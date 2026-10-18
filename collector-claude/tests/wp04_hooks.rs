//! WP-04 acceptance 1 (hook goldens) and 4 (subagent hooks map to children).
mod common;
use common::*;

use collector_claude::hooks::{map_hook, IGNORED_EVENTS, MAPPED_EVENTS};
use serde_json::json;

/// fixture file name -> expected event summaries (empty = no event).
const GOLDEN: &[(&str, &[&str])] = &[
    ("session-start-startup", &["session_start/hook/exact"]),
    ("session-start-resume", &["session_start/hook/exact"]),
    ("session-end-clear", &["session_end/hook/exact;end=clear"]),
    ("session-end-logout", &["session_end/hook/exact;end=logout"]),
    ("session-end-prompt-input-exit", &["session_end/hook/exact;end=exit"]),
    ("session-end-other", &["session_end/hook/exact;end=other"]),
    ("user-prompt-submit", &["turn_start/hook/exact"]),
    ("pre-tool-use-bash", &["heartbeat/hook/exact;act=shell"]),
    ("pre-tool-use-edit", &["heartbeat/hook/exact;act=edit"]),
    ("pre-tool-use-ask-user-question", &["needs_answer/hook/exact"]),
    ("post-tool-use-bash", &["tool_end/hook/exact;act=shell"]),
    ("post-tool-use-edit", &["tool_end/hook/exact;act=edit"]),
    ("post-tool-use-webfetch", &["tool_end/hook/exact;act=web"]),
    ("post-tool-use-task", &["tool_end/hook/exact;act=delegate"]),
    ("post-tool-use-failure", &["tool_end/hook/exact;act=shell"]),
    ("post-tool-use-in-subagent", &["tool_end/hook/exact;act=read;child"]),
    ("permission-request-bash", &["needs_permission/hook/exact"]),
    ("permission-request-edit", &["needs_permission/hook/exact"]),
    ("permission-denied", &["answered/hook/exact"]),
    ("notification-permission-prompt", &["needs_permission/hook/exact;notif=permission_prompt"]),
    ("notification-elicitation-dialog", &["needs_answer/hook/exact;notif=elicitation_dialog"]),
    ("notification-elicitation-url-dialog", &["needs_answer/hook/exact;notif=elicitation_url_dialog"]),
    ("notification-agent-needs-input", &["needs_answer/hook/exact;notif=agent_needs_input"]),
    ("notification-elicitation-response", &["answered/hook/exact;notif=elicitation_response"]),
    ("notification-elicitation-complete", &["answered/hook/exact;notif=elicitation_complete"]),
    ("notification-idle-prompt", &["heartbeat/hook/exact;notif=idle_prompt"]),
    ("notification-quota-auto-resume-fired", &["heartbeat/hook/exact;notif=quota_auto_resume_fired"]),
    ("stop", &["turn_end/hook/exact;stop=end_turn"]),
    ("stop-failure-rate-limit", &["limit_hit/hook/exact"]),
    ("stop-failure-overloaded", &["error/hook/exact;err=overloaded"]),
    ("stop-failure-server-error", &["error/hook/exact;err=server_error"]),
    ("stop-failure-authentication-failed", &["error/hook/exact;err=auth"]),
    ("subagent-start", &["session_start/hook/exact;child"]),
    ("subagent-stop", &["session_end/hook/exact;end=exit;child"]),
    ("pre-compact", &[]),
    ("post-compact", &[]),
    ("task-created", &[]),
    ("task-completed", &[]),
];

fn map(rel: &str) -> Vec<busyholm_contracts::AgentEvent> {
    let body = read_fixture(rel);
    with_env(NOW, |env| map_hook(&body, env).unwrap_or_else(|e| panic!("{rel}: {e:?}")).events)
}

#[test]
fn golden_events_for_every_claude_hook_fixture() {
    // Every fixture file is in the table (no fixture is silently untested).
    let dir = fixture("claude/hooks");
    let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().trim_end_matches(".json").to_string())
        .collect();
    on_disk.sort();
    let mut in_table: Vec<String> = GOLDEN.iter().map(|(n, _)| n.to_string()).collect();
    in_table.sort();
    assert_eq!(on_disk, in_table, "fixture folder and golden table must list the same files");

    for (name, expected) in GOLDEN {
        let events = map(&format!("claude/hooks/{name}.json"));
        assert_valid(&events);
        assert_eq!(summs(&events), expected.to_vec(), "{name}");
    }
}

#[test]
fn thirteen_mapped_and_four_ignored_hook_names_cover_all_seventeen_fixtures() {
    assert_eq!(MAPPED_EVENTS.len(), 13);
    assert_eq!(IGNORED_EVENTS.len(), 4);
    let mut seen = std::collections::BTreeSet::new();
    for (name, _) in GOLDEN {
        let v: serde_json::Value = serde_json::from_slice(&read_fixture(&format!("claude/hooks/{name}.json"))).unwrap();
        seen.insert(v["hook_event_name"].as_str().unwrap().to_string());
    }
    let mut all: Vec<&str> = MAPPED_EVENTS.iter().chain(IGNORED_EVENTS.iter()).copied().collect();
    all.sort();
    assert_eq!(seen.into_iter().collect::<Vec<_>>(), all);
}

