//! The `collector::Adapter` implementation and the testable core under it.
//!
//! `ClaudeCore` owns every watcher (registry, transcript tails, process snapshot), the
//! dedup rules and the grace timer. It takes the clock and the identity hash as arguments,
//! so tests drive it with fixed values; `ClaudeAdapter` passes the collector's own.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use collector::contracts::common::{Host, InstanceId, Tool};
use collector::contracts::AgentEvent;
use collector::{Adapter, AdapterContext, AdapterError, Clock, SystemClock};
use busyholm_contracts::agent_event::{EventKind, EventSource, StopReason};
use busyholm_contracts::common::Confidence;
use serde_json::Value;

use crate::dedup::Dedup;
use crate::fsx::{self, Fsx};
use crate::hooks::{map_hook, MAX_BODY};
use crate::pending::Draft;
use crate::process::{ProcInfo, ProcessTracker};
use crate::registry::{parse_registry_entry, registry_file_pid, RegistryEntry, RegistryTracker};
use crate::statusline::map_statusline;
use crate::tailer::{tail_step, Start, TailState, BACKFILL_BYTES};
use crate::transcript::{FileRole, TranscriptReader};
use crate::{Env, MapError, PendingEvent};

/// After the registry leaves `busy`, wait this long for a `Stop` hook or an `end_turn` log
/// record before calling the turn interrupted (Claude's `Stop` does not run on interrupt).
pub const GRACE_MS: u64 = 3_000;
/// How often to look for new transcript files.
pub const DISCOVERY_MS: u64 = 5_000;
/// Only transcripts modified this recently are followed.
pub const ACTIVE_MS: u64 = 30 * 60 * 1000;
/// Inactive tails retain offsets and parser state in this bounded FIFO. Older entries
/// reattach through the usual 64 KiB backfill rather than retaining every past session.
pub const MAX_RESUME_TAILS: usize = 128;
const REGISTRY_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct ClaudeConfig {
    /// One connector per Claude data root; extra roots are separate, explicit adapters.
    pub root: PathBuf,
}

impl ClaudeConfig {
    /// `CLAUDE_CONFIG_DIR` (when set and non-empty) wins; otherwise `<home>/.claude`.
    pub fn resolve(home: &Path, config_dir_env: Option<&str>) -> ClaudeConfig {
        match config_dir_env.map(str::trim).filter(|s| !s.is_empty()) {
            Some(dir) => ClaudeConfig { root: PathBuf::from(dir) },
            None => ClaudeConfig { root: home.join(".claude") },
        }
    }
    /// The default root for this user, from the environment. `None` when no home folder is known.
    pub fn from_environment() -> Option<ClaudeConfig> {
        let home = fsx::home_dir()?;
        Some(ClaudeConfig::resolve(&home, fsx::config_dir_env().as_deref()))
    }
}

/// Counters for format drift and skipped input. Counts only.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct CoreStats {
    pub unknown_hook_events: u64,
    pub oversize_lines: u64,
    pub bad_lines: u64,
    pub tail_resets: u64,
    pub registry_unreadable: u64,
}

#[derive(Clone, Default)]
struct Directory {
    host: HashMap<InstanceId, Host>,
    account: HashMap<InstanceId, String>,
}

struct TailEntry {
    state: TailState,
    role: FileRole,
    reader: TranscriptReader,
}

/// Everything except the identity hash source, so tests can drive it with a fake clock.
pub struct ClaudeCore {
    pub stats: CoreStats,
    cfg: ClaudeConfig,
    canonical_root: PathBuf,
    fsx: Fsx,
    dedup: Dedup,
    registry: RegistryTracker,
    process: ProcessTracker,
    dir: Directory,
    tails: HashMap<PathBuf, TailEntry>,
    resume: VecDeque<(PathBuf, TailEntry)>,
    left_busy: HashMap<InstanceId, u64>,
    last_discovery: Option<u64>,
    procs: Option<Vec<ProcInfo>>,
}

impl ClaudeCore {
    pub fn new(cfg: ClaudeConfig, fsx: Fsx) -> ClaudeCore {
        ClaudeCore {
            stats: CoreStats::default(),
            canonical_root: fsx::canonical_root(&cfg.root),
            cfg,
            fsx,
            dedup: Dedup::new(),
            registry: RegistryTracker::new(),
            process: ProcessTracker::new(),
            dir: Directory::default(),
            tails: HashMap::new(),
            resume: VecDeque::new(),
            left_busy: HashMap::new(),
            last_discovery: None,
            procs: None,
        }
    }

