//! `~/.claude/sessions/<pid>.json` parsing and diffing.
//!
//! Only the allowlisted fields below are read. `name`, `cwd`, `messagingSocketPath`,
//! `ownerOrganizationUuid` and everything else is ignored by the parser, and the owner
//! account id is hashed before it leaves this module.

use std::collections::{HashMap, HashSet};

use busyholm_contracts::agent_event::{EndReason, EventKind, EventSource};
use busyholm_contracts::common::{Confidence, Host, InstanceId};
use serde::Deserialize;

use crate::env::host_from_entrypoint;
use crate::pending::Draft;
use crate::{Env, MapError, PendingEvent};

/// `<digits>.json` exactly. The `<pid>.<hash>.key` sibling and everything else is `None`.
pub fn registry_file_pid(name: &str) -> Option<u32> {
    let digits = name.strip_suffix(".json")?;
    if digits.is_empty() || digits.len() > 10 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok().filter(|p| *p > 0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitKind {
    Permission,
    Question,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegStatus {
    Busy,
    Idle,
    Waiting(Option<WaitKind>),
    Starting,
    Other,
}

/// Allowlisted registry fields. Ids are raw in memory only; Debug redacts them.
#[derive(Clone)]
pub struct RegistryEntry {
    pub pid: u32,
    pub session_id: String,
    pub started_at: Option<u64>,
    pub proc_start: String,
    pub kind: String,
    pub host: Host,
    pub status: RegStatus,
    pub status_updated_at: Option<u64>,
    pub owner_account: Option<String>,
}

impl std::fmt::Debug for RegistryEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RegistryEntry").field("pid", &self.pid).field("status", &self.status).finish()
    }
}

#[derive(Deserialize)]
struct Raw {
    pid: Option<u64>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "startedAt")]
    started_at: Option<f64>,
    #[serde(rename = "procStart")]
    proc_start: Option<String>,
    kind: Option<String>,
    entrypoint: Option<String>,
    status: Option<String>,
    #[serde(rename = "statusUpdatedAt")]
    status_updated_at: Option<f64>,
    #[serde(rename = "waitingFor")]
    waiting_for: Option<String>,
    #[serde(rename = "ownerAccountUuid")]
    owner_account: Option<String>,
}

fn ms(v: Option<f64>) -> Option<u64> {
    v.filter(|v| v.is_finite() && *v >= 0.0).map(|v| v as u64)
}

pub fn parse_registry_entry(bytes: &[u8]) -> Result<RegistryEntry, MapError> {
    let raw: Raw = serde_json::from_slice(bytes).map_err(|_| MapError::NotJson)?;
    let pid = raw.pid.and_then(|p| u32::try_from(p).ok()).filter(|p| *p > 0).ok_or(MapError::MissingField)?;
    let session_id = raw.session_id.filter(|s| !s.is_empty() && s.len() <= 256).ok_or(MapError::MissingField)?;
    let status = match raw.status.as_deref() {
        Some("busy") | Some("working") | Some("running") => RegStatus::Busy,
        Some("idle") | Some("done") => RegStatus::Idle,
        Some("waiting") | Some("blocked") => RegStatus::Waiting(match raw.waiting_for.as_deref() {
            Some("permission") => Some(WaitKind::Permission),
            Some("question") | Some("input") | Some("answer") | Some("elicitation") => Some(WaitKind::Question),
            _ => None,
        }),
        Some("starting") | Some("resuming") | Some("adopted") => RegStatus::Starting,
        _ => RegStatus::Other,
    };
    Ok(RegistryEntry {
        pid,
        session_id,
        started_at: ms(raw.started_at),
        proc_start: raw.proc_start.unwrap_or_default(),
        kind: raw.kind.unwrap_or_default(),
        host: raw.entrypoint.as_deref().map(host_from_entrypoint).unwrap_or(Host::Other),
        status,
        status_updated_at: ms(raw.status_updated_at),
        owner_account: raw.owner_account.filter(|a| !a.is_empty()),
    })
}

#[derive(Debug, Default)]
pub struct RegistryOutput {
    pub events: Vec<PendingEvent>,
    /// Instances whose status left busy (or waiting) this scan.
    pub left_busy: Vec<InstanceId>,
    /// (instance, host, salted account id) learned this scan.
    pub learned: Vec<(InstanceId, Host, Option<String>)>,
}

struct Tracked {
    proc_start: String,
    instance: InstanceId,
    host: Host,
    account: Option<String>,
    status: RegStatus,
    ended: bool,
}

#[derive(Default)]
pub struct RegistryTracker {
    tracked: HashMap<u32, Tracked>,
}

impl std::fmt::Debug for RegistryTracker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RegistryTracker").field("tracked", &self.tracked.len()).finish()
    }
}

/// `daemon` and `daemon-worker` are infrastructure, not sessions.
fn is_session_kind(kind: &str) -> bool {
    !matches!(kind, "daemon" | "daemon-worker")
}

impl RegistryTracker {
    pub fn new() -> RegistryTracker {
        RegistryTracker::default()
    }

    /// The instance for a running process, if the registry knows it (pid plus start time).
    pub fn instance_for(&self, pid: u32, proc_start: &str) -> Option<InstanceId> {
        self.tracked.get(&pid).filter(|t| !t.ended && t.proc_start == proc_start).map(|t| t.instance.clone())
    }

    /// The start string the registry holds for a running (not ended) tracked pid.
    pub fn proc_start_of(&self, pid: u32) -> Option<&str> {
        self.tracked.get(&pid).filter(|t| !t.ended).map(|t| t.proc_start.as_str())
    }

