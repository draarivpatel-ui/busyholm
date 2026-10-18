//! Transcript record mapper (structure keys only).
//!
//! Records are parsed into structs that name only the allowlisted keys, so text inside
//! `message.content`, `toolUseResult`, `cwd`, `gitBranch` and the rest are skipped and never
//! stored. Nothing from a line is kept after `on_line` returns except salted ids and counters.
//!
//! The log never raises needs-you alerts (hooks only, SPEC 5.1) and never ends a session.

use std::collections::{HashMap, HashSet, VecDeque};

use busyholm_contracts::agent_event::{
    ErrorClass, EventKind, EventLimit, EventSource, StopReason,
};
use busyholm_contracts::common::{Confidence, Host, InstanceId, LimitWindow, Provider};
use serde::de::IgnoredAny;
use serde::Deserialize;

use crate::env::host_from_entrypoint;
use crate::hooks::{activity_for_tool, error_class};
use crate::pending::Draft;
use crate::time::{epoch_to_ms, parse_iso_ms};
use crate::{Env, PendingEvent};

/// Records older than this (relative to the collector clock) are history.
pub const STALE_MS: u64 = 10 * 60 * 1000;
const SEEN_MESSAGES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileRole {
    Main,
    /// `<session>/subagents/agent-<id>.jsonl`; the raw agent id from the file name.
    Subagent { agent_id: String },
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct TranscriptStats {
    pub records: u64,
    pub bad_lines: u64,
    pub unknown_types: u64,
}

const KNOWN_TYPES: &[&str] = &[
    "user", "assistant", "system", "attachment", "queue-operation", "last-prompt", "mode", "cost-state",
    "ai-title", "custom-title", "agent-name", "atis-latch", "bridge-session", "file-history-snapshot",
    "file-history-delta", "frame-link", "history-suppression", "summary",
];

#[derive(Deserialize)]
struct Rec {
    #[serde(rename = "type")]
    ty: Option<String>,
    subtype: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    entrypoint: Option<String>,
    #[serde(rename = "promptId")]
    prompt_id: Option<String>,
    origin: Option<OriginField>,
    message: Option<MsgField>,
    #[serde(rename = "isApiErrorMessage")]
    is_api_error: Option<bool>,
    #[serde(rename = "apiErrorStatus")]
    api_status: Option<u64>,
    error: Option<ErrField>,
    #[serde(rename = "quotaLimits")]
    quota: Option<QuotaField>,
    #[serde(rename = "retryAttempt")]
    retry_attempt: Option<u64>,
    #[serde(rename = "maxRetries")]
    max_retries: Option<u64>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum OriginField {
    Obj { kind: Option<String> },
    Other(IgnoredAny),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum MsgField {
    Obj(Msg),
    Other(IgnoredAny),
}

#[derive(Deserialize)]
struct Msg {
    id: Option<String>,
    stop_reason: Option<String>,
    usage: Option<UsageField>,
    content: Option<ContentField>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum UsageField {
    Obj(Usage),
    Other(IgnoredAny),
}

#[derive(Deserialize)]
struct Usage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ContentField {
    Blocks(Vec<BlockField>),
    Other(IgnoredAny),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum BlockField {
    Obj {
        #[serde(rename = "type")]
        ty: Option<String>,
        name: Option<String>,
        tool_use_id: Option<String>,
    },
    Other(IgnoredAny),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ErrField {
    Label(String),
    Obj {
        status: Option<u64>,
        #[serde(rename = "type")]
        ty: Option<String>,
    },
    Other(IgnoredAny),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum QuotaField {
    Obj {
        status: Option<String>,
        #[serde(rename = "rateLimitType")]
        rate_limit_type: Option<String>,
        #[serde(rename = "resetsAt")]
        resets_at: Option<f64>,
    },
    Other(IgnoredAny),
}

#[derive(Default)]
pub struct TranscriptReader {
    pub stats: TranscriptStats,
    current_turn: HashMap<InstanceId, String>,
    seen_messages: HashMap<InstanceId, VecDeque<String>>,
    error_latched: HashSet<InstanceId>,
    announced: HashSet<InstanceId>,
}

impl std::fmt::Debug for TranscriptReader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TranscriptReader").field("stats", &self.stats).finish()
    }
}

impl TranscriptReader {
    pub fn new() -> TranscriptReader {
        TranscriptReader::default()
    }

    pub fn on_line(&mut self, line: &[u8], role: &FileRole, env: &Env) -> Vec<PendingEvent> {
        let rec: Rec = match serde_json::from_slice(line) {
            Ok(r) => r,
            Err(_) => {
                self.stats.bad_lines += 1;
                return Vec::new();
            }
        };
        let Some(ty) = rec.ty.as_deref() else {
            self.stats.unknown_types += 1;
            return Vec::new();
        };
        if !KNOWN_TYPES.contains(&ty) && !ty.starts_with("artifact-") {
            self.stats.unknown_types += 1;
            return Vec::new();
        }
        self.stats.records += 1;
        if !matches!(ty, "user" | "assistant" | "system") {
            return Vec::new();
        }
        let Some(session_raw) = rec.session_id.as_deref().filter(|s| !s.is_empty() && s.len() <= 256) else {
            return Vec::new();
        };
        let session = env.instance(session_raw);
        let account = (env.account_of)(&session);
        let (instance, parent) = match role {
            FileRole::Main => (session.clone(), None),
            FileRole::Subagent { agent_id } => (env.instance(agent_id), Some(session.clone())),
        };
        let host = rec
            .entrypoint
            .as_deref()
            .map(host_from_entrypoint)
            .filter(|h| *h != Host::Other)
            .unwrap_or_else(|| env.host(&session));
        let et = rec.timestamp.as_deref().and_then(parse_iso_ms);

        let mut events = Vec::new();
        let turn = self.current_turn.get(&instance).cloned();
        let draft = |kind: EventKind, turn: Option<String>| {
            Draft::new(env, kind, EventSource::Log, Confidence::Exact, instance.clone(), host)
                .parent(parent.clone())
                .account(account.clone())
                .et(et)
                .turn(turn)
        };

        if parent.is_some() && self.announced.insert(instance.clone()) {
            events.push(draft(EventKind::SessionStart, None).done());
        }

        match ty {
            "user" => {
                let human = matches!(&rec.origin, Some(OriginField::Obj { kind: Some(k) }) if k == "human");
                if human {
                    let turn_id = rec.prompt_id.as_deref().filter(|p| !p.is_empty() && p.len() <= 256).map(|p| env.scoped("turn", p));
                    match &turn_id {
                        Some(t) => {
                            self.current_turn.insert(instance.clone(), t.clone());
                        }
                        None => {
                            self.current_turn.remove(&instance);
                        }
                    }
                    self.error_latched.remove(&instance);
                    events.push(draft(EventKind::TurnStart, turn_id).done());
                } else if let Some(MsgField::Obj(Msg { content: Some(ContentField::Blocks(blocks)), .. })) = &rec.message {
                    for block in blocks {
                        if let BlockField::Obj { ty: Some(ty), tool_use_id, .. } = block {
                            if ty == "tool_result" {
                                let request = tool_use_id.as_deref()
                                    .filter(|id| !id.is_empty() && id.len() <= 256)
                                    .map(|id| env.scoped("req", id));
                                // Without correlation, this is activity evidence only. A bare
                                // tool_end would let the collector answer an unrelated alert.
                                let kind = if request.is_some() { EventKind::ToolEnd } else { EventKind::Heartbeat };
                                events.push(draft(kind, turn.clone()).request(request).done());
                            }
                        }
                    }
                }
            }
            "assistant" => {
                if rec.is_api_error == Some(true) {
                    if let Some(e) = self.api_error(&rec, &instance, &draft, turn) {
                        events.push(e);
                    }
                } else if let Some(MsgField::Obj(msg)) = &rec.message {
                    let tokens = self.tokens_once(&instance, msg, env);
                    let stop = match msg.stop_reason.as_deref() {
                        Some("end_turn") => Some(StopReason::EndTurn),
                        Some("max_tokens") => Some(StopReason::MaxTokens),
                        Some("refusal") => Some(StopReason::Refusal),
                        _ => None,
                    };
                    let tool_name = first_tool_use(msg);
                    if let Some(stop) = stop {
                        self.error_latched.remove(&instance);
                        events.push(
                            draft(EventKind::TurnEnd, turn)
                                .detail(|d| d.stop_reason = Some(stop))
                                .tokens(tokens)
                                .done(),
                        );
                    } else if let Some(name) = tool_name {
                        let act = activity_for_tool(&name);
                        events.push(draft(EventKind::Heartbeat, turn).detail(|d| d.activity = Some(act)).tokens(tokens).done());
                    } else if tokens.is_some() {
                        events.push(draft(EventKind::Heartbeat, turn).tokens(tokens).done());
                    }
                }
            }
            "system" => {
                // Early-warning retries are not errors; only exhausted retries are.
                if rec.subtype.as_deref() == Some("api_error") {
                    if let (Some(attempt), Some(max)) = (rec.retry_attempt, rec.max_retries) {
                        if max > 0 && attempt >= max && !self.error_latched.contains(&instance) {
                            let (status, label) = match &rec.error {
                                Some(ErrField::Obj { status, ty }) => (*status, ty.as_deref()),
                                _ => (None, None),
                            };
                            let class = error_class(label, status);
                            self.error_latched.insert(instance.clone());
                            events.push(draft(EventKind::Error, turn).detail(|d| d.error_class = Some(class)).done());
                        }
                    }
                }
            }
            _ => {}
        }
        events
    }

    fn api_error(
        &mut self,
        rec: &Rec,
        instance: &InstanceId,
        draft: &dyn Fn(EventKind, Option<String>) -> Draft,
        turn: Option<String>,
    ) -> Option<PendingEvent> {
        if self.error_latched.contains(instance) {
            return None;
        }
        let label = match &rec.error {
            Some(ErrField::Label(s)) => Some(s.as_str()),
            _ => None,
        };
        if let Some(QuotaField::Obj { status: Some(status), rate_limit_type, resets_at }) = &rec.quota {
            if status == "rejected" {
                let window = match rate_limit_type.as_deref() {
                    Some("five_hour") => LimitWindow::FiveHour,
                    Some(t) if t.starts_with("seven_day") || t == "weekly" => LimitWindow::Weekly,
                    _ => LimitWindow::Unknown,
                };
                let resets = resets_at.and_then(epoch_to_ms);
                self.error_latched.insert(instance.clone());
                return Some(
                    draft(EventKind::LimitHit, turn)
                        .limit(EventLimit { provider: Provider::Claude, window, resets_at: resets })
                        .done(),
                );
            }
        }
        if label == Some("rate_limit") || rec.api_status == Some(429) {
            self.error_latched.insert(instance.clone());
            return Some(
                draft(EventKind::LimitHit, turn)
                    .limit(EventLimit { provider: Provider::Claude, window: LimitWindow::Unknown, resets_at: None })
                    .done(),
            );
        }
        let class: ErrorClass = error_class(label, rec.api_status);
        self.error_latched.insert(instance.clone());
        Some(draft(EventKind::Error, turn).detail(|d| d.error_class = Some(class)).done())
    }

    /// New tokens processed by one API message, counted once per message id: input, output and
    /// cache creation (cache reads repeat context and would swamp the animation).
    fn tokens_once(&mut self, instance: &InstanceId, msg: &Msg, env: &Env) -> Option<u32> {
        let Some(UsageField::Obj(u)) = &msg.usage else { return None };
        if let Some(id) = msg.id.as_deref() {
            let key = env.scoped("msg", id);
            let seen = self.seen_messages.entry(instance.clone()).or_default();
            if seen.contains(&key) {
                return None;
            }
            seen.push_back(key);
            if seen.len() > SEEN_MESSAGES {
                seen.pop_front();
            }
        }
        let total = u.input_tokens.unwrap_or(0).saturating_add(u.output_tokens.unwrap_or(0)).saturating_add(u.cache_creation_input_tokens.unwrap_or(0));
        if total == 0 {
            None
        } else {
            Some(u32::try_from(total.min(1_000_000_000)).unwrap_or(1_000_000_000))
        }
    }

    /// Keep live events; collapse events older than `STALE_MS` to the last state-bearing one
    /// per instance (an app start must not replay history as live activity).
    pub fn reduce_history(events: Vec<PendingEvent>, now_ms: u64) -> Vec<PendingEvent> {
        let is_history = |e: &PendingEvent| now_ms.saturating_sub(e.et.unwrap_or(now_ms)) > STALE_MS;
        let bearing = |e: &PendingEvent| {
            matches!(
                e.kind,
                EventKind::TurnStart | EventKind::TurnEnd | EventKind::TurnInterrupted | EventKind::Error | EventKind::LimitHit
            )
        };
        let mut last_idx: HashMap<InstanceId, usize> = HashMap::new();
        for (i, e) in events.iter().enumerate() {
            if is_history(e) && bearing(e) {
                last_idx.insert(e.instance.clone(), i);
            }
        }
        events
            .into_iter()
            .enumerate()
            .filter(|(i, e)| if is_history(e) { last_idx.get(&e.instance) == Some(i) } else { true })
            .map(|(_, e)| e)
            .collect()
    }

    pub fn forget(&mut self, instance: &InstanceId) {
        self.current_turn.remove(instance);
        self.seen_messages.remove(instance);
        self.error_latched.remove(instance);
        self.announced.remove(instance);
    }
}

fn first_tool_use(msg: &Msg) -> Option<String> {
    match &msg.content {
        Some(ContentField::Blocks(bs)) => bs.iter().find_map(|b| match b {
            BlockField::Obj { ty: Some(t), name, .. } if t == "tool_use" => Some(name.clone().unwrap_or_default()),
            _ => None,
        }),
        _ => None,
    }
}
