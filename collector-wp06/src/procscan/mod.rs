//! Cross-platform process scanner: executable names, executable paths and start times only.
//!
//! The scanner never asks the OS for another process's argument list, because that is where
//! prompts and secrets live: macOS uses libproc (`proc_pidpath`, and the BSD info record for
//! the start time), Linux reads `/proc/<pid>/stat` and the `exe` link, Windows takes a
//! toolhelp snapshot and asks each process for its image path and creation time. A process
//! is identified by (pid, start time), so a reused pid is a new process. `tests/static_checks.rs`
//! fails the build if any source here names an argument-list API.
use std::collections::{BTreeMap, HashMap};

use busyholm_contracts::{
    agent_event::{EventKind, EventSource},
    common::{Confidence, Host, Tool},
    AgentEvent,
};
use collector::{Adapter, AdapterContext, AdapterError};

use crate::build::{valid_ms, Builder};
use crate::ident::{process_raw, Identity};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod windows;

/// One running process as the scanner sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcInfo {
    pub pid: u32,
    /// Process start, ms since the Unix epoch.
    pub start_ms: u64,
    /// Lowercase executable name without a trailing `.exe`.
    pub name: String,
    /// Executable path when the OS lets us see it.
    pub path: Option<String>,
}

/// What an agent process is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Match {
    pub tool: Tool,
    pub host: Host,
}

/// Lowercase and drop a trailing `.exe`.
pub fn normalize_name(raw: &str) -> String {
    let lower = raw.to_lowercase();
    lower.strip_suffix(".exe").map(str::to_string).unwrap_or(lower)
}

/// Baseline matching rules from the data-layer research (section 4). Claude and Codex have
/// their own, richer matchers in WP-04 and WP-05; these are enough to tell the real agent
/// process from its helpers, by name and path alone.
pub fn classify(p: &ProcInfo) -> Option<Match> {
    let path = p.path.as_deref().map(|s| s.replace('\\', "/").to_lowercase());
    let in_path = |needle: &str| path.as_deref().map_or(false, |s| s.contains(needle));
    let (tool, host) = match p.name.as_str() {
        "opencode" => (Tool::Opencode, Host::Cli),
        "agy" => (Tool::Antigravity, Host::Cli),
        "claude" => {
            if in_path("/claude-code/") && in_path(".app/contents/macos/claude") {
                (Tool::Claude, Host::Desktop)
            } else if in_path(".app/contents/") || in_path("/anthropicclaude/") {
                return None; // the Electron app itself and its helpers
            } else {
                (Tool::Claude, Host::Cli)
            }
        }
        "codex" => (Tool::Codex, if in_path("chatgpt.app/") { Host::Desktop } else { Host::Cli }),
        _ => return None,
    };
    Some(Match { tool, host })
}

/// (comm, start time in clock ticks since boot) from the text of `/proc/<pid>/stat`.
/// The command name sits in parentheses and may itself contain spaces and parentheses, so
/// everything is located relative to the LAST closing parenthesis.
pub fn parse_proc_stat(text: &str) -> Option<(String, u64)> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    if close < open {
        return None;
    }
    let comm = text[open + 1..close].to_string();
    // fields after the name start at field 3 (state); starttime is field 22
    let starttime = text[close + 1..].split_whitespace().nth(19)?.parse().ok()?;
    Some((comm, starttime))
}

/// Windows FILETIME (100 ns ticks since 1601-01-01) to ms since the Unix epoch.
pub fn filetime_to_unix_ms(ticks: u64) -> u64 {
    (ticks / 10_000).saturating_sub(11_644_473_600_000)
}

pub trait ProcessSource: Send {
    fn snapshot(&mut self) -> Result<Vec<ProcInfo>, AdapterError>;
}

/// The real source for this OS.
pub fn system_source() -> Box<dyn ProcessSource> {
    #[cfg(target_os = "macos")]
    return Box::new(mac::MacSource::default());
    #[cfg(target_os = "linux")]
    return Box::new(linux::LinuxSource::default());
    #[cfg(windows)]
    return Box::new(windows::WindowsSource::default());
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    return Box::new(UnsupportedSource);
}

#[allow(dead_code)]
struct UnsupportedSource;
impl ProcessSource for UnsupportedSource {
    fn snapshot(&mut self) -> Result<Vec<ProcInfo>, AdapterError> {
        Err(AdapterError::Unsupported)
    }
}

/// Diffs consecutive snapshots into `process_up` and `process_down` events.
#[derive(Default)]
pub struct ProcessTracker {
    live: HashMap<(u32, u64), Match>,
    roots: HashMap<Tool, String>,
}

