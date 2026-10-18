//! Claude hook payload mapper: the 13 live events plus 4 known-but-ignored ones.
//!
//! The input is the `busyholm-hook` shim's allowlisted body (SPEC Revision 1), which is
//! the hook's own JSON with content fields already removed. This mapper reads only
//! closed-vocabulary fields and ids, never requires a content field, and drops the
//! parsed document before returning.

use busyholm_contracts::agent_event::{
    EndReason, ErrorClass, EventKind, EventLimit, EventSource, Notification, StopReason,
};
use busyholm_contracts::common::{Activity, Confidence, LimitWindow, Provider};
use serde_json::Value;

use crate::pending::Draft;
use crate::{Env, MapError, PendingEvent};

/// Largest accepted body (same cap as the receiver, SPEC 5.6).
pub const MAX_BODY: usize = 256 * 1024;
const MAX_ID_LEN: usize = 256;

/// The 13 hook events that change state.
pub const MAPPED_EVENTS: [&str; 13] = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "PermissionDenied",
    "Notification",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
];
/// Known hook events that carry no state change for Busyholm (no event is produced).
pub const IGNORED_EVENTS: [&str; 4] = ["PreCompact", "PostCompact", "TaskCreated", "TaskCompleted"];

#[derive(Debug, Default)]
pub struct HookMapped {
    pub events: Vec<PendingEvent>,
    /// The event name is neither mapped nor ignored: format drift to count.
    pub unknown_event: bool,
}

/// A string field, only if it is a string of sane length.
fn text<'a>(obj: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= MAX_ID_LEN)
}

pub fn map_hook(body: &[u8], env: &Env) -> Result<HookMapped, MapError> {
    if body.len() > MAX_BODY {
        return Err(MapError::TooLarge);
    }
    let doc: Value = serde_json::from_slice(body).map_err(|_| MapError::NotJson)?;
    let obj = doc.as_object().ok_or(MapError::NotObject)?;
    let name = text(obj, "hook_event_name").ok_or(MapError::MissingField)?;

    if IGNORED_EVENTS.contains(&name) {
        return Ok(HookMapped::default());
    }
    if !MAPPED_EVENTS.contains(&name) {
        return Ok(HookMapped { events: Vec::new(), unknown_event: true });
    }

    let session_raw = text(obj, "session_id").ok_or(MapError::MissingField)?;
    let session = env.instance(session_raw);
    let agent_raw = text(obj, "agent_id");
    let is_start_or_stop = name == "SubagentStart" || name == "SubagentStop";
    if is_start_or_stop && agent_raw.is_none() {
        return Err(MapError::MissingField);
    }
    // Any hook fired inside a subagent describes the child, not the main session.
    let (instance, parent) = match agent_raw {
        Some(a) => (env.instance(a), Some(session.clone())),
        None => (session.clone(), None),
    };
    let host = env.host(&session);
    let account = (env.account_of)(&session);
    let turn = text(obj, "turn_id").or_else(|| text(obj, "prompt_id")).map(|t| env.scoped("turn", t));
    let request = text(obj, "request_id").or_else(|| text(obj, "tool_use_id")).map(|r| env.scoped("req", r));
    let tool = text(obj, "tool_name");

    let make = |kind: EventKind, confidence: Confidence| {
        let with_request = matches!(
            kind,
            EventKind::NeedsPermission | EventKind::NeedsAnswer | EventKind::Answered | EventKind::ToolEnd
        );
        Draft::new(env, kind, EventSource::Hook, confidence, instance.clone(), host)
            .parent(parent.clone())
            .account(account.clone())
            .turn(turn.clone())
            .request(if with_request { request.clone() } else { None })
    };
    let exact = Confidence::Exact;

    let event = match name {
        "SessionStart" => {
            if text(obj, "source") == Some("compact") {
                // Compaction restarts the hook inside the same, running session.
                None
            } else {
                Some(make(EventKind::SessionStart, exact))
            }
        }
        "SessionEnd" => {
            let reason = match text(obj, "reason") {
                Some("clear") => EndReason::Clear,
                Some("resume") => EndReason::Resume,
                Some("logout") => EndReason::Logout,
                Some("prompt_input_exit") => EndReason::Exit,
                _ => EndReason::Other,
            };
            Some(make(EventKind::SessionEnd, exact).detail(|d| d.end_reason = Some(reason)))
        }
        "UserPromptSubmit" => Some(make(EventKind::TurnStart, exact)),
        "PreToolUse" => {
            if tool == Some("AskUserQuestion") {
                Some(make(EventKind::NeedsAnswer, exact))
            } else {
                let act = activity_for_tool(tool.unwrap_or(""));
                Some(make(EventKind::Heartbeat, exact).detail(|d| d.activity = Some(act)))
            }
        }
        "PostToolUse" => {
            if tool == Some("AskUserQuestion") {
                Some(make(EventKind::Answered, exact))
            } else {
                let act = activity_for_tool(tool.unwrap_or(""));
                Some(make(EventKind::ToolEnd, exact).detail(|d| d.activity = Some(act)))
            }
        }
        "PostToolUseFailure" => {
            if obj.get("is_interrupt").and_then(Value::as_bool) == Some(true) {
                // The user stopped the turn mid-tool; no Stop hook will follow. Inferred: the
                // payload says the tool was interrupted, not that the whole turn ended.
                Some(
                    make(EventKind::TurnInterrupted, Confidence::Inferred)
                        .detail(|d| d.stop_reason = Some(StopReason::Interrupted)),
                )
            } else {
                let act = activity_for_tool(tool.unwrap_or(""));
                Some(make(EventKind::ToolEnd, exact).detail(|d| d.activity = Some(act)))
            }
        }
        "PermissionRequest" => Some(make(EventKind::NeedsPermission, exact)),
        "PermissionDenied" => Some(make(EventKind::Answered, exact)),
        "Notification" => Some(notification(&make, text(obj, "notification_type"))),
        "Stop" => Some(make(EventKind::TurnEnd, exact).detail(|d| d.stop_reason = Some(StopReason::EndTurn))),
        "StopFailure" => {
            let label = text(obj, "error");
            if label == Some("rate_limit") {
                Some(make(EventKind::LimitHit, exact).limit(EventLimit {
                    provider: Provider::Claude,
                    window: LimitWindow::Unknown,
                    resets_at: None,
                }))
            } else {
                let class = error_class(label, None);
                Some(make(EventKind::Error, exact).detail(|d| d.error_class = Some(class)))
            }
        }
        "SubagentStart" => Some(make(EventKind::SessionStart, exact)),
        "SubagentStop" => Some(make(EventKind::SessionEnd, exact).detail(|d| d.end_reason = Some(EndReason::Exit))),
        _ => None,
    };
    Ok(HookMapped { events: event.map(Draft::done).into_iter().collect(), unknown_event: false })
}