    /// Latest process snapshot, supplied by the collector's scanner (WP-06). Without one the
    /// core cannot tell a dead session from a live one, so it assumes alive.
    pub fn set_processes(&mut self, procs: Vec<ProcInfo>) {
        self.procs = Some(procs);
    }

    pub fn dedup_stats(&self) -> crate::dedup::DedupStats {
        self.dedup.stats
    }

    fn root_id(&self, id: &dyn Fn(&str) -> InstanceId) -> String {
        // Contract: salted hash of agent + ':' + the canonical root path (the collector's
        // hasher already prefixes the agent).
        id(&self.canonical_root.to_string_lossy())
    }

    fn admit_all(&mut self, events: Vec<PendingEvent>, out: &mut Vec<AgentEvent>, mono_ms: u64) {
        for ev in events {
            if self.dedup.admit_at(&ev, mono_ms) {
                if ev.kind == EventKind::TurnStart {
                    self.left_busy.remove(&ev.instance);
                }
                out.push(ev);
            }
        }
    }

    /// Hook body or status line body (routed by `hook_event_name` vs `rate_limits`).
    pub fn map_payload(
        &mut self,
        body: &[u8],
        now_ms: u64,
        id: &dyn Fn(&str) -> InstanceId,
    ) -> Result<Vec<AgentEvent>, MapError> {
        self.map_payload_at(body, now_ms, SystemClock.monotonic_ms(), id)
    }

    fn map_payload_at(
        &mut self,
        body: &[u8],
        now_ms: u64,
        mono_ms: u64,
        id: &dyn Fn(&str) -> InstanceId,
    ) -> Result<Vec<AgentEvent>, MapError> {
        if body.len() > MAX_BODY {
            return Err(MapError::TooLarge);
        }
        let doc: Value = serde_json::from_slice(body).map_err(|_| MapError::NotJson)?;
        let obj = doc.as_object().ok_or(MapError::NotObject)?;
        let is_hook = obj.get("hook_event_name").is_some_and(Value::is_string);
        // A status line body with no rate_limits (not a subscriber, or before the first API
        // response) is valid and simply yields no samples.
        let is_status = !is_hook && obj.contains_key("session_id");
        drop(doc);

        let root = self.root_id(id);
        let dir = self.dir.clone();
        let host_of = |i: &InstanceId| dir.host.get(i).copied();
        let account_of = |i: &InstanceId| dir.account.get(i).cloned();
        let env = Env { now_ms, id, host_of: &host_of, account_of: &account_of, root_id: &root };

        let events = if is_hook {
            let mapped = map_hook(body, &env)?;
            if mapped.unknown_event {
                self.stats.unknown_hook_events += 1;
            }
            mapped.events
        } else if is_status {
            map_statusline(body, &env)?
        } else {
            return Err(MapError::MissingField);
        };
        let mut out = Vec::new();
        self.admit_all(events, &mut out, mono_ms);
        Ok(out)
    }

    /// Startup: registry, the last 64 KiB of recently modified transcripts, processes.
    pub fn rebuild(&mut self, now_ms: u64, id: &dyn Fn(&str) -> InstanceId) -> Vec<AgentEvent> {
        self.rebuild_at(now_ms, SystemClock.monotonic_ms(), id)
    }

    fn rebuild_at(&mut self, now_ms: u64, mono_ms: u64, id: &dyn Fn(&str) -> InstanceId) -> Vec<AgentEvent> {
        self.canonical_root = fsx::canonical_root(&self.cfg.root);
        self.cycle(now_ms, mono_ms, id, true)
    }

    /// One bounded pass: registry, process snapshot, transcript tails, grace timers.
    pub fn poll(&mut self, now_ms: u64, id: &dyn Fn(&str) -> InstanceId) -> Vec<AgentEvent> {
        self.cycle(now_ms, SystemClock.monotonic_ms(), id, false)
    }

    fn scan_registry(&mut self) -> Vec<RegistryEntry> {
        let dir = self.cfg.root.join("sessions");
        let Ok(items) = self.fsx.read_dir(&dir) else { return Vec::new() };
        let mut entries = Vec::new();
        for item in items.into_iter().filter(|i| i.is_file) {
            if registry_file_pid(&item.name).is_none() {
                continue;
            }
            match self.fsx.read_small(&dir.join(&item.name), REGISTRY_MAX_BYTES).ok().and_then(|b| parse_registry_entry(&b).ok()) {
                Some(e) => entries.push(e),
                None => self.stats.registry_unreadable += 1,
            }
        }
        entries.sort_by_key(|e| e.pid);
        entries
    }

