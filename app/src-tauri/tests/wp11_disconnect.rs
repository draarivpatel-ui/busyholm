//! WP-11 acceptance tests: the bridge from the app shell to the WP-07 installer (SPEC 9.1 WP-11 test 5:
//! "Disconnect all restores the agent config files byte for byte").
//!
//! Every path is inside a temp folder. The layout is built field by field and nothing here reads the real
//! environment, so the real ~/.claude, ~/.codex and ~/.config/opencode can never be touched.

use busyholm_app::connect::{Connector, Part, Status};
use busyholm_installer::fsio::sha256_hex;
use busyholm_installer::{Installer, Layout, Sources};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const ALL: [Part; 4] = [Part::ClaudeHooks, Part::ClaudeStatusline, Part::CodexHooks, Part::OpencodePlugin];
const SHIM_BYTES: &[u8] = b"#!/bin/sh\n# fixed stand-in for busyholm-hook (WP-11 tests)\nexit 0\n";
const CODEX_CONFIG: &[u8] = b"model = \"stand-in\"\n\n[projects]\n# synthetic config.toml: Busyholm must never touch it\n";
const HELPER_MISSING: &str = "The hook helper is missing from this build, so nothing was connected.";

fn plugin_source() -> String {
    include_str!("../../../collector-wp06/plugin/busyholm.js").to_string()
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

struct TempRoot(PathBuf);
impl TempRoot {
    fn new() -> TempRoot {
        static N: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("busyholm-wp11-{}-{nanos}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(&p).unwrap();
        TempRoot(p)
    }
}
impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Env {
    root: TempRoot,
    layout: Layout,
    home: PathBuf,
}

/// A fake home in a temp folder with the three agent folders present and empty.
fn env() -> Env {
    let root = TempRoot::new();
    let home = root.0.join("home");
    let layout = Layout {
        data_dir: home.join("Library").join("Application Support").join("Busyholm"), // has a space, like macOS
        claude_dir: home.join(".claude"),
        codex_dir: home.join(".codex"),
        opencode_dir: home.join(".config").join("opencode"),
    };
    for d in [&layout.claude_dir, &layout.codex_dir, &layout.opencode_dir] {
        std::fs::create_dir_all(d).unwrap();
    }
    Env { root, layout, home }
}

impl Env {
    fn shim_source(&self) -> PathBuf {
        let p = self.root.0.join("build").join("busyholm-hook");
        if !p.exists() {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, SHIM_BYTES).unwrap();
        }
        p
    }
    fn sources(&self) -> Sources {
        Sources { shim_binary: self.shim_source(), opencode_plugin: plugin_source() }
    }
    fn connector(&self) -> Connector {
        Connector::new(self.layout.clone(), Some(self.sources()), self.home.clone())
    }
    fn connector_without_helper(&self) -> Connector {
        Connector::new(self.layout.clone(), None, self.home.clone())
    }
    fn settings(&self) -> PathBuf {
        self.layout.claude_settings()
    }
    fn codex_hooks(&self) -> PathBuf {
        self.layout.codex_hooks()
    }
    fn manifest_entry_count(&self) -> usize {
        Installer::new(self.layout.clone()).load_manifest().unwrap().entries.len()
    }
    fn owner_tag(&self) -> String {
        Installer::new(self.layout.clone()).load_manifest().unwrap().owner_tag.expect("owner tag")
    }
    /// Every file under the three agent folders, relative path to sha256.
    fn snapshot(&self) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        for (label, dir) in [("claude", &self.layout.claude_dir), ("codex", &self.layout.codex_dir), ("opencode", &self.layout.opencode_dir)] {
            walk(dir, dir, label, &mut out);
        }
        out
    }
}

fn walk(base: &Path, dir: &Path, label: &str, out: &mut BTreeMap<String, String>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(base, &p, label, out);
        } else {
            let rel = p.strip_prefix(base).unwrap().to_string_lossy().to_string();
            out.insert(format!("{label}/{rel}"), sha256_hex(&std::fs::read(&p).unwrap()));
        }
    }
}

