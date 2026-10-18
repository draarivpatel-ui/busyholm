// Busyholm placeholder details window (WP-02, SPEC Revision 1 item 8): an ordinary,
// keyboard-operable window with a live region announcing needs-you changes.
import * as bridge from "./bridge.js";
import { el, limitBar, limitsOf, needsYouCount, REASON_LABEL, sortedAgents, stateLabel, toolLabel } from "./shared.js";

const summary = document.getElementById("summary");
const live = document.getElementById("live");
const table = document.getElementById("agents-table");
const body = document.getElementById("agents-body");
const emptyAgents = document.getElementById("agents-empty");
const limitsEl = document.getElementById("limits");
const emptyLimits = document.getElementById("limits-empty");

let snapshot = null;
let prevNeeding = null; // Map id -> label, null before the first snapshot

function agentName(a) {
  return toolLabel(a.tool) + " number " + a.ordinal;
}

function announce(text) {
  // Clear first so a repeated message is announced again.
  live.textContent = "";
  setTimeout(() => {
    live.textContent = text;
  }, 50);
}

function render() {
  const agents = sortedAgents(snapshot);
  const need = needsYouCount(snapshot);
  summary.textContent =
    agents.length === 0
      ? "No agents running."
      : agents.length + (agents.length === 1 ? " agent" : " agents") + ", " + need + (need === 1 ? " needs you." : " need you.");

  body.replaceChildren();
  table.hidden = agents.length === 0;
  emptyAgents.hidden = agents.length !== 0;
  for (const a of agents) {
    const tr = el("tr");
    const th = el("th", null, toolLabel(a.tool));
    th.scope = "row";
    tr.append(th, el("td", null, String(a.ordinal)), el("td", "state " + a.state, stateLabel(a.state)));
    tr.append(el("td", null, a.state === "needs_you" && a.reason ? REASON_LABEL[a.reason] || a.reason : ""));
    body.append(tr);
  }

  const limits = limitsOf(snapshot);
  limitsEl.replaceChildren(...limits.map(limitBar));
  emptyLimits.hidden = limits.length !== 0;
}

function trackAttention() {
  const now = new Map();
  for (const a of sortedAgents(snapshot)) if (a.state === "needs_you") now.set(a.id, agentName(a));
  if (prevNeeding !== null) {
    const added = [...now].filter(([id]) => !prevNeeding.has(id)).map(([, name]) => name);
    const removed = [...prevNeeding].filter(([id]) => !now.has(id));
    if (added.length > 0) {
      announce(added.join(", ") + (added.length === 1 ? " needs you." : " need you.") + " " + now.size + " waiting in total.");
    } else if (removed.length > 0) {
      announce(now.size === 0 ? "No agents need you now." : now.size + (now.size === 1 ? " agent needs you." : " agents need you."));
    }
  }
  prevNeeding = now;
}

function applySnapshot(s) {
  if (!s || typeof s !== "object" || !Array.isArray(s.agents)) return;
  if (snapshot && typeof s.t === "number" && s.t < snapshot.t) return;
  snapshot = s;
  render();
  trackAttention();
}

bridge.onSnapshot(applySnapshot);
bridge.getSnapshot().then(applySnapshot);

document.getElementById("btn-settings").addEventListener("click", () => bridge.open("settings"));
document.getElementById("btn-ambient").addEventListener("click", () => bridge.open("ambient"));
if (!bridge.hasCore()) document.getElementById("nocore").hidden = false;
