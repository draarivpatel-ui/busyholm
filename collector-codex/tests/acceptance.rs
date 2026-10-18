use std::{fs, io::Write, path::{Path, PathBuf}, sync::{Arc, atomic::{AtomicU64, Ordering}}, time::{Duration, Instant}};
use collector::{Adapter, AdapterContext, FakeClock, IdentityHasher};
use collector::contracts::{AgentEvent, Validate, agent_event::{EventKind, EventSource, StopReason}, common::{Host, Window}};
use collector_codex::{CodexAdapter, RolloutStream, RolloutTailer, match_process};
use serde_json::{json, Value};

const NOW: u64 = 1_791_806_400_000;
const SID: &str = "SYNTHETIC-SESSION-ID-CANARY";
const ACCOUNT: &str = "WP05-ACCOUNT-ID-CANARY";
const USER: &str = "WP05-USER-ID-CANARY";
const TEXT: &str = "WP05-CONTENT-CANARY";

fn ctx() -> AdapterContext {
    AdapterContext { clock: Arc::new(FakeClock::new(NOW)), identities: IdentityHasher::new([37; 32]) }
}
fn envelope(kind: &str, payload: Value, at: u64) -> Vec<u8> {
    serde_json::to_vec(&json!({"timestamp": at, "type": kind, "payload": payload})).unwrap()
}
fn meta(id: &str) -> Vec<u8> {
    envelope("session_meta", json!({"id":id, "source":"cli", "cwd":TEXT,
        "creator_account_id":ACCOUNT,"creator_user_id":USER,"git":{"branch":TEXT}}), NOW)
}
fn event(kind: &str, at: u64) -> Vec<u8> {
    envelope("event_msg", json!({"type":kind,"turn_id":TEXT,"reason":"interrupted",
        "last_agent_message":TEXT,"prompt":TEXT}), at)
}
fn usage(primary: Value, secondary: Value, at: u64) -> Vec<u8> {
    envelope("event_msg", json!({"type":"token_count","info":{"total_token_usage":{"total_tokens":500}},
        "rate_limits":{"primary":primary,"secondary":secondary,"rate_limit_reached_type":null,
        "creator_account_id":ACCOUNT,"credits":{"balance":TEXT}}}), at)
}
fn window(percent: f64, minutes: u64) -> Value {
    json!({"used_percent":percent,"window_minutes":minutes,"resets_at":1_791_810_000_u64})
}
fn hook(kind: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"hook_event_name":kind,"session_id":SID,"tool_name":"Bash",
        "tool_input":{"command":TEXT},"prompt":TEXT,"last_assistant_message":TEXT,
        "transcript_path":TEXT,"cwd":TEXT,"creator_account_id":ACCOUNT,"creator_user_id":USER})).unwrap()
}
fn checked(events: &[AgentEvent]) {
    for event in events { event.validate().expect("AgentEvent v1 must validate"); }
}
fn decode(adapter: &mut CodexAdapter, stream: &mut RolloutStream, bytes: &[u8]) -> Vec<AgentEvent> {
    let events = adapter.decode_record(stream, bytes, &ctx()).unwrap();
    checked(&events);
    events
}
fn first(events: &[AgentEvent], kind: EventKind) -> &AgentEvent {
    events.iter().find(|e| e.kind == kind).expect("expected mapped event")
}
fn private_free(bytes: &str) {
    for needle in [SID, ACCOUNT, USER, TEXT, "BHCANARY_"] {
        assert!(!bytes.contains(needle), "private canary escaped");
    }
}

// Acceptance 1: a null primary invalidates the sample, including a tempting secondary.
#[test]
fn null_primary_skips_record_and_newest_good_value_is_kept() {
    let mut adapter = CodexAdapter::new(); let mut stream = RolloutStream::default();
    decode(&mut adapter, &mut stream, &meta(SID));
    let events = decode(&mut adapter, &mut stream, &usage(window(41.0, 300), window(12.0, 10_080), NOW + 100));
    assert_eq!(events.iter().filter(|e| e.kind == EventKind::UsageSample).count(), 2);
    let events = decode(&mut adapter, &mut stream, &usage(Value::Null, window(99.0, 10_080), NOW + 200));
    assert!(events.iter().all(|e| e.kind != EventKind::UsageSample));
    assert_eq!(stream.latest_usage(Window::FiveHour).unwrap().used_pct, 41.0);
    assert_eq!(stream.latest_usage(Window::Weekly).unwrap().used_pct, 12.0);
    decode(&mut adapter, &mut stream, &usage(window(55.0, 300), window(18.0, 10_080), NOW + 300));
    decode(&mut adapter, &mut stream, &usage(window(3.0, 300), window(2.0, 10_080), NOW));
    assert_eq!(stream.latest_usage(Window::FiveHour).unwrap().used_pct, 55.0);
    assert_eq!(stream.latest_usage(Window::Weekly).unwrap().used_pct, 18.0);
}

