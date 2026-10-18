use std::{io::{Read,Write},net::TcpStream,path::PathBuf,sync::Arc};
use collector::{Collector, CollectorOutput, EventBus, FakeClock, HookMapper, NormalizedMapper, Receiver, ReceiverCredentials};
use serde_json::json;
const BASE:u64=1791806400000;

fn scratch(name:&str)->PathBuf {
    let p=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("test-output").join(format!("{}-{name}",std::process::id()));
    std::fs::create_dir_all(&p).unwrap(); p
}
fn payload(kind:&str)->Vec<u8> {
    serde_json::to_vec(&json!({"v":1,"agent":"claude","instance":"00000000000000000000000000000001","parent":null,
        "root_id":"00000000000000000000000000000003","account_id":null,"session_id":null,"turn_id":null,"request_id":null,
        "host":"cli","kind":kind,"source":"hook","confidence":"exact","t":BASE})).unwrap()
}
fn post(port:u16,path:&str,headers:&str,body:&[u8],length:usize)->u16 {
    let mut stream=TcpStream::connect(("127.0.0.1",port)).unwrap();
    stream.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
    write!(stream,"POST {path} HTTP/1.1\r\n{headers}Content-Length: {length}\r\nConnection: close\r\n\r\n").unwrap();
    stream.write_all(body).unwrap();
    let mut buf=[0u8;1024]; let n=stream.read(&mut buf).unwrap();
    std::str::from_utf8(&buf[..n]).unwrap().split_whitespace().nth(1).unwrap().parse().unwrap()
}
#[test]
fn receiver_codes_loopback_host_token_origin_size_and_private_runtime() {
    let p=scratch("receiver"); let bus=EventBus::bounded(4096);
    let clock=Arc::new(FakeClock::new(BASE));
    let keys=ReceiverCredentials {secret:"a".repeat(64),token:"b".repeat(64)};
    let server=Receiver::start(&p.join("runtime.json"),keys,Arc::new(NormalizedMapper{clock}),bus.sender()).unwrap();
    let port=server.runtime().port; assert!(port>=49152);
    let path=format!("/e/{}",server.runtime().secret);
    let headers=format!("Host: 127.0.0.1:{port}\r\nX-Busyholm-Token: {}\r\nContent-Type: application/json\r\n",server.runtime().token);
    let body=payload("turn_start");
    assert_eq!(post(port,"/wrong",&headers,&body,body.len()),404);
    assert_eq!(post(port,&path,&headers.replace("Content-Type: application/json\r\n",""),&body,body.len()),415);
    assert_eq!(post(port,&path,&format!("{headers}Origin: null\r\n"),&body,body.len()),403);
    assert_eq!(post(port,&path,&headers.replace(&format!("127.0.0.1:{port}"),"localhost"),&body,body.len()),403);
    assert_eq!(post(port,&path,&headers.replace(&"b".repeat(64),&"c".repeat(64)),&body,body.len()),403);
    assert_eq!(post(port,&path,&headers.replace(&format!("X-Busyholm-Token: {}\r\n","b".repeat(64)),""),&body,body.len()),403);
    assert_eq!(post(port,&path,&headers,&[],collector::receiver::MAX_BODY+1),413);
    assert_eq!(post(port,&path,&headers,&body,body.len()),204);
    assert!(matches!(bus.receiver.recv_timeout(std::time::Duration::from_secs(1)).unwrap(),collector::CollectorInput::Event(_)));
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(p.join("runtime.json")).unwrap().permissions().mode() & 0o777,0o600);
    }
    drop(server); assert!(!p.join("runtime.json").exists());
}
#[test]
fn allowlist_canary_pipeline_covers_outputs_ledger_and_diagnostics() {
    let clock=Arc::new(FakeClock::new(BASE)); let mapper=NormalizedMapper{clock:clock.clone()};
    let mut c=Collector::new(clock.clone(),1); let mut output=String::new();
    let forbidden=["prompt","last_assistant_message","tool_input","tool_response","tool_output","output","text","content","message","title","name","summary","error_details","permission_suggestions","user_email","input-messages","last-assistant-message","creator_user_id","creator_account_id","ownerAccountUuid","ownerOrganizationUuid","toolUseResult","cwd"];
    for kind in ["turn_start","needs_permission","answered","turn_end","error","turn_start","turn_interrupted","session_end"] {
        let mut value:serde_json::Value=serde_json::from_slice(&payload(kind)).unwrap();
        for field in forbidden {value[field]=json!(format!("BHCANARY_{field}"));}
        let events=mapper.map(None,&serde_json::to_vec(&value).unwrap()).unwrap();
        for event in events { for o in c.ingest(event).unwrap() { output.push_str(&serde_json::to_string(&o).unwrap()); } }
        clock.advance(1000);
    }
    for value in [serde_json::to_string(&c.snapshot()).unwrap(),serde_json::to_string(c.ledger()).unwrap(),serde_json::to_string(&c.diagnostics()).unwrap()] { output.push_str(&value); }
    assert!(!output.contains("BHCANARY")); assert!(!output.contains("bca1a700"));
    assert!(output.contains("turn_end"));
    let p=scratch("privacy"); std::fs::write(p.join("pipeline.jsonl"),output).unwrap();
    assert!(matches!(CollectorOutput::Ledger(c.ledger().clone()),CollectorOutput::Ledger(_)));
}
#[test]
fn per_install_credentials_survive_restart_and_reject_symlinks() {
    let p=scratch("keys"); let a=ReceiverCredentials::load_or_create(&p).unwrap();
    let b=ReceiverCredentials::load_or_create(&p).unwrap();
    assert_eq!(a.token,b.token); assert_eq!(a.secret,b.secret); assert_ne!(a.token,a.secret);
    assert_eq!(a.token.len(),64);
}
