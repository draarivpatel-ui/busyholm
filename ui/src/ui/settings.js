// Settings window (WP-11): a native-feeling preferences page over Settings v1 (SPEC 6.9).
//
// Rules this file keeps (they are tested):
//  - `saved` is the last Settings object the core accepted.
//  - Every change sends a COMPLETE new Settings v1 object (a deep copy of `saved` plus the one
//    change) through core.setSettings, never a partial patch. Changes are queued one after the
//    other so two quick changes cannot overwrite each other.
//  - On ok: saved = result.settings, controls re-render from it. On error: every control goes back
//    to `saved` and the error shows in the row that was changed.
//  - Hook connections go through a preview dialog; nothing is written until the user confirms.

import * as core from "./core.js";
import { h, fill, announce, applyAppearance } from "./dom.js";
import { icon } from "./icons.js";
import { TOOL_NAME, SPECIES, SPECIES_NAME, DEFAULT_SPECIES } from "./model.js";

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const OS = core.boot().os;
const ACCELERATOR = /^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

const DEFAULTS = {
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

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** A settings object with every group present (the core always sends complete ones). */
function normalize(s) {
  if (!s || typeof s !== "object") return clone(DEFAULTS);
  let out = s;
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (out[k] === undefined) {
      if (out === s) out = { ...s };
      out[k] = clone(v);
    }
  }
  if (!out.agents.species || typeof out.agents.species !== "object") {
    out = { ...out, agents: { ...out.agents, species: {} } };
  }
  return out;
}

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((o, k) => o[k], obj);
  parent[last] = value;
}

// ---------------------------------------------------------------------------------------------
// State, saving and syncing
// ---------------------------------------------------------------------------------------------

let saved = normalize(clone(core.boot().settings));
const syncers = [];
let queue = Promise.resolve();

const sync = (fn) => syncers.push(fn);

function syncAll(force) {
  for (const fn of syncers) fn(!!force);
}

function clearErrors() {
  for (const e of document.querySelectorAll(".field-error")) e.remove();
  for (const e of document.querySelectorAll("[aria-invalid]")) e.removeAttribute("aria-invalid");
}

function setError(row, message) {
  if (!row) return;
  let p = row.querySelector(":scope > .field-error");
  if (!p) {
    p = h("p.field-error", { role: "alert" });
    row.append(p);
  }
  fill(p, icon("warning"), h("span", { text: message }));
}

function clearRowError(row) {
  const p = row && row.querySelector(":scope > .field-error");
  if (p) p.remove();
}

/**
 * Apply one change. `mutate(draft)` edits a deep copy of the settings that were saved when this
 * change gets its turn; the whole copy goes to the core.
 */
function commit(row, mutate) {
  queue = queue.then(async () => {
    const next = clone(saved);
    mutate(next);
    let r;
    try {
      r = await core.setSettings(next);
    } catch (e) {
      r = { ok: false, error: "Busyholm could not save this setting." };
    }
    if (r && r.ok) {
      saved = normalize(r.settings);
      clearErrors();
      applyAppearance(saved, OS);
      syncAll(true);
    } else {
      syncAll(true);
      setError(row, (r && r.error) || "Busyholm could not save this setting.");
    }
  });
  return queue;
}

// ---------------------------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------------------------

const idFor = (path) => "c-" + path.replace(/\./g, "-");

function describedBy(id, desc) {
  return desc ? id + "-d" : null;
}

function rowShell(id, title, desc, ...controls) {
  return h(
    "div.row",
    null,
    h("div.row-text", null, h("label.row-title", { for: id, text: title }), desc ? h("p.row-desc", { id: id + "-d", text: desc }) : null),
    h("div.row-control", null, ...controls),
  );
}

function switchRow(path, title, desc, opts = {}) {
  const id = idFor(path);
  const input = h("input.switch", { type: "checkbox", role: "switch", id, "data-path": path, "aria-describedby": describedBy(id, desc), disabled: opts.disabled });
  const row = rowShell(id, title, desc, input);
  const read = opts.read || ((s) => !!getPath(s, path));
  const write = opts.write || ((d, v) => setPath(d, path, v));
  input.addEventListener("change", () => commit(row, (d) => write(d, input.checked)));
  sync(() => {
    input.checked = read(saved);
    if (opts.after) opts.after(input.checked);
  });
  return row;
}

