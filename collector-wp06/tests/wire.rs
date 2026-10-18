mod common;
use busyholm_contracts::{agent_event::{EventKind, EventSource, ErrorClass, StopReason}, common::{Activity, Confidence, Host, Tool}};
use collector::AdapterError;
use collector_wp06::{map_wire, sha256_hex};
use common::*;
use serde_json::json;

const NOW: u64 = 1_791_806_400_000;
const ROOT: &str = "/Users/u/.local/share/opencode";
fn sid(n: u8) -> String { sha256_hex(&format!("session-{n}")) }
fn body(v: serde_json::Value) -> Vec<u8> { serde_json::to_vec(&v).unwrap() }
fn map(v: serde_json::Value) -> Result<Vec<busyholm_contracts::AgentEvent>, AdapterError> { map_wire(&body(v), &FakeIds, NOW, ROOT) }
fn one(v: serde_json::Value) -> busyholm_contracts::AgentEvent {
    let mut evs = map(v).expect("maps");
    check_events(&evs);
    assert_eq!(evs.len(), 1);
    evs.remove(0)
}
fn base(t: &str) -> serde_json::Value { json!({"v":1,"agent":"opencode","type":t,"sid":sid(1),"et":NOW - 5}) }

#[test]
fn lifecycle_events_map_to_the_contract_kinds() {
    let e = one(base("session.created"));
    assert_eq!((e.kind, e.source, e.confidence, e.host, e.agent), (EventKind::SessionStart, EventSource::Plugin, Confidence::Exact, Host::Cli, Tool::Opencode));
    assert_eq!(e.instance, FakeIds_instance(&sid(1)));
    assert_eq!(e.parent, None);
    assert_eq!(e.session_id, Some(e.instance.clone()), "a top-level session is its own session");
    assert_eq!(e.root_id, FakeIds_instance(&format!("root:{ROOT}")));
    assert_eq!((e.account_id, e.turn_id, e.request_id), (None, None, None));
    assert_eq!((e.t, e.et), (NOW, Some(NOW - 5)));

    assert_eq!(one(base("session.busy")).kind, EventKind::TurnStart);
    let idle = one(base("session.idle"));
    assert_eq!(idle.kind, EventKind::TurnEnd);
    assert_eq!(idle.detail.unwrap().stop_reason, Some(StopReason::EndTurn));
    let del = one(base("session.deleted"));
    assert_eq!(del.kind, EventKind::SessionEnd);
}

#[allow(non_snake_case)]
fn FakeIds_instance(raw: &str) -> String { collector_wp06::Identity::instance(&FakeIds, Tool::Opencode, raw) }

#[test]
fn subagent_parent_link_is_hashed_the_same_way() {
    let mut v = base("session.created");
    v["psid"] = json!(sid(2));
    let e = one(v);
    assert_eq!(e.parent, Some(FakeIds_instance(&sid(2))));
    assert_ne!(e.parent.as_deref(), Some(e.instance.as_str()));
}

#[test]
fn subagent_events_after_the_first_keep_the_parent_link_and_the_parent_session() {
    let mut v = base("session.busy");
    v["psid"] = json!(sid(2));
    let e = one(v);
    assert_eq!(e.parent, Some(FakeIds_instance(&sid(2))));
    assert_eq!(e.session_id, Some(FakeIds_instance(&sid(2))), "a subagent carries its parent session's session_id");
}

#[test]
fn permission_and_question_events_drive_needs_you_and_answered() {
    let mut a = base("permission.asked"); a["rid"] = json!(sid(9));
    let ask = one(a);
    assert_eq!(ask.kind, EventKind::NeedsPermission);
    assert_eq!(ask.request_id, Some(FakeIds_instance(&sid(9))), "alerts are keyed by request");
    let mut r = base("permission.replied"); r["rid"] = json!(sid(9));
    let rep = one(r);
    assert_eq!(rep.kind, EventKind::Answered);
    assert_eq!(rep.request_id, ask.request_id, "the answer closes the same request");
    assert_eq!(one(base("permission.asked")).request_id, None, "no request id on the wire means none on the event");
    assert_eq!(one(base("question.asked")).kind, EventKind::NeedsAnswer);
    assert_eq!(one(base("question.replied")).kind, EventKind::Answered);
}

