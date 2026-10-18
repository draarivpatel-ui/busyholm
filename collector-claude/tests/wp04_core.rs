//! WP-04 acceptance 6 (file-open spy), privacy canaries, Revision 1 stripped payloads,
//! the core's grace timer, and the Claude data root rules.
mod common;
use common::*;

use std::path::{Path, PathBuf};

use collector_claude::adapter::{ClaudeConfig, ClaudeCore};
use collector_claude::fsx::{is_never_open, Fsx};
use collector_claude::hooks::map_hook;
use collector_claude::process::ProcInfo;
use serde_json::json;

const PROC_START: &str = "Mon Oct 12 11:50:00 2026";

fn copy_fixture(rel: &str, dest: &Path) {
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    std::fs::write(dest, read_fixture(rel)).unwrap();
}

/// A synthetic ~/.claude holding live-looking files AND every never-open stand-in.
fn synthetic_root(s: &Scratch) -> PathBuf {
    let root = s.join("dotclaude/placeholder").parent().unwrap().to_path_buf();
    copy_fixture("claude/registry/registry-busy.json", &root.join("sessions/41001.json"));
    copy_fixture("never-open/keys/session.key", &root.join("sessions/41001.deadbeefcafe.key"));
    copy_fixture("never-open/codex/auth.json", &root.join("auth.json"));
    copy_fixture("never-open/codex/auth.json", &root.join(".credentials.json"));
    copy_fixture("never-open/codex/history.jsonl", &root.join("history.jsonl"));
    copy_fixture("never-open/antigravity/antigravity-oauth-token", &root.join("antigravity-oauth-token"));
    let proj = root.join("projects/-Users-someone-code-x");
    let sid = "bca1a700-0000-4000-8000-00000000003e";
    copy_fixture("claude/transcript/transcript-main.jsonl", &proj.join(format!("{sid}.jsonl")));
    copy_fixture("never-open/claude/tool-results/result-1.txt", &proj.join(format!("{sid}/tool-results/result-1.txt")));
    copy_fixture("never-open/claude/tool-results/result-1.txt", &proj.join(format!("{sid}/tool-results/big.jsonl")));
    copy_fixture(
        "claude/transcript/transcript-u2028.jsonl",
        &proj.join(format!("{sid}/subagents/agent-bca1a700-0000-4000-8000-0000000000bb.jsonl")),
    );
    root
}

fn procs() -> Vec<ProcInfo> {
    vec![ProcInfo { pid: 41001, start: PROC_START.into(), exe: "/Users/a/.local/share/claude/versions/2.1.296".into() }]
}

fn now_real() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

const FORBIDDEN_NAMES: &[&str] = &["auth.json", ".credentials.json", "history.jsonl", "antigravity-oauth-token", "result-1.txt", "big.jsonl", "session.key"];

fn forbidden(p: &Path) -> bool {
    let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    FORBIDDEN_NAMES.contains(&name.as_str())
        || name.ends_with(".key")
        || p.components().any(|c| c.as_os_str() == "tool-results")
}

fn assert_no_canary(text: &str) {
    let l = text.to_lowercase();
    for needle in ["bhcanary", "bca1a700-0000-4000-8000-", "bca1a700000040008000"] {
        assert!(!l.contains(needle), "canary {needle} leaked");
    }
}

