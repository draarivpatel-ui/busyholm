//! WP-07 (Revision 1): disconnect removes ONLY our entries. It never restores a whole file over later
//! edits by the user or another tool. The original is kept for recovery only.

mod common;

use busyholm_contracts::install_manifest::InstallTarget;
use busyholm_installer::Component;
use common::*;
use serde_json::{json, Value};

fn fixture(name: &str) -> Vec<u8> {
    fixtures("settings").into_iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("fixture {name}")).1
}

fn replace_once(hay: &[u8], needle: &str, with: &str) -> Vec<u8> {
    let s = String::from_utf8(hay.to_vec()).unwrap();
    assert_eq!(s.matches(needle).count(), 1, "anchor {needle:?} must occur exactly once");
    s.replacen(needle, with, 1).into_bytes()
}

#[test]
fn surgical_third_party_edits_survive_and_only_our_entries_go() {
    // The third party edits the INSTALLED file with plain text edits at anchors that exist in both the
    // original and the installed file. The same edits applied to the original give the expected result.
    let original = fixture("ok-hooks-existing-stop");
    let text = String::from_utf8(original.clone()).unwrap();
    assert!(text.contains("  \"hooks\": {\n    \"Stop\": [\n"), "fixture layout changed:\n{text}");
    let edit = |b: &[u8]| -> Vec<u8> {
        let b = replace_once(b, "{\n  \"", "{\n  \"third_party_note\": \"hello\",\n  \"");
        replace_once(&b, "\"Stop\": [\n", "\"Stop\": [\n      {\"hooks\": [{\"type\": \"command\", \"command\": \"/third/party.sh\"}]},\n")
    };
    let sb = sandbox();
    sb.write_settings(&original);
    sb.install(&[Component::ClaudeHooks]);
    let edited = edit(&sb.read_settings());
    sb.write_settings(&edited);

    let plan = sb.disconnect(&[Component::ClaudeHooks]);
    assert_edits_inside_target_span(file_plan(&plan, InstallTarget::ClaudeHooks), &edited);
    assert_eq!(
        String::from_utf8(sb.read_settings()).unwrap(),
        String::from_utf8(edit(&original)).unwrap(),
        "the file must equal the original plus the third party's edits, byte for byte"
    );
}

#[test]
fn a_hook_appended_after_ours_by_a_third_party_survives() {
    let original = fixture("ok-indent2");
    let sb = sandbox();
    sb.write_settings(&original);
    sb.install(&[Component::ClaudeHooks]);
    let tag = tag_of(&sb);
    // third party: appends its own group to Stop (after ours) and a new event, via a re-serialising tool
    let mut v = parse(&sb.read_settings());
    v["hooks"]["Stop"].as_array_mut().unwrap().push(json!({"hooks": [{"type": "command", "command": "/third/after.sh"}]}));
    v["hooks"]["Elicitation"] = json!([{"hooks": [{"type": "command", "command": "/third/elicit.sh"}]}]);
    v["extra"] = json!({"added": "by someone else"});
    std::fs::write(sb.settings(), serde_json::to_string_pretty(&v).unwrap()).unwrap();

    sb.disconnect(&[Component::ClaudeHooks]);
    let after = parse(&sb.read_settings());
    assert_eq!(count_ours(&after, &tag), 0);
    assert_eq!(after["hooks"]["Stop"], json!([{"hooks": [{"type": "command", "command": "/third/after.sh"}]}]));
    assert_eq!(after["hooks"]["Elicitation"], json!([{"hooks": [{"type": "command", "command": "/third/elicit.sh"}]}]));
    assert_eq!(after["extra"], json!({"added": "by someone else"}));
    let mut expect = parse(&original);
    expect["hooks"] = json!({"Stop": [{"hooks": [{"type": "command", "command": "/third/after.sh"}]}], "Elicitation": [{"hooks": [{"type": "command", "command": "/third/elicit.sh"}]}]});
    expect["extra"] = json!({"added": "by someone else"});
    assert_eq!(after, expect, "everything else is exactly as the third party left it");
}

#[test]
fn another_tool_adding_a_handler_into_our_group_loses_nothing() {
    let sb = sandbox();
    sb.write_settings(b"{}\n");
    sb.install(&[Component::ClaudeHooks]);
    let tag = tag_of(&sb);
    let mut v = parse(&sb.read_settings());
    v["hooks"]["Stop"][0]["hooks"].as_array_mut().unwrap().push(json!({"type": "command", "command": "/third/inside-our-group.sh"}));
    std::fs::write(sb.settings(), serde_json::to_string_pretty(&v).unwrap()).unwrap();
    sb.disconnect(&[Component::ClaudeHooks]);
    let after = parse(&sb.read_settings());
    assert_eq!(count_ours(&after, &tag), 0);
    assert_eq!(after["hooks"]["Stop"], json!([{"hooks": [{"type": "command", "command": "/third/inside-our-group.sh"}]}]));
}

