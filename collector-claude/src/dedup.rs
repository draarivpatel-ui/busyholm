//! Cross-source dedup (SPEC Revision 1): one completed-turn event per turn whichever
//! source reports it first, one alert per request, late notifications for an answered
//! request ignored.
//!
//! Everything is keyed by salted ids; nothing here holds a raw id or text.

use std::collections::{HashMap, VecDeque};
use collector::{Clock, SystemClock};

use busyholm_contracts::agent_event::{EventKind, EventSource, Notification};
use busyholm_contracts::common::InstanceId;

use crate::PendingEvent;

/// A copy of a completed turn or an error from another source this soon is a duplicate
/// when the turn id cannot tell the two apart.
const UNKEYED_WINDOW_MS: u64 = 10_000;
/// A Claude `permission_prompt` notification arrives about 6 s after the request; one this
/// soon after an answered request is that request's late copy.
const LATE_NOTIFICATION_MS: u64 = 10_000;
const SEEN_TURNS: usize = 32;
const SEEN_REQUESTS: usize = 32;
const MAX_INSTANCES: usize = 4096;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DedupStats {
    pub turn_dupes: u64,
    pub request_dupes: u64,
    pub late_notifications: u64,
    pub ended_dupes: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReqKind {
    Permission,
    Question,
}

struct Req {
    kind: ReqKind,
    id: Option<String>,
    answered_at: Option<u64>,
}

#[derive(Default)]
struct Inst {
    open_turn: bool,
    turn_generation: u64,
    current_turn: Option<String>,
    ended: bool,
    seen_end_turns: VecDeque<String>,
    last_end: Option<(Option<String>, EventSource, u64, u64)>,
    last_terminal: Option<(EventKind, EventSource, u64, u64)>,
    reqs: Vec<Req>,
    answered_requests: VecDeque<String>,
}

impl Inst {
    fn answer_requests(&mut self, mono_ms: u64, request: Option<&String>) {
        for r in &mut self.reqs {
            let other_tool = matches!((&r.id, request), (Some(a), Some(b)) if a != b);
            if other_tool || r.answered_at.is_some() {
                continue;
            }
            r.answered_at = Some(mono_ms);
            if let Some(id) = &r.id {
                self.answered_requests.push_back(id.clone());
                if self.answered_requests.len() > SEEN_REQUESTS {
                    self.answered_requests.pop_front();
                }
            }
        }
    }
}

#[derive(Default)]
pub struct Dedup {
    pub stats: DedupStats,
    insts: HashMap<InstanceId, Inst>,
}

impl std::fmt::Debug for Dedup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Dedup").field("stats", &self.stats).field("instances", &self.insts.len()).finish()
    }
}

fn is_fallback_notification(ev: &PendingEvent) -> bool {
    ev.source == EventSource::Registry
        || matches!(
            ev.detail.as_ref().and_then(|d| d.notification),
            Some(
                Notification::PermissionPrompt
                    | Notification::ElicitationDialog
                    | Notification::ElicitationUrlDialog
                    | Notification::AgentNeedsInput
            )
        )
}

impl Dedup {
    pub fn new() -> Dedup {
        Dedup::default()
    }

    /// A turn is open for this instance (started, not yet ended).
    pub fn has_open_turn(&self, instance: &InstanceId) -> bool {
        self.insts.get(instance).is_some_and(|i| i.open_turn)
    }

    /// Observe every event in arrival order; `false` means drop it.
    pub fn admit(&mut self, ev: &PendingEvent) -> bool {
        self.admit_at(ev, SystemClock.monotonic_ms())
    }