#[test]
fn file_open_spy_proves_no_never_open_path_is_touched() {
    let s = Scratch::new("spy");
    let root = synthetic_root(&s);
    let (fsx, spy) = Fsx::with_spy();
    let mut core = ClaudeCore::new(ClaudeConfig { root: root.clone() }, fsx);
    core.set_processes(procs());

    let mut events = core.rebuild(now_real(), &test_id);
    let t0 = now_real();
    for i in 0..4u64 {
        events.extend(core.poll(t0 + i * 6_000, &test_id));
    }
    assert_valid(&events);
    assert!(!events.is_empty(), "the run must produce events, or the spy proves nothing");

    let touched = spy.paths();
    let names: Vec<String> = touched.iter().map(|p| p.file_name().unwrap().to_string_lossy().to_string()).collect();
    assert!(names.contains(&"41001.json".to_string()), "registry file was read: {names:?}");
    assert!(names.iter().any(|n| n.ends_with("3e.jsonl")), "transcript was read: {names:?}");
    assert!(names.iter().any(|n| n.starts_with("agent-")), "subagent transcript was read: {names:?}");
    let bad: Vec<_> = touched.iter().filter(|p| forbidden(p)).collect();
    assert!(bad.is_empty(), "never-open paths touched: {bad:?}");

    assert_no_canary(&serde_json::to_string(&events).unwrap());
    assert_no_canary(&format!("{:?}", core.stats));
}

#[test]
fn the_guard_refuses_never_open_paths_even_if_asked_directly() {
    let s = Scratch::new("guard");
    let root = synthetic_root(&s);
    let (fsx, spy) = Fsx::with_spy();
    for p in [
        root.join("auth.json"),
        root.join(".credentials.json"),
        root.join("AUTH.JSON"),
        root.join(".Credentials.Json"),
        root.join("history.jsonl"),
        root.join("sessions/41001.deadbeefcafe.key"),
        root.join("antigravity-oauth-token"),
        root.join("projects/-Users-someone-code-x/bca1a700-0000-4000-8000-00000000003e/tool-results/result-1.txt"),
    ] {
        assert!(is_never_open(&p), "{p:?}");
        let err = fsx.read_small(&p, 1024).expect_err("must be refused");
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied, "{p:?}");
        assert!(fsx.read_at(&p, 0, 10).is_err());
        assert!(fsx.metadata(&p).is_err(), "even stat is refused: {p:?}");
    }
    assert!(!spy.paths().is_empty(), "the spy records attempts");
    assert!(fsx.read_small(&root.join("sessions/41001.json"), 65536).is_ok());
    assert!(fsx.read_dir(&root.join("projects/-Users-someone-code-x/bca1a700-0000-4000-8000-00000000003e/tool-results")).is_err());
    for ok in ["sessions/41001.json", "projects/x/abc.jsonl", "projects/x/abc/subagents/agent-1.jsonl", "settings.json"] {
        assert!(!is_never_open(Path::new(ok)), "{ok}");
    }
}

#[test]
fn only_the_fs_module_may_touch_the_file_system_or_network_or_spawn_processes() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let banned = ["std::fs", "fs::", "File::open", "OpenOptions", "std::net", "TcpStream", "UdpSocket", "Command::new", "std::process", "keychain", "env::var"];
    let mut checked = 0;
    for e in std::fs::read_dir(&src).unwrap() {
        let p = e.unwrap().path();
        if p.file_name().unwrap() == "fsx.rs" {
            continue;
        }
        let text = std::fs::read_to_string(&p).unwrap();
        for (n, line) in text.lines().enumerate() {
            let code = line.trim_start();
            if code.starts_with("//") {
                continue;
            }
            for b in banned {
                assert!(!code.contains(b), "{}:{} uses `{b}` outside fsx.rs", p.display(), n + 1);
            }
        }
        checked += 1;
    }
    assert!(checked >= 10);
}

#[test]
fn all_claude_fixtures_through_the_core_leak_no_canary_byte() {
    let s = Scratch::new("canary-out");
    let out = s.join("out/events.jsonl");
    let mut core = ClaudeCore::new(ClaudeConfig { root: s.join("none/placeholder").parent().unwrap().to_path_buf() }, Fsx::real());
    let mut lines = Vec::new();
    for dir in ["hooks", "statusline"] {
        let mut names: Vec<_> = std::fs::read_dir(fixture(&format!("claude/{dir}"))).unwrap().map(|e| e.unwrap().path()).collect();
        names.sort();
        for p in names {
            let body = std::fs::read(&p).unwrap();
            let events = core.map_payload(&body, NOW, &test_id).unwrap_or_else(|e| panic!("{p:?}: {e:?}"));
            for ev in events {
                lines.push(serde_json::to_string(&ev).unwrap());
            }
        }
    }
    assert!(lines.len() > 30);
    std::fs::write(&out, lines.join("\n")).unwrap();

    // The repo's own scanner (UTF-8, UTF-16, hex, base64 forms) over everything produced.
    let status = std::process::Command::new("node")
        .arg(repo_root().join("tools/privacy/check.mjs"))
        .arg(out.parent().unwrap())
        .output()
        .expect("node is required for the privacy kit");
    assert!(status.status.success(), "privacy:check failed: {}", String::from_utf8_lossy(&status.stderr));
}

