//! WP-03 integration: the REAL shim binary posts synthetic hook bodies to the REAL receiver inside the
//! REAL collector service (the one the sidecar and the app run), which routes them by `X-Busyholm-Agent`
//! to the real Claude and Codex adapters. Nothing is mocked except the agents themselves.
//! Every content field carries a canary; no canary byte may appear in any output or any file.
#![cfg(unix)]

use collector::{Clock, CollectorInput, CollectorOutput, EventBus, SystemClock};
use serde_json::Value;
use sidecar::Roots;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_busyholm-hook");
const CANARIES: [&str; 6] = ["BHCANARY_prompt", "BHCANARY_cmd", "BHCANARY_cwd", "BHCANARY_msg", "BHCANARY_path", "BHCANARY_email"];

fn shim(agent: &str, runtime: &Path, body: &str) -> std::process::Output {
    let mut child = Command::new(BIN)
        .args(["hook", "--agent", agent, "--runtime"]).arg(runtime)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(body.as_bytes()).unwrap();
    child.wait_with_output().unwrap()
}

fn files_under(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let p = entry.path();
        if p.is_dir() { files_under(&p, out); } else { out.push(p); }
    }
}

struct Live {
    outputs: mpsc::Receiver<CollectorOutput>,
    sender: collector::EventSender,
    handle: Option<std::thread::JoinHandle<std::io::Result<()>>>,
}
impl Live {
    fn start(data: &Path, roots: Roots) -> Live {
        let bus = EventBus::bounded(4096);
        let sender = bus.sender();
        let (tx, outputs) = mpsc::channel();
        let data = data.to_path_buf();
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let handle = std::thread::spawn(move || {
            sidecar::run(data, 7, &roots, clock, bus, move |o| { let _ = tx.send(o); Ok(()) })
        });
        Live { outputs, sender, handle: Some(handle) }
    }
    /// Collect outputs until `done` accepts the accumulated list or the time runs out.
    fn wait(&self, seen: &mut Vec<Value>, secs: u64, done: impl Fn(&[Value]) -> bool) {
        let end = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < end && !done(seen) {
            if let Ok(o) = self.outputs.recv_timeout(Duration::from_millis(100)) {
                seen.push(serde_json::to_value(&o).unwrap());
            }
        }
    }
    fn stop(mut self) -> Vec<Value> {
        let _ = self.sender.shutdown();
        let mut rest = Vec::new();
        self.handle.take().unwrap().join().unwrap().unwrap();
        while let Ok(o) = self.outputs.try_recv() { rest.push(serde_json::to_value(&o).unwrap()); }
        rest
    }
}
fn latest_snapshot(seen: &[Value]) -> Option<&Value> {
    seen.iter().rev().find(|v| v["type"] == "snapshot").map(|v| &v["data"])
}
fn moments(seen: &[Value], kind: &str, agent: &str) -> usize {
    seen.iter().filter(|v| v["type"] == "moment" && v["data"]["kind"] == kind && v["data"]["tool"] == agent).count()
}