// Acceptance 2: includes serialized checkpoints and diagnostic output.
#[test]
fn account_canaries_never_leave_adapter_and_hook_and_log_share_identity() {
    let mut adapter = CodexAdapter::new(); let mut stream = RolloutStream::default();
    let events = decode(&mut adapter, &mut stream, &meta(SID));
    let session = first(&events, EventKind::SessionStart);
    let hooks = adapter.map_hook(&hook("PermissionRequest"), &ctx()).unwrap(); checked(&hooks);
    assert_eq!(session.instance, first(&hooks, EventKind::NeedsPermission).instance);
    private_free(&serde_json::to_string(&events).unwrap());
    private_free(&serde_json::to_string(&hooks).unwrap());
    private_free(&serde_json::to_string(&stream).unwrap());
    private_free(&format!("{:?}", adapter.diagnostics()));
    assert_eq!(session.instance.len(), 32);
    let different = AdapterContext { clock: Arc::new(FakeClock::new(NOW)), identities: IdentityHasher::new([38;32]) };
    assert_ne!(hooks[0].instance, adapter.map_hook(&hook("PermissionRequest"), &different).unwrap()[0].instance);
}

// Acceptance 3: collector applies these kinds to needs_you and interrupted-turn accounting.
#[test]
fn permission_and_both_interrupt_sources_map_to_canonical_kinds() {
    let mut adapter = CodexAdapter::new(); let mut stream = RolloutStream::default();
    let permission = adapter.map_hook(&hook("PermissionRequest"), &ctx()).unwrap(); checked(&permission);
    assert_eq!(permission[0].kind, EventKind::NeedsPermission);
    assert_eq!(permission[0].source, EventSource::Hook);
    let interrupt = adapter.map_hook(&hook("Interrupt"), &ctx()).unwrap(); checked(&interrupt);
    assert_eq!(interrupt[0].kind, EventKind::TurnInterrupted);
    assert_eq!(interrupt[0].detail.as_ref().unwrap().stop_reason, Some(StopReason::Interrupted));
    decode(&mut adapter, &mut stream, &meta(SID));
    let aborted = decode(&mut adapter, &mut stream, &event("turn_aborted", NOW));
    assert_eq!(aborted[0].kind, EventKind::TurnInterrupted);
    assert_eq!(aborted[0].source, EventSource::Log);
    assert!(aborted.iter().all(|e| e.kind != EventKind::TurnEnd));
}

// Acceptance 4: no arbitrary type name or payload is retained in diagnostics.
#[test]
fn unknown_envelope_increments_drift_without_error_or_content() {
    let mut adapter = CodexAdapter::new(); let mut stream = RolloutStream::default();
    assert!(decode(&mut adapter, &mut stream, &envelope(TEXT, json!({"account_id":ACCOUNT,"text":TEXT}), NOW)).is_empty());
    assert_eq!(adapter.diagnostics().unknown_envelopes, 1);
    assert!(decode(&mut adapter, &mut stream, &envelope("response_item", json!({"content":TEXT}), NOW)).is_empty());
    assert_eq!(adapter.diagnostics().unknown_envelopes, 1);
    private_free(&serde_json::to_string(&adapter.diagnostics()).unwrap());
}