#[test]
fn reformatted_file_deleted_hooks_and_deleted_file_are_all_survivable() {
    // user's tool rewrote the file with different indentation and key order
    let original = fixture("ok-hooks-plugin-style");
    let sb = sandbox();
    sb.write_settings(&original);
    sb.install(&[Component::ClaudeHooks]);
    let v = parse(&sb.read_settings());
    std::fs::write(sb.settings(), serde_json::to_string(&v).unwrap()).unwrap();
    sb.disconnect(&[Component::ClaudeHooks]);
    assert_eq!(parse(&sb.read_settings()), parse(&original));

    // the whole hooks key was removed by the user
    let sb = sandbox();
    sb.write_settings(&fixture("ok-indent2"));
    sb.install(&[Component::ClaudeHooks]);
    let mut v = parse(&sb.read_settings());
    v.as_object_mut().unwrap().remove("hooks");
    std::fs::write(sb.settings(), serde_json::to_string_pretty(&v).unwrap()).unwrap();
    sb.disconnect(&[Component::ClaudeHooks]);
    assert_eq!(parse(&sb.read_settings()), v);
    assert!(sb.manifest().entries.iter().all(|e| e.target != InstallTarget::ClaudeHooks), "the entry is dropped from the manifest");

    // the file is gone
    let sb = sandbox();
    sb.write_settings(&fixture("ok-indent2"));
    sb.install(&[Component::ClaudeHooks]);
    std::fs::remove_file(sb.settings()).unwrap();
    sb.disconnect(&[Component::ClaudeHooks]);
    assert!(!sb.settings().exists(), "never recreated");
}

#[test]
fn disconnect_never_restores_the_old_backup_over_newer_content() {
    let original = fixture("ok-indent4");
    let sb = sandbox();
    sb.write_settings(&original);
    sb.install(&[Component::ClaudeHooks]);
    let tag = tag_of(&sb);
    // the user changes an unrelated setting after install
    let changed = replace_once(&sb.read_settings(), "\"model\":", "\"model_was_changed_by_user\":");
    sb.write_settings(&changed);
    sb.disconnect(&[Component::ClaudeHooks]);
    let after = sb.read_settings();
    assert!(String::from_utf8_lossy(&after).contains("model_was_changed_by_user"), "later edit must survive");
    assert_eq!(count_ours(&parse(&after), &tag), 0);
    // the backup is deleted on disconnect
    assert!(!sb.layout.backups_dir().join(format!("{}.bak", sha(&original))).exists());
}