#[test]
fn real_shim_to_real_service_routes_claude_and_codex_and_keeps_every_canary_out() {
    let tmp = tempfile::tempdir().unwrap();
    // macOS temp folders sit under the /var symlink, which the Codex adapter refuses to follow.
    let base = tmp.path().canonicalize().unwrap();
    let data = base.join("data");
    let claude_root = base.join("claude");
    let codex_sessions = base.join("codex/sessions");
    std::fs::create_dir_all(&claude_root).unwrap();
    std::fs::create_dir_all(&codex_sessions).unwrap();
    let live = Live::start(&data, Roots { claude: Some(claude_root), codex_sessions: Some(codex_sessions) });
    let runtime = data.join("runtime.json");
    let end = Instant::now() + Duration::from_secs(5);
    while !runtime.exists() && Instant::now() < end { std::thread::sleep(Duration::from_millis(20)); }
    assert!(runtime.exists(), "the service must publish runtime.json");

    // Claude: a turn starts, then a permission request carrying content that must not survive.
    for body in [
        r#"{"hook_event_name":"UserPromptSubmit","session_id":"claude-sess-1","prompt":"BHCANARY_prompt","cwd":"/BHCANARY_cwd"}"#,
        r#"{"hook_event_name":"PermissionRequest","session_id":"claude-sess-1","tool_name":"Bash","tool_input":{"command":"BHCANARY_cmd"},"cwd":"/BHCANARY_cwd","user_email":"BHCANARY_email"}"#,
    ] {
        let out = shim("claude", &runtime, body);
        assert_eq!(out.status.code(), Some(0));
        assert!(out.stdout.is_empty() && out.stderr.is_empty());
    }
    // Codex: the same through the Codex adapter.
    for body in [
        r#"{"hook_event_name":"UserPromptSubmit","session_id":"codex-thread-1","turn_id":"turn-1","prompt":"BHCANARY_prompt","host":"cli"}"#,
        r#"{"hook_event_name":"PermissionRequest","session_id":"codex-thread-1","turn_id":"turn-1","request_id":"req-1","tool_name":"shell","tool_input":{"command":"BHCANARY_cmd"},"message":"BHCANARY_msg"}"#,
    ] {
        let out = shim("codex", &runtime, body);
        assert_eq!(out.status.code(), Some(0));
        assert!(out.stdout.is_empty() && out.stderr.is_empty());
    }

    let mut seen = Vec::new();
    live.wait(&mut seen, 5, |s| moments(s, "needs_you", "claude") == 1 && moments(s, "needs_you", "codex") == 1);
    assert_eq!(moments(&seen, "needs_you", "claude"), 1, "Claude permission request must reach the state machine");
    assert_eq!(moments(&seen, "needs_you", "codex"), 1, "Codex permission request must reach the state machine: {seen:?}");
    live.wait(&mut seen, 2, |s| latest_snapshot(s).is_some_and(|d| d["attention"]["needs_you"] == 2));
    let snap = latest_snapshot(&seen).expect("a snapshot").clone();
    assert_eq!(snap["attention"]["needs_you"], 2);

    // Codex finishes its turn: a Moment and a ledger turn.
    let out = shim("codex", &runtime, r#"{"hook_event_name":"Stop","session_id":"codex-thread-1","turn_id":"turn-1","last_assistant_message":"BHCANARY_msg"}"#);
    assert_eq!(out.status.code(), Some(0));
    live.wait(&mut seen, 5, |s| moments(s, "turn_end", "codex") == 1);
    assert_eq!(moments(&seen, "turn_end", "codex"), 1);

    seen.extend(live.stop());
    let ledger = std::fs::read_to_string(data.join("ledger.json")).expect("ledger flushed on shutdown");
    let ledger: Value = serde_json::from_str(&ledger).unwrap();
    let turns: u64 = ledger["days"].as_object().unwrap().values()
        .map(|d| d["codex"]["turns"].as_u64().unwrap_or(0)).sum();
    assert_eq!(turns, 1, "the Codex turn is counted once");

    // No canary in any output and no canary in any file the service wrote (or the whole temp tree).
    let all = serde_json::to_string(&seen).unwrap();
    for c in CANARIES { assert!(!all.contains(c), "{c} leaked into an output"); }
    let mut files = Vec::new();
    files_under(tmp.path(), &mut files);
    for f in files {
        let bytes = std::fs::read(&f).unwrap_or_default();
        for c in CANARIES { assert!(!bytes.windows(c.len()).any(|w| w == c.as_bytes()), "{c} in {f:?}"); }
    }
    let _ = CollectorInput::Shutdown; // keep the public input type exercised by this crate's imports
}

fn coverage_of(seen: &[Value], tool: &str) -> Option<(String, Value, String)> {
    let snap = latest_snapshot(seen)?;
    let t = snap["tools"].as_array()?.iter().find(|t| t["tool"] == tool)?;
    Some((t["coverage"].as_str()?.to_string(), t["coverage_reason"].clone(), t["presence"].as_str()?.to_string()))
}
fn is_coverage(seen: &[Value], tool: &str, coverage: &str) -> bool {
    coverage_of(seen, tool).is_some_and(|c| c.0 == coverage)
}

/// INT-1 (SPEC Revision 1 item 2): "verified" is earned by a real hook event that went through the real shim,
/// the real receiver and the real router; it survives a restart; log or registry activity alone never earns it.
#[test]
fn a_hook_through_the_real_shim_flips_coverage_to_verified_and_a_restart_keeps_it() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let data = base.join("data");
    let (claude_root, codex_sessions) = (base.join("claude"), base.join("codex/sessions"));
    std::fs::create_dir_all(&claude_root).unwrap();
    std::fs::create_dir_all(&codex_sessions).unwrap();
    let roots = || Roots { claude: Some(claude_root.clone()), codex_sessions: Some(codex_sessions.clone()) };
    let live = Live::start(&data, roots());
    let runtime = data.join("runtime.json");
    let end = Instant::now() + Duration::from_secs(5);
    while !runtime.exists() && Instant::now() < end { std::thread::sleep(Duration::from_millis(20)); }
    assert!(runtime.exists(), "the service must publish runtime.json");

    let mut seen = Vec::new();
    live.wait(&mut seen, 2, |s| latest_snapshot(s).is_some());
    assert!(coverage_of(&seen, "claude").is_none(), "no connector, so no coverage claim, before any activity");

    let out = shim("claude", &runtime, r#"{"hook_event_name":"UserPromptSubmit","session_id":"cov-claude-1","prompt":"BHCANARY_prompt","cwd":"/BHCANARY_cwd"}"#);
    assert_eq!(out.status.code(), Some(0));
    live.wait(&mut seen, 5, |s| is_coverage(s, "claude", "verified"));
    let c = coverage_of(&seen, "claude").expect("the Claude connector appears with the first hook");
    assert_eq!((c.0.as_str(), &c.1), ("verified", &Value::Null), "the snapshot's coverage flips to verified: {seen:?}");
    assert!(coverage_of(&seen, "codex").is_none(), "Codex has not sent a hook");

    let out = shim("codex", &runtime, r#"{"hook_event_name":"UserPromptSubmit","session_id":"cov-codex-1","turn_id":"turn-1","prompt":"BHCANARY_prompt","host":"cli"}"#);
    assert_eq!(out.status.code(), Some(0));
    live.wait(&mut seen, 5, |s| is_coverage(s, "codex", "verified"));
    assert!(is_coverage(&seen, "codex", "verified"), "Codex flips on its own hook: {seen:?}");
    assert!(is_coverage(&seen, "claude", "verified"));
    seen.extend(live.stop());

    let record = std::fs::read_to_string(data.join("coverage.json")).expect("coverage.json written");
    let record: Value = serde_json::from_str(&record).unwrap();
    assert_eq!(record["entries"].as_array().unwrap().len(), 2);

    // A restart keeps both, offline until the tools show up again.
    let again = Live::start(&data, roots());
    let mut seen2 = Vec::new();
    again.wait(&mut seen2, 5, |s| is_coverage(s, "claude", "verified") && is_coverage(s, "codex", "verified"));
    for t in ["claude", "codex"] {
        let c = coverage_of(&seen2, t).unwrap_or_else(|| panic!("{t} connector restored: {seen2:?}"));
        assert_eq!((c.0.as_str(), &c.1, c.2.as_str()), ("verified", &Value::Null, "offline"), "{t}");
    }
    seen2.extend(again.stop());

    // Privacy: no canary in any output or file, including the new coverage record.
    let all = serde_json::to_string(&(seen, seen2)).unwrap();
    for c in CANARIES { assert!(!all.contains(c), "{c} leaked into an output"); }
    let mut files = Vec::new();
    files_under(tmp.path(), &mut files);
    for f in files {
        let bytes = std::fs::read(&f).unwrap_or_default();
        for c in CANARIES { assert!(!bytes.windows(c.len()).any(|w| w == c.as_bytes()), "{c} in {f:?}"); }
    }
}
