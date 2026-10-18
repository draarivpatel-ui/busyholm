//! Receiver hardening beyond Revision 1 item 4: a hostile body cannot take the receiver down, and a stalled
//! client cannot starve the others. Leads from an unverified external review are each tested here.
use std::{io::{Read,Write},net::TcpStream,path::PathBuf,sync::Arc,time::{Duration,Instant}};
use collector::{AdapterError,EventBus,HookMapper,Receiver,ReceiverCredentials,contracts::{AgentEvent,common::Tool}};

struct Mapper;
impl HookMapper for Mapper {
    fn map(&self,tool:Option<Tool>,body:&[u8])->Result<Vec<AgentEvent>,AdapterError> {
        if body==b"panic" {panic!("hostile body");}
        if body==b"unsupported" {return Err(AdapterError::Unsupported);}
        let _=tool;Ok(Vec::new())
    }
}
fn scratch(name:&str)->PathBuf {
    let p=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("test-output").join(format!("{}-{name}",std::process::id()));
    let _=std::fs::remove_dir_all(&p);std::fs::create_dir_all(&p).unwrap();p
}
struct Fixture {receiver:Receiver,_bus:EventBus,port:u16,path:String,token:String}
fn fixture(name:&str)->Fixture {
    let p=scratch(name);let bus=EventBus::bounded(64);
    let keys=ReceiverCredentials{secret:"a".repeat(64),token:"b".repeat(64)};
    let receiver=Receiver::start(&p.join("runtime.json"),keys,Arc::new(Mapper),bus.sender()).unwrap();
    let (port,path,token)=(receiver.runtime().port,format!("/e/{}",receiver.runtime().secret),receiver.runtime().token.clone());
    Fixture{receiver,_bus:bus,port,path,token}
}
impl Fixture {
    fn headers(&self,extra:&str)->String {format!("Host: 127.0.0.1:{}\r\nX-Busyholm-Token: {}\r\nContent-Type: application/json\r\n{extra}",self.port,self.token)}
    fn post_to(&self,path:&str,extra:&str,body:&[u8])->u16 {
        let mut s=TcpStream::connect(("127.0.0.1",self.port)).unwrap();s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        write!(s,"POST {path} HTTP/1.1\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n",self.headers(extra),body.len()).unwrap();s.write_all(body).unwrap();
        let mut buf=[0u8;256];match s.read(&mut buf){Ok(n)if n>0=>std::str::from_utf8(&buf[..n]).unwrap().split_whitespace().nth(1).unwrap().parse().unwrap(),_=>0}
    }
    fn post(&self,extra:&str,body:&[u8])->u16 {self.post_to(&self.path.clone(),extra,body)}
    /// Valid headers promising `n` body bytes, then silence. Keep the stream alive.
    fn stall(&self,n:usize)->TcpStream {
        let mut s=TcpStream::connect(("127.0.0.1",self.port)).unwrap();
        write!(s,"POST {} HTTP/1.1\r\n{}Content-Length: {n}\r\n\r\n",self.path,self.headers("")).unwrap();s
    }
}

#[test]
fn a_panicking_mapper_does_not_take_the_receiver_down() {
    let f=fixture("panic");
    for _ in 0..4 {assert_eq!(f.post("",b"panic"),400);}
    assert_eq!(f.post("",b"ok"),204,"the workers must survive hostile bodies");
}
#[test]
fn origin_is_refused_before_the_secret_path_is_looked_at() {
    let f=fixture("origin");
    assert_eq!(f.post_to("/e/wrong","Origin: http://evil.example\r\n",b"x"),403);
    assert_eq!(f.post("Origin: http://evil.example\r\n",b"x"),403);
    assert_eq!(f.post_to("/wrong","",b"x"),404);
}
#[test]
fn a_repeated_agent_header_is_refused() {
    let f=fixture("agent");
    assert_eq!(f.post("X-Busyholm-Agent: claude\r\n",b"x"),204);
    assert_eq!(f.post("X-Busyholm-Agent: claude\r\nX-Busyholm-Agent: codex\r\n",b"x"),400);
}
#[test]
fn stalled_clients_cannot_starve_the_receiver_or_block_shutdown() {
    let f=fixture("stall");
    let stalled:Vec<_>=(0..24).map(|_|f.stall(100)).collect();
    std::thread::sleep(Duration::from_millis(500)); // let the receiver pick the stalled ones up
    let start=Instant::now();
    assert_eq!(f.post("",b"ok"),204,"a normal request is answered while other clients stall");
    assert!(start.elapsed()<Duration::from_secs(2));
    let drop_start=Instant::now();
    drop(f.receiver);
    assert!(drop_start.elapsed()<Duration::from_secs(5),"shutdown must not wait for a stalled client");
    drop(stalled);
}


/// Run as a child process so its stderr can be captured: an adapter panic whose message holds content
/// (a parser error quoting a value, say) must not be printed by the default panic hook.
#[test]
fn a_panic_message_with_content_never_reaches_stderr() {
    if std::env::var_os("BH_PANIC_CHILD").is_some() {
        struct Leaky;
        impl HookMapper for Leaky {
            fn map(&self,_:Option<Tool>,_:&[u8])->Result<Vec<AgentEvent>,AdapterError> {panic!("BHCANARY_panic_content");}
        }
        let p=scratch("panic-child");let bus=EventBus::bounded(8);
        let keys=ReceiverCredentials{secret:"a".repeat(64),token:"b".repeat(64)};
        let r=Receiver::start(&p.join("runtime.json"),keys,Arc::new(Leaky),bus.sender()).unwrap();
        let f=Fixture{port:r.runtime().port,path:format!("/e/{}",r.runtime().secret),token:r.runtime().token.clone(),receiver:r,_bus:bus};
        assert_eq!(f.post("",b"x"),400);
        return;
    }
    let out=std::process::Command::new(std::env::current_exe().unwrap())
        .args(["a_panic_message_with_content_never_reaches_stderr","--exact","--nocapture","--test-threads=1"])
        .env("BH_PANIC_CHILD","1").output().unwrap();
    assert!(out.status.success(),"child failed");
    let text=String::from_utf8_lossy(&out.stderr).to_string()+&String::from_utf8_lossy(&out.stdout);
    assert!(!text.contains("BHCANARY"),"panic text leaked: {text}");
}