    fn discover(&mut self, now_ms: u64) {
        let projects = self.cfg.root.join("projects");
        let mut found: Vec<(PathBuf, FileRole)> = Vec::new();
        let agent_files = |fsx: &Fsx, dir: &Path, out: &mut Vec<(PathBuf, FileRole)>| {
            if let Ok(items) = fsx.read_dir(dir) {
                for it in items.into_iter().filter(|i| i.is_file) {
                    if let Some(stem) = it.name.strip_suffix(".jsonl").and_then(|s| s.strip_prefix("agent-")) {
                        out.push((dir.join(&it.name), FileRole::Subagent { agent_id: stem.to_string() }));
                    }
                }
            }
        };
        if let Ok(pdirs) = self.fsx.read_dir(&projects) {
            for pd in pdirs.into_iter().filter(|i| i.is_dir) {
                let pdir = projects.join(&pd.name);
                let Ok(items) = self.fsx.read_dir(&pdir) else { continue };
                for it in items {
                    if it.is_file && it.name.ends_with(".jsonl") {
                        found.push((pdir.join(&it.name), FileRole::Main));
                    } else if it.is_dir {
                        let sub = pdir.join(&it.name).join("subagents");
                        agent_files(&self.fsx, &sub, &mut found);
                        if let Ok(runs) = self.fsx.read_dir(&sub.join("workflows")) {
                            for run in runs.into_iter().filter(|r| r.is_dir) {
                                agent_files(&self.fsx, &sub.join("workflows").join(&run.name), &mut found);
                            }
                        }
                    }
                }
            }
        }
        let mut present = HashSet::new();
        for (path, role) in found {
            let Ok(meta) = self.fsx.metadata(&path) else { continue };
            present.insert(path.clone());
            if now_ms.saturating_sub(meta.mtime_ms) > ACTIVE_MS {
                if let Some(entry) = self.tails.remove(&path) {
                    self.resume.push_back((path, entry));
                    if self.resume.len() > MAX_RESUME_TAILS {
                        self.resume.pop_front();
                    }
                }
                continue;
            }
            if !self.tails.contains_key(&path) {
                let saved = self.resume.iter().position(|(p, _)| p == &path)
                    .and_then(|i| self.resume.remove(i)).map(|(_, entry)| entry);
                let entry = saved.unwrap_or_else(|| TailEntry {
                    state: TailState::default(), role, reader: TranscriptReader::new(),
                });
                self.tails.insert(path, entry);
            }
        }
        self.tails.retain(|p, _| present.contains(p));
        self.resume.retain(|(p, _)| present.contains(p));
        self.last_discovery = Some(now_ms);
    }

