// Snapshot v2 fixtures (contracts/schemas/snapshot.v2.schema.json).
import { T0, MIN, HOUR, MS_MIN, MS_MAX, hid, edit, fx, DELETE } from "../lib.mjs";

const A = hid("snapshot-agent-a");
const B = hid("snapshot-agent-b");
const ROOT = hid("snapshot-root-claude");
const ROOT2 = hid("snapshot-root-codex");
const ACCT = hid("snapshot-account-1");
const ACCT2 = hid("snapshot-account-2");
const SESS = hid("snapshot-session-a");
const TURN = hid("snapshot-turn-a");
const REQ = hid("snapshot-request-a");

function toolStatus(over = {}) {
  return { tool: "claude", root_id: ROOT, presence: "present", hooks: "installed", coverage: "verified", coverage_reason: null, ...over };
}

function limitOf(over = {}) {
  return { provider: "claude", window: "5h", account_id: ACCT, root_id: ROOT, used_pct: 42.5, resets_at: T0 + 2 * HOUR, observed_at: T0 - MIN, stale: false, ...over };
}

function agent(over = {}) {
  return {
    id: A,
    tool: "claude",
    host: "cli",
    ordinal: 1,
    parent: null,
    root_id: ROOT,
    account_id: ACCT,
    session_id: SESS,
    turn_id: TURN,
    request_id: null,
    state: "working",
    confidence: "exact",
    since: T0 - 2 * MIN,
    started_at: T0 - HOUR,
    ...over,
  };
}

function snap(over = {}) {
  return {
    schema_version: 2,
    t: T0,
    demo: false,
    agents: [agent({ activity: "shell" })],
    tools: [toolStatus()],
    limits: [limitOf()],
    attention: { needs_you: 0, oldest_since: null },
    ...over,
  };
}

const empty = () => snap({ agents: [], tools: [], limits: [] });
const one = (a) => snap({ agents: [a] });
const waiting = (a) => snap({ agents: [a], attention: { needs_you: 1, oldest_since: a.since } });