// Test scratch remains inside the repository. No tempfile defaults or real agent homes.
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("target/wp05-tests")
            .join(format!("{}-{}",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed)));
        fs::create_dir_all(&path).unwrap(); Self(path)
    }
    fn file(&self) -> PathBuf { self.0.join("rollout-synthetic.jsonl") }
}
impl Drop for Scratch { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn append(path: &Path, records: &[Vec<u8>]) {
    let mut file = fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
    for record in records { file.write_all(record).unwrap(); file.write_all(b"\n").unwrap(); }
    file.sync_all().unwrap();
}

// Acceptance 5: real OS notification path, including first-prompt date-directory creation.
#[test]
fn rollout_created_at_first_prompt_registers_within_200ms() {
    let scratch = Scratch::new(); let root = scratch.0.join("sessions"); fs::create_dir(&root).unwrap();
    let mut adapter = CodexAdapter::watch(&root).unwrap();
    assert!(adapter.poll(&ctx()).unwrap().is_empty());
    let start = Instant::now();
    let date = root.join("2026/10/12"); fs::create_dir_all(&date).unwrap();
    append(&date.join("rollout-first-prompt.jsonl"), &[meta(SID), event("task_started",NOW)]);
    let mut seen = Vec::new();
    while start.elapsed() < Duration::from_millis(200) {
        seen.extend(adapter.poll(&ctx()).unwrap());
        if seen.iter().any(|e| e.kind == EventKind::SessionStart) { break; }
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(seen.iter().any(|e| e.kind == EventKind::SessionStart), "first prompt rollout was not registered within 200 ms");
    assert!(start.elapsed() < Duration::from_millis(200));
    assert!(seen.iter().any(|e| e.kind == EventKind::TurnStart)); checked(&seen);
    println!("first prompt registration: {} us",start.elapsed().as_micros());
}

#[test]
fn tailer_resumes_offset_and_completes_partial_last_line_once() {
    let scratch = Scratch::new(); let path = scratch.file(); append(&path, &[meta(SID)]);
    let mut adapter = CodexAdapter::new(); let mut tailer = RolloutTailer::new(&path).unwrap();
    let events = tailer.poll(&mut adapter, &ctx()).unwrap(); checked(&events);
    assert_eq!(events.len(),1);
    let checkpoint = tailer.checkpoint(); assert_eq!(checkpoint.offset,fs::metadata(&path).unwrap().len());
    private_free(&serde_json::to_string(&checkpoint).unwrap());
    let mut tailer = RolloutTailer::resume(&path, checkpoint.clone()).unwrap();
    assert!(tailer.poll(&mut adapter,&ctx()).unwrap().is_empty());
    let started = event("task_started",NOW); let split = started.len()/2;
    fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(&started[..split]).unwrap();
    assert!(tailer.poll(&mut adapter,&ctx()).unwrap().is_empty());
    assert_eq!(tailer.checkpoint().offset,checkpoint.offset);
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(&started[split..]).unwrap();file.write_all(b"\n").unwrap();
    let events = tailer.poll(&mut adapter,&ctx()).unwrap(); checked(&events);
    assert_eq!(events.len(),1); assert_eq!(events[0].kind,EventKind::TurnStart);
    assert!(tailer.poll(&mut adapter,&ctx()).unwrap().is_empty());
}

#[test]
fn tailer_detects_replacement_and_truncation() {
    let scratch = Scratch::new(); let path = scratch.file(); append(&path,&[meta(SID),event("task_started",NOW)]);
    let mut adapter = CodexAdapter::new(); let mut tailer = RolloutTailer::new(&path).unwrap();
    assert_eq!(tailer.poll(&mut adapter,&ctx()).unwrap().len(),2);
    fs::rename(&path,scratch.0.join("rotated.jsonl")).unwrap(); append(&path,&[meta("new-session"),event("turn_aborted",NOW)]);
    let replaced = tailer.poll(&mut adapter,&ctx()).unwrap(); checked(&replaced);
    assert_eq!(replaced.len(),2); assert_eq!(replaced[1].kind,EventKind::TurnInterrupted);
    fs::write(&path,b"").unwrap(); append(&path,&[meta("truncated-session")]);
    let truncated = tailer.poll(&mut adapter,&ctx()).unwrap(); checked(&truncated);
    assert_eq!(truncated.len(),1); assert_eq!(truncated[0].kind,EventKind::SessionStart);
}

#[test]
fn oversized_line_is_skipped_and_unicode_separator_is_not_a_newline() {
    let scratch = Scratch::new(); let path = scratch.file();
    append(&path,&[meta(SID),vec![b'x';1_048_577],envelope("response_item",json!({"text":"a\u{2028}b"}),NOW),event("task_started",NOW)]);
    let mut adapter=CodexAdapter::new();let mut tailer=RolloutTailer::new(&path).unwrap();
    let mut events=Vec::new();
    for _ in 0..32 { events.extend(tailer.poll(&mut adapter,&ctx()).unwrap()); }
    checked(&events);
    assert_eq!(events.iter().filter(|e|e.kind==EventKind::TurnStart).count(),1);
    assert_eq!(adapter.diagnostics().oversized_lines,1);
    assert_eq!(adapter.diagnostics().malformed_records,0);
}

#[test]
fn never_open_names_and_symlink_rollouts_are_rejected() {
    let scratch=Scratch::new();
    for name in ["auth.json","history.jsonl","session.key","logs_2.sqlite","config.toml"] {
        assert!(RolloutTailer::new(scratch.0.join(name)).is_err());
    }
    #[cfg(unix)] {
        let target=scratch.0.join("private.json");fs::write(&target,TEXT).unwrap();
        std::os::unix::fs::symlink(&target,scratch.file()).unwrap();
        let mut adapter=CodexAdapter::new();
        if let Ok(mut tailer)=RolloutTailer::new(scratch.file()) { assert!(tailer.poll(&mut adapter,&ctx()).is_err()); }
    }
}

#[test]
fn process_matcher_uses_only_names_paths_and_known_daemon_pid() {
    let cli=match_process("codex",Path::new("/vendor/bin/codex"),42,NOW,None).unwrap();assert_eq!(cli.host,Host::Cli);
    let desktop=match_process("codex",Path::new("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"),43,NOW,None).unwrap();
    assert_eq!(desktop.host,Host::Desktop);
    assert!(match_process("codex",Path::new("/vendor/bin/codex"),42,NOW,Some(42)).is_none());
    for helper in ["codex-code-mode-host","Codex Computer Use","Updater","node"] {
        assert!(match_process(helper,Path::new(helper),44,NOW,None).is_none());
    }
}

#[test]
fn existing_synthetic_rollouts_produce_valid_events_without_any_canary() {
    let mut adapter=CodexAdapter::new();let mut stream=RolloutStream::default();let mut events=Vec::new();
    for line in include_bytes!("../../fixtures/agent-inputs/codex/rollout/rollout-complete-turn.jsonl").split(|b|*b==b'\n').filter(|l|!l.is_empty()) {
        events.extend(decode(&mut adapter,&mut stream,line));
    }
    assert!(events.iter().any(|e|e.kind==EventKind::SessionStart));
    assert!(events.iter().any(|e|e.kind==EventKind::TurnEnd));
    assert_eq!(events.iter().filter(|e|e.kind==EventKind::UsageSample).count(),2);
    private_free(&serde_json::to_string(&events).unwrap());
}

#[test]
fn unknown_envelope_can_change_timestamp_shape_without_becoming_an_error() {
    let mut adapter = CodexAdapter::new(); let mut stream = RolloutStream::default();
    let bytes = serde_json::to_vec(&json!({"type":TEXT,"timestamp":{"new_format":TEXT},"payload":{"text":TEXT}})).unwrap();
    assert!(decode(&mut adapter,&mut stream,&bytes).is_empty());
    assert_eq!(adapter.diagnostics().unknown_envelopes,1);
    assert_eq!(adapter.diagnostics().malformed_records,0);
}

#[test]
fn process_comm_paths_and_windows_executables_match_without_argv() {
    assert!(match_process("/vendor/bin/codex",Path::new("/vendor/bin/codex"),42,NOW,None).is_some());
    assert!(match_process("codex.exe",Path::new("C:\\tools\\codex.exe"),43,NOW,None).is_some());
    assert!(match_process("codex --prompt private",Path::new("/vendor/bin/codex"),44,NOW,None).is_none());
}

#[test]
fn non_regular_rollout_files_are_rejected_before_reading() {
    let scratch = Scratch::new(); let path = scratch.file();
    fs::create_dir(&path).unwrap(); assert!(RolloutTailer::new(&path).is_err());
    #[cfg(unix)] {
        fs::remove_dir(&path).unwrap();
        use std::{ffi::CString,os::unix::ffi::OsStrExt};
        let name=CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: name is a live nul-terminated repository-local synthetic path.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(),0o600) },0);
        assert!(RolloutTailer::new(&path).is_err());
    }
}

