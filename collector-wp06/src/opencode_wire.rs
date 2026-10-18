//! OpenCode plugin wire format to AgentEvent v1 (the receiver side of `plugin/busyholm.js`).
//!
//! The body is parsed into a closed struct: any key that is not on the allowlist, any value
//! of the wrong shape and any id that is not a SHA-256 digest is `InvalidPayload`. Session
//! digests are turned into the salted instance id by the collector's hasher, so the raw
//! OpenCode id is never held by this side at all.
use collector::{Adapter, AdapterContext, AdapterError};
use busyholm_contracts::{
    agent_event::{EndReason, ErrorClass, EventDetail, EventKind, EventSource, StopReason},
    common::{Activity, Confidence, Host, Tool},
    AgentEvent,
};
use serde_json::Value;

use crate::build::{detail, Builder};
use crate::ident::Identity;

const MAX_BODY: usize = 4096;
const ALLOWED_KEYS: &[&str] = &["v", "agent", "type", "sid", "psid", "rid", "activity", "error", "tok", "et"];
const ET_MIN: u64 = 946_684_800_000;
const ET_MAX: u64 = 4_102_444_800_000;
const TOK_MAX: u64 = 1_000_000_000;

fn is_digest(v: &Value) -> Option<&str> {
    let s = v.as_str()?;
    (s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))).then_some(s)
}

fn activity(s: &str) -> Option<Activity> {
    Some(match s {
        "shell" => Activity::Shell,
        "edit" => Activity::Edit,
        "read" => Activity::Read,
        "web" => Activity::Web,
        "delegate" => Activity::Delegate,
        "other" => Activity::Other,
        _ => return None,
    })
}

/// `Ok(None)` is an interrupt; `Ok(Some(class))` an error class.
fn error_class(s: &str) -> Option<Option<ErrorClass>> {
    Some(match s {
        "aborted" => None,
        "auth" => Some(ErrorClass::Auth),
        "server_error" => Some(ErrorClass::ServerError),
        "max_output_tokens" => Some(ErrorClass::MaxOutputTokens),
        "network" => Some(ErrorClass::Network),
        "unknown" => Some(ErrorClass::Unknown),
        _ => return None,
    })
}

