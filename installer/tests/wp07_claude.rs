//! WP-07 acceptance tests 1 and 2 for Claude Code settings.json (SPEC 9.1 as modified by Revision 1):
//! 25+ fixtures; install parses; the diff touches only the target span; installing twice adds one set;
//! disconnect removes only our entries (and, when nothing else changed, restores the original bytes).

mod common;

use busyholm_contracts::install_manifest::{InstallAction, InstallState, InstallTarget};
use busyholm_installer::{Component, InstallError};
use common::*;
use serde_json::Value;

fn has_bare_lf(b: &[u8]) -> bool {
    b.iter().enumerate().any(|(i, &c)| c == b'\n' && (i == 0 || b[i - 1] != b'\r'))
}

#[test]
fn there_are_enough_fixtures() {
    let ok = fixtures("settings").into_iter().filter(|(n, _)| n.starts_with("ok-")).count();
    let bad = fixtures("settings").into_iter().filter(|(n, _)| n.starts_with("bad-")).count();
    assert!(ok >= 25, "need at least 25 ok fixtures, have {ok}");
    assert!(bad >= 10, "need at least 10 refusal fixtures, have {bad}");
}

#[test]
fn matrix_hooks_install_diff_idempotence_and_exact_disconnect() {
    let mut checked = 0;
    for (name, original) in fixtures("settings").into_iter().filter(|(n, _)| n.starts_with("ok-")) {
        let ctx = |what: &str| format!("fixture {name}: {what}");
        let sb = sandbox();
        sb.write_settings(&original);
        let inst = sb.installer();

        // preview: writes nothing
        let plan = inst.plan_install(&[Component::ClaudeHooks], &sb.sources).unwrap_or_else(|e| panic!("{}: {e}", ctx("plan")));
        assert_eq!(sb.read_settings(), original, "{}", ctx("preview must not write"));
        assert!(!sb.layout.manifest_path().exists() && !sb.layout.shim_path().exists(), "{}", ctx("preview wrote files"));
        let diff = plan.diff_text();
        assert!(diff.contains("busyholm-hook") && CLAUDE_EVENTS.iter().all(|e| diff.contains(e)), "{}", ctx("diff must show the entries"));
        let fp = file_plan(&plan, InstallTarget::ClaudeHooks);
        assert_edits_inside_target_span(fp, &original);

        inst.apply(&plan).unwrap_or_else(|e| panic!("{}: {e}", ctx("apply")));
        let after = sb.read_settings();
        assert_eq!(Some(&after), fp.new.as_ref(), "{}", ctx("written bytes equal the previewed bytes"));

        // formatting survives
        assert_eq!(after.starts_with(BOM), original.starts_with(BOM), "{}", ctx("BOM"));
        if original.contains(&b'\r') && !has_bare_lf(&original) {
            assert!(!has_bare_lf(&after), "{}", ctx("CRLF file must stay CRLF"));
        }
        if !original.contains(&b'\r') {
            assert!(!after.contains(&b'\r'), "{}", ctx("LF file must stay LF"));
        }

        // parse + only the target changed
        let (vb, va) = (parse(&original), parse(&after));
        for (k, v) in vb.as_object().unwrap() {
            if k != "hooks" {
                assert_eq!(&va[k], v, "{}", ctx(&format!("key {k} changed")));
            }
        }
        assert!(va.as_object().unwrap().keys().all(|k| k == "hooks" || vb.get(k).is_some()), "{}", ctx("new top-level key"));
        let tag = tag_of(&sb);
        assert_eq!(events_with_ours(&va, &tag), { let mut e = CLAUDE_EVENTS.map(String::from).to_vec(); e.sort(); e }, "{}", ctx("events"));
        assert_eq!(count_ours(&va, &tag), 13, "{}", ctx("one handler per event"));
        for ev in CLAUDE_EVENTS {
            // existing user groups come first and are untouched
            let old_groups = vb.pointer(&format!("/hooks/{ev}")).and_then(Value::as_array).cloned().unwrap_or_default();
            let new_groups = va.pointer(&format!("/hooks/{ev}")).and_then(Value::as_array).unwrap();
            assert_eq!(&new_groups[..old_groups.len()], &old_groups[..], "{}", ctx(&format!("{ev}: user groups changed")));
            assert_eq!(new_groups.len(), old_groups.len() + 1, "{}", ctx(&format!("{ev}: exactly one group added")));
        }
        // other events untouched
        if let Some(h) = vb.get("hooks").and_then(Value::as_object) {
            for (ev, v) in h.iter().filter(|(e, _)| !CLAUDE_EVENTS.contains(&e.as_str())) {
                assert_eq!(&va["hooks"][ev], v, "{}", ctx(&format!("{ev} changed")));
            }
        }

        // manifest
        let m = sb.manifest();
        let e = m.entries.iter().find(|e| e.target == InstallTarget::ClaudeHooks).expect("claude_hooks entry");
        assert_eq!(e.state, InstallState::Installed);
        assert_eq!(e.action, InstallAction::EditSpan, "{}", ctx("file existed"));
        assert_eq!(e.path, sb.settings().to_string_lossy());
        assert_eq!(e.after.sha256, sha(&after));
        assert_eq!(e.before.sha256.as_deref(), Some(sha(&original).as_str()));
        let owned = e.owned.as_ref().unwrap();
        assert_eq!(owned.len(), 13, "{}", ctx("owned entries"));
        for o in owned {
            assert_eq!(pointer_hash(&va, &o.pointer), o.sha256, "{}", ctx(&format!("hash of {}", o.pointer)));
            assert!(o.replaced_sha256.is_none());
        }
        assert!(m.entries.iter().any(|e| e.target == InstallTarget::ShimBinary), "{}", ctx("shim entry"));
        assert!(sb.layout.shim_path().is_file());
        assert!(sb.layout.backups_dir().join(format!("{}.bak", sha(&original))).is_file(), "{}", ctx("original kept for recovery"));

        // installing twice adds one set
        let again = inst.plan_install(&[Component::ClaudeHooks], &sb.sources).unwrap();
        assert!(again.is_noop(), "{}", ctx("second install must be a no-op"));
        inst.apply(&again).unwrap();
        assert_eq!(sb.read_settings(), after, "{}", ctx("second install changed bytes"));
        assert_eq!(count_ours(&parse(&sb.read_settings()), &tag), 13);

        // disconnect: nothing else changed, so the original bytes come back
        sb.disconnect(&[Component::ClaudeHooks]);
        assert_eq!(sha(&sb.read_settings()), sha(&original), "{}", ctx("disconnect must restore the original bytes"));
        assert!(sb.manifest().entries.iter().all(|e| e.target != InstallTarget::ClaudeHooks));
        checked += 1;
    }
    assert!(checked >= 25, "only {checked} fixtures ran");
}

