//! Event construction. SPEC Revision 1 identity fields (`root_id`, `account_id`,
//! `session_id`, `turn_id`, `request_id`) are part of AgentEvent v1 now.

use busyholm_contracts::agent_event::{
    EventDetail, EventKind, EventLimit, EventSource, EventUsage,
};
use busyholm_contracts::common::{Confidence, Host, InstanceId, Tool, Version};
use busyholm_contracts::AgentEvent;

use crate::Env;

/// Mappers return plain AgentEvents; the alias keeps signatures readable.
pub type PendingEvent = AgentEvent;

/// Small builder so every mapper builds events the same way.
pub struct Draft {
    event: AgentEvent,
}

impl Draft {
    /// `session_id` defaults to the instance itself (a main session); `parent()` moves it
    /// to the parent session. `account_id` defaults to what the registry taught `env`.
    pub fn new(
        env: &Env,
        kind: EventKind,
        source: EventSource,
        confidence: Confidence,
        instance: InstanceId,
        host: Host,
    ) -> Draft {
        let account_id = (env.account_of)(&instance);
        Draft {
            event: AgentEvent {
                v: Version,
                agent: Tool::Claude,
                session_id: Some(instance.clone()),
                instance,
                parent: None,
                root_id: env.root_id.to_string(),
                account_id,
                turn_id: None,
                request_id: None,
                host,
                kind,
                source,
                confidence,
                t: env.now_ms,
                et: None,
                detail: None,
                usage: None,
                limit: None,
                tokens_delta: None,
            },
        }
    }
    pub fn parent(mut self, parent: Option<InstanceId>) -> Draft {
        if parent.is_some() {
            self.event.session_id = parent.clone();
        }
        self.event.parent = parent;
        self
    }
    pub fn et(mut self, et: Option<u64>) -> Draft {
        self.event.et = et;
        self
    }
    pub fn account(mut self, account: Option<String>) -> Draft {
        if account.is_some() {
            self.event.account_id = account;
        }
        self
    }
    pub fn turn(mut self, turn: Option<String>) -> Draft {
        self.event.turn_id = turn;
        self
    }
    pub fn request(mut self, request: Option<String>) -> Draft {
        self.event.request_id = request;
        self
    }
    pub fn detail(mut self, f: impl FnOnce(&mut EventDetail)) -> Draft {
        let mut d = self.event.detail.take().unwrap_or(EventDetail {
            activity: None,
            error_class: None,
            notification: None,
            stop_reason: None,
            end_reason: None,
        });
        f(&mut d);
        self.event.detail = Some(d);
        self
    }
    pub fn usage(mut self, u: EventUsage) -> Draft {
        self.event.usage = Some(u);
        self
    }
    pub fn limit(mut self, l: EventLimit) -> Draft {
        self.event.limit = Some(l);
        self
    }
    pub fn tokens(mut self, n: Option<u32>) -> Draft {
        self.event.tokens_delta = n;
        self
    }
    pub fn done(self) -> PendingEvent {
        self.event
    }
}
