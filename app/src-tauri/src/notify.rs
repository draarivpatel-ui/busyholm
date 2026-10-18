//! WP-11: the notification dedupe state machine (SPEC 4.3 "Tray and OS" column, 5.7 rule 9, 6.9,
//! Revision 1 item 3).
//!
//! Pure on purpose: no tauri, no clock reads, no IO. The caller feeds every Snapshot and Moment in,
//! passes a monotonic millisecond clock (`now`) with each call, calls [`Notifier::tick`] when
//! [`Notifier::next_due`] says a reminder is due, and shows whatever [`Notice`]s come back.
//!
//! Two clocks, never mixed:
//! - `t` inside a Snapshot or Moment is the collector's wall clock. It only orders signals about
//!   the same agent against each other ("is this snapshot newer than that Moment?").
//! - `now` is the caller's monotonic clock. It drives reminders, the error cooldown and the
//!   expiry of the answered-request memory.
//!
//! Episodes. An episode is one agent waiting on one request. It opens on the first `needs_you`
//! Moment, or the first Snapshot showing that agent in `needs_you` with `exact` confidence, and
//! gives exactly one NeedsYou notice. Every later copy (the hook copy and the log copy of the same
//! alert, repeated snapshots) joins the open episode and is silent. A copy with no request id and a
//! copy with one are the same episode (the id is adopted); two different ids are two episodes.
//! An episode closes on an `answered` Moment, or on a Snapshot whose `t` is strictly newer than the
//! newest `needs_you` evidence seen for it and which no longer shows the agent in `needs_you`.
//! Snapshots are coalesced and can arrive after a Moment, so an older or equal-`t` snapshot never
//! closes anything. For an episode whose only evidence is its opening signal, "newest evidence" is
//! exactly its opening `t`, as the spec words it; later copies move the mark forward, which keeps a
//! late snapshot built between two copies from closing an ask that a newer copy proved still open.
//!
//! Decisions beyond the written rules, each pinned by a test:
//! - Inferred (restored after a restart) `needs_you` is tracked silently, never announced, and
//!   never reminded. A later live signal (Moment or exact snapshot) for the SAME request id stays
//!   quiet too; a live signal with a different or missing id is treated as new and does notify,
//!   because staying quiet there could swallow a real ask.
//! - An episode opened while a pref was off or a demo snapshot was newest is tracked but silent.
//!   Turning a pref on later never fires for it, and it never gets a reminder.
//! - A reminder is scheduled only if the first notice went out with `renotify` on, and it is only
//!   shown if `renotify` is still on when it falls due. A due reminder is always consumed, so
//!   switching the pref back on afterwards never fires it late.
//! - A request replaced by a newer one, and a request whose episode closed on a snapshot, are
//!   remembered as answered so their stale copies cannot reopen them.
//! - `next_due` does not look at prefs (it does not take them); a woken `tick` filters.
//! - Names: tool display name, plus the agent's ordinal only while the newest snapshot holds more
//!   than one agent of that tool. Nothing else from a snapshot ever reaches the text.

use std::collections::{HashMap, HashSet, VecDeque};

use busyholm_contracts::common::{Confidence, NeedsYouReason, Tool};
use busyholm_contracts::moment::MomentKind;
use busyholm_contracts::snapshot::AgentState;
use busyholm_contracts::{Moment, Settings, Snapshot};

pub const RENOTIFY_AFTER_MS: u64 = 300_000;
pub const LONG_TURN_MS: u64 = 120_000;
pub const ERROR_COOLDOWN_MS: u64 = 60_000;

/// Open episodes kept at most (oldest evicted first).
const MAX_EPISODES: usize = 256;
/// Answered (agent, request) pairs and per-agent answered times kept at most.
const MAX_ANSWERED: usize = 512;
/// Long-turn dedupe keys kept at most.
const MAX_LONG_SEEN: usize = 256;
/// How long the answered memory lives, in monotonic time.
const ANSWERED_MEMORY_MS: u64 = 30 * 60_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Prefs {
    pub needs_you: bool,
    pub renotify: bool,
    pub long_turn: bool,
    pub errors: bool,
}

