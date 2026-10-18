//! WP-03 persistence: the ledger and the pending alerts survive a kill at any point. The real `collector`
//! binary is driven over stdin and killed with SIGKILL; files are checked from outside.
#![cfg(unix)]
use std::{io::{BufRead,BufReader,Write},os::unix::fs::PermissionsExt,path::{Path,PathBuf},process::{Child,Command,Stdio},sync::mpsc,time::{Duration,Instant}};
use collector::contracts::{Ledger,Validate,pending_alerts::PendingAlerts};
use serde_json::{json,Value};

const BIN:&str=env!("CARGO_BIN_EXE_collector");
fn scratch(name:&str)->PathBuf {
    let p=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("test-output").join(format!("{}-{name}",std::process::id()));
    let _=std::fs::remove_dir_all(&p);std::fs::create_dir_all(&p).unwrap();p
}
fn event(kind:&str,turn:&str)->String {
    json!({"v":1,"agent":"claude","instance":format!("{:032x}",1),"parent":null,"root_id":format!("{:032x}",3),"account_id":null,
        "session_id":null,"turn_id":format!("{:032x}",turn.bytes().fold(0u128,|a,b|a*31+b as u128)),"request_id":null,
        "host":"cli","kind":kind,"source":"hook","confidence":"exact","t":1791806400000_u64}).to_string()
}
struct Sidecar {child:Child,lines:mpsc::Receiver<Value>}
impl Sidecar {
    fn start(data:&Path)->Sidecar {
        let _=std::fs::remove_file(data.join("runtime.json")); // a killed run leaves a stale one behind
        let mut child=Command::new(BIN).arg("--data-dir").arg(data).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let out=child.stdout.take().unwrap();let (tx,lines)=mpsc::channel();
        std::thread::spawn(move||{for line in BufReader::new(out).lines().map_while(Result::ok){if let Ok(v)=serde_json::from_str(&line){if tx.send(v).is_err(){break;}}}});
        let s=Sidecar{child,lines};
        let end=Instant::now()+Duration::from_secs(5);
        while !data.join("runtime.json").exists()&&Instant::now()<end {std::thread::sleep(Duration::from_millis(5));}
        assert!(data.join("runtime.json").exists(),"service did not start");s
    }
    fn send(&mut self,line:&str) {let stdin=self.child.stdin.as_mut().unwrap();stdin.write_all(line.as_bytes()).unwrap();stdin.write_all(b"\n").unwrap();stdin.flush().unwrap();}
    fn wait_type(&self,kind:&str)->Value {
        let end=Instant::now()+Duration::from_secs(5);
        while Instant::now()<end {if let Ok(v)=self.lines.recv_timeout(Duration::from_millis(50)) {if v["type"]==kind {return v;}}}
        panic!("no {kind} output");
    }
    fn wait_moment(&self,kind:&str) {
        let end=Instant::now()+Duration::from_secs(5);
        while Instant::now()<end {
            if let Ok(v)=self.lines.recv_timeout(Duration::from_millis(50)) {if v["type"]=="moment"&&v["data"]["kind"]==kind {return;}}
        }
        panic!("no {kind} moment");
    }
    fn kill9(mut self) {self.child.kill().unwrap();self.child.wait().unwrap();}
    fn finish(mut self) {drop(self.child.stdin.take());let status=self.child.wait().unwrap();assert!(status.success());}
}
fn turns(data:&Path)->u64 {
    let ledger:Ledger=serde_json::from_slice(&std::fs::read(data.join("ledger.json")).unwrap()).unwrap();ledger.validate().unwrap();
    ledger.days.values().map(|d|d.values().map(|c|c.turns as u64).sum::<u64>()).sum()
}
fn mode(p:&Path)->u32 {std::fs::metadata(p).unwrap().permissions().mode()&0o777}

#[test]
fn a_counted_turn_is_on_disk_before_a_kill_can_lose_it() {
    let data=scratch("kill-ledger");
    let mut s=Sidecar::start(&data);
    s.send(&event("turn_start","a"));s.send(&event("turn_end","a"));
    s.wait_moment("turn_end");
    s.kill9();
    assert_eq!(turns(&data),1,"the ledger must be written when the turn is counted, not 30 s later");
    // A restart loads it and keeps counting.
    let mut s=Sidecar::start(&data);
    s.send(&event("turn_start","b"));s.send(&event("turn_end","b"));
    s.wait_moment("turn_end");s.finish();
    assert_eq!(turns(&data),2);
}

#[test]
fn a_shown_alert_is_on_disk_before_a_kill_can_lose_it() {
    let data=scratch("kill-pending");
    let mut s=Sidecar::start(&data);
    s.send(&event("turn_start","a"));s.send(&event("needs_permission","a"));
    s.wait_moment("needs_you");
    s.kill9();
    let pending:PendingAlerts=serde_json::from_slice(&std::fs::read(data.join("pending-alerts.json")).unwrap()).unwrap();
    pending.validate().unwrap();
    assert_eq!(pending.alerts.len(),1,"an alert the user was shown must survive a kill");
    // After restart the alert is restored as uncertain (needs_you, inferred), not forgotten.
    let s=Sidecar::start(&data);
    let end=Instant::now()+Duration::from_secs(5);let mut restored=false;
    while Instant::now()<end&&!restored {
        if let Ok(v)=s.lines.recv_timeout(Duration::from_millis(50)) {
            restored=v["type"]=="snapshot"&&v["data"]["attention"]["needs_you"]==1&&v["data"]["agents"][0]["confidence"]=="inferred";
        }
    }
    assert!(restored,"restart did not restore the pending alert");s.kill9();
}

