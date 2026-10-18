// Busyholm placeholder popover (WP-02): compact agent list, needs-you count, limits.
import * as bridge from "./bridge.js";
import { el, limitBar, limitsOf, needsYouCount, REASON_LABEL, sortedAgents, stateLabel, toolLabel } from "./shared.js";

const list = document.getElementById("agents");
const needEl = document.getElementById("need-count");
const limitsWrap = document.getElementById("limits-wrap");
const limitsEl = document.getElementById("limits");

let snapshot = null;

function render() {
  const agents = sortedAgents(snapshot);
  const need = needsYouCount(snapshot);
  needEl.textContent = need === 0 ? "No agents need you" : need === 1 ? "1 agent needs you" : need + " agents need you";
  needEl.classList.toggle("some", need > 0);

  list.replaceChildren();
  if (agents.length === 0) {
    const li = el("li", "empty", "No agents running.");
    list.append(li);
  }
  for (const a of agents) {
    const li = el("li");
    const row = el("div", "row");
    row.append(el("span", null, toolLabel(a.tool) + " #" + a.ordinal), el("span", "state " + a.state, stateLabel(a.state)));
    li.append(row);
    if (a.state === "needs_you" && a.reason) li.append(el("div", "reason", REASON_LABEL[a.reason] || a.reason));
    list.append(li);
  }

  const limits = limitsOf(snapshot);
  limitsEl.replaceChildren(...limits.map(limitBar));
  limitsWrap.hidden = limits.length === 0;
}

function applySnapshot(s) {
  if (!s || typeof s !== "object" || !Array.isArray(s.agents)) return;
  if (snapshot && typeof s.t === "number" && s.t < snapshot.t) return;
  snapshot = s;
  render();
}

bridge.onSnapshot(applySnapshot);
bridge.getSnapshot().then(applySnapshot);

document.getElementById("btn-details").addEventListener("click", () => bridge.open("details"));
document.getElementById("btn-settings").addEventListener("click", () => bridge.open("settings"));
document.getElementById("btn-ambient").addEventListener("click", () => bridge.open("ambient"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") bridge.close();
});

if (!bridge.hasCore()) document.getElementById("nocore").hidden = false;
render();