impl From<&Settings> for Prefs {
    fn from(s: &Settings) -> Self {
        let n = &s.notifications;
        Prefs { needs_you: n.needs_you, renotify: n.renotify, long_turn: n.long_turn, errors: n.errors }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoticeKind {
    NeedsYou,
    Reminder,
    LongTurn,
    Error,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    pub kind: NoticeKind,
    /// Internal agent id, never displayed.
    pub agent: String,
    pub tool: Tool,
    pub title: String,
    pub body: String,
}

/// One agent waiting on one request.
struct Episode {
    request: Option<String>,
    tool: Tool,
    reason: NeedsYouReason,
    /// Collector time of the opening signal.
    opened_t: u64,
    /// Newest collector time at which a signal showed the ask still open.
    last_seen_t: u64,
    /// Monotonic time the episode opened (eviction order).
    opened_at: u64,
    /// Opened from an `inferred` snapshot: tracked, never announced.
    inferred: bool,
    /// Monotonic time the single reminder falls due; None when none is pending.
    reminder_due: Option<u64>,
}

/// The newest answer seen for an agent.
struct AnsweredAt {
    /// Collector time.
    t: u64,
    /// Monotonic time it was recorded.
    at: u64,
    had_request: bool,
}

#[derive(Default)]
pub struct Notifier {
    /// True while the newest snapshot is a demo one.
    demo: bool,
    /// At most one open episode per agent.
    episodes: HashMap<String, Episode>,
    /// (agent, request, monotonic time) of answered, replaced or snapshot-closed requests, oldest first.
    answered: VecDeque<(String, String, u64)>,
    answered_at: HashMap<String, AnsweredAt>,
    /// agent id to (tool, ordinal), from the newest snapshots.
    known: HashMap<String, (Tool, u16)>,
    /// Agents per tool in the newest snapshot.
    tool_counts: HashMap<Tool, usize>,
    /// (agent, t) of long turns already seen, oldest first.
    long_seen: VecDeque<(String, u64)>,
    /// Monotonic time of the last error notice per agent.
    last_error: HashMap<String, u64>,
}

fn display_name(tool: Tool) -> &'static str {
    match tool {
        Tool::Claude => "Claude Code",
        Tool::Codex => "Codex",
        Tool::Opencode => "OpenCode",
        Tool::Antigravity => "Antigravity",
        Tool::Gemini => "Gemini CLI",
        Tool::Cursor => "Cursor",
        Tool::Aider => "Aider",
        Tool::Other => "Agent",
    }
}

/// One needs-you signal, from a Moment or a snapshot agent.
struct Signal<'a> {
    agent: &'a str,
    tool: Tool,
    request: Option<&'a str>,
    reason: NeedsYouReason,
    /// Collector time.
    t: u64,
    /// A Moment or an exact snapshot agent. False for `inferred`.
    live: bool,
}

impl Notifier {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn on_snapshot(&mut self, s: &Snapshot, now: u64, prefs: &Prefs) -> Vec<Notice> {
        self.prune(now);
        self.demo = s.demo;

        // Remember tool and ordinal per agent, and how many of each tool there are right now.
        self.tool_counts.clear();
        for a in &s.agents {
            *self.tool_counts.entry(a.tool).or_insert(0) += 1;
            self.known.insert(a.id.clone(), (a.tool, a.ordinal));
        }
        let present: HashSet<&str> = s.agents.iter().map(|a| a.id.as_str()).collect();
        let episodes = &self.episodes;
        self.known.retain(|id, _| present.contains(id.as_str()) || episodes.contains_key(id));

        // Close episodes a strictly newer snapshot no longer shows waiting.
        let waiting: HashSet<&str> =
            s.agents.iter().filter(|a| a.state == AgentState::NeedsYou).map(|a| a.id.as_str()).collect();
        let mut closing: Vec<String> = self
            .episodes
            .iter()
            .filter(|(id, ep)| s.t > ep.last_seen_t && !waiting.contains(id.as_str()))
            .map(|(id, _)| id.clone())
            .collect();
        closing.sort();
        for id in closing {
            if let Some(ep) = self.episodes.remove(&id) {
                self.record_answered(&id, ep.request.as_deref(), s.t, now);
            }
        }

