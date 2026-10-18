mod common;
use common::*;

use std::sync::Arc;

use busyholm_contracts::agent_event::EventKind;
use busyholm_contracts::snapshot::AgentState;
use collector::{Adapter, AdapterContext, Collector, FakeClock, IdentityHasher};
use collector_claude::{ClaudeAdapter, ClaudeConfig};
use collector_claude::dedup::Dedup;
use collector_claude::fsx::Fsx;
use collector_claude::hooks::map_hook;
use collector_claude::transcript::{FileRole, TranscriptReader};
use serde_json::{json, Value};

fn result(ids: &[Option<&str>]) -> Value {
    let blocks: Vec<_> = ids.iter().map(|id| json!({"type":"tool_result","tool_use_id":id,"content":"BHCANARY_result_private_text"})).collect();
    json!({"type":"user","sessionId":"synthetic-session","message":{"content":blocks}})
}

#[test]
fn h4c_transcript_results_preserve_each_salted_tool_use_id() {
    let mut reader = TranscriptReader::new();
    let events = with_env(NOW, |env| reader.on_line(result(&[Some("tool-b"), Some("question-a")]).to_string().as_bytes(), &FileRole::Main, env));
    assert_valid(&events);
    assert_eq!(events.len(), 2, "each result needs its own correlation identity");
    assert_eq!(events[0].request_id, Some(scoped("req", "tool-b")));
    assert_eq!(events[1].request_id, Some(scoped("req", "question-a")));
    assert!(!serde_json::to_string(&events).unwrap().contains("BHCANARY"));
}

#[test]
fn h4c_uncorrelated_transcript_results_are_only_activity_evidence() {
    let too_long = "x".repeat(257);
    for id in [None, Some(""), Some(too_long.as_str())] {
        let mut reader = TranscriptReader::new();
        let events = with_env(NOW, |env| reader.on_line(result(&[id]).to_string().as_bytes(), &FileRole::Main, env));
        assert_valid(&events);
        assert!(events.iter().all(|e| e.kind == EventKind::Heartbeat && e.request_id.is_none()));
    }
}

#[test]
fn h4c_dedup_does_not_treat_an_idless_tool_end_as_answering_a_keyed_question() {
    let mut d = Dedup::new();
    let hook = |name: &str, fields: Value| with_env(NOW, |env| {
        let mut body = fields;
        body["hook_event_name"] = name.into();
        body["session_id"] = "synthetic-session".into();
        map_hook(body.to_string().as_bytes(), env).unwrap().events.remove(0)
    });
    assert!(d.admit(&hook("PreToolUse", json!({"tool_name":"AskUserQuestion","tool_use_id":"question-a"}))));
    assert!(!d.admit(&hook("PostToolUse", json!({"tool_name":"Read"}))), "an uncorrelated completion must not reach the collector as an answer");
    assert!(!d.admit(&hook("Notification", json!({"notification_type":"agent_needs_input"}))));
    assert_eq!(d.stats.request_dupes, 1, "the question is still pending");
}

#[test]
fn h4c_parallel_and_idless_results_do_not_clear_the_collectors_question_after_hook_authority_expires() {
    let scratch = Scratch::new("fix-b-h4c");
    let transcript = scratch.join("projects/synthetic/synthetic-session.jsonl");
    std::fs::write(&transcript, b"").unwrap();
    let clock = Arc::new(FakeClock::new(NOW));
    let ctx = AdapterContext { clock: clock.clone(), identities: IdentityHasher::new([7; 32]) };
    let mut adapter = ClaudeAdapter::new(ClaudeConfig { root: scratch.path().into() }, Fsx::real());
    let mut collector = Collector::new(clock.clone(), 17);
    assert!(adapter.poll(&ctx).unwrap().is_empty());
    for body in [
        json!({"hook_event_name":"UserPromptSubmit","session_id":"synthetic-session","prompt_id":"turn-a"}),
        json!({"hook_event_name":"PreToolUse","session_id":"synthetic-session","tool_name":"AskUserQuestion","tool_use_id":"question-a"}),
    ] {
        for event in adapter.map_hook(body.to_string().as_bytes(), &ctx).unwrap() { collector.ingest(event).unwrap(); }
    }
    clock.advance(6_001);
    std::fs::write(&transcript, format!("{}\n", result(&[Some("tool-b"), None]))).unwrap();
    for event in adapter.poll(&ctx).unwrap() { collector.ingest(event).unwrap(); }
    let waiting = collector.snapshot().agents.remove(0);
    assert_eq!(waiting.state, AgentState::NeedsYou);
    assert_eq!(waiting.request_id, Some(ctx.instance(busyholm_contracts::common::Tool::Claude, "req:question-a")));

    use std::io::Write;
    writeln!(std::fs::OpenOptions::new().append(true).open(&transcript).unwrap(), "{}", result(&[Some("question-a")])).unwrap();
    clock.advance(1);
    let events = adapter.poll(&ctx).unwrap();
    assert!(events.iter().any(|e| e.kind == EventKind::ToolEnd));
    for event in events { collector.ingest(event).unwrap(); }
    let answered = collector.snapshot().agents.remove(0);
    assert_eq!(answered.state, AgentState::Working);
    assert!(answered.request_id.is_none());
}
