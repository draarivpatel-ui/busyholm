//! Snapshot v2: the full live state sent by the core to every window (SPEC 5.4).

use serde::{Deserialize, Serialize};

use crate::check;
use crate::validate::{ContractError, Validate};
use crate::common::{
    nullable, present, Activity, Confidence, Host, InstanceId, Ms, NeedsYouReason, Provider, Tool,
    Version, Window,
};

/// Agent state machine value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    Starting,
    Working,
    NeedsYou,
    YourTurn,
    Error,
    Limited,
    Idle,
    Unknown,
}

/// Whether a tool is currently running.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Presence {
    Present,
    Offline,
}

/// Hook install state for a tool. `pending_review` means installed but not yet
/// trusted inside the agent (Codex /hooks).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HooksStatus {
    Installed,
    Missing,
    PendingReview,
    Unsupported,
}

/// Whether alerts for a connector are proven live.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Coverage {
    /// An onboarding round trip proved hook delivery, so alerts are live.
    Verified,
    /// States work but alerts do not (yet).
    Degraded,
    /// This tool, host or OS cannot raise alerts in v0.1.
    Unsupported,
}

/// Why coverage is not verified.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverageReason {
    HooksMissing,
    HooksPendingReview,
    RoundTripPending,
    RoundTripFailed,
    ReceiverUnreachable,
    BareSession,
    NoPermissionEvent,
    ExperimentalAdapter,
    RemoteSession,
    OsUnsupported,
    Other,
}

/// One live agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotAgent {
    /// Opaque to every consumer; equal to the AgentEvent instance.
    pub id: InstanceId,
    pub tool: Tool,
    pub host: Host,
    /// 1.. per tool, stable for the session; picks the scarf colour (max 999).
    pub ordinal: u16,
    /// Parent agent id for a subagent helper, otherwise null. Required (never omitted).
    #[serde(deserialize_with = "nullable")]
    pub parent: Option<InstanceId>,
    /// The connector (agent data root) this agent was seen through.
    pub root_id: InstanceId,
    /// Salted account hash, or null when unknown.
    #[serde(deserialize_with = "nullable")]
    pub account_id: Option<InstanceId>,
    /// Salted session hash, or null when not known yet.
    #[serde(deserialize_with = "nullable")]
    pub session_id: Option<InstanceId>,
    /// Salted hash of the current or last turn, or null.
    #[serde(deserialize_with = "nullable")]
    pub turn_id: Option<InstanceId>,
    /// Salted hash of the pending request; non-null only when state is `needs_you`.
    #[serde(deserialize_with = "nullable")]
    pub request_id: Option<InstanceId>,
    pub state: AgentState,
    /// Present exactly when state is `needs_you`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub reason: Option<NeedsYouReason>,
    /// Optional, and only when state is `working`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub activity: Option<Activity>,
    pub confidence: Confidence,
    /// When the current state began.
    pub since: Ms,
    /// When the session began.
    pub started_at: Ms,
    /// Optional, and only when state is `limited` (omitted when the reset time is unknown).
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub limited_until: Option<Ms>,
    /// ONLY when the user opted in to project names: the last folder segment, never a path.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub project_label: Option<String>,
}

/// One connector: a tool seen through one agent data root.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolStatus {
    pub tool: Tool,
    pub root_id: InstanceId,
    pub presence: Presence,
    pub hooks: HooksStatus,
    pub coverage: Coverage,
    /// Why coverage is not verified; null exactly when coverage is `verified`.
    #[serde(deserialize_with = "nullable")]
    pub coverage_reason: Option<CoverageReason>,
}

/// One usage-window reading. A missing entry means no data; never infer 0%.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotLimit {
    pub provider: Provider,
    pub window: Window,
    /// Salted account hash; null when the source does not identify the account
    /// (the entry is then per root).
    #[serde(deserialize_with = "nullable")]
    pub account_id: Option<InstanceId>,
    /// The connector the newest sample came through.
    pub root_id: InstanceId,
    /// Percent used, 0 to 100.
    pub used_pct: f64,
    pub resets_at: Ms,
    pub observed_at: Ms,
    /// True when no fresh sample arrived for 30 min; the value is the last good one.
    pub stale: bool,
}

/// How many agents need the user.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attention {
    /// Number of agents in state `needs_you` (max 64).
    pub needs_you: u8,
    /// `since` of the longest-waiting `needs_you` agent; null exactly when `needs_you` is 0.
    #[serde(deserialize_with = "nullable")]
    pub oldest_since: Option<Ms>,
}