#[test]
fn errors_become_classes_and_an_abort_is_an_interrupt_not_an_error() {
    for (wire, class) in [("unknown", ErrorClass::Unknown), ("auth", ErrorClass::Auth), ("server_error", ErrorClass::ServerError),
                          ("max_output_tokens", ErrorClass::MaxOutputTokens), ("network", ErrorClass::Network)] {
        let mut v = base("session.error"); v["error"] = json!(wire);
        let e = one(v);
        assert_eq!(e.kind, EventKind::Error);
        assert_eq!(e.detail.unwrap().error_class, Some(class), "{wire}");
    }
    let mut v = base("session.error"); v["error"] = json!("aborted");
    let e = one(v);
    assert_eq!(e.kind, EventKind::TurnInterrupted);
    assert_eq!(e.detail.unwrap().stop_reason, Some(StopReason::Interrupted));
    assert!(map(base("session.error")).is_err(), "an error event without a class is refused");
}

#[test]
fn tool_and_token_events() {
    let mut t = base("tool.after"); t["activity"] = json!("shell");
    let e = one(t);
    assert_eq!(e.kind, EventKind::ToolEnd);
    assert_eq!(e.detail.unwrap().activity, Some(Activity::Shell));
    let mut k = base("tokens"); k["tok"] = json!(1590);
    let e = one(k);
    assert_eq!(e.kind, EventKind::Heartbeat);
    assert_eq!(e.tokens_delta, Some(1590));
    assert!(e.detail.is_none());
    let mut huge = base("tokens"); huge["tok"] = json!(2_000_000_000u64);
    assert!(map(huge).is_err(), "above the contract ceiling is refused, not clamped silently");
}

#[test]
fn strict_allowlist_unknown_keys_raw_ids_and_bad_shapes_are_refused() {
    let cases: Vec<(&str, serde_json::Value)> = vec![
        ("extra key", { let mut v = base("session.idle"); v["title"] = json!("BHCANARY_opencode_title_1"); v }),
        ("extra key path", { let mut v = base("session.idle"); v["cwd"] = json!("/Users/x/BHCANARY_cwd"); v }),
        ("raw uuid sid", { let mut v = base("session.idle"); v["sid"] = json!("bca1a700-0000-4000-8000-00000000007f"); v }),
        ("uppercase hex sid", { let mut v = base("session.idle"); v["sid"] = json!(sid(1).to_uppercase()); v }),
        ("short sid", { let mut v = base("session.idle"); v["sid"] = json!("abcd"); v }),
        ("missing sid", json!({"v":1,"agent":"opencode","type":"session.idle"})),
        ("wrong v", { let mut v = base("session.idle"); v["v"] = json!(2); v }),
        ("wrong agent", { let mut v = base("session.idle"); v["agent"] = json!("claude"); v }),
        ("unknown type", base("message.part.updated")),
        ("activity on wrong type", { let mut v = base("session.idle"); v["activity"] = json!("shell"); v }),
        ("activity not an enum", { let mut v = base("tool.after"); v["activity"] = json!("BHCANARY_tool"); v }),
        ("et in seconds", { let mut v = base("session.idle"); v["et"] = json!(1_791_806_400u64); v }),
        ("et float", { let mut v = base("session.idle"); v["et"] = json!(1791806400000.5); v }),
        ("tok negative", { let mut v = base("tokens"); v["tok"] = json!(-1); v }),
        ("rid on a session event", { let mut v = base("session.idle"); v["rid"] = json!(sid(2)); v }),
    ];
    for (name, v) in cases {
        assert_eq!(map(v), Err(AdapterError::InvalidPayload), "{name}");
    }
    assert_eq!(map_wire(b"not json BHCANARY", &FakeIds, NOW, ROOT), Err(AdapterError::InvalidPayload));
    assert_eq!(map_wire(b"[]", &FakeIds, NOW, ROOT), Err(AdapterError::InvalidPayload));
    assert_eq!(map_wire(&vec![b'x'; 5000], &FakeIds, NOW, ROOT), Err(AdapterError::InvalidPayload), "bodies over 4 KiB are refused");
    assert_eq!(map_wire(b"", &FakeIds, NOW, ROOT), Err(AdapterError::InvalidPayload));
}

#[test]
fn the_error_value_never_carries_the_payload() {
    // AdapterError is a closed enum, so there is nowhere for text to go; this pins the Debug form.
    let err = map_wire(b"{\"BHCANARY\": 1}", &FakeIds, NOW, ROOT).unwrap_err();
    assert!(!format!("{err:?}").to_lowercase().contains("bhcanary"));
}
