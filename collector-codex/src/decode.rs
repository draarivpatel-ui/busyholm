use collector::{AdapterContext, AdapterError};
use collector::contracts::{AgentEvent, Validate, agent_event::{EventDetail, EventKind, EventLimit,
    EventSource, EventUsage, EndReason, StopReason}, common::{Activity, Confidence, Host,
    LimitWindow, Tool, Version, Window}};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub(crate) const MIN_MS: u64 = 946_684_800_000;
pub(crate) const MAX_MS: u64 = 4_102_444_800_000;
const MAX_RAW_ID: usize = 4096;

/// Only integer counters leave the drift/error path.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Diagnostics {
    pub unknown_envelopes: u64,
    pub unknown_events: u64,
    pub unknown_hooks: u64,
    pub unknown_windows: u64,
    pub malformed_records: u64,
    pub oversized_lines: u64,
    pub io_errors: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Session {
    pub instance: String,
    pub parent: Option<String>,
    pub host: Host,
    pub root_id: String,
    pub account_id: Option<String>,
    pub session_id: String,
}

/// Per-file state contains hashes, closed enums and counts only.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct RolloutStream {
    pub(crate) session: Option<Session>,
    total_tokens: Option<u64>,
    five_hour: Option<EventUsage>,
    weekly: Option<EventUsage>,
    five_hour_at: Option<u64>,
    weekly_at: Option<u64>,
}

impl RolloutStream {
    pub(crate) fn valid(&self) -> bool {
        fn hash(id: &str) -> bool { id.len() == 32 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) }
        self.session.as_ref().map_or(true, |s| hash(&s.instance) && hash(&s.root_id) && hash(&s.session_id)
            && s.account_id.as_ref().map_or(true, |p| hash(p))
            && s.parent.as_ref().map_or(true, |p| hash(p) && p != &s.instance))
            && [&self.five_hour, &self.weekly].into_iter().flatten().all(|u|
                u.provider == collector::contracts::common::Provider::Codex && u.used_pct.is_finite()
                && (0.0..=100.0).contains(&u.used_pct) && (MIN_MS..=MAX_MS).contains(&u.resets_at)
                && (MIN_MS..=MAX_MS).contains(&u.observed_at))
    }
    pub fn latest_usage(&self, window: Window) -> Option<&EventUsage> {
        match window { Window::FiveHour => self.five_hour.as_ref(), Window::Weekly => self.weekly.as_ref() }
    }

    fn retain_newest(&mut self, value: EventUsage, source_at: u64) -> bool {
        let (slot, at) = match value.window {
            Window::FiveHour => (&mut self.five_hour, &mut self.five_hour_at),
            Window::Weekly => (&mut self.weekly, &mut self.weekly_at),
        };
        if at.is_some_and(|previous| previous > source_at) { return false; }
        *slot = Some(value); *at = Some(source_at); true
    }
}

#[derive(Deserialize)]
enum EnvelopeKind {
    #[serde(rename = "session_meta")] SessionMeta,
    #[serde(rename = "event_msg")] Event,
    #[serde(rename = "turn_context")] TurnContext,
    #[serde(rename = "response_item")] ResponseItem,
    #[serde(rename = "token_usage_record")] TokenUsageRecord,
    #[serde(rename = "compacted")] Compacted,
    #[serde(rename = "world_state")] WorldState,
    #[serde(rename = "inter_agent_communication_metadata")] Communication,
    #[serde(other)] Unknown,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawTime<'a> { Millis(u64), Text(#[serde(borrow)] &'a str) }

fn source_time(raw: Option<RawTime<'_>>) -> Option<u64> {
    let ms = match raw? {
        RawTime::Millis(n) => n,
        RawTime::Text(s) => u64::try_from(OffsetDateTime::parse(s, &Rfc3339).ok()?.unix_timestamp_nanos() / 1_000_000).ok()?,
    };
    (MIN_MS..=MAX_MS).contains(&ms).then_some(ms)
}

#[derive(Deserialize)]
struct Envelope<'a> {
    #[serde(rename = "type")] kind: EnvelopeKind,
    #[serde(default, borrow)] timestamp: Option<&'a RawValue>,
    #[serde(default, borrow)] payload: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct Meta<'a> {
    #[serde(default, borrow)] id: Option<&'a str>,
    #[serde(default, borrow)] session_id: Option<&'a str>,
    #[serde(default, borrow)] source: Option<&'a RawValue>,
    #[serde(default, borrow)] parent_thread_id: Option<&'a str>,
    #[serde(default, borrow)] creator_account_id: Option<&'a str>,
}

