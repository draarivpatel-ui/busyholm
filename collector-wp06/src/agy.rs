//! Antigravity CLI (`agy`) presence from the request heartbeat in `log/cli-*.log`.
//!
//! What is read: for each log line, only its glog prefix (`I1012 12:00:03.124267 4242
//! http_helpers.go:88] URL:`), and from that only the time of day and whether it is a model
//! request line. The rest of every line (prompts and working folders appear there) is dropped
//! unread, a line is never held longer than its first 128 bytes, and non-log lines (JSON
//! continuation lines, binary) are ignored. Conversations, history and the OAuth token are
//! never listed or opened: the only directory read is `log/`.
//!
//! The request lines arrive about every 3 s (gaps of 1 to 10 s, rarely up to a minute) while
//! the CLI works, so `working` means "a request line within the last 90 s" and 90 s without one
//! reads as `your_turn`, always `inferred`: the log cannot say whether the CLI is waiting for
//! the user, for a tool, or gone.
//!
//! glog lines carry no year and no time zone. Instead of guessing either, line times are taken
//! relative to the last glog line of each batch, which is anchored to the file's modification
//! time (or the collector clock, whichever is earlier). Midnight rollover is handled.
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use busyholm_contracts::{
    agent_event::{EventDetail, EventKind, EventSource, StopReason},
    common::{Confidence, Host, Tool},
    AgentEvent,
};
use collector::{Adapter, AdapterContext, AdapterError};

use crate::build::{valid_ms, Builder};
use crate::ident::{process_raw, Identity};

const PREFIX_MAX: usize = 128;
const DAY_MICROS: u64 = 86_400 * 1_000_000;
const BIND_WINDOW_MS: u64 = 15_000;
const BATCH_CAP: usize = 8_192;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgyState {
    Working,
    YourTurn,
}

#[derive(Debug, Clone)]
pub struct AgyConfig {
    /// `<home>/.gemini/antigravity-cli`.
    pub root: PathBuf,
    pub min_interval_ms: u64,
    /// No request line for this long means the turn is over (`your_turn`, inferred), ms.
    pub quiet_end_ms: u64,
    /// Only logs modified within this window are followed, ms.
    pub active_log_window_ms: u64,
    pub max_logs: usize,
    /// First look reads at most this many trailing bytes of a log.
    pub tail_bytes: u64,
}

impl AgyConfig {
    pub fn new(root: PathBuf) -> Self {
        Self { root, min_interval_ms: 1_000, quiet_end_ms: 90_000, active_log_window_ms: 600_000, max_logs: 8, tail_bytes: 65_536 }
    }
}

/// A parsed glog prefix. Everything after the source tag is discarded unread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GlogLine {
    pub micros_of_day: u64,
    pub is_request: bool,
}

fn digits(b: &[u8]) -> Option<u64> {
    if b.is_empty() || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(b.iter().fold(0u64, |a, d| a * 10 + u64::from(d - b'0')))
}

/// Parse `I1012 12:00:03.124267 4242 http_helpers.go:88] URL: ...`; None for anything else.
pub fn parse_glog_prefix(line: &[u8]) -> Option<GlogLine> {
    let line = &line[..line.len().min(PREFIX_MAX)];
    if line.len() < 24 || !matches!(line[0], b'I' | b'W' | b'E' | b'F') {
        return None;
    }
    let month = digits(&line[1..3])?;
    let day = digits(&line[3..5])?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || line[5] != b' ' {
        return None;
    }
    let h = digits(&line[6..8])?;
    let m = digits(&line[9..11])?;
    let s = digits(&line[12..14])?;
    if line[8] != b':' || line[11] != b':' || line[14] != b'.' || h > 23 || m > 59 || s > 60 {
        return None;
    }
    let frac_end = 15 + line[15..].iter().take_while(|c| c.is_ascii_digit()).count();
    if frac_end == 15 || frac_end > 24 || line.get(frac_end) != Some(&b' ') {
        return None;
    }
    let mut micros = 0u64;
    for i in 0..6 {
        micros = micros * 10 + line.get(15 + i).filter(|_| 15 + i < frac_end).map_or(0, |d| u64::from(d - b'0'));
    }
    // thread token, a space, then `file.go:123]`
    let rest = &line[frac_end + 1..];
    let thread_len = rest.iter().take_while(|c| !c.is_ascii_whitespace()).count();
    if thread_len == 0 || rest.get(thread_len) != Some(&b' ') {
        return None;
    }
    let rest = &rest[thread_len + 1..];
    let close = rest.iter().position(|&c| c == b']')?;
    let tag = &rest[..close];
    if tag.is_empty() || !tag.contains(&b':') || !tag.iter().all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(c)) {
        return None;
    }
    let file = tag.split(|&c| c == b':').next().unwrap_or(&[]);
    let after = rest[close + 1..].strip_prefix(b" ").unwrap_or(&rest[close + 1..]);
    Some(GlogLine {
        micros_of_day: (h * 3600 + m * 60 + s) * 1_000_000 + micros,
        is_request: file == b"http_helpers.go" && after.starts_with(b"URL:"),
    })
}

