//! The service loop drives the AdapterRouter: rebuild at start, poll while running, hook bodies by header.
//! Stub adapters only; the real adapters are covered end to end in shim/tests/e2e_service.rs.
use std::{io::{Read,Write},net::TcpStream,path::PathBuf,sync::{Arc,atomic::{AtomicUsize,Ordering}},time::{Duration,Instant}};
use collector::{Adapter,AdapterContext,AdapterError,AdapterRouter,EventBus,HookMapper,IdentityHasher,ServiceConfig,SystemClock,Clock,CollectorOutput,
    contracts::{AgentEvent,common::Tool}};
use serde_json::{json,Value};

fn scratch(name:&str)->PathBuf {
    let p=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("test-output").join(format!("{}-{name}",std::process::id()));
    let _=std::fs::remove_dir_all(&p);std::fs::create_dir_all(&p).unwrap();p
}
fn event(tool:&str,kind:&str,id:u8,turn:Option<u8>,et:Option<u64>)->AgentEvent {
    let mut v=json!({"v":1,"agent":tool,"instance":format!("{id:032x}"),"parent":null,"root_id":format!("{:032x}",3),"account_id":null,
        "session_id":null,"turn_id":turn.map(|t|format!("{t:032x}")),"request_id":null,"host":"cli","kind":kind,"source":"log","confidence":"exact",
        "t":1791806400000_u64});
    if let Some(et)=et {v["et"]=json!(et);}
    serde_json::from_value(v).unwrap()
}
struct Stub {tool:Tool,polls:Arc<AtomicUsize>,fail:bool,now:u64}
impl Adapter for Stub {
    fn tool(&self)->Tool {self.tool}
    fn map_hook(&mut self,body:&[u8],_:&AdapterContext)->Result<Vec<AgentEvent>,AdapterError> {
        if self.fail||body!=b"hook" {return Err(AdapterError::InvalidPayload);}
        Ok(vec![event("codex","turn_start",9,Some(9),None)])
    }
    fn rebuild(&mut self,_:&AdapterContext)->Result<Vec<AgentEvent>,AdapterError> {
        if self.fail {return Err(AdapterError::Io);}
        Ok(vec![event("codex","turn_start",5,Some(5),Some(self.now-1000))])
    }
    fn poll(&mut self,_:&AdapterContext)->Result<Vec<AgentEvent>,AdapterError> {
        if self.fail {return Err(AdapterError::Io);}
        if self.polls.fetch_add(1,Ordering::SeqCst)==0 {Ok(vec![event("codex","turn_start",7,Some(7),None),event("codex","turn_end",7,Some(7),None)])} else {Ok(vec![])}
    }
}
fn post(port:u16,secret:&str,token:&str,agent:&str,body:&[u8])->u16 {
    let mut s=TcpStream::connect(("127.0.0.1",port)).unwrap();s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    write!(s,"POST /e/{secret} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Busyholm-Token: {token}\r\nX-Busyholm-Agent: {agent}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
    s.write_all(body).unwrap();let mut buf=[0u8;512];let n=s.read(&mut buf).unwrap();
    std::str::from_utf8(&buf[..n]).unwrap().split_whitespace().nth(1).unwrap().parse().unwrap()
}

#[test]
fn the_service_rebuilds_polls_and_routes_hooks_through_the_router_and_survives_a_failing_adapter() {
    let data=scratch("router");let clock:Arc<dyn Clock>=Arc::new(SystemClock);
    let ctx=AdapterContext{clock:clock.clone(),identities:IdentityHasher::new([1;32])};
    let polls=Arc::new(AtomicUsize::new(0));let now=clock.now_ms();
    let mut router=AdapterRouter::new(ctx);
    // the failing adapter is registered FIRST in key order (Claude < Codex): it must not starve Codex
    router.register(Box::new(Stub{tool:Tool::Claude,polls:polls.clone(),fail:true,now})).unwrap();
    router.register(Box::new(Stub{tool:Tool::Codex,polls:polls.clone(),fail:false,now})).unwrap();
    assert_eq!(router.registered(),vec![Tool::Claude,Tool::Codex]);
    let router=Arc::new(router);let mapper:Arc<dyn HookMapper>=router.clone();
    let bus=EventBus::bounded(256);let sender=bus.sender();
    let mut config=ServiceConfig::new(data.clone());config.router=Some(router);config.poll_ms=50;
    let (tx,rx)=std::sync::mpsc::channel();
    let handle=std::thread::spawn(move||collector::run_service(config,bus,clock,mapper,move|o|{let _=tx.send(serde_json::to_value(&o).unwrap());Ok(())}));
    let end=Instant::now()+Duration::from_secs(5);
    while !data.join("runtime.json").exists()&&Instant::now()<end {std::thread::sleep(Duration::from_millis(5));}
    let runtime:Value=serde_json::from_slice(&std::fs::read(data.join("runtime.json")).unwrap()).unwrap();
    let (port,secret,token)=(runtime["port"].as_u64().unwrap() as u16,runtime["secret"].as_str().unwrap(),runtime["token"].as_str().unwrap());
    // hook routing by header: codex -> its adapter; claude -> the failing adapter (400); gemini -> none registered (400)
    assert_eq!(post(port,secret,token,"codex",b"hook"),204);
    assert_eq!(post(port,secret,token,"codex",b"other"),400);
    assert_eq!(post(port,secret,token,"claude",b"hook"),400);
    assert_eq!(post(port,secret,token,"gemini",b"hook"),400);
    let mut seen:Vec<Value>=Vec::new();
    let end=Instant::now()+Duration::from_secs(5);
    let turn_end=|s:&[Value]|s.iter().any(|v|v["type"]=="moment"&&v["data"]["kind"]=="turn_end");
    let rebuilt=|s:&[Value]|s.iter().any(|v|v["type"]=="snapshot"&&v["data"]["agents"].as_array().is_some_and(|a|a.iter().any(|x|x["state"]=="working")));
    while Instant::now()<end&&!(turn_end(&seen)&&rebuilt(&seen)) {if let Ok(v)=rx.recv_timeout(Duration::from_millis(50)){seen.push(v);}}
    assert!(rebuilt(&seen),"rebuild events must reach the state machine");
    assert!(turn_end(&seen),"events from poll must reach the state machine even though another adapter fails every poll");
    let end=Instant::now()+Duration::from_secs(5);
    while polls.load(Ordering::SeqCst)<3&&Instant::now()<end {std::thread::sleep(Duration::from_millis(10));}
    assert!(polls.load(Ordering::SeqCst)>=3,"the service keeps polling");
    sender.shutdown().unwrap();handle.join().unwrap().unwrap();
    while let Ok(v)=rx.try_recv(){seen.push(v);}
    assert!(seen.iter().any(|v|v["type"]=="ledger"));
    let _=CollectorOutput::Ledger;
}

struct Panics;
impl Adapter for Panics {
    fn tool(&self)->Tool {Tool::Claude}
    fn poll(&mut self,_:&AdapterContext)->Result<Vec<AgentEvent>,AdapterError> {panic!("adapter bug")}
    fn rebuild(&mut self,_:&AdapterContext)->Result<Vec<AgentEvent>,AdapterError> {panic!("adapter bug")}
}
#[test]
fn a_panicking_adapter_poll_or_rebuild_does_not_stop_the_others_or_the_caller() {
    let clock:Arc<dyn Clock>=Arc::new(SystemClock);
    let ctx=AdapterContext{clock:clock.clone(),identities:IdentityHasher::new([1;32])};
    let mut router=AdapterRouter::new(ctx);
    router.register(Box::new(Panics)).unwrap();
    router.register(Box::new(Stub{tool:Tool::Codex,polls:Arc::new(AtomicUsize::new(0)),fail:false,now:clock.now_ms()})).unwrap();
    let bus=EventBus::bounded(16);
    assert!(router.poll(&bus.sender()).is_err());
    assert!(matches!(bus.receiver.try_recv(),Ok(collector::CollectorInput::Event(_))),"the healthy adapter was still polled");
    assert_eq!(router.rebuild().unwrap().len(),1,"the healthy adapter still rebuilds");
}
