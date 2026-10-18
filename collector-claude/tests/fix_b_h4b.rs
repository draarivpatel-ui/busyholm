mod common;
use common::*;

use busyholm_contracts::agent_event::{EventKind, EventSource};
use collector_claude::dedup::Dedup;
use collector_claude::hooks::map_hook;
use serde_json::{json, Value};

fn hook(name: &str, fields: Value, t: u64) -> busyholm_contracts::AgentEvent {
    let mut body = fields;
    body["hook_event_name"] = name.into();
    body["session_id"] = "synthetic-session".into();
    with_env(t, |env| map_hook(body.to_string().as_bytes(), env).unwrap().events.remove(0))
}

#[test]
fn h4b_a_previous_unkeyed_end_cannot_suppress_the_next_turns_log_end() {
    for hook_first in [true, false] {
        let mut d = Dedup::new();
        let mut old_end = hook("Stop", json!({}), NOW);
        if !hook_first { old_end.source = EventSource::Log; }
        assert!(d.admit(&old_end));
        assert!(d.admit(&hook("UserPromptSubmit", json!({"prompt_id":"turn-2"}), NOW + 500)));
        let mut new_end = hook("Stop", json!({"prompt_id":"turn-2"}), NOW + 1_000);
        if hook_first { new_end.source = EventSource::Log; }
        assert!(d.admit(&new_end), "the terminal window belongs to the earlier turn (hook_first={hook_first})");
        assert!(!d.has_open_turn(&new_end.instance));
        let mut copy = new_end.clone();
        copy.source = old_end.source;
        assert!(!d.admit(&copy), "keyed duplicate protection remains intact");
    }
}

#[test]
fn h4b_the_previous_turns_error_or_limit_cannot_suppress_a_new_failure() {
    for label in ["server_error", "rate_limit"] {
            let mut d = Dedup::new();
            let old = hook("StopFailure", json!({"error":label}), NOW);
            assert!(matches!(old.kind, EventKind::Error | EventKind::LimitHit));
            assert!(d.admit(&old));
            assert!(d.admit(&hook("UserPromptSubmit", json!({"prompt_id":"turn-2"}), NOW + 500)));
            let mut new_failure = hook("StopFailure", json!({"error":label}), NOW + 1_000);
            new_failure.source = EventSource::Log;
            assert!(d.admit(&new_failure), "a retry that still fails is a new terminal observation");
            let mut copy = new_failure;
            copy.source = EventSource::Hook;
            assert!(!d.admit(&copy), "copies in the same turn are suppressed");
    }
}

#[test]
fn h4b_keyed_duplicates_remain_suppressed_across_turn_generations() {
    let mut d = Dedup::new();
    let end = hook("Stop", json!({"prompt_id":"turn-1"}), NOW);
    assert!(d.admit(&end));
    d.admit(&hook("UserPromptSubmit", json!({"prompt_id":"turn-2"}), NOW + 500));
    let mut copy = end;
    copy.source = EventSource::Log;
    copy.t += 1_000;
    assert!(!d.admit(&copy));
    assert!(d.has_open_turn(&copy.instance), "a late duplicate must not close the current turn");
}