function selectRow(path, title, desc, options, { read, write }) {
  const id = idFor(path);
  const select = h(
    "select",
    { id, "data-path": path, "aria-describedby": describedBy(id, desc) },
    options.map((o) => h("option", { value: o.value, text: o.label })),
  );
  const row = rowShell(id, title, desc, h("span.select-wrap", null, select));
  select.addEventListener("change", () => commit(row, (d) => write(d, select.value)));
  sync(() => {
    for (const o of select.querySelectorAll("option[data-extra]")) o.remove();
    const v = String(read(saved));
    if (![...select.options].some((o) => o.value === v)) select.append(h("option", { value: v, text: v + " minutes", "data-extra": "1" }));
    select.value = v;
  });
  return row;
}

function rangeRow(path, title, desc, { min, max, step, format, round }) {
  const id = idFor(path);
  const input = h("input.range", { type: "range", min, max, step, id, "data-path": path, "aria-describedby": describedBy(id, desc) });
  const value = h("span.value.tabular", { "aria-hidden": "true" });
  const paint = () => {
    const v = Number(input.value);
    value.textContent = format(v);
    input.setAttribute("aria-valuetext", format(v));
    input.style.setProperty("--fill", ((v - min) / (max - min)) * 100 + "%");
  };
  const row = rowShell(id, title, desc, input, value);
  input.addEventListener("input", paint);
  input.addEventListener("change", () => commit(row, (d) => setPath(d, path, round(Number(input.value)))));
  sync(() => {
    input.value = String(getPath(saved, path));
    paint();
  });
  return row;
}

/** A radio group: a fieldset with a legend; every radio carries data-path and its value. */
function radioRow(path, legend, desc, options, { read, write }) {
  const gid = idFor(path);
  const radios = [];
  const opts = options.map((o) => {
    const id = gid + "-" + o.value.replace(/_/g, "-");
    const input = h("input.radio", { type: "radio", name: path, id, value: o.value, "data-path": path, "aria-describedby": o.desc ? id + "-d" : null });
    radios.push(input);
    return h("div.opt", null, input, h("div.opt-text", null, h("label", { for: id, text: o.label }), o.desc ? h("small", { id: id + "-d", text: o.desc }) : null));
  });
  const row = h(
    "div.row.row-radios",
    null,
    h(
      "fieldset",
      { "aria-describedby": desc ? gid + "-d" : null },
      h("legend.row-title", { text: legend }),
      desc ? h("p.row-desc", { id: gid + "-d", text: desc }) : null,
      h("div.opts", null, opts),
    ),
  );
  for (const r of radios) r.addEventListener("change", () => r.checked && commit(row, (d) => write(d, r.value)));
  sync(() => {
    const v = read(saved);
    for (const r of radios) r.checked = r.value === v;
  });
  row.radios = radios;
  return row;
}

function textRow(path, title, desc, { read, onChange, placeholder }) {
  const id = idFor(path);
  const input = h("input.text", {
    type: "text", id, "data-path": path, placeholder, spellcheck: "false", autocomplete: "off", autocapitalize: "off", maxlength: "64",
    "aria-describedby": describedBy(id, desc),
  });
  const row = rowShell(id, title, desc, input);
  input.addEventListener("change", () => onChange(row, input));
  sync((force) => {
    if (!force && document.activeElement === input) return;
    input.value = read(saved) || "";
  });
  return row;
}

function timeRow(path, title, desc, hidden) {
  const id = idFor(path);
  const input = h("input.time", { type: "time", id, "data-path": path, step: "60", required: true, "aria-describedby": describedBy(id, desc) });
  const row = rowShell(id, title, desc, input);
  const key = path.endsWith(".start") ? "start" : "end";
  input.addEventListener("change", () => {
    const v = input.value;
    if (!HHMM.test(v)) {
      setError(row, "Enter a time such as 22:00.");
      input.setAttribute("aria-invalid", "true");
      return;
    }
    commit(row, (d) => {
      if (!d.sound.quiet_hours) d.sound.quiet_hours = { start: "22:00", end: "07:00" };
      d.sound.quiet_hours[key] = v;
    });
  });
  sync(() => {
    const qh = saved.sound.quiet_hours;
    row.hidden = !qh;
    if (qh) input.value = qh[key];
  });
  row.hidden = true;
  return row;
}

const group = (...rows) => h("div.group", null, rows);
const note = (text, iconName) => h("p.note", null, icon(iconName || "info"), h("span", { text }));
const caption = (text, id) => h("h3.caption", { id }, text);

