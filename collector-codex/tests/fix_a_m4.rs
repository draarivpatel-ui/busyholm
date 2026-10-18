//! FIX-A M4: a Codex sessions root that does not exist at launch is registered provisionally
//! and its watcher attaches when the folder appears, without changing the connector identity.
use std::{fs, io::Write, path::{Path, PathBuf}, sync::{Arc, atomic::{AtomicU64, Ordering}},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use collector::{Adapter, AdapterContext, FakeClock, IdentityHasher};
use collector::contracts::{AgentEvent, Validate, agent_event::{EventKind, EventSource}};
use collector_codex::CodexAdapter;
use serde_json::{json, Value};

const SID: &str = "SYNTHETIC-SESSION-ID-CANARY";
const TEXT: &str = "FIXA-M4-CONTENT-CANARY";

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 }
fn ctx() -> AdapterContext {
    AdapterContext { clock: Arc::new(FakeClock::new(now_ms())), identities: IdentityHasher::new([37; 32]) }
}
fn envelope(kind: &str, payload: Value, at: u64) -> Vec<u8> {
    serde_json::to_vec(&json!({"timestamp": at, "type": kind, "payload": payload})).unwrap()
}
fn meta(id: &str) -> Vec<u8> {
    envelope("session_meta", json!({"id":id, "source":"cli", "cwd":TEXT}), now_ms())
}
fn task_started() -> Vec<u8> {
    envelope("event_msg", json!({"type":"task_started","turn_id":TEXT}), now_ms())
}
fn hook(kind: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"hook_event_name":kind,"session_id":SID,"tool_name":"Bash",
        "tool_input":{"command":TEXT},"prompt":TEXT,"cwd":TEXT})).unwrap()
}
fn append(path: &Path, records: &[Vec<u8>]) {
    let mut file = fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
    for record in records { file.write_all(record).unwrap(); file.write_all(b"\n").unwrap(); }
    file.sync_all().unwrap();
}

