//! INT-1 through the real service loop and the real receiver (stub adapters only): a hook body that reaches an
//! adapter flips the connector to verified in the snapshot, log polling alone does not, the record lands in
//! `coverage.json` (0600) and a restart keeps it; a restart without the adapter shows it unsupported.
#![cfg(unix)]
use std::{io::{Read,Write},net::TcpStream,os::unix::fs::PermissionsExt,path::{Path,PathBuf},sync::{Arc,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};
use collector::{Adapter,AdapterContext,AdapterError,AdapterRouter,EventBus,HookMapper,IdentityHasher,ServiceConfig,SystemClock,Clock,
    contracts::{AgentEvent,common::Tool}};
use serde_json::{json,Value};

fn scratch(name:&str)->PathBuf {
    let p=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("test-output").join(format!("{}-{name}",std::process::id()));
    let _=std::fs::remove_dir_all(&p);std::fs::create_dir_all(&p).unwrap();p
}
fn event(tool:&str,kind:&str,source:&str,id:u8)->AgentEvent {
    serde_json::from_value(json!({"v":1,"agent":tool,"instance":format!("{:032x}",id+if tool=="codex"{10}else{0}),"parent":null,"root_id":format!("{:032x}",3),"account_id":null,
        "session_id":null,"turn_id":null,"request_id":null,"host":"cli","kind":kind,"source":source,"confidence":"exact","t":1791806400000_u64})).unwrap()
}
/// Maps the body `hook` to a hook event; polls once with a log turn start (the "activity only" path).
struct Stub {tool:Tool,polled:AtomicBool}
impl Adapter for Stub {
    fn tool(&self)->Tool {self.tool}
    fn map_hook(&mut self,body:&[u8],_:&AdapterContext)->Result<Vec<AgentEvent>,AdapterError> {
        if body!=b"hook" {return Err(AdapterError::InvalidPayload);}
        Ok(vec![event(if self.tool==Tool::Claude{"claude"}else{"codex"},"turn_start","hook",1)])
    }
    fn poll(&mut self,_:&AdapterContext)->Result<Vec<AgentEvent>,AdapterError> {
        if self.polled.swap(true,Ordering::SeqCst) {return Ok(vec![]);}
        Ok(vec![event(if self.tool==Tool::Claude{"claude"}else{"codex"},"turn_start","log",2)])
    }
}
fn post(port:u16,secret:&str,token:&str,agent:&str,body:&[u8])->u16 {
    let mut s=TcpStream::connect(("127.0.0.1",port)).unwrap();s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    write!(s,"POST /e/{secret} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Busyholm-Token: {token}\r\nX-Busyholm-Agent: {agent}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
    s.write_all(body).unwrap();let mut buf=[0u8;512];let n=s.read(&mut buf).unwrap();
    std::str::from_utf8(&buf[..n]).unwrap().split_whitespace().nth(1).unwrap().parse().unwrap()
}
struct Run {rx:std::sync::mpsc::Receiver<Value>,sender:collector::EventSender,handle:std::thread::JoinHandle<std::io::Result<()>>,seen:Vec<Value>,data:PathBuf}
impl Run {
    fn start(data:&Path,tools:&[Tool])->Run {
        let clock:Arc<dyn Clock>=Arc::new(SystemClock);
        let ctx=AdapterContext{clock:clock.clone(),identities:IdentityHasher::new([1;32])};
        let mut router=AdapterRouter::new(ctx);
        for t in tools {router.register(Box::new(Stub{tool:*t,polled:AtomicBool::new(false)})).unwrap();}
        let router=Arc::new(router);let mapper:Arc<dyn HookMapper>=router.clone();
        let bus=EventBus::bounded(256);let sender=bus.sender();
        let mut config=ServiceConfig::new(data.to_path_buf());config.router=Some(router);config.poll_ms=50;
        let (tx,rx)=std::sync::mpsc::channel();
        let handle=std::thread::spawn(move||collector::run_service(config,bus,clock,mapper,move|o|{let _=tx.send(serde_json::to_value(&o).unwrap());Ok(())}));
        let end=Instant::now()+Duration::from_secs(5);
        while !data.join("runtime.json").exists()&&Instant::now()<end {std::thread::sleep(Duration::from_millis(5));}
        Run{rx,sender,handle,seen:Vec::new(),data:data.to_path_buf()}
    }
    fn post(&self,agent:&str,body:&[u8])->u16 {
        let r:Value=serde_json::from_slice(&std::fs::read(self.data.join("runtime.json")).unwrap()).unwrap();
        post(r["port"].as_u64().unwrap() as u16,r["secret"].as_str().unwrap(),r["token"].as_str().unwrap(),agent,body)
    }
    fn wait(&mut self,done:impl Fn(&[Value])->bool) {
        let end=Instant::now()+Duration::from_secs(5);
        while Instant::now()<end&&!done(&self.seen) {if let Ok(v)=self.rx.recv_timeout(Duration::from_millis(20)){self.seen.push(v);}}
    }
    fn stop(mut self)->Vec<Value> {
        self.sender.shutdown().unwrap();self.handle.join().unwrap().unwrap();
        while let Ok(v)=self.rx.try_recv(){self.seen.push(v);}self.seen
    }
}
fn coverage_of(seen:&[Value],tool:&str)->Option<(String,Option<String>,String)> {
    let snap=seen.iter().rev().find(|v|v["type"]=="snapshot")?;
    let t=snap["data"]["tools"].as_array()?.iter().find(|t|t["tool"]==tool)?;
    Some((t["coverage"].as_str()?.to_string(),t["coverage_reason"].as_str().map(String::from),t["presence"].as_str()?.to_string()))
}
fn is(seen:&[Value],tool:&str,coverage:&str)->bool {coverage_of(seen,tool).is_some_and(|c|c.0==coverage)}

#[test]
fn a_hook_through_the_receiver_verifies_log_polling_alone_does_not_and_a_restart_keeps_it() {
    let data=scratch("coverage");
    let mut run=Run::start(&data,&[Tool::Claude,Tool::Codex]);
    // Both adapters poll once with a log event: both connectors appear, both only degraded.
    run.wait(|s|is(s,"claude","degraded")&&is(s,"codex","degraded"));
    assert!(is(&run.seen,"claude","degraded")&&is(&run.seen,"codex","degraded"),"log activity alone is degraded: {:?}",run.seen);
    assert_eq!(run.post("claude",b"hook"),204);
    run.wait(|s|is(s,"claude","verified"));
    let c=coverage_of(&run.seen,"claude").expect("claude connector");
    assert_eq!((c.0.as_str(),c.1),("verified",None),"a hook through the receiver verifies");
    assert!(is(&run.seen,"codex","degraded"),"codex has no hook event yet");
    // The record is on disk before it is announced, private, and holds ids and times only.
    let file=data.join("coverage.json");
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode()&0o777,0o600);
    let record:Value=serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(record["entries"].as_array().unwrap().len(),1);
    assert_eq!(record["entries"][0]["tool"],"claude");
    run.stop();

    // Restart: the first snapshot already says verified (the tool is not running: offline).
    let mut again=Run::start(&data,&[Tool::Claude,Tool::Codex]);
    again.wait(|s|is(s,"claude","verified"));
    let c=coverage_of(&again.seen,"claude").expect("restored connector");
    assert_eq!((c.0.as_str(),c.2.as_str()),("verified","offline"));
    again.stop();

    // Restart without a Claude adapter (its folder became unreadable): unsupported, and the record is kept.
    let mut gone=Run::start(&data,&[Tool::Codex]);
    gone.wait(|s|is(s,"claude","unsupported"));
    assert!(is(&gone.seen,"claude","unsupported"),"{:?}",gone.seen);
    gone.stop();
    let record:Value=serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(record["entries"].as_array().unwrap().len(),1,"a missing adapter does not erase the proof");

    // A corrupt record never stops the service: it is set aside and the connector starts unverified.
    std::fs::write(&file,b"{not json").unwrap();
    let mut corrupt=Run::start(&data,&[Tool::Claude,Tool::Codex]);
    corrupt.wait(|s|is(s,"claude","degraded"));
    assert!(is(&corrupt.seen,"claude","degraded"));
    corrupt.stop();
    assert!(data.join("coverage.json.corrupt").exists());
}