fn describe_diff(before: &BTreeMap<String, String>, after: &BTreeMap<String, String>) -> String {
    let mut lines = Vec::new();
    for (k, v) in before {
        match after.get(k) {
            None => lines.push(format!("  {k}: existed before, is gone now")),
            Some(a) if a != v => lines.push(format!("  {k}: bytes differ from the original")),
            _ => {}
        }
    }
    for k in after.keys().filter(|k| !before.contains_key(*k)) {
        lines.push(format!("  {k}: did not exist before, still there"));
    }
    lines.join("\n")
}

fn fixtures(kind: &str) -> Vec<(String, Vec<u8>)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../installer/tests/fixtures").join(kind);
    let mut out: Vec<(String, Vec<u8>)> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("fixtures folder {}: {e}", dir.display()))
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| (p.file_stem().unwrap().to_string_lossy().to_string(), std::fs::read(&p).unwrap()))
        // the same rule WP-07's own tests use: "ok-" fixtures are valid, "bad-" ones are refused
        .filter(|(n, _)| n.starts_with("ok-"))
        .collect();
    out.sort();
    out
}

fn fixture(kind: &str, name: &str) -> Vec<u8> {
    fixtures(kind).into_iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("fixture {kind}/{name}")).1
}

fn parse(bytes: &[u8]) -> Value {
    let b = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    serde_json::from_str(std::str::from_utf8(b).expect("utf-8")).unwrap_or_else(|e| panic!("not strict JSON: {e}"))
}

/// preview then apply, as the shell does it.
fn round(c: &mut Connector, parts: &[Part]) -> Result<Status, String> {
    let p = c.preview_connect(parts)?;
    c.apply(p.token)
}

fn part<'a>(s: &'a Status, p: Part) -> &'a busyholm_app::connect::PartStatus {
    s.parts.iter().find(|x| x.part == p).unwrap_or_else(|| panic!("no status row for {p:?}"))
}

fn connected(s: &Status) -> Vec<Part> {
    s.parts.iter().filter(|p| p.connected).map(|p| p.part).collect()
}

fn write_case(e: &Env, claude: Option<&[u8]>, codex: Option<&[u8]>) {
    if let Some(b) = claude {
        std::fs::write(e.settings(), b).unwrap();
    }
    if let Some(b) = codex {
        std::fs::write(e.codex_hooks(), b).unwrap();
    }
    std::fs::write(e.layout.codex_config(), CODEX_CONFIG).unwrap();
}

/// One full cycle: connect all four parts in one preview and apply, then disconnect_all.
fn all_in_one_cycle(claude: Option<&[u8]>, codex: Option<&[u8]>) -> Result<(), String> {
    let e = env();
    write_case(&e, claude, codex);
    let before = e.snapshot();
    let mut c = e.connector();

    let pv = c.preview_connect(&ALL)?;
    if pv.noop || pv.files.is_empty() {
        return Err("the connect preview was empty".into());
    }
    if e.snapshot() != before || e.layout.manifest_path().exists() || e.layout.shim_path().exists() {
        return Err("previewing wrote something".into());
    }
    let st = c.apply(pv.token)?;
    if connected(&st).len() != 4 {
        return Err(format!("after connect, connected parts were {:?}", connected(&st)));
    }
    if e.snapshot() == before {
        return Err("connect changed nothing".into());
    }
    if std::fs::read(e.layout.codex_config()).unwrap() != CODEX_CONFIG {
        return Err("codex config.toml changed during connect".into());
    }

    let st = c.disconnect_all()?;
    let after = e.snapshot();
    if after != before {
        return Err(format!("not restored byte for byte:\n{}", describe_diff(&before, &after)));
    }
    if std::fs::read(e.layout.codex_config()).unwrap() != CODEX_CONFIG {
        return Err("codex config.toml changed during disconnect".into());
    }
    if st.any_connected || !connected(&st).is_empty() {
        return Err(format!("still connected after disconnect_all: {:?}", connected(&st)));
    }
    if e.manifest_entry_count() != 0 {
        return Err("the install manifest still has entries".into());
    }
    if e.layout.shim_path().exists() {
        return Err("the hook helper was left in the data folder".into());
    }
    Ok(())
}