#[derive(Deserialize)]
enum NamedHost {
    #[serde(rename = "cli")] Cli,
    #[serde(rename = "desktop")] Desktop,
    #[serde(rename = "vscode")] Vscode,
    #[serde(rename = "sdk")] Sdk,
    #[serde(rename = "ide")] Ide,
    #[serde(other)] Other,
}
impl From<NamedHost> for Host {
    fn from(value: NamedHost) -> Self {
        match value { NamedHost::Cli => Host::Cli, NamedHost::Desktop => Host::Desktop,
            NamedHost::Vscode => Host::Vscode, NamedHost::Sdk => Host::Sdk,
            NamedHost::Ide => Host::Ide, NamedHost::Other => Host::Other }
    }
}

#[derive(Deserialize)]
struct SpawnSource<'a> { #[serde(default, borrow)] subagent: Option<SubagentSource<'a>> }
#[derive(Deserialize)]
struct SubagentSource<'a> { #[serde(default, borrow)] thread_spawn: Option<ThreadSpawn<'a>> }
#[derive(Deserialize)]
struct ThreadSpawn<'a> { #[serde(default, borrow)] parent_thread_id: Option<&'a str> }

fn usable_id(id: Option<&str>) -> Option<&str> { id.filter(|id| !id.is_empty() && id.len() <= MAX_RAW_ID) }

