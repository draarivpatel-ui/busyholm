//! Claude process matcher and up/down tracker (executable paths only, never arguments).

use std::collections::{HashMap, HashSet};

use busyholm_contracts::agent_event::{EventKind, EventSource};
use busyholm_contracts::common::{Confidence, Host, InstanceId};

use crate::pending::Draft;
use crate::{Env, PendingEvent};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcInfo {
    pub pid: u32,
    /// Process start as `ps -o lstart` prints it; equals the registry `procStart`.
    pub start: String,
    /// Executable path (never the argument list).
    pub exe: String,
}

/// Is this executable a Claude Code session process? `Some(host)` if so.
///
/// Measured on macOS (research 4): the terminal binary lives under
/// `~/.local/share/claude/versions/`, the Desktop-hosted one under
/// `.../Application Support/Claude/claude-code/<version>/<hash>/claude.app/Contents/MacOS/claude`.
/// The `.exe` and Linux/Windows path shapes are derived, not measured.
pub fn match_claude_process(exe: &str) -> Option<Host> {
    let norm = exe.replace('\\', "/");
    let comps: Vec<&str> = norm.split('/').filter(|c| !c.is_empty()).collect();
    let name = *comps.last()?;
    let is_claude_name = name == "claude" || name.eq_ignore_ascii_case("claude.exe");

    if is_claude_name
        && comps.windows(2).any(|w| w[0].eq_ignore_ascii_case("claude") && w[1] == "claude-code")
    {
        return Some(Host::Desktop);
    }
    let n = comps.len();
    if n >= 4 && comps[n - 2] == "versions" && comps[n - 3] == "claude" && comps[n - 4] == "share" {
        return Some(Host::Cli);
    }
    if is_claude_name && n >= 3 && comps[n - 2] == "bin" && comps[n - 3] == ".local" {
        return Some(Host::Cli);
    }
    None
}

#[derive(Debug, Default)]
pub struct ProcessTracker {
    known: HashMap<(u32, String), InstanceId>,
}

impl ProcessTracker {
    pub fn new() -> ProcessTracker {
        ProcessTracker::default()
    }

    /// Diff a process snapshot. `resolve(pid, start)` returns the session instance when the
    /// registry knows that process; otherwise the event uses a process-only instance, which
    /// is retired (process_down) as soon as the registry claims the process.
    pub fn observe(
        &mut self,
        procs: &[ProcInfo],
        resolve: &dyn Fn(u32, &str) -> Option<InstanceId>,
        env: &Env,
    ) -> Vec<PendingEvent> {
        let mut events = Vec::new();
        let mut seen: HashSet<(u32, String)> = HashSet::new();
        let ev = |kind: EventKind, conf: Confidence, inst: &InstanceId, host: Host| {
            Draft::new(env, kind, EventSource::Process, conf, inst.clone(), host).done()
        };

        for p in procs {
            let Some(host) = match_claude_process(&p.exe) else { continue };
            let key = (p.pid, p.start.clone());
            seen.insert(key.clone());
            let resolved = resolve(p.pid, &p.start);
            match self.known.get(&key).cloned() {
                None => {
                    let inst = resolved.unwrap_or_else(|| env.scoped("proc", &format!("{}:{}", p.pid, p.start)));
                    events.push(ev(EventKind::ProcessUp, Confidence::Exact, &inst, host));
                    self.known.insert(key, inst);
                }
                Some(cur) => {
                    if let Some(r) = resolved {
                        if r != cur {
                            events.push(ev(EventKind::ProcessDown, Confidence::Inferred, &cur, host));
                            events.push(ev(EventKind::ProcessUp, Confidence::Exact, &r, host));
                            self.known.insert(key, r);
                        }
                    }
                }
            }
        }

        let mut vanished: Vec<(u32, String)> = self.known.keys().filter(|k| !seen.contains(*k)).cloned().collect();
        vanished.sort();
        for key in vanished {
            if let Some(inst) = self.known.remove(&key) {
                events.push(ev(EventKind::ProcessDown, Confidence::Exact, &inst, Host::Other));
            }
        }
        events
    }
}