/// Three separate consents (hooks, then status line, then Codex), then disconnect_all.
fn staged_cycle(claude: Option<&[u8]>, codex: Option<&[u8]>) -> Result<(), String> {
    let e = env();
    write_case(&e, claude, codex);
    let before = e.snapshot();
    let mut c = e.connector();
    let st = round(&mut c, &[Part::ClaudeHooks])?;
    if connected(&st) != vec![Part::ClaudeHooks] {
        return Err(format!("after round 1, connected parts were {:?}", connected(&st)));
    }
    round(&mut c, &[Part::ClaudeStatusline])?;
    let st = round(&mut c, &[Part::CodexHooks])?;
    if connected(&st).len() != 3 {
        return Err(format!("after round 3, connected parts were {:?}", connected(&st)));
    }
    c.disconnect_all()?;
    let after = e.snapshot();
    if after != before {
        return Err(format!("not restored byte for byte:\n{}", describe_diff(&before, &after)));
    }
    if std::fs::read(e.layout.codex_config()).unwrap() != CODEX_CONFIG {
        return Err("codex config.toml changed".into());
    }
    if e.manifest_entry_count() != 0 {
        return Err("the install manifest still has entries".into());
    }
    Ok(())
}

fn run_matrix(f: fn(Option<&[u8]>, Option<&[u8]>) -> Result<(), String>) {
    let claude = fixtures("settings");
    let codex = fixtures("codex");
    assert!(claude.len() >= 30 && codex.len() >= 8, "fixture folders look wrong ({} claude, {} codex)", claude.len(), codex.len());
    let mut failures = Vec::new();
    let mut runs = 0;
    for (i, (name, bytes)) in claude.iter().enumerate() {
        // every Claude fixture with a Codex fixture (rotating), and with no Codex hooks file
        let (cname, cbytes) = &codex[i % codex.len()];
        runs += 2;
        if let Err(m) = f(Some(bytes), Some(cbytes)) {
            failures.push(format!("claude {name} + codex {cname}: {m}"));
        }
        if let Err(m) = f(Some(bytes), None) {
            failures.push(format!("claude {name} + no codex hooks file: {m}"));
        }
    }
    for (name, bytes) in &codex {
        // every Codex fixture with no Claude settings file at all
        runs += 1;
        if let Err(m) = f(None, Some(bytes)) {
            failures.push(format!("no claude settings file + codex {name}: {m}"));
        }
    }
    runs += 1;
    if let Err(m) = f(None, None) {
        failures.push(format!("neither file exists: {m}"));
    }
    assert!(failures.is_empty(), "{} of {runs} cycles failed:\n{}", failures.len(), failures.join("\n"));
}

// ---------------------------------------------------------------------------------------------
// (a) connect everything in one step, disconnect all: byte for byte
// ---------------------------------------------------------------------------------------------

#[test]
fn a_disconnect_all_restores_every_file_byte_for_byte_for_every_fixture() {
    run_matrix(all_in_one_cycle);
}

// ---------------------------------------------------------------------------------------------
// (b) staged consents (WP-07 known issue 3)
// ---------------------------------------------------------------------------------------------

#[test]
fn b_staged_connects_then_disconnect_all_restore_every_file_byte_for_byte() {
    run_matrix(staged_cycle);
}

// ---------------------------------------------------------------------------------------------
// (c) a file that changed between preview and apply
// ---------------------------------------------------------------------------------------------

