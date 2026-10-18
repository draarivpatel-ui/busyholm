// Shared view pieces for the popover and the details window: agent rows, limits, coverage and
// island progress. Text comes from model.js; elements from dom.js. Data is set as text only.

import { h, fill } from "./dom.js";
import { icon, iconFor } from "./icons.js";
import * as M from "./model.js";
import { boot, hasCore } from "./core.js";

// ---------------------------------------------------------------------------------------------
// Clock: fixtures and demo snapshots carry their own time; live snapshots use the wall clock.
// ---------------------------------------------------------------------------------------------

export function makeClock() {
  let anchorT = null;
  let anchorPerf = 0;
  return {
    update(snapshot) {
      const fixed = !hasCore() || (snapshot && snapshot.demo) || (boot().test && boot().test.freeze);
      if (fixed && snapshot && Number.isFinite(snapshot.t)) {
        anchorT = snapshot.t;
        anchorPerf = performance.now();
      } else anchorT = null;
    },
    now() {
      if (anchorT === null) return Date.now();
      const frozen = boot().test && boot().test.freeze;
      return anchorT + (frozen ? 0 : performance.now() - anchorPerf);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Portraits (art.js is loaded lazily so the first paint never waits for it)
// ---------------------------------------------------------------------------------------------

let portraitFn = null;
let portraitLoad = null;

export function loadPortraits() {
  if (!portraitLoad) {
    portraitLoad = import("./art.js").then(
      (m) => (portraitFn = m.portrait),
      (e) => console.warn("busyholm: portraits unavailable", e),
    );
  }
  return portraitLoad;
}

/** Draw every pending .token in `root` (call after a render and after art.js loads). */
export function hydratePortraits(root, size) {
  if (!portraitFn) return;
  for (const t of root.querySelectorAll(".token[data-species]:not([data-drawn])")) {
    try {
      const c = portraitFn(t.dataset.species, Number(t.dataset.scarf) || 0, t.dataset.pose || "stand-0", size || 40);
      t.prepend(c);
      t.dataset.drawn = "1";
    } catch (e) {
      console.warn("busyholm: portrait failed", e);
      t.dataset.drawn = "0";
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------------------------

export function token(agent, settings, info) {
  const t = h("span.token", {
    "aria-hidden": "true",
    dataset: { species: M.speciesFor(agent.tool, settings), scarf: String(M.scarfIndex(agent.ordinal)), pose: M.poseFor(agent) },
  });
  if (agent.state === "unknown" || agent.confidence === "inferred") t.dataset.dim = "true";
  if (info.tone === "alert") t.append(h("span.badge", null, icon(agent.reason === "question" ? "question" : "flag")));
  return t;
}

/**
 * One agent row. ctx: { settings, counts, now, helpers }. The accessible name reads as one
 * sentence: "Claude Code 2, beaver with a blue scarf: needs your permission, for 4 minutes".
 */
export function agentRow(agent, ctx) {
  const info = M.stateInfo(agent, ctx.now);
  const names = M.agentNames(agent, ctx.settings, ctx.counts);
  const waited = ctx.now - agent.since;
  const helpers = ctx.helpers || 0;
  const row = h(
    "li.agent-row",
    { dataset: { tone: info.tone, state: agent.state, agent: agent.id } },
    token(agent, ctx.settings, info),
    h(
      "div.agent-copy",
      null,
      h("span.agent-name", null, h("span.primary", { text: names.primary }), names.secondary ? h("span.secondary", { text: names.secondary }) : null),
      h("span.agent-state", null, icon(info.icon), h("span", { text: info.label })),
    ),
    h(
      "div.agent-meta",
      null,
      h("span.elapsed", { text: M.shortDuration(waited), "aria-hidden": "true" }),
      helpers ? h("span.helpers", { text: "+" + helpers + (helpers === 1 ? " helper" : " helpers"), "aria-hidden": "true" }) : null,
    ),
    h("span.sr-only", {
      text:
        names.primary +
        (names.secondary ? " (" + names.secondary + ")" : "") +
        ", " +
        names.resident.toLowerCase() +
        ": " +
        info.label.toLowerCase() +
        ", for " +
        M.longDuration(waited) +
        (helpers ? ", with " + helpers + (helpers === 1 ? " helper" : " helpers") : "") +
        ".",
    }),
  );
  // The visible parts are summarised by the sr-only sentence; hide them from assistive tech.
  for (const c of row.children) if (!c.classList.contains("sr-only")) c.setAttribute("aria-hidden", "true");
  return row;
}

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

export function limitItem(it) {
  return h(
    "div.limit-item",
    { dataset: { severity: it.severity, stale: String(it.stale) }, role: "group", "aria-label": it.label },
    h(
      "div.limit-top",
      null,
      h("span.limit-label", { text: it.label, "aria-hidden": "true" }),
      h("span.limit-pct", null, it.severity !== "normal" ? icon("warning") : null, h("span", { text: it.pctText })),
    ),
    h(
      "div.bar.ticks",
      { role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(it.pct)), "aria-label": it.label + " used" },
      h("span.bar-fill", { style: { "--used": it.pct + "%" } }),
    ),
    h("div.limit-reset", null, icon(it.stale ? "history" : "clock"), h("span", { text: it.stale ? it.staleText : "Resets in " + it.resetsIn })),
  );
}

// ---------------------------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------------------------

export function coverageRow(it) {
  return h(
    "li.cov-item",
    { dataset: { state: it.state, tool: it.tool } },
    h("span.cov-mark", { dataset: { state: it.state }, "aria-hidden": "true" }),
    h("span.cov-name", { text: it.name }),
    h("span.cov-state", { text: it.stateName }),
    it.state !== "verified" || it.offline ? h("span.cov-detail", { text: it.detail }) : null,
  );
}

// ---------------------------------------------------------------------------------------------
// Island progress (grow.js loaded lazily)
// ---------------------------------------------------------------------------------------------

let growLoad = null;

export async function computeProgress(inputs, nowMs) {
  if (!inputs || !inputs.ledger || !inputs.choices || typeof inputs.seed !== "number") return null;
  if (!growLoad) growLoad = import("./grow.js");
  const { grow } = await growLoad;
  const day = M.localDay(nowMs);
  const world = grow(inputs.seed, inputs.ledger, inputs.choices);
  let before = null;
  if (inputs.ledger.days && day in inputs.ledger.days) before = grow(inputs.seed, M.ledgerWithout(inputs.ledger, day), inputs.choices);
  else before = world;
  return M.progressInfo(world, before);
}

export function holmBlock(info) {
  if (!info) {
    return [
      h("span.holm-mark", { "aria-hidden": "true" }, icon("island")),
      h("div.holm-copy", null, h("div.holm-line", null, h("strong", { text: "The first plank is waiting" })), h("div.holm-today", { text: "The island starts growing with your first finished turn." })),
    ];
  }
  const b = info.building;
  const pct = b ? Math.round(b.progress * 100) : 100;
  return [
    h("span.holm-mark", { "aria-hidden": "true" }, icon(b ? "plank" : "island")),
    h(
      "div.holm-copy",
      null,
      h("div.holm-line", null, h("strong", { text: b ? b.name : "Everything is built" }), h("span", { text: b ? b.detail : info.tier })),
      b
        ? h("div.bar", { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": b.name + " progress" }, h("span.bar-fill", { style: { "--used": pct + "%" } }))
        : null,
      h("div.holm-today", { text: M.todayText(info.today) || "" }),
    ),
  ];
}

export { fill, icon, iconFor };