// Scratch stays inside the repository (as in acceptance.rs): macOS temp dirs sit under /var, a symlink.
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("target/fixa-m4-tests")
            .join(format!("{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&path).unwrap(); Self(path)
    }
}
impl Drop for Scratch { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

fn poll_until(adapter: &mut CodexAdapter, limit: Duration, done: impl Fn(&[AgentEvent]) -> bool) -> Vec<AgentEvent> {
    let start = Instant::now(); let mut seen = Vec::new();
    while start.elapsed() < limit {
        seen.extend(adapter.poll(&ctx()).unwrap());
        if done(&seen) { break; }
        std::thread::sleep(Duration::from_millis(20));
    }
    seen
}

#[test]
fn missing_sessions_root_is_accepted_and_hooks_map() {
    let scratch = Scratch::new(); let root = scratch.0.join("codex-home/sessions");
    let mut adapter = CodexAdapter::watch_or_wait(&root).expect("a missing root must be accepted");
    assert!(!root.exists(), "constructing must not create the folder");
    let hooks = adapter.map_hook(&hook("PermissionRequest"), &ctx()).unwrap();
    for event in &hooks { event.validate().unwrap(); }
    assert_eq!(hooks[0].kind, EventKind::NeedsPermission);
    assert_eq!(hooks[0].source, EventSource::Hook);
    assert!(adapter.poll(&ctx()).unwrap().is_empty(), "nothing to read while the folder is missing");
    assert!(!root.exists(), "polling must not create the folder");
}

#[test]
fn existing_root_behaves_like_watch() {
    let scratch = Scratch::new(); let root = scratch.0.join("sessions"); fs::create_dir(&root).unwrap();
    let mut adapter = CodexAdapter::watch_or_wait(&root).unwrap();
    let date = root.join("2026/10/12"); fs::create_dir_all(&date).unwrap();
    append(&date.join("rollout-existing.jsonl"), &[meta(SID), task_started()]);
    let seen = poll_until(&mut adapter, Duration::from_secs(5), |s| s.iter().any(|e| e.kind == EventKind::TurnStart));
    assert!(seen.iter().any(|e| e.kind == EventKind::SessionStart));
}

#[test]
fn root_id_is_identical_before_and_after_the_folder_appears() {
    let scratch = Scratch::new(); let root = scratch.0.join("a/b/sessions");
    let provisional = CodexAdapter::watch_or_wait(&root).unwrap().root_id(&ctx());
    fs::create_dir_all(&root).unwrap();
    assert_eq!(provisional, CodexAdapter::for_root(&root).unwrap().root_id(&ctx()));
    assert_eq!(provisional, CodexAdapter::watch(&root).unwrap().root_id(&ctx()));
    // A hook mapped before the folder existed carries the same connector id as one mapped after.
    let early = CodexAdapter::watch_or_wait(scratch.0.join("c/sessions")).unwrap();
    fs::create_dir_all(scratch.0.join("c/sessions")).unwrap();
    let late = CodexAdapter::for_root(scratch.0.join("c/sessions")).unwrap();
    assert_eq!(early.root_id(&ctx()), late.root_id(&ctx()));
}

#[test]
fn first_rollout_in_a_new_folder_flows_out_of_poll() {
    let scratch = Scratch::new(); let root = scratch.0.join("codex-home/sessions");
    let mut adapter = CodexAdapter::watch_or_wait(&root).unwrap();
    assert!(adapter.poll(&ctx()).unwrap().is_empty());
    let date = root.join("2026/10/12"); fs::create_dir_all(&date).unwrap();
    append(&date.join("rollout-first-ever.jsonl"), &[meta(SID), task_started()]);
    let seen = poll_until(&mut adapter, Duration::from_secs(5), |s|
        s.iter().any(|e| e.kind == EventKind::SessionStart) && s.iter().any(|e| e.kind == EventKind::TurnStart));
    for event in &seen { event.validate().unwrap(); }
    assert!(seen.iter().any(|e| e.kind == EventKind::SessionStart), "SessionStart missing");
    assert!(seen.iter().any(|e| e.kind == EventKind::TurnStart), "TurnStart missing");
    assert_eq!(adapter.diagnostics().io_errors, 0);
    // The session identity is shared with a hook mapped through the same adapter afterwards.
    let hooks = adapter.map_hook(&hook("PermissionRequest"), &ctx()).unwrap();
    assert_eq!(hooks[0].kind, EventKind::NeedsPermission);
    // Later appends are still followed.
    append(&date.join("rollout-first-ever.jsonl"), &[envelope("event_msg", json!({"type":"turn_aborted"}), now_ms())]);
    let more = poll_until(&mut adapter, Duration::from_secs(5), |s| s.iter().any(|e| e.kind == EventKind::TurnInterrupted));
    assert!(more.iter().any(|e| e.kind == EventKind::TurnInterrupted));
}

#[cfg(unix)]
#[test]
fn symlinked_ancestor_and_parent_components_are_still_rejected() {
    let scratch = Scratch::new();
    let real = scratch.0.join("real"); fs::create_dir(&real).unwrap();
    let link = scratch.0.join("link"); std::os::unix::fs::symlink(&real, &link).unwrap();
    assert!(CodexAdapter::watch_or_wait(link.join("sessions")).is_err(), "missing leaf below a symlinked ancestor");
    assert!(CodexAdapter::watch_or_wait(link.join("x/y/sessions")).is_err(), "deeper missing part below a symlink");
    assert!(CodexAdapter::watch_or_wait(&link).is_err(), "an existing symlink root");
    assert!(CodexAdapter::watch_or_wait(scratch.0.join("real/../other/sessions")).is_err(), "parent component");
    assert!(CodexAdapter::watch_or_wait(scratch.0.join("nope/../sessions")).is_err(), "parent component in the missing part");
    assert!(!scratch.0.join("other").exists());
}

#[cfg(unix)]
#[test]
fn a_symlink_planted_at_the_root_is_not_attached_and_is_counted() {
    let scratch = Scratch::new(); let root = scratch.0.join("codex-home/sessions");
    let mut adapter = CodexAdapter::watch_or_wait(&root).unwrap();
    let elsewhere = scratch.0.join("elsewhere/2026/10/12"); fs::create_dir_all(&elsewhere).unwrap();
    append(&elsewhere.join("rollout-other.jsonl"), &[meta(SID), task_started()]);
    fs::create_dir_all(root.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(scratch.0.join("elsewhere"), &root).unwrap();
    let seen = poll_until(&mut adapter, Duration::from_millis(1500), |s| !s.is_empty());
    assert!(seen.is_empty(), "a symlinked root must never be read");
    assert_eq!(adapter.diagnostics().io_errors, 1, "counted once, not every second");
    std::thread::sleep(Duration::from_millis(1100));
    assert!(adapter.poll(&ctx()).unwrap().is_empty());
    assert_eq!(adapter.diagnostics().io_errors, 1);
}
