//! Review r1 H5: a Claude agent killed while it waits for permission must not leave its alert up forever. The
//! process scanner gives the Claude adapter positive evidence that the session's process is gone. Synthetic
//! registry files and a fake process source only; no real ~/.claude is read.
use std::{path::PathBuf, sync::{Arc, Mutex}};
use collector::{Adapter, AdapterContext, AdapterError, Collector, FakeClock, IdentityHasher, ledger::FixedCalendar,
    contracts::{AgentEvent, agent_event::EventKind, common::Tool}};
use collector_claude::ClaudeConfig;
use collector_wp06::{ProcInfo, ProcessSource};
use serde_json::json;

const START: u64 = 1_791_806_000_000;
const NOW: u64 = START + 60_000;

#[derive(Clone)]
struct Fake(Arc<Mutex<Result<Vec<ProcInfo>, AdapterError>>>);
impl ProcessSource for Fake {
    fn snapshot(&mut self) -> Result<Vec<ProcInfo>, AdapterError> { self.0.lock().unwrap().clone() }
}
impl Fake {
    fn set(&self, procs: Vec<ProcInfo>) { *self.0.lock().unwrap() = Ok(procs); }
    fn fail(&self) { *self.0.lock().unwrap() = Err(AdapterError::Io); }
}
fn claude(pid: u32) -> ProcInfo {
    ProcInfo { pid, start_ms: START, name: "2.1.0".into(), path: Some("/Users/someone/.local/share/claude/versions/2.1.0".into()) }
}
fn scratch(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("bh-fixa-h5-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(p.join("sessions")).unwrap();
    p
}
fn register(root: &PathBuf, pid: u32, session: &str) {
    let entry = json!({"pid": pid, "sessionId": session, "startedAt": START, "procStart": sidecar::lstart(START), "kind": "interactive",
        "entrypoint": "cli", "status": "busy", "statusUpdatedAt": START + 1000});
    std::fs::write(root.join(format!("sessions/{pid}.json")), entry.to_string()).unwrap();
}
struct World { adapter: sidecar::ClaudeWithProcesses, ctx: AdapterContext, clock: Arc<FakeClock>, core: Collector, procs: Fake }
fn world(root: &PathBuf, procs: Vec<ProcInfo>) -> World {
    let clock = Arc::new(FakeClock::new(NOW));
    let ctx = AdapterContext { clock: clock.clone(), identities: IdentityHasher::new([5; 32]) };
    let fake = Fake(Arc::new(Mutex::new(Ok(procs))));
    let adapter = sidecar::claude_adapter(ClaudeConfig { root: root.clone() }, Some(Box::new(fake.clone())));
    let core = Collector::with_calendar(clock.clone(), 1, Arc::new(FixedCalendar(0)));
    let mut w = World { adapter, ctx, clock, core, procs: fake };
    let events = w.adapter.rebuild(&w.ctx).unwrap();
    w.core.rebuild(events).unwrap();
    w
}
impl World {
    fn poll(&mut self) -> Vec<AgentEvent> {
        let events = self.adapter.poll(&self.ctx).unwrap();
        for e in &events { let _ = self.core.ingest(e.clone()); }
        events
    }
    fn hook(&mut self, name: &str, session: &str, request: &str) {
        let body = json!({"hook_event_name": name, "session_id": session, "tool_use_id": request, "tool_name": "Bash"});
        for e in self.adapter.map_hook(body.to_string().as_bytes(), &self.ctx).unwrap() { self.core.ingest(e).unwrap(); }
    }
}

#[test]
fn h5_a_killed_claude_session_closes_its_pending_alert() {
    let root = scratch("killed");
    register(&root, 4242, "session-h5");
    let mut w = world(&root, vec![claude(4242)]);
    w.hook("PermissionRequest", "session-h5", "request-1");
    assert_eq!(w.core.pending_alerts().alerts.len(), 1, "the permission request is pending");
    // Killed without a SessionEnd hook: the registry file stays behind, the process is gone.
    w.procs.set(vec![]);
    w.clock.advance(6_000);
    let events = w.poll();
    assert!(events.iter().any(|e| e.kind == EventKind::SessionEnd && e.agent == Tool::Claude),
        "the scanner's snapshot proves the session's process is gone");
    assert!(w.core.pending_alerts().alerts.is_empty(), "a dead agent's alert does not stay up");
}

#[test]
fn h5_a_failed_snapshot_is_not_evidence_of_death() {
    let root = scratch("failed");
    register(&root, 4242, "session-h5f");
    let mut w = world(&root, vec![claude(4242)]);
    w.hook("PermissionRequest", "session-h5f", "request-1");
    w.procs.fail();
    w.clock.advance(6_000);
    w.poll();
    assert_eq!(w.core.pending_alerts().alerts.len(), 1, "a scan that failed proves nothing");
}

#[test]
fn h5_a_session_that_starts_between_scans_is_not_taken_for_a_crash_leftover() {
    let root = scratch("between");
    let mut w = world(&root, vec![]);
    // One second later (no 5 s rescan due), a new Claude process registers itself.
    w.clock.advance(1_000);
    w.procs.set(vec![claude(4343)]);
    register(&root, 4343, "session-new");
    let events = w.poll();
    assert!(events.iter().any(|e| e.kind == EventKind::SessionStart),
        "a registry entry newer than the last snapshot is checked against a fresh one, not declared dead");
    w.clock.advance(1_000);
    w.hook("PermissionRequest", "session-new", "request-1");
    assert_eq!(w.core.pending_alerts().alerts.len(), 1);
}

#[test]
fn h5_claude_processes_this_root_does_not_register_are_not_reported() {
    // Another config folder's session, or any Claude process on the machine, is not this connector's resident.
    let root = scratch("foreign");
    let mut w = world(&root, vec![claude(5555)]);
    w.clock.advance(6_000);
    assert!(w.poll().is_empty());
    assert!(w.core.snapshot().agents.is_empty());
}

#[cfg(target_os = "macos")]
#[test]
fn h5_lstart_matches_ps_for_this_process() {
    // The registry's procStart must byte-equal what we format, or every live session would look dead.
    let me = std::process::id();
    let mine = collector_wp06::procscan::system_source().snapshot().unwrap().into_iter().find(|p| p.pid == me).expect("own process listed");
    let ps = std::process::Command::new("ps").args(["-o", "lstart=", "-p", &me.to_string()]).output().unwrap();
    let expected = String::from_utf8(ps.stdout).unwrap().trim().to_string();
    assert_eq!(sidecar::lstart(mine.start_ms), expected);
}

/// INT-4: the laptop changes time zone while a session runs. The registry still holds the old `procStart` string, the
/// scanner now formats the same process start differently. The pid is present, so there is no evidence of death.
#[test]
fn int4_a_live_pid_with_a_shifted_start_string_is_unknown_not_dead() {
    let root = scratch("tzshift");
    register(&root, 4242, "session-tz");
    let mut w = world(&root, vec![claude(4242)]);
    w.hook("PermissionRequest", "session-tz", "request-1");
    assert_eq!(w.core.pending_alerts().alerts.len(), 1);
    // Same process (same pid), start time now printed one hour later by a changed time zone.
    w.procs.set(vec![ProcInfo { start_ms: START + 3_600_000, ..claude(4242) }]);
    w.clock.advance(6_000);
    let events = w.poll();
    assert!(!events.iter().any(|e| e.kind == EventKind::SessionEnd), "a present pid is not proof of death: {events:?}");
    assert_eq!(w.core.pending_alerts().alerts.len(), 1, "the alert stays up");
    assert_eq!(w.core.snapshot().agents.len(), 1, "no ghost resident from the unmatched start string either");
}

/// The other half of the contract: a pid that is absent is still dead.
#[test]
fn int4_an_absent_pid_is_still_dead() {
    let root = scratch("absent");
    register(&root, 4242, "session-abs");
    let mut w = world(&root, vec![claude(4242)]);
    w.procs.set(vec![claude(9999)]);
    w.clock.advance(6_000);
    let events = w.poll();
    assert!(events.iter().any(|e| e.kind == EventKind::SessionEnd));
}
