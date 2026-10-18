//! Read-only poll of OpenCode's `session` table.
//!
//! OpenCode's database was 5.4 GB on the reference Mac, almost all of it in `message`, `part`
//! and `event`. This module reads one small table and nothing else:
//!
//! * [`SESSION_QUERY`] names the table `session` and ten id, clock and counter columns. The
//!   query plan is a scan of `session` (no index covers `time_updated`; the table is a few
//!   thousand rows, about 10 ms), and never mentions `message`, `part` or `event`.
//! * The connection is opened read-only, with `query_only` on and no busy wait, and carries a
//!   SQLite authorizer that refuses to read any other table or any column outside
//!   [`ALLOWED_COLUMNS`]. Titles, directories, slugs, diffs, metadata and model names cannot
//!   be read even by a code change that forgets to name them: the statement fails to prepare.
//! * Nothing is ever written. A busy or locked database is skipped until the next poll.
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use busyholm_contracts::{
    agent_event::{EndReason, EventDetail, EventKind, EventSource},
    common::{Confidence, Host, Tool},
    AgentEvent,
};
use collector::AdapterError;
use rusqlite::{hooks::{AuthAction, AuthContext, Authorization}, Connection, ErrorCode, OpenFlags};

use crate::build::{valid_ms, Builder};
use crate::ident::{sha256_hex, Identity};

/// The one statement the poller runs. It reads `session` only, and only the columns named here.
pub const SESSION_QUERY: &str = "SELECT id, parent_id, time_created, time_updated, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_archived FROM session WHERE time_updated >= ?1 ORDER BY time_updated ASC LIMIT 512";
/// Every statement the poller can prepare (the query-plan test walks this list).
pub const QUERIES: &[&str] = &[SESSION_QUERY];
/// Columns of `session` the poller may read; the SQLite authorizer denies all others.
pub const ALLOWED_COLUMNS: &[&str] = &[
    "id", "parent_id", "time_created", "time_updated", "tokens_input", "tokens_output",
    "tokens_reasoning", "tokens_cache_read", "tokens_cache_write", "time_archived",
];

/// A row seen again this soon after its last change is the same activity, not a new one.
const OVERLAP_MS: u64 = 5_000;
/// A row that moved less than this after creation is the creation itself, not work.
const WORKED_AFTER_MS: u64 = 2_000;
const FORGET_AFTER_MS: u64 = 3_600_000;
const REOPEN_AFTER_MS: u64 = 30_000;

#[derive(Debug, Clone)]
pub struct PollConfig {
    pub db_path: PathBuf,
    /// Connector key (the OpenCode data folder), hashed into `root_id`.
    pub root: String,
    /// Minimum gap between queries, ms.
    pub min_interval_ms: u64,
    /// A session whose row has not changed for this long is `turn_end` (inferred), ms.
    pub quiet_end_ms: u64,
    /// On the first look, only rows updated within this window are reported, ms.
    pub rebuild_window_ms: u64,
}

impl PollConfig {
    pub fn new(db_path: PathBuf) -> Self {
        let root = db_path.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        Self { db_path, root, min_interval_ms: 1_000, quiet_end_ms: 90_000, rebuild_window_ms: 600_000 }
    }
}

struct Row {
    id: String,
    parent: Option<String>,
    created: u64,
    updated: u64,
    tokens: u64,
    archived: bool,
}

struct Track {
    updated: u64,
    tokens: u64,
    working: bool,
    last_activity: u64,
    ended: bool,
    parent: Option<String>,
}

struct Conn {
    conn: Connection,
    opened_at: u64,
    immutable: bool,
}

pub struct OpenCodePoller {
    cfg: PollConfig,
    conn: Option<Conn>,
    tracks: HashMap<String, Track>,
    initialized: bool,
    watermark: u64,
    last_poll: Option<u64>,
    read_log: Arc<Mutex<BTreeSet<(String, String)>>>,
}

