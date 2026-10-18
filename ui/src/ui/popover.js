// Tray popover (WP-11): residents (needs-you first), usage per account, island progress,
// alert coverage per tool, quick actions. Opened by the tray icon; closes when it loses focus.

import * as core from "./core.js";
import * as M from "./model.js";
import { h, fill, applyAppearance } from "./dom.js";
import { icon } from "./icons.js";
import { makeClock, loadPortraits, hydratePortraits, agentRow, limitItem, coverageRow, computeProgress, holmBlock } from "./views.js";

const $ = (id) => document.getElementById(id);
const MAX_ROWS = 4;
const clock = makeClock();
const q = new URLSearchParams(location.search);
if (q.get("glass") === "1" || window.__BH_GLASS__ === true) document.documentElement.classList.add("glass");
if (q.get("wallpaper") === "1") document.documentElement.classList.add("wallpaper", "glass");

let snapshot = null;
let settings = core.boot().settings;
let worldInputs = core.boot().world_inputs || null;
let progress = undefined; // undefined: not computed yet; null: no ledger yet
let progressSeq = 0;

applyAppearance(settings, core.boot().os);

// Static button content
fill($("btn-settings"), icon("settings"));
fill($("btn-details"), icon("details"), h("span", { text: "Details" }));
fill($("btn-ambient"), icon("moon"), h("span", { text: "Ambient" }));


function render() {
  const now = clock.now();
  const agents = M.agentsOf(snapshot);
  const sum = M.summary(snapshot);
  $("demo-badge").hidden = !(snapshot && snapshot.demo);

  $("sum-count").textContent = String(sum.total);
  $("sum-text").textContent = sum.total === 1 ? "resident" : "residents";
  const att = $("attention");
  fill(att, sum.needsYou ? icon("flag") : null, h("span", { text: M.attentionText(sum.needsYou) }));
  att.dataset.none = String(sum.needsYou === 0);

  // Agents
  const list = $("agent-list");
  const sorted = M.sortAgents(agents);
  const counts = M.toolCounts(agents);
  const parts = [];
  if (sum.working) parts.push(sum.working + " working");
  if (sum.yourTurn) parts.push(sum.yourTurn + " your turn");
  if (sum.idle) parts.push(sum.idle + " idle");
  $("agents-aside").textContent = parts.join(", ");
  if (sorted.length === 0) fill(list, emptyState());
  else {
    // A glance surface: every agent that needs you, then up to four rows in all; the rest are
    // one click away in the details window.
    const cap = Math.max(MAX_ROWS, sorted.filter((a) => a.state === "needs_you").length);
    const shown = sorted.length > cap + 1 ? sorted.slice(0, cap) : sorted;
    const rows = shown.map((a) => agentRow(a, { settings, counts, now, helpers: M.helpersOf(agents, a.id).length }));
    const rest = sorted.length - shown.length;
    if (rest > 0) {
      rows.push(
        h(
          "li.more-row",
          null,
          h("button.more-btn", { type: "button", onclick: () => core.open("details") }, h("span", { text: rest + " more in Details" }), icon("chevron")),
        ),
      );
    }
    fill(list, rows);
  }
  hydratePortraits(list, 40);

  // Limits
  const items = M.limitItems(snapshot, now);
  $("limits-section").hidden = items.length === 0;
  fill($("limit-grid"), items.map(limitItem));

  // Island progress
  if (progress !== undefined) {
    fill($("holm"), holmBlock(progress));
    $("holm-aside").textContent = progress ? progress.tier : "";
  }
  $("holm-section").hidden = progress === undefined;

  // Coverage
  const cov = M.coverageItems(snapshot);
  $("cov-section").hidden = cov.length === 0;
  fill($("cov-list"), cov.map(coverageRow));
  $("cov-aside").textContent = cov.length ? M.coverageSummary(cov).text : "";

  // Quick actions
  const stripOn = !!(settings && settings.strip && settings.strip.enabled);
  const strip = $("btn-strip");
  strip.setAttribute("aria-pressed", String(stripOn));
  fill(strip, icon("strip"), h("span", { text: "Strip" }), h("span.toggle-state", { text: stripOn ? "On" : "Off", "aria-hidden": "true" }));
  document.documentElement.dataset.snapshotT = snapshot ? String(snapshot.t) : "";
  strip.disabled = !!(core.boot().strip && core.boot().strip.supported === false);
}

function emptyState() {
  const tools = snapshot && Array.isArray(snapshot.tools) ? snapshot.tools : [];
  const anyHooks = tools.some((t) => t.hooks === "installed" || t.hooks === "pending_review");
  if (!anyHooks) {
    return h(
      "li.empty",
      null,
      h("span.empty-art", { "aria-hidden": "true" }, icon("bell")),
      h(
        "div",
        null,
        h("strong", { text: "Alerts are not connected" }),
        h("span", { text: "Busyholm can show agents at work, but cannot ring the bell until hooks are connected." }),
        h("button.btn.primary", { type: "button", onclick: () => core.open("settings") }, icon("plug"), h("span", { text: "Connect hooks" })),
      ),
    );
  }
  return h(
    "li.empty",
    null,
    h("span.empty-art", { "aria-hidden": "true" }, icon("island")),
    h("div", null, h("strong", { text: "Quiet on the holm" }), h("span", { text: "No agent is running. Start Claude Code or Codex and a resident steps out." })),
  );
}

function applySnapshot(s) {
  if (!s || typeof s !== "object" || !Array.isArray(s.agents)) return;
  if (snapshot && typeof s.t === "number" && s.t < snapshot.t) return;
  snapshot = s;
  clock.update(s);
  render();
}

async function refreshProgress() {
  const seq = ++progressSeq;
  try {
    const p = await computeProgress(worldInputs, clock.now());
    if (seq !== progressSeq) return;
    progress = p;
  } catch (e) {
    console.warn("busyholm: island progress unavailable", e);
    progress = null;
  }
  render();
}

core.onSnapshot(applySnapshot);
core.onSettings((s) => {
  if (s && typeof s === "object") {
    settings = s;
    applyAppearance(settings, core.boot().os);
    render();
  }
});
core.onWorldInputs((w) => {
  worldInputs = w || null;
  refreshProgress();
});

$("btn-settings").addEventListener("click", () => core.open("settings"));
$("btn-details").addEventListener("click", () => core.open("details"));
$("btn-ambient").addEventListener("click", () => core.open("ambient"));
$("btn-strip").addEventListener("click", async () => {
  const next = JSON.parse(JSON.stringify(settings));
  next.strip.enabled = !next.strip.enabled;
  const r = await core.setSettings(next);
  if (r.ok) settings = r.settings;
  render();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") core.close();
});

// First paint from boot data, then the live snapshot; portraits and progress fill in after.
render();
core.getSnapshot().then(applySnapshot);
core.getSettings().then((s) => {
  if (s) {
    settings = s;
    applyAppearance(settings, core.boot().os);
    render();
  }
});
loadPortraits().then(() => hydratePortraits($("agent-list"), 40));
(async () => {
  if (!worldInputs) worldInputs = await core.getWorldInputs();
  refreshProgress();
})();

// Elapsed times tick while the popover is open.
setInterval(() => {
  if (document.visibilityState !== "hidden" && !(core.boot().test && core.boot().test.freeze)) render();
}, 30000);
window.__bhPopover = { render, get snapshot() { return snapshot; } };
