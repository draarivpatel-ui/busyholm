mod common;
use common::*;

use std::sync::Arc;

use collector::{Adapter, AdapterContext, FakeClock, IdentityHasher};
use collector_claude::{ClaudeAdapter, ClaudeConfig};
use collector_claude::fsx::Fsx;
use serde_json::{json, Value};

fn setup() -> (ClaudeAdapter, AdapterContext, Arc<FakeClock>) {
    let clock = Arc::new(FakeClock::new(NOW));
    let ctx = AdapterContext { clock: clock.clone(), identities: IdentityHasher::new([7; 32]) };
    let adapter = ClaudeAdapter::new(ClaudeConfig { root: "/nonexistent-fix-b-h4a".into() }, Fsx::real());
    (adapter, ctx, clock)
}

fn send(adapter: &mut ClaudeAdapter, ctx: &AdapterContext, name: &str, fields: Value) -> Vec<busyholm_contracts::AgentEvent> {
    let mut body = fields;
    body["hook_event_name"] = name.into();
    body["session_id"] = "synthetic-session".into();
    let events = adapter.map_hook(body.to_string().as_bytes(), ctx).unwrap();
    assert_valid(&events);
    events
}

fn answer_after_fifteen_seconds(adapter: &mut ClaudeAdapter, ctx: &AdapterContext, clock: &FakeClock) {
    assert_eq!(send(adapter, ctx, "PermissionRequest", json!({"tool_use_id":"request-a"})).len(), 1);
    clock.advance(15_000);
    assert_eq!(send(adapter, ctx, "PostToolUse", json!({"tool_use_id":"request-a","tool_name":"Bash"})).len(), 1);
}

#[test]
fn h4a_unkeyed_notification_after_a_slow_answer_does_not_reopen_the_request() {
    let (mut adapter, ctx, clock) = setup();
    answer_after_fifteen_seconds(&mut adapter, &ctx, &clock);
    clock.advance(100);
    assert!(send(&mut adapter, &ctx, "Notification", json!({"notification_type":"permission_prompt"})).is_empty());
    assert_eq!(adapter.core_mut().dedup_stats().late_notifications, 1);
}

#[test]
fn h4a_answer_grace_survives_wall_clock_jumps_in_both_directions() {
    for wall in [NOW - 60_000, NOW + 60_000] {
        let (mut adapter, ctx, clock) = setup();
        answer_after_fifteen_seconds(&mut adapter, &ctx, &clock);
        clock.advance(100);
        clock.set_wall(wall);
        assert!(send(&mut adapter, &ctx, "Notification", json!({"notification_type":"permission_prompt"})).is_empty());
        clock.advance(10_001);
        assert_eq!(send(&mut adapter, &ctx, "Notification", json!({"notification_type":"permission_prompt"})).len(), 1, "a later unkeyed request is still observable");
    }
}

#[test]
fn h4a_answered_keyed_requests_stay_suppressed_after_a_newer_request() {
    let (mut adapter, ctx, clock) = setup();
    answer_after_fifteen_seconds(&mut adapter, &ctx, &clock);
    clock.advance(20_000);
    assert_eq!(send(&mut adapter, &ctx, "PermissionRequest", json!({"tool_use_id":"request-b"})).len(), 1);
    assert!(send(&mut adapter, &ctx, "PermissionRequest", json!({"tool_use_id":"request-a"})).is_empty(), "an old keyed copy must not replace the newer pending request");
    assert!(send(&mut adapter, &ctx, "Notification", json!({"notification_type":"permission_prompt","tool_use_id":"request-a"})).is_empty());
}