#[test]
fn a_user_hook_with_a_similar_command_is_never_mistaken_for_ours() {
    let sb = sandbox();
    sb.write_settings(
        br#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/home/u/bin/busyholm-hook hook --agent claude"}]}]}}"#,
    );
    sb.install(&[Component::ClaudeHooks]);
    sb.disconnect(&[Component::ClaudeHooks]);
    assert_eq!(
        parse(&sb.read_settings()),
        parse(br#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/home/u/bin/busyholm-hook hook --agent claude"}]}]}}"#),
        "without our owner tag an entry is not ours, even if it looks similar"
    );
}

#[test]
fn status_line_install_wraps_the_prior_command_and_disconnect_restores_it_exactly() {
    for name in ["ok-statusline-other", "ok-statusline-othertool", "ok-statusline-with-refresh", "ok-statusline-and-hooks"] {
        let original = fixture(name);
        let ov: Value = parse(&original);
        let prior = ov["statusLine"].clone();
        let sb = sandbox();
        sb.write_settings(&original);
        let inst = sb.installer();
        let plan = inst.plan_install(&[Component::ClaudeStatusline], &sb.sources).unwrap();
        assert_edits_inside_target_span(file_plan(&plan, InstallTarget::ClaudeStatusline), &original);
        inst.apply(&plan).unwrap();
        let after = parse(&sb.read_settings());
        let tag = tag_of(&sb);
        let sl = &after["statusLine"];
        assert_eq!(sl["type"], "command");
        let cmd = sl["command"].as_str().unwrap();
        assert!(cmd.contains(&format!("--owner {tag}")), "{name}: tag in the command: {cmd}");
        assert!(cmd.contains("statusline") && cmd.contains(sb.layout.shim_path().to_str().unwrap()), "{name}: {cmd}");
        // other keys of the prior status line (padding, refreshInterval) are kept
        for (k, v) in prior.as_object().unwrap().iter().filter(|(k, _)| *k != "command") {
            assert_eq!(&sl[k], v, "{name}: {k} of the prior status line must be kept");
        }
        // the prior value is saved exactly and named in the command
        let m = sb.manifest();
        let e = m.entries.iter().find(|e| e.target == InstallTarget::ClaudeStatusline).unwrap();
        let o = &e.owned.as_ref().unwrap()[0];
        assert_eq!((o.event.as_deref(), o.pointer.as_str()), (None, "/statusLine"));
        let replaced = o.replaced_sha256.clone().expect("replaced value recorded");
        let bak = sb.layout.backups_dir().join(format!("{replaced}.bak"));
        assert!(cmd.contains(bak.to_str().unwrap()), "{name}: --prev-file must name the saved prior value");
        assert_eq!(parse(&std::fs::read(&bak).unwrap()), prior);
        assert_eq!(sha(&std::fs::read(&bak).unwrap()), replaced);

        // idempotent
        let again = inst.plan_install(&[Component::ClaudeStatusline], &sb.sources).unwrap();
        assert!(again.is_noop(), "{name}");

        sb.disconnect(&[Component::ClaudeStatusline]);
        assert_eq!(sha(&sb.read_settings()), sha(&original), "{name}: exact restore when untouched since");
    }
}

#[test]
fn status_line_disconnect_leaves_a_status_line_the_user_changed_alone() {
    let sb = sandbox();
    sb.write_settings(&fixture("ok-statusline-other"));
    sb.install(&[Component::ClaudeStatusline]);
    let mut v = parse(&sb.read_settings());
    v["statusLine"] = json!({"type": "command", "command": "/users/own/new-status.sh"});
    std::fs::write(sb.settings(), serde_json::to_string_pretty(&v).unwrap()).unwrap();
    sb.disconnect(&[Component::ClaudeStatusline]);
    assert_eq!(parse(&sb.read_settings())["statusLine"]["command"], "/users/own/new-status.sh");
}

#[test]
fn status_line_with_no_prior_is_added_and_removed_and_unsupported_prior_is_refused() {
    let sb = sandbox();
    sb.write_settings(&fixture("ok-indent2"));
    let original = sb.read_settings();
    sb.install(&[Component::ClaudeStatusline]);
    let v = parse(&sb.read_settings());
    assert!(v["statusLine"]["command"].as_str().unwrap().contains("statusline"));
    let m = sb.manifest();
    assert!(m.entries.iter().find(|e| e.target == InstallTarget::ClaudeStatusline).unwrap().owned.as_ref().unwrap()[0].replaced_sha256.is_none());
    sb.disconnect(&[Component::ClaudeStatusline]);
    assert_eq!(sha(&sb.read_settings()), sha(&original));

    // a status line we cannot wrap faithfully is refused, not replaced
    let sb = sandbox();
    sb.write_settings(br#"{"statusLine": "just a string"}"#);
    assert!(sb.installer().plan_install(&[Component::ClaudeStatusline], &sb.sources).is_err());
    sb.write_settings(br#"{"statusLine": {"type": "static", "text": "hi"}}"#);
    assert!(sb.installer().plan_install(&[Component::ClaudeStatusline], &sb.sources).is_err());
    assert_eq!(sb.read_settings(), br#"{"statusLine": {"type": "static", "text": "hi"}}"#);
}

#[test]
fn hooks_and_status_line_together_and_separately() {
    for (name, original) in fixtures("settings").into_iter().filter(|(n, _)| n.starts_with("ok-")) {
        let sb = sandbox();
        sb.write_settings(&original);
        let inst = sb.installer();
        let plan = inst.plan_install(&[Component::ClaudeHooks, Component::ClaudeStatusline], &sb.sources).unwrap();
        assert_edits_inside_target_span(file_plan(&plan, InstallTarget::ClaudeHooks), &original);
        inst.apply(&plan).unwrap();
        let both = sb.read_settings();
        let tag = tag_of(&sb);
        let v = parse(&both);
        assert_eq!(count_ours(&v, &tag), 13, "{name}");
        assert!(v["statusLine"]["command"].as_str().unwrap().contains(&tag), "{name}");
        assert!(sb.manifest().entries.iter().filter(|e| e.path == sb.settings().to_string_lossy()).count() == 2, "{name}: two consents, two entries");

        // separate consents: dropping the status line keeps the hooks
        sb.disconnect(&[Component::ClaudeStatusline]);
        let v = parse(&sb.read_settings());
        assert_eq!(count_ours(&v, &tag), 13, "{name}");
        assert_eq!(v.get("statusLine"), parse(&original).get("statusLine"), "{name}");
        sb.disconnect(&[]);
        assert_eq!(sha(&sb.read_settings()), sha(&original), "{name}: disconnect all restores the bytes");
        assert!(sb.manifest().entries.is_empty(), "{name}: manifest empty after disconnect all");
        assert!(!sb.layout.shim_path().exists(), "{name}: shim removed when nothing needs it");

        // the other order: status line first, then hooks as a separate consent
        let sb = sandbox();
        sb.write_settings(&original);
        sb.install(&[Component::ClaudeStatusline]);
        sb.install(&[Component::ClaudeHooks]);
        let tag = tag_of(&sb);
        sb.disconnect(&[Component::ClaudeHooks]);
        let v = parse(&sb.read_settings());
        assert_eq!(count_ours(&v, &tag), 0, "{name}");
        assert!(v["statusLine"]["command"].as_str().unwrap().contains(&tag), "{name}: status line stays");
        sb.disconnect(&[Component::ClaudeStatusline]);
        assert_eq!(sha(&sb.read_settings()), sha(&original), "{name}");
    }
}

fn dup_hooks_file(sb: &Sandbox, before_ours: bool) {
    let text = String::from_utf8(sb.read_settings()).unwrap();
    let dup = "\"hooks\": {\"Elicitation\": []},\n  ";
    let text = if before_ours { text.replacen("{\n  ", &format!("{{\n  {dup}"), 1) } else { text.replacen("\n}\n", ",\n  \"hooks\": {\"Elicitation\": []}\n}\n", 1) };
    assert_eq!(text.matches("\n  \"hooks\"").count(), 2, "duplicate key not added:\n{text}");
    sb.write_settings(text.as_bytes());
}

#[test]
fn duplicate_hooks_keys_are_refused_at_install_and_at_disconnect_in_both_orders() {
    for before_ours in [true, false] {
        // a file that already has two `hooks` keys: install refuses, file untouched
        let sb = sandbox();
        sb.write_settings(b"{\n  \"hooks\": {},\n  \"hooks\": {}\n}\n");
        let orig = sb.read_settings();
        match sb.installer().plan_install(&[Component::ClaudeHooks], &sb.sources) {
            Err(busyholm_installer::InstallError::WrongShape { detail, .. }) => assert!(detail.contains("duplicate"), "{detail}"),
            other => panic!("expected a duplicate-key refusal, got {other:?}"),
        }
        assert_eq!(sb.read_settings(), orig);

        // a third party adds a second `hooks` key after our install
        let sb = sandbox();
        sb.write_settings(b"{\n  \"model\": \"m\"\n}\n");
        sb.install(&[Component::ClaudeHooks]);
        dup_hooks_file(&sb, before_ours);
        let dirty = sb.read_settings();
        let plan = sb.installer().plan_disconnect(&[Component::ClaudeHooks]).unwrap();
        assert!(plan.diff_text().contains("duplicate"), "the plan must say why nothing is removed:\n{}", plan.diff_text());
        sb.installer().apply(&plan).unwrap();
        assert_eq!(sb.read_settings(), dirty, "file untouched");
        assert!(sb.manifest().entries.iter().any(|e| e.target == InstallTarget::ClaudeHooks), "the entry is kept so a later disconnect can finish");

        // once the user removes the duplicate, disconnect works again
        let fixed = String::from_utf8(dirty).unwrap().replace("\"hooks\": {\"Elicitation\": []},\n  ", "").replace(",\n  \"hooks\": {\"Elicitation\": []}", "");
        sb.write_settings(fixed.as_bytes());
        sb.disconnect(&[Component::ClaudeHooks]);
        assert_eq!(parse(&sb.read_settings()), serde_json::json!({"model": "m"}));
    }
    // duplicate event keys inside `hooks`, and a duplicate statusLine, are refused too
    let sb = sandbox();
    sb.write_settings(b"{\"hooks\": {\"Stop\": [], \"Stop\": []}}\n");
    assert!(sb.installer().plan_install(&[Component::ClaudeHooks], &sb.sources).is_err());
    sb.write_settings(b"{\"statusLine\": {\"type\":\"command\",\"command\":\"a\"}, \"statusLine\": {\"type\":\"command\",\"command\":\"b\"}}\n");
    assert!(sb.installer().plan_install(&[Component::ClaudeStatusline], &sb.sources).is_err());
}

#[test]
fn a_status_line_edited_by_a_third_party_keeps_their_edit_and_gets_the_users_command_back() {
    let original = fixture("ok-statusline-with-refresh");
    let sb = sandbox();
    sb.write_settings(&original);
    sb.install(&[Component::ClaudeStatusline]);
    let edited = replace_once(&sb.read_settings(), "\"refreshInterval\": 5", "\"refreshInterval\": 9");
    sb.write_settings(&edited);
    sb.disconnect(&[Component::ClaudeStatusline]);
    let after = parse(&sb.read_settings());
    assert_eq!(after["statusLine"]["refreshInterval"], 9, "their edit survives");
    assert_eq!(after["statusLine"]["command"], parse(&original)["statusLine"]["command"], "the user's own command is back");
    assert_eq!(after["statusLine"]["padding"], 1);
}

#[test]
fn a_missing_saved_status_line_does_not_block_the_other_disconnects() {
    let sb = sandbox();
    sb.write_settings(&fixture("ok-statusline-other"));
    sb.install(&[Component::ClaudeHooks, Component::ClaudeStatusline]);
    let tag = tag_of(&sb);
    std::fs::remove_dir_all(sb.layout.backups_dir()).unwrap();
    let plan = sb.installer().plan_disconnect(&[]).unwrap();
    assert!(plan.diff_text().contains("saved"), "{}", plan.diff_text());
    sb.installer().apply(&plan).unwrap();
    let v = parse(&sb.read_settings());
    assert_eq!(count_ours(&v, &tag), 0, "hooks are removed even though the saved status line is gone");
    assert!(sb.manifest().entries.iter().any(|e| e.target == InstallTarget::ClaudeStatusline), "the status line entry stays so nothing is forgotten");
}

fn scan_dir_for(dir: &std::path::Path, needles: &[&str]) -> Vec<String> {
    let mut hits = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return hits };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            hits.extend(scan_dir_for(&p, needles));
        } else if let Ok(bytes) = std::fs::read(&p) {
            let text = String::from_utf8_lossy(&bytes);
            for &n in needles {
                if text.contains(n) {
                    hits.push(format!("{}: contains {n}", p.display()));
                }
            }
        }
    }
    hits
}

#[test]
fn p1_1_installer_never_copies_user_settings_or_keys_and_deletes_backups_on_disconnect() {
    let sb = sandbox();
    let secret_settings = br#"{
  "env": {"ANTHROPIC_API_KEY": "sk-ZQCANARY-SECRET-123"},
  "apiKeyHelper": "/Users/ZQPATHUSER/get-key.sh",
  "permissions": {"allow": ["Read(//Users/ZQPATHUSER/proj/**)"]},
  "hooks": {
    "Stop": [
      {"hooks": [{"type": "command", "command": "/Users/ZQPATHUSER/user-hook.sh"}]}
    ]
  },
  "statusLine": {"type": "command", "command": "/Users/ZQPATHUSER/bin/mystatus --token ZQSTATUSTOKEN"}
}
"#;
    sb.write_settings(secret_settings);
    sb.install(&[Component::ClaudeHooks, Component::ClaudeStatusline]);

    // While connected: API keys, paths, permissions and user hooks are NEVER stored in data_dir.
    let forbidden_while_connected = [
        "ZQCANARY",
        "ANTHROPIC_API_KEY",
        "apiKeyHelper",
        "get-key.sh",
        "ZQPATHUSER/proj",
        "user-hook.sh",
    ];
    let hits = scan_dir_for(&sb.layout.data_dir, &forbidden_while_connected);
    assert!(hits.is_empty(), "unrelated user settings must never be copied into data_dir: {hits:?}");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for entry in std::fs::read_dir(sb.layout.backups_dir()).unwrap().flatten() {
            let mode = entry.metadata().unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "backup {} must be 0600", entry.path().display());
        }
    }

    // Disconnect: restores settings byte for byte and deletes all install backups (including replaced statusLine).
    sb.disconnect(&[]);
    assert_eq!(sb.read_settings(), secret_settings, "settings.json must be restored byte for byte");
    let all_canaries = ["ZQCANARY", "ZQPATHUSER", "ZQSTATUSTOKEN"];
    let after_hits = scan_dir_for(&sb.layout.data_dir, &all_canaries);
    assert!(after_hits.is_empty(), "no canary may remain in data_dir after disconnect: {after_hits:?}");
    assert!(!sb.layout.backups_dir().exists(), "backups/install must be removed when empty");
    assert!(!sb.layout.manifest_path().exists(), "empty install-manifest.json must be removed on disconnect");
}