/// The reducer: Working until `quiet_end_ms` without a request line, then YourTurn.
pub fn agy_state(last_request_ms: u64, now_ms: u64, quiet_end_ms: u64) -> AgyState {
    if now_ms.saturating_sub(last_request_ms) >= quiet_end_ms { AgyState::YourTurn } else { AgyState::Working }
}

struct LogState {
    offset: u64,
    created_ms: Option<u64>,
    carry: Vec<u8>,
    carry_overflow: bool,
    skip_partial: bool,
    started: bool,
    last_request_ms: Option<u64>,
    working: bool,
    raw: String,
}

pub struct AgyReader {
    cfg: AgyConfig,
    logs: HashMap<String, LogState>,
    live: Vec<(u32, u64)>,
    last_poll: Option<u64>,
}

struct Batch {
    /// (time of day in microseconds, is a request line)
    lines: Vec<(u64, bool)>,
}

impl AgyReader {
    pub fn new(cfg: AgyConfig) -> Self {
        Self { cfg, logs: HashMap::new(), live: Vec::new(), last_poll: None }
    }

    /// Live agy processes (pid, start ms) from the process scanner, used to bind a log to
    /// the process that wrote it so one agy shows as one resident.
    pub fn set_live_processes(&mut self, procs: Vec<(u32, u64)>) {
        self.live = procs;
    }

    pub fn poll_at(&mut self, ids: &dyn Identity, now_ms: u64) -> Vec<AgentEvent> {
        if let Some(last) = self.last_poll {
            if now_ms < last + self.cfg.min_interval_ms {
                return Vec::new();
            }
        }
        self.last_poll = Some(now_ms);
        let root = self.cfg.root.to_string_lossy().into_owned();
        let b = Builder { ids, tool: Tool::Antigravity, root_raw: &root, host: Host::Cli, now_ms };
        let mut out = Vec::new();

        // The newest `max_logs` logs by name that were written to recently.
        let mut found: Vec<(String, u64, u64)> = Vec::new(); // (name, len, mtime ms)
        if let Ok(rd) = fs::read_dir(self.cfg.root.join("log")) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if !(name.starts_with("cli-") && name.ends_with(".log")) {
                    continue;
                }
                let Ok(md) = e.metadata() else { continue };
                if !md.is_file() {
                    continue;
                }
                let mtime = md.modified().ok().and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
                if now_ms.saturating_sub(mtime) > self.cfg.active_log_window_ms {
                    continue;
                }
                found.push((name, md.len(), mtime));
            }
        }
        found.sort_by(|a, b| b.0.cmp(&a.0));
        found.truncate(self.cfg.max_logs);
        found.sort_by(|a, b| a.0.cmp(&b.0));
        let names: Vec<String> = found.iter().map(|f| f.0.clone()).collect();
        self.logs.retain(|k, _| names.contains(k));
        let log_count = found.len();

        for (name, len, mtime) in found {
            let path = self.cfg.root.join("log").join(&name);
            let created_ms = fs::metadata(&path).ok().and_then(|m| m.created().ok()).and_then(|c| c.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64);
            let first_sight = !self.logs.contains_key(&name);
            if first_sight {
                let raw = self.bind(&name, created_ms, log_count);
                self.logs.insert(name.clone(), LogState {
                    offset: 0, created_ms, carry: Vec::new(), carry_overflow: false, skip_partial: false,
                    started: false, last_request_ms: None, working: false, raw,
                });
            }
            let quiet = self.cfg.quiet_end_ms;
            let tail = self.cfg.tail_bytes;
            let st = self.logs.get_mut(&name).expect("inserted");
            // A shorter file, or a different creation time, is a replaced log: start over.
            if !first_sight && (len < st.offset || (created_ms.is_some() && st.created_ms.is_some() && created_ms != st.created_ms)) {
                st.offset = 0;
                st.carry.clear();
                st.carry_overflow = false;
                st.created_ms = created_ms;
            }
            if first_sight || st.offset == 0 && len > tail {
                if len > tail {
                    st.offset = len - tail;
                    st.skip_partial = true;
                }
            }
            let batch = read_new(&path, st, len);
            let raw = st.raw.clone();
            let ev = |kind: EventKind| b.event(kind, EventSource::Log, Confidence::Inferred, &raw, None, true);

            if !st.started {
                st.started = true;
                let mut e = ev(EventKind::SessionStart);
                e.et = created_ms.and_then(valid_ms);
                out.push(e);
            }

            // Turn line times into collector time.
            let anchor = now_ms.min(if mtime > 0 { mtime } else { now_ms });
            let mut reqs: Vec<u64> = Vec::new();
            if let Some(&(last_tod, _)) = batch.lines.last() {
                for &(tod, is_req) in &batch.lines {
                    if !is_req {
                        continue;
                    }
                    let back = (last_tod + DAY_MICROS - tod) % DAY_MICROS / 1000;
                    reqs.push(anchor.saturating_sub(back));
                }
            }
            if first_sight {
                // Observation, not history: only the final burst counts, and only if it is live.
                let mut start = reqs.len();
                while start > 0 && (start == reqs.len() || reqs[start] - reqs[start - 1] < quiet) {
                    start -= 1;
                }
                reqs = reqs.split_off(start);
                if reqs.last().map_or(true, |&l| now_ms.saturating_sub(l) >= quiet) {
                    if let Some(&l) = reqs.last() {
                        st.last_request_ms = Some(l);
                    }
                    reqs.clear();
                }
            }
            for r in reqs {
                if st.working {
                    let gap = r.saturating_sub(st.last_request_ms.unwrap_or(r));
                    if gap >= quiet {
                        let mut e = ev(EventKind::TurnEnd);
                        e.et = valid_ms(st.last_request_ms.unwrap_or(r) + quiet);
                        e.detail = Some(EventDetail { stop_reason: Some(StopReason::Other), ..crate::build::detail() });
                        out.push(e);
                        st.working = false;
                    }
                }
                let mut e = ev(if st.working { EventKind::Heartbeat } else { EventKind::TurnStart });
                e.et = valid_ms(r);
                out.push(e);
                st.working = true;
                st.last_request_ms = Some(r);
            }
            if st.working {
                if let Some(l) = st.last_request_ms {
                    if agy_state(l, now_ms, quiet) == AgyState::YourTurn {
                        let mut e = ev(EventKind::TurnEnd);
                        e.detail = Some(EventDetail { stop_reason: Some(StopReason::Other), ..crate::build::detail() });
                        out.push(e);
                        st.working = false;
                    }
                }
            }
        }
        out
    }

    /// The raw key a log's events are filed under: the process that wrote it when that is
    /// clear, otherwise the log's own name. Decided once, when the log is first seen.
    fn bind(&self, name: &str, created_ms: Option<u64>, active_logs: usize) -> String {
        if let Some(c) = created_ms {
            let nearest = self.live.iter().min_by_key(|(_, s)| s.abs_diff(c));
            if let Some(&(pid, start)) = nearest {
                if start.abs_diff(c) <= BIND_WINDOW_MS {
                    return process_raw(pid, start);
                }
            }
        }
        if self.live.len() == 1 && active_logs == 1 {
            let (pid, start) = self.live[0];
            return process_raw(pid, start);
        }
        format!("log:{name}")
    }
}