        // Open or refresh the ones that are waiting.
        let mut out = Vec::new();
        for a in s.agents.iter().filter(|a| a.state == AgentState::NeedsYou) {
            let sig = Signal {
                agent: &a.id,
                tool: a.tool,
                request: a.request_id.as_deref(),
                // The contract guarantees a reason for needs_you; Permission is the safe default.
                reason: a.reason.unwrap_or(NeedsYouReason::Permission),
                t: s.t,
                live: a.confidence == Confidence::Exact,
            };
            out.extend(self.signal(sig, now, prefs));
        }
        out
    }

    pub fn on_moment(&mut self, m: &Moment, now: u64, prefs: &Prefs) -> Vec<Notice> {
        self.prune(now);
        let (Some(agent), Some(tool)) = (m.agent.as_deref(), m.tool) else {
            return Vec::new();
        };
        match m.kind {
            MomentKind::NeedsYou => {
                let sig = Signal {
                    agent,
                    tool,
                    request: m.request_id.as_deref(),
                    reason: m.reason.unwrap_or(NeedsYouReason::Permission),
                    t: m.t,
                    live: true,
                };
                self.signal(sig, now, prefs).into_iter().collect()
            }
            MomentKind::Answered => {
                self.on_answered(agent, m.request_id.as_deref(), m.t, now);
                Vec::new()
            }
            MomentKind::TurnEnd => self.on_turn_end(agent, tool, m, now, prefs),
            MomentKind::Error => self.on_error(agent, tool, now, prefs),
            _ => Vec::new(),
        }
    }

    /// Emits the reminders that have fallen due. A due reminder is always consumed, even when it is
    /// not shown (pref off, demo), so it can never fire late.
    pub fn tick(&mut self, now: u64, prefs: &Prefs) -> Vec<Notice> {
        self.prune(now);
        let mut due: Vec<(u64, String)> = self
            .episodes
            .iter()
            .filter_map(|(id, ep)| ep.reminder_due.filter(|d| *d <= now).map(|d| (d, id.clone())))
            .collect();
        due.sort();
        let mut out = Vec::new();
        for (_, id) in due {
            let Some(ep) = self.episodes.get_mut(&id) else { continue };
            ep.reminder_due = None;
            if prefs.renotify && !self.demo {
                let (tool, reason) = (ep.tool, ep.reason);
                out.push(self.notice(NoticeKind::Reminder, &id, tool, Some(reason)));
            }
        }
        out
    }

    /// Monotonic time of the earliest pending reminder, for the caller's timer.
    pub fn next_due(&self) -> Option<u64> {
        self.episodes.values().filter_map(|e| e.reminder_due).min()
    }

    // ------------------------------------------------------------------ episodes

    fn signal(&mut self, sig: Signal<'_>, now: u64, prefs: &Prefs) -> Option<Notice> {
        if self.is_answered(sig.agent, sig.request, sig.t) {
            return None;
        }
        if let Some(ep) = self.episodes.get_mut(sig.agent) {
            let differ = matches!((&ep.request, sig.request), (Some(a), Some(b)) if a != b);
            let same = match (sig.live, ep.inferred) {
                // Live signal against a silently tracked one: same only when the ids prove it.
                (true, true) => matches!((&ep.request, sig.request), (Some(a), Some(b)) if a == b),
                (true, false) | (false, true) => !differ,
                // An inferred snapshot never replaces an exact episode.
                (false, false) => true,
            };
            if same {
                ep.last_seen_t = ep.last_seen_t.max(sig.t);
                if sig.live && ep.request.is_none() {
                    ep.request = sig.request.map(str::to_owned);
                }
                return None;
            }
            // A different request: the old episode is over, and its stale copies must not return.
            let old = self.episodes.remove(sig.agent).and_then(|e| e.request);
            if let Some(r) = old {
                self.push_answered(sig.agent, &r, now);
            }
        }

        let announce = sig.live && prefs.needs_you && !self.demo;
        let mut ep = Episode {
            request: sig.request.map(str::to_owned),
            tool: sig.tool,
            reason: sig.reason,
            opened_t: sig.t,
            last_seen_t: sig.t,
            opened_at: now,
            inferred: !sig.live,
            reminder_due: None,
        };
        if announce && prefs.renotify {
            ep.reminder_due = Some(now.saturating_add(RENOTIFY_AFTER_MS));
        }
        self.insert_episode(sig.agent, ep);
        announce.then(|| self.notice(NoticeKind::NeedsYou, sig.agent, sig.tool, Some(sig.reason)))
    }