#[test]
fn c_apply_after_the_target_changed_is_refused_and_the_third_partys_bytes_stay() {
    // an existing file edited by someone else
    let e = env();
    std::fs::write(e.settings(), fixture("settings", "ok-indent2")).unwrap();
    let mut c = e.connector();
    let pv = c.preview_connect(&[Part::ClaudeHooks]).unwrap();
    let theirs = b"{\n  \"edited_by\": \"a third party, after the preview\"\n}\n".to_vec();
    std::fs::write(e.settings(), &theirs).unwrap();
    let err = c.apply(pv.token).expect_err("apply must refuse a file that changed since the preview");
    assert!(err.contains("changed after the preview"), "a plain sentence was expected, got: {err}");
    assert!(err.contains("nothing was written"), "{err}");
    assert_eq!(std::fs::read(e.settings()).unwrap(), theirs, "the third party's bytes are untouched");
    assert!(!e.layout.shim_path().exists() && !e.layout.manifest_path().exists(), "nothing else was written either");
    // the token is consumed: a second try is refused too
    assert!(c.apply(pv.token).is_err());
    assert_eq!(std::fs::read(e.settings()).unwrap(), theirs);

    // a file that did not exist at preview time but was created by someone else
    let e = env();
    let mut c = e.connector();
    let pv = c.preview_connect(&[Part::ClaudeHooks, Part::CodexHooks]).unwrap();
    std::fs::write(e.codex_hooks(), b"{\"hooks\":{}}\n").unwrap();
    assert!(c.apply(pv.token).is_err());
    assert_eq!(std::fs::read(e.codex_hooks()).unwrap(), b"{\"hooks\":{}}\n");
    assert!(!e.settings().exists(), "the Claude file is not created either: all or nothing");
    assert!(!e.layout.shim_path().exists() && !e.layout.manifest_path().exists());
}

#[test]
fn c2_a_disconnect_preview_is_refused_when_the_file_changed_too() {
    let e = env();
    std::fs::write(e.settings(), fixture("settings", "ok-indent4")).unwrap();
    let mut c = e.connector();
    round(&mut c, &[Part::ClaudeHooks]).unwrap();
    let pv = c.preview_disconnect(&[Part::ClaudeHooks]).unwrap();
    let mut theirs = std::fs::read(e.settings()).unwrap();
    theirs.extend_from_slice(b"\n");
    std::fs::write(e.settings(), &theirs).unwrap();
    assert!(c.apply(pv.token).is_err());
    assert_eq!(std::fs::read(e.settings()).unwrap(), theirs);
}

// ---------------------------------------------------------------------------------------------
// (d) third-party hooks survive
// ---------------------------------------------------------------------------------------------

#[test]
fn d_a_third_party_hook_added_after_connect_survives_disconnect_all() {
    let e = env();
    std::fs::write(e.settings(), fixture("settings", "ok-indent2")).unwrap();
    let mut c = e.connector();
    round(&mut c, &ALL).unwrap();
    let tag = e.owner_tag();
    assert!(String::from_utf8_lossy(&std::fs::read(e.settings()).unwrap()).contains(&tag), "the owner tag is in the installed file");

    // a re-serialising tool appends its own hook to Stop in both files
    let third = json!({"hooks": [{"type": "command", "command": "/third/party-after.sh"}]});
    for path in [e.settings(), e.codex_hooks()] {
        let mut v = parse(&std::fs::read(&path).unwrap());
        v.pointer_mut("/hooks/Stop").and_then(Value::as_array_mut).expect("our Stop group is there").push(third.clone());
        std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    }

    let st = c.disconnect_all().unwrap();
    assert!(!st.any_connected);
    for path in [e.settings(), e.codex_hooks()] {
        let text = String::from_utf8(std::fs::read(&path).unwrap()).unwrap();
        assert!(!text.contains(&tag), "{}: an entry with the owner tag is left", path.display());
        assert!(!text.contains("busyholm-hook"), "{}: a Busyholm command is left", path.display());
        let v = parse(text.as_bytes());
        assert_eq!(v.pointer("/hooks/Stop"), Some(&json!([third.clone()])), "{}: the third party's hook is exactly as they left it", path.display());
    }
    // the rest of the Claude file is as the fixture had it
    let orig = parse(&fixture("settings", "ok-indent2"));
    let now = parse(&std::fs::read(e.settings()).unwrap());
    for (k, v) in orig.as_object().unwrap() {
        assert_eq!(now.get(k), Some(v), "key {k} of the original");
    }
    assert!(!e.layout.opencode_plugin().exists(), "our plugin is removed");
}

// ---------------------------------------------------------------------------------------------
// (e) stale and reused tokens
// ---------------------------------------------------------------------------------------------