#[test]
fn tail_poll_has_a_record_budget_and_resumes_without_losing_the_remainder() {
    let scratch = Scratch::new(); let path = scratch.file();
    let mut records=vec![meta(SID)]; for _ in 0..512 { records.push(event("task_started",NOW)); } append(&path,&records);
    let mut adapter=CodexAdapter::new();let mut tailer=RolloutTailer::new(&path).unwrap();
    let first=tailer.poll(&mut adapter,&ctx()).unwrap(); assert!(first.len()<=128);
    let mut count=first.len();for _ in 0..16 {count+=tailer.poll(&mut adapter,&ctx()).unwrap().len();}
    assert_eq!(count,513);
}

#[test]
fn checkpoint_from_a_different_install_is_rehashed_instead_of_forwarded() {
    let scratch=Scratch::new();let path=scratch.file();append(&path,&[meta(SID)]);
    let mut adapter=CodexAdapter::new();let mut tailer=RolloutTailer::new(&path).unwrap();
    let original=tailer.poll(&mut adapter,&ctx()).unwrap()[0].instance.clone();
    let mut resumed=RolloutTailer::resume(&path,tailer.checkpoint()).unwrap();append(&path,&[event("task_started",NOW)]);
    let other=AdapterContext {clock:Arc::new(FakeClock::new(NOW)),identities:IdentityHasher::new([83;32])};
    let events=resumed.poll(&mut adapter,&other).unwrap();checked(&events);
    assert!(events.iter().all(|e|e.instance!=original));
    assert_eq!(events.last().unwrap().instance,other.instance(collector::contracts::common::Tool::Codex,SID));
}

