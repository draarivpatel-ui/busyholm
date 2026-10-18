// Demo scenarios for browser-only mode and screenshots (SPEC 3.8: Relay's four mock scenarios
// become demo scenarios), all in Snapshot v2 shape and marked demo: true. Synthetic only.

const ROOT_CLAUDE = "5c96dbc2661405adf9ab0e86e0eef50b";
const ROOT_CODEX = "5e1805de3c344b54fb9b24e1e1b20045";
const ROOT_OPENCODE = "7a1e0c0de0000000000000000000a0c1";
const ACCOUNT_A = "2f7339c66415277e5b58670b67b979a9";
const ACCOUNT_B = "9b2e11aa0f6c4d1e8a7b3c2d1e0f9a8b";

/** Fixed demo clock so screenshots are stable: 2026-10-12 15:40 UTC. */
export const DEMO_T = 1791826800000;
const MIN = 60000;
const HOUR = 3600000;

function id(n) {
  return "d" + n.toString(16).padStart(31, "0");
}

function agent(n, tool, host, ordinal, state, sinceMin, extra) {
  const root = tool === "codex" ? ROOT_CODEX : tool === "opencode" ? ROOT_OPENCODE : ROOT_CLAUDE;
  return Object.assign(
    {
      id: id(n),
      tool,
      host,
      ordinal,
      parent: null,
      root_id: root,
      account_id: tool === "codex" ? ACCOUNT_B : tool === "claude" ? ACCOUNT_A : null,
      session_id: null,
      turn_id: null,
      request_id: null,
      state,
      confidence: "exact",
      since: DEMO_T - sinceMin * MIN,
      started_at: DEMO_T - (sinceMin + 20) * MIN,
    },
    extra || {},
  );
}

const TOOLS_ALL_ON = [
  { tool: "claude", root_id: ROOT_CLAUDE, presence: "present", hooks: "installed", coverage: "verified", coverage_reason: null },
  { tool: "codex", root_id: ROOT_CODEX, presence: "present", hooks: "installed", coverage: "verified", coverage_reason: null },
];

const TOOLS_MIXED = [
  { tool: "claude", root_id: ROOT_CLAUDE, presence: "present", hooks: "installed", coverage: "verified", coverage_reason: null },
  { tool: "codex", root_id: ROOT_CODEX, presence: "present", hooks: "pending_review", coverage: "degraded", coverage_reason: "hooks_pending_review" },
  { tool: "opencode", root_id: ROOT_OPENCODE, presence: "present", hooks: "installed", coverage: "degraded", coverage_reason: "experimental_adapter" },
];

function limits(c5, cw, x5, xw) {
  const out = [];
  if (c5 != null) out.push({ provider: "claude", window: "5h", account_id: ACCOUNT_A, root_id: ROOT_CLAUDE, used_pct: c5, resets_at: DEMO_T + 2 * HOUR + 18 * MIN, observed_at: DEMO_T - MIN, stale: false });
  if (cw != null) out.push({ provider: "claude", window: "weekly", account_id: ACCOUNT_A, root_id: ROOT_CLAUDE, used_pct: cw, resets_at: DEMO_T + 52 * HOUR, observed_at: DEMO_T - MIN, stale: false });
  if (x5 != null) out.push({ provider: "codex", window: "5h", account_id: ACCOUNT_B, root_id: ROOT_CODEX, used_pct: x5, resets_at: DEMO_T + 3 * HOUR + 46 * MIN, observed_at: DEMO_T - 4 * MIN, stale: false });
  if (xw != null) out.push({ provider: "codex", window: "weekly", account_id: ACCOUNT_B, root_id: ROOT_CODEX, used_pct: xw, resets_at: DEMO_T + 31 * HOUR, observed_at: DEMO_T - 4 * MIN, stale: false });
  return out;
}

function snap(agents, tools, lims) {
  const waiting = agents.filter((a) => a.state === "needs_you");
  return {
    schema_version: 2,
    t: DEMO_T,
    demo: true,
    agents,
    tools,
    limits: lims,
    attention: {
      needs_you: waiting.length,
      oldest_since: waiting.length ? Math.min(...waiting.map((a) => a.since)) : null,
    },
  };
}