fn session(meta: Meta<'_>, ctx: &AdapterContext, root: &str) -> Option<Session> {
    // Codex's canonical rollout identity is payload.id. session_id is a legacy fallback.
    let raw = usable_id(meta.id).or_else(|| usable_id(meta.session_id))?;
    let host = meta.source.and_then(|s| serde_json::from_str::<NamedHost>(s.get()).ok())
        .map(Host::from).unwrap_or(Host::Other);
    let nested_parent = meta.source.and_then(|s| serde_json::from_str::<SpawnSource<'_>>(s.get()).ok())
        .and_then(|s| s.subagent).and_then(|s| s.thread_spawn).and_then(|s| s.parent_thread_id);
    let instance = ctx.instance(Tool::Codex, raw);
    let parent = usable_id(meta.parent_thread_id.or(nested_parent)).map(|id| ctx.instance(Tool::Codex, id))
        .filter(|parent| parent != &instance);
    let session_id = parent.clone().unwrap_or_else(|| instance.clone());
    let account_id = usable_id(meta.creator_account_id).map(|id| ctx.instance(Tool::Codex, &format!("account:{id}")));
    Some(Session { instance, parent, host, root_id: root.into(), account_id, session_id })
}

#[derive(Deserialize)]
enum MessageKind {
    #[serde(rename = "task_started")] Started,
    #[serde(rename = "task_complete")] Complete,
    #[serde(rename = "turn_aborted")] Aborted,
    #[serde(rename = "token_count")] Tokens,
    #[serde(rename = "item_completed")] Item,
    #[serde(rename = "thread_settings_applied")] Settings,
    #[serde(rename = "error")] Error,
    #[serde(rename = "stream_error")] StreamError,
    #[serde(rename = "warning")] Warning,
    #[serde(other)] Unknown,
}

#[derive(Deserialize)]
struct Message<'a> {
    #[serde(rename = "type")] kind: MessageKind,
    #[serde(default, borrow)] item: Option<&'a RawValue>,
    #[serde(default, borrow)] rate_limits: Option<&'a RawValue>,
    #[serde(default)] info: Option<TokenInfo>,
    #[serde(default, borrow)] turn_id: Option<&'a str>,
}
#[derive(Deserialize)]
struct TokenInfo { #[serde(default)] total_token_usage: Option<TokenTotals> }
#[derive(Deserialize)]
struct TokenTotals { #[serde(default)] total_tokens: Option<u64> }

#[derive(Deserialize)]
struct RateLimits<'a> {
    #[serde(default)] primary: Option<RateWindow>,
    #[serde(default)] secondary: Option<RateWindow>,
    #[serde(default, borrow)] rate_limit_reached_type: Option<&'a RawValue>,
}
#[derive(Deserialize)]
struct RateWindow {
    #[serde(default)] used_percent: Option<f64>,
    #[serde(default)] window_minutes: Option<u64>,
    #[serde(default)] resets_at: Option<u64>,
}

fn usage(raw: &RateWindow, observed_at: u64, diag: &mut Diagnostics) -> Option<EventUsage> {
    let window = match raw.window_minutes? {
        300 => Window::FiveHour, 10_080 => Window::Weekly,
        _ => { diag.unknown_windows = diag.unknown_windows.saturating_add(1); return None; }
    };
    let used_pct = raw.used_percent?;
    if !used_pct.is_finite() || !(0.0..=100.0).contains(&used_pct) { return None; }
    let resets_at = raw.resets_at?.checked_mul(1000)?;
    if !(MIN_MS..=MAX_MS).contains(&resets_at) { return None; }
    Some(EventUsage { provider: collector::contracts::common::Provider::Codex, window,
        used_pct, resets_at, observed_at })
}

pub(crate) fn base(session: &Session, kind: EventKind, source: EventSource, ctx: &AdapterContext, et: Option<u64>) -> AgentEvent {
    AgentEvent { v: Version, agent: Tool::Codex, instance: session.instance.clone(), parent: session.parent.clone(),
        root_id: session.root_id.clone(), account_id: session.account_id.clone(), session_id: Some(session.session_id.clone()),
        turn_id: None, request_id: None,
        host: session.host, kind, source, confidence: Confidence::Exact, t: ctx.now_ms(), et,
        detail: None, usage: None, limit: None, tokens_delta: None }
}
fn detail() -> EventDetail { EventDetail { activity: None, error_class: None, notification: None, stop_reason: None, end_reason: None } }
fn stopped(event: &mut AgentEvent, reason: StopReason) {
    event.detail = Some(EventDetail { stop_reason: Some(reason), ..detail() });
}
fn active(event: &mut AgentEvent, activity: Activity) {
    event.detail = Some(EventDetail { activity: Some(activity), ..detail() });
}
fn validated(events: Vec<AgentEvent>) -> Result<Vec<AgentEvent>, AdapterError> {
    if events.iter().all(|event| event.validate().is_ok()) { Ok(events) } else { Err(AdapterError::InvalidPayload) }
}

pub(crate) fn record(stream: &mut RolloutStream, bytes: &[u8], ctx: &AdapterContext, root: &str, diag: &mut Diagnostics)
    -> Result<Vec<AgentEvent>, AdapterError>
{
    if bytes.len() > crate::tail::MAX_LINE {
        diag.oversized_lines = diag.oversized_lines.saturating_add(1); return Ok(Vec::new());
    }
    let mapped = map_record(stream, bytes, ctx, root, diag);
    match mapped {
        Some(events) => match validated(events) {
            Ok(events) => Ok(events),
            Err(_) => { diag.malformed_records = diag.malformed_records.saturating_add(1); Ok(Vec::new()) }
        },
        None => { diag.malformed_records = diag.malformed_records.saturating_add(1); Ok(Vec::new()) }
    }
}

fn map_record(stream: &mut RolloutStream, bytes: &[u8], ctx: &AdapterContext, root: &str, diag: &mut Diagnostics) -> Option<Vec<AgentEvent>> {
    let envelope: Envelope<'_> = serde_json::from_slice(bytes).ok()?;
    let et = source_time(envelope.timestamp.and_then(|raw| serde_json::from_str(raw.get()).ok()));
    match envelope.kind {
        EnvelopeKind::Unknown => {
            diag.unknown_envelopes = diag.unknown_envelopes.saturating_add(1); Some(Vec::new())
        },
        EnvelopeKind::SessionMeta => {
            let session = session(serde_json::from_str(envelope.payload?.get()).ok()?, ctx, root)?;
            let duplicate = stream.session.as_ref().is_some_and(|old| old.instance == session.instance);
            if !duplicate { *stream = RolloutStream::default(); }
            let event = base(&session, EventKind::SessionStart, EventSource::Log, ctx, et);
            stream.session = Some(session);
            Some(if duplicate { Vec::new() } else { vec![event] })
        },
        EnvelopeKind::Event => {
            let message: Message<'_> = serde_json::from_str(envelope.payload?.get()).ok()?;
            if matches!(message.kind, MessageKind::Unknown) {
                diag.unknown_events = diag.unknown_events.saturating_add(1); return Some(Vec::new());
            }
            let Some(session) = stream.session.clone() else { return Some(Vec::new()); };
            let turn_id = usable_id(message.turn_id).map(|id| ctx.instance(Tool::Codex, &format!("turn:{}:{id}",session.session_id)));
            let mut event = match message.kind {
                MessageKind::Started => base(&session, EventKind::TurnStart, EventSource::Log, ctx, et),
                MessageKind::Complete => {
                    let mut event = base(&session, EventKind::TurnEnd, EventSource::Log, ctx, et);
                    stopped(&mut event, StopReason::EndTurn); event
                },
                MessageKind::Aborted => {
                    let mut event = base(&session, EventKind::TurnInterrupted, EventSource::Log, ctx, et);
                    stopped(&mut event, StopReason::Interrupted); event
                },
                MessageKind::Tokens => return token_events(stream, &session, message, et, ctx, diag),
                MessageKind::Item => {
                    let item: Item<'_> = serde_json::from_str(message.item?.get()).ok()?;
                    let activity = match item.kind {
                        ItemKind::Command => Activity::Shell, ItemKind::File => Activity::Edit,
                        ItemKind::Image => Activity::Read, ItemKind::Subagent => Activity::Delegate,
                        ItemKind::Mcp => tool_activity(item.tool.unwrap_or("")),
                        ItemKind::Unknown => { diag.unknown_events = diag.unknown_events.saturating_add(1); return Some(Vec::new()); },
                        _ => return Some(Vec::new()),
                    };
                    let mut event = base(&session, EventKind::ToolEnd, EventSource::Log, ctx, et);
                    active(&mut event, activity); event
                },
                // These do not prove retries exhausted or a failed turn.
                MessageKind::Error | MessageKind::StreamError | MessageKind::Warning | MessageKind::Settings => return Some(Vec::new()),
                MessageKind::Unknown => unreachable!(),
            };
            event.turn_id = turn_id;
            Some(vec![event])
        },
        _ => Some(Vec::new()),
    }
}

fn token_events(stream: &mut RolloutStream, session: &Session, message: Message<'_>, et: Option<u64>, ctx: &AdapterContext,
    diag: &mut Diagnostics) -> Option<Vec<AgentEvent>>
{
    let previous = stream.total_tokens;
    let total = message.info.and_then(|info| info.total_token_usage).and_then(|usage| usage.total_tokens);
    let delta = total.zip(previous).and_then(|(current, previous)| current.checked_sub(previous))
        .filter(|delta| *delta > 0 && *delta <= 1_000_000_000).map(|delta| delta as u32);
    // The baseline only advances when an event carries the growth, so tokens counted by a record
    // that emits nothing reach the next emitted delta. A first sighting or a drop re-bases it.
    let rebase = |stream: &mut RolloutStream| {
        if let Some(total) = total { if previous.map_or(true, |old| total < old) { stream.total_tokens = Some(total); } }
    };
    let Some(raw) = message.rate_limits else { rebase(stream); return Some(Vec::new()); };
    let limits: RateLimits<'_> = serde_json::from_str(raw.get()).ok()?;
    let mut events = Vec::new();
    let sample_at = et.unwrap_or(ctx.now_ms());
    // A null primary is a known bad record, including its secondary value.
    if let Some(primary) = &limits.primary {
        let mut windows = Vec::new();
        for raw in std::iter::once(primary).chain(limits.secondary.as_ref()) {
            let Some(value) = usage(raw, sample_at.min(ctx.now_ms()), diag) else { continue; };
            if windows.contains(&value.window) || !stream.retain_newest(value.clone(), sample_at) { continue; }
            windows.push(value.window);
            let mut event = base(session, EventKind::UsageSample, EventSource::Log, ctx, et);
            event.usage = Some(value); events.push(event);
        }
    }
    if limits.rate_limit_reached_type.is_some() {
        // Non-null values have not been verified. Preserve the hit without guessing its window.
        let mut event = base(session, EventKind::LimitHit, EventSource::Log, ctx, et);
        event.limit = Some(EventLimit { provider: collector::contracts::common::Provider::Codex,
            window: LimitWindow::Unknown, resets_at: None }); events.push(event);
    }
    // Exactly one event carries the delta even when a record yields both windows.
    if let Some(first) = events.first_mut() {
        first.tokens_delta = delta;
        if total.is_some() { stream.total_tokens = total; }
    } else { rebase(stream); }
    Some(events)
}

#[derive(Deserialize)]
enum ItemKind {
    #[serde(rename = "CommandExecution")] Command,
    #[serde(rename = "McpToolCall")] Mcp,
    #[serde(rename = "FileChange")] File,
    #[serde(rename = "ImageView")] Image,
    #[serde(rename = "SubAgentActivity")] Subagent,
    #[serde(rename = "UserMessage")] User,
    #[serde(rename = "AgentMessage")] Agent,
    #[serde(rename = "Reasoning")] Reasoning,
    #[serde(rename = "ContextCompaction")] Compaction,
    #[serde(rename = "Extension")] Extension,
    #[serde(other)] Unknown,
}
#[derive(Deserialize)]
struct Item<'a> {
    #[serde(rename = "type")] kind: ItemKind,
    #[serde(default, borrow)] tool: Option<&'a str>,
}