/// The full live state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    /// Schema version, always 2.
    pub schema_version: Version<2>,
    pub t: Ms,
    /// True while demo mode drives the snapshot.
    pub demo: bool,
    /// At most 64 agents.
    pub agents: Vec<SnapshotAgent>,
    /// At most 8 tool statuses, one per tool.
    pub tools: Vec<ToolStatus>,
    /// At most 4 entries, one per provider and window.
    pub limits: Vec<SnapshotLimit>,
    pub attention: Attention,
}

fn validate_agent(a: &SnapshotAgent, path: &str) -> Result<(), ContractError> {
    check::instance(&check::child(path, "id"), &a.id)?;
    check::int_range(&check::child(path, "ordinal"), u64::from(a.ordinal), 1, 999)?;
    check::opt_instance(&check::child(path, "parent"), a.parent.as_ref())?;
    check::ms(&check::child(path, "since"), a.since)?;
    check::ms(&check::child(path, "started_at"), a.started_at)?;
    check::opt_ms(&check::child(path, "limited_until"), a.limited_until)?;
    check::instance(&check::child(path, "root_id"), &a.root_id)?;
    for (name, v) in [
        ("account_id", &a.account_id),
        ("session_id", &a.session_id),
        ("turn_id", &a.turn_id),
        ("request_id", &a.request_id),
    ] {
        check::opt_instance(&check::child(path, name), v.as_ref())?;
    }
    // request_id is null unless state is needs_you.
    check::ensure(
        a.request_id.is_none() || a.state == AgentState::NeedsYou,
        &check::child(path, "request_id"),
        "must be null unless state is needs_you",
    )?;
    if let Some(label) = &a.project_label {
        let p = check::child(path, "project_label");
        check::chars(&p, label, 1, 128)?;
        check::pattern(&p, label, check::is_project_label, "a folder name with no path separator or control character")?;
    }
    // reason is present exactly when state is needs_you.
    check::presence(
        path,
        "reason",
        a.reason.is_some(),
        a.state == AgentState::NeedsYou,
        "state is needs_you",
    )?;
    // activity only when working; limited_until only when limited.
    check::ensure(
        a.activity.is_none() || a.state == AgentState::Working,
        &check::child(path, "activity"),
        "only allowed when state is working",
    )?;
    check::ensure(
        a.limited_until.is_none() || a.state == AgentState::Limited,
        &check::child(path, "limited_until"),
        "only allowed when state is limited",
    )
}

impl Validate for Snapshot {
    fn validate(&self) -> Result<(), ContractError> {
        check::ms("/t", self.t)?;

        check::max_items("/agents", self.agents.len(), 64)?;
        for (i, a) in self.agents.iter().enumerate() {
            validate_agent(a, &check::at("/agents", i))?;
        }
        check::unique_by("/agents", &self.agents, "id", |a| a.id.as_str())?;
        check::unique_by("/agents", &self.agents, "tool and ordinal", |a| (a.tool, a.ordinal))?;

        check::max_items("/tools", self.tools.len(), 16)?;
        for (i, t) in self.tools.iter().enumerate() {
            let p = check::at("/tools", i);
            check::instance(&check::child(&p, "root_id"), &t.root_id)?;
            // coverage_reason is null exactly when coverage is verified.
            check::ensure(
                t.coverage_reason.is_none() == (t.coverage == Coverage::Verified),
                &check::child(&p, "coverage_reason"),
                "must be null when coverage is verified and set otherwise",
            )?;
        }
        check::unique_by("/tools", &self.tools, "tool and root_id", |t| (t.tool, t.root_id.as_str()))?;

        check::max_items("/limits", self.limits.len(), 16)?;
        for (i, l) in self.limits.iter().enumerate() {
            let p = check::at("/limits", i);
            check::opt_instance(&check::child(&p, "account_id"), l.account_id.as_ref())?;
            check::instance(&check::child(&p, "root_id"), &l.root_id)?;
            check::num_range(&check::child(&p, "used_pct"), l.used_pct, 0.0, 100.0)?;
            check::ms(&check::child(&p, "resets_at"), l.resets_at)?;
            check::ms(&check::child(&p, "observed_at"), l.observed_at)?;
        }
        check::unique_by("/limits", &self.limits, "provider, window, account_id and root_id", |l| {
            (l.provider, l.window, l.account_id.as_deref(), l.root_id.as_str())
        })?;

        let att = &self.attention;
        check::int_range("/attention/needs_you", u64::from(att.needs_you), 0, 64)?;
        check::opt_ms("/attention/oldest_since", att.oldest_since)?;
        // oldest_since is null exactly when needs_you is 0.
        if att.needs_you == 0 {
            check::ensure(att.oldest_since.is_none(), "/attention/oldest_since", "must be null when needs_you is 0")?;
        } else {
            check::ensure(att.oldest_since.is_some(), "/attention/oldest_since", "must be set when needs_you is above 0")?;
        }
        Ok(())
    }
}