#[test]
fn files_stay_valid_whenever_the_process_is_killed() {
    let data=scratch("kill-anywhere");
    for round in 0..16u64 {
        let mut s=Sidecar::start(&data);
        for i in 0..6 {
            let turn=format!("{round}-{i}");
            s.send(&event("turn_start",&turn));s.send(&event(if i%2==0{"needs_permission"}else{"heartbeat"},&turn));s.send(&event("turn_end",&turn));
            if i==3 {std::thread::sleep(Duration::from_millis(round*3));}
        }
        std::thread::sleep(Duration::from_millis(round*4));
        s.kill9();
        for name in ["ledger.json","pending-alerts.json"] {
            let path=data.join(name);if !path.exists() {continue;}
            let bytes=std::fs::read(&path).unwrap();
            if name=="ledger.json" {let l:Ledger=serde_json::from_slice(&bytes).expect("ledger torn");l.validate().unwrap();}
            else {let p:PendingAlerts=serde_json::from_slice(&bytes).expect("pending torn");p.validate().unwrap();}
            assert_eq!(mode(&path),0o600);
        }
    }
    assert!(turns(&data)>=1);
}

#[test]
fn torn_or_foreign_files_are_moved_aside_and_stale_temp_files_removed() {
    let data=scratch("torn");
    let valid=json!({"schema_version":1}).to_string();
    std::fs::write(data.join("ledger.json"),&valid[..valid.len()-3]).unwrap();           // torn write
    std::fs::write(data.join("pending-alerts.json"),b"\x00\x01 not json").unwrap();
    let stale=data.join(".busyholm-1-deadbeef.tmp");let fresh=data.join(".busyholm-2-cafe.tmp");
    std::fs::write(&stale,b"partial").unwrap();std::fs::write(&fresh,b"in progress").unwrap();
    let old=std::time::SystemTime::now()-Duration::from_secs(3600);
    std::fs::File::options().write(true).open(&stale).unwrap().set_modified(old).unwrap();
    let s=Sidecar::start(&data);
    // the stored state is loaded right after the receiver starts; the pending file is rewritten once that is done
    let end=Instant::now()+Duration::from_secs(5);
    while Instant::now()<end&&!std::fs::read(data.join("pending-alerts.json")).is_ok_and(|b|serde_json::from_slice::<Value>(&b).is_ok()) {std::thread::sleep(Duration::from_millis(5));}
    assert!(data.join("ledger.json.corrupt").exists());
    assert!(data.join("pending-alerts.json.corrupt").exists());
    assert!(!stale.exists(),"a temp file left by a killed write is removed");
    assert!(fresh.exists(),"a recent temp file may belong to a live writer");
    s.finish();
    assert_eq!(turns(&data),0,"the service starts a fresh valid ledger");
    for name in ["ledger.json","pending-alerts.json","runtime.json","receiver-keys.json","salt"] {
        let p=data.join(name);if p.exists() {assert_eq!(mode(&p),0o600,"{name}");}
    }
    assert_eq!(mode(&data),0o700);
}

#[test]
fn atomic_write_keeps_the_old_file_when_it_cannot_finish_and_refuses_links() {
    let data=scratch("atomic");let path=data.join("x.json");
    collector::private_io::atomic_bytes(&path,b"one").unwrap();
    collector::private_io::atomic_bytes(&path,b"two").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(),b"two");assert_eq!(mode(&path),0o600);
    let target=data.join("real");std::fs::write(&target,b"secret").unwrap();
    let link=data.join("link.json");std::os::unix::fs::symlink(&target,&link).unwrap();
    assert!(collector::private_io::atomic_bytes(&link,b"x").is_err());
    assert_eq!(std::fs::read(&target).unwrap(),b"secret");
    let dir=data.join("a-directory");std::fs::create_dir(&dir).unwrap();
    assert!(collector::private_io::atomic_bytes(&dir,b"x").is_err());
    let leftovers:Vec<_>=std::fs::read_dir(&data).unwrap().flatten().filter(|e|e.file_name().to_string_lossy().ends_with(".tmp")).collect();
    assert!(leftovers.is_empty(),"a failed write must not leave its temp file");
}

#[test]
fn the_ledger_is_emitted_at_start_and_after_every_flush_not_only_on_quit() {
    let data=scratch("ledger-output");
    let mut s=Sidecar::start(&data);
    let first=s.wait_type("ledger");
    assert_eq!(first["data"]["days"].as_object().map_or(0,|d|d.len()),0,"the start-up ledger is the (empty) loaded one");
    s.send(&event("turn_start","a"));s.send(&event("turn_end","a"));
    let end=Instant::now()+Duration::from_secs(5);let mut turns=0;
    while Instant::now()<end&&turns==0 {
        if let Ok(v)=s.lines.recv_timeout(Duration::from_millis(50)) {
            if v["type"]=="ledger" {turns=v["data"]["days"].as_object().unwrap().values().map(|d|d["claude"]["turns"].as_u64().unwrap_or(0)).sum();}
        }
    }
    assert_eq!(turns,1,"a flush announces the new ledger without waiting for shutdown");
    s.kill9();
}
