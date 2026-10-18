// AgentEvent v1 fixtures (contracts/schemas/agent-event.v1.schema.json).
import { T0, MIN, HOUR, MS_MIN, MS_MAX, hid, edit, fx, DELETE } from "../lib.mjs";

const SESSION = hid("agent-event-session-a");
const SUB = hid("agent-event-subagent-b");
const PARENT = hid("agent-event-parent-session");
const ROOT = hid("agent-event-root-a");
const ROOT_B = hid("agent-event-root-b");
const ACCOUNT = hid("agent-event-account-a");
const TURN = hid("agent-event-turn-a");
const REQUEST = hid("agent-event-request-a");
const RAW_UUID = "6f1c0a2e-1b2c-4d3e-8f9a-0b1c2d3e4f5a";

const slug = (s) => String(s).replace(/[_.]/g, "-");

const KINDS = [
  "session_start", "session_end", "turn_start", "tool_end", "needs_permission", "needs_answer",
  "answered", "turn_end", "turn_interrupted", "error", "limit_hit", "usage_sample",
  "process_up", "process_down", "heartbeat",
];
const TOOLS = ["claude", "codex", "opencode", "antigravity", "gemini", "cursor", "aider", "other"];
const HOSTS = ["cli", "desktop", "vscode", "sdk", "ide", "other"];
const SOURCES = ["hook", "registry", "log", "process", "plugin", "poll"];
const ACTIVITIES = ["shell", "edit", "read", "web", "delegate", "other"];
const ERROR_CLASSES = [
  "overloaded", "server_error", "network", "auth", "billing", "invalid_request",
  "model_not_found", "max_output_tokens", "unknown",
];
const NOTIFICATIONS = [
  "permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input",
  "elicitation_response", "elicitation_complete", "idle_prompt", "quota_auto_resume_fired",
  "quota_auto_resume_stale", "quota_auto_resume_disabled", "other",
];
const NOTIFY_KIND = [
  "needs_permission", "needs_answer", "needs_answer", "needs_answer", "answered", "answered",
  "heartbeat", "turn_start", "process_up", "heartbeat", "session_start",
];
const STOP_REASONS = [
  ["end_turn", "turn_end"], ["interrupted", "turn_interrupted"], ["max_tokens", "turn_end"],
  ["refusal", "turn_end"], ["other", "turn_interrupted"],
];
const END_REASONS = ["clear", "resume", "logout", "exit", "process_gone", "other"];

/**
 * A minimal valid event; every field here is one the schema requires. The identity fields
 * default to the connector root and the session, and to null for account, turn and request.
 */
function ev(over = {}) {
  return {
    v: 1,
    agent: "claude",
    instance: SESSION,
    parent: null,
    root_id: ROOT,
    account_id: null,
    session_id: SESSION,
    turn_id: null,
    request_id: null,
    host: "cli",
    kind: "turn_start",
    source: "hook",
    confidence: "exact",
    t: T0,
    ...over,
  };
}

const usageOf = (over = {}) => ({
  provider: "claude",
  window: "5h",
  used_pct: 42.5,
  resets_at: T0 + 2 * HOUR,
  observed_at: T0 - MIN,
  ...over,
});

const limitOf = (over = {}) => ({
  provider: "claude",
  window: "5h",
  resets_at: T0 + HOUR,
  ...over,
});

/** The companion field (or detail) each kind carries in its minimal form. */
const KIND_SHAPE = {
  session_start: {},
  session_end: { detail: { end_reason: "exit" } },
  turn_start: {},
  tool_end: { detail: { activity: "shell" } },
  needs_permission: { detail: { notification: "permission_prompt" } },
  needs_answer: { detail: { notification: "elicitation_dialog" } },
  answered: {},
  turn_end: { detail: { stop_reason: "end_turn" } },
  turn_interrupted: { detail: { stop_reason: "interrupted" } },
  error: { detail: { error_class: "network" } },
  limit_hit: { limit: limitOf() },
  usage_sample: { usage: usageOf() },
  process_up: {},
  process_down: {},
  heartbeat: {},
};

