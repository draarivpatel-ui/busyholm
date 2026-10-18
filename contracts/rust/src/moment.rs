//! Moment v1: a one-off happening, sent immediately (not coalesced) to every window (SPEC 5.4).

use serde::{Deserialize, Serialize};

use crate::check;
use crate::validate::{ContractError, Validate};
use crate::common::{
    present, InstanceId, MilestoneId, Ms, NeedsYouReason, Provider, StructureId, Tool, Version,
};

/// What kind of moment this is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MomentKind {
    TurnEnd,
    NeedsYou,
    Answered,
    Error,
    Recovered,
    LimitHit,
    LimitReset,
    WeeklyReset,
    BuildComplete,
    Milestone,
}

/// A one-off happening. Flat on purpose: which optional fields appear for
/// which `kind` is a semantic rule, not a type-level one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Moment {
    /// Schema version, always 1.
    pub schema_version: Version<1>,
    pub kind: MomentKind,
    pub t: Ms,
    /// Snapshot agent id. Always paired with `tool`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub agent: Option<InstanceId>,
    /// Always paired with `agent`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub tool: Option<Tool>,
    /// Present exactly when `kind` is `needs_you`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub reason: Option<NeedsYouReason>,
    /// Optional, `turn_end` only: how long the turn ran (max 604800000).
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub turn_ms: Option<u32>,
    /// Present exactly when `kind` is `limit_hit`, `limit_reset` or `weekly_reset`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub provider: Option<Provider>,
    /// Present exactly when `kind` is `build_complete`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub structure: Option<StructureId>,
    /// Present exactly when `kind` is `build_complete`: the stage just completed (1 to 3).
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub stage: Option<u8>,
    /// Optional, `needs_you` and `answered` only: the request the alert is keyed by.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub request_id: Option<InstanceId>,
    /// Present exactly when `kind` is `milestone`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub milestone: Option<MilestoneId>,
}

impl Validate for Moment {
    fn validate(&self) -> Result<(), ContractError> {
        use MomentKind::*;
        check::ms("/t", self.t)?;
        check::opt_instance("/agent", self.agent.as_ref())?;
        check::opt_instance("/request_id", self.request_id.as_ref())?;
        if let Some(n) = self.turn_ms {
            check::int_range("/turn_ms", u64::from(n), 0, 604_800_000)?;
        }
        if let Some(n) = self.stage {
            check::int_range("/stage", u64::from(n), 1, 3)?;
        }

        let kind = self.kind;
        // dependentRequired: agent and tool come as a pair.
        if self.agent.is_some() {
            check::ensure(self.tool.is_some(), "", "\"tool\" is required when \"agent\" is present")?;
        }
        if self.tool.is_some() {
            check::ensure(self.agent.is_some(), "", "\"agent\" is required when \"tool\" is present")?;
        }
        // Agent moments name their agent; island moments are not tied to one.
        if matches!(kind, TurnEnd | NeedsYou | Answered | Error | Recovered) {
            check::ensure(self.agent.is_some() && self.tool.is_some(), "", "\"agent\" and \"tool\" are required for agent moments")?;
        }
        if matches!(kind, LimitReset | WeeklyReset | BuildComplete | Milestone) {
            check::ensure(self.agent.is_none(), "/agent", "not allowed on island moments")?;
            check::ensure(self.tool.is_none(), "/tool", "not allowed on island moments")?;
        }
        check::ensure(
            self.request_id.is_none() || matches!(kind, NeedsYou | Answered),
            "/request_id",
            "only allowed when kind is needs_you or answered",
        )?;
        check::presence("", "reason", self.reason.is_some(), kind == NeedsYou, "kind is needs_you")?;
        check::ensure(
            self.turn_ms.is_none() || kind == TurnEnd,
            "/turn_ms",
            "only allowed when kind is turn_end",
        )?;
        check::presence(
            "",
            "provider",
            self.provider.is_some(),
            matches!(kind, LimitHit | LimitReset | WeeklyReset),
            "kind is limit_hit, limit_reset or weekly_reset",
        )?;
        check::presence("", "structure", self.structure.is_some(), kind == BuildComplete, "kind is build_complete")?;
        check::presence("", "stage", self.stage.is_some(), kind == BuildComplete, "kind is build_complete")?;
        check::presence("", "milestone", self.milestone.is_some(), kind == Milestone, "kind is milestone")?;
        Ok(())
    }
}
