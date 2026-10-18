//! INT-2 task 2: the onboarding preview must tell the truth about what the installer will add.
//!
//! This builds the REAL installer plan (through the same `Connector` the app uses) in a temp home with synthetic
//! agent config files, applies it in a second temp home to learn the ground truth (which hook events end up in
//! each file, read back from the written file, never from the plan's own note), and compares both with the
//! committed fixture `ui/test/fixtures/real-plan.json`. The UI browser test renders that fixture in the real
//! onboarding page and checks every event name is visible (ui/test/browser/int2-preview.test.mjs).
//!
//! Regenerate with `BUSYHOLM_REGEN_FIXTURE=1 cargo test --test int2_preview_fixture`.

use busyholm_app::connect::{Connector, Part};
use busyholm_installer::{Layout, Sources};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const PARTS: [Part; 4] = [Part::ClaudeHooks, Part::ClaudeStatusline, Part::CodexHooks, Part::OpencodePlugin];
const FIXED_HOME: &str = "/home/synthetic";
const FIXED_OWNER: &str = "0123456789abcdef01234567";

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn world(tag: &str) -> (Tmp, Layout, PathBuf, Sources) {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("busyholm-int2-{tag}-{}-{nanos}", std::process::id()));
    let home = root.join("home");
    let layout = Layout {
        data_dir: home.join("Library").join("Application Support").join("Busyholm"),
        claude_dir: home.join(".claude"),
        codex_dir: home.join(".codex"),
        opencode_dir: home.join(".config").join("opencode"),
    };
    for d in [&layout.claude_dir, &layout.codex_dir, &layout.opencode_dir] {
        std::fs::create_dir_all(d).unwrap();
    }
    // Synthetic user config: one hook of their own on Stop, so Stop is an event the plan adds to rather than creates.
    std::fs::write(
        layout.claude_dir.join("settings.json"),
        "{\n  \"theme\": \"dark\",\n  \"hooks\": {\n    \"Stop\": [\n      { \"hooks\": [ { \"type\": \"command\", \"command\": \"/usr/local/bin/their-own-hook\" } ] }\n    ]\n  }\n}\n",
    )
    .unwrap();
    std::fs::write(layout.codex_dir.join("config.toml"), "model = \"synthetic\"\n").unwrap();
    std::fs::write(root.join("busyholm-hook"), b"#!/bin/sh\n# fixed stand-in for busyholm-hook (INT-2)\nexit 0\n").unwrap();
    let sources = Sources { shim_binary: root.join("busyholm-hook"), opencode_plugin: include_str!("../../../collector-wp06/plugin/busyholm.js").to_string() };
    (Tmp(root.clone()), layout, home, sources)
}

/// Event names whose handler list contains a handler running our shim, read from the file the install wrote.
fn events_with_our_hook(file: &Path, shim: &str) -> Vec<String> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    let mut out: Vec<String> = v["hooks"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, groups)| groups.to_string().contains(shim))
        .map(|(ev, _)| ev.clone())
        .collect();
    out.sort();
    out
}

