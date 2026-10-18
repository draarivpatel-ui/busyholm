//! Structural serde tests: shape only, no semantic validation.

use busyholm_contracts::choices::ChoiceEntry;
use busyholm_contracts::PendingAlerts;
use busyholm_contracts::common::{LimitWindow, Window};
use busyholm_contracts::settings::StripDisplay;
use busyholm_contracts::{
    AgentEvent, Choices, HitRects, InstallManifest, Ledger, Moment, Settings, Snapshot, World,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

const A: &str = "0123456789abcdef0123456789abcdef";
const B: &str = "fedcba9876543210fedcba9876543210";
const R: &str = "00112233445566778899aabbccddeeff";
const SHA: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// Numeric-tolerant equality (an integer-valued f64 serializes as `3.0`, not `3`).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

fn roundtrip<T: DeserializeOwned + Serialize>(v: Value) -> T {
    let t: T = serde_json::from_value(v.clone()).expect("deserialize");
    let back = serde_json::to_value(&t).expect("serialize");
    assert!(same(&v, &back), "round trip differs:\n in: {v}\nout: {back}");
    t
}

fn rejects<T: DeserializeOwned>(v: Value) -> String {
    serde_json::from_value::<T>(v).err().expect("expected an error").to_string()
}

fn event() -> Value {
    json!({
        "v": 1, "agent": "claude", "instance": A, "parent": null, "root_id": R,
        "account_id": B, "session_id": A, "turn_id": null, "request_id": null, "host": "cli",
        "kind": "usage_sample", "source": "poll", "confidence": "exact",
        "t": 1760270400000u64, "et": 1760270399000u64,
        "detail": { "notification": "idle_prompt" },
        "usage": { "provider": "claude", "window": "5h", "used_pct": 42.5,
                   "resets_at": 1760288400000u64, "observed_at": 1760270400000u64 },
        "tokens_delta": 1200
    })
}

fn snapshot() -> Value {
    json!({
        "schema_version": 2, "t": 1760270400000u64, "demo": false,
        "agents": [
            { "id": A, "tool": "claude", "host": "cli", "ordinal": 1, "parent": null,
              "root_id": R, "account_id": B, "session_id": A, "turn_id": B, "request_id": R,
              "state": "needs_you", "reason": "permission", "confidence": "exact",
              "since": 1760270300000u64, "started_at": 1760260000000u64, "project_label": "busyholm" },
            { "id": B, "tool": "codex", "host": "desktop", "ordinal": 999, "parent": A,
              "root_id": R, "account_id": null, "session_id": null, "turn_id": null, "request_id": null,
              "state": "limited", "confidence": "inferred",
              "since": 1760270000000u64, "started_at": 1760260000000u64,
              "limited_until": 1760288400000u64 }
        ],
        "tools": [ { "tool": "claude", "root_id": R, "presence": "present", "hooks": "installed",
                     "coverage": "verified", "coverage_reason": null },
                   { "tool": "codex", "root_id": R, "presence": "offline", "hooks": "pending_review",
                     "coverage": "degraded", "coverage_reason": "hooks_pending_review" } ],
        "limits": [ { "provider": "claude", "window": "weekly", "account_id": B, "root_id": R, "used_pct": 12.25,
                      "resets_at": 1760700000000u64, "observed_at": 1760270400000u64, "stale": true } ],
        "attention": { "needs_you": 1, "oldest_since": 1760270300000u64 }
    })
}

fn ledger() -> Value {
    let counts = json!({ "turns": 12, "interrupted_turns": 1, "sessions": 3, "working_seconds": 5400,
        "needs_you": 4, "errors": 0, "recovered": 0, "limit_hits": 1, "subagent_turns": 5 });
    json!({
        "schema_version": 1, "privacy": { "containsText": false }, "seed": 4294967295u64,
        "founded_day": "2026-09-01", "hooks_first_connected_day": "2026-09-02",
        "days": { "2026-09-01": { "claude": counts.clone(), "codex": counts.clone() },
                  "2026-09-02": { "claude": counts.clone() } },
        "backfill": { "imported_at": 1760270400000u64, "days": { "2026-08-30": { "gemini": counts } } }
    })
}

fn choices() -> Value {
    json!({
        "schema_version": 1, "privacy": { "containsText": false },
        "log": [
            { "kind": "build_order", "t": 1760270400000u64, "day": "2026-09-02",
              "order": ["well", "workshop_1", "market_hall"] },
            { "kind": "decoration", "t": 1760270500000u64, "day": "2026-09-02",
              "decoration": "lantern_01", "on": true }
        ]
    })
}

fn pending_alerts() -> Value {
    json!({
        "schema_version": 1, "privacy": { "containsText": false }, "saved_at": 1760270400000u64,
        "alerts": [ { "agent": A, "tool": "claude", "host": "cli", "root_id": R, "account_id": B,
                      "session_id": A, "request_id": null, "reason": "permission",
                      "since": 1760270300000u64, "last_confirmed_at": 1760270350000u64 } ]
    })
}

fn world() -> Value {
    json!({
        "schema_version": 1, "seed": 305419896, "as_of_day": "2026-10-12", "tier": "hamlet",
        "resources": { "planks": 10.5, "stone": 3.25, "seeds": 0.5 },
        "earned": { "planks": 120.5, "stone": 40.25, "seeds": 7.5 },
        "structures": [
            { "id": "campfire", "status": "complete", "stage": 3, "progress": 1.0, "completed_day": "2026-09-01" },
            { "id": "workshop_1", "variant": "claude", "status": "building", "stage": 1, "progress": 0.4 },
            { "id": "crossing", "variant": "footbridge", "status": "planned", "stage": 0, "progress": 0.0 },
            { "id": "bell_tower", "status": "waiting", "stage": 0, "progress": 0.75,
              "waiting_for": { "active_days": 30 } }
        ],
        "decorations": [ { "id": "lantern_01", "slot": 17, "shown": true } ],
        "milestones": [ { "id": "turns_100", "day": "2026-10-01" } ],
        "stats": { "lifetime_turns": 340, "active_days": 25,
                   "streak_days": 6, "tools_seen": ["claude", "codex"] },
        "founders_stone": { "days": 31, "turns": 900, "sessions": 80, "working_hours": 123.5 },
        "demo_capped": false
    })
}

fn hit_rects() -> Value {
    json!({
        "schema_version": 1, "t": 1760270400000u64, "surface": "strip",
        "viewport": { "w": 1440.0, "h": 112.0 }, "scale": 2.0,
        "rects": [ { "x": 10.5, "y": 20.0, "w": 48.0, "h": 48.0, "kind": "resident", "agent": A },
                   { "x": 100.0, "y": 0.0, "w": 24.5, "h": 112.0 } ]
    })
}

fn settings() -> Value {
    json!({
        "schema_version": 1,
        "strip": { "enabled": true, "display": { "mode": "named", "name": "Studio Display" },
                   "height": 112, "layer_mode": "reserve_space", "hover_fade": true,
                   "show_over_fullscreen": false },
        "sky": { "mode": "usage_and_clock", "hemisphere": "south" },
        "sound": { "bell": true, "volume": 0.5, "quiet_hours": { "start": "22:00", "end": "07:30" } },
        "notifications": { "needs_you": true, "renotify": true, "long_turn": true, "errors": false },
        "ambient": { "idle_minutes": 15, "shortcut": "CommandOrControl+Shift+B" },
        "agents": { "species": { "claude": "beaver", "codex": "otter" } },
        "privacy": { "project_names": false, "history_backfill": false },
        "other": { "launch_at_login": false, "reduced_motion": "follow_os" },
        "updates": { "check": false }
    })
}

fn manifest() -> Value {
    json!({
        "schema_version": 1, "app_version": "0.1.0-beta.1",
        "owner_tag": "k3j9x0a7b2c4d6e8",
        "entries": [
            { "id": "claude-hooks", "tool": "claude", "target": "claude_hooks",
              "path": "/Users/example/.claude/settings.json", "action": "edit_span", "state": "installed",
              "installed_at": 1760270400000u64,
              "before": { "existed": true, "sha256": SHA, "bytes": 1024 },
              "after": { "sha256": SHA, "bytes": 2048 },
              "owned": [ { "event": "Stop", "pointer": "/hooks/Stop/0", "sha256": SHA, "replaced_sha256": null },
                         { "event": null, "pointer": "/statusLine", "sha256": SHA, "replaced_sha256": SHA } ] },
            { "id": "shim", "tool": null, "target": "shim_binary",
              "path": "/Users/example/bin/busyholm-shim", "action": "create_file", "state": "installed",
              "installed_at": 1760270400000u64,
              "before": { "existed": false, "sha256": null, "bytes": null },
              "after": { "sha256": SHA, "bytes": 4096 } }
        ]
    })
}

#[test]
fn full_objects_roundtrip() {
    roundtrip::<AgentEvent>(event());
    roundtrip::<Snapshot>(snapshot());
    roundtrip::<Moment>(json!({ "schema_version": 1, "kind": "build_complete", "t": 1760270400000u64,
        "structure": "well", "stage": 3 }));
    roundtrip::<Moment>(json!({ "schema_version": 1, "kind": "turn_end", "t": 1760270400000u64,
        "agent": A, "tool": "claude", "turn_ms": 125000 }));
    roundtrip::<Moment>(json!({ "schema_version": 1, "kind": "needs_you", "t": 1760270400000u64,
        "agent": A, "tool": "codex", "reason": "question", "request_id": R }));
    roundtrip::<Moment>(json!({ "schema_version": 1, "kind": "limit_hit", "t": 1760270400000u64,
        "provider": "codex" }));
    roundtrip::<Moment>(json!({ "schema_version": 1, "kind": "milestone", "t": 1760270400000u64,
        "milestone": "turns_1000" }));
    roundtrip::<Ledger>(ledger());
    roundtrip::<PendingAlerts>(pending_alerts());
    roundtrip::<Choices>(choices());
    roundtrip::<World>(world());
    roundtrip::<HitRects>(hit_rects());
    roundtrip::<Settings>(settings());
    roundtrip::<InstallManifest>(manifest());
}

#[test]
fn limit_event_and_null_resets_at() {
    let mut e = event();
    let o = e.as_object_mut().unwrap();
    o.remove("usage");
    o.insert("kind".into(), json!("limit_hit"));
    o.insert("limit".into(), json!({ "provider": "claude", "window": "unknown", "resets_at": null }));
    let ev: AgentEvent = roundtrip(e);
    assert_eq!(ev.limit.unwrap().window, LimitWindow::Unknown);
}

#[test]
fn all_enum_strings_with_digits_roundtrip() {
    for s in ["workshop_1", "workshop_2", "cottage_1", "cottage_2"] {
        let mut w = world();
        w["structures"][0]["id"] = json!(s);
        roundtrip::<World>(w);
    }
    for s in ["turns_100", "turns_1000", "streak_7", "two_tools_day"] {
        let mut w = world();
        w["milestones"][0]["id"] = json!(s);
        roundtrip::<World>(w);
    }
    for s in ["claude", "codex", "opencode", "antigravity", "gemini", "cursor", "aider", "other",
              "guest_house", "footbridge", "jetty"] {
        let mut w = world();
        w["structures"][1]["variant"] = json!(s);
        roundtrip::<World>(w);
    }
}

#[test]
fn five_hour_window_roundtrips() {
    assert_eq!(serde_json::to_string(&Window::FiveHour).unwrap(), "\"5h\"");
    assert_eq!(serde_json::from_str::<Window>("\"5h\"").unwrap(), Window::FiveHour);
    assert_eq!(serde_json::from_str::<LimitWindow>("\"5h\"").unwrap(), LimitWindow::FiveHour);
    assert!(serde_json::from_str::<Window>("\"five_hour\"").is_err());
    assert!(serde_json::from_str::<Window>("\"unknown\"").is_err());
}

#[test]
fn missing_required_nullable_is_rejected_and_null_accepted() {
    // AgentEvent.parent
    let mut e = event();
    e.as_object_mut().unwrap().remove("parent");
    assert!(rejects::<AgentEvent>(e).contains("parent"));
    // AgentEvent limit.resets_at
    let mut e = event();
    let o = e.as_object_mut().unwrap();
    o.remove("usage");
    o.insert("limit".into(), json!({ "provider": "claude", "window": "5h" }));
    assert!(rejects::<AgentEvent>(e).contains("resets_at"));
    // Snapshot attention.oldest_since
    let mut s = snapshot();
    s["attention"].as_object_mut().unwrap().remove("oldest_since");
    assert!(rejects::<Snapshot>(s).contains("oldest_since"));
    // Snapshot agent.parent
    let mut s = snapshot();
    s["agents"][0].as_object_mut().unwrap().remove("parent");
    assert!(rejects::<Snapshot>(s).contains("parent"));
    // Ledger
    let mut l = ledger();
    l.as_object_mut().unwrap().remove("hooks_first_connected_day");
    assert!(rejects::<Ledger>(l).contains("hooks_first_connected_day"));
    let mut l = ledger();
    l.as_object_mut().unwrap().remove("backfill");
    assert!(rejects::<Ledger>(l).contains("backfill"));
    // World
    let mut w = world();
    w.as_object_mut().unwrap().remove("founders_stone");
    assert!(rejects::<World>(w).contains("founders_stone"));
    // Settings
    let mut s = settings();
    s["sound"].as_object_mut().unwrap().remove("quiet_hours");
    assert!(rejects::<Settings>(s).contains("quiet_hours"));
    let mut s = settings();
    s["ambient"].as_object_mut().unwrap().remove("idle_minutes");
    assert!(rejects::<Settings>(s).contains("idle_minutes"));
    let mut s = settings();
    s["ambient"].as_object_mut().unwrap().remove("shortcut");
    assert!(rejects::<Settings>(s).contains("shortcut"));
    // InstallManifest
    let mut m = manifest();
    m.as_object_mut().unwrap().remove("owner_tag");
    assert!(rejects::<InstallManifest>(m).contains("owner_tag"));
    for key in ["event", "replaced_sha256"] {
        let mut m = manifest();
        m["entries"][0]["owned"][0].as_object_mut().unwrap().remove(key);
        assert!(rejects::<InstallManifest>(m).contains(key));
    }
    // New identity fields: a missing one is an error, in every contract that has them.
    for key in ["root_id", "account_id", "session_id", "turn_id", "request_id"] {
        let mut e = event();
        e.as_object_mut().unwrap().remove(key);
        assert!(rejects::<AgentEvent>(e).contains(key), "event {key}");
        let mut s = snapshot();
        s["agents"][0].as_object_mut().unwrap().remove(key);
        assert!(rejects::<Snapshot>(s).contains(key), "agent {key}");
    }
    for key in ["root_id", "account_id"] {
        let mut s = snapshot();
        s["limits"][0].as_object_mut().unwrap().remove(key);
        assert!(rejects::<Snapshot>(s).contains(key), "limit {key}");
    }
    for key in ["root_id", "coverage", "coverage_reason"] {
        let mut s = snapshot();
        s["tools"][0].as_object_mut().unwrap().remove(key);
        assert!(rejects::<Snapshot>(s).contains(key), "tool {key}");
    }
    for key in ["root_id", "account_id", "session_id", "request_id"] {
        let mut p = pending_alerts();
        p["alerts"][0].as_object_mut().unwrap().remove(key);
        assert!(rejects::<PendingAlerts>(p).contains(key), "alert {key}");
    }
    let mut m = manifest();
    m["entries"][1].as_object_mut().unwrap().remove("tool");
    assert!(rejects::<InstallManifest>(m).contains("tool"));
    let mut m = manifest();
    m["entries"][1]["before"].as_object_mut().unwrap().remove("sha256");
    assert!(rejects::<InstallManifest>(m).contains("sha256"));
    let mut m = manifest();
    m["entries"][1]["before"].as_object_mut().unwrap().remove("bytes");
    assert!(rejects::<InstallManifest>(m).contains("bytes"));

    // Explicit nulls are accepted and re-serialize as null.
    let mut s = settings();
    s["sound"]["quiet_hours"] = Value::Null;
    s["ambient"]["idle_minutes"] = Value::Null;
    s["ambient"]["shortcut"] = Value::Null;
    roundtrip::<Settings>(s);
    let mut l = ledger();
    l["hooks_first_connected_day"] = Value::Null;
    l["backfill"] = Value::Null;
    roundtrip::<Ledger>(l);
    let mut w = world();
    w["founders_stone"] = Value::Null;
    roundtrip::<World>(w);
    let mut m = manifest();
    m["owner_tag"] = Value::Null;
    roundtrip::<InstallManifest>(m);
}

#[test]
fn null_in_optional_field_is_rejected() {
    let mut e = event();
    e["et"] = Value::Null;
    rejects::<AgentEvent>(e);
    let mut e = event();
    e["detail"] = Value::Null;
    rejects::<AgentEvent>(e);
    let mut e = event();
    e["detail"]["activity"] = Value::Null;
    rejects::<AgentEvent>(e);
    let mut e = event();
    e["usage"] = Value::Null;
    rejects::<AgentEvent>(e);
    let mut e = event();
    e["tokens_delta"] = Value::Null;
    rejects::<AgentEvent>(e);
    let mut s = snapshot();
    s["agents"][0]["activity"] = Value::Null;
    rejects::<Snapshot>(s);
    let mut s = snapshot();
    s["agents"][0]["project_label"] = Value::Null;
    rejects::<Snapshot>(s);
    rejects::<Moment>(json!({ "schema_version": 1, "kind": "turn_end", "t": 1760270400000u64, "agent": null, "tool": "claude" }));
    rejects::<Moment>(json!({ "schema_version": 1, "kind": "turn_end", "t": 1760270400000u64, "turn_ms": null }));
    let mut w = world();
    w["structures"][1]["variant"] = Value::Null;
    rejects::<World>(w);
    let mut w = world();
    w["structures"][0]["completed_day"] = Value::Null;
    rejects::<World>(w);
    let mut h = hit_rects();
    h["rects"][0]["kind"] = Value::Null;
    rejects::<HitRects>(h);
    let mut m = manifest();
    m["entries"][0]["owned"] = Value::Null;
    rejects::<InstallManifest>(m);
    let mut m = manifest();
    m["entries"][0]["owned"][0]["pointer"] = Value::Null;
    rejects::<InstallManifest>(m);
    let mut r = json!({ "schema_version": 1, "kind": "answered", "t": 1760270400000u64, "agent": A, "tool": "claude", "request_id": null });
    rejects::<Moment>(r.take());
    let mut m = manifest();
    m["entries"][0]["owned"] = Value::Null;
    rejects::<InstallManifest>(m);
}

#[test]
fn unknown_fields_are_rejected_everywhere() {
    macro_rules! extra {
        ($ty:ty, $v:expr, $($path:expr),*) => {{
            let base: Value = $v;
            for path in [$($path),*] {
                let mut v = base.clone();
                let mut cur = &mut v;
                for seg in path.split('/').filter(|s| !s.is_empty()) {
                    cur = match seg.parse::<usize>() {
                        Ok(i) => &mut cur[i],
                        Err(_) => &mut cur[seg],
                    };
                }
                cur.as_object_mut().unwrap().insert("extra".into(), json!(1));
                let msg = rejects::<$ty>(v);
                assert!(msg.contains("extra") || msg.contains("unknown"), "{path}: {msg}");
            }
        }};
    }
    extra!(AgentEvent, event(), "", "detail", "usage");
    extra!(Snapshot, snapshot(), "", "agents/0", "tools/0", "limits/0", "attention");
    extra!(Moment, json!({ "schema_version": 1, "kind": "turn_end", "t": 1760270400000u64 }), "");
    extra!(Ledger, ledger(), "", "privacy", "backfill", "days/2026-09-01/claude");
    extra!(Choices, choices(), "", "privacy", "log/0", "log/1");
    extra!(World, world(), "", "resources", "earned", "structures/0", "structures/3/waiting_for",
        "decorations/0", "milestones/0", "stats", "founders_stone");
    extra!(HitRects, hit_rects(), "", "viewport", "rects/0");
    extra!(Settings, settings(), "", "strip", "strip/display", "sky", "sound", "sound/quiet_hours",
        "notifications", "ambient", "agents", "privacy", "other", "updates");
    extra!(InstallManifest, manifest(), "", "entries/0", "entries/0/before",
        "entries/0/after", "entries/0/owned/0");
    extra!(PendingAlerts, pending_alerts(), "", "privacy", "alerts/0");
}

#[test]
fn tagged_enums_reject_unknown_fields_and_wrong_tags() {
    // Auto {} still rejects extra keys.
    assert!(serde_json::from_value::<StripDisplay>(json!({ "mode": "auto" })).is_ok());
    assert!(serde_json::from_value::<StripDisplay>(json!({ "mode": "auto", "name": "x" })).is_err());
    assert!(serde_json::from_value::<StripDisplay>(json!({ "mode": "named" })).is_err());
    assert!(serde_json::from_value::<StripDisplay>(json!({ "mode": "named", "name": "x", "y": 1 })).is_err());
    assert!(serde_json::from_value::<StripDisplay>(json!({ "mode": "other" })).is_err());
    assert_eq!(serde_json::to_value(StripDisplay::Auto {}).unwrap(), json!({ "mode": "auto" }));
    // Choices entries.
    let bo = json!({ "kind": "build_order", "t": 1760270400000u64, "day": "2026-09-02", "order": ["well"] });
    let dec = json!({ "kind": "decoration", "t": 1760270400000u64, "day": "2026-09-02", "decoration": "lantern_01", "on": false });
    assert!(serde_json::from_value::<ChoiceEntry>(bo.clone()).is_ok());
    assert!(serde_json::from_value::<ChoiceEntry>(dec.clone()).is_ok());
    for (v, key) in [(bo.clone(), "decoration"), (dec.clone(), "order"), (bo, "zzz"), (dec, "zzz")] {
        let mut v = v;
        v.as_object_mut().unwrap().insert(key.into(), json!(true));
        assert!(serde_json::from_value::<ChoiceEntry>(v).is_err(), "{key}");
    }
    assert!(serde_json::from_value::<ChoiceEntry>(json!({ "kind": "nope", "t": 1760270400000u64, "day": "2026-09-02" })).is_err());
}

#[test]
fn wrong_version_const_is_rejected() {
    let mut e = event();
    e["v"] = json!(2);
    assert!(rejects::<AgentEvent>(e).contains("version"));
    let mut e = event();
    e["v"] = json!("1");
    rejects::<AgentEvent>(e);
    let mut s = snapshot();
    s["schema_version"] = json!(1); // Snapshot is v2
    assert!(rejects::<Snapshot>(s).contains("expected version 2"));
    let mut w = world();
    w["schema_version"] = json!(2);
    rejects::<World>(w);
    let mut l = ledger();
    l["schema_version"] = json!(0);
    rejects::<Ledger>(l);
    let mut c = choices();
    c.as_object_mut().unwrap().remove("schema_version");
    rejects::<Choices>(c);
    let mut s = settings();
    s["schema_version"] = json!(1.5);
    rejects::<Settings>(s);
}

#[test]
fn contains_text_must_be_false() {
    let mut l = ledger();
    l["privacy"]["containsText"] = json!(true);
    assert!(rejects::<Ledger>(l).contains("containsText"));
    let mut c = choices();
    c["privacy"]["containsText"] = json!("false");
    rejects::<Choices>(c);
    let mut c = choices();
    c["privacy"] = json!({});
    rejects::<Choices>(c);
    let mut c = choices();
    c["privacy"] = json!({ "contains_text": false });
    rejects::<Choices>(c);
}

#[test]
fn integer_widths_follow_the_schema() {
    // Millisecond timestamps need 64 bits; negative or fractional integers fail.
    let mut s = snapshot();
    s["t"] = json!(-1);
    rejects::<Snapshot>(s);
    let mut s = snapshot();
    s["t"] = json!(1760270400000.5);
    rejects::<Snapshot>(s);
    // ordinal 999 fits (u16), 70000 does not.
    let mut s = snapshot();
    s["agents"][0]["ordinal"] = json!(70000);
    rejects::<Snapshot>(s);
    // seed is u32.
    let mut l = ledger();
    l["seed"] = json!(4294967296u64);
    rejects::<Ledger>(l);
    // A float where an integer is required is rejected.
    let mut w = world();
    w["stats"]["lifetime_turns"] = json!(1.5);
    rejects::<World>(w);
}

#[test]
fn revision_one_semantic_rules() {
    use busyholm_contracts::from_value;
    // The realistic samples are semantically valid.
    from_value::<AgentEvent>(event()).unwrap();
    from_value::<Snapshot>(snapshot()).unwrap();
    from_value::<Ledger>(ledger()).unwrap();
    from_value::<World>(world()).unwrap();
    from_value::<InstallManifest>(manifest()).unwrap();
    from_value::<PendingAlerts>(pending_alerts()).unwrap();

    // AgentEvent: request_id only on request kinds.
    let mut e = event();
    e["request_id"] = json!(R);
    assert!(from_value::<AgentEvent>(e.clone()).is_err());
    e["kind"] = json!("tool_end");
    e["usage"] = Value::Null; // would be a serde error, so remove instead
    e.as_object_mut().unwrap().remove("usage");
    from_value::<AgentEvent>(e).unwrap();

    // Snapshot: request_id only for needs_you; coverage_reason null iff verified.
    let mut s = snapshot();
    s["agents"][1]["request_id"] = json!(R);
    assert!(from_value::<Snapshot>(s).is_err());
    let mut s = snapshot();
    s["tools"][0]["coverage_reason"] = json!("other");
    assert!(from_value::<Snapshot>(s).is_err());
    let mut s = snapshot();
    s["tools"][1]["coverage_reason"] = Value::Null;
    assert!(from_value::<Snapshot>(s).is_err());
    // tools unique by (tool, root_id); limits unique by (provider, window, account, root) with null equal.
    let mut s = snapshot();
    let t0 = s["tools"][0].clone();
    s["tools"].as_array_mut().unwrap().push(t0);
    assert!(from_value::<Snapshot>(s).is_err());
    let mut s = snapshot();
    s["limits"][0]["account_id"] = Value::Null;
    let l0 = s["limits"][0].clone();
    s["limits"].as_array_mut().unwrap().push(l0);
    assert!(from_value::<Snapshot>(s).is_err());

    // Moment: request_id only on needs_you and answered.
    let ok = json!({ "schema_version": 1, "kind": "answered", "t": 1760270400000u64, "agent": A, "tool": "claude", "request_id": R });
    from_value::<Moment>(ok.clone()).unwrap();
    let mut bad = ok;
    bad["kind"] = json!("turn_end");
    assert!(from_value::<Moment>(bad).is_err());

    // Ledger: working_seconds max 90000.
    let mut l = ledger();
    l["days"]["2026-09-01"]["claude"]["working_seconds"] = json!(90001);
    assert!(from_value::<Ledger>(l).is_err());
    let mut l = ledger();
    l["days"]["2026-09-01"]["claude"]["working_seconds"] = json!(90000);
    from_value::<Ledger>(l).unwrap();

    // World: waiting_for.active_days 1..=3650.
    let mut w = world();
    w["structures"][3]["waiting_for"]["active_days"] = json!(3651);
    assert!(from_value::<World>(w).is_err());

    // InstallManifest: owner_tag, owned presence.
    let mut m = manifest();
    m["owner_tag"] = Value::Null;
    assert!(from_value::<InstallManifest>(m).is_err());
    let mut m = manifest();
    m["entries"][0].as_object_mut().unwrap().remove("owned");
    assert!(from_value::<InstallManifest>(m).is_err());
    let mut m = manifest();
    m["entries"][1]["owned"] = json!([{ "event": null, "pointer": "/a", "sha256": SHA, "replaced_sha256": null }]);
    assert!(from_value::<InstallManifest>(m).is_err());
    let mut m = manifest();
    m["owner_tag"] = json!("SHORT");
    assert!(from_value::<InstallManifest>(m).is_err());
    let mut m = manifest();
    m["entries"] = json!([]);
    m["owner_tag"] = Value::Null;
    from_value::<InstallManifest>(m).unwrap();

    // PendingAlerts: unique by agent.
    let mut p = pending_alerts();
    let a0 = p["alerts"][0].clone();
    p["alerts"].as_array_mut().unwrap().push(a0);
    assert!(from_value::<PendingAlerts>(p).is_err());
}
