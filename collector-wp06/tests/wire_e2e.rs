//! The real plugin, run by Node over every OpenCode fixture, feeding the real Rust mapper.
mod common;
use collector_wp06::map_wire;
use common::*;
use std::process::Command;

#[test]
fn plugin_output_maps_cleanly_end_to_end() {
    let node = Command::new("node").arg("--version").output();
    if node.is_err() {
        eprintln!("node not found: skipping");
        return;
    }
    let script = repo_root().join("collector-wp06/plugin/tools/emit.mjs");
    let out = Command::new("node").arg(&script).output().expect("run emit.mjs");
    assert!(out.status.success(), "emit.mjs failed: {}", String::from_utf8_lossy(&out.stderr));
    let text = String::from_utf8(out.stdout).unwrap();
    let lines: Vec<&str> = text.lines().filter(|l| !l.is_empty()).collect();
    assert!(lines.len() >= 10, "expected the fixtures to produce posts, got {}", lines.len());
    let mut all = Vec::new();
    for l in lines {
        let evs = map_wire(l.as_bytes(), &FakeIds, 1_791_806_400_000, "/Users/u/.local/share/opencode").unwrap_or_else(|e| panic!("{e:?} for {l}"));
        all.extend(evs);
    }
    check_events(&all);
    let ks = kinds(&all);
    for want in ["session_start", "turn_start", "turn_end", "needs_permission", "answered", "needs_answer", "tool_end", "error", "turn_interrupted", "heartbeat", "session_end"] {
        assert!(ks.iter().any(|k| k == want), "no {want} in {ks:?}");
    }
}