    fn cycle(&mut self, now_ms: u64, mono_ms: u64, id: &dyn Fn(&str) -> InstanceId, rebuild: bool) -> Vec<AgentEvent> {
        let mut out: Vec<AgentEvent> = Vec::new();
        let root = self.root_id(id);

        // 1. Registry.
        let entries = self.scan_registry();
        let procs = self.procs.clone();
        // Only a pid that is ABSENT from the snapshot is dead. A pid that is present with a different start string
        // (the time zone changed, or the scanner formats the start differently) is no evidence either way: unknown,
        // so alive. The start string is deliberately not compared here.
        let alive = |pid: u32, _start: &str| match &procs {
            Some(list) => list.iter().any(|p| p.pid == pid),
            None => true,
        };
        let reg = {
            let dir = self.dir.clone();
            let host_of = |i: &InstanceId| dir.host.get(i).copied();
            let account_of = |i: &InstanceId| dir.account.get(i).cloned();
            let env = Env { now_ms, id, host_of: &host_of, account_of: &account_of, root_id: &root };
            self.registry.observe(&entries, &alive, &env)
        };
        for (inst, host, account) in &reg.learned {
            self.dir.host.insert(inst.clone(), *host);
            if let Some(a) = account {
                self.dir.account.insert(inst.clone(), a.clone());
            }
        }
        for inst in reg.left_busy {
            self.left_busy.entry(inst).or_insert(now_ms);
        }
        self.admit_all(reg.events, &mut out, mono_ms);

        let dir = self.dir.clone();
        let host_of = |i: &InstanceId| dir.host.get(i).copied();
        let account_of = |i: &InstanceId| dir.account.get(i).cloned();
        let env = Env { now_ms, id, host_of: &host_of, account_of: &account_of, root_id: &root };

        // 2. Processes. A registered pid is known by the start string the registry holds, so a scanner that prints
        // the same start differently does not look like a new process (a ghost resident plus a process_down).
        if let Some(list) = &procs {
            let registry = &self.registry;
            let list: Vec<ProcInfo> = list.iter().map(|p| match registry.proc_start_of(p.pid) {
                Some(start) => ProcInfo { start: start.to_string(), ..p.clone() },
                None => p.clone(),
            }).collect();
            let events = self.process.observe(&list, &|pid, start| registry.instance_for(pid, start), &env);
            self.admit_all(events, &mut out, mono_ms);
        }

        // 3. Transcripts.
        if rebuild || self.last_discovery.map_or(true, |t| now_ms.saturating_sub(t) >= DISCOVERY_MS) {
            self.discover(now_ms);
        }
        let mut events: Vec<PendingEvent> = Vec::new();
        let mut dead: Vec<PathBuf> = Vec::new();
        let mut paths: Vec<PathBuf> = self.tails.keys().cloned().collect();
        paths.sort();
        for path in paths {
            let Some(entry) = self.tails.get_mut(&path) else { continue };
            // The reader belongs to this tail so evicting its resume entry releases all
            // cached turn, message and child state as well as the byte offset.
            let reader = &mut entry.reader;
            let bad_before = reader.stats.bad_lines;
            let role = entry.role.clone();
            match tail_step(&self.fsx, &path, &mut entry.state, Start::Tail(BACKFILL_BYTES), &mut |line| {
                events.extend(reader.on_line(line, &role, &env));
            }) {
                Ok(o) => {
                    self.stats.oversize_lines += u64::from(o.skipped_oversize);
                    self.stats.tail_resets += u64::from(o.reset);
                }
                Err(_) => dead.push(path),
            }
            self.stats.bad_lines += reader.stats.bad_lines - bad_before;
        }
        for p in dead {
            self.tails.remove(&p);
        }
        let events = TranscriptReader::reduce_history(events, now_ms);
        self.admit_all(events, &mut out, mono_ms);

        // 4. Registry left busy and nothing explained it: the user interrupted.
        if !rebuild {
            let mut due: Vec<InstanceId> = self
                .left_busy
                .iter()
                .filter(|(_, since)| now_ms.saturating_sub(**since) >= GRACE_MS)
                .map(|(i, _)| i.clone())
                .collect();
            due.sort();
            for inst in due {
                self.left_busy.remove(&inst);
                if self.dedup.has_open_turn(&inst) {
                    let ev = Draft::new(&env, EventKind::TurnInterrupted, EventSource::Registry, Confidence::Inferred, inst.clone(), env.host(&inst))
                        .account((env.account_of)(&inst))
                        .detail(|d| d.stop_reason = Some(StopReason::Interrupted))
                        .done();
                    self.admit_all(vec![ev], &mut out, mono_ms);
                }
            }
        }
        out
    }
}

pub struct ClaudeAdapter {
    core: ClaudeCore,
}

impl ClaudeAdapter {
    pub fn new(cfg: ClaudeConfig, fsx: Fsx) -> ClaudeAdapter {
        ClaudeAdapter { core: ClaudeCore::new(cfg, fsx) }
    }
    /// For the collector's scanner to hand over process snapshots and to read counters.
    pub fn core_mut(&mut self) -> &mut ClaudeCore {
        &mut self.core
    }
}

fn to_adapter_error(_: MapError) -> AdapterError {
    AdapterError::InvalidPayload
}

impl Adapter for ClaudeAdapter {
    fn tool(&self) -> Tool {
        Tool::Claude
    }
    fn map_hook(&mut self, body: &[u8], ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        self.core
            .map_payload_at(body, ctx.now_ms(), ctx.clock.monotonic_ms(), &|raw| ctx.instance(Tool::Claude, raw))
            .map_err(to_adapter_error)
    }
    fn rebuild(&mut self, ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        Ok(self.core.rebuild_at(ctx.now_ms(), ctx.clock.monotonic_ms(), &|raw| ctx.instance(Tool::Claude, raw)))
    }
    fn poll(&mut self, ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        Ok(self.core.cycle(ctx.now_ms(), ctx.clock.monotonic_ms(), &|raw| ctx.instance(Tool::Claude, raw), false))
    }
}