export function valid() {
  return [
    ...KINDS.map((k) =>
      fx(`kind-${slug(k)}`, `A minimal ${slug(k)} event with only the companion field that kind allows.`, ev({ kind: k, ...KIND_SHAPE[k] })),
    ),
    ...END_REASONS.map((r) =>
      fx(`end-reason-${slug(r)}`, `session_end with detail.end_reason ${r}.`, ev({ kind: "session_end", source: "process", detail: { end_reason: r } })),
    ),
    ...ACTIVITIES.map((a) =>
      fx(`activity-${a}`, `tool_end with activity ${a}, derived from the tool name.`, ev({ kind: "tool_end", source: "plugin", detail: { activity: a } })),
    ),
    fx("heartbeat-activity-edit", "heartbeat with an activity, the PreToolUse stand-in from CHANGES item 7.", ev({ kind: "heartbeat", detail: { activity: "edit" } })),
    fx("heartbeat-activity-delegate", "heartbeat announcing a subagent launch as delegate activity.", ev({ kind: "heartbeat", detail: { activity: "delegate" } })),
    ...NOTIFICATIONS.map((n, i) =>
      fx(`notification-${slug(n)}`, `The ${n} notification carried on a ${slug(NOTIFY_KIND[i])} event.`, ev({ kind: NOTIFY_KIND[i], source: "log", detail: { notification: n } })),
    ),
    fx("tool-end-activity-and-notification", "tool_end carries both an activity and a notification, two keys at once.", ev({ kind: "tool_end", detail: { activity: "edit", notification: "other" } })),
    ...ERROR_CLASSES.map((c) =>
      fx(`error-class-${slug(c)}`, `An error event with detail.error_class ${c}.`, ev({ kind: "error", source: "log", detail: { error_class: c } })),
    ),
    ...STOP_REASONS.map(([s, k]) =>
      fx(`stop-reason-${slug(s)}`, `A ${slug(k)} event with detail.stop_reason ${s}.`, ev({ kind: k, source: "log", detail: { stop_reason: s } })),
    ),
    ...TOOLS.map((t) =>
      fx(`tool-${t}`, `A session_start from the ${t} agent.`, ev({ agent: t, kind: "session_start", instance: hid(`tool-${t}`) })),
    ),
    ...HOSTS.map((h) =>
      fx(`host-${h}`, `A turn_start hosted in ${h}, from a codex agent.`, ev({ agent: "codex", kind: "turn_start", host: h, instance: SUB })),
    ),
    ...SOURCES.map((s) =>
      fx(`source-${s}`, `An aider turn_start observed through the ${s} source.`, ev({ agent: "aider", kind: "turn_start", source: s })),
    ),
    fx("confidence-exact", "An exact confidence on a gemini heartbeat from the process source.", ev({ agent: "gemini", kind: "heartbeat", source: "process", confidence: "exact" })),
    fx("confidence-inferred", "An inferred confidence on a gemini heartbeat from the process source.", ev({ agent: "gemini", kind: "heartbeat", source: "process", confidence: "inferred" })),
    fx("usage-codex-5h", "A codex usage_sample for the 5h window with provider codex.", ev({ agent: "codex", kind: "usage_sample", usage: usageOf({ provider: "codex" }) })),
    fx("usage-claude-weekly", "A claude usage_sample for the weekly window.", ev({ kind: "usage_sample", usage: usageOf({ window: "weekly", used_pct: 77 }) })),
    fx("usage-codex-weekly", "A codex usage_sample for the weekly window at 7 percent.", ev({ agent: "codex", kind: "usage_sample", usage: usageOf({ provider: "codex", window: "weekly", used_pct: 7 }) })),
    fx("usage-used-pct-zero", "used_pct at the 0 minimum.", ev({ kind: "usage_sample", usage: usageOf({ used_pct: 0 }) })),
    fx("usage-used-pct-hundred", "used_pct at the 100 maximum.", ev({ kind: "usage_sample", usage: usageOf({ used_pct: 100 }) })),
    fx("usage-resets-at-min", "usage resets_at at the minimum legal timestamp.", ev({ kind: "usage_sample", usage: usageOf({ resets_at: MS_MIN }) })),
    fx("usage-resets-at-max", "usage resets_at at the maximum legal timestamp.", ev({ kind: "usage_sample", usage: usageOf({ resets_at: MS_MAX }) })),
    fx("usage-observed-at-min", "usage observed_at at the minimum legal timestamp.", ev({ kind: "usage_sample", usage: usageOf({ observed_at: MS_MIN }) })),
    fx("usage-with-tokens-delta", "A usage_sample that also carries a tokens_delta.", ev({ kind: "usage_sample", usage: usageOf(), tokens_delta: 1500 })),
    fx("limit-claude-weekly", "A claude limit_hit on the weekly window.", ev({ kind: "limit_hit", limit: limitOf({ window: "weekly", resets_at: T0 + 72 * HOUR }) })),
    fx("limit-claude-unknown-reset-null", "A claude limit_hit with window unknown and resets_at null, as StopFailure rate_limit gives.", ev({ kind: "limit_hit", limit: limitOf({ window: "unknown", resets_at: null }) })),
    fx("limit-codex-5h", "A codex limit_hit on the 5h window.", ev({ agent: "codex", kind: "limit_hit", limit: limitOf({ provider: "codex" }) })),
    fx("limit-codex-weekly", "A codex limit_hit on the weekly window.", ev({ agent: "codex", kind: "limit_hit", limit: limitOf({ provider: "codex", window: "weekly" }) })),
    fx("limit-codex-unknown-window", "A codex limit_hit with window unknown but a known reset time.", ev({ agent: "codex", kind: "limit_hit", limit: limitOf({ provider: "codex", window: "unknown" }) })),
    fx("limit-codex-reset-null", "A codex limit_hit on the 5h window with the reset time unknown.", ev({ agent: "codex", kind: "limit_hit", limit: limitOf({ provider: "codex", resets_at: null }) })),
    fx("limit-resets-at-min", "limit resets_at at the minimum legal timestamp.", ev({ kind: "limit_hit", limit: limitOf({ resets_at: MS_MIN }) })),
    fx("limit-resets-at-max", "limit resets_at at the maximum legal timestamp.", ev({ kind: "limit_hit", limit: limitOf({ resets_at: MS_MAX }) })),
    fx("et-present", "et is present because the source states a time.", ev({ kind: "tool_end", detail: { activity: "read" }, et: T0 - 5000 })),
    fx("et-at-min", "et at the minimum legal timestamp.", ev({ kind: "turn_start", et: MS_MIN })),
    fx("et-at-max", "et at the maximum legal timestamp.", ev({ kind: "turn_start", et: MS_MAX })),
    fx("tokens-delta-zero", "tokens_delta at the 0 minimum.", ev({ kind: "heartbeat", tokens_delta: 0 })),
    fx("tokens-delta-max", "tokens_delta at the 1000000000 maximum.", ev({ kind: "heartbeat", tokens_delta: 1000000000 })),
    fx("tokens-delta-typical", "tokens_delta with a typical sample size.", ev({ kind: "heartbeat", tokens_delta: 240 })),
    fx("t-at-min", "t at the minimum legal timestamp.", ev({ t: MS_MIN })),
    fx("t-at-max", "t at the maximum legal timestamp.", ev({ t: MS_MAX })),
    fx("subagent-codex-parent", "A codex subagent names its parent session instance, and its session_id is that parent's session.", ev({ agent: "codex", instance: SUB, parent: PARENT, session_id: PARENT, kind: "turn_start" })),
    fx("subagent-claude-parent", "A claude subagent with a parent instance and a tool_end activity.", ev({ instance: SUB, parent: SESSION, kind: "tool_end", detail: { activity: "delegate" } })),
    fx("usage-on-claude-session", "A claude session reporting a usage sample for its own provider.", ev({ kind: "usage_sample", agent: "claude", usage: usageOf({ provider: "claude", window: "5h" }), tokens_delta: 0 })),

    // r1 identity fields and the request_id rule.
    fx("request-needs-permission-with-id", "needs_permission carries the salted id of the permission request.", ev({ kind: "needs_permission", detail: { notification: "permission_prompt" }, request_id: REQUEST })),
    fx("request-needs-answer-with-id", "needs_answer carries the salted id of the open question.", ev({ kind: "needs_answer", detail: { notification: "elicitation_dialog" }, request_id: REQUEST })),
    fx("request-answered-with-id", "answered closes the request and carries the same salted request id.", ev({ kind: "answered", request_id: REQUEST })),
    fx("request-tool-end-with-id", "tool_end carries the salted tool use id as its request id.", ev({ kind: "tool_end", detail: { activity: "edit" }, request_id: REQUEST })),
    fx("request-id-null-on-codex-permission", "A codex needs_permission whose source did not supply a request id, so request_id is null.", ev({ agent: "codex", kind: "needs_permission", detail: { notification: "permission_prompt" }, request_id: null })),
    fx("account-id-set", "A turn_start carrying the salted provider account id.", ev({ kind: "turn_start", account_id: ACCOUNT })),
    fx("session-id-null-process-up", "process_up before the session id is known, so session_id is null.", ev({ kind: "process_up", source: "process", session_id: null })),
    fx("turn-id-set", "A turn_start carrying the salted id of the turn it starts.", ev({ kind: "turn_start", turn_id: TURN })),
    fx("turn-id-set-on-turn-end", "A turn_end with the same salted turn id, so the collector can match it to its start.", ev({ kind: "turn_end", detail: { stop_reason: "end_turn" }, turn_id: TURN })),
    fx("root-id-second-connector", "A heartbeat from a second connector: the same agent with a different root_id.", ev({ kind: "heartbeat", root_id: ROOT_B })),
    fx("usage-sample-with-account-id", "A usage_sample whose limits are kept under the salted account id.", ev({ kind: "usage_sample", account_id: ACCOUNT, usage: usageOf() })),
    fx("usage-sample-without-account-id", "A weekly claude usage_sample from a source that does not name the account.", ev({ kind: "usage_sample", usage: usageOf({ window: "weekly", used_pct: 12 }) })),
  ];
}