#[test]
fn e_stale_unknown_and_reused_tokens_are_refused_and_write_nothing() {
    let e = env();
    std::fs::write(e.settings(), fixture("settings", "ok-indent2")).unwrap();
    let before = e.snapshot();
    let mut c = e.connector();

    // no preview yet
    assert!(c.apply(0).is_err());
    assert!(c.apply(1).is_err());

    // a newer preview replaces the older one: the older token is stale
    let a = c.preview_connect(&[Part::ClaudeHooks]).unwrap();
    let b = c.preview_connect(&[Part::ClaudeHooks, Part::OpencodePlugin]).unwrap();
    assert_ne!(a.token, b.token, "every preview gets a fresh token");
    let err = c.apply(a.token).expect_err("a stale token must be refused");
    assert!(!err.is_empty() && err.ends_with('.'), "a plain sentence, got {err:?}");
    assert_eq!(e.snapshot(), before, "nothing written by the stale token");
    assert!(!e.layout.manifest_path().exists() && !e.layout.shim_path().exists());
    // an unknown token does not use up the real one
    assert!(c.apply(b.token.wrapping_add(1000)).is_err());
    assert_eq!(e.snapshot(), before);

    // the current token works exactly once
    let st = c.apply(b.token).unwrap();
    assert_eq!(connected(&st), vec![Part::ClaudeHooks, Part::OpencodePlugin]);
    let done = e.snapshot();
    assert!(c.apply(b.token).is_err(), "a reused token is refused");
    assert_eq!(e.snapshot(), done, "and writes nothing");

    // a token from a disconnect preview is also single use
    let d = c.preview_disconnect(&[]).unwrap();
    c.apply(d.token).unwrap();
    assert_eq!(e.snapshot(), before);
    assert!(c.apply(d.token).is_err());
    assert_eq!(e.snapshot(), before);
}

// ---------------------------------------------------------------------------------------------
// (f) status
// ---------------------------------------------------------------------------------------------

#[test]
fn f_status_flags_before_and_after() {
    let e = env();
    let mut c = e.connector();

    let st = c.status().unwrap();
    assert_eq!(st.parts.iter().map(|p| p.part).collect::<Vec<_>>(), ALL.to_vec(), "all four parts, in a fixed order");
    assert!(!st.any_connected && connected(&st).is_empty());
    assert!(st.shim_available);
    for p in &st.parts {
        assert!(p.available, "{:?}: the tool's folder exists", p.part);
        assert!(!p.pending_review, "{:?}", p.part);
    }
    // display paths: only the home folder becomes "~"
    assert_eq!(part(&st, Part::ClaudeHooks).path, "~/.claude/settings.json");
    assert_eq!(part(&st, Part::ClaudeStatusline).path, "~/.claude/settings.json");
    assert_eq!(part(&st, Part::CodexHooks).path, "~/.codex/hooks.json");
    assert_eq!(part(&st, Part::OpencodePlugin).path, "~/.config/opencode/plugins/busyholm.js");
    let json = serde_json::to_string(&st).unwrap();
    assert!(json.contains("\"claude_hooks\"") && json.contains("\"pending_review\""), "snake_case on the wire: {json}");

    let st = round(&mut c, &[Part::ClaudeHooks, Part::CodexHooks]).unwrap();
    assert_eq!(connected(&st), vec![Part::ClaudeHooks, Part::CodexHooks]);
    assert!(st.any_connected);
    assert!(part(&st, Part::CodexHooks).pending_review, "Codex asks the user to trust the hooks");
    assert!(!part(&st, Part::ClaudeHooks).pending_review);
    assert!(!part(&st, Part::ClaudeStatusline).connected && !part(&st, Part::OpencodePlugin).connected);
    // status() on a fresh connector reads the same thing from disk
    assert_eq!(e.connector().status().unwrap(), st);

    let st = round(&mut c, &[Part::ClaudeStatusline, Part::OpencodePlugin]).unwrap();
    assert_eq!(connected(&st), ALL.to_vec());
    assert!(part(&st, Part::CodexHooks).pending_review);

    // one part at a time
    let pv = c.preview_disconnect(&[Part::CodexHooks]).unwrap();
    let st = c.apply(pv.token).unwrap();
    assert_eq!(connected(&st), vec![Part::ClaudeHooks, Part::ClaudeStatusline, Part::OpencodePlugin]);
    assert!(!part(&st, Part::CodexHooks).pending_review);

    let st = c.disconnect_all().unwrap();
    assert!(!st.any_connected && connected(&st).is_empty());
    assert!(st.parts.iter().all(|p| !p.pending_review));
}