#[test]
fn p1_1_delete_everything_disconnects_first_then_removes_data_folder() {
    let sb = sandbox();
    let original = fixture("ok-statusline-and-hooks");
    sb.write_settings(&original);
    std::fs::write(sb.layout.codex_hooks(), b"{\"hooks\":{}}\n").unwrap();
    sb.install(&[Component::ClaudeHooks, Component::ClaudeStatusline, Component::CodexHooks, Component::OpencodePlugin]);

    // Populate the rest of the app data folder (ledger, rolling backups, coverage, logs).
    std::fs::write(sb.layout.data_dir.join("ledger.json"), b"{\"turns\":3}\n").unwrap();
    std::fs::write(sb.layout.data_dir.join("coverage.json"), b"{}\n").unwrap();
    let bdir = sb.layout.data_dir.join("backups");
    std::fs::create_dir_all(&bdir).unwrap();
    std::fs::write(bdir.join("ledger-2026-10-17.json"), b"{}\n").unwrap();
    let ldir = sb.layout.data_dir.join("logs");
    std::fs::create_dir_all(&ldir).unwrap();
    std::fs::write(ldir.join("app.log"), b"log\n").unwrap();

    sb.installer().delete_everything().expect("delete_everything should succeed");

    // Agent config files were disconnected first and restored byte for byte.
    assert_eq!(sb.read_settings(), original, "Claude settings restored before data_dir removal");
    assert_eq!(std::fs::read(sb.layout.codex_hooks()).unwrap(), b"{\"hooks\":{}}\n", "Codex hooks restored");
    assert!(!sb.layout.opencode_plugin().exists(), "OpenCode plugin removed");
    // And the entire app data folder (ledger, backups/, coverage.json, logs, manifest, shim) is gone.
    assert!(!sb.layout.data_dir.exists(), "data_dir must be completely removed");
}