export function invalid() {
  const base = ev({ kind: "tool_end", detail: { activity: "shell" } });
  const errBase = ev({ kind: "error", detail: { error_class: "network" } });
  const turnBase = ev({ kind: "turn_end", detail: { stop_reason: "end_turn" } });
  const sessionEnd = ev({ kind: "session_end", detail: { end_reason: "exit" } });
  const usageBase = ev({ kind: "usage_sample", usage: usageOf() });
  const limitBase = ev({ kind: "limit_hit", limit: limitOf() });

  const leaks = [
    ["prompt", "fix the failing test"],
    ["tool_input", { command: "ls -la /example/project" }],
    ["message", "Hello from the agent"],
    ["cwd", "/example/project"],
    ["transcript_path", "/example/transcripts/session.jsonl"],
    ["last_assistant_message", "All done."],
  ];

  return [
    fx("root-array", "The root must be an object, not an array.", [base], ""),
    fx("root-null", "The root must be an object, not null.", null, ""),
    fx("root-string", "The root must be an object, not a string.", "tool_end", ""),
    fx("missing-v", "v is required.", edit(base, { v: DELETE }), ""),
    fx("missing-agent", "agent is required.", edit(base, { agent: DELETE }), ""),
    fx("missing-instance", "instance is required.", edit(base, { instance: DELETE }), ""),
    fx("missing-parent", "parent is required and is null when there is no parent.", edit(base, { parent: DELETE }), ""),
    fx("missing-host", "host is required.", edit(base, { host: DELETE }), ""),
    fx("missing-kind", "kind is required.", edit(base, { kind: DELETE }), ""),
    fx("missing-source", "source is required.", edit(base, { source: DELETE }), ""),
    fx("missing-confidence", "confidence is required.", edit(base, { confidence: DELETE }), ""),
    fx("missing-t", "t is required.", edit(base, { t: DELETE }), ""),
    ...leaks.map(([key, value]) =>
      fx(`leak-${slug(key)}`, `The raw ${key} field is an unknown property and is rejected.`, edit(base, { [key]: value }), ""),
    ),
    fx("unknown-top-level-field", "An unknown top-level field is rejected by the closed object.", edit(base, { schema_hint: "v1" }), ""),
    fx("instance-raw-uuid", "A raw UUID session id cannot match the salted 32 hex shape.", edit(base, { instance: RAW_UUID }), "/instance"),
    fx("instance-uppercase-hex", "Instance hex must be lowercase.", edit(base, { instance: SESSION.toUpperCase() }), "/instance"),
    fx("instance-too-short", "Instance must be exactly 32 characters.", edit(base, { instance: SESSION.slice(0, 31) }), "/instance"),
    fx("instance-not-hex", "Instance characters must be hexadecimal.", edit(base, { instance: "z".repeat(32) }), "/instance"),
    fx("parent-raw-uuid", "A subagent parent must also be a salted id, never a raw UUID.", edit(base, { parent: RAW_UUID }), "/parent"),
    fx("version-two", "v must be the constant 1.", edit(base, { v: 2 }), "/v"),
    fx("version-string", "v must be the integer 1, not a string.", edit(base, { v: "1" }), "/v"),
    fx("agent-unknown-tool", "agent must be one of the known tools.", edit(base, { agent: "gemini-cli" }), "/agent"),
    fx("host-unknown", "host must be one of the known hosts.", edit(base, { host: "terminal" }), "/host"),
    fx("kind-tool-start", "tool_start is not a kind in v0.1 (CHANGES item 7).", edit(base, { kind: "tool_start", detail: DELETE }), "/kind"),
    fx("source-unknown", "source must be one of the six sources.", edit(base, { source: "websocket" }), "/source"),
    fx("confidence-unknown", "confidence is exact or inferred.", edit(base, { confidence: "certain" }), "/confidence"),
    fx("detail-activity-unknown", "activity must be a closed value; the tool name Bash is not one.", edit(base, { detail: { activity: "Bash" } }), "/detail/activity"),
    fx("detail-error-class-rate-limit", "rate_limit is a limit_hit, not an error_class (CHANGES item 5).", edit(errBase, { detail: { error_class: "rate_limit" } }), "/detail/error_class"),
    fx("detail-notification-unknown", "notification must be one of the listed notification types.", edit(base, { detail: { notification: "toast" } }), "/detail/notification"),
    fx("detail-stop-reason-unknown", "stop_reason must be one of the five closed values.", edit(turnBase, { detail: { stop_reason: "stop" } }), "/detail/stop_reason"),
    fx("detail-end-reason-unknown", "end_reason must be one of the six closed values.", edit(sessionEnd, { detail: { end_reason: "timeout" } }), "/detail/end_reason"),
    fx("detail-unknown-key", "detail has no free-text key, so an unknown key is rejected.", edit(base, { detail: { activity: "shell", text: "ls -la" } }), "/detail"),
    fx("detail-empty", "detail is omitted rather than sent empty.", edit(base, { detail: {} }), "/detail"),
    fx("detail-null", "detail is omitted, never null.", edit(base, { detail: null }), "/detail"),
    fx("detail-activity-on-turn-start", "activity is only allowed on tool_end and heartbeat.", edit(base, { kind: "turn_start" }), "/detail"),
    fx("detail-error-class-on-tool-end", "error_class is only allowed on error.", edit(base, { detail: { error_class: "network" } }), "/detail"),
    fx("detail-stop-reason-on-error", "stop_reason is only allowed on turn_end and turn_interrupted.", edit(errBase, { detail: { stop_reason: "end_turn" } }), "/detail"),
    fx("detail-end-reason-on-turn-end", "end_reason is only allowed on session_end.", edit(turnBase, { detail: { end_reason: "exit" } }), "/detail"),
    fx("t-in-seconds", "t in seconds is below the millisecond range.", edit(base, { t: T0 / 1000 }), "/t"),
    fx("t-below-min", "t is one millisecond before 2000-01-01.", edit(base, { t: MS_MIN - 1 }), "/t"),
    fx("t-above-max", "t is one millisecond after 2100-01-01.", edit(base, { t: MS_MAX + 1 }), "/t"),
    fx("t-iso-string", "t must be an integer, not an ISO timestamp string.", edit(base, { t: "2026-10-12T12:00:00Z" }), "/t"),
    fx("et-in-seconds", "et in seconds is below the millisecond range.", edit(base, { et: T0 / 1000 }), "/et"),
    fx("et-null", "et is omitted when the source states no time, never null.", edit(base, { et: null }), "/et"),
    fx("et-above-max", "et is one millisecond after 2100-01-01.", edit(base, { et: MS_MAX + 1 }), "/et"),
    fx("usage-sample-without-usage", "A usage_sample must carry usage.", ev({ kind: "usage_sample" }), ""),
    fx("usage-on-heartbeat", "usage is only allowed on usage_sample.", ev({ kind: "heartbeat", usage: usageOf() }), ""),
    fx("usage-null-on-usage-sample", "usage is omitted or present, never null.", edit(usageBase, { usage: null }), "/usage"),
    fx("limit-hit-without-limit", "A limit_hit must carry limit.", ev({ kind: "limit_hit" }), ""),
    fx("limit-on-error", "limit is only allowed on limit_hit.", ev({ kind: "error", detail: { error_class: "network" }, limit: limitOf() }), ""),
    fx("limit-null-on-limit-hit", "limit is omitted or present, never null.", edit(limitBase, { limit: null }), "/limit"),
    fx("usage-provider-not-agent", "A claude agent's usage provider must be claude.", edit(usageBase, { "usage.provider": "codex" }), "/usage/provider"),
    fx("limit-provider-not-agent", "A codex agent's limit provider must be codex.", edit(limitBase, { agent: "codex", "limit.provider": "claude" }), "/limit/provider"),
    fx("usage-on-opencode", "usage is only reported by claude and codex in v0.1.", edit(usageBase, { agent: "opencode" }), ""),
    fx("limit-on-gemini", "limit is only reported by claude and codex in v0.1.", edit(limitBase, { agent: "gemini" }), ""),
    fx("usage-on-other-agent", "The catch-all other agent carries no usage.", edit(usageBase, { agent: "other" }), ""),
    fx("usage-missing-provider", "usage.provider is required.", edit(usageBase, { "usage.provider": DELETE }), "/usage"),
    fx("usage-missing-window", "usage.window is required.", edit(usageBase, { "usage.window": DELETE }), "/usage"),
    fx("usage-missing-used-pct", "usage.used_pct is required.", edit(usageBase, { "usage.used_pct": DELETE }), "/usage"),
    fx("usage-missing-resets-at", "usage.resets_at is required.", edit(usageBase, { "usage.resets_at": DELETE }), "/usage"),
    fx("usage-missing-observed-at", "usage.observed_at is required.", edit(usageBase, { "usage.observed_at": DELETE }), "/usage"),
    fx("usage-extra-field", "usage is a closed object with no extra fields.", edit(usageBase, { "usage.note": "heavy use" }), "/usage"),
    fx("usage-window-unknown", "usage windows are 5h or weekly; unknown is only for limits.", edit(usageBase, { "usage.window": "unknown" }), "/usage/window"),
    fx("usage-used-pct-over", "used_pct is at most 100.", edit(usageBase, { "usage.used_pct": 100.5 }), "/usage/used_pct"),
    fx("usage-used-pct-negative", "used_pct is at least 0.", edit(usageBase, { "usage.used_pct": -0.5 }), "/usage/used_pct"),
    fx("usage-resets-at-seconds", "usage resets_at in seconds is rejected (CHANGES item 1).", edit(usageBase, { "usage.resets_at": T0 / 1000 }), "/usage/resets_at"),
    fx("usage-observed-at-below-min", "usage observed_at below the millisecond range.", edit(usageBase, { "usage.observed_at": MS_MIN - 1 }), "/usage/observed_at"),
    fx("limit-missing-provider", "limit.provider is required.", edit(limitBase, { "limit.provider": DELETE }), "/limit"),
    fx("limit-missing-window", "limit.window is required.", edit(limitBase, { "limit.window": DELETE }), "/limit"),
    fx("limit-missing-resets-at", "limit.resets_at is required even though it may be null.", edit(limitBase, { "limit.resets_at": DELETE }), "/limit"),
    fx("limit-window-five-hours", "limit windows are spelled 5h, weekly or unknown.", edit(limitBase, { "limit.window": "5hours" }), "/limit/window"),
    fx("limit-resets-at-seconds", "limit resets_at in seconds is rejected.", edit(limitBase, { "limit.resets_at": T0 / 1000 }), "/limit/resets_at"),
    fx("limit-extra-field", "limit is a closed object with no extra fields.", edit(limitBase, { "limit.message": "rate limited" }), "/limit"),
    fx("tokens-delta-negative", "tokens_delta is at least 0.", edit(base, { tokens_delta: -1 }), "/tokens_delta"),
    fx("tokens-delta-over-max", "tokens_delta is at most 1000000000.", edit(base, { tokens_delta: 1000000001 }), "/tokens_delta"),
    fx("tokens-delta-fraction", "tokens_delta must be an integer, not 2.5.", edit(base, { tokens_delta: 2.5 }), "/tokens_delta"),
    fx("tokens-delta-null", "tokens_delta is omitted, never null.", edit(base, { tokens_delta: null }), "/tokens_delta"),
    fx("tokens-delta-string", "tokens_delta must be a number, not a string.", edit(base, { tokens_delta: "12" }), "/tokens_delta"),

    // r1 identity fields: each is required (even when null), and each has its own shape.
    fx("root-id-missing", "root_id is required.", edit(base, { root_id: DELETE }), ""),
    fx("root-id-null", "root_id is never null: every event names the connector that produced it.", edit(base, { root_id: null }), "/root_id"),
    fx("root-id-raw-uuid", "root_id must be a salted hash, so a raw UUID is rejected.", edit(base, { root_id: RAW_UUID }), "/root_id"),
    fx("root-id-uppercase", "root_id must be lowercase hex.", edit(base, { root_id: ROOT.toUpperCase() }), "/root_id"),
    fx("account-id-missing", "account_id is required even though it may be null.", edit(base, { account_id: DELETE }), ""),
    fx("account-id-raw-uuid", "account_id must be a salted hash, never the raw provider account id.", edit(base, { account_id: RAW_UUID }), "/account_id"),
    fx("session-id-missing", "session_id is required even though it may be null.", edit(base, { session_id: DELETE }), ""),
    fx("session-id-raw-uuid", "A raw UUID session id is rejected because session_id is a salted hash.", edit(base, { session_id: RAW_UUID }), "/session_id"),
    fx("turn-id-missing", "turn_id is required even though it may be null.", edit(base, { turn_id: DELETE }), ""),
    fx("turn-id-uppercase", "turn_id must be lowercase hex.", edit(base, { turn_id: TURN.toUpperCase() }), "/turn_id"),
    fx("request-id-missing", "request_id is required even though it is null on most kinds.", edit(base, { request_id: DELETE }), ""),
    fx("request-id-raw-uuid", "request_id must be a salted hash, so a raw tool use id is rejected.", edit(base, { request_id: RAW_UUID }), "/request_id"),
    fx("request-id-on-turn-start", "request_id is only allowed on the four request kinds, and this turn_start sets it.", ev({ kind: "turn_start", request_id: REQUEST }), "/request_id"),
    fx("request-id-on-turn-end", "request_id is only allowed on the four request kinds, and this turn_end sets it.", ev({ kind: "turn_end", detail: { stop_reason: "end_turn" }, request_id: REQUEST }), "/request_id"),
    fx("request-id-on-heartbeat", "request_id is only allowed on the four request kinds, and this heartbeat sets it.", ev({ kind: "heartbeat", request_id: REQUEST }), "/request_id"),
  ];
}