#[test]
fn collector_receives_needs_you_and_interrupted_without_completion_rewards() {
    use collector::{Collector,CollectorOutput};
    use collector::contracts::{common::NeedsYouReason,snapshot::AgentState,moment::MomentKind};
    for log_interrupt in [false,true] {
        let clock=Arc::new(FakeClock::new(NOW));let context=AdapterContext {clock:clock.clone(),identities:IdentityHasher::new([37;32])};
        let mut core=Collector::new(clock.clone(),1);let mut adapter=CodexAdapter::new();let mut stream=RolloutStream::default();
        for event in adapter.decode_record(&mut stream,&meta(SID),&context).unwrap() {core.ingest(event).unwrap();}
        clock.advance(2001);
        for event in adapter.map_hook(&hook("UserPromptSubmit"),&context).unwrap() {core.ingest(event).unwrap();}
        for event in adapter.map_hook(&hook("PermissionRequest"),&context).unwrap() {core.ingest(event).unwrap();}
        let snapshot=core.snapshot();assert_eq!(snapshot.agents[0].state,AgentState::NeedsYou);
        assert_eq!(snapshot.agents[0].reason,Some(NeedsYouReason::Permission));
        clock.advance(6000);
        let bytes=envelope("event_msg",json!({"type":"turn_aborted","reason":"interrupted"}),NOW);
        let interrupted=if log_interrupt {adapter.decode_record(&mut stream,&bytes,&context).unwrap()} else {adapter.map_hook(&hook("Interrupt"),&context).unwrap()};
        let mut output=Vec::new();for event in interrupted {output.extend(core.ingest(event).unwrap());}
        assert_eq!(core.snapshot().agents[0].state,AgentState::YourTurn);
        assert!(!output.iter().any(|o|matches!(o,CollectorOutput::Moment(m) if m.kind==MomentKind::TurnEnd)));
        let counters=core.ledger().days.values().next().unwrap().get(&collector::contracts::common::Tool::Codex).unwrap();
        assert_eq!(counters.turns,0);assert_eq!(counters.interrupted_turns,1);
        private_free(&serde_json::to_string(&core.snapshot()).unwrap());private_free(&serde_json::to_string(core.ledger()).unwrap());
    }
}

