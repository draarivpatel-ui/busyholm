//! INT-2 end to end: with the real collector linked in, a disconnect ends a verified connector and a connect
//! lets it verify again. Real `busyholm-hook` shim, real `RealCollector` behind the hub, everything in temp
//! folders (the agent roots are pointed at temp folders through CLAUDE_CONFIG_DIR and CODEX_HOME).
#![cfg(all(feature = "collector", unix))]

mod common;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use busyholm_app::collector_link::RealCollector;
use busyholm_app::connect::{Connector, Part};
use busyholm_app::hooks_link::HooksLink;
use busyholm_app::hub::{Hub, HubConfig, Outlet};
use busyholm_contracts::{Moment, Snapshot};
use busyholm_installer::{Layout, Sources};

#[derive(Default)]
struct Rec {
    last: Mutex<Option<serde_json::Value>>,
}
impl Outlet for Rec {
    fn snapshot(&self, s: &Snapshot) {
        *self.last.lock().unwrap() = Some(serde_json::to_value(s).unwrap());
    }
    fn moment(&self, _m: &Moment) {}
}
impl Rec {
    /// (coverage, reason) of the Claude connector in the newest snapshot.
    fn claude(&self) -> Option<(String, Option<String>)> {
        let g = self.last.lock().unwrap();
        let t = g.as_ref()?["tools"].as_array()?.iter().find(|t| t["tool"] == "claude")?.clone();
        Some((t["coverage"].as_str()?.to_string(), t["coverage_reason"].as_str().map(str::to_string)))
    }
    fn wait_claude(&self, coverage: &str, reason: Option<&str>) -> Result<(), String> {
        let end = Instant::now() + Duration::from_secs(8);
        while Instant::now() < end {
            if self.claude().is_some_and(|(c, r)| c == coverage && r.as_deref() == reason) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err(format!("wanted claude {coverage} / {reason:?}, last seen {:?}", self.claude()))
    }
}

fn build_shim() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
    let target = root.join("target");
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let out = Command::new(cargo)
        .current_dir(&root)
        .args(["build", "-p", "busyholm-shim", "--bin", "busyholm-hook", "--target-dir"])
        .arg(&target)
        .output()
        .expect("run cargo build for the shim");
    assert!(out.status.success(), "building busyholm-hook failed: {}", String::from_utf8_lossy(&out.stderr));
    target.join("debug/busyholm-hook")
}

fn shim(bin: &Path, runtime: &Path, body: &str) {
    let mut child = Command::new(bin)
        .args(["hook", "--agent", "claude", "--runtime"])
        .arg(runtime)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(body.as_bytes()).unwrap();
    assert_eq!(child.wait_with_output().unwrap().status.code(), Some(0));
}

#[test]
fn a_disconnect_ends_verified_and_a_reconnect_lets_it_verify_again() {
    let bin = build_shim();
    let base = common::temp_dir("int2-link").canonicalize().unwrap();
    let data = base.join("data");
    let home = base.join("home");
    let layout = Layout { data_dir: data.clone(), claude_dir: home.join(".claude"), codex_dir: home.join(".codex"), opencode_dir: home.join(".config/opencode") };
    for d in [&layout.claude_dir, &layout.codex_dir, &layout.opencode_dir] {
        std::fs::create_dir_all(d).unwrap();
    }
    std::fs::create_dir_all(layout.codex_dir.join("sessions")).unwrap();
    // This file holds one test, so changing the process environment cannot race another test.
    std::env::set_var("CLAUDE_CONFIG_DIR", &layout.claude_dir);
    std::env::set_var("CODEX_HOME", &layout.codex_dir);
    let stand_in = base.join("busyholm-hook-standin");
    std::fs::write(&stand_in, b"#!/bin/sh\nexit 0\n").unwrap();
    let sources = Sources { shim_binary: stand_in, opencode_plugin: include_str!("../../../collector-wp06/plugin/busyholm.js").to_string() };

    let link = HooksLink::new();
    let mut connector = Connector::new(layout, Some(sources), home).with_hooks(link.clone());
    // Start: nothing connected yet. The report is made before the collector exists and is replayed to it.
    connector.report_hooks();

    let rec = Arc::new(Rec::default());
    let cfg = HubConfig { min_interval: Duration::from_millis(50), backoff_initial: Duration::from_millis(50), backoff_max: Duration::from_millis(200) };
    let hub = Hub::start(Box::new(RealCollector::new(data.clone()).with_hooks(link.clone())), rec.clone(), cfg);
    let runtime = data.join("runtime.json");
    let end = Instant::now() + Duration::from_secs(10);
    while !runtime.exists() && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(runtime.exists(), "the linked collector must publish runtime.json");

    let prompt = r#"{"hook_event_name":"UserPromptSubmit","session_id":"int2-sess-1","prompt":"synthetic","cwd":"/synthetic"}"#;
    let result = (|| -> Result<(), String> {
        // 1. The installer has not connected anything: a hook event does not verify, the reason is hooks_missing.
        shim(&bin, &runtime, prompt);
        rec.wait_claude("degraded", Some("hooks_missing"))?;
        // 2. Connect: the next hook event verifies.
        let pv = connector.preview_connect(&[Part::ClaudeHooks])?;
        connector.apply(pv.token)?;
        shim(&bin, &runtime, prompt);
        rec.wait_claude("verified", None)?;
        // 3. Disconnect all: verified ends at once and the reason says why.
        connector.disconnect_all()?;
        rec.wait_claude("degraded", Some("hooks_missing"))?;
        // 4. Reconnect, record a turn, then run the Delete everything sequence:
        //    disconnect_for_delete -> hub.shutdown_without_flush -> delete_data_files.
        let pv = connector.preview_connect(&[Part::ClaudeHooks])?;
        connector.apply(pv.token)?;
        shim(&bin, &runtime, prompt);
        shim(&bin, &runtime, r#"{"hook_event_name":"Stop","session_id":"int2-sess-1"}"#);
        rec.wait_claude("verified", None)?;
        connector.disconnect_for_delete()?;
        hub.shutdown_without_flush();
        let st = connector.delete_data_files()?;
        if st.any_connected {
            return Err("expected all hooks disconnected".into());
        }
        if data.exists() {
            return Err(format!("expected data folder removed, found {:?}", std::fs::read_dir(&data).map(|d| d.flatten().map(|e| e.file_name()).collect::<Vec<_>>())));
        }
        Ok(())
    })();
    hub.shutdown();
    let _ = std::fs::remove_dir_all(&base);
    result.unwrap();
}
