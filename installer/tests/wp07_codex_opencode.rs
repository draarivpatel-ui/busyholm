//! WP-07 acceptance tests 3 (Codex config.toml and `notify` untouched) plus the Codex hooks.json append
//! and the OpenCode plugin file, ownership in InstallManifest, and the shim binary copy.

mod common;

use busyholm_contracts::install_manifest::{InstallAction, InstallState, InstallTarget};
use busyholm_installer::{Component, InstallError};
use common::*;
use serde_json::json;

const CONFIG_TOML: &str = "# user's codex config\nmodel = \"gpt-6.1\"\nnotify = [\"/Applications/Other.app/Contents/MacOS/client\", \"turn-ended\"]\n\n[tui]\nnotifications = true\n";

fn codex_config_state(sb: &Sandbox) -> (String, std::time::SystemTime) {
    let p = sb.layout.codex_config();
    (sha(&std::fs::read(&p).unwrap()), std::fs::metadata(&p).unwrap().modified().unwrap())
}

#[test]
fn codex_matrix_append_is_exact_and_config_toml_is_never_touched() {
    let mut n = 0;
    for (name, original) in fixtures("codex").into_iter().filter(|(n, _)| n.starts_with("ok-")) {
        let sb = sandbox();
        std::fs::write(sb.layout.codex_config(), CONFIG_TOML).unwrap();
        let toml_before = codex_config_state(&sb);
        std::fs::write(sb.layout.codex_hooks(), &original).unwrap();
        let inst = sb.installer();

        let plan = inst.plan_install(&[Component::CodexHooks], &sb.sources).unwrap_or_else(|e| panic!("{name}: {e}"));
        let fp = file_plan(&plan, InstallTarget::CodexHooks);
        assert_edits_inside_target_span(fp, &original);
        assert!(plan.files.iter().all(|f| f.path != sb.layout.codex_config()), "{name}: config.toml must never be planned");
        inst.apply(&plan).unwrap();

        let after = std::fs::read(sb.layout.codex_hooks()).unwrap();
        let (vb, va) = (parse(&original), parse(&after));
        let tag = tag_of(&sb);
        assert_eq!(count_ours(&va, &tag), 10, "{name}");
        assert_eq!(events_with_ours(&va, &tag), { let mut e = CODEX_EVENTS.map(String::from).to_vec(); e.sort(); e }, "{name}");
        for (k, v) in vb.as_object().unwrap().iter().filter(|(k, _)| *k != "hooks") {
            assert_eq!(&va[k], v, "{name}: {k}");
        }
        for ev in CODEX_EVENTS {
            let old = vb.pointer(&format!("/hooks/{ev}")).and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let new = va.pointer(&format!("/hooks/{ev}")).and_then(|v| v.as_array()).unwrap();
            assert_eq!(&new[..old.len()], &old[..], "{name}: {ev}");
            assert_eq!(new.len(), old.len() + 1, "{name}: {ev}");
        }
        assert_eq!(after.starts_with(BOM), original.starts_with(BOM), "{name}");

        // handler shape: shell form (Codex has no args field), quoted absolute path, async, short timeouts
        for ev in CODEX_EVENTS {
            let groups = va["hooks"][ev].as_array().unwrap();
            let h = &groups[groups.len() - 1]["hooks"][0];
            assert_eq!(h["type"], "command");
            let cmd = h["command"].as_str().unwrap();
            assert!(cmd.starts_with(&format!("'{}'", sb.layout.shim_path().to_str().unwrap())), "{name}: path with a space must be quoted: {cmd}");
            assert!(cmd.contains("hook --agent codex") && cmd.contains(&format!("--owner {tag}")), "{name}: {cmd}");
            assert_eq!(h["async"], true);
            let t = h["timeout"].as_u64().unwrap();
            assert!(t >= 2 && t <= if ev == "SessionEnd" || ev == "Interrupt" { 3 } else { 5 }, "{name}: {ev} timeout {t}");
        }

        // manifest: pending review until the user trusts the hooks inside Codex
        let m = sb.manifest();
        let e = m.entries.iter().find(|e| e.target == InstallTarget::CodexHooks).unwrap();
        assert_eq!(e.state, InstallState::PendingReview, "{name}");
        assert_eq!(e.action, InstallAction::EditSpan);
        assert_eq!(e.owned.as_ref().unwrap().len(), 10);
        for o in e.owned.as_ref().unwrap() {
            assert_eq!(pointer_hash(&va, &o.pointer), o.sha256, "{name}");
        }

        // twice = once
        assert!(inst.plan_install(&[Component::CodexHooks], &sb.sources).unwrap().is_noop(), "{name}");

        // config.toml hash and mtime unchanged
        assert_eq!(codex_config_state(&sb), toml_before, "{name}: config.toml touched");

        sb.disconnect(&[Component::CodexHooks]);
        assert_eq!(sha(&std::fs::read(sb.layout.codex_hooks()).unwrap()), sha(&original), "{name}: exact bytes back");
        assert_eq!(codex_config_state(&sb), toml_before, "{name}: config.toml touched by disconnect");
        n += 1;
    }
    assert!(n >= 9);
}

