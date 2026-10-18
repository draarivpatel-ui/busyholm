//! PendingAlerts v1: `pending-alerts.json` in the app data folder (SPEC Revision 1, item 3).
//!
//! The minimal record that lets a waiting-for-you alert survive an app restart.
//! Ids and enums only: no text, no paths.

use serde::{Deserialize, Serialize};

use crate::check;
use crate::common::{nullable, Host, InstanceId, Ms, NeedsYouReason, Privacy, Tool, Version};
use crate::validate::{ContractError, Validate};

/// One agent waiting on the user.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PendingAlert {
    /// Snapshot agent id (the AgentEvent instance).
    pub agent: InstanceId,
    pub tool: Tool,
    pub host: Host,
    pub root_id: InstanceId,
    #[serde(deserialize_with = "nullable")]
    pub account_id: Option<InstanceId>,
    #[serde(deserialize_with = "nullable")]
    pub session_id: Option<InstanceId>,
    /// The request the alert is keyed by, or null when the source gave none
    /// (then the agent is the key).
    #[serde(deserialize_with = "nullable")]
    pub request_id: Option<InstanceId>,
    pub reason: NeedsYouReason,
    /// When the agent started waiting.
    pub since: Ms,
    /// The last time a fresh signal confirmed the wait.
    pub last_confirmed_at: Ms,
}

/// The pending-alerts file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PendingAlerts {
    /// Schema version, always 1.
    pub schema_version: Version<1>,
    pub privacy: Privacy,
    pub saved_at: Ms,
    /// One record per agent waiting on the user (at most 64, unique by agent).
    pub alerts: Vec<PendingAlert>,
}

impl Validate for PendingAlerts {
    fn validate(&self) -> Result<(), ContractError> {
        check::ms("/saved_at", self.saved_at)?;
        check::max_items("/alerts", self.alerts.len(), 64)?;
        for (i, a) in self.alerts.iter().enumerate() {
            let p = check::at("/alerts", i);
            check::instance(&check::child(&p, "agent"), &a.agent)?;
            check::instance(&check::child(&p, "root_id"), &a.root_id)?;
            check::opt_instance(&check::child(&p, "account_id"), a.account_id.as_ref())?;
            check::opt_instance(&check::child(&p, "session_id"), a.session_id.as_ref())?;
            check::opt_instance(&check::child(&p, "request_id"), a.request_id.as_ref())?;
            check::ms(&check::child(&p, "since"), a.since)?;
            check::ms(&check::child(&p, "last_confirmed_at"), a.last_confirmed_at)?;
        }
        check::unique_by("/alerts", &self.alerts, "agent", |a| a.agent.as_str())
    }
}
