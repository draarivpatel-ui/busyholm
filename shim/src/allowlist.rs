//! The privacy edge of the shim (SPEC Revision 1, item 1).
//!
//! The wire body is built FRESH from validated primitives. Nothing is deleted from the
//! original document: a field that is not named here simply never exists in the output, so a
//! field nobody has thought of yet is dropped too. Prompt text, tool input and output, paths,
//! transcripts and messages are never copied. Closed-vocabulary fields are mapped through
//! fixed lists, so even a free-text value sent under an allowed name cannot get through.
//!
//! The field list follows `collector-claude/SHIM_ALLOWLIST.md` (Claude) and the fields the
//! Codex adapter reads (`collector-codex/src/decode.rs`: `timestamp`, `host`, `turn_id`).

use serde_json::{Map, Number, Value};

/// Largest accepted id or name.
const MAX_ID: usize = 256;

/// Ids are identifiers (UUIDs, `toolu_...`, `thr_...`), never prose or paths: a fixed character set
/// (`[A-Za-z0-9._:-]`), so an id field cannot carry text, paths, whitespace tricks or bidi characters out of the process.
fn id_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_ID && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}

/// A tool NAME (never its input): identifier characters only.
fn tool_name_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
}

fn event_name_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.'))
}

const SOURCES: [&str; 5] = ["startup", "resume", "clear", "compact", "fork"];
const END_REASONS: [&str; 6] = ["clear", "resume", "logout", "prompt_input_exit", "exit", "other"];
const NOTIFICATIONS: [&str; 10] = [
    "permission_prompt",
    "elicitation_dialog",
    "elicitation_url_dialog",
    "agent_needs_input",
    "elicitation_response",
    "elicitation_complete",
    "idle_prompt",
    "quota_auto_resume_fired",
    "quota_auto_resume_stale",
    "quota_auto_resume_disabled",
];
const ERRORS: [&str; 14] = [
    "rate_limit",
    "overloaded",
    "overloaded_error",
    "server_error",
    "api_error",
    "authentication_failed",
    "oauth_org_not_allowed",
    "cloud_credential_error",
    "account_on_hold",
    "billing_error",
    "invalid_request",
    "model_not_found",
    "max_output_tokens",
    "unknown",
];
const HOSTS: [&str; 5] = ["cli", "desktop", "vscode", "sdk", "ide"];

/// Agents the shim may name in `X-Busyholm-Agent`.
pub const AGENTS: [&str; 3] = ["claude", "codex", "gemini"];

fn str_of<'a>(obj: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(Value::as_str)
}

fn put(out: &mut Map<String, Value>, key: &str, value: &str) {
    out.insert(key.to_string(), Value::String(value.to_string()));
}

/// Filter one hook body. `None` means "send nothing" (not an object, no usable event name).
pub fn filter_hook(input: &[u8]) -> Option<Vec<u8>> {
    let doc: Value = serde_json::from_slice(input).ok()?;
    let obj = doc.as_object()?;
    let event = str_of(obj, "hook_event_name").filter(|s| event_name_ok(s))?;
    let mut out = Map::new();
    put(&mut out, "hook_event_name", event);

    for key in ["session_id", "agent_id", "prompt_id", "turn_id", "tool_use_id", "request_id"] {
        if let Some(v) = str_of(obj, key).filter(|s| id_ok(s)) {
            put(&mut out, key, v);
        }
    }
    if let Some(v) = str_of(obj, "tool_name").filter(|s| tool_name_ok(s)) {
        put(&mut out, "tool_name", v);
    }
    if let Some(v) = str_of(obj, "host").filter(|s| HOSTS.contains(s)) {
        put(&mut out, "host", v);
    }
    // A source time: a finite number, or a short timestamp string (digits and ISO-8601 punctuation only).
    match obj.get("timestamp") {
        Some(Value::Number(n)) if n.as_f64().is_some_and(f64::is_finite) => {
            out.insert("timestamp".to_string(), Value::Number(n.clone()));
        }
        Some(Value::String(s))
            if !s.is_empty() && s.len() <= 40 && s.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | ':' | '.' | '+' | 'T' | 'Z')) =>
        {
            put(&mut out, "timestamp", s);
        }
        _ => {}
    }

    // Event-conditional closed vocabularies. `reason` on PermissionDenied and `error` on
    // PostToolUseFailure are free text in Claude Code, so they are never read.
    match event {
        "SessionStart" => {
            if let Some(v) = str_of(obj, "source").filter(|s| SOURCES.contains(s)) {
                put(&mut out, "source", v);
            }
        }
        "SessionEnd" | "SubagentStop" => {
            if let Some(v) = str_of(obj, "reason") {
                put(&mut out, "reason", if END_REASONS.contains(&v) { v } else { "other" });
            }
        }
        "Notification" => {
            if let Some(v) = str_of(obj, "notification_type") {
                put(&mut out, "notification_type", if NOTIFICATIONS.contains(&v) { v } else { "other" });
            }
        }
        "StopFailure" => {
            if let Some(v) = str_of(obj, "error") {
                put(&mut out, "error", if ERRORS.contains(&v) { v } else { "unknown" });
            }
        }
        "PostToolUseFailure" => {
            if let Some(b) = obj.get("is_interrupt").and_then(Value::as_bool) {
                out.insert("is_interrupt".to_string(), Value::Bool(b));
            }
        }
        _ => {}
    }
    serde_json::to_vec(&Value::Object(out)).ok()
}

fn number_in(v: Option<&Value>, lo: f64, hi: f64) -> Option<Number> {
    let n = v?.as_number()?;
    let f = n.as_f64()?;
    if f.is_finite() && f >= lo && f <= hi {
        Some(n.clone())
    } else {
        None
    }
}

/// Filter one status line body down to `session_id` and the two rate-limit windows
/// (`used_percentage` and `resets_at` only). `None` when there is no complete window:
/// a missing window must never become a 0% sample, and there is nothing else to send.
pub fn filter_statusline(input: &[u8]) -> Option<Vec<u8>> {
    let doc: Value = serde_json::from_slice(input).ok()?;
    let obj = doc.as_object()?;
    let session = str_of(obj, "session_id").filter(|s| id_ok(s))?;
    let limits = obj.get("rate_limits")?.as_object()?;
    let mut windows = Map::new();
    for key in ["five_hour", "seven_day"] {
        let Some(w) = limits.get(key).and_then(Value::as_object) else { continue };
        let (Some(pct), Some(reset)) = (
            number_in(w.get("used_percentage"), 0.0, 100.0),
            number_in(w.get("resets_at"), 1.0, 1.0e13),
        ) else {
            continue;
        };
        let mut one = Map::new();
        one.insert("used_percentage".to_string(), Value::Number(pct));
        one.insert("resets_at".to_string(), Value::Number(reset));
        windows.insert(key.to_string(), Value::Object(one));
    }
    if windows.is_empty() {
        return None;
    }
    let mut out = Map::new();
    put(&mut out, "session_id", session);
    out.insert("rate_limits".to_string(), Value::Object(windows));
    serde_json::to_vec(&Value::Object(out)).ok()
}
