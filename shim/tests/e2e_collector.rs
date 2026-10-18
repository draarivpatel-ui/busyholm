//! Integration with the REAL receiver (WP-03) and the REAL Claude adapter (WP-04): the installed hook entry
//! is run as the agent would run it, and the collector must accept its body and produce the right event.
#![cfg(unix)]

use busyholm_contracts::agent_event::EventKind;
use busyholm_contracts::common::Tool;
use busyholm_installer::{Component, Installer, Layout, Sources};
use collector::receiver::{AdapterRouter, Receiver, ReceiverCredentials};
use collector::{AdapterContext, CollectorInput, EventBus, FakeClock, IdentityHasher};
use collector_claude::adapter::{ClaudeAdapter, ClaudeConfig};
use collector_claude::fsx::Fsx;
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

const BIN: &str = env!("CARGO_BIN_EXE_busyholm-hook");
const NOW: u64 = 1_791_800_000_000;

fn run(mut cmd: Command, stdin: &[u8]) -> std::process::Output {
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn shim_to_real_receiver_to_claude_adapter() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = Layout {
        data_dir: tmp.path().join("data"),
        claude_dir: tmp.path().join("claude"),
        codex_dir: tmp.path().join("codex"),
        opencode_dir: tmp.path().join("oc"),
    };
    std::fs::create_dir_all(&layout.claude_dir).unwrap();
    std::fs::create_dir_all(&layout.data_dir).unwrap();
    std::fs::write(
        layout.claude_settings(),
        serde_json::json!({"statusLine": {"type": "command", "command": "printf kept"}}).to_string(),
    )
    .unwrap();

    // the real receiver, writing runtime.json where the installer told the shim to look
    let bus = EventBus::bounded(256);
    let ctx = AdapterContext { clock: Arc::new(FakeClock::new(NOW)), identities: IdentityHasher::new([7u8; 32]) };
    let mut router = AdapterRouter::new(ctx);
    router.register(Box::new(ClaudeAdapter::new(ClaudeConfig { root: tmp.path().join("claude-root") }, Fsx::real()))).unwrap();
    let keys = ReceiverCredentials::load_or_create(&layout.data_dir).unwrap();
    let _receiver = Receiver::start(&layout.runtime_path(), keys, Arc::new(router), bus.sender()).unwrap();

    let inst = Installer::new(layout.clone());
    let plan = inst.plan_install(&[Component::ClaudeHooks, Component::ClaudeStatusline], &Sources { shim_binary: BIN.into(), opencode_plugin: String::new() }).unwrap();
    inst.apply(&plan).unwrap();
    let settings: Value = serde_json::from_slice(&std::fs::read(layout.claude_settings()).unwrap()).unwrap();

    // a permission request, with content that must not survive
    let h = &settings["hooks"]["PermissionRequest"][0]["hooks"][0];
    let mut cmd = Command::new(h["command"].as_str().unwrap());
    cmd.args(h["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()));
    let out = run(cmd, br#"{"hook_event_name":"PermissionRequest","session_id":"sess-real","tool_name":"Bash","tool_input":{"command":"BHCANARY"},"cwd":"/x"}"#);
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stdout.is_empty() && out.stderr.is_empty());
    match bus.receiver.recv_timeout(Duration::from_secs(2)).expect("the collector must produce an event") {
        CollectorInput::Event(e) => {
            assert_eq!(e.agent, Tool::Claude);
            assert_eq!(e.kind, EventKind::NeedsPermission);
            assert!(!serde_json::to_string(&e).unwrap().contains("BHCANARY"));
        }
        other => panic!("unexpected {other:?}"),
    }

    // the wrapped status line: usage samples reach the adapter, the prior output passes through
    let sl = settings["statusLine"]["command"].as_str().unwrap();
    let mut cmd = Command::new("sh");
    cmd.arg("-c").arg(sl);
    let out = run(cmd, br#"{"session_id":"sess-real","rate_limits":{"five_hour":{"used_percentage":40.0,"resets_at":1791810000},"seven_day":{"used_percentage":10.5,"resets_at":1792300000}}}"#);
    assert_eq!(out.stdout, b"kept");
    let mut kinds = Vec::new();
    while let Ok(CollectorInput::Event(e)) = bus.receiver.recv_timeout(Duration::from_millis(500)) {
        kinds.push((e.kind, e.usage.map(|u| u.used_pct)));
    }
    assert_eq!(kinds.len(), 2, "{kinds:?}");
    assert!(kinds.iter().all(|(k, _)| *k == EventKind::UsageSample));
}
