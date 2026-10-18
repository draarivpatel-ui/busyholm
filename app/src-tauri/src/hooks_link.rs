//! INT-2: tells the collector whether our hook entries are installed (`hooks(tool, Installed | PendingReview |
//! Missing)`, collector/DECISIONS.md "INT-1"), so coverage can reflect a disconnect.
//!
//! The install manifest is the source of truth (never the agents' files). [`reports_from_status`] turns what the
//! manifest says into one report per tool. [`HooksLink`] carries the newest reports to whichever collector is
//! running: the collector service is started (and restarted after a crash) on a hub thread with a fresh event bus
//! each time, so the link remembers the latest reports and replays them whenever a bus attaches. Without the
//! `collector` feature nothing attaches and the link only remembers.
use crate::connect::{Part, Status};
use busyholm_contracts::common::Tool;
use busyholm_contracts::snapshot::HooksStatus;
use std::sync::{Arc, Mutex};

/// One tool and what the installer says about its hooks.
pub type Report = (Tool, HooksStatus);

/// Delivers one report to the running collector. Returns false once that collector is gone (detach it).
pub type Sink = Box<dyn FnMut(Tool, HooksStatus) -> bool + Send>;

#[derive(Default)]
struct Inner {
    latest: Vec<Report>,
    sink: Option<Sink>,
}

#[derive(Clone, Default)]
pub struct HooksLink(Arc<Mutex<Inner>>);

impl HooksLink {
    pub fn new() -> Self {
        Self::default()
    }

    /// Remember `reports` as the newest and pass them to the attached collector, if any.
    pub fn report(&self, reports: Vec<Report>) {
        let mut g = self.0.lock().unwrap();
        g.latest = reports;
        let Inner { latest, sink } = &mut *g;
        send_all(latest, sink);
    }

    /// Attach a collector: it gets the newest reports at once, then every later one.
    pub fn attach(&self, sink: Sink) {
        let mut g = self.0.lock().unwrap();
        g.sink = Some(sink);
        let Inner { latest, sink } = &mut *g;
        send_all(latest, sink);
    }

    /// The collector is gone; reports are only remembered until the next `attach`.
    pub fn detach(&self) {
        self.0.lock().unwrap().sink = None;
    }

    /// The newest reports (empty before the first `report`).
    pub fn latest(&self) -> Vec<Report> {
        self.0.lock().unwrap().latest.clone()
    }
}

/// Send every report; a sink that says its collector is gone is dropped.
fn send_all(reports: &[Report], sink: &mut Option<Sink>) {
    let Some(f) = sink.as_mut() else { return };
    for &(tool, status) in reports {
        if !f(tool, status) {
            *sink = None;
            return;
        }
    }
}

/// What the manifest says, as one report per tool that has an installable part, always in the order Claude,
/// Codex, OpenCode. A tool whose part is not connected is `Missing`, which also ends a verification at once
/// (collector/DECISIONS.md "INT-1"). Codex hooks stay `PendingReview` (as the manifest records them) until
/// Codex trusts them. The Claude statusline is not hooks: wrapping it proves nothing about the alert hooks.
pub fn reports_from_status(status: &Status) -> Vec<Report> {
    let state = |part: Part| match status.parts.iter().find(|p| p.part == part) {
        Some(p) if p.connected && p.pending_review => HooksStatus::PendingReview,
        Some(p) if p.connected => HooksStatus::Installed,
        _ => HooksStatus::Missing,
    };
    vec![
        (Tool::Claude, state(Part::ClaudeHooks)),
        (Tool::Codex, state(Part::CodexHooks)),
        (Tool::Opencode, state(Part::OpencodePlugin)),
    ]
}
