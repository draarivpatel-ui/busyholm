//! AgentEvent v1: the collector's internal, normalised event (SPEC 5.3).
//!
//! It carries no free text at all: every string is an enum or a salted hash.

use serde::{Deserialize, Serialize};

use crate::check;
use crate::validate::{ContractError, Validate};
use crate::common::{
    nullable, present, Activity, Confidence, Host, InstanceId, LimitWindow, Ms, Provider, Tool,
    Version, Window,
};

/// What happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    SessionStart,
    SessionEnd,
    TurnStart,
    ToolEnd,
    NeedsPermission,
    NeedsAnswer,
    Answered,
    TurnEnd,
    TurnInterrupted,
    Error,
    LimitHit,
    UsageSample,
    ProcessUp,
    ProcessDown,
    Heartbeat,
}

/// Which kind of source produced the event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventSource {
    Hook,
    Registry,
    Log,
    Process,
    Plugin,
    Poll,
}

/// Closed error classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorClass {
    Overloaded,
    ServerError,
    Network,
    Auth,
    Billing,
    InvalidRequest,
    ModelNotFound,
    MaxOutputTokens,
    Unknown,
}

/// The notification type that produced an event, when the source was a notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Notification {
    PermissionPrompt,
    ElicitationDialog,
    ElicitationUrlDialog,
    AgentNeedsInput,
    ElicitationResponse,
    ElicitationComplete,
    IdlePrompt,
    QuotaAutoResumeFired,
    QuotaAutoResumeStale,
    QuotaAutoResumeDisabled,
    Other,
}

/// Why a turn stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    Interrupted,
    MaxTokens,
    Refusal,
    Other,
}

/// Why a session ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    Clear,
    Resume,
    Logout,
    Exit,
    ProcessGone,
    Other,
}

/// Closed-enum detail. Omit `detail` entirely when there is nothing to say
/// (the schema requires at least one property; that check is semantic).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventDetail {
    /// From the tool NAME only. Only on `tool_end` and `heartbeat`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub activity: Option<Activity>,
    /// Only on `error`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub error_class: Option<ErrorClass>,
    /// The notification type that produced this event.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub notification: Option<Notification>,
    /// Only on `turn_end` and `turn_interrupted`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub stop_reason: Option<StopReason>,
    /// Only on `session_end`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub end_reason: Option<EndReason>,
}

/// One usage-window sample. A source without a value for a window yields no sample (never 0%).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventUsage {
    pub provider: Provider,
    pub window: Window,
    /// Percent used, 0 to 100.
    pub used_pct: f64,
    /// Milliseconds, converted at the edge from the sources' epoch seconds.
    pub resets_at: Ms,
    pub observed_at: Ms,
}

/// A limit was hit. The window and reset time are often unknown at the source.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventLimit {
    pub provider: Provider,
    pub window: LimitWindow,
    /// Reset time in milliseconds, or null when unknown. Required (never omitted).
    #[serde(deserialize_with = "nullable")]
    pub resets_at: Option<Ms>,
}

/// The collector's normalised event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentEvent {
    /// Schema version, always 1.
    pub v: Version<1>,
    pub agent: Tool,
    /// Salted hash of the session or thread id (32 lowercase hex characters).
    pub instance: InstanceId,
    /// The parent session's instance for a subagent, otherwise null. Required (never omitted).
    #[serde(deserialize_with = "nullable")]
    pub parent: Option<InstanceId>,
    /// The connector (agent data root) that produced the event: a salted hash.
    pub root_id: InstanceId,
    /// Salted hash of the provider account, or null when the source does not say.
    #[serde(deserialize_with = "nullable")]
    pub account_id: Option<InstanceId>,
    /// Salted hash of the session or thread id, or null when not known yet.
    #[serde(deserialize_with = "nullable")]
    pub session_id: Option<InstanceId>,
    /// Salted hash of the turn (prompt) id, or null when the source cannot supply it.
    #[serde(deserialize_with = "nullable")]
    pub turn_id: Option<InstanceId>,
    /// Salted hash of the permission or question request id, or null. Non-null only
    /// on `needs_permission`, `needs_answer`, `answered` and `tool_end`.
    #[serde(deserialize_with = "nullable")]
    pub request_id: Option<InstanceId>,
    pub host: Host,
    pub kind: EventKind,
    pub source: EventSource,
    pub confidence: Confidence,
    /// Collector clock when the event was observed.
    pub t: Ms,
    /// Source time, only when the source states one. Omitted otherwise (never null).
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub et: Option<Ms>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub detail: Option<EventDetail>,
    /// Present exactly when `kind` is `usage_sample`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub usage: Option<EventUsage>,
    /// Present exactly when `kind` is `limit_hit`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub limit: Option<EventLimit>,
    /// Tokens since the previous sample for this instance (animation only).
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub tokens_delta: Option<u32>,
}

