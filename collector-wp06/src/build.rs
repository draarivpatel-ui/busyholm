//! The one place that constructs an AgentEvent, so a contract change touches one function.
use busyholm_contracts::{
    agent_event::{EventDetail, EventKind, EventSource},
    common::{Confidence, Host, Tool},
    AgentEvent,
};

use crate::ident::Identity;

/// Shared facts of every event one connector produces.
pub struct Builder<'a> {
    pub ids: &'a dyn Identity,
    pub tool: Tool,
    /// Raw connector key (the agent's data root); hashed into `root_id`.
    pub root_raw: &'a str,
    pub host: Host,
    pub now_ms: u64,
}

impl Builder<'_> {
    /// An event for the thing identified by `raw`. `parent_raw` links a subagent to its parent
    /// session, whose id then also becomes `session_id`; a top-level session is its own
    /// `session_id`. Pass `has_session = false` for sources that have no session notion
    /// (a bare process).
    pub fn event(
        &self,
        kind: EventKind,
        source: EventSource,
        confidence: Confidence,
        raw: &str,
        parent_raw: Option<&str>,
        has_session: bool,
    ) -> AgentEvent {
        let instance = self.ids.instance(self.tool, raw);
        let parent = parent_raw.map(|p| self.ids.instance(self.tool, p));
        let session_id = if has_session { Some(parent.clone().unwrap_or_else(|| instance.clone())) } else { None };
        AgentEvent {
            v: Default::default(),
            agent: self.tool,
            instance,
            parent,
            root_id: self.ids.instance(self.tool, &format!("root:{}", self.root_raw)),
            account_id: None,
            session_id,
            turn_id: None,
            request_id: None,
            host: self.host,
            kind,
            source,
            confidence,
            t: self.now_ms,
            et: None,
            detail: None,
            usage: None,
            limit: None,
            tokens_delta: None,
        }
    }

    pub fn request_id(&self, raw: &str) -> String {
        self.ids.instance(self.tool, raw)
    }
}

pub fn detail() -> EventDetail {
    EventDetail { activity: None, error_class: None, notification: None, stop_reason: None, end_reason: None }
}

/// An `et` outside the contract's range (2000 to 2100) is dropped, never forwarded.
pub fn valid_ms(ms: u64) -> Option<u64> {
    (946_684_800_000..=4_102_444_800_000).contains(&ms).then_some(ms)
}