/// Read what was appended since the last look. Lines are folded into (time, request) pairs
/// as they complete; a trailing partial line waits in `carry` (its first bytes only).
fn read_new(path: &PathBuf, st: &mut LogState, len: u64) -> Batch {
    let mut batch = Batch { lines: Vec::new() };
    if len <= st.offset {
        return batch;
    }
    let Ok(mut f) = File::open(path) else { return batch };
    if f.seek(SeekFrom::Start(st.offset)).is_err() {
        return batch;
    }
    let mut buf = [0u8; 16 * 1024];
    let mut remaining = len - st.offset;
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        let n = match f.read(&mut buf[..want]) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        remaining -= n as u64;
        st.offset += n as u64;
        for &byte in &buf[..n] {
            if byte == b'\n' {
                if st.skip_partial {
                    st.skip_partial = false;
                } else if !st.carry_overflow || !st.carry.is_empty() {
                    if let Some(g) = parse_glog_prefix(&st.carry) {
                        if batch.lines.len() < BATCH_CAP {
                            batch.lines.push((g.micros_of_day, g.is_request));
                        }
                    }
                }
                st.carry.clear();
                st.carry_overflow = false;
            } else if st.carry.len() < PREFIX_MAX {
                st.carry.push(byte);
            } else {
                st.carry_overflow = true;
            }
        }
    }
    batch
}

pub struct AgyAdapter {
    reader: AgyReader,
}

impl AgyAdapter {
    pub fn new(cfg: AgyConfig) -> Self {
        Self { reader: AgyReader::new(cfg) }
    }
    /// Pass the process scanner's live agy processes each tick (see [`AgyReader::set_live_processes`]).
    pub fn set_live_processes(&mut self, procs: Vec<(u32, u64)>) {
        self.reader.set_live_processes(procs);
    }
}

impl Adapter for AgyAdapter {
    fn tool(&self) -> Tool {
        Tool::Antigravity
    }
    fn rebuild(&mut self, ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        Ok(self.reader.poll_at(ctx, ctx.now_ms()))
    }
    fn poll(&mut self, ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        Ok(self.reader.poll_at(ctx, ctx.now_ms()))
    }
}
