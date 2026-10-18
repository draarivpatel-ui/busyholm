// First-run onboarding (WP-11). Runs in the settings window. Steps: welcome and the privacy
// promise; choose what to connect (hooks, the separate status line consent); preview the exact
// changes; connect; the Codex /hooks review explained; history import (only when the collector
// supports it); strip placement; done, with each tool's honest coverage state.
// All hook changes are applied as ONE previewed plan, so a single Disconnect all undoes them.

import * as core from "./core.js";
import * as M from "./model.js";
import { h, fill, applyAppearance } from "./dom.js";
import { icon } from "./icons.js";

/**
 * The collector does not implement the opt-in history import yet (collector/src/ledger.rs always
 * writes backfill: null, and SPEC Revision 1 item 5 defers it), so the step stays out of the flow
 * until it does. Turning this on without collector support would promise something that never happens.
 */
const BACKFILL_AVAILABLE = false;

const PARTS = [
  { part: "claude_hooks", title: "Claude Code", desc: "Bell and flag for permission requests and questions, plus working and finished states.", defaultOn: true },
  { part: "codex_hooks", title: "Codex", desc: "The same for Codex. Codex asks you to approve new hooks once, with /hooks.", defaultOn: true },
  { part: "opencode_plugin", title: "OpenCode (experimental)", desc: "Planned for a later version. OpenCode hooks are not wired in v0.1.", defaultOn: false },
  { part: "claude_statusline", title: "Claude Code usage limits", desc: "Wraps your status line so the sky can follow your 5-hour and weekly usage. What your status line shows stays the same; only the usage percentages and reset times are passed on.", defaultOn: false },
];

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);

let settings = core.boot().settings;
let status = null;
let snapshot = null;
let preview = null;
let connected = [];
let busy = false;
let flow = [];
let index = 0;

applyAppearance(settings, core.boot().os);

function steps() {
  const s = ["welcome", "choose"];
  if (selected().length && status && status.shim_available) s.push("preview");
  if (connected.includes("codex_hooks") || (selected().includes("codex_hooks") && !connected.length)) s.push("codex");
  if (BACKFILL_AVAILABLE) s.push("backfill");
  s.push("strip", "done");
  return s;
}

function selected() {
  return [...document.querySelectorAll('#ob-parts input[type="checkbox"]:checked')].map((i) => i.value);
}

function show(step, focus = true) {
  flow = steps();
  index = Math.max(0, flow.indexOf(step));
  for (const sec of document.querySelectorAll("section[data-step]")) sec.hidden = sec.dataset.step !== step;
  const n = flow.length;
  fill($("ob-dots"), flow.map((s, i) => h("span.dot", { dataset: { on: String(i === index), done: String(i < index) } })));
  $("ob-progress").textContent = "Step " + (index + 1) + " of " + n;
  $("ob-back").hidden = index === 0 || step === "done";
  $("ob-skip").hidden = step !== "welcome";
  const label = {
    welcome: "Get started",
    choose: selected().length && status && status.shim_available ? "Preview changes" : "Continue without hooks",
    preview: "Connect",
    codex: "Continue",
    backfill: "Continue",
    strip: "Continue",
    done: "Open Busyholm",
  }[step];
  $("ob-next").textContent = label;
  document.documentElement.dataset.obStep = step;
  if (step === "done") renderDone();
  if (step === "codex") renderCodex();
  if (focus) {
    const hd = document.querySelector('[data-step="' + step + '"] .ob-title');
    if (hd) hd.focus();
  }
  document.querySelector(".ob-main").scrollTop = 0;
}