export const SCENARIOS = {
  // "A working afternoon": busy, nothing urgent.
  afternoon: snap(
    [
      agent(1, "claude", "cli", 1, "working", 18, { activity: "edit" }),
      agent(2, "codex", "cli", 1, "your_turn", 4),
      agent(3, "claude", "vscode", 2, "working", 7, { activity: "shell" }),
    ],
    TOOLS_ALL_ON,
    limits(46, 31, 22, 12),
  ),
  // "Needs attention": two agents wait for the user, one error, a limit near its end.
  attention: snap(
    [
      agent(1, "claude", "cli", 1, "needs_you", 2, { reason: "permission", request_id: "a0000000000000000000000000000001" }),
      agent(2, "codex", "cli", 1, "needs_you", 6, { reason: "question", request_id: "a0000000000000000000000000000002" }),
      agent(3, "claude", "vscode", 2, "error", 11),
      agent(4, "codex", "cli", 2, "working", 23, { activity: "read" }),
      agent(5, "claude", "cli", 3, "limited", 40, { limited_until: DEMO_T + 2 * HOUR + 18 * MIN }),
      agent(6, "opencode", "cli", 1, "idle", 55),
    ],
    TOOLS_MIXED,
    limits(83, 64, 58, 97),
  ),
  // "All quiet": tools connected, nobody running.
  quiet: snap([], TOOLS_ALL_ON, limits(12, 30, 5, 9)),
  // "No connections": nothing installed yet.
  none: snap(
    [],
    [
      { tool: "claude", root_id: ROOT_CLAUDE, presence: "present", hooks: "missing", coverage: "degraded", coverage_reason: "hooks_missing" },
      { tool: "codex", root_id: ROOT_CODEX, presence: "offline", hooks: "missing", coverage: "degraded", coverage_reason: "hooks_missing" },
    ],
    [],
  ),
  // Counts for the screenshot matrix.
  one: snap([agent(1, "claude", "cli", 1, "working", 12, { activity: "shell" })], TOOLS_ALL_ON, limits(46, 31, null, null)),
  three: snap(
    [
      agent(1, "claude", "cli", 1, "needs_you", 1, { reason: "permission", request_id: "a0000000000000000000000000000003" }),
      agent(2, "codex", "cli", 1, "working", 9, { activity: "edit" }),
      agent(3, "claude", "desktop", 2, "your_turn", 3),
    ],
    TOOLS_ALL_ON,
    limits(67, 88, 42, 96),
  ),
};
SCENARIOS.six = SCENARIOS.attention;

export const DEMO_SETTINGS = {
  schema_version: 1,
  strip: { enabled: true, display: { mode: "auto" }, height: 112, layer_mode: "on_top", hover_fade: true, show_over_fullscreen: false },
  sky: { mode: "usage_and_clock", hemisphere: "north" },
  sound: { bell: true, volume: 0.7, quiet_hours: null },
  notifications: { needs_you: true, renotify: true, long_turn: true, errors: true },
  ambient: { idle_minutes: null, shortcut: null },
  agents: { species: {} },
  privacy: { project_names: false, history_backfill: false },
  other: { launch_at_login: false, reduced_motion: "follow_os" },
  updates: { check: false },
};

export const DEMO_CONNECT_STATUS = {
  parts: [
    { part: "claude_hooks", connected: true, pending_review: false, available: true, path: "~/.claude/settings.json" },
    { part: "claude_statusline", connected: false, pending_review: false, available: true, path: "~/.claude/settings.json" },
    { part: "codex_hooks", connected: true, pending_review: true, available: true, path: "~/.codex/hooks.json" },
    { part: "opencode_plugin", connected: false, pending_review: false, available: false, path: "~/.config/opencode/plugins/busyholm.js" },
  ],
  any_connected: true,
  shim_available: true,
};

function dayKey(offsetDays) {
  const d = new Date(DEMO_T + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

function counts(turns, seconds) {
  return { turns, interrupted_turns: 0, sessions: Math.max(1, Math.round(turns / 6)), working_seconds: seconds, needs_you: Math.round(turns / 5), errors: 0, recovered: 0, limit_hits: 0, subagent_turns: 0 };
}

/** A few active days, so the popover's "today on the holm" has something to show. */
export const DEMO_WORLD_INPUTS = {
  seed: 20261012,
  ledger: {
    schema_version: 1,
    privacy: { containsText: false },
    seed: 20261012,
    founded_day: dayKey(-6),
    hooks_first_connected_day: dayKey(-6),
    days: {
      [dayKey(-6)]: { claude: counts(14, 5400) },
      [dayKey(-5)]: { claude: counts(22, 7200), codex: counts(9, 2400) },
      [dayKey(-3)]: { claude: counts(18, 6000) },
      [dayKey(-2)]: { codex: counts(16, 5200) },
      [dayKey(-1)]: { claude: counts(25, 8000), codex: counts(7, 1800) },
      [dayKey(0)]: { claude: counts(11, 3600), codex: counts(5, 1500) },
    },
    backfill: null,
  },
  choices: { schema_version: 1, privacy: { containsText: false }, log: [] },
};