// ---------------------------------------------------------------------------------------------
// Dialogs: <dialog> + showModal(). Escape closes; focus returns to the button that opened it.
// ---------------------------------------------------------------------------------------------

let dialogSeq = 0;

function fallbackFocus() {
  const heading = $("h-agents");
  if (heading) heading.focus({ preventScroll: true });
}

/**
 * opts: { title, body: Node[], okLabel, okClass, onConfirm(): Promise<{ok, error?}>, opener(): Element,
 *         noop?: boolean }
 */
function openDialog(opts) {
  // A dialog closed a moment ago stays in the DOM until its async close event; drop it now so ids
  // stay unique and the new dialog is the only one.
  for (const old of document.querySelectorAll("dialog.dialog")) if (!old.open) old.remove();
  const n = ++dialogSeq;
  const titleId = "dlg-title-" + n;
  let busy = false;
  const dlg = h("dialog.dialog", { "aria-labelledby": titleId });
  const cancel = h("button.btn", { type: "button", id: "confirm-cancel", text: opts.noop ? "Close" : "Cancel" });
  const ok = opts.noop ? null : h("button." + opts.okClass.split(" ").join("."), { type: "button", id: "confirm-ok", text: opts.okLabel });
  const slot = h("div.dialog-slot");
  const body = h("div.dialog-body", null, h("h2.dialog-title", { id: titleId, text: opts.title }), opts.body, slot);
  fill(dlg, body, h("div.dialog-actions", null, cancel, ok));

  cancel.addEventListener("click", () => dlg.close());
  // Keep Tab and Shift+Tab inside the dialog (the browser would otherwise move on to its own chrome).
  dlg.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const items = [...dlg.querySelectorAll("button, [href], input, select, textarea, [tabindex]")].filter((el) => !el.disabled && el.tabIndex >= 0 && !el.hidden);
    if (!items.length) return;
    const first = items[0];
    const lastItem = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && document.activeElement === lastItem) {
      e.preventDefault();
      first.focus();
    }
  });
  dlg.addEventListener("cancel", (e) => {
    if (busy) e.preventDefault();
  });
  dlg.addEventListener("close", () => {
    dlg.remove();
    if (document.querySelector("dialog[open]")) return; // a newer dialog owns focus now
    const target = opts.opener && opts.opener();
    if (target && target.isConnected && !target.disabled) target.focus();
    else fallbackFocus();
  });
  if (ok) {
    ok.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      cancel.disabled = true;
      ok.disabled = true;
      slot.replaceChildren();
      let r;
      try {
        r = await opts.onConfirm();
      } catch (e) {
        r = { ok: false, error: "Something went wrong. Nothing was changed." };
      }
      busy = false;
      if (r && r.ok) {
        dlg.close();
        return;
      }
      cancel.disabled = false;
      ok.disabled = false;
      fill(slot, h("p.dialog-error", { role: "alert" }, icon("warning"), h("span", { text: (r && r.error) || "Something went wrong. Nothing was changed." })));
      ok.focus();
    });
  }
  document.body.append(dlg);
  dlg.showModal();
  cancel.focus();
  return dlg;
}

function diffBlock(file) {
  const lines = String(file.diff || "").replace(/\n$/, "").split("\n");
  const pre = h("pre.diff", { tabindex: "0", role: "group", "aria-label": "Changes to " + file.path });
  for (const line of lines) {
    const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "ctx";
    pre.append(h("span." + kind, { text: line === "" ? " " : line }));
  }
  return pre;
}