#[test]
fn missing_secondary_and_unknown_limit_type_do_not_invent_values() {
    let mut adapter=CodexAdapter::new();let mut stream=RolloutStream::default();decode(&mut adapter,&mut stream,&meta(SID));
    let events=decode(&mut adapter,&mut stream,&usage(window(33.0,300),Value::Null,NOW));
    assert_eq!(events.len(),1);assert!(stream.latest_usage(Window::Weekly).is_none());
    let raw=envelope("event_msg",json!({"type":"token_count","rate_limits":{"primary":null,"rate_limit_reached_type":TEXT}}),NOW);
    let events=decode(&mut adapter,&mut stream,&raw);assert_eq!(events.len(),1);
    let limit=events[0].limit.as_ref().unwrap();assert_eq!(limit.window,collector::contracts::common::LimitWindow::Unknown);assert_eq!(limit.resets_at,None);
    private_free(&serde_json::to_string(&events).unwrap());
}

#[test]
fn turn_and_request_ids_match_across_hook_log_and_answer_observations() {
    let mut adapter=CodexAdapter::new();let mut stream=RolloutStream::default();decode(&mut adapter,&mut stream,&meta(SID));
    let log=decode(&mut adapter,&mut stream,&event("task_complete",NOW));
    let body=|kind|serde_json::to_vec(&json!({"hook_event_name":kind,"session_id":SID,"turn_id":TEXT,"tool_use_id":USER})).unwrap();
    let stop=adapter.map_hook(&body("Stop"),&ctx()).unwrap();assert_eq!(log[0].turn_id,stop[0].turn_id);
    let permission=adapter.map_hook(&body("PermissionRequest"),&ctx()).unwrap();
    let answered=adapter.map_hook(&body("PostToolUse"),&ctx()).unwrap();
    assert!(permission[0].request_id.is_some());assert_eq!(permission[0].request_id,answered[0].request_id);
    assert_eq!(permission[0].account_id,log[0].account_id);
    private_free(&serde_json::to_string(&permission).unwrap());
}

#[test]
fn source_rfc3339_time_is_preserved_and_reset_seconds_are_converted() {
    let mut adapter=CodexAdapter::new();let mut stream=RolloutStream::default();
    let raw=serde_json::to_vec(&json!({"type":"session_meta","timestamp":"2026-10-12T12:00:00Z","payload":{"id":SID}})).unwrap();
    let events=decode(&mut adapter,&mut stream,&raw);assert_eq!(events[0].et,Some(NOW));
    let events=decode(&mut adapter,&mut stream,&usage(window(33.0,300),Value::Null,NOW));
    assert_eq!(events[0].usage.as_ref().unwrap().resets_at,1_791_810_000_000);
}

#[test]
fn synthetic_pipeline_outputs_are_artifacts_for_the_shared_privacy_scanner() {
    use collector::Collector;
    let clock=Arc::new(FakeClock::new(NOW));let context=AdapterContext {clock:clock.clone(),identities:IdentityHasher::new([37;32])};
    let mut core=Collector::new(clock.clone(),1);let mut adapter=CodexAdapter::new();let mut events=Vec::new();
    for fixture in [include_bytes!("../../fixtures/agent-inputs/codex/rollout/rollout-complete-turn.jsonl").as_slice(),
        include_bytes!("../../fixtures/agent-inputs/codex/rollout/rollout-aborted-turn.jsonl").as_slice()] {
        let mut stream=RolloutStream::default();
        for line in fixture.split(|b|*b==b'\n').filter(|l|!l.is_empty()) {events.extend(adapter.decode_record(&mut stream,line,&context).unwrap());}
    }
    for fixture in [include_bytes!("../../fixtures/agent-inputs/codex/hooks/user-prompt-submit.json").as_slice(),
        include_bytes!("../../fixtures/agent-inputs/codex/hooks/permission-request.json").as_slice(),
        include_bytes!("../../fixtures/agent-inputs/codex/hooks/interrupt.json").as_slice(),
        include_bytes!("../../fixtures/agent-inputs/codex/hooks/subagent-start.json").as_slice()] {
        events.extend(adapter.map_hook(fixture,&context).unwrap());
    }
    checked(&events);let mut outputs=Vec::new();
    for event in &events {clock.advance(6000);outputs.extend(core.ingest(event.clone()).unwrap());}
    let path=Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("target/wp05-evidence/privacy");fs::create_dir_all(&path).unwrap();
    let moments:Vec<_>=outputs.iter().filter_map(|o|if let collector::CollectorOutput::Moment(m)=o {Some(m)} else {None}).collect();
    for (name,bytes) in [("events.json",serde_json::to_string(&events).unwrap()),("snapshot.json",serde_json::to_string(&core.snapshot()).unwrap()),
        ("moments.json",serde_json::to_string(&moments).unwrap()),("ledger.json",serde_json::to_string(core.ledger()).unwrap()),
        ("diagnostics.json",serde_json::to_string(&adapter.diagnostics()).unwrap())] {private_free(&bytes);fs::write(path.join(name),bytes).unwrap();}
}

