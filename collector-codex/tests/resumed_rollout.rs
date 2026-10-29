//! A rollout too old for the startup scan that gets new lines later (a resumed or long idle session) is followed
//! from now on: its history is not replayed as new work.
use std::{fs, io::Write, path::{Path, PathBuf}, sync::{Arc, atomic::{AtomicU64, Ordering}},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use collector::{Adapter, AdapterContext, FakeClock, IdentityHasher};
use collector::contracts::{AgentEvent, agent_event::EventKind};
use collector_codex::CodexAdapter;
use serde_json::{json, Value};

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 }
fn ctx() -> AdapterContext {
    AdapterContext { clock: Arc::new(FakeClock::new(now_ms())), identities: IdentityHasher::new([41; 32]) }
}
fn envelope(kind: &str, payload: Value, at: u64) -> Vec<u8> {
    serde_json::to_vec(&json!({"timestamp": at, "type": kind, "payload": payload})).unwrap()
}
fn turn(at: u64) -> [Vec<u8>; 2] {
    [envelope("event_msg", json!({"type":"task_started"}), at), envelope("event_msg", json!({"type":"task_complete"}), at)]
}
fn append(path: &Path, records: &[Vec<u8>]) {
    let mut file = fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
    for record in records { file.write_all(record).unwrap(); file.write_all(b"\n").unwrap(); }
    file.sync_all().unwrap();
}

// Inside the repository's target folder, as in fix_a_m4.rs: macOS temp dirs sit under /var, a symlink.
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("target/resumed-rollout-tests")
            .join(format!("{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&path).unwrap(); Self(path)
    }
}
impl Drop for Scratch { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

#[test]
fn an_old_rollout_that_wakes_up_reports_only_its_new_turn() {
    let scratch = Scratch::new(); let root = scratch.0.join("sessions");
    let date = root.join("2026/10/12"); fs::create_dir_all(&date).unwrap();
    let file = date.join("rollout-resumed.jsonl");
    let old = now_ms() - 2 * 3_600_000;
    let mut history = vec![envelope("session_meta", json!({"id":"SYNTHETIC-RESUMED-SESSION", "source":"cli"}), old)];
    for k in 0..3 { history.extend(turn(old + k * 60_000)); }
    append(&file, &history);
    fs::File::options().write(true).open(&file).unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(3_600)).unwrap();

    let mut adapter = CodexAdapter::watch(&root).unwrap();
    assert!(adapter.rebuild(&ctx()).unwrap().is_empty(), "too old for the startup scan");
    append(&file, &turn(now_ms()));
    let start = Instant::now(); let mut seen: Vec<AgentEvent> = Vec::new();
    while start.elapsed() < Duration::from_secs(5) && !seen.iter().any(|e| e.kind == EventKind::TurnEnd) {
        seen.extend(adapter.poll(&ctx()).unwrap());
        std::thread::sleep(Duration::from_millis(20));
    }
    // let any late notice or backstop rescan run too
    std::thread::sleep(Duration::from_millis(2_200));
    seen.extend(adapter.poll(&ctx()).unwrap());
    let count = |kind: EventKind| seen.iter().filter(|e| e.kind == kind).count();
    assert_eq!((count(EventKind::TurnStart), count(EventKind::TurnEnd)), (1, 1), "only the new turn");
}