function current() {
  return flow[index];
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

function renderParts() {
  const box = $("ob-parts");
  const legend = box.querySelector("legend");
  const byPart = Object.fromEntries((status ? status.parts : []).map((p) => [p.part, p]));
  const rows = PARTS.map((d) => {
    const st = byPart[d.part] || { available: false, connected: false, path: "" };
    const id = "part-" + d.part;
    const disabled = !st.available || st.connected || !(status && status.shim_available);
    const note = st.connected ? "Already connected" : st.unavailable_reason ? st.unavailable_reason : !st.available ? "Not found on this computer" : st.path;
    return h(
      "label.ob-check",
      { for: id, dataset: { part: d.part } },
      h("input", { type: "checkbox", id, value: d.part, checked: !disabled && d.defaultOn, disabled, "aria-describedby": id + "-desc" }),
      h("span", null, h("strong", { text: d.title }), h("small", { id: id + "-desc", text: d.desc }), h("small.ob-path", { text: note })),
    );
  });
  fill(box, legend, rows);
  if (status && !status.shim_available) {
    $("ob-choose-note").textContent = "The hook helper is missing from this build, so hooks cannot be connected. Busyholm can still show agents at work.";
  }
  box.addEventListener("change", () => {
    if (current() === "choose") show("choose", false);
  });
}

function renderPreview() {
  const box = $("ob-files");
  if (!preview || preview.files.length === 0) {
    fill(box, h("p.ob-small", { text: "Nothing needs to change: these are already connected." }));
    return;
  }
  fill(
    box,
    preview.files.map((f, i) => {
      const lines = String(f.diff || "").replace(/\n$/, "").split("\n");
      return h(
        "div.ob-file",
        null,
        h("div.ob-file-head", null, icon("details"), h("code", { text: f.path }), f.creates ? h("span.ob-tag", { text: "new file" }) : null),
        f.note ? h("p.ob-small", { text: f.note }) : null,
        h(
          "pre.diff",
          { tabindex: "0", "aria-label": "Changes to " + f.path, id: "diff-" + i },
          lines.map((l) => h("span.dl", { dataset: { k: l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : "ctx" }, text: l + "\n" })),
        ),
      );
    }),
    preview.notes && preview.notes.length ? preview.notes.map((n) => h("p.ob-small", { text: n })) : null,
  );
}

function coverageFor(tool) {
  const tools = snapshot && Array.isArray(snapshot.tools) ? snapshot.tools : [];
  return tools.find((t) => t.tool === tool) || null;
}

function renderCodex() {
  const t = coverageFor("codex");
  const el = $("ob-codex-status");
  if (t && t.hooks === "installed") fill(el, icon("check"), h("span", { text: "Codex has approved the Busyholm hooks." }));
  else fill(el, icon("clock"), h("span", { text: "Waiting for you to approve them in Codex. You can also do it later." }));
  el.dataset.ok = String(!!(t && t.hooks === "installed"));
}

function renderDone() {
  const items = M.coverageItems(snapshot).filter((i) => i.tool === "claude" || i.tool === "codex" || connected.includes(i.tool + "_plugin"));
  const list = $("ob-coverage");
  if (connected.length === 0 && !(status && status.any_connected)) {
    $("ob-done-lede").textContent = "No hooks are connected, so residents show their work but cannot ring the bell yet. You can connect them any time in Settings.";
  }
  fill(
    list,
    items.length
      ? items.map((it) => h("li", { dataset: { state: it.state } }, h("span.cov-mark", { dataset: { state: it.state }, "aria-hidden": "true" }), h("span", null, h("strong", { text: it.name + ": " + it.stateName }), h("small", { text: it.detail }))))
      : [h("li", null, h("span", { text: "Busyholm has not seen an agent yet. Start one and it shows up in the tray." }))],
  );
}

// ---------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------

function setError(id, text) {
  const e = $(id);
  e.hidden = !text;
  e.textContent = text || "";
}

async function next() {
  if (busy) return;
  const step = current();
  busy = true;
  $("ob-next").setAttribute("aria-busy", "true");
  try {
    if (step === "choose") {
      setError("ob-choose-error", "");
      const parts = selected();
      if (parts.length && status && status.shim_available) {
        const r = await core.connectPreview(parts);
        if (!r.ok) return setError("ob-choose-error", r.error);
        preview = r.preview;
        renderPreview();
        return show("preview");
      }
      return show(steps()[steps().indexOf("choose") + 1]);
    }
    if (step === "preview") {
      setError("ob-preview-error", "");
      if (preview && !preview.noop) {
        const r = await core.connectApply(preview.token);
        if (!r.ok) {
          setError("ob-preview-error", r.error + " Go back and preview again.");
          return;
        }
        status = r.status;
      }
      connected = selected();
      const s = steps();
      return show(s[s.indexOf("preview") + 1]);
    }
    if (step === "done") return finish();
    const s = steps();
    return show(s[Math.min(s.length - 1, s.indexOf(step) + 1)]);
  } finally {
    busy = false;
    $("ob-next").removeAttribute("aria-busy");
  }
}

function back() {
  const s = steps();
  const i = s.indexOf(current());
  if (i > 0) show(s[i - 1]);
}

async function finish() {
  await core.onboardingDone();
  if (core.hasCore()) await core.close();
  else location.href = "settings.html?noredirect=1";
}

// Strip placement saves at once (the whole Settings object), so the strip moves while you look.
async function saveStrip(mut) {
  const next = JSON.parse(JSON.stringify(settings));
  mut(next);
  const r = await core.setSettings(next);
  if (r.ok) {
    settings = r.settings;
    setError("ob-strip-error", "");
  } else {
    setError("ob-strip-error", r.error);
  }
  syncStrip();
}

function syncStrip() {
  for (const r of document.querySelectorAll('input[name="layer"]')) r.checked = r.value === settings.strip.layer_mode || (settings.strip.layer_mode === "reserve_space" && r.value === "on_top");
  const heights = [88, 112, 136];
  const nearest = heights.reduce((a, b) => (Math.abs(b - settings.strip.height) < Math.abs(a - settings.strip.height) ? b : a));
  for (const r of document.querySelectorAll('input[name="height"]')) r.checked = Number(r.value) === nearest;
  const unsupported = core.boot().strip && core.boot().strip.supported === false;
  for (const i of document.querySelectorAll("#ob-layer input, #ob-height input")) i.disabled = !!unsupported;
  if (unsupported) $("ob-strip-lede").textContent = "The island strip is not available on this system, so Busyholm shows everything in its own window instead. You can open it from the tray at any time.";
}

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.name === "layer") saveStrip((s) => (s.strip.layer_mode = t.value));
  if (t.name === "height") saveStrip((s) => (s.strip.height = Number(t.value)));
});