// 10 recent files of 300 records each need three 128-record reads apiece, more than the 16 file
// slots of one poll. Startup must still drain all of them inside rebuild, never as later live work.
#[test]
fn startup_rebuild_drains_recent_history_without_replaying_it_as_live_work() {
    const FILES: usize = 10;
    let scratch=Scratch::new();let root=scratch.0.join("sessions");fs::create_dir(&root).unwrap();
    for index in 0..FILES {
        let mut records=vec![meta(&format!("{SID}-{index}"))];
        for _ in 0..300 {records.push(event("task_started",NOW));}records.push(event("task_complete",NOW));
        append(&root.join(format!("rollout-existing-{index}.jsonl")),&records);
    }
    let clock=Arc::new(FakeClock::new(NOW));let context=AdapterContext {clock:clock.clone(),identities:IdentityHasher::new([37;32])};
    let mut adapter=CodexAdapter::watch(&root).unwrap();let rebuilt=adapter.rebuild(&context).unwrap();
    assert_eq!(rebuilt.iter().filter(|e|e.kind==EventKind::TurnEnd).count(),FILES,
        "bounded live polling must not strand history after rebuild");
    let mut core=collector::Collector::new(clock,1);core.rebuild(rebuilt).unwrap();
    for _ in 0..8 {for event in adapter.poll(&context).unwrap() {core.ingest(event).unwrap();}}
    assert!(core.ledger().days.values().flat_map(|d|d.values()).all(|c|c.turns==0 && c.sessions==0));
}

// WP-05 review leads (reviewer saw an older paste; each claim was checked against current code first).

fn meta_child(id: &str, parent: &str) -> Vec<u8> {
    envelope("session_meta", json!({"id":id,"parent_thread_id":parent,"source":"cli","creator_account_id":ACCOUNT}), NOW)
}

// Lead 1: a hook for a session the log already described must reuse that session's parent and
// session id, otherwise hook and log turn ids hash differently and the collector cannot dedupe.
#[test]
fn child_session_hook_shares_log_session_parent_and_turn_identity() {
    let mut adapter=CodexAdapter::new();let mut stream=RolloutStream::default();
    decode(&mut adapter,&mut stream,&meta_child("CHILD-SYNTHETIC","PARENT-SYNTHETIC"));
    let log=decode(&mut adapter,&mut stream,&event("task_complete",NOW));
    let body=serde_json::to_vec(&json!({"hook_event_name":"Stop","session_id":"CHILD-SYNTHETIC","turn_id":TEXT})).unwrap();
    let hooks=adapter.map_hook(&body,&ctx()).unwrap();checked(&hooks);
    assert!(log[0].parent.is_some());
    assert_eq!(hooks[0].instance,log[0].instance);
    assert_eq!(hooks[0].parent,log[0].parent);
    assert_eq!(hooks[0].session_id,log[0].session_id);
    assert_eq!(hooks[0].turn_id,log[0].turn_id);
}

fn tokens(total: u64, limits: bool, at: u64) -> Vec<u8> {
    let mut payload=json!({"type":"token_count","info":{"total_token_usage":{"total_tokens":total}}});
    if limits {payload["rate_limits"]=json!({"primary":window(10.0,300),"secondary":null,"rate_limit_reached_type":null});}
    envelope("event_msg",payload,at)
}