#[test]
fn matrix_refuses_invalid_json_and_wrong_shapes_and_leaves_the_file_alone() {
    let mut n = 0;
    for (name, bytes) in fixtures("settings").into_iter().filter(|(n, _)| n.starts_with("bad-")) {
        for comp in [Component::ClaudeHooks, Component::ClaudeStatusline] {
            // shape fixtures about `hooks` only matter for the hooks edit; a status line edit never reads `hooks`
            let hooks_shape_only = name.starts_with("bad-hooks-is") || name.starts_with("bad-event-is");
            if comp == Component::ClaudeStatusline && hooks_shape_only {
                continue;
            }
            let sb = sandbox();
            sb.write_settings(&bytes);
            let r = sb.installer().plan_install(&[comp], &sb.sources);
            match r {
                Err(InstallError::InvalidJson { .. }) | Err(InstallError::WrongShape { .. }) | Err(InstallError::NotUtf8 { .. }) => {}
                Err(e) => panic!("{name}: wrong error kind {e:?}"),
                Ok(_) => panic!("{name}: must be refused"),
            }
            assert_eq!(sb.read_settings(), bytes, "{name}: refused file must be untouched");
            assert!(!sb.layout.manifest_path().exists() && !sb.layout.shim_path().exists(), "{name}: nothing may be written");
            n += 1;
        }
    }
    assert!(n >= 20);
}

#[test]
fn missing_settings_file_is_created_and_removed_again() {
    let sb = sandbox();
    assert!(!sb.settings().exists());
    sb.install(&[Component::ClaudeHooks]);
    let after = sb.read_settings();
    let v = parse(&after);
    let tag = tag_of(&sb);
    assert_eq!(count_ours(&v, &tag), 13);
    assert_eq!(v.as_object().unwrap().len(), 1, "only the hooks key");
    assert!(after.ends_with(b"\n"));
    let m = sb.manifest();
    let e = m.entries.iter().find(|e| e.target == InstallTarget::ClaudeHooks).unwrap();
    assert_eq!(e.action, InstallAction::CreateFile);
    assert!(!e.before.existed);

    // unchanged since install: the file we created is deleted
    sb.disconnect(&[Component::ClaudeHooks]);
    assert!(!sb.settings().exists());
}

