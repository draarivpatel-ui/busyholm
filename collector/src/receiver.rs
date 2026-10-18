use std::{collections::BTreeMap,io::{self,Read},net::{Ipv4Addr,SocketAddrV4},path::{Path,PathBuf},sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},thread::{self,JoinHandle}};
use busyholm_contracts::{AgentEvent,Validate,agent_event::{EventKind,EventSource,EventDetail,EventUsage,EventLimit,ErrorClass,Notification,StopReason,EndReason},common::{Tool,Host,Confidence,Version,Activity,Provider,Window,LimitWindow}};
use serde::{Serialize,Deserialize};
use tiny_http::{Server,Request,Response,Method};
use crate::{Adapter,AdapterContext,AdapterError,Clock,EventSender,SendError,private_io};

pub const TOKEN_HEADER:&str="X-Busyholm-Token";
pub const AGENT_HEADER:&str="X-Busyholm-Agent";
pub const MAX_BODY:usize=256*1024;
pub trait HookMapper:Send+Sync {fn map(&self,tool:Option<Tool>,body:&[u8])->Result<Vec<AgentEvent>,AdapterError>;}
pub struct NormalizedMapper {pub clock:Arc<dyn Clock>}
// Unknown fields are consumed as IgnoredAny by serde, including nested content.
// They are never collected into a generic JSON Value or put on a queue.
#[derive(Deserialize)]
struct WireDetail {activity:Option<Activity>,error_class:Option<ErrorClass>,notification:Option<Notification>,stop_reason:Option<StopReason>,end_reason:Option<EndReason>}
#[derive(Deserialize)]
struct WireUsage {provider:Provider,window:Window,used_pct:f64,resets_at:u64,observed_at:u64}
#[derive(Deserialize)]
struct WireLimit {provider:Provider,window:LimitWindow,#[serde(deserialize_with="busyholm_contracts::common::nullable")]resets_at:Option<u64>}
#[derive(Deserialize)]
struct WireEvent {
    v:Version<1>,agent:Tool,instance:String,#[serde(deserialize_with="busyholm_contracts::common::nullable")]parent:Option<String>,root_id:String,
    #[serde(deserialize_with="busyholm_contracts::common::nullable")]account_id:Option<String>,
    #[serde(deserialize_with="busyholm_contracts::common::nullable")]session_id:Option<String>,
    #[serde(deserialize_with="busyholm_contracts::common::nullable")]turn_id:Option<String>,
    #[serde(deserialize_with="busyholm_contracts::common::nullable")]request_id:Option<String>,
    host:Host,kind:EventKind,source:EventSource,confidence:Confidence,
    #[serde(default)]et:Option<u64>,#[serde(default)]detail:Option<WireDetail>,#[serde(default)]usage:Option<WireUsage>,#[serde(default)]limit:Option<WireLimit>,#[serde(default)]tokens_delta:Option<u32>,
}
impl HookMapper for NormalizedMapper {
    fn map(&self,tool:Option<Tool>,body:&[u8])->Result<Vec<AgentEvent>,AdapterError> {
        if body.len()>MAX_BODY {return Err(AdapterError::InvalidPayload);}
        let raw:WireEvent=serde_json::from_slice(body).map_err(|_|AdapterError::InvalidPayload)?;
        if tool.is_some_and(|tool|tool!=raw.agent){return Err(AdapterError::InvalidPayload);}
        let event=AgentEvent{v:raw.v,agent:raw.agent,instance:raw.instance,parent:raw.parent,root_id:raw.root_id,account_id:raw.account_id,session_id:raw.session_id,turn_id:raw.turn_id,request_id:raw.request_id,
            host:raw.host,kind:raw.kind,source:raw.source,confidence:raw.confidence,t:self.clock.now_ms(),et:raw.et,
            detail:raw.detail.map(|d|EventDetail{activity:d.activity,error_class:d.error_class,notification:d.notification,stop_reason:d.stop_reason,end_reason:d.end_reason}),
            usage:raw.usage.map(|u|EventUsage{provider:u.provider,window:u.window,used_pct:u.used_pct,resets_at:u.resets_at,observed_at:u.observed_at}),
            limit:raw.limit.map(|l|EventLimit{provider:l.provider,window:l.window,resets_at:l.resets_at}),tokens_delta:raw.tokens_delta};
        event.validate().map_err(|_|AdapterError::InvalidPayload)?;
        if event.parent.as_ref()==Some(&event.instance)||event.usage.as_ref().is_some_and(|u|u.observed_at>event.t){return Err(AdapterError::InvalidPayload);}
        Ok(vec![event])
    }
}
/// Adapter hooks are selected by a fixed header, not an untrusted filesystem path.
pub struct AdapterRouter {context:AdapterContext,adapters:BTreeMap<Tool,Mutex<Box<dyn Adapter>>>}
impl AdapterRouter {
    pub fn new(context:AdapterContext)->Self {Self{context,adapters:BTreeMap::new()}}
    pub fn register(&mut self,adapter:Box<dyn Adapter>)->Result<(),AdapterError> {
        if self.adapters.contains_key(&adapter.tool()){return Err(AdapterError::Unavailable);}
        self.adapters.insert(adapter.tool(),Mutex::new(adapter));Ok(())
    }
    /// The tools that have an adapter. A tool whose folder could not be opened is missing here, and its hooks get 400.
    pub fn registered(&self)->Vec<Tool> {self.adapters.keys().copied().collect()}
    /// Gives every adapter the service's waker (review r1 M5).
    pub fn set_waker(&self,waker:crate::Waker) {
        for adapter in self.adapters.values(){let _=guarded(||adapter.lock().unwrap_or_else(|e|e.into_inner()).set_waker(waker.clone()));}
    }
    /// Startup observations from every adapter. One adapter failing (a missing folder, say) never hides the others.
    pub fn rebuild(&self)->Result<Vec<AgentEvent>,AdapterError> {
        let mut events=Vec::new();
        for adapter in self.adapters.values(){
            let mut adapter=adapter.lock().unwrap_or_else(|e|e.into_inner());
            if let Some(Ok(found))=guarded(||adapter.rebuild(&self.context)){events.extend(found.into_iter().filter(|e|e.validate().is_ok()));}
        }
        events.truncate(4096);Ok(events)
    }
    /// One bounded poll of every adapter; events go to the bus. A failing or full adapter never starves the
    /// others; the first error is returned after all of them have been polled.
    pub fn poll(&self,sender:&EventSender)->Result<(),AdapterError> {
        let mut first=None;
        for adapter in self.adapters.values(){
            let events=guarded(||adapter.lock().unwrap_or_else(|e|e.into_inner()).poll(&self.context)).unwrap_or(Err(AdapterError::Unavailable));
            let sent=events.and_then(|events|sender.send_batch(events).map_err(|_|AdapterError::Unavailable));
            if let Err(e)=sent{first.get_or_insert(e);}
        }
        first.map_or(Ok(()),Err)
    }
}
impl HookMapper for AdapterRouter {
    fn map(&self,tool:Option<Tool>,body:&[u8])->Result<Vec<AgentEvent>,AdapterError> {
        let tool=tool.ok_or(AdapterError::Unsupported)?;let adapter=self.adapters.get(&tool).ok_or(AdapterError::Unsupported)?;
        let events=adapter.lock().unwrap_or_else(|e|e.into_inner()).map_hook(body,&self.context)?;
        if events.len()>64||events.iter().any(|e|e.agent!=tool||e.validate().is_err()){return Err(AdapterError::InvalidPayload);}Ok(events)
    }
}

#[derive(Clone,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiverCredentials {pub secret:String,pub token:String}
impl ReceiverCredentials {
    pub fn load_or_create(dir:&Path)->io::Result<Self> {
        let path=dir.join("receiver-keys.json");
        if !path.exists(){let keys=Self{secret:private_io::hex(&private_io::random::<32>()?),token:private_io::hex(&private_io::random::<32>()?)};
            let bytes=serde_json::to_vec(&keys).map_err(|_|io::ErrorKind::InvalidData)?;
            match private_io::create_private(&path,&bytes){Ok(())=>return Ok(keys),Err(e)if e.kind()==io::ErrorKind::AlreadyExists=>{},Err(e)=>return Err(e)}}
        let keys:Self=private_io::read_json(&path,4096)?;
        if !keys.valid(){return Err(io::ErrorKind::InvalidData.into());}Ok(keys)
    }
    fn valid(&self)->bool {self.secret.len()==64&&self.token.len()==64&&self.secret.bytes().chain(self.token.bytes()).all(|b|b.is_ascii_hexdigit()&&!b.is_ascii_uppercase())}
}
#[derive(Clone,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeInfo {pub v:u8,pub port:u16,pub secret:String,pub token:String}
pub struct Receiver {server:Arc<Server>,stopping:Arc<AtomicBool>,threads:Vec<JoinHandle<()>>,runtime:RuntimeInfo,path:PathBuf}
fn header<'a>(r:&'a Request,name:&'static str)->Option<&'a str> {
    let mut headers=r.headers().iter().filter(|h|h.field.equiv(name));let first=headers.next()?;
    if headers.next().is_some(){return None;}Some(first.value.as_str())
}
thread_local! {static IN_ADAPTER:std::cell::Cell<bool>=const{std::cell::Cell::new(false)};}
/// While an adapter maps a hook body on a receiver thread, a panic prints a fixed line instead of its message
/// (a parser error can quote a value from the body). Every other thread keeps the previous hook.
fn install_quiet_panic_hook() {
    static ONCE:std::sync::Once=std::sync::Once::new();
    ONCE.call_once(||{
        let previous=std::panic::take_hook();
        std::panic::set_hook(Box::new(move|info|{
            if IN_ADAPTER.with(|f|f.get()) {eprintln!("collector: adapter_panic");} else {previous(info);}
        }));
    });
}
/// Runs adapter code so a panic becomes `None` and prints only a fixed line.
fn guarded<T>(f:impl FnOnce()->T)->Option<T> {
    install_quiet_panic_hook();
    IN_ADAPTER.with(|flag|flag.set(true));
    let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).ok();
    IN_ADAPTER.with(|flag|flag.set(false));result
}
/// Equal-length byte comparison that does not stop at the first difference.
fn same(a:&str,b:&str)->bool {a.len()==b.len()&&a.bytes().zip(b.bytes()).fold(0u8,|d,(x,y)|d|(x^y))==0}
fn handle(mut r:Request,info:&RuntimeInfo,mapper:&dyn HookMapper,sender:&EventSender) {
    let path_ok=same(r.url(),&format!("/e/{}",info.secret));
    // Browser and rebinding checks come first, so a cross-origin page learns nothing about the secret path.
    let code=if r.headers().iter().any(|h|h.field.equiv("Origin"))
            || header(&r,"Host")!=Some(format!("127.0.0.1:{}",info.port).as_str()){403}
        else if !path_ok{404}
        else if !header(&r,TOKEN_HEADER).is_some_and(|t|same(t,&info.token)){403}
        else if r.method()!=&Method::Post{405}
        else if header(&r,"Content-Type")!=Some("application/json"){415}
        else if r.body_length().is_some_and(|n|n>MAX_BODY){413}
        else if r.headers().iter().filter(|h|h.field.equiv(AGENT_HEADER)).count()>1{400}
        else {
            let tool=match header(&r,AGENT_HEADER){Some(value)=>match serde_json::from_str::<Tool>(&format!("\"{value}\"")){Ok(tool)=>Some(tool),Err(_)=>{let _=r.respond(Response::empty(400));return;}},None=>None};
            let mut bytes=Vec::with_capacity(r.body_length().unwrap_or(1024).min(MAX_BODY));
            if r.as_reader().take((MAX_BODY+1) as u64).read_to_end(&mut bytes).is_err(){400}
            else if bytes.len()>MAX_BODY{413}
            else {
                // A panic inside an adapter must not kill a receiver thread: two hostile bodies would stop all hooks.
                match guarded(||mapper.map(tool,&bytes)) {None|Some(Err(_))=>400,Some(Ok(events))=>match sender.send_batch(events){Ok(())=>204,Err(SendError::Full|SendError::Closed)=>503,Err(SendError::InvalidEvent)=>400}}
            }
        };
    let _=r.respond(Response::empty(code));
}
impl Receiver {
    pub fn start(path:&Path,keys:ReceiverCredentials,mapper:Arc<dyn HookMapper>,sender:EventSender)->io::Result<Self> {
        if !keys.valid(){return Err(io::ErrorKind::InvalidInput.into());}
        install_quiet_panic_hook();
        let mut selected=None;
        for _ in 0..64 {let bytes=private_io::random::<2>()?;let port=49152+(u16::from_le_bytes(bytes)%16384);
            if let Ok(server)=Server::http(SocketAddrV4::new(Ipv4Addr::LOCALHOST,port)){selected=Some((Arc::new(server),port));break;}}
        let (server,port)=selected.ok_or(io::ErrorKind::AddrInUse)?;
        let runtime=RuntimeInfo{v:1,port,secret:keys.secret,token:keys.token};private_io::atomic_json(path,&runtime)?;
        let stopping=Arc::new(AtomicBool::new(false));let mut threads=Vec::new();
        for _ in 0..2 {let server=server.clone();let stopping=stopping.clone();let info=runtime.clone();let mapper=mapper.clone();let sender=sender.clone();
            threads.push(thread::spawn(move||{while !stopping.load(Ordering::Acquire){match server.recv_timeout(std::time::Duration::from_secs(1)){Ok(Some(r))=>handle(r,&info,mapper.as_ref(),&sender),Ok(None)=>{},Err(_)=>break}}}));}
        Ok(Self{server,stopping,threads,runtime,path:path.to_owned()})
    }
    pub fn runtime(&self)->&RuntimeInfo {&self.runtime}
}
impl Drop for Receiver {
    fn drop(&mut self) {
        self.stopping.store(true,Ordering::Release);for _ in &self.threads {self.server.unblock();}
        for thread in self.threads.drain(..){let _=thread.join();}
        if let Ok(info)=private_io::read_json::<RuntimeInfo>(&self.path,4096){if info.port==self.runtime.port&&info.token==self.runtime.token{let _=std::fs::remove_file(&self.path);}}
    }
}