#[test]
fn f2_a_missing_tool_folder_is_unavailable_and_refused_in_a_plain_sentence() {
    let e = env();
    std::fs::remove_dir_all(&e.layout.codex_dir).unwrap();
    let mut c = e.connector();
    let st = c.status().unwrap();
    assert!(!part(&st, Part::CodexHooks).available);
    assert!(part(&st, Part::ClaudeHooks).available && part(&st, Part::OpencodePlugin).available);
    let err = c.preview_connect(&[Part::ClaudeHooks, Part::CodexHooks]).expect_err("Codex is not installed here");
    assert!(err.contains("~/.codex"), "the message names the folder with ~: {err}");
    assert!(!err.contains(e.home.to_str().unwrap()), "the home path must not appear: {err}");
    assert!(!e.settings().exists() && !e.layout.manifest_path().exists(), "nothing was written");
}

// ---------------------------------------------------------------------------------------------
// preview contents, no helper, odds and ends
// ---------------------------------------------------------------------------------------------

#[test]
fn preview_describes_files_with_home_shown_as_tilde_and_writes_nothing() {
    let e = env();
    std::fs::write(e.settings(), fixture("settings", "ok-indent2")).unwrap();
    let before = e.snapshot();
    let mut c = e.connector();
    let pv = c.preview_connect(&ALL).unwrap();
    assert!(!pv.noop);
    assert_eq!(e.snapshot(), before);
    assert!(!e.layout.manifest_path().exists());

    let by = |suffix: &str| pv.files.iter().find(|f| f.path.ends_with(suffix)).unwrap_or_else(|| panic!("no preview for {suffix}: {:?}", pv.files.iter().map(|f| &f.path).collect::<Vec<_>>()));
    let settings = by("settings.json");
    assert_eq!(settings.path, "~/.claude/settings.json");
    assert!(!settings.creates && !settings.deletes);
    assert!(settings.diff.contains("busyholm-hook"), "the diff shows what will be added");
    assert!(settings.note.is_some());
    let codex = by("hooks.json");
    assert_eq!(codex.path, "~/.codex/hooks.json");
    assert!(codex.creates && !codex.deletes);
    let plugin = by("busyholm.js");
    assert!(plugin.creates);
    let shim = by("busyholm-hook");
    assert!(shim.creates && shim.path.starts_with("~/Library/Application Support/Busyholm"), "{}", shim.path);
    for f in &pv.files {
        assert!(f.path.starts_with("~/"), "{}", f.path);
    }
    let wire = serde_json::to_value(&pv).unwrap();
    assert!(wire["files"].is_array() && wire["noop"] == json!(false) && wire["token"].is_u64());

    // connect for real, then the disconnect preview shows deletions
    c.apply(pv.token).unwrap();
    let dv = c.preview_disconnect(&[]).unwrap();
    assert!(dv.files.iter().any(|f| f.deletes && f.path.ends_with("busyholm.js")));
    assert!(dv.files.iter().any(|f| f.deletes && f.path.ends_with("hooks.json")), "the Codex file Busyholm created goes again");
    assert!(dv.files.iter().any(|f| !f.deletes && f.path == "~/.claude/settings.json"));
    // connecting what is already connected is a no-op
    let again = c.preview_connect(&ALL).unwrap();
    assert!(again.noop && again.files.is_empty(), "{:?}", again.files);
}