#[test]
fn created_file_that_changed_later_keeps_the_users_part() {
    let sb = sandbox();
    sb.install(&[Component::ClaudeHooks]);
    let mut v = parse(&sb.read_settings());
    v["model"] = serde_json::json!("claude-opus-5");
    std::fs::write(sb.settings(), serde_json::to_string_pretty(&v).unwrap()).unwrap();
    sb.disconnect(&[Component::ClaudeHooks]);
    let after = parse(&sb.read_settings());
    assert_eq!(after, serde_json::json!({"model": "claude-opus-5"}), "their key stays, our hooks go, and the empty hooks object we created goes too");
}

#[test]
fn claude_config_dir_is_respected() {
    use busyholm_installer::Layout;
    let home = std::path::Path::new("/home/someone");
    let env = |k: &str| match k {
        "CLAUDE_CONFIG_DIR" => Some("/custom/claude".to_string()),
        "CODEX_HOME" => Some("/custom/codex".to_string()),
        _ => None,
    };
    let l = Layout::from_env_with(home, "/data/busyholm".into(), &env);
    assert_eq!(l.claude_settings(), std::path::PathBuf::from("/custom/claude/settings.json"));
    assert_eq!(l.codex_hooks(), std::path::PathBuf::from("/custom/codex/hooks.json"));
    let none = |_: &str| None;
    let d = Layout::from_env_with(home, "/data/busyholm".into(), &none);
    assert_eq!(d.claude_settings(), std::path::PathBuf::from("/home/someone/.claude/settings.json"));
    assert_eq!(d.codex_hooks(), std::path::PathBuf::from("/home/someone/.codex/hooks.json"));
    assert_eq!(d.opencode_plugin(), std::path::PathBuf::from("/home/someone/.config/opencode/plugins/busyholm.js"));
    let xdg = |k: &str| (k == "XDG_CONFIG_HOME").then(|| "/xdg/config".to_string());
    assert_eq!(Layout::from_env_with(home, "/d".into(), &xdg).opencode_plugin(), std::path::PathBuf::from("/xdg/config/opencode/plugins/busyholm.js"));
    let relative = |k: &str| (k == "CLAUDE_CONFIG_DIR").then(|| "relative/dir".to_string());
    assert_eq!(Layout::from_env_with(home, "/d".into(), &relative).claude_dir, std::path::PathBuf::from("/home/someone/.claude"), "a relative override is ignored");
}

#[test]
fn hook_entries_use_exec_form_with_absolute_shim_and_owner_tag() {
    let sb = sandbox();
    sb.write_settings(b"{}\n");
    sb.install(&[Component::ClaudeHooks]);
    let v = parse(&sb.read_settings());
    let tag = tag_of(&sb);
    assert!(tag.len() >= 16 && tag.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()));
    for ev in CLAUDE_EVENTS {
        let g = &v["hooks"][ev][0];
        assert!(g.get("matcher").is_none(), "{ev}: no matcher, so every tool and notification is seen");
        let h = &g["hooks"][0];
        assert_eq!(h["type"], "command");
        assert_eq!(h["command"], sb.layout.shim_path().to_string_lossy().as_ref(), "absolute path, never PATH");
        assert_eq!(h["async"], true, "{ev}: observer hooks never block Claude");
        assert!(h["timeout"].as_u64().is_some_and(|t| (1..=5).contains(&t)));
        let args: Vec<&str> = h["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
        assert_eq!(
            args,
            ["hook", "--agent", "claude", "--runtime", sb.layout.runtime_path().to_str().unwrap(), "--owner", tag.as_str()]
        );
    }
}

#[test]
fn very_large_settings_file_is_edited_quickly_and_restored() {
    let sb = sandbox();
    let mut s = String::from("{\n  \"env\": {\n");
    for i in 0..120_000 {
        s.push_str(&format!("    \"KEY_{i}\": \"value-{i}-{}\",\n", "x".repeat(40)));
    }
    s.push_str("    \"LAST\": \"1\"\n  },\n  \"hooks\": {\n    \"Stop\": [\n      {\"hooks\": [{\"type\": \"command\", \"command\": \"/x/stop.sh\"}]}\n    ]\n  },\n  \"model\": \"m\"\n}\n");
    assert!(s.len() > 8 * 1024 * 1024, "fixture is {} bytes", s.len());
    sb.write_settings(s.as_bytes());
    let t = std::time::Instant::now();
    let inst = sb.installer();
    let plan = inst.plan_install(&[Component::ClaudeHooks], &sb.sources).unwrap();
    assert_edits_inside_target_span(file_plan(&plan, InstallTarget::ClaudeHooks), s.as_bytes());
    inst.apply(&plan).unwrap();
    sb.disconnect(&[Component::ClaudeHooks]);
    assert_eq!(sha(&sb.read_settings()), sha(s.as_bytes()));
    assert!(t.elapsed() < std::time::Duration::from_secs(20), "took {:?}", t.elapsed());
}