#[test]
fn rate_limit_stop_failure_is_a_limit_hit_with_unknown_window_and_no_reset() {
    let e = &map("claude/hooks/stop-failure-rate-limit.json")[0];
    let l = e.limit.as_ref().expect("limit payload");
    assert_eq!(serde_json::to_value(l).unwrap(), json!({"provider":"claude","window":"unknown","resets_at":null}));
}

#[test]
fn identity_fields_come_from_the_payload_as_salted_hashes() {
    let stop = &map("claude/hooks/stop.json")[0];
    assert_eq!(stop.instance, test_id("bca1a700-0000-4000-8000-000000000001"));
    assert_eq!(stop.session_id.as_deref(), Some(stop.instance.as_str()));
    assert_eq!(stop.turn_id, Some(scoped("turn", "bca1a700-0000-4000-8000-000000000026")));
    assert_eq!(stop.root_id, root_id());
    assert_eq!(stop.request_id, None);

    let ask = &map("claude/hooks/pre-tool-use-ask-user-question.json")[0];
    assert_eq!(ask.request_id, Some(scoped("req", "bca1a700-0000-4000-8000-00000000000e")));

    let post = &map("claude/hooks/post-tool-use-bash.json")[0];
    assert!(post.request_id.is_some(), "tool_end carries the request id of its tool call");

    let start = &map("claude/hooks/pre-tool-use-bash.json")[0];
    assert_eq!(start.request_id, None, "heartbeat may not carry a request id (contract)");
}

#[test]
fn subagent_hooks_map_to_children_of_the_main_session() {
    let main = test_id("bca1a700-0000-4000-8000-000000000001");
    let child = test_id("bca1a700-0000-4000-8000-000000000002");
    for name in ["post-tool-use-in-subagent", "subagent-start", "subagent-stop"] {
        let e = &map(&format!("claude/hooks/{name}.json"))[0];
        assert_eq!(e.instance, child, "{name}");
        assert_eq!(e.parent.as_deref(), Some(main.as_str()), "{name}");
        assert_eq!(e.session_id.as_deref(), Some(main.as_str()), "{name}");
    }
    // The main session's own hooks have no parent.
    assert_eq!(map("claude/hooks/stop.json")[0].parent, None);
}

#[test]
fn interrupt_failure_is_an_inferred_interruption() {
    let body = json!({
        "session_id": "s-1", "hook_event_name": "PostToolUseFailure",
        "tool_name": "Bash", "is_interrupt": true
    });
    let ev = with_env(NOW, |env| map_hook(body.to_string().as_bytes(), env).unwrap().events);
    assert_eq!(summs(&ev), vec!["turn_interrupted/hook/inferred;stop=interrupted"]);
}

#[test]
fn compact_restart_is_not_a_new_session() {
    let body = json!({"session_id":"s-1","hook_event_name":"SessionStart","source":"compact"});
    let ev = with_env(NOW, |env| map_hook(body.to_string().as_bytes(), env).unwrap().events);
    assert!(ev.is_empty());
}

#[test]
fn unknown_event_names_are_counted_not_errors() {
    let body = json!({"session_id":"s-1","hook_event_name":"BrandNewEvent2027"});
    let out = with_env(NOW, |env| map_hook(body.to_string().as_bytes(), env).unwrap());
    assert!(out.events.is_empty());
    assert!(out.unknown_event);
}

#[test]
fn bad_payloads_are_refused_with_closed_errors() {
    use collector_claude::MapError;
    with_env(NOW, |env| {
        assert_eq!(map_hook(b"not json", env).err(), Some(MapError::NotJson));
        assert_eq!(map_hook(b"[1]", env).err(), Some(MapError::NotObject));
        assert_eq!(map_hook(b"{\"hook_event_name\":\"Stop\"}", env).err(), Some(MapError::MissingField));
        let big = vec![b' '; 256 * 1024 + 1];
        assert_eq!(map_hook(&big, env).err(), Some(MapError::TooLarge));
    });
}

#[test]
fn tool_names_map_to_activity_by_name_only() {
    use busyholm_contracts::common::Activity::*;
    use collector_claude::hooks::activity_for_tool;
    for (n, a) in [
        ("Bash", Shell), ("BashOutput", Shell), ("Edit", Edit), ("Write", Edit), ("MultiEdit", Edit),
        ("NotebookEdit", Edit), ("Read", Read), ("Grep", Read), ("Glob", Read),
        ("WebFetch", Web), ("WebSearch", Web), ("Task", Delegate), ("Agent", Delegate),
        ("mcp__server__tool", Other), ("TodoWrite", Other), ("", Other),
    ] {
        assert_eq!(activity_for_tool(n), a, "{n}");
    }
}
