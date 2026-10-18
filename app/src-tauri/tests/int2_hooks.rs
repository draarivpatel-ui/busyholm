//! INT-2 acceptance: the app tells the collector which tools have our hook entries installed
//! (`hooks(tool, Installed | PendingReview | Missing)`, collector/DECISIONS.md "INT-1"), at start and after
//! every applied plan, so coverage can reflect a disconnect.
//!
//! Temp folders only: the layout is built field by field and nothing here reads the real environment.

use busyholm_app::connect::{Connector, Part};
use busyholm_app::hooks_link::{reports_from_status, HooksLink};
use busyholm_contracts::common::Tool;
use busyholm_contracts::snapshot::HooksStatus as H;
use busyholm_installer::{Layout, Sources};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

const SHIM_BYTES: &[u8] = b"#!/bin/sh\n# fixed stand-in for busyholm-hook (INT-2 tests)\nexit 0\n";

struct Env {
    root: PathBuf,
    layout: Layout,
    home: PathBuf,
}
impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn env() -> Env {
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("busyholm-int2-{}-{nanos}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
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
    std::fs::create_dir_all(root.join("build")).unwrap();
    std::fs::write(root.join("build").join("busyholm-hook"), SHIM_BYTES).unwrap();
    Env { root, layout, home }
}

impl Env {
    fn connector(&self, link: &HooksLink) -> Connector {
        let sources = Sources {
            shim_binary: self.root.join("build").join("busyholm-hook"),
            opencode_plugin: include_str!("../../../collector-wp06/plugin/busyholm.js").to_string(),
        };
        Connector::new(self.layout.clone(), Some(sources), self.home.clone()).with_hooks(link.clone())
    }
}

type Log = Arc<Mutex<Vec<(Tool, H)>>>;

/// A link with a recording collector attached.
fn recording_link() -> (HooksLink, Log) {
    let link = HooksLink::new();
    let log: Log = Arc::default();
    let l = log.clone();
    link.attach(Box::new(move |t, s| {
        l.lock().unwrap().push((t, s));
        true
    }));
    (link, log)
}

/// The newest status told for each tool.
fn told(log: &Log, tool: Tool) -> Option<H> {
    log.lock().unwrap().iter().rev().find(|(t, _)| *t == tool).map(|(_, s)| *s)
}

fn connect(c: &mut Connector, parts: &[Part]) {
    let pv = c.preview_connect(parts).unwrap();
    c.apply(pv.token).unwrap();
}

#[test]
fn start_with_nothing_installed_tells_missing_for_every_tool() {
    let e = env();
    let (link, log) = recording_link();
    e.connector(&link).report_hooks();
    for t in [Tool::Claude, Tool::Codex, Tool::Opencode] {
        assert_eq!(told(&log, t), Some(H::Missing), "{t:?}");
    }
}

#[test]
fn connecting_tells_installed_and_codex_pending_review() {
    let e = env();
    let (link, log) = recording_link();
    let mut c = e.connector(&link);
    c.report_hooks();
    connect(&mut c, &[Part::ClaudeHooks, Part::CodexHooks]);
    assert_eq!(told(&log, Tool::Claude), Some(H::Installed));
    assert_eq!(told(&log, Tool::Codex), Some(H::PendingReview), "Codex needs the /hooks review before its hooks run");
    assert_eq!(told(&log, Tool::Opencode), Some(H::Missing));
}

#[test]
fn the_opencode_plugin_counts_as_opencode_hooks() {
    let e = env();
    let (link, log) = recording_link();
    let mut c = e.connector(&link);
    connect(&mut c, &[Part::OpencodePlugin]);
    assert_eq!(told(&log, Tool::Opencode), Some(H::Installed));
    assert_eq!(told(&log, Tool::Claude), Some(H::Missing));
}

#[test]
fn the_statusline_alone_is_not_hooks() {
    let e = env();
    let (link, log) = recording_link();
    let mut c = e.connector(&link);
    connect(&mut c, &[Part::ClaudeStatusline]);
    assert_eq!(told(&log, Tool::Claude), Some(H::Missing), "the statusline wrap proves nothing about the alert hooks");
    connect(&mut c, &[Part::ClaudeHooks]);
    assert_eq!(told(&log, Tool::Claude), Some(H::Installed));
}

#[test]
fn disconnecting_one_part_tells_missing_for_that_tool_only() {
    let e = env();
    let (link, log) = recording_link();
    let mut c = e.connector(&link);
    connect(&mut c, &[Part::ClaudeHooks, Part::CodexHooks]);
    let pv = c.preview_disconnect(&[Part::ClaudeHooks]).unwrap();
    c.apply(pv.token).unwrap();
    assert_eq!(told(&log, Tool::Claude), Some(H::Missing));
    assert_eq!(told(&log, Tool::Codex), Some(H::PendingReview));
}

#[test]
fn disconnect_all_tells_missing_for_every_tool() {
    let e = env();
    let (link, log) = recording_link();
    let mut c = e.connector(&link);
    connect(&mut c, &[Part::ClaudeHooks, Part::CodexHooks, Part::OpencodePlugin]);
    assert_eq!(told(&log, Tool::Opencode), Some(H::Installed));
    c.disconnect_all().unwrap();
    for t in [Tool::Claude, Tool::Codex, Tool::Opencode] {
        assert_eq!(told(&log, t), Some(H::Missing), "{t:?}");
    }
}

#[test]
fn a_preview_or_a_stale_token_tells_nothing() {
    let e = env();
    let (link, log) = recording_link();
    let mut c = e.connector(&link);
    let pv = c.preview_connect(&[Part::ClaudeHooks]).unwrap();
    assert!(log.lock().unwrap().is_empty(), "a preview writes nothing, so it reports nothing");
    assert!(c.apply(pv.token + 1).is_err());
    assert!(log.lock().unwrap().is_empty(), "a refused apply reports nothing");
    assert!(link.latest().is_empty());
}

#[test]
fn an_unreadable_manifest_tells_nothing() {
    let e = env();
    std::fs::create_dir_all(&e.layout.data_dir).unwrap();
    std::fs::write(e.layout.data_dir.join("install-manifest.json"), b"{ not json").unwrap();
    let (link, log) = recording_link();
    let c = e.connector(&link);
    assert!(c.status().is_err(), "the fixture must make the manifest unreadable");
    c.report_hooks();
    assert!(log.lock().unwrap().is_empty(), "no guess when the manifest cannot be read");
}

#[test]
fn a_collector_that_attaches_late_gets_the_newest_reports() {
    let e = env();
    let link = HooksLink::new();
    let mut c = e.connector(&link);
    c.report_hooks();
    connect(&mut c, &[Part::ClaudeHooks]);
    let log: Log = Arc::default();
    let l = log.clone();
    link.attach(Box::new(move |t, s| {
        l.lock().unwrap().push((t, s));
        true
    }));
    assert_eq!(told(&log, Tool::Claude), Some(H::Installed), "replayed on attach");
    assert_eq!(told(&log, Tool::Codex), Some(H::Missing));
    // a restarted collector attaches a new sink: it gets the same newest reports again
    link.detach();
    let log2: Log = Arc::default();
    let l2 = log2.clone();
    link.attach(Box::new(move |t, s| {
        l2.lock().unwrap().push((t, s));
        true
    }));
    assert_eq!(told(&log2, Tool::Claude), Some(H::Installed));
}

#[test]
fn a_sink_that_reports_closed_is_dropped() {
    let link = HooksLink::new();
    let calls = Arc::new(Mutex::new(0u32));
    let c = calls.clone();
    link.attach(Box::new(move |_, _| {
        *c.lock().unwrap() += 1;
        false
    }));
    link.report(vec![(Tool::Claude, H::Installed), (Tool::Codex, H::Missing)]);
    link.report(vec![(Tool::Claude, H::Missing)]);
    assert_eq!(*calls.lock().unwrap(), 1, "after the first false the sink is detached, nothing else is sent to it");
    assert_eq!(link.latest(), vec![(Tool::Claude, H::Missing)]);
}

#[test]
fn reports_cover_exactly_claude_codex_and_opencode() {
    let e = env();
    let (link, _log) = recording_link();
    let c = e.connector(&link);
    let r = reports_from_status(&c.status().unwrap());
    let tools: Vec<Tool> = r.iter().map(|x| x.0).collect();
    assert_eq!(tools, vec![Tool::Claude, Tool::Codex, Tool::Opencode]);
}
