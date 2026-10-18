//! WP-11 acceptance: the app's linked collector must accept what the real hook shim posts.
//!
//! collector_link.rs once built the service with `NormalizedMapper`, which expects a normalised
//! AgentEvent, so every real `busyholm-hook` POST (the allowlisted hook BODY) was answered 400 and
//! nothing reached the app (collector/INTEGRATION.md section 2). This test runs the real shim binary
//! against `RealCollector` driven by the hub, in a temp data folder, and needs an event to come out.
//! Everything lives in temp folders; the agents' real folders are never read (the roots are pointed at
//! empty temp folders through CLAUDE_CONFIG_DIR and CODEX_HOME).
#![cfg(all(feature = "collector", unix))]

mod common;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use busyholm_app::collector_link::RealCollector;
use busyholm_app::hub::{Hub, HubConfig, Outlet};
use busyholm_contracts::{Moment, Snapshot};

#[derive(Default)]
struct Rec {
    snaps: Mutex<Vec<serde_json::Value>>,
    moments: Mutex<Vec<serde_json::Value>>,
}
impl Outlet for Rec {
    fn snapshot(&self, s: &Snapshot) {
        self.snaps.lock().unwrap().push(serde_json::to_value(s).unwrap());
    }
    fn moment(&self, m: &Moment) {
        self.moments.lock().unwrap().push(serde_json::to_value(m).unwrap());
    }
}

fn root_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

/// Builds the shim in the root workspace (its own target folder) and returns the binary path.
fn build_shim() -> PathBuf {
    let root = root_dir();
    let target = root.join("target");
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let out = Command::new(cargo)
        .current_dir(&root)
        .args(["build", "-p", "busyholm-shim", "--bin", "busyholm-hook", "--target-dir"])
        .arg(&target)
        .output()
        .expect("run cargo build for the shim");
    assert!(out.status.success(), "building busyholm-hook failed: {}", String::from_utf8_lossy(&out.stderr));
    let bin = target.join("debug/busyholm-hook");
    assert!(bin.exists(), "missing {bin:?}");
    bin
}

fn shim(bin: &Path, agent: &str, runtime: &Path, body: &str) -> std::process::Output {
    let mut child = Command::new(bin)
        .args(["hook", "--agent", agent, "--runtime"])
        .arg(runtime)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(body.as_bytes()).unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn a_real_shim_post_through_the_linked_collector_produces_an_event() {
    let bin = build_shim();
    // macOS temp folders sit under the /var symlink, which the adapters refuse to follow.
    let base = common::temp_dir("wp11-link").canonicalize().unwrap();
    let data = base.join("data");
    let claude = base.join("claude");
    let codex = base.join("codex");
    std::fs::create_dir_all(&claude).unwrap();
    std::fs::create_dir_all(codex.join("sessions")).unwrap();
    // This file holds one test, so changing the process environment cannot race another test.
    std::env::set_var("CLAUDE_CONFIG_DIR", &claude);
    std::env::set_var("CODEX_HOME", &codex);

    let rec = Arc::new(Rec::default());
    let cfg = HubConfig {
        min_interval: Duration::from_millis(50),
        backoff_initial: Duration::from_millis(50),
        backoff_max: Duration::from_millis(200),
    };
    let hub = Hub::start(Box::new(RealCollector::new(data.clone())), rec.clone(), cfg);

    let runtime = data.join("runtime.json");
    let end = Instant::now() + Duration::from_secs(10);
    while !runtime.exists() && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(runtime.exists(), "the linked collector must publish runtime.json");

    // The same body Claude Code hands the shim for a prompt, then a permission request.
    for body in [
        r#"{"hook_event_name":"UserPromptSubmit","session_id":"wp11-sess-1","prompt":"synthetic","cwd":"/synthetic"}"#,
        r#"{"hook_event_name":"PermissionRequest","session_id":"wp11-sess-1","tool_name":"Bash","tool_input":{"command":"synthetic"},"cwd":"/synthetic"}"#,
    ] {
        let out = shim(&bin, "claude", &runtime, body);
        assert_eq!(out.status.code(), Some(0));
    }

    let end = Instant::now() + Duration::from_secs(5);
    let (mut agent_seen, mut moment_seen) = (false, false);
    while Instant::now() < end && !(agent_seen && moment_seen) {
        agent_seen = rec.snaps.lock().unwrap().iter().any(|s| {
            s["agents"].as_array().is_some_and(|a| a.iter().any(|x| x["tool"] == "claude"))
        });
        moment_seen = rec.moments.lock().unwrap().iter().any(|m| m["kind"] == "needs_you" && m["tool"] == "claude");
        std::thread::sleep(Duration::from_millis(50));
    }
    hub.shutdown();
    let _ = std::fs::remove_dir_all(&base);
    assert!(agent_seen, "a Snapshot with the Claude agent must arrive (a 400 on the shim POST means NormalizedMapper)");
    assert!(moment_seen, "a needs_you Moment for Claude must arrive");
}