impl ProcessTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Connector key for a tool's events (its data root, so presence and session events of one
    /// agent share a `root_id`). Without one the key is `process-scan:<tool>`.
    pub fn set_root(&mut self, tool: Tool, root: String) {
        self.roots.insert(tool, root);
    }

    pub fn scan(&mut self, procs: &[ProcInfo], ids: &dyn Identity, now_ms: u64) -> Vec<AgentEvent> {
        let mut current: BTreeMap<(u64, u32), Match> = BTreeMap::new();
        for p in procs {
            if let Some(m) = classify(p) {
                current.insert((p.start_ms, p.pid), m);
            }
        }
        let mut out = Vec::new();
        let make = |kind: EventKind, pid: u32, start: u64, m: Match, roots: &HashMap<Tool, String>| {
            let root = roots.get(&m.tool).cloned().unwrap_or_else(|| format!("process-scan:{:?}", m.tool));
            let b = Builder { ids, tool: m.tool, root_raw: &root, host: m.host, now_ms };
            let mut e = b.event(kind, EventSource::Process, Confidence::Exact, &process_raw(pid, start), None, false);
            if kind == EventKind::ProcessUp {
                e.et = valid_ms(start);
            }
            e
        };
        for (&(start, pid), &m) in &current {
            if !self.live.contains_key(&(pid, start)) {
                out.push(make(EventKind::ProcessUp, pid, start, m, &self.roots));
            }
        }
        let mut gone: Vec<((u32, u64), Match)> = self
            .live
            .iter()
            .filter(|((pid, start), _)| !current.contains_key(&(*start, *pid)))
            .map(|(k, m)| (*k, *m))
            .collect();
        gone.sort_by_key(|((pid, start), _)| (*start, *pid));
        for ((pid, start), m) in gone {
            out.push(make(EventKind::ProcessDown, pid, start, m, &self.roots));
        }
        self.live = current.into_iter().map(|((start, pid), m)| ((pid, start), m)).collect();
        out
    }

    /// Live processes (pid, start ms) of one tool, oldest first, for the agy reader's log binding.
    pub fn live(&self, tool: Tool) -> Vec<(u32, u64)> {
        let mut v: Vec<(u32, u64)> = self.live.iter().filter(|(_, m)| m.tool == tool).map(|(k, _)| *k).collect();
        v.sort_by_key(|&(pid, start)| (start, pid));
        v
    }
}

pub struct ProcessScanner {
    source: Box<dyn ProcessSource>,
    tracker: ProcessTracker,
    last_scan: Option<u64>,
}

impl ProcessScanner {
    pub const INTERVAL_MS: u64 = 5_000;

    pub fn new(source: Box<dyn ProcessSource>) -> Self {
        Self { source, tracker: ProcessTracker::new(), last_scan: None }
    }

    pub fn set_root(&mut self, tool: Tool, root: String) {
        self.tracker.set_root(tool, root);
    }

    /// One scan now. A failed snapshot leaves everything as it was: nothing is reported gone.
    pub fn scan_at(&mut self, ids: &dyn Identity, now_ms: u64) -> Result<Vec<AgentEvent>, AdapterError> {
        self.last_scan = Some(now_ms);
        let procs = self.source.snapshot()?;
        Ok(self.tracker.scan(&procs, ids, now_ms))
    }

    pub fn live(&self, tool: Tool) -> Vec<(u32, u64)> {
        self.tracker.live(tool)
    }

    /// `scan_at` at most once per [`Self::INTERVAL_MS`].
    pub fn poll_at(&mut self, ids: &dyn Identity, now_ms: u64) -> Result<Vec<AgentEvent>, AdapterError> {
        if let Some(last) = self.last_scan {
            if now_ms >= last && now_ms - last < Self::INTERVAL_MS {
                return Ok(Vec::new());
            }
        }
        self.scan_at(ids, now_ms)
    }

    /// Blocking loop for a dedicated thread: polls until `stop` is set, sleeping in short steps
    /// so a stop is noticed within 100 ms.
    pub fn run_loop(&mut self, ids: &dyn Identity, clock: &dyn Fn() -> u64, stop: &std::sync::atomic::AtomicBool, sink: &mut dyn FnMut(AgentEvent)) {
        use std::sync::atomic::Ordering;
        while !stop.load(Ordering::SeqCst) {
            if let Ok(events) = self.poll_at(ids, clock()) {
                for e in events {
                    sink(e);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
}

impl Adapter for ProcessScanner {
    fn tool(&self) -> Tool {
        // Events carry their own tool; this adapter spans several.
        Tool::Other
    }
    fn rebuild(&mut self, ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        self.scan_at(ctx, ctx.now_ms())
    }
    fn poll(&mut self, ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        self.poll_at(ctx, ctx.now_ms())
    }
}