    fn insert_episode(&mut self, agent: &str, ep: Episode) {
        if self.episodes.len() >= MAX_EPISODES && !self.episodes.contains_key(agent) {
            let oldest = self.episodes.iter().min_by(|a, b| (a.1.opened_at, a.0).cmp(&(b.1.opened_at, b.0))).map(|(k, _)| k.clone());
            if let Some(k) = oldest {
                self.episodes.remove(&k);
            }
        }
        self.episodes.insert(agent.to_owned(), ep);
    }

    fn on_answered(&mut self, agent: &str, request: Option<&str>, t: u64, now: u64) {
        if let Some(ep) = self.episodes.get(agent) {
            let closes = match (&ep.request, request) {
                // Both ids present: they must match.
                (Some(a), Some(b)) => a == b,
                // An id is missing on one side: only an answer not older than the ask counts.
                _ => t >= ep.opened_t,
            };
            if closes {
                self.episodes.remove(agent);
            }
        }
        self.record_answered(agent, request, t, now);
    }

    // ------------------------------------------------------------------ answered memory

    fn record_answered(&mut self, agent: &str, request: Option<&str>, t: u64, now: u64) {
        if let Some(r) = request {
            self.push_answered(agent, r, now);
        }
        let newer = self.answered_at.get(agent).map_or(true, |a| t >= a.t);
        if newer {
            self.answered_at.insert(agent.to_owned(), AnsweredAt { t, at: now, had_request: request.is_some() });
        }
        while self.answered_at.len() > MAX_ANSWERED {
            let oldest = self.answered_at.iter().min_by(|a, b| (a.1.at, a.0).cmp(&(b.1.at, b.0))).map(|(k, _)| k.clone());
            match oldest {
                Some(k) => self.answered_at.remove(&k),
                None => break,
            };
        }
    }

    fn push_answered(&mut self, agent: &str, request: &str, now: u64) {
        self.answered.push_back((agent.to_owned(), request.to_owned(), now));
        while self.answered.len() > MAX_ANSWERED {
            self.answered.pop_front();
        }
    }

    /// A signal about a request that was already answered (or replaced), or that is not newer than
    /// the agent's last answer when it cannot name its request.
    fn is_answered(&self, agent: &str, request: Option<&str>, t: u64) -> bool {
        if let Some(r) = request {
            if self.answered.iter().any(|(a, q, _)| a == agent && q == r) {
                return true;
            }
        }
        match self.answered_at.get(agent) {
            Some(a) => t <= a.t && (request.is_none() || !a.had_request),
            None => false,
        }
    }

    // ------------------------------------------------------------------ long turns and errors

    fn on_turn_end(&mut self, agent: &str, tool: Tool, m: &Moment, _now: u64, prefs: &Prefs) -> Vec<Notice> {
        let Some(ms) = m.turn_ms else { return Vec::new() };
        if u64::from(ms) <= LONG_TURN_MS {
            return Vec::new();
        }
        // One per (agent, t), however many copies arrive and whatever the prefs said.
        if self.long_seen.iter().any(|(a, t)| a == agent && *t == m.t) {
            return Vec::new();
        }
        self.long_seen.push_back((agent.to_owned(), m.t));
        while self.long_seen.len() > MAX_LONG_SEEN {
            self.long_seen.pop_front();
        }
        if prefs.long_turn && !self.demo {
            vec![self.notice(NoticeKind::LongTurn, agent, tool, None)]
        } else {
            Vec::new()
        }
    }

    fn on_error(&mut self, agent: &str, tool: Tool, now: u64, prefs: &Prefs) -> Vec<Notice> {
        if !prefs.errors || self.demo {
            return Vec::new();
        }
        if let Some(last) = self.last_error.get(agent) {
            if now.saturating_sub(*last) < ERROR_COOLDOWN_MS {
                return Vec::new();
            }
        }
        self.last_error.insert(agent.to_owned(), now);
        vec![self.notice(NoticeKind::Error, agent, tool, None)]
    }

    // ------------------------------------------------------------------ text

    /// "Claude Code", or "Claude Code 2" while the newest snapshot holds more than one Claude.
    fn name(&self, agent: &str, tool: Tool) -> String {
        let base = display_name(tool);
        match self.known.get(agent) {
            Some((t, ordinal)) if *t == tool && self.tool_counts.get(&tool).copied().unwrap_or(0) > 1 => {
                format!("{base} {ordinal}")
            }
            _ => base.to_owned(),
        }
    }