#[cfg(unix)]
#[test]
fn p2_5_statusline_wrapper_falls_back_to_original_command_when_shim_or_backup_is_missing() {
    let sb = sandbox();
    sb.write_settings(
        br#"{
  "statusLine": {
    "type": "command",
    "command": "printf 'original-status-line'; exit 0"
  }
}
"#,
    );
    sb.install(&[Component::ClaudeStatusline]);
    let after = parse(&sb.read_settings());
    let cmd = after["statusLine"]["command"].as_str().unwrap().to_string();
    assert!(cmd.contains("--prev-cmd"), "wrapper must pass --prev-cmd fallback: {cmd}");

    // Simulate the user deleting Busyholm's entire data folder (e.g. AppCleaner) without disconnecting.
    std::fs::remove_dir_all(&sb.layout.data_dir).unwrap();
    let out = std::process::Command::new("sh").arg("-c").arg(&cmd).output().unwrap();
    assert_eq!(out.status.code(), Some(0), "wrapper must succeed when shim and backup are deleted");
    assert_eq!(out.stdout, b"original-status-line", "wrapper must fall back to the user's original command");
}

#[test]
fn p2_3_foreign_file_survives_delete_everything_and_is_reported() {
    let sb = sandbox();
    let original = fixture("ok-statusline-and-hooks");
    sb.write_settings(&original);
    sb.install(&[Component::ClaudeHooks, Component::ClaudeStatusline]);

    std::fs::write(sb.layout.data_dir.join("ledger.json"), b"{\"turns\":3}\n").unwrap();
    std::fs::write(sb.layout.data_dir.join("coverage.json"), b"{}\n").unwrap();
    std::fs::write(sb.layout.data_dir.join("settings.json"), b"{}\n").unwrap();
    std::fs::write(sb.layout.data_dir.join("onboarding.json"), b"{}\n").unwrap();
    let foreign = sb.layout.data_dir.join("user-notes.txt");
    std::fs::write(&foreign, b"do not delete my notes\n").unwrap();

    let left = sb.installer().delete_everything().expect("delete_everything should succeed");
    assert_eq!(sb.read_settings(), original, "Claude settings restored");
    assert!(!sb.layout.data_dir.join("ledger.json").exists(), "known Busyholm files removed");
    assert!(!sb.layout.data_dir.join("coverage.json").exists());
    assert!(!sb.layout.data_dir.join("settings.json").exists());
    assert!(!sb.layout.data_dir.join("onboarding.json").exists());
    assert!(!sb.layout.shim_path().exists());
    assert!(foreign.exists(), "foreign file must survive");
    assert_eq!(std::fs::read(&foreign).unwrap(), b"do not delete my notes\n");
    assert_eq!(left, vec![foreign], "foreign file must be reported");
}

