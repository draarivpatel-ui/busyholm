// Pure view-model for the popover, details window and settings (WP-11). No DOM here, so it is
// unit tested in Node. Every label a surface shows comes from this file.

export const TOOL_NAME = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  gemini: "Gemini CLI",
  cursor: "Cursor",
  aider: "Aider",
  other: "Agent",
};

/** SPEC 4.2 defaults; settings.agents.species overrides per tool. */
export const DEFAULT_SPECIES = {
  claude: "beaver",
  codex: "otter",
  opencode: "frog",
  antigravity: "hare",
  gemini: "hare",
  cursor: "mole",
  aider: "heron",
  other: "hedgehog",
};

export const SPECIES = ["beaver", "otter", "frog", "hare", "mole", "heron", "hedgehog"];

export const SPECIES_NAME = {
  beaver: "Beaver",
  otter: "Otter",
  frog: "Frog",
  hare: "Hare",
  mole: "Mole",
  heron: "Heron",
  hedgehog: "Hedgehog",
};

/** Scarf colour names, in SPEC 3.3 order (instance scarf = (ordinal - 1) mod 6, as in the strip). */
export const SCARF_NAME = ["coral", "blue", "sand", "sage", "rose", "plum"];

export const WORKSHOP_NAME = {
  claude: "Sawmill",
  codex: "Stone yard",
  opencode: "Print shop",
  antigravity: "Windmill",
  gemini: "Windmill",
  cursor: "Tunnel",
  aider: "Ferry",
  other: "Workshop",
};

const ACTIVITY_TEXT = {
  shell: "running commands",
  edit: "editing",
  read: "reading",
  web: "on the web",
  delegate: "with a helper",
  other: "",
};

/** Display order: whatever needs the user first (SPEC 3.8: needs-you first). */
const STATE_RANK = { needs_you: 0, error: 1, your_turn: 2, working: 3, starting: 4, limited: 5, idle: 6, unknown: 7 };

export function toolName(tool) {
  return TOOL_NAME[tool] || "Agent";
}

export function speciesFor(tool, settings) {
  const over = settings && settings.agents && settings.agents.species ? settings.agents.species[tool] : undefined;
  return SPECIES.includes(over) ? over : DEFAULT_SPECIES[tool] || "hedgehog";
}

export function scarfIndex(ordinal) {
  const n = Number.isInteger(ordinal) && ordinal > 0 ? ordinal : 1;
  return (n - 1) % 6;
}

/** True only when the user opted in to project names (SPEC 5.7 rule 5). */
export function projectNamesOn(settings) {
  return !!(settings && settings.privacy && settings.privacy.project_names === true);
}

export function agentsOf(snapshot) {
  return snapshot && Array.isArray(snapshot.agents) ? snapshot.agents : [];
}

/** Main agents (not subagent helpers), needs-you first, then the longest waiting. */
export function sortAgents(agents) {
  return agents
    .filter((a) => !a.parent)
    .slice()
    .sort((a, b) => {
      const r = (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9);
      if (r) return r;
      if (a.state === "needs_you" && a.since !== b.since) return a.since - b.since;
      if (a.tool !== b.tool) return a.tool < b.tool ? -1 : 1;
      return a.ordinal - b.ordinal;
    });
}

export function helpersOf(agents, parentId) {
  return agents.filter((a) => a.parent === parentId);
}

/** How many agents of each tool are present (used to decide whether an ordinal is worth showing). */
export function toolCounts(agents) {
  const m = {};
  for (const a of agents) if (!a.parent) m[a.tool] = (m[a.tool] || 0) + 1;
  return m;
}

/**
 * The name a row shows. Project names only with the opt-in; otherwise tool plus ordinal.
 * Returns { primary, secondary } where secondary names the resident.
 */
export function agentNames(agent, settings, counts) {
  const tool = toolName(agent.tool);
  const many = (counts && counts[agent.tool]) > 1 || agent.ordinal > 1;
  const toolLine = many ? tool + " " + agent.ordinal : tool;
  const species = SPECIES_NAME[speciesFor(agent.tool, settings)];
  const resident = species + ", " + SCARF_NAME[scarfIndex(agent.ordinal)] + " scarf";
  if (projectNamesOn(settings) && typeof agent.project_label === "string" && agent.project_label.length > 0) {
    return { primary: agent.project_label, secondary: toolLine, resident };
  }
  return { primary: toolLine, secondary: null, resident };
}