impl Validate for AgentEvent {
    fn validate(&self) -> Result<(), ContractError> {
        check::instance("/instance", &self.instance)?;
        check::opt_instance("/parent", self.parent.as_ref())?;
        check::instance("/root_id", &self.root_id)?;
        check::opt_instance("/account_id", self.account_id.as_ref())?;
        check::opt_instance("/session_id", self.session_id.as_ref())?;
        check::opt_instance("/turn_id", self.turn_id.as_ref())?;
        check::opt_instance("/request_id", self.request_id.as_ref())?;
        check::ms("/t", self.t)?;
        check::opt_ms("/et", self.et)?;
        if let Some(n) = self.tokens_delta {
            check::int_range("/tokens_delta", u64::from(n), 0, 1_000_000_000)?;
        }
        if let Some(u) = &self.usage {
            check::num_range("/usage/used_pct", u.used_pct, 0.0, 100.0)?;
            check::ms("/usage/resets_at", u.resets_at)?;
            check::ms("/usage/observed_at", u.observed_at)?;
        }
        if let Some(l) = &self.limit {
            check::opt_ms("/limit/resets_at", l.resets_at)?;
        }

        let kind = self.kind;
        // request_id only on the kinds that open or close a request.
        check::ensure(
            self.request_id.is_none()
                || matches!(
                    kind,
                    EventKind::NeedsPermission
                        | EventKind::NeedsAnswer
                        | EventKind::Answered
                        | EventKind::ToolEnd
                ),
            "/request_id",
            "must be null unless kind is needs_permission, needs_answer, answered or tool_end",
        )?;
        // usage is present exactly when kind is usage_sample.
        check::presence(
            "",
            "usage",
            self.usage.is_some(),
            kind == EventKind::UsageSample,
            "kind is usage_sample",
        )?;
        // limit is present exactly when kind is limit_hit.
        check::presence(
            "",
            "limit",
            self.limit.is_some(),
            kind == EventKind::LimitHit,
            "kind is limit_hit",
        )?;
        // Only Claude and Codex report limits, and the provider is the reporting agent.
        let provider = match self.agent {
            Tool::Claude => Some(Provider::Claude),
            Tool::Codex => Some(Provider::Codex),
            _ => None,
        };
        match provider {
            Some(p) => {
                if let Some(u) = &self.usage {
                    check::ensure(u.provider == p, "/usage/provider", "must equal the reporting agent")?;
                }
                if let Some(l) = &self.limit {
                    check::ensure(l.provider == p, "/limit/provider", "must equal the reporting agent")?;
                }
            }
            None => {
                check::ensure(self.usage.is_none(), "/usage", "only allowed when agent is claude or codex")?;
                check::ensure(self.limit.is_none(), "/limit", "only allowed when agent is claude or codex")?;
            }
        }

        if let Some(d) = &self.detail {
            let any = d.activity.is_some()
                || d.error_class.is_some()
                || d.notification.is_some()
                || d.stop_reason.is_some()
                || d.end_reason.is_some();
            check::ensure(any, "/detail", "must have at least 1 property; omit detail instead")?;
            check::ensure(
                d.activity.is_none() || matches!(kind, EventKind::ToolEnd | EventKind::Heartbeat),
                "/detail/activity",
                "only allowed when kind is tool_end or heartbeat",
            )?;
            check::ensure(
                d.error_class.is_none() || kind == EventKind::Error,
                "/detail/error_class",
                "only allowed when kind is error",
            )?;
            check::ensure(
                d.stop_reason.is_none()
                    || matches!(kind, EventKind::TurnEnd | EventKind::TurnInterrupted),
                "/detail/stop_reason",
                "only allowed when kind is turn_end or turn_interrupted",
            )?;
            check::ensure(
                d.end_reason.is_none() || kind == EventKind::SessionEnd,
                "/detail/end_reason",
                "only allowed when kind is session_end",
            )?;
        }
        Ok(())
    }
}