#[cfg(unix)]
#[test]
fn p2_3_symlinked_data_folder_is_refused_and_its_target_untouched() {
    let sb = sandbox();
    let target_dir = sb.tmp.path().join("outside-target");
    std::fs::create_dir_all(&target_dir).unwrap();
    let target_ledger = target_dir.join("ledger.json");
    let target_notes = target_dir.join("important.txt");
    std::fs::write(&target_ledger, b"{\"keep\":true}\n").unwrap();
    std::fs::write(&target_notes, b"outside data\n").unwrap();

    if sb.layout.data_dir.exists() {
        std::fs::remove_dir_all(&sb.layout.data_dir).unwrap();
    }
    std::os::unix::fs::symlink(&target_dir, &sb.layout.data_dir).unwrap();

    let err = sb.installer().delete_everything().expect_err("symlinked data_dir must be refused");
    assert!(
        matches!(err, busyholm_installer::InstallError::Symlink { ref path } if path == &sb.layout.data_dir),
        "expected Symlink error for data_dir, got {err:?}"
    );
    assert!(
        std::fs::symlink_metadata(&sb.layout.data_dir).unwrap().file_type().is_symlink(),
        "symlink itself must not be removed when refused"
    );
    assert_eq!(std::fs::read(&target_ledger).unwrap(), b"{\"keep\":true}\n", "target ledger untouched");
    assert_eq!(std::fs::read(&target_notes).unwrap(), b"outside data\n", "target file untouched");
}

#[cfg(unix)]
#[test]
fn p2_3_symlink_inside_data_folder_is_removed_without_touching_its_target() {
    let sb = sandbox();
    let original = fixture("ok-indent2");
    sb.write_settings(&original);
    sb.install(&[Component::ClaudeHooks]);

    let outside_dir = sb.tmp.path().join("outside-keep");
    std::fs::create_dir_all(&outside_dir).unwrap();
    let outside_file = outside_dir.join("secret.json");
    let outside_log = outside_dir.join("app.log");
    std::fs::write(&outside_file, b"{\"secret\":1}\n").unwrap();
    std::fs::write(&outside_log, b"keep this log\n").unwrap();

    // Place known-name file symlinks (`ledger.json` and `logs/app.log`) inside `data_dir`.
    let link_file = sb.layout.data_dir.join("ledger.json");
    std::fs::create_dir_all(sb.layout.data_dir.join("logs")).unwrap();
    let link_log = sb.layout.data_dir.join("logs").join("app.log");
    std::os::unix::fs::symlink(&outside_file, &link_file).unwrap();
    std::os::unix::fs::symlink(&outside_log, &link_log).unwrap();

    let left = sb.installer().delete_everything().expect("delete_everything should succeed");
    assert!(left.is_empty(), "no foreign files should remain: {left:?}");
    assert_eq!(sb.read_settings(), original, "Claude settings restored");
    assert!(
        std::fs::symlink_metadata(&link_file).is_err(),
        "file symlink inside data_dir must be unlinked"
    );
    assert!(
        std::fs::symlink_metadata(&link_log).is_err(),
        "known log symlink inside logs/ must be unlinked"
    );
    assert!(!sb.layout.data_dir.exists(), "empty data_dir must be removed after unlinking symlinks");
    assert_eq!(std::fs::read(&outside_file).unwrap(), b"{\"secret\":1}\n", "symlink target file must be untouched");
    assert_eq!(std::fs::read(&outside_log).unwrap(), b"keep this log\n", "symlink target log file must be untouched");
}