#[test]
fn without_the_hook_helper_nothing_can_be_connected_but_disconnect_still_works() {
    let e = env();
    std::fs::write(e.settings(), fixture("settings", "ok-indent2")).unwrap();
    let before = e.snapshot();
    let mut none = e.connector_without_helper();
    let st = none.status().unwrap();
    assert!(!st.shim_available);
    let err = none.preview_connect(&[Part::ClaudeHooks]).expect_err("no helper");
    assert_eq!(err, HELPER_MISSING);
    assert_eq!(e.snapshot(), before);
    assert!(!e.layout.manifest_path().exists());

    // a helper path that does not exist is the same thing
    let missing = Sources { shim_binary: e.root.0.join("nope").join("busyholm-hook"), opencode_plugin: plugin_source() };
    let mut gone = Connector::new(e.layout.clone(), Some(missing), e.home.clone());
    assert!(!gone.status().unwrap().shim_available);
    assert_eq!(gone.preview_connect(&[Part::ClaudeHooks]).unwrap_err(), HELPER_MISSING);

    // an install made earlier can still be removed by a build without the helper
    let mut c = e.connector();
    round(&mut c, &[Part::ClaudeHooks]).unwrap();
    let mut none = e.connector_without_helper();
    assert!(none.status().unwrap().any_connected);
    none.disconnect_all().unwrap();
    assert_eq!(e.snapshot(), before);
}

#[test]
fn choosing_nothing_to_connect_is_refused_in_a_plain_sentence() {
    let e = env();
    let mut c = e.connector();
    let err = c.preview_connect(&[]).expect_err("an empty selection");
    assert!(err.ends_with('.') && err.len() > 10, "{err}");
}

#[test]
fn a_file_busyholm_did_not_write_in_the_plugin_slot_is_left_alone() {
    let e = env();
    let slot = e.layout.opencode_plugin();
    std::fs::create_dir_all(slot.parent().unwrap()).unwrap();
    std::fs::write(&slot, b"// somebody else's plugin\n").unwrap();
    let mut c = e.connector();
    let err = c.preview_connect(&[Part::OpencodePlugin]).expect_err("must not overwrite a foreign file");
    assert!(err.contains("~/.config/opencode"), "{err}");
    assert_eq!(std::fs::read(&slot).unwrap(), b"// somebody else's plugin\n");
}

// ---------------------------------------------------------------------------------------------
// FIX-C M6: the v0.1 slice does not offer OpenCode (the live router only registers Claude and Codex)
// ---------------------------------------------------------------------------------------------

#[test]
fn m6_shipping_connector_does_not_offer_opencode_and_refuses_to_install_it() {
    let e = env();
    let mut c = Connector::shipping(e.layout.clone(), Some(e.sources()), e.home.clone());
    let st = c.status().unwrap();
    let oc = part(&st, Part::OpencodePlugin);
    assert!(!oc.available, "the OpenCode folder exists, but the part must not be offered");
    assert!(oc.unavailable_reason.as_deref().is_some_and(|r| r.contains("OpenCode")), "{:?}", oc.unavailable_reason);
    assert!(part(&st, Part::ClaudeHooks).unavailable_reason.is_none());
    let before = e.snapshot();
    let err = c.preview_connect(&[Part::OpencodePlugin]).expect_err("install must be refused");
    assert!(err.contains("OpenCode"), "{err}");
    assert!(c.preview_connect(&[Part::ClaudeHooks, Part::OpencodePlugin]).is_err(), "no half-accepted plans");
    assert_eq!(e.snapshot(), before);
    // the other parts still work
    assert!(c.preview_connect(&[Part::ClaudeHooks]).is_ok());
}

#[test]
fn m6_an_already_installed_opencode_plugin_can_still_be_disconnected() {
    let e = env();
    let mut full = e.connector(); // the code path is kept: a connector with OpenCode enabled installs it
    round(&mut full, &[Part::OpencodePlugin]).unwrap();
    assert!(e.layout.opencode_plugin().exists());
    let mut c = Connector::shipping(e.layout.clone(), Some(e.sources()), e.home.clone());
    let st = c.status().unwrap();
    assert!(part(&st, Part::OpencodePlugin).connected);
    let pv = c.preview_disconnect(&[Part::OpencodePlugin]).unwrap();
    c.apply(pv.token).unwrap();
    assert!(!e.layout.opencode_plugin().exists());
}