fn authorizer(log: Arc<Mutex<BTreeSet<(String, String)>>>) -> impl FnMut(AuthContext<'_>) -> Authorization + Send + 'static {
    move |ctx| match ctx.action {
        AuthAction::Select => Authorization::Allow,
        AuthAction::Read { table_name, column_name } => {
            if let Ok(mut l) = log.lock() {
                l.insert((table_name.to_string(), column_name.to_string()));
            }
            if table_name == "session" && (column_name.is_empty() || ALLOWED_COLUMNS.contains(&column_name)) {
                Authorization::Allow
            } else {
                Authorization::Deny
            }
        }
        _ => Authorization::Deny,
    }
}

impl OpenCodePoller {
    pub fn new(cfg: PollConfig) -> Self {
        Self {
            cfg,
            conn: None,
            tracks: HashMap::new(),
            initialized: false,
            watermark: 0,
            last_poll: None,
            read_log: Arc::new(Mutex::new(BTreeSet::new())),
        }
    }

    /// The connector key events are tagged with.
    pub fn root(&self) -> &str {
        &self.cfg.root
    }

    fn sibling(&self, suffix: &str) -> PathBuf {
        let mut s = self.cfg.db_path.clone().into_os_string();
        s.push(suffix);
        PathBuf::from(s)
    }

    /// With no `-wal` or `-shm` next to it the database is closed cleanly, and opening it
    /// the usual way would make SQLite create those two files in OpenCode's folder. In that
    /// state it is opened `immutable` instead, which touches nothing. The moment either file
    /// exists (OpenCode is running) the normal read-only mode is used.
    fn want_immutable(&self) -> bool {
        cfg!(unix) && !self.sibling("-wal").exists() && !self.sibling("-shm").exists()
    }

    fn open(&self, now_ms: u64) -> Result<Conn, AdapterError> {
        let immutable = self.want_immutable();
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI;
        let target = if immutable { immutable_uri(&self.cfg.db_path) } else { plain_uri(&self.cfg.db_path) };
        let conn = Connection::open_with_flags(target, flags).map_err(|_| AdapterError::Io)?;
        conn.busy_timeout(Duration::ZERO).map_err(|_| AdapterError::Io)?;
        conn.pragma_update(None, "query_only", "ON").map_err(|_| AdapterError::Io)?;
        conn.authorizer(Some(authorizer(self.read_log.clone()))).map_err(|_| AdapterError::Io)?;
        Ok(Conn { conn, opened_at: now_ms, immutable })
    }

    fn ensure_open(&mut self, now_ms: u64) -> Result<bool, AdapterError> {
        if !self.cfg.db_path.exists() {
            self.conn = None;
            return Ok(false);
        }
        let stale = match &self.conn {
            None => true,
            Some(c) => c.immutable || now_ms.saturating_sub(c.opened_at) >= REOPEN_AFTER_MS || c.immutable != self.want_immutable(),
        };
        if stale {
            self.conn = Some(self.open(now_ms)?);
        }
        Ok(true)
    }

    fn query(&mut self, since: u64) -> Result<Vec<Row>, AdapterError> {
        let c = &self.conn.as_ref().ok_or(AdapterError::Unavailable)?.conn;
        let run = || -> rusqlite::Result<Vec<Row>> {
            let mut st = c.prepare_cached(SESSION_QUERY)?;
            let rows = st.query_map([since as i64], |r| {
                let n = |i: usize| r.get::<_, Option<i64>>(i).map(|v| v.unwrap_or(0).max(0) as u64);
                Ok(Row {
                    id: r.get(0)?,
                    parent: r.get(1)?,
                    created: n(2)?,
                    updated: n(3)?,
                    tokens: n(4)? + n(5)? + n(6)? + n(7)? + n(8)?,
                    archived: r.get::<_, Option<i64>>(9)?.is_some(),
                })
            })?;
            rows.collect()
        };
        run().map_err(|e| match e.sqlite_error_code() {
            Some(ErrorCode::DatabaseBusy) | Some(ErrorCode::DatabaseLocked) => AdapterError::Unavailable,
            _ => AdapterError::Io,
        })
    }

    /// First look: observations only (`et` carries the source time).
    pub fn rebuild_at(&mut self, ids: &dyn Identity, now_ms: u64) -> Result<Vec<AgentEvent>, AdapterError> {
        self.step(ids, now_ms, true)
    }

    pub fn poll_at(&mut self, ids: &dyn Identity, now_ms: u64) -> Result<Vec<AgentEvent>, AdapterError> {
        if !self.initialized {
            return self.step(ids, now_ms, true);
        }
        if let Some(last) = self.last_poll {
            if now_ms < last + self.cfg.min_interval_ms {
                return Ok(Vec::new());
            }
        }
        self.step(ids, now_ms, false)
    }

    fn step(&mut self, ids: &dyn Identity, now_ms: u64, first: bool) -> Result<Vec<AgentEvent>, AdapterError> {
        self.last_poll = Some(now_ms);
        if !self.ensure_open(now_ms)? {
            return Ok(Vec::new());
        }
        let since = if first { now_ms.saturating_sub(self.cfg.rebuild_window_ms) } else { self.watermark.saturating_sub(OVERLAP_MS) };
        let rows = match self.query(since) {
            Ok(r) => r,
            Err(AdapterError::Unavailable) => {
                self.conn = None;
                return Ok(Vec::new());
            }
            Err(e) => {
                self.conn = None;
                return Err(e);
            }
        };
        let mut out = Vec::new();
        let root = self.cfg.root.clone();
        let b = Builder { ids, tool: Tool::Opencode, root_raw: &root, host: Host::Cli, now_ms };
        let quiet = self.cfg.quiet_end_ms;
        if self.watermark == 0 {
            self.watermark = since;
        }
        for row in rows {
            self.watermark = self.watermark.max(row.updated);
            let raw = sha256_hex(&row.id);
            let parent_raw = row.parent.as_deref().map(sha256_hex);
            let ev = |kind: EventKind| b.event(kind, EventSource::Poll, Confidence::Inferred, &raw, parent_raw.as_deref(), true);
            match self.tracks.get_mut(&row.id) {
                None => {
                    let mut e = ev(EventKind::SessionStart);
                    e.et = valid_ms(row.created.min(now_ms));
                    out.push(e);
                    let worked = row.updated >= row.created + WORKED_AFTER_MS;
                    let working = worked && !row.archived && now_ms.saturating_sub(row.updated) < quiet;
                    if working {
                        let mut t = ev(EventKind::TurnStart);
                        t.et = valid_ms(row.updated.min(now_ms));
                        out.push(t);
                    }
                    let mut ended = false;
                    if row.archived {
                        out.push(session_end(ev(EventKind::SessionEnd)));
                        ended = true;
                    }
                    self.tracks.insert(row.id.clone(), Track {
                        updated: row.updated, tokens: row.tokens, working, last_activity: row.updated, ended, parent: row.parent.clone(),
                    });
                }
                Some(tr) => {
                    if tr.ended {
                        continue;
                    }
                    if row.archived {
                        out.push(session_end(ev(EventKind::SessionEnd)));
                        tr.ended = true;
                        tr.working = false;
                        continue;
                    }
                    if row.updated > tr.updated {
                        let delta = row.tokens.saturating_sub(tr.tokens).min(1_000_000_000) as u32;
                        let mut e = ev(if tr.working { EventKind::Heartbeat } else { EventKind::TurnStart });
                        e.et = valid_ms(row.updated.min(now_ms));
                        if delta > 0 {
                            e.tokens_delta = Some(delta);
                        }
                        out.push(e);
                        tr.working = true;
                        tr.updated = row.updated;
                        tr.last_activity = row.updated;
                    }
                    tr.tokens = row.tokens;
                    if tr.parent != row.parent {
                        tr.parent = row.parent.clone();
                    }
                }
            }
        }
        self.initialized = true;
        // Quiet means the turn is over: inferred, from the row's own clock.
        let mut ending: Vec<(&String, u64)> = self.tracks.iter()
            .filter(|(_, t)| t.working && !t.ended && now_ms.saturating_sub(t.last_activity) >= quiet)
            .map(|(id, t)| (id, t.last_activity))
            .collect();
        ending.sort_by_key(|(id, last)| (*last, (*id).clone()));
        let ending_ids: Vec<(String, Option<String>)> = ending.iter().map(|(id, _)| ((*id).clone(), self.tracks[*id].parent.clone())).collect();
        for (id, parent) in ending_ids {
            let raw = sha256_hex(&id);
            let parent_raw = parent.as_deref().map(sha256_hex);
            let mut e = b.event(EventKind::TurnEnd, EventSource::Poll, Confidence::Inferred, &raw, parent_raw.as_deref(), true);
            e.detail = Some(EventDetail { stop_reason: Some(busyholm_contracts::agent_event::StopReason::Other), ..crate::build::detail() });
            out.push(e);
            if let Some(t) = self.tracks.get_mut(&id) {
                t.working = false;
            }
        }
        self.tracks.retain(|_, t| t.working || now_ms.saturating_sub(t.last_activity) < FORGET_AFTER_MS);
        Ok(out)
    }

    /// (table, column) pairs the authorizer has seen read since the poller was created.
    pub fn columns_read(&self) -> Vec<(String, String)> {
        self.read_log.lock().map(|l| l.iter().cloned().collect()).unwrap_or_default()
    }

    /// True when the authorizer refuses `sql` (used to prove content columns are unreachable).
    pub fn authorizer_refuses(&mut self, sql: &str) -> bool {
        if self.ensure_open(0).ok() != Some(true) {
            return false;
        }
        let Some(c) = self.conn.as_ref() else { return false };
        match c.conn.prepare(sql) {
            Ok(_) => false,
            Err(e) => e.sqlite_error_code() == Some(ErrorCode::AuthorizationForStatementDenied),
        }
    }
}

fn session_end(mut e: AgentEvent) -> AgentEvent {
    e.detail = Some(EventDetail { end_reason: Some(EndReason::Other), ..crate::build::detail() });
    e
}

fn percent_encode(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b':' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn plain_uri(p: &Path) -> String {
    format!("file:{}?mode=ro", uri_path(p))
}

fn immutable_uri(p: &Path) -> String {
    format!("file:{}?mode=ro&immutable=1", uri_path(p))
}

fn uri_path(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    if s.starts_with('/') { percent_encode(&s) } else { format!("/{}", percent_encode(&s)) }
}