$("ob-next").addEventListener("click", next);
$("ob-back").addEventListener("click", back);
$("ob-skip").addEventListener("click", finish);

// Residents on the hero hill (art.js draws the same papercut animals as the strip).
async function drawHero() {
  try {
    const { portrait } = await import("./art.js");
    const cast = [
      ["beaver", 0, "cheer-0"],
      ["otter", 1, "stand-0"],
      ["frog", 3, "sit-0"],
      ["hare", 4, "stand-1"],
    ];
    fill($("ob-residents"), cast.map(([sp, sc, pose]) => h("span.ob-res", null, portrait(sp, sc, pose, 64))));
  } catch (e) {
    console.warn("busyholm: hero art unavailable", e);
  }
}

core.onSnapshot((s) => {
  if (s && Array.isArray(s.agents)) {
    snapshot = s;
    if (current() === "codex") renderCodex();
    if (current() === "done") renderDone();
  }
});
core.onConnectStatus((s) => {
  if (s && Array.isArray(s.parts)) status = s;
});

(async () => {
  const st = await core.onboardingState();
  if (st.done && q.get("again") !== "1" && core.hasCore()) {
    // Already onboarded: this page was opened directly; show settings instead.
    location.replace("settings.html");
    return;
  }
  status = await core.connectStatus();
  if (!status || !Array.isArray(status.parts)) status = { parts: [], any_connected: false, shim_available: false };
  snapshot = await core.getSnapshot();
  const s = await core.getSettings();
  if (s) settings = s;
  applyAppearance(settings, core.boot().os);
  renderParts();
  syncStrip();
  show(q.get("step") && steps().includes(q.get("step")) ? q.get("step") : "welcome", false);
  drawHero();
})();
