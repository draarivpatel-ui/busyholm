// Details window (WP-11; SPEC Revision 1 item 8): an ordinary focusable window that shows
// everything the strip shows, fully keyboard operable. Also the fallback surface where the strip
// is not supported. Agents use a roving focus: one tab stop, arrow keys move between rows.

import * as core from "./core.js";
import * as M from "./model.js";
import { h, fill, applyAppearance } from "./dom.js";
import { icon } from "./icons.js";
import { makeClock, loadPortraits, hydratePortraits, agentRow, limitItem, coverageRow, computeProgress, holmBlock } from "./views.js";

const $ = (id) => document.getElementById(id);
const clock = makeClock();
const HOST = { cli: "in a terminal", desktop: "in the desktop app", vscode: "in VS Code", sdk: "through the SDK", ide: "in an editor", other: "" };
const MAX_LOG = 30;

let snapshot = null;
let settings = core.boot().settings;
let worldInputs = core.boot().world_inputs || null;
let progress = undefined;
let progressSeq = 0;
let focusedAgent = null;
const log = [];

applyAppearance(settings, core.boot().os);
fill($("btn-settings"), icon("settings"), h("span", { text: "Settings" }));
fill($("btn-ambient"), icon("moon"), h("span", { text: "Ambient scene" }));

const strip = core.boot().strip;
if (strip && strip.supported === false) {
  $("strip-note").hidden = false;
  $("strip-note").textContent = "The island strip is not available on this system. This window shows everything it would.";
}

function nameOf(agentId, tool) {
  const a = M.agentsOf(snapshot).find((x) => x.id === agentId);
  if (!a) return M.toolName(tool);
  return M.agentNames(a, { privacy: { project_names: false } }, M.toolCounts(M.agentsOf(snapshot))).primary;
}

function render() {
  const now = clock.now();
  const agents = M.agentsOf(snapshot);
  const sum = M.summary(snapshot);
  const counts = M.toolCounts(agents);
  $("demo-badge").hidden = !(snapshot && snapshot.demo);

  const att = $("attention");
  const attText = sum.needsYou === 0 ? "Nobody needs you right now." : sum.needsYou === 1 ? "1 agent needs you." : sum.needsYou + " agents need you.";
  if (att.dataset.text !== attText) {
    fill(att, icon(sum.needsYou ? "flag" : "check"), h("span", { text: attText }));
    att.dataset.text = attText;
  }
  att.dataset.none = String(sum.needsYou === 0);

  const parts = [];
  if (sum.total) parts.push(M.residentsText(sum.total));
  if (sum.working) parts.push(sum.working + " working");
  if (sum.yourTurn) parts.push(sum.yourTurn + " your turn");
  $("agents-aside").textContent = parts.join(", ");

  const list = $("agent-list");
  const hadFocus = list.contains(document.activeElement);
  const sorted = M.sortAgents(agents);
  if (sorted.length === 0) {
    fill(list, h("li.empty", null, h("span.empty-art", { "aria-hidden": "true" }, icon("island")), h("div", null, h("strong", { text: "No agents running" }), h("span", { text: "Start Claude Code or Codex and a resident steps out." }))));
    $("agents-hint").hidden = true;
  } else {
    $("agents-hint").hidden = sorted.length < 2;
    const rows = sorted.map((a) => {
      const helpers = M.helpersOf(agents, a.id);
      const row = agentRow(a, { settings, counts, now, helpers: helpers.length });
      row.classList.add("d-row");
      row.tabIndex = -1;
      const host = HOST[a.host] || "";
      const extra = [host ? "Running " + host : null, "started " + M.clockTime(a.started_at), a.confidence === "inferred" ? "not confirmed since a restart" : null].filter(Boolean).join(", ");
      row.querySelector(".agent-copy").append(h("span.agent-extra", { text: extra.charAt(0).toUpperCase() + extra.slice(1), "aria-hidden": "true" }));
      const sr = row.querySelector(".sr-only");
      sr.textContent = sr.textContent.replace(/\.$/, "") + ". " + extra.charAt(0).toUpperCase() + extra.slice(1) + ".";
      if (helpers.length) {
        row.append(
          h(
            "ul.helper-list",
            { "aria-label": "Helpers" },
            helpers.map((x) => {
              const info = M.stateInfo(x, now);
              return h("li.helper-row", { dataset: { agent: x.id, state: x.state } }, icon(info.icon), h("span", { text: "Helper: " + info.label.toLowerCase() + ", " + M.longDuration(now - x.since) }));
            }),
          ),
        );
      }
      return row;
    });
    fill(list, rows);
    // Roving focus: keep the focused agent (or the first row) as the single tab stop.
    let current = rows.find((r) => r.dataset.agent === focusedAgent) || rows[0];
    current.tabIndex = 0;
    if (hadFocus) current.focus();
    hydratePortraits(list, 44);
  }

  const items = M.limitItems(snapshot, now);
  $("limits-section").hidden = items.length === 0;
  fill(
    $("limit-grid"),
    items.map((it) => {
      const el = limitItem(it);
      if (!it.stale) el.querySelector(".limit-reset span").textContent = "Resets " + M.clockTime(it.resetsAt) + " (in " + it.resetsIn + ")";
      return el;
    }),
  );

  if (progress !== undefined) {
    fill($("holm"), holmBlock(progress));
    $("holm-aside").textContent = progress ? progress.tier + (progress.total ? ", " + progress.done + " of " + progress.total + " built" : "") : "";
  }
  $("holm-section").hidden = progress === undefined;

  const cov = M.coverageItems(snapshot);
  $("cov-section").hidden = cov.length === 0;
  fill($("cov-list"), cov.map((it) => {
    const li = coverageRow(it);
    if (it.state === "verified" && !li.querySelector(".cov-detail")) li.append(h("span.cov-detail", { text: it.detail }));
    return li;
  }));
  $("cov-aside").textContent = cov.length ? M.coverageSummary(cov).text : "";

  renderLog();

  const on = !!(settings && settings.strip && settings.strip.enabled);
  const sb = $("btn-strip");
  sb.setAttribute("aria-pressed", String(on));
  fill(sb, icon("strip"), h("span", { text: on ? "Strip on" : "Strip off" }));
  sb.disabled = !!(strip && strip.supported === false);
  document.documentElement.dataset.snapshotT = snapshot ? String(snapshot.t) : "";
}