export function valid() {
  const out = [
    fx("empty", "No agents, no tools, no limits: a fresh install before anything is seen.", empty()),
    fx("one-working-shell", "One Claude CLI resident working with the shell activity.", snap()),
    fx("starting", "A new session in state starting.", one(agent({ state: "starting", since: T0 - 1000 }))),
    fx("working-no-activity", "Working with no activity known (activity is optional).", one(agent())),
    fx("needs-you-permission", "needs_you with reason permission and attention counted.", waiting(agent({ state: "needs_you", reason: "permission", since: T0 - 30000 }))),
    fx("needs-you-question", "needs_you with reason question.", waiting(agent({ state: "needs_you", reason: "question", since: T0 - 5000 }))),
    fx("your-turn", "A finished turn waiting for the next prompt.", one(agent({ state: "your_turn" }))),
    fx("error", "An agent in the error state.", one(agent({ state: "error" }))),
    fx("limited-with-reset", "limited with a known reset time.", one(agent({ state: "limited", limited_until: T0 + 3 * HOUR }))),
    fx("limited-unknown-reset", "limited with the reset time unknown (limited_until omitted).", one(agent({ state: "limited" }))),
    fx("idle", "An idle agent.", one(agent({ state: "idle" }))),
    fx("unknown-inferred", "A stale agent shown as unknown with inferred confidence.", one(agent({ state: "unknown", confidence: "inferred" }))),
    ...["edit", "read", "web", "delegate", "other"].map((act) =>
      fx(`activity-${act}`, `Working with activity ${act}.`, one(agent({ activity: act }))),
    ),
    ...["desktop", "vscode", "sdk", "ide", "other"].map((host) =>
      fx(`host-${host}`, `An agent hosted in ${host}.`, one(agent({ host }))),
    ),
    ...["codex", "opencode", "antigravity", "gemini", "cursor", "aider", "other"].map((tool) =>
      fx(`tool-${tool}`, `A resident for tool ${tool}.`, snap({ agents: [agent({ tool, id: hid(`tool-${tool}`) })], tools: [toolStatus({ tool, root_id: hid(`root-${tool}`), hooks: "missing", coverage: "degraded", coverage_reason: "hooks_missing" })], limits: [] })),
    ),
    fx("subagent-helper", "A subagent helper linked to its parent.", snap({ agents: [agent(), agent({ id: B, ordinal: 2, parent: A, state: "working", activity: "read" })] })),
    fx("two-sessions-same-tool", "Two concurrent Codex sessions with ordinals 1 and 2.", snap({ agents: [agent({ tool: "codex", id: A }), agent({ tool: "codex", id: B, ordinal: 2, state: "idle" })], limits: [] })),
    fx("project-label-opt-in", "Project label present because the user opted in.", one(agent({ project_label: "busyholm" }))),
    fx("project-label-unicode-spaces", "Project label with spaces and non-ASCII letters.", one(agent({ project_label: "Mon Projet été" }))),
    fx("project-label-max-length", "Project label at the 128 character maximum.", one(agent({ project_label: "p".repeat(128) }))),
    fx("demo-mode", "A demo-mode snapshot (Demo sign shown, no OS notifications).", snap({ demo: true })),
    fx("tools-every-hook-state", "One connector per hook state, offline and present.", snap({ agents: [], limits: [], tools: [
      toolStatus(),
      toolStatus({ tool: "codex", root_id: ROOT2, presence: "offline", hooks: "pending_review", coverage: "degraded", coverage_reason: "hooks_pending_review" }),
      toolStatus({ tool: "opencode", root_id: hid("root-opencode"), hooks: "missing", coverage: "degraded", coverage_reason: "hooks_missing" }),
      toolStatus({ tool: "antigravity", root_id: hid("root-agy"), presence: "offline", hooks: "unsupported", coverage: "unsupported", coverage_reason: "no_permission_event" }),
    ] })),
    fx("all-four-limits", "Both providers with both windows, one stale.", snap({ limits: [
      limitOf({ used_pct: 0, resets_at: T0 + HOUR, observed_at: T0 }),
      limitOf({ window: "weekly", used_pct: 100, resets_at: T0 + 72 * HOUR, observed_at: T0 }),
      limitOf({ provider: "codex", root_id: ROOT2, used_pct: 63.25, observed_at: T0 - 40 * MIN, stale: true }),
      limitOf({ provider: "codex", root_id: ROOT2, window: "weekly", used_pct: 7, resets_at: T0 + 100 * HOUR }),
    ] })),
    ...["hooks_missing", "hooks_pending_review", "round_trip_pending", "round_trip_failed", "receiver_unreachable", "bare_session", "no_permission_event", "experimental_adapter", "remote_session", "os_unsupported", "other"].map((reason, i) =>
      fx(`coverage-reason-${reason.replace(/_/g, "-")}`, `A connector whose coverage is not verified, because ${reason}.`, snap({ tools: [toolStatus({ coverage: i % 2 ? "unsupported" : "degraded", coverage_reason: reason })] })),
    ),
    fx("two-roots-same-tool", "Two Claude connectors (two data roots), each with its own coverage.", snap({ tools: [toolStatus(), toolStatus({ root_id: ROOT2, coverage: "degraded", coverage_reason: "round_trip_pending" })] })),
    fx("limits-per-account", "Two Claude accounts keep separate 5h limits; they are never merged.", snap({ limits: [limitOf(), limitOf({ account_id: ACCT2, root_id: ROOT2, used_pct: 90 })] })),
    fx("limits-unknown-account-per-root", "Unknown accounts are kept per root.", snap({ limits: [limitOf({ account_id: null }), limitOf({ account_id: null, root_id: ROOT2, used_pct: 12 })] })),
    fx("identity-all-null", "Account, session and turn unknown (for example a process seen before its first hook).", one(agent({ state: "starting", account_id: null, session_id: null, turn_id: null }))),
    fx("needs-you-with-request", "needs_you keyed by its request id.", waiting(agent({ state: "needs_you", reason: "permission", request_id: REQ, since: T0 - 4000 }))),
    fx("needs-you-restored-inferred", "A needs_you restored after a restart is shown as inferred until confirmed.", waiting(agent({ state: "needs_you", reason: "permission", request_id: REQ, confidence: "inferred", since: T0 - 600000 }))),
    fx("max-tools-and-limits", "16 connectors and 16 limit entries, the maxima.", snap({
      tools: Array.from({ length: 16 }, (_, i) => toolStatus({ root_id: hid(`max-root-${i}`) })),
      limits: Array.from({ length: 16 }, (_, i) => limitOf({ account_id: hid(`max-acct-${i}`), window: i % 2 ? "weekly" : "5h" })),
    })),
    fx("two-waiting", "Two agents waiting; attention counts both and names the oldest.", snap({
      agents: [agent({ state: "needs_you", reason: "permission", since: T0 - 90000 }), agent({ id: B, tool: "codex", state: "needs_you", reason: "question", since: T0 - 10000 })],
      attention: { needs_you: 2, oldest_since: T0 - 90000 },
    })),
    fx("max-agents", "64 agents, the maximum.", snap({ agents: Array.from({ length: 64 }, (_, i) => agent({ id: hid(`max-${i}`), tool: "codex", ordinal: i + 1, state: "idle" })), limits: [] })),
    fx("ordinal-999", "The largest ordinal.", one(agent({ ordinal: 999 }))),
    fx("timestamps-at-bounds", "Timestamps at the legal minimum and maximum.", snap({ t: MS_MAX, agents: [agent({ since: MS_MIN, started_at: MS_MIN })], limits: [] })),
  ];
  return out;
}