#[test]
fn p1_1_connector_delete_everything_disconnects_hooks_and_removes_data_dir() {
    let e = env();
    write_case(&e, Some(&fixture("settings", "ok-indent2")), Some(&fixtures("codex")[0].1));
    let before = e.snapshot();
    let mut c = e.connector();
    round(&mut c, &[Part::ClaudeHooks, Part::ClaudeStatusline, Part::CodexHooks]).unwrap();

    // Populate ledger, backups, coverage, logs in data_dir.
    std::fs::write(e.layout.data_dir.join("ledger.json"), b"{\"turns\":5}\n").unwrap();
    std::fs::write(e.layout.data_dir.join("coverage.json"), b"{}\n").unwrap();
    let bdir = e.layout.data_dir.join("backups");
    std::fs::create_dir_all(&bdir).unwrap();
    std::fs::write(bdir.join("ledger-2026-10-17.json"), b"{}\n").unwrap();
    let ldir = e.layout.data_dir.join("logs");
    std::fs::create_dir_all(&ldir).unwrap();
    std::fs::write(ldir.join("app.log"), b"log\n").unwrap();

    let st = c.delete_everything().expect("delete_everything should succeed");
    assert!(!st.any_connected);
    assert_eq!(e.snapshot(), before, "agent config files restored byte for byte");
    assert!(!e.layout.data_dir.exists(), "app data folder removed");
}

#[test]
fn p2_8_refresh_shim_at_launch_replaces_stale_hook_binary_and_disconnect_still_cleans_up() {
    let e = env();
    write_case(&e, Some(&fixture("settings", "ok-indent2")), None);
    let before = e.snapshot();
    let mut c = e.connector();
    round(&mut c, &[Part::ClaudeHooks]).unwrap();

    // Same version at launch is a no-op.
    assert_eq!(c.refresh_shim().unwrap(), false);

    // Simulate an app upgrade where the bundled busyholm-hook binary has new bytes.
    let v2 = b"#!/bin/sh\n# busyholm-hook v2\nexit 0\n";
    std::fs::write(&e.sources().shim_binary, v2).unwrap();
    let mut c_launch = e.connector();
    assert_eq!(c_launch.refresh_shim().unwrap(), true, "must refresh installed shim when bundled version differs");
    assert_eq!(std::fs::read(e.layout.shim_path()).unwrap(), v2, "installed shim must be updated to v2");

    // And disconnecting later still removes the refreshed shim cleanly because the manifest entry was updated.
    let st = c_launch.disconnect_all().unwrap();
    assert!(!st.any_connected);
    assert!(!e.layout.shim_path().exists(), "refreshed shim must be removed on disconnect_all");
    assert_eq!(e.snapshot(), before, "settings restored byte for byte");
}

#[test]
fn p2_2_part1_delete_everything_refuses_before_touching_claude_when_codex_hooks_is_invalid_json() {
    let e = env();
    write_case(&e, Some(&fixture("settings", "ok-indent2")), Some(&fixtures("codex")[0].1));
    let mut c = e.connector();
    round(&mut c, &[Part::ClaudeHooks, Part::CodexHooks]).unwrap();

    let claude_connected = std::fs::read(e.settings()).unwrap();
    let manifest_connected = std::fs::read(e.layout.manifest_path()).unwrap();
    std::fs::write(e.codex_hooks(), b"{not valid json").unwrap();

    let err = c.delete_everything().expect_err("delete_everything must refuse when Codex hooks.json is invalid JSON");
    assert!(err.contains("not valid JSON"), "unexpected error: {err}");
    assert_eq!(
        std::fs::read(e.settings()).unwrap(),
        claude_connected,
        "Claude settings file must be byte for byte unchanged when another connected part cannot be removed"
    );
    assert_eq!(
        std::fs::read(e.layout.manifest_path()).unwrap(),
        manifest_connected,
        "install-manifest.json must be byte for byte unchanged"
    );
    assert!(e.layout.shim_path().exists(), "installed shim must remain untouched");
}