    fn notice(&self, kind: NoticeKind, agent: &str, tool: Tool, reason: Option<NeedsYouReason>) -> Notice {
        let name = self.name(agent, tool);
        let permission = reason == Some(NeedsYouReason::Permission);
        let (title, body) = match kind {
            NoticeKind::NeedsYou => (
                format!("{name} needs you"),
                if permission { "Permission requested" } else { "A question is waiting for your answer" },
            ),
            NoticeKind::Reminder => (
                format!("{name} is still waiting"),
                if permission { "Permission requested 5 minutes ago" } else { "A question has waited 5 minutes" },
            ),
            NoticeKind::LongTurn => (format!("{name} finished a long turn"), "Your turn"),
            NoticeKind::Error => (format!("{name} stopped with an error"), "Check its terminal or editor"),
        };
        Notice { kind, agent: agent.to_owned(), tool, title, body: body.to_owned() }
    }

    // ------------------------------------------------------------------ housekeeping

    /// Drops memory that has aged out (monotonic time).
    fn prune(&mut self, now: u64) {
        while let Some((_, _, at)) = self.answered.front() {
            if now.saturating_sub(*at) > ANSWERED_MEMORY_MS {
                self.answered.pop_front();
            } else {
                break;
            }
        }
        self.answered_at.retain(|_, a| now.saturating_sub(a.at) <= ANSWERED_MEMORY_MS);
        self.last_error.retain(|_, at| now.saturating_sub(*at) < ERROR_COOLDOWN_MS);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use busyholm_contracts::from_value;
    use serde_json::json;

    const T0: u64 = 1_791_806_400_000;
    const ON: Prefs = Prefs { needs_you: true, renotify: true, long_turn: true, errors: true };

    fn id(n: u32) -> String {
        format!("{n:032x}")
    }
    fn needs(t: u64, n: u32, req: u32) -> Moment {
        from_value(json!({
            "schema_version": 1, "kind": "needs_you", "t": t, "agent": id(n), "tool": "claude",
            "reason": "permission", "request_id": id(10_000 + req)
        }))
        .unwrap()
    }
    fn answered(t: u64, n: u32, req: u32) -> Moment {
        from_value(json!({
            "schema_version": 1, "kind": "answered", "t": t, "agent": id(n), "tool": "claude",
            "request_id": id(10_000 + req)
        }))
        .unwrap()
    }

    #[test]
    fn episodes_are_capped_and_the_oldest_is_evicted() {
        let mut nf = Notifier::new();
        for i in 0..(MAX_EPISODES as u32 + 50) {
            nf.on_moment(&needs(T0 + u64::from(i), i, i), u64::from(i), &ON);
        }
        assert_eq!(nf.episodes.len(), MAX_EPISODES);
        assert!(!nf.episodes.contains_key(&id(0)), "the oldest went first");
        assert!(nf.episodes.contains_key(&id(MAX_EPISODES as u32 + 49)));
    }

    #[test]
    fn answered_memory_is_capped_and_ages_out() {
        let mut nf = Notifier::new();
        for i in 0..(MAX_ANSWERED as u32 * 2) {
            nf.on_moment(&answered(T0 + u64::from(i), i, i), u64::from(i), &ON);
        }
        assert!(nf.answered.len() <= MAX_ANSWERED);
        assert!(nf.answered_at.len() <= MAX_ANSWERED);
        nf.tick(ANSWERED_MEMORY_MS + 10_000, &ON);
        assert!(nf.answered.is_empty());
        assert!(nf.answered_at.is_empty());
    }

    #[test]
    fn long_turn_keys_are_capped() {
        let mut nf = Notifier::new();
        for i in 0..(MAX_LONG_SEEN as u32 + 100) {
            let m: Moment = from_value(json!({
                "schema_version": 1, "kind": "turn_end", "t": T0 + u64::from(i), "agent": id(1),
                "tool": "claude", "turn_ms": 500_000
            }))
            .unwrap();
            assert_eq!(nf.on_moment(&m, 0, &ON).len(), 1);
        }
        assert_eq!(nf.long_seen.len(), MAX_LONG_SEEN);
    }
}