#[derive(Deserialize)]
enum HookKind {
    SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse,
    PreCompact, PostCompact, SubagentStart, SubagentStop, Stop, Interrupt,
    #[serde(other)] Unknown,
}
#[derive(Deserialize)]
struct Hook<'a> {
    hook_event_name: HookKind,
    #[serde(default, borrow)] session_id: Option<&'a str>,
    #[serde(default, borrow)] agent_id: Option<&'a str>,
    #[serde(default, borrow)] tool_name: Option<&'a str>,
    #[serde(default, borrow)] timestamp: Option<RawTime<'a>>,
    #[serde(default)] host: Option<NamedHost>,
    #[serde(default)] reason: Option<RawEndReason>,
    #[serde(default, borrow)] turn_id: Option<&'a str>,
    #[serde(default, borrow)] request_id: Option<&'a str>,
    #[serde(default, borrow)] tool_use_id: Option<&'a str>,
    #[serde(default, borrow)] call_id: Option<&'a str>,
    #[serde(default, borrow)] account_id: Option<&'a str>,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawEndReason { Clear, Resume, Logout, Exit, #[serde(other)] Other }

pub(crate) fn hook(bytes: &[u8], ctx: &AdapterContext, root: &str,
    known: &std::collections::BTreeMap<String, Session>, diag: &mut Diagnostics) -> Result<Vec<AgentEvent>, AdapterError> {
    if bytes.len() > 262_144 { return Err(AdapterError::InvalidPayload); }
    let hook: Hook<'_> = serde_json::from_slice(bytes).map_err(|_| AdapterError::InvalidPayload)?;
    if matches!(hook.hook_event_name, HookKind::Unknown) {
        diag.unknown_hooks = diag.unknown_hooks.saturating_add(1); return Ok(Vec::new());
    }
    let raw = usable_id(hook.session_id).ok_or(AdapterError::InvalidPayload)?;
    let parent = ctx.instance(Tool::Codex, raw);
    let cached = known.get(&parent);
    let host = hook.host.map(Host::from).or_else(|| cached.map(|s| s.host)).unwrap_or(Host::Cli);
    let account_id = usable_id(hook.account_id).map(|id| ctx.instance(Tool::Codex, &format!("account:{id}")))
        .or_else(|| cached.and_then(|s| s.account_id.clone()));
    let child = matches!(hook.hook_event_name, HookKind::SubagentStart | HookKind::SubagentStop);
    let session = if child {
        let Some(id) = usable_id(hook.agent_id) else { return Ok(Vec::new()); };
        let instance = ctx.instance(Tool::Codex, id);
        if instance == parent { return Ok(Vec::new()); }
        Session { instance, parent: Some(parent.clone()), host, root_id: root.into(), account_id, session_id: parent }
    } else {
        // A session the rollout already described keeps its parent and session id, so hook and
        // log events (and their turn ids) agree.
        let session_id = cached.map_or_else(|| parent.clone(), |s| s.session_id.clone());
        Session { instance: parent.clone(), parent: cached.and_then(|s| s.parent.clone()), host,
            root_id: root.into(), account_id, session_id }
    };
    let kind = match hook.hook_event_name {
        HookKind::SessionStart | HookKind::SubagentStart => EventKind::SessionStart,
        HookKind::SessionEnd | HookKind::SubagentStop => EventKind::SessionEnd,
        HookKind::UserPromptSubmit => EventKind::TurnStart,
        HookKind::PermissionRequest => EventKind::NeedsPermission,
        HookKind::PreToolUse | HookKind::PreCompact | HookKind::PostCompact => EventKind::Heartbeat,
        HookKind::PostToolUse => EventKind::ToolEnd,
        HookKind::Stop => EventKind::TurnEnd,
        HookKind::Interrupt => EventKind::TurnInterrupted,
        HookKind::Unknown => unreachable!(),
    };
    let mut event = base(&session, kind, EventSource::Hook, ctx, source_time(hook.timestamp));
    event.turn_id = usable_id(hook.turn_id).map(|id| ctx.instance(Tool::Codex, &format!("turn:{}:{id}",session.session_id)));
    if matches!(kind, EventKind::NeedsPermission | EventKind::ToolEnd) {
        event.request_id = usable_id(hook.request_id.or(hook.tool_use_id).or(hook.call_id))
            .map(|id| ctx.instance(Tool::Codex, &format!("request:{}:{id}",session.session_id)));
    }
    match hook.hook_event_name {
        HookKind::Stop => stopped(&mut event, StopReason::EndTurn),
        HookKind::Interrupt => stopped(&mut event, StopReason::Interrupted),
        HookKind::PreToolUse | HookKind::PostToolUse => active(&mut event, tool_activity(hook.tool_name.unwrap_or(""))),
        HookKind::SessionEnd | HookKind::SubagentStop => {
            let reason = match hook.reason { Some(RawEndReason::Clear) => EndReason::Clear,
                Some(RawEndReason::Resume) => EndReason::Resume, Some(RawEndReason::Logout) => EndReason::Logout,
                Some(RawEndReason::Exit) => EndReason::Exit, _ => EndReason::Other };
            event.detail = Some(EventDetail { end_reason: Some(reason), ..detail() });
        },
        _ => {},
    }
    validated(vec![event])
}

fn tool_activity(name: &str) -> Activity {
    match name {
        "Bash" | "shell" | "shell_command" | "exec_command" | "write_stdin" => Activity::Shell,
        "Edit" | "Write" | "apply_patch" => Activity::Edit,
        "Read" | "Grep" | "Glob" | "search" | "read_file" | "view_image" => Activity::Read,
        "web.run" | "web" | "WebFetch" | "WebSearch" => Activity::Web,
        "Task" | "spawn_agent" | "delegate_task" => Activity::Delegate,
        _ => Activity::Other,
    }
}