fn build() -> Value {
    // Plan in one temp home (nothing written) ...
    let (_t1, layout, home, sources) = world("plan");
    let mut c = Connector::new(layout.clone(), Some(sources), home.clone());
    let pv = c.preview_connect(&PARTS).unwrap();
    let mut text = serde_json::to_string(&pv).unwrap();
    assert!(!layout.claude_dir.join("settings.json").metadata().map(|m| m.len() == 0).unwrap_or(true));

    // ... and the same plan applied in another, to read back what really lands in the files.
    let (_t2, layout2, home2, sources2) = world("apply");
    let mut c2 = Connector::new(layout2.clone(), Some(sources2), home2.clone());
    let pv2 = c2.preview_connect(&PARTS).unwrap();
    c2.apply(pv2.token).unwrap();
    let shim = layout2.shim_path().to_string_lossy().to_string();
    let owner = busyholm_installer::Installer::new(layout2.clone()).load_manifest().unwrap().owner_tag.unwrap();
    let truth = json!({
        "~/.claude/settings.json": events_with_our_hook(&layout2.claude_settings(), &shim),
        "~/.codex/hooks.json": events_with_our_hook(&layout2.codex_hooks(), &shim),
    });
    let mut truth_text = truth.to_string();

    // Make the fixture the same on every machine: the temp home becomes a fixed one and the random tag a fixed one.
    let plan_tag = busyholm_installer::Installer::new(layout.clone()).load_manifest().ok().and_then(|m| m.owner_tag);
    for (from, to) in [(home.to_string_lossy().to_string(), FIXED_HOME.to_string()), (home2.to_string_lossy().to_string(), FIXED_HOME.to_string())] {
        text = text.replace(&from.replace('/', "\\/"), &to).replace(&from, &to);
        truth_text = truth_text.replace(&from, &to);
    }
    // the plan's own tag is only known from the plan text: it follows "--owner" (JSON args) or `--owner ` (shell form)
    let _ = (plan_tag, &owner);
    let text = replace_owner_tags(&text);
    json!({ "preview": serde_json::from_str::<Value>(&text).unwrap(), "ground_truth_events": serde_json::from_str::<Value>(&truth_text).unwrap() })
}

/// Replace every 24 hex character word that follows `--owner` with a fixed one.
fn replace_owner_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("--owner") {
        let after = i + "--owner".len();
        out.push_str(&rest[..after]);
        rest = &rest[after..];
        // skip the separator: a space, or the closing quote, comma and opening quote of the next JSON string
        let sep_len = rest.chars().take_while(|c| matches!(c, ' ' | '"' | ',' | '\\')).map(char::len_utf8).sum::<usize>();
        out.push_str(&rest[..sep_len]);
        rest = &rest[sep_len..];
        let hex_len = rest.chars().take_while(|c| c.is_ascii_hexdigit()).count();
        if hex_len == 24 {
            out.push_str(FIXED_OWNER);
            rest = &rest[hex_len..];
        }
    }
    out.push_str(rest);
    out
}

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/test/fixtures/real-plan.json")
}

#[test]
fn the_plan_adds_every_event_and_the_ui_fixture_is_the_real_plan() {
    let built = build();
    let truth = &built["ground_truth_events"];
    // Ground truth sanity: 13 Claude events and 10 Codex events, and Stop is among them although it already existed.
    assert_eq!(truth["~/.claude/settings.json"].as_array().unwrap().len(), 13);
    assert_eq!(truth["~/.codex/hooks.json"].as_array().unwrap().len(), 10);
    assert!(truth["~/.claude/settings.json"].as_array().unwrap().iter().any(|e| e == "Stop"));

    // The preview carries a file entry for every file the install writes, and each hooks file's note names every event.
    let files = built["preview"]["files"].as_array().unwrap();
    for (path, events) in truth.as_object().unwrap() {
        let f = files.iter().find(|f| f["path"] == *path).unwrap_or_else(|| panic!("no preview entry for {path}"));
        let note = f["note"].as_str().unwrap_or("");
        for e in events.as_array().unwrap() {
            assert!(note.contains(e.as_str().unwrap()), "{path}: the preview note does not name {e}");
        }
    }
    for tail in ["bin/busyholm-hook", ".claude/settings.json", ".codex/hooks.json", "plugins/busyholm.js"] {
        assert!(files.iter().any(|f| f["path"].as_str().unwrap().ends_with(tail)), "the preview has no entry for {tail}");
    }

    let mut want = serde_json::to_string_pretty(&built).unwrap();
    want.push('\n');
    if std::env::var_os("BUSYHOLM_REGEN_FIXTURE").is_some() {
        std::fs::create_dir_all(fixture_path().parent().unwrap()).unwrap();
        std::fs::write(fixture_path(), &want).unwrap();
    }
    let have = std::fs::read_to_string(fixture_path()).expect("ui/test/fixtures/real-plan.json is missing: regenerate with BUSYHOLM_REGEN_FIXTURE=1");
    assert!(have == want, "ui/test/fixtures/real-plan.json is stale: regenerate with BUSYHOLM_REGEN_FIXTURE=1 cargo test --test int2_preview_fixture");
}