#[test]
fn codex_refuses_invalid_hooks_json() {
    for (name, bytes) in fixtures("codex").into_iter().filter(|(n, _)| n.starts_with("bad-")) {
        let sb = sandbox();
        std::fs::write(sb.layout.codex_hooks(), &bytes).unwrap();
        match sb.installer().plan_install(&[Component::CodexHooks], &sb.sources) {
            Err(InstallError::InvalidJson { .. }) | Err(InstallError::WrongShape { .. }) => {}
            other => panic!("{name}: must be refused, got {other:?}"),
        }
        assert_eq!(std::fs::read(sb.layout.codex_hooks()).unwrap(), bytes);
    }
}

#[test]
fn codex_missing_hooks_json_is_created_pending_review_and_deleted_when_unchanged() {
    let sb = sandbox();
    std::fs::write(sb.layout.codex_config(), CONFIG_TOML).unwrap();
    let toml_before = codex_config_state(&sb);
    sb.install(&[Component::CodexHooks]);
    let v = parse(&std::fs::read(sb.layout.codex_hooks()).unwrap());
    assert_eq!(count_ours(&v, &tag_of(&sb)), 10);
    let m = sb.manifest();
    let e = m.entries.iter().find(|e| e.target == InstallTarget::CodexHooks).unwrap();
    assert_eq!((e.action, e.state), (InstallAction::CreateFile, InstallState::PendingReview));
    assert!(!e.before.existed);
    sb.disconnect(&[Component::CodexHooks]);
    assert!(!sb.layout.codex_hooks().exists());
    assert_eq!(codex_config_state(&sb), toml_before);
}

