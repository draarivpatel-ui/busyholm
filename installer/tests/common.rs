//! Shared helpers for the WP-07 installer acceptance tests. Every path is inside a temp directory:
//! nothing here can touch the real ~/.claude, ~/.codex or OpenCode config.
#![allow(dead_code)]

use busyholm_contracts::install_manifest::{InstallManifest, InstallTarget};
use busyholm_contracts::Validate;
use busyholm_installer::{canonical_json, Component, Edit, FilePlan, Installer, Layout, Plan, Sources};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const BOM: &[u8] = b"\xef\xbb\xbf";
pub const CLAUDE_EVENTS: [&str; 13] = [
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
    "PermissionRequest", "PermissionDenied", "Notification", "Stop", "StopFailure", "SubagentStart", "SubagentStop",
];
pub const CODEX_EVENTS: [&str; 10] = [
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop",
    "Interrupt", "SubagentStart", "SubagentStop",
];
pub const NOW: u64 = 1_791_800_000_000;

pub struct Sandbox {
    pub tmp: tempfile::TempDir,
    pub layout: Layout,
    pub sources: Sources,
}

pub fn plugin_source() -> String {
    include_str!("../../collector-wp06/plugin/busyholm.js").to_string()
}

pub fn sandbox() -> Sandbox {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    let layout = Layout {
        data_dir: root.join("data dir"), // a space on purpose: macOS "Application Support" has one
        claude_dir: root.join("claude"),
        codex_dir: root.join("codex"),
        opencode_dir: root.join("opencode"),
    };
    for d in [&layout.claude_dir, &layout.codex_dir, &layout.opencode_dir] {
        std::fs::create_dir_all(d).unwrap();
    }
    let shim = root.join("build").join("busyholm-hook");
    std::fs::create_dir_all(shim.parent().unwrap()).unwrap();
    std::fs::write(&shim, b"#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    Sandbox { tmp, layout, sources: Sources { shim_binary: shim, opencode_plugin: plugin_source() } }
}

impl Sandbox {
    pub fn installer(&self) -> Installer {
        Installer::new(self.layout.clone()).with_clock(Box::new(|| NOW))
    }
    pub fn settings(&self) -> PathBuf {
        self.layout.claude_settings()
    }
    pub fn write_settings(&self, bytes: &[u8]) {
        std::fs::write(self.settings(), bytes).unwrap();
    }
    pub fn read_settings(&self) -> Vec<u8> {
        std::fs::read(self.settings()).unwrap()
    }
    pub fn manifest(&self) -> InstallManifest {
        let m = self.installer().load_manifest().unwrap();
        m.validate().unwrap_or_else(|e| panic!("manifest invalid: {e}"));
        m
    }
    pub fn install(&self, c: &[Component]) -> Plan {
        let inst = self.installer();
        let plan = inst.plan_install(c, &self.sources).unwrap_or_else(|e| panic!("plan_install failed: {e}"));
        inst.apply(&plan).unwrap_or_else(|e| panic!("apply failed: {e}"));
        plan
    }
    pub fn disconnect(&self, c: &[Component]) -> Plan {
        let inst = self.installer();
        let plan = inst.plan_disconnect(c).unwrap_or_else(|e| panic!("plan_disconnect failed: {e}"));
        inst.apply(&plan).unwrap_or_else(|e| panic!("apply (disconnect) failed: {e}"));
        plan
    }
}

pub fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn fixtures(kind: &str) -> Vec<(String, Vec<u8>)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join(kind);
    let mut out: Vec<(String, Vec<u8>)> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| (p.file_stem().unwrap().to_string_lossy().to_string(), std::fs::read(&p).unwrap()))
        .collect();
    out.sort();
    out
}

/// Strict parse: BOM removed, UTF-8, no comments, no trailing commas. Whitespace-only is `{}`.
pub fn parse(bytes: &[u8]) -> Value {
    let b = bytes.strip_prefix(BOM).unwrap_or(bytes);
    let s = std::str::from_utf8(b).expect("utf-8");
    if s.trim().is_empty() {
        return serde_json::json!({});
    }
    serde_json::from_str(s).unwrap_or_else(|e| panic!("not strict JSON: {e}\n{s}"))
}

pub fn apply_edits(old: &[u8], edits: &[Edit]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut at = 0;
    for e in edits {
        assert!(e.start >= at && e.end >= e.start && e.end <= old.len(), "edits must be sorted, disjoint, in range");
        out.extend_from_slice(&old[at..e.start]);
        out.extend_from_slice(e.text.as_bytes());
        at = e.end;
    }
    out.extend_from_slice(&old[at..]);
    out
}

/// The "diff touches only the target span" check: every edit lies inside one allowed interval of the old file.
pub fn assert_edits_inside_target_span(fp: &FilePlan, old: &[u8]) {
    for e in &fp.edits {
        assert!(
            fp.allowed.iter().any(|&(a, b)| e.start >= a && e.end <= b),
            "edit {}..{} lies outside the target span(s) {:?}",
            e.start,
            e.end,
            fp.allowed
        );
    }
    let new = fp.new.as_ref().expect("file plan has new bytes");
    assert_eq!(&apply_edits(old, &fp.edits), new, "edits must reproduce the planned file exactly");
}

pub fn file_plan<'a>(plan: &'a Plan, target: InstallTarget) -> &'a FilePlan {
    plan.files.iter().find(|f| f.target == target).unwrap_or_else(|| panic!("no file plan for {target:?}"))
}

/// Count the hook handlers in `v` (a settings or hooks.json document) carrying `tag`.
pub fn count_ours(v: &Value, tag: &str) -> usize {
    fn ours(h: &Value, tag: &str) -> bool {
        let cmd = h.get("command").and_then(Value::as_str).unwrap_or("");
        let in_cmd = cmd.split_whitespace().map(|w| w.trim_matches(|c| c == '\'' || c == '"')).collect::<Vec<_>>().windows(2).any(|w| w[0] == "--owner" && w[1] == tag);
        let in_args = h
            .get("args")
            .and_then(Value::as_array)
            .is_some_and(|a| a.windows(2).any(|w| w[0] == "--owner" && w[1] == tag));
        in_cmd || in_args
    }
    let mut n = 0;
    if let Some(hooks) = v.get("hooks").and_then(Value::as_object) {
        for groups in hooks.values().filter_map(Value::as_array) {
            for g in groups {
                for h in g.get("hooks").and_then(Value::as_array).into_iter().flatten() {
                    if ours(h, tag) {
                        n += 1;
                    }
                }
            }
        }
    }
    n
}

/// The event names that carry one of our handlers.
pub fn events_with_ours(v: &Value, tag: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(hooks) = v.get("hooks").and_then(Value::as_object) {
        for (ev, groups) in hooks {
            let probe = serde_json::json!({"hooks": {ev: groups}});
            if count_ours(&probe, tag) > 0 {
                out.push(ev.clone());
            }
        }
    }
    out.sort();
    out
}

pub fn pointer_hash(doc: &Value, pointer: &str) -> String {
    let v = doc.pointer(pointer).unwrap_or_else(|| panic!("pointer {pointer} not found"));
    sha(canonical_json(v).as_bytes())
}

pub fn tag_of(sb: &Sandbox) -> String {
    sb.manifest().owner_tag.expect("owner tag")
}