export function invalid() {
  const base = snap();
  return [
    fx("root-array", "The root must be an object.", [base], ""),
    fx("root-null", "The root must be an object.", null, ""),
    fx("schema-version-1", "schema_version must be 2 (Relay v1 is not accepted).", edit(base, { schema_version: 1 }), "/schema_version"),
    fx("missing-demo", "demo is required.", edit(base, { demo: DELETE }), ""),
    fx("extra-top-level", "Unknown top-level fields are rejected.", edit(base, { generated_by: "x" }), ""),
    fx("t-in-seconds", "t in seconds is below the ms range.", edit(base, { t: 1791806400 }), "/t"),
    fx("t-string", "t must be an integer, not an ISO string.", edit(base, { t: "2026-10-12T12:00:00Z" }), "/t"),
    fx("agents-not-array", "agents must be an array.", edit(base, { agents: {} }), "/agents"),
    fx("agent-missing-id", "id is required.", edit(base, { "agents.0.id": DELETE }), "/agents/0"),
    fx("agent-id-raw-uuid", "A raw UUID is not a salted 32-hex id.", edit(base, { "agents.0.id": "6f1c0a2e-1b2c-4d3e-8f9a-0b1c2d3e4f5a" }), "/agents/0/id"),
    fx("agent-id-uppercase", "Ids are lowercase hex.", edit(base, { "agents.0.id": A.toUpperCase() }), "/agents/0/id"),
    fx("agent-leaked-prompt", "A content field such as prompt is rejected as unknown.", edit(base, { "agents.0.prompt": "fix the bug" }), "/agents/0"),
    fx("agent-tool-unknown", "tool must be one of the known tools.", edit(base, { "agents.0.tool": "gemini-cli" }), "/agents/0/tool"),
    fx("agent-host-unknown", "host must be one of the known hosts.", edit(base, { "agents.0.host": "terminal" }), "/agents/0/host"),
    fx("ordinal-zero", "ordinal starts at 1.", edit(base, { "agents.0.ordinal": 0 }), "/agents/0/ordinal"),
    fx("ordinal-1000", "ordinal is at most 999.", edit(base, { "agents.0.ordinal": 1000 }), "/agents/0/ordinal"),
    fx("state-waiting-v1", "Relay v1 state waiting is split into needs_you and your_turn.", edit(base, { "agents.0.state": "waiting", "agents.0.activity": DELETE }), "/agents/0/state"),
    fx("state-finished-v1", "finished is a Moment, not a state.", edit(base, { "agents.0.state": "finished", "agents.0.activity": DELETE }), "/agents/0/state"),
    fx("state-offline", "offline is per tool, not an agent state.", edit(base, { "agents.0.state": "offline", "agents.0.activity": DELETE }), "/agents/0/state"),
    fx("needs-you-without-reason", "needs_you requires a reason.", edit(base, { "agents.0.state": "needs_you", "agents.0.activity": DELETE, attention: { needs_you: 1, oldest_since: T0 } }), "/agents/0"),
    fx("reason-on-working", "reason is only allowed with needs_you.", edit(base, { "agents.0.reason": "permission" }), "/agents/0"),
    fx("activity-on-idle", "activity is only allowed while working.", edit(base, { "agents.0.state": "idle" }), "/agents/0"),
    fx("activity-unknown", "activity must be a known value.", edit(base, { "agents.0.activity": "Bash" }), "/agents/0/activity"),
    fx("limited-until-on-working", "limited_until is only allowed with limited.", edit(base, { "agents.0.limited_until": T0 + HOUR }), "/agents/0"),
    fx("reason-null", "Optional fields are omitted, never null.", edit(base, { "agents.0.state": "needs_you", "agents.0.activity": DELETE, "agents.0.reason": null, attention: { needs_you: 1, oldest_since: T0 } }), "/agents/0"),
    fx("parent-missing", "parent is required (null when there is none).", edit(base, { "agents.0.parent": DELETE }), "/agents/0"),
    fx("project-label-slash", "A project label is a last folder segment, never a path.", edit(base, { "agents.0.project_label": "Users/me/app" }), "/agents/0/project_label"),
    fx("project-label-backslash", "Windows separators are rejected too.", edit(base, { "agents.0.project_label": "me\\app" }), "/agents/0/project_label"),
    fx("project-label-empty", "An empty project label is rejected.", edit(base, { "agents.0.project_label": "" }), "/agents/0/project_label"),
    fx("project-label-too-long", "A project label over 128 characters is rejected.", edit(base, { "agents.0.project_label": "p".repeat(129) }), "/agents/0/project_label"),
    fx("project-label-newline", "Control characters are rejected.", edit(base, { "agents.0.project_label": "app\nname" }), "/agents/0/project_label"),
    fx("duplicate-agent-id", "Agent ids are unique.", edit(base, { agents: [agent(), agent({ ordinal: 2 })] }), "/agents/1"),
    fx("duplicate-tool-ordinal", "The pair tool and ordinal is unique.", edit(base, { agents: [agent(), agent({ id: B })] }), "/agents/1"),
    fx("duplicate-tool-status", "One tools entry per tool and root.", edit(base, { tools: [toolStatus(), toolStatus({ presence: "offline", hooks: "missing", coverage: "degraded", coverage_reason: "hooks_missing" })] }), "/tools/1"),
    fx("presence-online", "presence is present or offline.", edit(base, { "tools.0.presence": "online" }), "/tools/0/presence"),
    fx("hooks-connected", "hooks uses the four defined states.", edit(base, { "tools.0.hooks": "connected" }), "/tools/0/hooks"),
    fx("duplicate-limit-window", "One limits entry per provider, window, account and root.", edit(base, { limits: [base.limits[0], { ...base.limits[0], used_pct: 50 }] }), "/limits/1"),
    fx("duplicate-limit-null-account", "Two unknown-account entries for the same root collide.", edit(base, { limits: [limitOf({ account_id: null }), limitOf({ account_id: null, used_pct: 50 })] }), "/limits/1"),
    fx("agent-root-missing", "root_id is required.", edit(base, { "agents.0.root_id": DELETE }), "/agents/0"),
    fx("agent-root-null", "root_id is never null.", edit(base, { "agents.0.root_id": null }), "/agents/0/root_id"),
    fx("agent-account-missing", "account_id is required (null when unknown).", edit(base, { "agents.0.account_id": DELETE }), "/agents/0"),
    fx("agent-session-missing", "session_id is required (null when unknown).", edit(base, { "agents.0.session_id": DELETE }), "/agents/0"),
    fx("agent-turn-missing", "turn_id is required (null when unknown).", edit(base, { "agents.0.turn_id": DELETE }), "/agents/0"),
    fx("agent-request-missing", "request_id is required (null when there is none).", edit(base, { "agents.0.request_id": DELETE }), "/agents/0"),
    fx("agent-session-raw-uuid", "session_id is a salted hash, never a raw id.", edit(base, { "agents.0.session_id": "6f1c0a2e-1b2c-4d3e-8f9a-0b1c2d3e4f5a" }), "/agents/0/session_id"),
    fx("request-on-working", "request_id is only set while waiting on the user.", edit(base, { "agents.0.request_id": REQ }), "/agents/0/request_id"),
    fx("tool-root-missing", "A connector names its data root.", edit(base, { "tools.0.root_id": DELETE }), "/tools/0"),
    fx("coverage-missing", "coverage is required.", edit(base, { "tools.0.coverage": DELETE }), "/tools/0"),
    fx("coverage-unknown", "coverage is verified, degraded or unsupported.", edit(base, { "tools.0.coverage": "partial" }), "/tools/0/coverage"),
    fx("verified-with-reason", "A verified connector has no reason.", edit(base, { "tools.0.coverage_reason": "other" }), "/tools/0/coverage_reason"),
    fx("degraded-without-reason", "A degraded connector says why.", edit(base, { "tools.0.coverage": "degraded" }), "/tools/0/coverage_reason"),
    fx("coverage-reason-unknown", "coverage_reason is a known code.", edit(base, { "tools.0.coverage": "degraded", "tools.0.coverage_reason": "flaky" }), "/tools/0/coverage_reason"),
    fx("limit-account-missing", "A limit names its account (null when unknown).", edit(base, { "limits.0.account_id": DELETE }), "/limits/0"),
    fx("limit-root-missing", "A limit names the root of its newest sample.", edit(base, { "limits.0.root_id": DELETE }), "/limits/0"),
    fx("too-many-tools", "At most 16 connectors.", edit(base, { tools: Array.from({ length: 17 }, (_, i) => toolStatus({ root_id: hid(`over-root-${i}`) })) }), "/tools"),
    fx("limit-provider-gemini", "Only claude and codex report limits in v0.1.", edit(base, { "limits.0.provider": "gemini" }), "/limits/0/provider"),
    fx("used-pct-over-100", "used_pct is at most 100.", edit(base, { "limits.0.used_pct": 101 }), "/limits/0/used_pct"),
    fx("used-pct-negative", "used_pct is at least 0.", edit(base, { "limits.0.used_pct": -1 }), "/limits/0/used_pct"),
    fx("limit-window-five-hour", "window is 5h or weekly.", edit(base, { "limits.0.window": "five_hour" }), "/limits/0/window"),
    fx("limit-missing-stale", "stale is required.", edit(base, { "limits.0.stale": DELETE }), "/limits/0"),
    fx("attention-zero-with-time", "oldest_since must be null when nobody is waiting.", edit(base, { attention: { needs_you: 0, oldest_since: T0 } }), "/attention"),
    fx("attention-one-without-time", "oldest_since must be set when someone is waiting.", edit(base, { attention: { needs_you: 1, oldest_since: null } }), "/attention"),
    fx("too-many-agents", "At most 64 agents.", edit(base, { agents: Array.from({ length: 65 }, (_, i) => agent({ id: hid(`over-${i}`), ordinal: i + 1, state: "idle" })) }), "/agents"),
    fx("confidence-unknown", "confidence is exact or inferred.", edit(base, { "agents.0.confidence": "certain" }), "/agents/0/confidence"),
  ];
}