function momentText(m) {
  const who = m.agent ? nameOf(m.agent, m.tool) : "";
  const prov = M.PROVIDER_NAME[m.provider] || "";
  switch (m.kind) {
    case "needs_you":
      return who + (m.reason === "question" ? " asked you a question" : " needs your permission");
    case "answered":
      return who + " got its answer";
    case "turn_end":
      return who + " finished a turn" + (Number.isFinite(m.turn_ms) && m.turn_ms >= 60000 ? " after " + M.longDuration(m.turn_ms) : "");
    case "error":
      return who + " stopped with an error";
    case "recovered":
      return who + " is working again";
    case "limit_hit":
      return prov + " usage limit reached";
    case "limit_reset":
      return prov + " 5-hour window reset";
    case "weekly_reset":
      return prov + " weekly window reset";
    case "build_complete":
      return M.structureName({ id: m.structure }) + (m.stage === 3 ? " finished" : ", stage " + m.stage + " of 3 done");
    case "milestone":
      return "Milestone reached";
    default:
      return null;
  }
}

function renderLog() {
  const el = $("log");
  if (log.length === 0) {
    fill(el, h("li.log-empty", { text: "Nothing yet. Bells, finished turns and new buildings show up here." }));
    return;
  }
  fill(
    el,
    log.map((e) => h("li.log-item", { dataset: { kind: e.kind } }, h("time.tabular", { text: M.clockTime(e.t), datetime: new Date(e.t).toISOString() }), h("span", { text: e.text }))),
  );
}

function onMoment(m) {
  if (!m || typeof m !== "object") return;
  const text = momentText(m);
  if (!text) return;
  log.unshift({ t: Number.isFinite(m.t) ? m.t : clock.now(), kind: m.kind, text });
  log.length = Math.min(log.length, MAX_LOG);
  renderLog();
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

// Roving focus in the agent list
$("agent-list").addEventListener("keydown", (e) => {
  const rows = [...$("agent-list").querySelectorAll(".d-row")];
  const i = rows.indexOf(document.activeElement);
  if (i < 0 || rows.length === 0) return;
  let j = i;
  if (e.key === "ArrowDown") j = Math.min(rows.length - 1, i + 1);
  else if (e.key === "ArrowUp") j = Math.max(0, i - 1);
  else if (e.key === "Home") j = 0;
  else if (e.key === "End") j = rows.length - 1;
  else return;
  e.preventDefault();
  rows[i].tabIndex = -1;
  rows[j].tabIndex = 0;
  rows[j].focus();
  focusedAgent = rows[j].dataset.agent;
});
$("agent-list").addEventListener("focusin", (e) => {
  const r = e.target.closest(".d-row");
  if (r) focusedAgent = r.dataset.agent;
});

$("btn-settings").addEventListener("click", () => core.open("settings"));
$("btn-ambient").addEventListener("click", () => core.open("ambient"));
$("btn-strip").addEventListener("click", async () => {
  const next = JSON.parse(JSON.stringify(settings));
  next.strip.enabled = !next.strip.enabled;
  const r = await core.setSettings(next);
  if (r.ok) settings = r.settings;
  render();
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ",") {
    e.preventDefault();
    core.open("settings");
  }
});

core.onSnapshot(applySnapshot);
core.onMoment(onMoment);
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

render();
core.getSnapshot().then(applySnapshot);
core.getSettings().then((s) => {
  if (s) {
    settings = s;
    applyAppearance(settings, core.boot().os);
    render();
  }
});
loadPortraits().then(() => hydratePortraits($("agent-list"), 44));
(async () => {
  if (!worldInputs) worldInputs = await core.getWorldInputs();
  refreshProgress();
})();
setInterval(() => {
  if (document.visibilityState !== "hidden" && !(core.boot().test && core.boot().test.freeze)) render();
}, 30000);