    /// The adapter supplies the collector's monotonic clock; tests can advance it explicitly.
    pub fn admit_at(&mut self, ev: &PendingEvent, mono_ms: u64) -> bool {
        if self.insts.len() > MAX_INSTANCES {
            self.insts.retain(|_, i| !i.ended);
        }
        let now = ev.t;
        let st = self.insts.entry(ev.instance.clone()).or_default();
        match ev.kind {
            EventKind::SessionStart => {
                st.ended = false;
            }
            EventKind::SessionEnd => {
                if st.ended {
                    self.stats.ended_dupes += 1;
                    return false;
                }
                st.ended = true;
                st.open_turn = false;
            }
            EventKind::TurnStart => {
                let new_turn = match (&st.current_turn, &ev.turn_id) {
                    (Some(a), Some(b)) => a != b,
                    _ => !st.open_turn,
                };
                if new_turn {
                    st.turn_generation = st.turn_generation.wrapping_add(1);
                    st.current_turn = ev.turn_id.clone();
                } else if st.current_turn.is_none() {
                    st.current_turn = ev.turn_id.clone();
                }
                st.open_turn = true;
                // A new prompt answers whatever was pending.
                st.answer_requests(mono_ms, None);
            }
            EventKind::TurnEnd => {
                let id = ev.turn_id.clone();
                if let Some(id) = &id {
                    if st.seen_end_turns.contains(id) {
                        self.stats.turn_dupes += 1;
                        return false;
                    }
                }
                if let Some((last_id, last_src, last_t, generation)) = &st.last_end {
                    let unkeyed = last_id.is_none() || id.is_none();
                    if *generation == st.turn_generation && unkeyed && *last_src != ev.source
                        && now.abs_diff(*last_t) <= UNKEYED_WINDOW_MS {
                        self.stats.turn_dupes += 1;
                        return false;
                    }
                }
                if let Some(id) = id.clone() {
                    st.seen_end_turns.push_back(id);
                    if st.seen_end_turns.len() > SEEN_TURNS {
                        st.seen_end_turns.pop_front();
                    }
                }
                st.last_end = Some((id, ev.source, now, st.turn_generation));
                st.open_turn = false;
                st.answer_requests(mono_ms, None);
            }
            EventKind::TurnInterrupted | EventKind::Error | EventKind::LimitHit => {
                if matches!(ev.kind, EventKind::Error | EventKind::LimitHit) {
                    if let Some((k, src, t, generation)) = &st.last_terminal {
                        if *generation == st.turn_generation && *k == ev.kind && *src != ev.source
                            && now.abs_diff(*t) <= UNKEYED_WINDOW_MS {
                            self.stats.turn_dupes += 1;
                            return false;
                        }
                    }
                    st.last_terminal = Some((ev.kind, ev.source, now, st.turn_generation));
                }
                st.open_turn = false;
                st.answer_requests(mono_ms, None);
            }
            EventKind::NeedsPermission | EventKind::NeedsAnswer => {
                let kind = if ev.kind == EventKind::NeedsPermission { ReqKind::Permission } else { ReqKind::Question };
                let weak = is_fallback_notification(ev);
                if ev.request_id.as_ref().is_some_and(|id| st.answered_requests.contains(id)) {
                    self.stats.late_notifications += 1;
                    return false;
                }
                let existing = st.reqs.iter_mut().find(|r| r.kind == kind);
                match existing {
                    Some(r) if r.answered_at.is_none() => {
                        let same = match (&r.id, &ev.request_id) {
                            (Some(a), Some(b)) => a == b,
                            _ => true,
                        };
                        if same {
                            if r.id.is_none() {
                                r.id = ev.request_id.clone(); // a hook identity upgrades a fallback alert
                            }
                            self.stats.request_dupes += 1;
                            return false;
                        }
                        *r = Req { kind, id: ev.request_id.clone(), answered_at: None };
                    }
                    Some(r) => {
                        if weak && ev.request_id.is_none()
                            && mono_ms.saturating_sub(r.answered_at.unwrap()) <= LATE_NOTIFICATION_MS {
                            self.stats.late_notifications += 1;
                            return false;
                        }
                        *r = Req { kind, id: ev.request_id.clone(), answered_at: None };
                    }
                    None => st.reqs.push(Req { kind, id: ev.request_id.clone(), answered_at: None }),
                }
                st.open_turn = true;
            }
            EventKind::Answered | EventKind::ToolEnd => {
                if ev.kind == EventKind::ToolEnd && ev.request_id.is_none()
                    && st.reqs.iter().any(|r| r.answered_at.is_none() && r.id.is_some()) {
                    return false;
                }
                st.answer_requests(mono_ms, ev.request_id.as_ref());
            }
            _ => {}
        }
        true
    }
}