#[test]
fn codex_created_file_edited_by_the_user_later_keeps_their_edit() {
    let sb = sandbox();
    sb.install(&[Component::CodexHooks]);
    let mut v = parse(&std::fs::read(sb.layout.codex_hooks()).unwrap());
    v["hooks"]["Stop"].as_array_mut().unwrap().push(json!({"hooks": [{"type": "command", "command": "/mine/stop.sh"}]}));
    v["description"] = json!("mine");
    std::fs::write(sb.layout.codex_hooks(), serde_json::to_string_pretty(&v).unwrap()).unwrap();
    sb.disconnect(&[Component::CodexHooks]);
    let after = parse(&std::fs::read(sb.layout.codex_hooks()).unwrap());
    assert_eq!(after, json!({"description": "mine", "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "/mine/stop.sh"}]}]}}));
}

#[test]
fn opencode_plugin_is_written_with_the_runtime_path_and_removed_only_if_unchanged() {
    let sb = sandbox();
    let inst = sb.installer();
    let plan = inst.plan_install(&[Component::OpencodePlugin], &sb.sources).unwrap();
    assert!(!sb.layout.opencode_plugin().exists(), "preview writes nothing");
    assert!(plan.diff_text().contains("busyholm.js"));
    inst.apply(&plan).unwrap();
    let text = std::fs::read_to_string(sb.layout.opencode_plugin()).unwrap();
    let rt = serde_json::to_string(sb.layout.runtime_path().to_str().unwrap()).unwrap();
    assert!(text.contains(&format!("const RUNTIME_FILE_OVERRIDE = {rt};")), "runtime path must be baked in as a JSON string");
    assert_eq!(text.matches("RUNTIME_FILE_OVERRIDE = ").count(), 1);
    assert!(!text.contains("RUNTIME_FILE_OVERRIDE = null"));
    // the rest of the plugin is byte-identical to the source
    let src = plugin_source();
    let patched_line = format!("const RUNTIME_FILE_OVERRIDE = {rt};");
    let original_line = "const RUNTIME_FILE_OVERRIDE = null;";
    assert_eq!(text.replacen(&patched_line, original_line, 1), src.replacen(original_line, original_line, 1).as_str(), "only the override line changes");

    let m = sb.manifest();
    let e = m.entries.iter().find(|e| e.target == InstallTarget::OpencodePlugin).unwrap();
    assert_eq!((e.action, e.state), (InstallAction::CreateFile, InstallState::Installed));
    assert!(e.owned.is_none(), "a whole file Busyholm owns lists no entries");
    assert_eq!(e.after.sha256, sha(text.as_bytes()));
    assert!(inst.plan_install(&[Component::OpencodePlugin], &sb.sources).unwrap().is_noop());

    sb.disconnect(&[Component::OpencodePlugin]);
    assert!(!sb.layout.opencode_plugin().exists());

    // edited by the user: left in place
    sb.install(&[Component::OpencodePlugin]);
    let mut edited = std::fs::read_to_string(sb.layout.opencode_plugin()).unwrap();
    edited.push_str("\n// my own tweak\n");
    std::fs::write(sb.layout.opencode_plugin(), &edited).unwrap();
    sb.disconnect(&[Component::OpencodePlugin]);
    assert_eq!(std::fs::read_to_string(sb.layout.opencode_plugin()).unwrap(), edited, "an edited plugin is never deleted");
    assert!(sb.manifest().entries.iter().all(|e| e.target != InstallTarget::OpencodePlugin));
}

#[test]
fn opencode_refuses_a_plugin_source_without_the_install_line() {
    let mut sb = sandbox();
    sb.sources.opencode_plugin = "export default {};\n".to_string();
    assert!(sb.installer().plan_install(&[Component::OpencodePlugin], &sb.sources).is_err());
    assert!(!sb.layout.opencode_plugin().exists());
}

#[test]
fn a_foreign_file_at_the_plugin_path_is_never_overwritten() {
    let sb = sandbox();
    std::fs::create_dir_all(sb.layout.opencode_plugin().parent().unwrap()).unwrap();
    std::fs::write(sb.layout.opencode_plugin(), "// somebody else's busyholm.js\n").unwrap();
    assert!(sb.installer().plan_install(&[Component::OpencodePlugin], &sb.sources).is_err());
    assert_eq!(std::fs::read_to_string(sb.layout.opencode_plugin()).unwrap(), "// somebody else's busyholm.js\n");
}

#[test]
fn shim_binary_is_copied_into_the_data_folder_and_owned() {
    let sb = sandbox();
    sb.install(&[Component::CodexHooks]);
    let shim = sb.layout.shim_path();
    assert_eq!(std::fs::read(&shim).unwrap(), std::fs::read(&sb.sources.shim_binary).unwrap());
    assert!(shim.starts_with(&sb.layout.data_dir), "referenced by an absolute path in the app's data folder");
    let m = sb.manifest();
    let e = m.entries.iter().find(|e| e.target == InstallTarget::ShimBinary).unwrap();
    assert_eq!((e.tool, e.action), (None, InstallAction::CreateFile));
    assert!(e.owned.is_none());
    // a newer shim build replaces the copy (an upgrade), keeping one entry
    std::fs::write(&sb.sources.shim_binary, b"#!/bin/sh\n# v2\nexit 0\n").unwrap();
    sb.install(&[Component::CodexHooks]);
    assert_eq!(std::fs::read(&shim).unwrap(), b"#!/bin/sh\n# v2\nexit 0\n");
    assert_eq!(sb.manifest().entries.iter().filter(|e| e.target == InstallTarget::ShimBinary).count(), 1);
    // still needed by a remaining consent: stays; the last disconnect removes it
    sb.install(&[Component::ClaudeHooks]);
    sb.disconnect(&[Component::CodexHooks]);
    assert!(shim.exists());
    sb.disconnect(&[Component::ClaudeHooks]);
    assert!(!shim.exists());
}

#[test]
fn manifest_is_valid_private_and_survives_a_reload() {
    let sb = sandbox();
    sb.write_settings(b"{}\n");
    sb.install(&[Component::ClaudeHooks, Component::ClaudeStatusline, Component::CodexHooks, Component::OpencodePlugin]);
    let m = sb.manifest();
    assert_eq!(m.entries.len(), 5);
    let ids: Vec<&str> = m.entries.iter().map(|e| e.id.as_str()).collect();
    for id in ["claude-hooks", "claude-statusline", "codex-hooks", "opencode-plugin", "shim-binary"] {
        assert!(ids.contains(&id), "{ids:?}");
    }
    assert_eq!(m.app_version, env!("CARGO_PKG_VERSION"));
    assert!(m.entries.iter().all(|e| e.installed_at == NOW));
    // the tag is stable across installs of other components
    let tag = m.owner_tag.clone().unwrap();
    sb.install(&[Component::CodexHooks]);
    assert_eq!(sb.manifest().owner_tag.unwrap(), tag);
    // a corrupt manifest is reported, never silently replaced
    std::fs::write(sb.layout.manifest_path(), b"{ nope").unwrap();
    assert!(sb.installer().load_manifest().is_err());
    assert!(sb.installer().plan_install(&[Component::ClaudeHooks], &sb.sources).is_err());
}