// ---- Revision 1: the shim sends only allowlisted fields ---------------------------------

/// What the `busyholm-hook` shim is allowed to send for a Claude hook (see SHIM_ALLOWLIST.md; an ALLOWLIST: every
/// other key, including ones nobody has thought of yet, is dropped). `reason` and `error`
/// are closed enums only on SessionEnd and StopFailure; elsewhere they are free text.
const KEEP: &[&str] = &[
    "hook_event_name", "session_id", "prompt_id", "turn_id", "request_id", "tool_use_id", "agent_id",
    "tool_name", "notification_type", "source", "is_interrupt",
];

fn strip(v: serde_json::Value) -> serde_json::Value {
    let obj = v.as_object().unwrap();
    let event = obj.get("hook_event_name").and_then(|n| n.as_str()).unwrap_or("").to_string();
    let mut out = serde_json::Map::new();
    for (k, val) in obj {
        let keep = KEEP.contains(&k.as_str())
            || (k == "reason" && event == "SessionEnd")
            || (k == "error" && event == "StopFailure");
        if keep {
            out.insert(k.clone(), val.clone());
        }
    }
    serde_json::Value::Object(out)
}

#[test]
fn stripped_shim_payloads_map_exactly_like_raw_payloads() {
    let mut n = 0;
    for e in std::fs::read_dir(fixture("claude/hooks")).unwrap() {
        let p = e.unwrap().path();
        let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        let stripped = strip(raw.clone());
        assert!(!stripped.to_string().contains("BHCANARY"), "strip list must remove every canary in {p:?}");
        let a = with_env(NOW, |env| map_hook(raw.to_string().as_bytes(), env).unwrap().events);
        let b = with_env(NOW, |env| map_hook(stripped.to_string().as_bytes(), env).unwrap().events);
        assert_eq!(a, b, "{p:?}");
        n += 1;
    }
    assert_eq!(n, 38);
}

#[test]
fn the_hook_mapper_needs_only_event_name_and_session_id() {
    // Minimal shim payloads: no tool name, no ids beyond the session.
    for (name, expected) in [
        ("UserPromptSubmit", "turn_start/hook/exact"),
        ("Stop", "turn_end/hook/exact;stop=end_turn"),
        ("PermissionRequest", "needs_permission/hook/exact"),
        ("PostToolUse", "tool_end/hook/exact;act=other"),
        ("SessionStart", "session_start/hook/exact"),
    ] {
        let body = json!({"hook_event_name": name, "session_id": "s-1"});
        let ev = with_env(NOW, |env| map_hook(body.to_string().as_bytes(), env).unwrap().events);
        assert_eq!(summs(&ev), vec![expected], "{name}");
    }
}

// ---- core behaviour ---------------------------------------------------------------------