/// Map one POSTed plugin body. Strict: unknown keys, wrong types and oversize bodies are
/// `InvalidPayload`. Nothing from the body except the mapped enums and hashed ids survives.
pub fn map_wire(body: &[u8], ids: &dyn Identity, now_ms: u64, root: &str) -> Result<Vec<AgentEvent>, AdapterError> {
    const BAD: AdapterError = AdapterError::InvalidPayload;
    if body.is_empty() || body.len() > MAX_BODY {
        return Err(BAD);
    }
    let v: Value = serde_json::from_slice(body).map_err(|_| BAD)?;
    let obj = v.as_object().ok_or(BAD)?;
    if obj.keys().any(|k| !ALLOWED_KEYS.contains(&k.as_str())) {
        return Err(BAD);
    }
    if obj.get("v").and_then(Value::as_u64) != Some(1) || obj.get("agent").and_then(Value::as_str) != Some("opencode") {
        return Err(BAD);
    }
    let ty = obj.get("type").and_then(Value::as_str).ok_or(BAD)?;
    let sid = obj.get("sid").and_then(is_digest).ok_or(BAD)?;
    let psid = match obj.get("psid") {
        None => None,
        Some(p) => Some(is_digest(p).ok_or(BAD)?),
    };
    let rid = match obj.get("rid") {
        None => None,
        Some(r) => Some(is_digest(r).ok_or(BAD)?),
    };
    let act = match obj.get("activity") {
        None => None,
        Some(a) => Some(activity(a.as_str().ok_or(BAD)?).ok_or(BAD)?),
    };
    let err = match obj.get("error") {
        None => None,
        Some(e) => Some(error_class(e.as_str().ok_or(BAD)?).ok_or(BAD)?),
    };
    let tok = match obj.get("tok") {
        None => None,
        Some(t) => {
            let n = t.as_u64().ok_or(BAD)?;
            if n > TOK_MAX {
                return Err(BAD);
            }
            Some(n as u32)
        }
    };
    let et = match obj.get("et") {
        None => None,
        Some(e) => {
            let n = e.as_u64().ok_or(BAD)?;
            if !(ET_MIN..=ET_MAX).contains(&n) {
                return Err(BAD);
            }
            Some(n)
        }
    };

    // Which optional keys each type may carry; anything else is refused.
    let allows = |key: &str| -> bool {
        match key {
            "activity" => ty == "tool.after",
            "error" => ty == "session.error",
            "tok" => ty == "tokens",
            "rid" => ty.starts_with("permission.") || ty.starts_with("question."),
            _ => true,
        }
    };
    if ["psid", "activity", "error", "tok", "rid"].iter().any(|k| obj.contains_key(*k) && !allows(k)) {
        return Err(BAD);
    }

    let (kind, detail, tokens_delta) = match ty {
        "session.created" => (EventKind::SessionStart, None, None),
        "session.deleted" => (EventKind::SessionEnd, Some(EventDetail { end_reason: Some(EndReason::Other), ..detail() }), None),
        "session.busy" => (EventKind::TurnStart, None, None),
        "session.idle" => (EventKind::TurnEnd, Some(EventDetail { stop_reason: Some(StopReason::EndTurn), ..detail() }), None),
        "session.error" => match err.ok_or(BAD)? {
            None => (EventKind::TurnInterrupted, Some(EventDetail { stop_reason: Some(StopReason::Interrupted), ..detail() }), None),
            Some(class) => (EventKind::Error, Some(EventDetail { error_class: Some(class), ..detail() }), None),
        },
        "permission.asked" => (EventKind::NeedsPermission, None, None),
        "question.asked" => (EventKind::NeedsAnswer, None, None),
        "permission.replied" | "question.replied" => (EventKind::Answered, None, None),
        "tool.after" => (EventKind::ToolEnd, Some(EventDetail { activity: Some(act.unwrap_or(Activity::Other)), ..detail() }), None),
        "tokens" => (EventKind::Heartbeat, None, Some(tok.ok_or(BAD)?)),
        _ => return Err(BAD),
    };

    let b = Builder { ids, tool: Tool::Opencode, root_raw: root, host: Host::Cli, now_ms };
    let mut ev = b.event(kind, EventSource::Plugin, Confidence::Exact, sid, psid, true);
    ev.et = et;
    ev.detail = detail;
    ev.tokens_delta = tokens_delta;
    if matches!(kind, EventKind::NeedsPermission | EventKind::NeedsAnswer | EventKind::Answered) {
        ev.request_id = rid.map(|r| b.request_id(r));
    }
    Ok(vec![ev])
}

/// OpenCode as a collector adapter: plugin bodies through `map_hook`, SQLite poll through
/// `poll` and `rebuild` (when the `opencode-poll` feature is on and a database is configured).
pub struct OpenCodeAdapter {
    root: String,
    #[cfg(feature = "opencode-poll")]
    poller: Option<crate::opencode_poll::OpenCodePoller>,
}

impl OpenCodeAdapter {
    /// Plugin events only. `root` is the OpenCode data folder (the connector key).
    pub fn new(root: String) -> Self {
        Self {
            root,
            #[cfg(feature = "opencode-poll")]
            poller: None,
        }
    }
    /// Plugin events plus the read-only database poll.
    #[cfg(feature = "opencode-poll")]
    pub fn with_poller(poller: crate::opencode_poll::OpenCodePoller) -> Self {
        Self { root: poller.root().to_string(), poller: Some(poller) }
    }
}

impl Adapter for OpenCodeAdapter {
    fn tool(&self) -> Tool {
        Tool::Opencode
    }
    fn map_hook(&mut self, body: &[u8], ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        map_wire(body, ctx, ctx.now_ms(), &self.root)
    }
    #[cfg(feature = "opencode-poll")]
    fn rebuild(&mut self, ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        match self.poller.as_mut() {
            Some(p) => p.rebuild_at(ctx, ctx.now_ms()),
            None => Ok(Vec::new()),
        }
    }
    #[cfg(feature = "opencode-poll")]
    fn poll(&mut self, ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        match self.poller.as_mut() {
            Some(p) => p.poll_at(ctx, ctx.now_ms()),
            None => Ok(Vec::new()),
        }
    }
}