#[test]
fn a_file_that_changes_between_preview_and_apply_is_not_written() {
    let sb = sandbox();
    sb.write_settings(b"{\"model\": \"a\"}\n");
    let inst = sb.installer();
    let plan = inst.plan_install(&[Component::ClaudeHooks], &sb.sources).unwrap();
    std::fs::write(sb.settings(), b"{\"model\": \"b\"}\n").unwrap();
    match inst.apply(&plan) {
        Err(InstallError::ChangedSincePreview { .. }) => {}
        other => panic!("expected ChangedSincePreview, got {other:?}"),
    }
    assert_eq!(sb.read_settings(), b"{\"model\": \"b\"}\n");
    assert!(!sb.layout.manifest_path().exists());
}

#[cfg(unix)]
#[test]
fn symlinked_settings_and_loose_modes_are_handled_safely() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let sb = sandbox();
    let real = sb.tmp.path().join("dotfiles-settings.json");
    std::fs::write(&real, b"{}\n").unwrap();
    symlink(&real, sb.settings()).unwrap();
    match sb.installer().plan_install(&[Component::ClaudeHooks], &sb.sources) {
        Err(InstallError::Symlink { .. }) => {}
        other => panic!("a symlinked settings file must be refused, got {other:?}"),
    }
    assert_eq!(std::fs::read(&real).unwrap(), b"{}\n");

    // the file mode is kept
    let sb = sandbox();
    sb.write_settings(b"{}\n");
    std::fs::set_permissions(sb.settings(), std::fs::Permissions::from_mode(0o600)).unwrap();
    sb.install(&[Component::ClaudeHooks]);
    assert_eq!(std::fs::metadata(sb.settings()).unwrap().permissions().mode() & 0o777, 0o600);
    let shim_mode = std::fs::metadata(sb.layout.shim_path()).unwrap().permissions().mode() & 0o777;
    assert_eq!(shim_mode, 0o755);
    let manifest_mode = std::fs::metadata(sb.layout.manifest_path()).unwrap().permissions().mode() & 0o777;
    assert_eq!(manifest_mode & 0o077, 0, "the manifest holds paths: private");
}

#[test]
fn a_tool_that_is_not_installed_is_reported_and_nothing_is_created() {
    let sb = sandbox();
    std::fs::remove_dir_all(&sb.layout.claude_dir).unwrap();
    match sb.installer().plan_install(&[Component::ClaudeHooks], &sb.sources) {
        Err(InstallError::ToolNotFound { .. }) => {}
        other => panic!("expected ToolNotFound, got {other:?}"),
    }
    assert!(!sb.layout.claude_dir.exists() && !sb.layout.data_dir.exists());
}

#[test]
fn a_plan_made_against_an_older_manifest_is_refused() {
    let sb = sandbox();
    sb.write_settings(b"{}\n");
    let inst = sb.installer();
    let stale = inst.plan_install(&[Component::ClaudeHooks], &sb.sources).unwrap();
    sb.install(&[Component::CodexHooks]); // the manifest moved on
    match inst.apply(&stale) {
        Err(InstallError::ChangedSincePreview { .. }) => {}
        other => panic!("expected ChangedSincePreview, got {other:?}"),
    }
    assert_eq!(sb.read_settings(), b"{}\n");
}

#[test]
fn staged_installs_and_disconnects_restore_the_original_bytes() {
    // install hooks, install status line, disconnect hooks, disconnect status line (and the other order)
    let mut cases: Vec<(String, Option<Vec<u8>>)> = fixtures("settings").into_iter().filter(|(n, _)| n.starts_with("ok-")).map(|(n, b)| (n, Some(b))).collect();
    cases.push(("missing".into(), None));
    cases.push(("spaced-empty-object".into(), Some(b"{ \n \n}\n".to_vec())));
    for (name, original) in cases {
        for order in 0..2 {
            let sb = sandbox();
            if let Some(b) = &original {
                sb.write_settings(b);
            }
            let (first, second) = if order == 0 { (Component::ClaudeHooks, Component::ClaudeStatusline) } else { (Component::ClaudeStatusline, Component::ClaudeHooks) };
            sb.install(&[first]);
            sb.install(&[second]);
            sb.disconnect(&[first]);
            sb.disconnect(&[second]);
            let now = std::fs::read(sb.settings()).ok();
            assert_eq!(now.as_ref().map(|b| sha(b)), original.as_ref().map(|b| sha(b)), "{name} order {order}: not restored; now {:?}", now.map(|b| String::from_utf8_lossy(&b).to_string()));
            assert!(sb.manifest().entries.is_empty(), "{name} order {order}");
        }
    }
}