#[test]
fn the_core_routes_hook_and_status_line_bodies_and_counts_drift() {
    let s = Scratch::new("route");
    let mut core = ClaudeCore::new(ClaudeConfig { root: s.path().to_path_buf() }, Fsx::real());
    let hook = core.map_payload(br#"{"hook_event_name":"Stop","session_id":"s-1","prompt_id":"p"}"#, NOW, &test_id).unwrap();
    assert_eq!(summs(&hook), vec!["turn_end/hook/exact;stop=end_turn"]);
    // The same Stop again (hook retry) is dropped by dedup.
    assert!(core.map_payload(br#"{"hook_event_name":"Stop","session_id":"s-1","prompt_id":"p"}"#, NOW + 5, &test_id).unwrap().is_empty());

    let sl = core.map_payload(&read_fixture("claude/statusline/statusline-both-windows.json"), NOW, &test_id).unwrap();
    assert_eq!(sl.len(), 2);

    assert!(core.map_payload(br#"{"hook_event_name":"NewThing","session_id":"s"}"#, NOW, &test_id).unwrap().is_empty());
    assert_eq!(core.stats.unknown_hook_events, 1);
    assert!(core.map_payload(br#"{"neither":"shape"}"#, NOW, &test_id).is_err());
    assert!(core.map_payload(b"nope", NOW, &test_id).is_err());
}

fn write_registry(root: &Path, status: &str) {
    let mut v: serde_json::Value = serde_json::from_slice(&read_fixture("claude/registry/registry-busy.json")).unwrap();
    v["status"] = status.into();
    std::fs::create_dir_all(root.join("sessions")).unwrap();
    std::fs::write(root.join("sessions/41001.json"), v.to_string()).unwrap();
}

#[test]
fn leaving_busy_without_a_stop_becomes_an_inferred_interruption_after_the_grace_period() {
    let s = Scratch::new("interrupt");
    let root = s.path().to_path_buf();
    let mut core = ClaudeCore::new(ClaudeConfig { root: root.clone() }, Fsx::real());
    core.set_processes(procs());
    write_registry(&root, "busy");
    let t = NOW;
    let ev = core.poll(t, &test_id);
    assert_eq!(summs(&ev), vec!["session_start/registry/exact", "turn_start/registry/exact", "process_up/process/exact"]);

    write_registry(&root, "idle");
    assert!(core.poll(t + 1_000, &test_id).is_empty(), "grace period: a Stop hook may still arrive");
    let ev = core.poll(t + 5_000, &test_id);
    assert_eq!(summs(&ev), vec!["turn_interrupted/registry/inferred;stop=interrupted"]);
    assert!(core.poll(t + 9_000, &test_id).is_empty(), "reported once");
}

#[test]
fn a_stop_hook_inside_the_grace_period_cancels_the_interruption() {
    let s = Scratch::new("stop-grace");
    let root = s.path().to_path_buf();
    let mut core = ClaudeCore::new(ClaudeConfig { root: root.clone() }, Fsx::real());
    core.set_processes(procs());
    write_registry(&root, "busy");
    core.poll(NOW, &test_id);
    write_registry(&root, "idle");
    core.poll(NOW + 500, &test_id);
    let stop = format!(r#"{{"hook_event_name":"Stop","session_id":"{}","prompt_id":"p"}}"#, "bca1a700-0000-4000-8000-000000000038");
    let ev = core.map_payload(stop.as_bytes(), NOW + 800, &test_id).unwrap();
    assert_eq!(summs(&ev), vec!["turn_end/hook/exact;stop=end_turn"]);
    assert!(core.poll(NOW + 6_000, &test_id).is_empty(), "no interruption after a real Stop");
}

#[test]
fn registry_account_and_host_flow_into_later_events() {
    let s = Scratch::new("learn");
    let root = s.path().to_path_buf();
    let mut core = ClaudeCore::new(ClaudeConfig { root: root.clone() }, Fsx::real());
    core.set_processes(procs());
    write_registry(&root, "idle");
    core.poll(NOW, &test_id);
    let sid = "bca1a700-0000-4000-8000-000000000038";
    let ev = core.map_payload(format!(r#"{{"hook_event_name":"UserPromptSubmit","session_id":"{sid}"}}"#).as_bytes(), NOW + 10, &test_id).unwrap();
    assert_eq!(ev[0].host, busyholm_contracts::common::Host::Cli);
    assert_eq!(ev[0].account_id, Some(scoped("account", "BHCANARY_claude_ownerAccountUuid_1")));
    let sl = core.map_payload(format!(r#"{{"session_id":"{sid}","rate_limits":{{"five_hour":{{"used_percentage":5,"resets_at":1791817200}}}}}}"#).as_bytes(), NOW + 20, &test_id).unwrap();
    assert_eq!(sl[0].account_id, ev[0].account_id, "limits are kept per account");
}

// ---- data root ----------------------------------------------------------------------------

#[test]
fn claude_config_dir_overrides_the_default_root() {
    let home = Path::new("/home/u");
    assert_eq!(ClaudeConfig::resolve(home, None).root, Path::new("/home/u/.claude"));
    assert_eq!(ClaudeConfig::resolve(home, Some("")).root, Path::new("/home/u/.claude"));
    assert_eq!(ClaudeConfig::resolve(home, Some("  ")).root, Path::new("/home/u/.claude"));
    assert_eq!(ClaudeConfig::resolve(home, Some("/data/claude-work")).root, Path::new("/data/claude-work"));
}

#[test]
fn each_root_gets_its_own_root_id() {
    let body = br#"{"hook_event_name":"UserPromptSubmit","session_id":"s-1"}"#;
    let a = ClaudeCore::new(ClaudeConfig { root: "/a/.claude".into() }, Fsx::real()).map_payload(body, NOW, &test_id).unwrap();
    let b = ClaudeCore::new(ClaudeConfig { root: "/b/.claude".into() }, Fsx::real()).map_payload(body, NOW, &test_id).unwrap();
    assert_ne!(a[0].root_id, b[0].root_id);
    assert_eq!(a[0].root_id, test_id("/a/.claude"), "salted hash of the root path itself (the hasher adds the agent)");
    assert_eq!(a[0].instance, b[0].instance, "same session id, same instance; only the root differs");
}

#[test]
fn a_symlinked_root_has_the_same_root_id_as_the_real_one() {
    let s = Scratch::new("canon");
    let real = s.join("real/placeholder").parent().unwrap().to_path_buf();
    let link = s.join("link-parent/placeholder").parent().unwrap().join("claude");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let body = br#"{"hook_event_name":"UserPromptSubmit","session_id":"s-1"}"#;
        let a = ClaudeCore::new(ClaudeConfig { root: real.clone() }, Fsx::real()).map_payload(body, NOW, &test_id).unwrap();
        let b = ClaudeCore::new(ClaudeConfig { root: link }, Fsx::real()).map_payload(body, NOW, &test_id).unwrap();
        assert_eq!(a[0].root_id, b[0].root_id);
    }
}

#[test]
fn every_id_on_every_event_is_32_lowercase_hex_and_unknowns_are_null_not_missing() {
    let mut all = Vec::new();
    for dir in ["hooks", "statusline"] {
        for e in std::fs::read_dir(fixture(&format!("claude/{dir}"))).unwrap() {
            // A fresh core per file: dedup would otherwise drop repeats of the same session.
            let mut core = ClaudeCore::new(ClaudeConfig { root: "/x/.claude".into() }, Fsx::real());
            all.extend(core.map_payload(&std::fs::read(e.unwrap().path()).unwrap(), NOW, &test_id).unwrap());
        }
    }
    assert!(all.len() > 30);
    for ev in &all {
        let v = serde_json::to_value(ev).unwrap();
        for key in ["instance", "root_id"] {
            let id = v[key].as_str().unwrap();
            assert!(id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "{key}");
        }
        for key in ["parent", "account_id", "session_id", "turn_id", "request_id"] {
            let f = &v[key];
            assert!(f.is_null() || f.as_str().is_some_and(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))), "{key}: {f}");
            assert!(v.get(key).is_some(), "{key} must be present (null when unknown)");
        }
        assert!(v["t"].as_u64().unwrap() > 946_684_800_000, "milliseconds");
        if let Some(u) = v.get("usage") {
            assert!(u["resets_at"].as_u64().unwrap() > 946_684_800_000, "usage.resets_at is milliseconds");
        }
    }
}