#[cfg(unix)]
#[test]
fn delete_everything_refuses_a_linked_install_manifest_and_keeps_hooks_and_data() {
    let sb = sandbox();
    let original = fixture("ok-indent2");
    sb.write_settings(&original);
    sb.install(&[Component::ClaudeHooks]);
    let connected = sb.read_settings();
    assert_ne!(connected, original, "the hook was installed");

    // Swap the real manifest for a link to a copy outside the data folder.
    let manifest = sb.layout.manifest_path();
    let outside = sb.tmp.path().join("outside-manifest.json");
    std::fs::copy(&manifest, &outside).unwrap();
    let outside_bytes = std::fs::read(&outside).unwrap();
    std::fs::remove_file(&manifest).unwrap();
    std::os::unix::fs::symlink(&outside, &manifest).unwrap();

    let err = sb.installer().delete_everything().expect_err("a linked manifest must be refused");
    assert!(matches!(err, busyholm_installer::InstallError::Symlink { .. }), "got {err:?}");
    assert_eq!(sb.read_settings(), connected, "agent settings untouched");
    assert!(sb.layout.data_dir.join("bin").join("busyholm-hook").exists(), "the shim the hooks call is kept");
    assert_eq!(std::fs::read(&outside).unwrap(), outside_bytes, "link target untouched");
}

#[test]
fn p2_2_part1_delete_everything_refuses_before_touching_claude_when_codex_hooks_is_invalid_json() {
    let sb = sandbox();
    sb.write_settings(&fixture("ok-indent2"));
    std::fs::write(sb.layout.codex_hooks(), b"{}\n").unwrap();
    sb.install(&[Component::ClaudeHooks, Component::CodexHooks]);

    let claude_connected = sb.read_settings();
    let manifest_connected = std::fs::read(sb.layout.manifest_path()).unwrap();
    std::fs::write(sb.layout.codex_hooks(), b"{not valid json").unwrap();

    let err = sb.installer().delete_everything().expect_err("delete_everything must refuse when Codex hooks.json is invalid JSON");
    assert!(matches!(err, busyholm_installer::InstallError::Manifest { .. }), "got {err:?}");
    assert_eq!(
        sb.read_settings(),
        claude_connected,
        "Claude settings file must be byte for byte unchanged when another connected part cannot be removed"
    );
    assert_eq!(
        std::fs::read(sb.layout.manifest_path()).unwrap(),
        manifest_connected,
        "install-manifest.json must be byte for byte unchanged"
    );
    assert!(sb.layout.shim_path().exists(), "installed shim must remain untouched");
}

#[cfg(unix)]
#[test]
fn p2_2_part2_unremovable_emptied_data_folder_is_reported_not_an_error() {
    use std::os::unix::fs::PermissionsExt;
    let mut sb = sandbox();
    let ro_parent = sb.tmp.path().join("ro-parent");
    let data_dir = ro_parent.join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    sb.layout.data_dir = data_dir.clone();

    let original = fixture("ok-indent2");
    sb.write_settings(&original);
    sb.install(&[Component::ClaudeHooks]);
    std::fs::write(data_dir.join("ledger.json"), b"{\"turns\":2}\n").unwrap();

    // Make the parent directory read-only so files inside `data_dir` can be removed,
    // but `remove_dir(&data_dir)` itself fails with PermissionDenied.
    std::fs::set_permissions(&ro_parent, std::fs::Permissions::from_mode(0o555)).unwrap();
    let res = sb.installer().delete_everything();
    std::fs::set_permissions(&ro_parent, std::fs::Permissions::from_mode(0o755)).unwrap();

    let left = res.expect("failing remove_dir on emptied data_dir must not be an error");
    assert_eq!(sb.read_settings(), original, "Claude settings restored");
    assert!(!data_dir.join("ledger.json").exists(), "known files inside data_dir removed");
    assert!(!sb.layout.manifest_path().exists(), "manifest removed");
    assert!(!sb.layout.shim_path().exists(), "shim removed");
    assert_eq!(left, vec![data_dir], "unremovable emptied data_dir must be reported as left behind");
}