    fn end(&self, env: &Env, t: &Tracked, reason: EndReason) -> PendingEvent {
        Draft::new(env, EventKind::SessionEnd, EventSource::Registry, Confidence::Exact, t.instance.clone(), t.host)
            .account(t.account.clone())
            .detail(|d| d.end_reason = Some(reason))
            .done()
    }

    /// `entries` is the full current set. `alive(pid, proc_start)` says whether the process still runs.
    pub fn observe(
        &mut self,
        entries: &[RegistryEntry],
        alive: &dyn Fn(u32, &str) -> bool,
        env: &Env,
    ) -> RegistryOutput {
        let mut out = RegistryOutput::default();
        let mut present: HashSet<u32> = HashSet::new();

        for e in entries.iter().filter(|e| is_session_kind(&e.kind)) {
            present.insert(e.pid);
            let instance = env.instance(&e.session_id);
            let account = e.owner_account.as_deref().map(|a| env.scoped("account", a));
            let is_alive = alive(e.pid, &e.proc_start);

            // A different process under the same pid, or a new session id in the same process.
            if let Some(old) = self.tracked.get(&e.pid) {
                if old.proc_start != e.proc_start {
                    if !old.ended {
                        out.events.push(self.end(env, old, EndReason::ProcessGone));
                    }
                    self.tracked.remove(&e.pid);
                } else if old.instance != instance {
                    if !old.ended {
                        out.events.push(self.end(env, old, EndReason::Clear));
                    }
                    self.tracked.remove(&e.pid);
                }
            }

            match self.tracked.get_mut(&e.pid) {
                Some(t) => {
                    if t.ended {
                        continue;
                    }
                    if !is_alive {
                        let ev = Draft::new(env, EventKind::SessionEnd, EventSource::Registry, Confidence::Exact, t.instance.clone(), t.host)
                            .account(t.account.clone())
                            .detail(|d| d.end_reason = Some(EndReason::ProcessGone))
                            .done();
                        t.ended = true;
                        out.events.push(ev);
                        continue;
                    }
                    if t.status != e.status {
                        let prev = t.status;
                        t.status = e.status;
                        let (instance, host, account) = (t.instance.clone(), t.host, t.account.clone());
                        status_events(env, e, prev, &instance, host, &account, &mut out);
                    }
                }
                None => {
                    if !is_alive {
                        // A crash leftover found at startup: not a session.
                        self.tracked.insert(
                            e.pid,
                            Tracked { proc_start: e.proc_start.clone(), instance, host: e.host, account, status: e.status, ended: true },
                        );
                        continue;
                    }
                    out.events.push(
                        Draft::new(env, EventKind::SessionStart, EventSource::Registry, Confidence::Exact, instance.clone(), e.host)
                            .account(account.clone())
                            .et(e.started_at)
                            .done(),
                    );
                    out.learned.push((instance.clone(), e.host, account.clone()));
                    status_events(env, e, RegStatus::Starting, &instance, e.host, &account, &mut out);
                    self.tracked.insert(
                        e.pid,
                        Tracked { proc_start: e.proc_start.clone(), instance, host: e.host, account, status: e.status, ended: false },
                    );
                }
            }
        }

        // Files that disappeared: a clean end once the process is gone too.
        let gone: Vec<u32> = self.tracked.keys().copied().filter(|p| !present.contains(p)).collect();
        for pid in gone {
            let Some(t) = self.tracked.get_mut(&pid) else { continue };
            if t.ended {
                self.tracked.remove(&pid);
            } else if !alive(pid, &t.proc_start) {
                let ev = Draft::new(env, EventKind::SessionEnd, EventSource::Registry, Confidence::Exact, t.instance.clone(), t.host)
                    .account(t.account.clone())
                    .detail(|d| d.end_reason = Some(EndReason::Exit))
                    .done();
                self.tracked.remove(&pid);
                out.events.push(ev);
            }
        }
        out
    }
}

fn status_events(
    env: &Env,
    e: &RegistryEntry,
    prev: RegStatus,
    instance: &InstanceId,
    host: Host,
    account: &Option<String>,
    out: &mut RegistryOutput,
) {
    let draft = |kind: EventKind, confidence: Confidence| {
        Draft::new(env, kind, EventSource::Registry, confidence, instance.clone(), host)
            .account(account.clone())
            .et(e.status_updated_at)
    };
    match e.status {
        RegStatus::Busy => {
            if matches!(prev, RegStatus::Waiting(_)) {
                out.events.push(draft(EventKind::Answered, Confidence::Inferred).done());
            } else if prev != RegStatus::Busy {
                out.events.push(draft(EventKind::TurnStart, Confidence::Exact).done());
            }
        }
        // The cause of a wait is unverified (internal field), so these stay inferred.
        RegStatus::Waiting(Some(WaitKind::Permission)) if prev != e.status => {
            out.events.push(draft(EventKind::NeedsPermission, Confidence::Inferred).done());
        }
        RegStatus::Waiting(Some(WaitKind::Question)) if prev != e.status => {
            out.events.push(draft(EventKind::NeedsAnswer, Confidence::Inferred).done());
        }
        RegStatus::Idle | RegStatus::Other | RegStatus::Starting => {
            if matches!(prev, RegStatus::Busy | RegStatus::Waiting(_)) {
                out.left_busy.push(instance.clone());
            }
        }
        _ => {}
    }
}