// Lead 4: tokens counted by records that emit no event must reach the next emitted delta.
#[test]
fn token_growth_on_records_without_rate_limits_is_not_dropped() {
    let mut adapter=CodexAdapter::new();let mut stream=RolloutStream::default();decode(&mut adapter,&mut stream,&meta(SID));
    assert!(decode(&mut adapter,&mut stream,&tokens(100,false,NOW)).is_empty());
    assert!(decode(&mut adapter,&mut stream,&tokens(300,false,NOW+1)).is_empty());
    let events=decode(&mut adapter,&mut stream,&tokens(500,true,NOW+2));
    assert_eq!(events[0].kind,EventKind::UsageSample);
    assert_eq!(events[0].tokens_delta,Some(400));
    let events=decode(&mut adapter,&mut stream,&tokens(550,true,NOW+3));
    assert_eq!(events[0].tokens_delta,Some(50));
}

// Lead 8: a blank CRLF line is blank, not a corrupted record.
#[test]
fn blank_crlf_lines_are_not_malformed_records() {
    let scratch=Scratch::new();let path=scratch.file();
    let mut bytes=Vec::new();
    for line in [meta(SID),Vec::new(),event("task_started",NOW),Vec::new()] {bytes.extend_from_slice(&line);bytes.extend_from_slice(b"\r\n");}
    fs::write(&path,bytes).unwrap();
    let mut adapter=CodexAdapter::new();let mut tailer=RolloutTailer::new(&path).unwrap();
    let events=tailer.poll(&mut adapter,&ctx()).unwrap();checked(&events);
    assert_eq!(events.len(),2);
    assert_eq!(adapter.diagnostics().malformed_records,0);
}

// Lead 6 check: the second symlink check in for_root looked redundant, but the first already
// walks every ancestor of the configured root, so a symlinked ancestor is rejected today.
#[cfg(unix)]
#[test]
fn for_root_rejects_a_symlinked_ancestor() {
    let scratch=Scratch::new();let real=scratch.0.join("real");fs::create_dir_all(real.join("sessions")).unwrap();
    std::os::unix::fs::symlink(&real,scratch.0.join("link")).unwrap();
    assert!(CodexAdapter::for_root(scratch.0.join("link/sessions")).is_err());
    assert!(CodexAdapter::for_root(real.join("sessions")).is_ok());
}

fn mark_old(path: &Path, age_ms: u64) {
    let at=std::time::UNIX_EPOCH+Duration::from_millis(NOW-age_ms);
    fs::OpenOptions::new().write(true).open(path).unwrap().set_modified(at).unwrap();
}

// Lead 3: files too old for the startup scan must not be tailed from byte 0 by the backstop rescan.
#[test]
fn backstop_rescan_does_not_replay_old_rollouts_from_byte_zero() {
    let scratch=Scratch::new();let root=scratch.0.join("sessions");let day=root.join("2026/09/01");fs::create_dir_all(&day).unwrap();
    let path=day.join("rollout-old.jsonl");append(&path,&[meta(SID),event("task_started",NOW),event("task_complete",NOW)]);
    mark_old(&path,3_600_000);
    std::thread::sleep(Duration::from_millis(300));
    let mut adapter=CodexAdapter::watch(&root).unwrap();
    assert!(adapter.rebuild(&ctx()).unwrap().is_empty(),"old file must be skipped at startup");
    let mut late=Vec::new();
    for _ in 0..3 {std::thread::sleep(Duration::from_millis(1100));late.extend(adapter.poll(&ctx()).unwrap());}
    assert!(late.is_empty(),"backstop rescan replayed an old rollout from byte 0");
}

// Lead 5: a deleted rollout must be forgotten, not retried and counted as an I/O error every rescan.
#[test]
fn deleted_rollout_is_pruned_instead_of_failing_every_rescan() {
    let scratch=Scratch::new();let root=scratch.0.join("sessions");fs::create_dir(&root).unwrap();
    let path=root.join("rollout-doomed.jsonl");append(&path,&[meta(SID)]);
    let mut adapter=CodexAdapter::watch(&root).unwrap();
    assert!(!adapter.rebuild(&ctx()).unwrap().is_empty());
    fs::remove_file(&path).unwrap();
    for _ in 0..2 {std::thread::sleep(Duration::from_millis(2100));adapter.poll(&ctx()).unwrap();}
    assert!(adapter.diagnostics().io_errors<=1,"deleted file kept failing: {} errors",adapter.diagnostics().io_errors);
}