/** Short elapsed text: "now", "4m", "1h 12m", "3d". */
export function shortDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d";
}

/** Spoken elapsed text for screen readers: "4 minutes", "1 hour 12 minutes". */
export function longDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const m = Math.floor(ms / 60000);
  if (m < 1) return "less than a minute";
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  if (m < 60) return plural(m, "minute");
  const h = Math.floor(m / 60);
  if (h < 24) return plural(h, "hour") + (m % 60 ? " " + plural(m % 60, "minute") : "");
  return plural(Math.floor(h / 24), "day");
}

/** Countdown "2h 18m" / "3d 4h" / "5m". */
export function countdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const m = Math.ceil(ms / 60000);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h " + String(m % 60).padStart(2, "0") + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
}

/** Local clock time "14:20". */
export function clockTime(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

/**
 * What a row says about the state. tone drives colour (always paired with an icon and text,
 * never colour alone). icon names come from icons.js.
 */
export function stateInfo(agent, now) {
  const inferred = agent.confidence === "inferred";
  switch (agent.state) {
    case "needs_you": {
      const q = agent.reason === "question";
      let label = q ? "Asked you a question" : "Needs your permission";
      if (inferred) label = q ? "May still have a question" : "May still need permission";
      return { label, short: q ? "Question" : "Permission", tone: "alert", icon: q ? "question" : "key" };
    }
    case "your_turn":
      return { label: "Your turn", short: "Your turn", tone: "turn", icon: "lantern" };
    case "working": {
      const act = ACTIVITY_TEXT[agent.activity] || "";
      return { label: act ? "Working, " + act : "Working", short: "Working", tone: "work", icon: "work" };
    }
    case "starting":
      return { label: "Starting up", short: "Starting", tone: "work", icon: "door" };
    case "error":
      return { label: "Stopped with an error", short: "Error", tone: "error", icon: "cloud" };
    case "limited": {
      const until = agent.limited_until;
      const label = Number.isFinite(until) ? "Usage limit, back at " + clockTime(until) : "Usage limit reached";
      return { label, short: "Limited", tone: "rest", icon: "cup" };
    }
    case "idle":
      return { label: "Idle", short: "Idle", tone: "idle", icon: "idle" };
    default:
      return { label: "Not sure what it is doing", short: "Unknown", tone: "idle", icon: "unknown" };
  }
}

/** Static resident pose for a state (names from world/art/src/residents.ts posesFor). */
export function poseFor(agent) {
  switch (agent.state) {
    case "needs_you":
      return "ring-0";
    case "your_turn":
      return "sit-lantern-0";
    case "working":
      return agent.activity === "read" ? "read-0" : agent.activity === "web" ? "spyglass-0" : agent.activity === "delegate" ? "whistle-0" : "work-0";
    case "starting":
      return "stretch-0";
    case "error":
      return "worried-0";
    case "limited":
      return "tea-0";
    case "idle":
      return "sweep-0";
    default:
      return "stand-0";
  }
}

export function needsYouCount(snapshot) {
  return agentsOf(snapshot).filter((a) => a.state === "needs_you").length;
}

/** Header summary: "3 residents at work" style counts. */
export function summary(snapshot) {
  const main = agentsOf(snapshot).filter((a) => !a.parent);
  const by = (s) => main.filter((a) => a.state === s).length;
  return {
    total: main.length,
    needsYou: by("needs_you"),
    working: by("working") + by("starting"),
    yourTurn: by("your_turn"),
    errors: by("error"),
    limited: by("limited"),
    idle: by("idle") + by("unknown"),
  };
}

export function attentionText(n) {
  if (n === 0) return "Nobody needs you";
  return n === 1 ? "1 needs you" : n + " need you";
}

export function residentsText(n) {
  if (n === 0) return "No residents out";
  return n === 1 ? "1 resident" : n + " residents";
}

// ---------------------------------------------------------------------------------------------
// Usage limits
// ---------------------------------------------------------------------------------------------

export const PROVIDER_NAME = { claude: "Claude", codex: "Codex" };
export const WINDOW_NAME = { "5h": "5-hour", weekly: "Weekly" };

export function severity(pct) {
  if (!Number.isFinite(pct)) return "normal";
  if (pct >= 95) return "critical";
  if (pct >= 80) return "warning";
  return "normal";
}

/**
 * Limits as display items, provider then window, one per account (never merged, SPEC Rev 1
 * item 3). When a provider has more than one account they are told apart as "account 1, 2".
 */
export function limitItems(snapshot, now) {
  const list = snapshot && Array.isArray(snapshot.limits) ? snapshot.limits.slice() : [];
  const accounts = {};
  for (const l of list) {
    const key = l.account_id || "root:" + l.root_id;
    accounts[l.provider] = accounts[l.provider] || [];
    if (!accounts[l.provider].includes(key)) accounts[l.provider].push(key);
  }
  const order = { claude: 0, codex: 1 };
  const worder = { "5h": 0, weekly: 1 };
  list.sort((a, b) => (order[a.provider] ?? 9) - (order[b.provider] ?? 9) || (a.account_id || "").localeCompare(b.account_id || "") || (worder[a.window] ?? 9) - (worder[b.window] ?? 9));
  return list.map((l) => {
    const key = l.account_id || "root:" + l.root_id;
    const many = accounts[l.provider].length > 1;
    const provider = (PROVIDER_NAME[l.provider] || l.provider) + (many ? " " + (accounts[l.provider].indexOf(key) + 1) : "");
    const pct = Math.max(0, Math.min(100, Number(l.used_pct) || 0));
    const shown = Math.round(pct);
    return {
      provider,
      window: WINDOW_NAME[l.window] || l.window,
      label: provider + " · " + (WINDOW_NAME[l.window] || l.window),
      pct,
      pctText: shown + "%",
      severity: severity(pct),
      resetsIn: countdown(l.resets_at - now),
      resetsAt: l.resets_at,
      stale: !!l.stale,
      staleText: l.stale ? "Last seen " + shortDuration(now - l.observed_at) + " ago" : null,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Coverage (SPEC Revision 1 item 2): what the tray says about each connector
// ---------------------------------------------------------------------------------------------

export const COVERAGE_NAME = { verified: "Alerts on", degraded: "Activity only", unsupported: "Not supported here" };

const REASON_TEXT = {
  hooks_missing: "Hooks are not connected",
  hooks_pending_review: "Approve the Busyholm hooks with /hooks in Codex",
  round_trip_pending: "Connected; waiting for the first hook event",
  round_trip_failed: "The hook test did not reach Busyholm",
  receiver_unreachable: "Busyholm could not listen for hook events",
  bare_session: "Started with --bare, which skips hooks",
  no_permission_event: "This tool does not report permission requests",
  experimental_adapter: "Experimental: alerts not verified",
  remote_session: "Remote sessions are not covered",
  os_unsupported: "Not supported on this system",
  other: "Alerts are not available",
};

export function coverageItems(snapshot) {
  const tools = snapshot && Array.isArray(snapshot.tools) ? snapshot.tools : [];
  const count = {};
  for (const t of tools) count[t.tool] = (count[t.tool] || 0) + 1;
  const seen = {};
  return tools.map((t) => {
    seen[t.tool] = (seen[t.tool] || 0) + 1;
    const name = toolName(t.tool) + (count[t.tool] > 1 ? " (folder " + seen[t.tool] + ")" : "");
    const offline = t.presence === "offline";
    const state = t.coverage;
    let detail = state === "verified" ? "Rings the bell and raises a flag when your agent needs you" : REASON_TEXT[t.coverage_reason] || REASON_TEXT.other;
    if (offline) detail = "Not running. " + detail;
    return { tool: t.tool, name, state, stateName: COVERAGE_NAME[state] || "Unknown", detail, offline, reason: t.coverage_reason };
  });
}

/** One-line coverage summary for the popover header. */
export function coverageSummary(items) {
  if (items.length === 0) return { state: "unsupported", text: "No agents found" };
  const v = items.filter((i) => i.state === "verified").length;
  if (v === items.length) return { state: "verified", text: "Alerts on" };
  if (v > 0) return { state: "degraded", text: "Alerts on for " + v + " of " + items.length };
  return { state: "degraded", text: "Alerts not on yet" };
}

// ---------------------------------------------------------------------------------------------
// Island progress, from a World computed by grow() (world/grow)
// ---------------------------------------------------------------------------------------------

const STRUCTURE_NAME = {
  campfire: "Campfire",
  tent: "Tent",
  bell_post: "Bell post",
  noticeboard: "Noticeboard",
  well: "Well",
  cottage_1: "Cottage",
  garden_plots: "Garden plots",
  watermill: "Watermill",
  cottage_2: "Second cottage",
  bell_tower: "Bell tower",
  bakery: "Bakery",
  market_hall: "Market hall",
  founders_stone: "Founders' stone",
};

export function structureName(s) {
  if (s.id === "workshop_1" || s.id === "workshop_2") {
    if (s.variant === "guest_house") return "Guest house";
    return s.variant ? WORKSHOP_NAME[s.variant] || "Workshop" : "Workshop";
  }
  if (s.id === "crossing") return s.variant === "jetty" ? "Jetty" : s.variant === "footbridge" ? "Footbridge" : "Crossing";
  return STRUCTURE_NAME[s.id] || "Building";
}

export const TIER_NAME = { camp: "Camp", hamlet: "Hamlet", village: "Village" };

/**
 * Progress summary: the structure being built now, tier, and what today earned.
 * `today` is the World grown without today's ledger day (or null).
 */
export function progressInfo(world, before) {
  if (!world) return null;
  const structs = Array.isArray(world.structures) ? world.structures : [];
  const current = structs.find((s) => s.status === "building") || structs.find((s) => s.status === "waiting") || structs.find((s) => s.status === "planned") || null;
  const done = structs.filter((s) => s.status === "complete").length;
  let building = null;
  if (current) {
    const name = structureName(current);
    let detail;
    if (current.status === "waiting" && current.waiting_for) {
      const d = current.waiting_for.active_days;
      detail = "Waits for " + d + " more active day" + (d === 1 ? "" : "s");
    } else if (current.status === "planned") {
      detail = "Next to build";
    } else {
      detail = "Stage " + Math.min(3, current.stage + 1) + " of 3";
    }
    building = { name, detail, progress: Math.max(0, Math.min(1, Number(current.progress) || 0)), status: current.status };
  }
  let today = null;
  if (before && world.earned && before.earned) {
    // Amounts can be fractional inside grow(); show whole units gathered today.
    const d = (k) => Math.max(0, Math.floor(world.earned[k] || 0) - Math.floor(before.earned[k] || 0));
    today = { planks: d("planks"), stone: d("stone"), seeds: d("seeds") };
  }
  return { tier: TIER_NAME[world.tier] || "Camp", done, total: structs.length, building, today, demoCapped: !!world.demo_capped };
}

export function todayText(today) {
  if (!today) return null;
  const parts = [];
  if (today.planks) parts.push("+" + today.planks + " plank" + (today.planks === 1 ? "" : "s"));
  if (today.stone) parts.push("+" + today.stone + " stone");
  if (today.seeds) parts.push("+" + today.seeds + " seed" + (today.seeds === 1 ? "" : "s"));
  return parts.length ? "Today " + parts.join(", ") : "Nothing gathered yet today";
}

/** Local day key "YYYY-MM-DD" (ledger days are local days). */
export function localDay(ms) {
  const d = new Date(ms);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/** The ledger without one day (to measure what that day earned). */
export function ledgerWithout(ledger, day) {
  if (!ledger || !ledger.days || !(day in ledger.days)) return ledger;
  const days = {};
  for (const k of Object.keys(ledger.days)) if (k !== day) days[k] = ledger.days[k];
  return Object.assign({}, ledger, { days });
}