function previewFiles(preview) {
  const files = (preview && preview.files) || [];
  return files.map((f) =>
    h(
      "div.file",
      null,
      h("div.file-head", null, h("code.path", { text: f.path }), f.creates ? h("span.file-tag", { text: "New file" }) : f.deletes ? h("span.file-tag", { text: "File removed" }) : null),
      f.note ? h("p.file-note", { text: f.note }) : null,
      f.diff ? diffBlock(f) : null,
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Agents: hook connections
// ---------------------------------------------------------------------------------------------

const PARTS = {
  claude_hooks: {
    title: "Claude Code hooks",
    dialog: "Claude Code hooks",
    desc: "Lets Claude Code tell Busyholm when it is working, needs you or has finished.",
  },
  claude_statusline: {
    title: "Claude Code usage limits",
    dialog: "Claude Code usage limits",
    desc: "Wraps your status line so Busyholm can read the 5-hour and weekly usage. Your status line keeps working as before; only the usage numbers are passed on.",
  },
  codex_hooks: {
    title: "Codex hooks",
    dialog: "Codex hooks",
    desc: "Lets Codex tell Busyholm when it is working, needs you or has finished.",
    pending: "Added. Codex asks you to review new hooks: run /hooks in Codex and approve the Busyholm entries.",
  },
  opencode_plugin: {
    title: "OpenCode plugin (experimental)",
    dialog: "the OpenCode plugin",
    desc: "Planned for a later version. OpenCode hooks are not wired in v0.1.",
  },
};

let connect = null; // last good status from the core
let connectProblem = "";
const partRows = new Map();
let previewBusy = false;

function partRow(part) {
  const info = PARTS[part] || { title: part, dialog: part, desc: "" };
  const titleId = "part-" + part + "-t";
  const descId = "part-" + part + "-d";
  const statusId = "part-" + part + "-s";
  const btnId = "part-" + part + "-b";
  const status = h("span.status", { id: statusId });
  const mark = h("span.cov-mark", { "aria-hidden": "true" });
  const desc = h("p.row-desc", { id: descId });
  const button = h("button.btn", { type: "button", id: btnId, "data-part": part, "aria-labelledby": btnId + " " + titleId, "aria-describedby": descId + " " + statusId });
  const row = h(
    "div.row.hook-row",
    { "data-row-part": part },
    h(
      "div.row-text",
      null,
      h("span.row-title", { id: titleId, text: info.title }),
      desc,
    ),
    h("div.row-control", null, button),
    h("p.hook-meta", null, h("code.path"), h("span.state", null, mark, status)),
  );
  button.addEventListener("click", () => startPartFlow(part, row, button));
  const r = { row, button, desc, status, mark, path: row.querySelector("code.path") };
  partRows.set(part, r);
  return r;
}

function renderConnect() {
  const list = $("hook-list");
  const placeholder = list.querySelector(".hook-wait");
  if (!connect || !Array.isArray(connect.parts)) {
    if (!placeholder) {
      fill(list);
    }
    if (connectProblem) {
      fill(list, h("div.row", null, h("p.field-error", { role: "alert" }, icon("warning"), h("span", { text: connectProblem }))));
    } else if (!placeholder) {
      fill(list, h("div.row.hook-wait", { "aria-busy": "true" }, h("p.row-desc", { text: "Checking which agents are installed." })));
    }
    $("disconnect-all").disabled = true;
    $("shim-note").hidden = true;
    return;
  }
  if (placeholder || list.querySelector(".field-error")) fill(list);
  const shimOk = connect.shim_available !== false;
  for (const p of connect.parts) {
    const info = PARTS[p.part];
    if (!info) continue;
    const r = partRows.get(p.part) || partRow(p.part);
    if (!r.row.isConnected) list.append(r.row);
    r.path.textContent = p.path || "";
    r.desc.textContent = p.part === "codex_hooks" && p.connected && p.pending_review ? info.pending : info.desc;
    const missing = p.available === false && !p.connected;
    r.status.textContent = p.connected ? (p.pending_review ? "Waiting for approval in Codex" : "Connected") : p.unavailable_reason ? p.unavailable_reason : missing ? "Not found on this computer" : "Not connected";
    r.mark.dataset.state = p.connected ? (p.pending_review ? "degraded" : "verified") : "unsupported";
    r.button.textContent = p.connected ? "Disconnect" : "Connect";
    r.button.dataset.action = p.connected ? "disconnect" : "connect";
    r.button.disabled = p.connected ? false : missing || !shimOk;
  }
  $("disconnect-all").disabled = !connect.parts.some((p) => p.connected);
  $("shim-note").hidden = shimOk;
}

async function refreshConnect() {
  const st = await core.connectStatus();
  setConnect(st);
}

function setConnect(st) {
  if (st && Array.isArray(st.parts)) {
    connect = st;
    connectProblem = "";
  } else if (!connect) {
    connectProblem = "Busyholm could not read which agents are connected" + (st && st.error ? ": " + st.error : ".");
  }
  renderConnect();
}

async function startPartFlow(part, row, button) {
  if (previewBusy) return;
  previewBusy = true;
  clearRowError(row);
  const info = PARTS[part];
  const current = connect && connect.parts.find((p) => p.part === part);
  const disconnecting = !!(current && current.connected);
  const verb = disconnecting ? "Disconnect" : "Connect";
  let r;
  try {
    r = disconnecting ? await core.disconnectPreview([part]) : await core.connectPreview([part]);
  } finally {
    previewBusy = false;
  }
  if (!r || !r.ok) {
    setError(row, (r && r.error) || "Busyholm could not prepare these changes.");
    return;
  }
  const preview = r.preview;
  const noop = !!preview.noop && !(preview.files || []).length;
  const body = [
    h("p.dialog-text", { text: noop ? "Nothing needs to change." : "These are the exact changes. Nothing is written until you choose " + verb + "." }),
    previewFiles(preview),
    (preview.notes || []).map((t) => h("p.file-note", { text: t })),
  ];
  openDialog({
    title: verb + " " + info.dialog + "?",
    body,
    okLabel: verb,
    okClass: disconnecting ? "btn danger solid" : "btn primary",
    noop,
    opener: () => document.querySelector('[data-part="' + part + '"]'),
    onConfirm: async () => {
      const res = await core.connectApply(preview.token);
      if (!res || !res.ok) return { ok: false, error: (res && res.error) || "Busyholm could not make these changes." };
      if (res.status && Array.isArray(res.status.parts)) setConnect(res.status);
      else await refreshConnect();
      announce(info.title + (disconnecting ? " disconnected." : " connected."));
      return { ok: true };
    },
  });
}

async function startDisconnectAll() {
  const button = $("disconnect-all");
  if (previewBusy) return;
  previewBusy = true;
  const errorSlot = $("disconnect-error");
  errorSlot.replaceChildren();
  let r;
  try {
    r = await core.disconnectPreview([]);
  } finally {
    previewBusy = false;
  }
  if (!r || !r.ok) {
    fill(errorSlot, h("p.field-error", { role: "alert" }, icon("warning"), h("span", { text: (r && r.error) || "Busyholm could not prepare these changes." })));
    return;
  }
  const preview = r.preview;
  const files = preview.files || [];
  const noop = !!preview.noop && !files.length;
  const body = noop
    ? [h("p.dialog-text", { text: "Nothing is connected, so nothing needs to change." })]
    : [
        h("p.dialog-text", { text: "Busyholm removes only the entries it added. Everything else in these files stays exactly as it is, and a file Busyholm created is removed again." }),
        h("ul.file-list", null, files.map((f) => h("li", null, h("code.path", { text: f.path })))),
        h("p.dialog-text", { text: "Your island and its progress stay. The bell and flag stop until you connect again." }),
      ];
  openDialog({
    title: "Disconnect all hooks?",
    body,
    okLabel: "Disconnect all",
    okClass: "btn danger solid",
    noop,
    opener: () => $("disconnect-all"),
    onConfirm: async () => {
      const res = await core.connectApply(preview.token);
      if (!res || !res.ok) return { ok: false, error: (res && res.error) || "Busyholm could not make these changes." };
      if (res.status && Array.isArray(res.status.parts)) setConnect(res.status);
      else await refreshConnect();
      announce("All hooks disconnected.");
      return { ok: true };
    },
  });
  void button;
}

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

const TOOL_ROWS = ["claude", "codex", "opencode", "antigravity", "gemini", "other"];
const TOOL_LABEL = { ...TOOL_NAME, other: "Other tools" };

function buildAgents() {
  const hookList = h("div.group", { id: "hook-list" });
  const disconnectAll = h("button.btn.danger", { type: "button", id: "disconnect-all", disabled: true }, icon("unplug"), h("span", { text: "Disconnect all" }));
  disconnectAll.addEventListener("click", startDisconnectAll);

  const residents = TOOL_ROWS.map((tool) => {
    const def = DEFAULT_SPECIES[tool];
    return selectRow(
      "agents.species." + tool,
      TOOL_LABEL[tool],
      "Default: " + SPECIES_NAME[def] + ".",
      SPECIES.map((s) => ({ value: s, label: SPECIES_NAME[s] + (s === def ? " (default)" : "") })),
      {
        read: (s) => {
          const v = s.agents.species[tool];
          return SPECIES.includes(v) ? v : def;
        },
        write: (d, v) => {
          if (!d.agents.species || typeof d.agents.species !== "object") d.agents.species = {};
          if (v === def) delete d.agents.species[tool];
          else d.agents.species[tool] = v;
        },
      },
    );
  });

  const again = h("button.btn.quiet", { type: "button", id: "run-setup" }, icon("history"), h("span", { text: "Run setup again" }));
  again.addEventListener("click", () => location.assign("onboarding.html?again=1"));

  return [
    h("p.intro", { text: "Hooks let a resident ring the bell and raise a flag when your agent needs you. Busyholm reads your agents' activity logs and transcripts to count events and never keeps, shows or sends their text; from hooks, only event types, ids, timings and counts ever leave the agent process over loopback." }),
    caption("Connections", "cap-connections"),
    hookList,
    h("p.note.warn", { id: "shim-note", hidden: true }, icon("warning"), h("span", { text: "The hook helper is missing from this build." })),
    h("div.actions", null, h("div.actions-error", { id: "disconnect-error" }), disconnectAll),
    caption("Residents", "cap-residents"),
    group(...residents),
    h("div.actions.actions-left", null, again),
  ];
}

function stripDisabled() {
  const b = core.boot();
  return !!(b.strip && b.strip.supported === false);
}

function buildStrip() {
  const reserveDesc = OS === "macos" ? "On macOS this works like On top." : "Other windows make room so nothing sits under the strip.";
  const displayRow = (() => {
    const id = "c-strip-display";
    const desc = h("p.row-desc", { id: id + "-d" });
    const btn = h("button.btn", { type: "button", id, "data-path": "strip.display", "aria-describedby": id + "-d", text: "Use automatic" });
    const row = h("div.row", null, h("div.row-text", null, h("span.row-title", { text: "Display" }), desc), h("div.row-control", null, btn));
    btn.addEventListener("click", () => commit(row, (d) => (d.strip.display = { mode: "auto" })));
    sync(() => {
      const dsp = saved.strip.display;
      const named = dsp && dsp.mode === "named";
      desc.textContent = named ? "Showing on the display named " + dsp.name + "." : "Automatic: the display with the Dock or taskbar";
      btn.hidden = !named;
    });
    return row;
  })();

  const rows = [
    switchRow("strip.enabled", "Show the island strip", "The strip of residents along the edge of your screen."),
    displayRow,
    rangeRow("strip.height", "Height", "How tall the strip is.", { min: 72, max: 160, step: 4, format: (v) => v + " px", round: (v) => Math.round(v) }),
    radioRow(
      "strip.layer_mode",
      "Layer",
      "Where the strip sits relative to your other windows.",
      [
        { value: "on_top", label: "On top of windows", desc: "The strip stays above other windows." },
        { value: "behind_windows", label: "Behind windows (experimental)", desc: "The strip sits under your windows and shows in the gaps." },
        { value: "reserve_space", label: "Reserve space (experimental)", desc: reserveDesc },
      ],
      { read: (s) => s.strip.layer_mode, write: (d, v) => (d.strip.layer_mode = v) },
    ),
    switchRow("strip.hover_fade", "Fade when the pointer comes near", "Keeps the strip out of the way of what is underneath."),
    switchRow("strip.show_over_fullscreen", "Show over full-screen apps", "Keeps the strip visible while another app is full screen."),
  ];
  const out = [];
  if (stripDisabled()) {
    out.push(note("The strip is not available on this system; the details window shows everything instead."));
    for (const r of rows) for (const c of r.querySelectorAll("input, select, button")) c.disabled = true;
    // The display row's button is only ever shown when a named display is saved; keep it inert here.
  }
  out.push(group(...rows));
  return out;
}

function buildSky() {
  return [
    group(
      radioRow(
        "sky.mode",
        "Sun",
        null,
        [
          { value: "usage_and_clock", label: "Usage and clock", desc: "The sun follows your 5-hour usage window." },
          { value: "clock_only", label: "Clock only", desc: "The sun follows the time of day." },
        ],
        { read: (s) => s.sky.mode, write: (d, v) => (d.sky.mode = v) },
      ),
      radioRow(
        "sky.hemisphere",
        "Hemisphere",
        "Used for the seasons.",
        [
          { value: "north", label: "Northern" },
          { value: "south", label: "Southern" },
        ],
        { read: (s) => s.sky.hemisphere, write: (d, v) => (d.sky.hemisphere = v) },
      ),
    ),
  ];
}

function buildSound() {
  const rows = [
    switchRow("sound.bell", "Ring the bell when an agent needs you", "A short chime, so you can look away."),
    rangeRow("sound.volume", "Volume", "How loud the bell is.", { min: 0, max: 1, step: 0.05, format: (v) => Math.round(v * 100) + "%", round: (v) => Math.round(v * 100) / 100 }),
    switchRow("sound.quiet_hours", "Quiet hours", "No bell between the two times below.", {
      read: (s) => !!s.sound.quiet_hours,
      write: (d, on) => (d.sound.quiet_hours = on ? { start: "22:00", end: "07:00" } : null),
    }),
    timeRow("sound.quiet_hours.start", "Quiet hours start", "Local time."),
    timeRow("sound.quiet_hours.end", "Quiet hours end", "Can be earlier than the start, to run past midnight."),
  ];
  // Nothing plays these yet, so they are shown but cannot be changed.
  for (const r of rows) for (const c of r.querySelectorAll("input, select, button")) c.disabled = true;
  return [note("The bell is visual for now. Busyholm plays no sound in this version, so these settings have no effect yet."), group(...rows)];
}

function buildNotifications() {
  return [
    group(
      switchRow("notifications.needs_you", "An agent needs you", "A desktop notification when an agent is waiting."),
      switchRow("notifications.renotify", "Remind me after 5 minutes", "One more nudge if an agent is still waiting."),
      switchRow("notifications.long_turn", "A long turn finished (over 2 minutes)", "So you know when a long task is done."),
      switchRow("notifications.errors", "An agent stopped with an error", "Lets you know when something went wrong."),
    ),
    note("Notifications name the tool and what it is waiting for. Busyholm reads the agents' activity logs and transcripts to count events and never keeps, shows or sends their text, project names, prompts or code."),
  ];
}

function buildAmbient() {
  const idle = [{ value: "", label: "Off" }, ...[5, 10, 15, 20, 30, 45, 60].map((n) => ({ value: String(n), label: n + " minutes" }))];
  return [
    group(
      selectRow("ambient.idle_minutes", "Start after idle time", "Start the scene from the tray or with the shortcut below. Automatic start after idle time is off in v0.1.", idle, {
        read: (s) => (s.ambient.idle_minutes == null ? "" : s.ambient.idle_minutes),
        write: (d, v) => (d.ambient.idle_minutes = v === "" ? null : Number(v)),
      }),
      textRow("ambient.shortcut", "Shortcut", "A global shortcut for the ambient scene, such as Alt+Shift+B. Leave it empty for none.", {
        placeholder: "None",
        read: (s) => s.ambient.shortcut,
        onChange: (row, input) => {
          const v = input.value.trim();
          if (v === "") {
            input.removeAttribute("aria-invalid");
            commit(row, (d) => (d.ambient.shortcut = null));
          } else if (v.length > 64 || !ACCELERATOR.test(v)) {
            input.setAttribute("aria-invalid", "true");
            setError(row, "Use letters, numbers and + only, for example CommandOrControl+Shift+B.");
          } else {
            input.removeAttribute("aria-invalid");
            commit(row, (d) => (d.ambient.shortcut = v));
          }
        },
      }),
    ),
  ];
}

function buildPrivacy() {
  const errEl = h("div.actions-error", { id: "delete-everything-error" });
  const delBtn = h("button.btn.danger", { type: "button", id: "delete-everything" }, icon("warning"), h("span", { text: "Delete everything" }));
  delBtn.addEventListener("click", () => {
    errEl.replaceChildren();
    openDialog({
      title: "Delete everything Busyholm keeps?",
      body: [
        h("p.dialog-text", {
          text: "Busyholm will first disconnect its hooks and status line from your agents and restore your original settings. Then it will delete its app data folder: ledger.json, backups/, coverage.json, logs and settings. Busyholm will close when it is done.",
        }),
      ],
      okLabel: "Delete everything",
      okClass: "btn danger solid",
      opener: () => delBtn,
      onConfirm: async () => {
        const res = await core.deleteEverything();
        if (!res || !res.ok) return { ok: false, error: (res && res.error) || "Busyholm could not delete its data folder." };
        if (res.status && Array.isArray(res.status.parts)) setConnect(res.status);
        else await refreshConnect();
        announce("All hooks disconnected and Busyholm data folder deleted. Closing Busyholm.");
        return { ok: true };
      },
    });
  });
  return [
    note("Busyholm reads your agents' activity logs and transcripts to count events and never keeps, shows or sends their text. No outbound network connections; loopback only."),
    group(
      switchRow("privacy.history_backfill", "Import past activity (counts only)", "Not available in this version.", { disabled: true }),
    ),
    h("div.actions", null, errEl, delBtn),
  ];
}

function buildOther() {
  const noticesBtn = h("button.btn", { type: "button", id: "notices-btn", text: "Show notices" });
  noticesBtn.addEventListener("click", async () => {
    noticesBtn.disabled = true;
    const text = await core.thirdPartyNotices();
    noticesBtn.disabled = false;
    openDialog({
      title: "Third-party notices",
      body: [
        h("p.dialog-lead", { text: "Open-source licences for Rust crates, npm packages, and the bundled Fraunces font." }),
        h("pre.diff", { id: "notices-text", text }),
      ],
      noop: true,
      opener: () => noticesBtn,
    });
  });
  return [
    group(
      switchRow("other.launch_at_login", "Open Busyholm at login", "Starts Busyholm in the tray when you sign in."),
      radioRow(
        "other.reduced_motion",
        "Motion",
        "Reduced motion stops the animated scenery and fades.",
        [
          { value: "follow_os", label: "Follow the system" },
          { value: "always", label: "Always reduce motion" },
        ],
        { read: (s) => s.other.reduced_motion, write: (d, v) => (d.other.reduced_motion = v) },
      ),
      rowShell(
        "other-notices",
        "Third-party notices",
        "Open-source licences for Rust crates, npm packages, and the Fraunces font.",
        noticesBtn,
      ),
    ),
  ];
}

const SECTIONS = [
  { id: "agents", label: "Agents", icon: "plug", build: buildAgents },
  { id: "strip", label: "Strip", icon: "strip", build: buildStrip },
  { id: "sky", label: "Sky", icon: "moon", build: buildSky },
  { id: "sound", label: "Sound", icon: "bell", build: buildSound },
  { id: "notifications", label: "Notifications", icon: "flag", build: buildNotifications },
  { id: "ambient", label: "Ambient", icon: "island", build: buildAmbient },
  { id: "privacy", label: "Privacy", icon: "shield", build: buildPrivacy },
  { id: "other", label: "Other", icon: "settings", build: buildOther },
];

// ---------------------------------------------------------------------------------------------
// Sidebar and scrolling
// ---------------------------------------------------------------------------------------------

let navLock = false;

function setCurrent(id) {
  for (const b of $("side").querySelectorAll("button")) {
    if (b.dataset.section === id) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  }
}

function goTo(id) {
  const heading = $("h-" + id);
  const section = $("sec-" + id);
  if (!heading || !section) return;
  navLock = true;
  setCurrent(id);
  section.scrollIntoView({ block: "start" });
  heading.focus({ preventScroll: true });
  setTimeout(() => (navLock = false), 120);
}

function spy() {
  if (navLock) return;
  const pane = $("pane");
  const top = pane.getBoundingClientRect().top + 48;
  let current = SECTIONS[0].id;
  for (const s of SECTIONS) {
    if ($("sec-" + s.id).getBoundingClientRect().top <= top) current = s.id;
  }
  if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2 && pane.scrollTop > 0) {
    // Scrolled to the very end: the last section whose heading is on screen.
    const bottom = pane.getBoundingClientRect().bottom;
    for (const s of SECTIONS) {
      if ($("h-" + s.id).getBoundingClientRect().bottom <= bottom) current = s.id;
    }
  }
  setCurrent(current);
}

function buildShell() {
  const side = $("side");
  const sections = $("sections");
  for (const s of SECTIONS) {
    const btn = h("button.nav-btn", { type: "button", "data-section": s.id }, icon(s.icon), h("span", { text: s.label }));
    btn.addEventListener("click", () => goTo(s.id));
    side.append(btn);
    sections.append(h("section.section", { id: "sec-" + s.id, "aria-labelledby": "h-" + s.id }, h("h2", { id: "h-" + s.id, tabindex: "-1", text: s.label }), s.build()));
  }
  setCurrent(SECTIONS[0].id);
  let ticking = false;
  $("pane").addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      spy();
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

async function start() {
  if (q.get("noredirect") !== "1") {
    const st = await core.onboardingState();
    if (st && st.done === false) {
      location.replace("onboarding.html");
      return;
    }
  }
  applyAppearance(saved, OS);
  buildShell();
  renderConnect();
  syncAll(true);

  core.onSettings((s) => {
    if (!s || typeof s !== "object") return;
    saved = normalize(s);
    applyAppearance(saved, OS);
    syncAll(false);
  });
  core.onConnectStatus((st) => setConnect(st));

  const [settings, status] = await Promise.all([core.getSettings(), core.connectStatus()]);
  if (settings && typeof settings === "object") {
    saved = normalize(settings);
    applyAppearance(saved, OS);
    syncAll(false);
  }
  setConnect(status);
}

window.__bhSettings = {
  get saved() {
    return saved;
  },
};

start();