#[cfg(unix)]
#[test]
fn p1_1_part1_delete_everything_refuses_linked_bin_backups_or_logs_before_disconnect() {
    let sb = sandbox();
    let original = fixture("ok-indent2");
    sb.write_settings(&original);
    sb.install(&[Component::ClaudeHooks]);
    let connected = sb.read_settings();

    let outside_bin = sb.tmp.path().join("outside-bin");
    std::fs::create_dir_all(&outside_bin).unwrap();
    let outside_shim = outside_bin.join("busyholm-hook");
    let shim_bytes = std::fs::read(sb.layout.shim_path()).unwrap();
    std::fs::copy(sb.layout.shim_path(), &outside_shim).unwrap();

    let bin_dir = sb.layout.data_dir.join("bin");
    std::fs::remove_dir_all(&bin_dir).unwrap();
    std::os::unix::fs::symlink(&outside_bin, &bin_dir).unwrap();

    let err = sb.installer().delete_everything().expect_err("linked bin folder must be refused before disconnect");
    assert!(
        matches!(err, busyholm_installer::InstallError::Symlink { ref path } if path == &bin_dir),
        "expected Symlink error for bin_dir, got {err:?}"
    );
    assert!(outside_shim.exists(), "outside busyholm-hook file must be untouched");
    assert_eq!(std::fs::read(&outside_shim).unwrap(), shim_bytes, "outside busyholm-hook bytes untouched");
    assert_eq!(sb.read_settings(), connected, "agent settings must be unchanged");

    // Restore real bin/ and verify that linked backups/, backups/install, and logs/ are also refused before disconnect.
    std::fs::remove_file(&bin_dir).unwrap();
    std::fs::create_dir_all(&bin_dir).unwrap();
    std::fs::write(sb.layout.shim_path(), &shim_bytes).unwrap();

    for rel in ["backups", "backups/install", "logs"] {
        let p = sb.layout.data_dir.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        if p.exists() {
            std::fs::remove_dir_all(&p).unwrap();
        }
        std::os::unix::fs::symlink(&outside_bin, &p).unwrap();
        let err = sb.installer().delete_everything().expect_err("linked subfolder must be refused");
        assert!(
            matches!(err, busyholm_installer::InstallError::Symlink { ref path } if path == &p),
            "expected Symlink error for {rel}, got {err:?}"
        );
        assert_eq!(sb.read_settings(), connected, "agent settings unchanged when {rel} is a symlink");
        std::fs::remove_file(&p).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn p1_1_part2_and_3_foreign_symlinks_foreign_bak_and_foreign_logs_survive_and_are_reported() {
    let sb = sandbox();
    let original = fixture("ok-statusline-and-hooks");
    sb.write_settings(&original);
    sb.install(&[Component::ClaudeHooks, Component::ClaudeStatusline]);

    let outside_target = sb.tmp.path().join("outside-note.txt");
    std::fs::write(&outside_target, b"outside target\n").unwrap();

    // 1. Foreign symlinks in data_dir and logs/.
    let foreign_top_link = sb.layout.data_dir.join("user-shortcut");
    std::os::unix::fs::symlink(&outside_target, &foreign_top_link).unwrap();

    let logs_dir = sb.layout.data_dir.join("logs");
    std::fs::create_dir_all(&logs_dir).unwrap();
    let known_log = logs_dir.join("app.log");
    let foreign_log = logs_dir.join("other.log");
    let foreign_jsonl = logs_dir.join("events.jsonl");
    let foreign_sub_link = logs_dir.join("linked-note.log");
    std::fs::write(&known_log, b"busyholm app log\n").unwrap();
    std::fs::write(&foreign_log, b"foreign log\n").unwrap();
    std::fs::write(&foreign_jsonl, b"{\"foreign\":true}\n").unwrap();
    std::os::unix::fs::symlink(&outside_target, &foreign_sub_link).unwrap();

    // 2. Foreign .bak in backups/install/ alongside Busyholm's own 64-hex .bak files.
    let install_bdir = sb.layout.data_dir.join("backups").join("install");
    std::fs::create_dir_all(&install_bdir).unwrap();
    let foreign_bak = install_bdir.join("my-config.bak");
    let stale_own_bak = install_bdir.join(format!("{}.bak", "a".repeat(64)));
    std::fs::write(&foreign_bak, b"user backup\n").unwrap();
    std::fs::write(&stale_own_bak, b"{}\n").unwrap();

    let left = sb.installer().delete_everything().expect("delete_everything should succeed");
    assert_eq!(sb.read_settings(), original, "Claude settings restored");
    assert!(!known_log.exists(), "known logs/app.log must be removed");
    assert!(!stale_own_bak.exists(), "64-hex .bak install backup must be removed");

    assert!(
        std::fs::symlink_metadata(&foreign_top_link).unwrap().file_type().is_symlink(),
        "foreign top-level symlink must be kept"
    );
    assert!(
        std::fs::symlink_metadata(&foreign_sub_link).unwrap().file_type().is_symlink(),
        "foreign subdir symlink must be kept"
    );
    assert_eq!(std::fs::read(&outside_target).unwrap(), b"outside target\n", "symlink target untouched");
    assert_eq!(std::fs::read(&foreign_bak).unwrap(), b"user backup\n", "foreign .bak file must be kept");
    assert_eq!(std::fs::read(&foreign_log).unwrap(), b"foreign log\n", "foreign .log file must be kept");
    assert_eq!(std::fs::read(&foreign_jsonl).unwrap(), b"{\"foreign\":true}\n", "foreign .jsonl file must be kept");

    let mut expected = vec![
        foreign_bak,
        foreign_jsonl,
        foreign_sub_link,
        foreign_log,
        foreign_top_link,
    ];
    expected.sort();
    assert_eq!(left, expected, "all foreign symlinks, .bak, and log files must be reported");
}