fn notification(make: &dyn Fn(EventKind, Confidence) -> Draft, kind: Option<&str>) -> Draft {
    let exact = Confidence::Exact;
    let (event, n) = match kind {
        Some("permission_prompt") => (EventKind::NeedsPermission, Notification::PermissionPrompt),
        Some("elicitation_dialog") => (EventKind::NeedsAnswer, Notification::ElicitationDialog),
        Some("elicitation_url_dialog") => (EventKind::NeedsAnswer, Notification::ElicitationUrlDialog),
        Some("agent_needs_input") => (EventKind::NeedsAnswer, Notification::AgentNeedsInput),
        Some("elicitation_response") => (EventKind::Answered, Notification::ElicitationResponse),
        Some("elicitation_complete") => (EventKind::Answered, Notification::ElicitationComplete),
        Some("idle_prompt") => (EventKind::Heartbeat, Notification::IdlePrompt),
        Some("quota_auto_resume_fired") => (EventKind::Heartbeat, Notification::QuotaAutoResumeFired),
        Some("quota_auto_resume_stale") => (EventKind::Heartbeat, Notification::QuotaAutoResumeStale),
        Some("quota_auto_resume_disabled") => (EventKind::Heartbeat, Notification::QuotaAutoResumeDisabled),
        _ => (EventKind::Heartbeat, Notification::Other),
    };
    make(event, exact).detail(|d| d.notification = Some(n))
}

/// Activity from the tool NAME only.
pub fn activity_for_tool(name: &str) -> Activity {
    match name {
        "Bash" | "BashOutput" | "KillShell" | "KillBash" | "PowerShell" => Activity::Shell,
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => Activity::Edit,
        "Read" | "Grep" | "Glob" | "LS" | "NotebookRead" => Activity::Read,
        "WebFetch" | "WebSearch" => Activity::Web,
        "Task" | "Agent" => Activity::Delegate,
        _ => Activity::Other,
    }
}

/// Closed error class from a label (StopFailure `error`, an API error `type`) and/or an HTTP status.
pub fn error_class(label: Option<&str>, status: Option<u64>) -> ErrorClass {
    let by_label = match label {
        Some("overloaded") | Some("overloaded_error") => Some(ErrorClass::Overloaded),
        Some("server_error") | Some("api_error") => Some(ErrorClass::ServerError),
        Some("authentication_failed") | Some("oauth_org_not_allowed") | Some("cloud_credential_error")
        | Some("authentication_error") | Some("permission_error") => Some(ErrorClass::Auth),
        Some("account_on_hold") | Some("billing_error") => Some(ErrorClass::Billing),
        Some("invalid_request") | Some("invalid_request_error") => Some(ErrorClass::InvalidRequest),
        Some("model_not_found") | Some("not_found_error") => Some(ErrorClass::ModelNotFound),
        Some("max_output_tokens") => Some(ErrorClass::MaxOutputTokens),
        _ => None,
    };
    if let Some(c) = by_label {
        return c;
    }
    match status {
        Some(529) => ErrorClass::Overloaded,
        Some(401) | Some(403) => ErrorClass::Auth,
        Some(402) => ErrorClass::Billing,
        Some(400) | Some(413) | Some(422) => ErrorClass::InvalidRequest,
        Some(404) => ErrorClass::ModelNotFound,
        Some(s) if (500..600).contains(&s) => ErrorClass::ServerError,
        _ => ErrorClass::Unknown,
    }
}
