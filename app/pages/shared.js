// Small helpers shared by the placeholder popover and details pages.

export const STATE_LABEL = {
  starting: "Starting",
  working: "Working",
  needs_you: "Needs you",
  your_turn: "Your turn",
  error: "Error",
  limited: "Limited",
  idle: "Idle",
  unknown: "Unknown",
};

export const REASON_LABEL = {
  permission: "Waiting for permission",
  question: "Has a question",
};

export const TOOL_LABEL = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  gemini: "Gemini",
  cursor: "Cursor",
  aider: "Aider",
  other: "Other",
};

export const WINDOW_LABEL = { "5h": "5 hours", weekly: "Weekly" };

export function stateLabel(state) {
  return STATE_LABEL[state] || "Unknown";
}

export function toolLabel(tool) {
  return TOOL_LABEL[tool] || String(tool || "Other");
}

/** Agents sorted by tool name then ordinal (stable order for every surface). */
export function sortedAgents(snapshot) {
  const agents = snapshot && Array.isArray(snapshot.agents) ? snapshot.agents.slice() : [];
  agents.sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : a.ordinal - b.ordinal));
  return agents;
}

export function needsYouCount(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.agents)) return 0;
  return snapshot.agents.filter((a) => a.state === "needs_you").length;
}

export function limitsOf(snapshot) {
  return snapshot && Array.isArray(snapshot.limits) ? snapshot.limits : [];
}

export function pctText(p) {
  if (typeof p !== "number" || !Number.isFinite(p)) return "?";
  return (Math.round(p * 10) / 10).toString() + "%";
}

/** Create an element with text content (never innerHTML, so snapshot text cannot inject markup). */
export function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

/** A small usage bar element for a limit entry. */
export function limitBar(limit) {
  const wrap = el("div", "limit");
  const name = toolLabel(limit.provider) + " " + (WINDOW_LABEL[limit.window] || limit.window);
  const head = el("div", "limit-head");
  head.append(el("span", "limit-name", name), el("span", "limit-pct", pctText(limit.used_pct) + (limit.stale ? " (stale)" : "")));
  const bar = el("div", "bar");
  bar.setAttribute("role", "meter");
  bar.setAttribute("aria-label", name + " used");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(Math.round(limit.used_pct)));
  const fill = el("div", "bar-fill" + (limit.used_pct >= 90 ? " hot" : "") + (limit.stale ? " stale" : ""));
  fill.style.width = Math.max(0, Math.min(100, limit.used_pct)) + "%";
  bar.append(fill);
  wrap.append(head, bar);
  return wrap;
}
