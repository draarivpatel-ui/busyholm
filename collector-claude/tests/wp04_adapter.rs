//! The `collector::Adapter` boundary, driven the way the collector drives it.
mod common;
use common::*;

use std::sync::Arc;

use busyholm_contracts::common::Tool;
use collector::{Adapter, AdapterContext, AdapterError, FakeClock, IdentityHasher};
use collector_claude::adapter::{ClaudeAdapter, ClaudeConfig};
use collector_claude::fsx::Fsx;

fn ctx() -> AdapterContext {
    AdapterContext { clock: Arc::new(FakeClock::new(NOW)), identities: IdentityHasher::new([7u8; 32]) }
}

fn adapter() -> ClaudeAdapter {
    // A root that does not exist: every scan finds nothing.
    ClaudeAdapter::new(ClaudeConfig { root: "/nonexistent-busyholm-test-root".into() }, Fsx::real())
}

#[test]
fn it_is_a_claude_adapter_behind_the_trait_object() {
    let a: Box<dyn Adapter> = Box::new(adapter());
    assert_eq!(a.tool(), Tool::Claude);
}

#[test]
fn map_hook_uses_the_collectors_clock_and_identity_hash() {
    let mut a = adapter();
    let c = ctx();
    let ev = a.map_hook(&read_fixture("claude/hooks/stop.json"), &c).unwrap();
    assert_eq!(ev.len(), 1);
    assert_valid(&ev);
    assert_eq!(ev[0].t, NOW);
    assert_eq!(ev[0].instance, c.instance(Tool::Claude, "bca1a700-0000-4000-8000-000000000001"));
    assert_eq!(ev[0].instance.len(), 32);
    let json = serde_json::to_string(&ev).unwrap().to_lowercase();
    assert!(!json.contains("bhcanary") && !json.contains("bca1a700"));
}

#[test]
fn map_hook_routes_status_line_bodies_and_refuses_junk_with_a_closed_error() {
    let mut a = adapter();
    let c = ctx();
    let ev = a.map_hook(&read_fixture("claude/statusline/statusline-both-windows.json"), &c).unwrap();
    assert_eq!(ev.len(), 2);
    assert_eq!(a.map_hook(b"not json", &c).err(), Some(AdapterError::InvalidPayload));
    assert_eq!(a.map_hook(b"{}", &c).err(), Some(AdapterError::InvalidPayload));
}

#[test]
fn rebuild_and_poll_on_an_empty_root_return_nothing() {
    let mut a = adapter();
    let c = ctx();
    assert!(a.rebuild(&c).unwrap().is_empty());
    assert!(a.poll(&c).unwrap().is_empty());
}
