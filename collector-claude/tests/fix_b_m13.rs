mod common;
use common::*;

use busyholm_contracts::common::{Host, InstanceId};
use collector_claude::hooks::map_hook;
use collector_claude::transcript::{FileRole, TranscriptReader};
use collector_claude::Env;
use serde_json::json;

#[test]
fn m13_child_transcript_limit_and_hook_observations_share_the_parents_account() {
    let account = scoped("account", "synthetic-account");
    let account_of = |instance: &InstanceId| (instance == &test_id("parent-session")).then(|| account.clone());
    let root = root_id();
    let env = Env { now_ms: NOW, id: &test_id, host_of: &no_host, account_of: &account_of, root_id: &root };
    let mut reader = TranscriptReader::new();
    let events = reader.on_line(json!({
        "type":"assistant","sessionId":"parent-session","isApiErrorMessage":true,
        "quotaLimits":{"status":"rejected","rateLimitType":"five_hour","resetsAt":1791817200},
        "message":{"content":"BHCANARY_private_child_reply"}
    }).to_string().as_bytes(), &FileRole::Subagent { agent_id:"child-agent".into() }, &env);
    let hooks = map_hook(json!({"hook_event_name":"StopFailure","session_id":"parent-session","agent_id":"child-agent","error":"rate_limit"}).to_string().as_bytes(), &env).unwrap().events;
    assert_valid(&events);
    assert_valid(&hooks);
    assert_eq!(events.len(), 2, "child announcement and limit hit");
    for event in &events {
        assert_eq!(event.account_id, Some(account.clone()));
        assert_eq!(event.account_id, hooks[0].account_id);
        assert_eq!(event.parent, Some(test_id("parent-session")));
        assert_eq!(event.session_id, event.parent);
    }
    assert!(!serde_json::to_string(&events).unwrap().contains("BHCANARY"));
}

#[test]
fn m13_every_child_transcript_event_uses_the_known_parent_account() {
    let parent = test_id("parent-session");
    let account = scoped("account", "parent-account");
    let account_of = |instance: &InstanceId| {
        if instance == &parent { Some(account.clone()) }
        else if instance == &test_id("child-agent") { Some(scoped("account", "stale-child-account")) }
        else { None }
    };
    let host_of = |instance: &InstanceId| (instance == &parent).then_some(Host::Desktop);
    let root = root_id();
    let env = Env { now_ms: NOW, id:&test_id, host_of:&host_of, account_of:&account_of, root_id:&root };
    let mut reader = TranscriptReader::new();
    let role = FileRole::Subagent { agent_id:"child-agent".into() };
    let mut events = Vec::new();
    for record in [
        json!({"type":"user","sessionId":"parent-session","origin":{"kind":"human"},"promptId":"turn-1"}),
        json!({"type":"assistant","sessionId":"parent-session","message":{"content":[{"type":"tool_use","name":"Read"}]}}),
        json!({"type":"user","sessionId":"parent-session","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1"}]}}),
        json!({"type":"assistant","sessionId":"parent-session","message":{"stop_reason":"end_turn"}}),
    ] {
        events.extend(reader.on_line(record.to_string().as_bytes(), &role, &env));
    }
    assert_valid(&events);
    assert_eq!(events.len(), 5);
    assert!(events.iter().all(|e| e.account_id.as_ref() == Some(&account) && e.host == Host::Desktop));
}

#[test]
fn m13_an_unknown_parent_account_remains_unknown() {
    let mut reader = TranscriptReader::new();
    let events = with_env(NOW, |env| reader.on_line(
        json!({"type":"user","sessionId":"parent-session","origin":{"kind":"human"},"promptId":"turn-1"}).to_string().as_bytes(),
        &FileRole::Subagent { agent_id:"child-agent".into() }, env));
    assert_eq!(events.len(), 2);
    assert!(events.iter().all(|e| e.account_id.is_none()));
}
