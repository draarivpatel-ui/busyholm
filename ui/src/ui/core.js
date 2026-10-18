// Busyholm UI bridge (WP-11): boot data, core events and commands for the popover, settings,
// details and onboarding pages. Follows the WP-02 page contract in app/README.md and adds the
// WP-11 commands (hook connect and disconnect, onboarding state). Plain ES module.
//
// Without a Tauri core (a plain browser) every page runs on a built-in demo scenario and the
// commands answer locally, so the pages can be opened and screenshotted on their own. Tests
// replace window.__TAURI__ with a fake core and so exercise the same code path as the app.

import { SCENARIOS, DEMO_SETTINGS, DEMO_CONNECT_STATUS, DEMO_WORLD_INPUTS } from "./scenarios.js";

const SURFACES = ["strip", "ambient", "popover", "settings", "details"];
const OPEN_SURFACES = ["details", "settings", "popover", "ambient"];

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function tauri() {
  return typeof window !== "undefined" ? window.__TAURI__ : undefined;
}

/** True when a Tauri core (or a test double of one) is connected. */
export function hasCore() {
  const t = tauri();
  return !!(t && t.core && typeof t.core.invoke === "function" && t.event && typeof t.event.listen === "function");
}

function guessOs() {
  const p = String((typeof navigator !== "undefined" && (navigator.platform || navigator.userAgent)) || "");
  if (/mac/i.test(p)) return "macos";
  if (/win/i.test(p)) return "windows";
  return "linux";
}

function params() {
  try {
    return new URLSearchParams(location.search);
  } catch {
    return new URLSearchParams();
  }
}

/** Demo scenario for browser-only mode: ?scenario=<key>, default "afternoon". */
function demoScenario() {
  const key = params().get("scenario") || "afternoon";
  return SCENARIOS[key] || SCENARIOS.afternoon;
}

let bootCache = null;

/** The boot object the core sets before page scripts run, or a browser-only default. */
export function boot() {
  if (typeof window !== "undefined" && window.__BUSYHOLM_BOOT__) return window.__BUSYHOLM_BOOT__;
  if (!bootCache) {
    const m = String((typeof location !== "undefined" && location.pathname) || "").match(/([a-z]+)\.html?$/i);
    const s = m ? m[1].toLowerCase() : "popover";
    bootCache = {
      surface: SURFACES.includes(s) ? s : "settings",
      os: params().get("os") || guessOs(),
      settings: clone(DEMO_SETTINGS),
      strip: { supported: true, layer: "on_top", w: 1512, h: 112, scale: 2 },
      test: { freeze: false, fixed_rect: false },
      world_inputs: clone(DEMO_WORLD_INPUTS),
    };
  }
  return bootCache;
}

// ---------------------------------------------------------------------------------------------
// Low-level access. Nothing here throws.
// ---------------------------------------------------------------------------------------------

function errorText(e) {
  if (typeof e === "string") return e;
  if (e && typeof e.message === "string") return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return "unknown error";
  }
}

/** Resolves { ok: true, value } or { ok: false, error, noCore? }. Never rejects. */
async function call(cmd, args) {
  const t = tauri();
  if (!hasCore()) return { ok: false, error: "no core connected", noCore: true };
  try {
    return { ok: true, value: await t.core.invoke(cmd, args) };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

const localHandlers = new Map();

function listen(name, cb) {
  let cancelled = false;
  let unlisten = null;
  const run = (payload) => {
    if (cancelled) return;
    try {
      cb(payload);
    } catch (e) {
      console.error("busyholm: handler for " + name + " failed", e);
    }
  };
  if (hasCore()) {
    try {
      Promise.resolve(tauri().event.listen(name, (ev) => run(ev ? ev.payload : undefined))).then(
        (fn) => {
          unlisten = typeof fn === "function" ? fn : null;
          if (cancelled && unlisten) unlisten();
        },
        () => {},
      );
    } catch {
      /* ignore */
    }
  } else {
    if (!localHandlers.has(name)) localHandlers.set(name, new Set());
    localHandlers.get(name).add(run);
    unlisten = () => localHandlers.get(name).delete(run);
  }
  return () => {
    cancelled = true;
    if (unlisten) unlisten();
    unlisten = null;
  };
}

function emitLocal(name, payload) {
  const set = localHandlers.get(name);
  if (set) for (const fn of [...set]) fn(clone(payload));
}

// ---------------------------------------------------------------------------------------------
// Events (core to page)
// ---------------------------------------------------------------------------------------------

export const onSnapshot = (cb) => listen("bh:snapshot", cb);
export const onMoment = (cb) => listen("bh:moment", cb);
export const onSettings = (cb) => listen("bh:settings", cb);
export const onWorldInputs = (cb) => listen("bh:world-inputs", cb);
export const onConnectStatus = (cb) => listen("bh:connect-status", cb);

// ---------------------------------------------------------------------------------------------
// Commands (page to core)
// ---------------------------------------------------------------------------------------------

export async function getSnapshot() {
  const r = await call("bh_get_snapshot");
  if (r.noCore) return clone(demoScenario());
  return r.ok && r.value && typeof r.value === "object" ? r.value : null;
}

let localSettings = null;

export async function getSettings() {
  const r = await call("bh_get_settings");
  if (r.noCore) return clone(localSettings || boot().settings);
  if (r.ok && r.value && typeof r.value === "object") return r.value;
  return clone(boot().settings);
}

/**
 * Save the WHOLE Settings v1 object (never a partial patch, so the core writes it atomically or
 * not at all). Resolves { ok: true, settings } or { ok: false, error }.
 */
export async function setSettings(settings) {
  const r = await call("bh_set_settings", { settings });
  if (r.noCore) {
    localSettings = clone(settings);
    emitLocal("bh:settings", localSettings);
    return { ok: true, settings: clone(localSettings) };
  }
  if (!r.ok) return { ok: false, error: r.error };
  if (typeof r.value === "string") return { ok: false, error: r.value };
  return { ok: true, settings: r.value && typeof r.value === "object" ? r.value : settings };
}

export async function getWorldInputs() {
  const r = await call("bh_get_world_inputs");
  if (r.noCore) return clone(boot().world_inputs || null);
  if (r.ok) return r.value || null;
  return boot().world_inputs || null;
}

export async function open(surface) {
  if (!OPEN_SURFACES.includes(surface)) return;
  await call("bh_open", { surface });
}

export async function close() {
  const r = await call("bh_close");
  if (r.noCore && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("bh-demo-close"));
}

// Hook connections (WP-11 commands, implemented in app/src-tauri/src/connect.rs).
// Parts: "claude_hooks", "claude_statusline", "codex_hooks", "opencode_plugin".

let demoStatus = null;
let demoToken = 0;
let demoPending = null;

function demoPreview(parts, disconnect) {
  demoToken += 1;
  demoPending = { token: demoToken, parts: parts.slice(), disconnect };
  const st = demoStatus || (demoStatus = demoInitialStatus());
  const chosen = st.parts.filter((p) => (parts.length ? parts.includes(p.part) : p.connected));
  const files = [];
  for (const p of chosen) {
    if (files.some((f) => f.path === p.path)) continue;
    files.push({
      path: p.path,
      diff: disconnect
        ? "@@ demo @@\n-    { \"type\": \"command\", \"command\": \"busyholm-hook hook --agent ...\" }\n"
        : "@@ demo @@\n+    { \"type\": \"command\", \"command\": \"busyholm-hook hook --agent ...\" }\n",
      note: null,
      creates: false,
      deletes: false,
    });
  }
  return { token: demoToken, files, notes: [], noop: files.length === 0 };
}

function demoInitialStatus() {
  const st = clone(DEMO_CONNECT_STATUS);
  // A first-run demo (?onboarded=0) starts with nothing connected.
  if (params().get("onboarded") === "0") {
    for (const p of st.parts) p.connected = p.pending_review = false;
    st.any_connected = false;
  }
  return st;
}

export async function connectStatus() {
  const r = await call("bh_connect_status");
  if (r.noCore) return clone(demoStatus || (demoStatus = demoInitialStatus()));
  return r.ok ? r.value : { error: r.error };
}

/** { ok: true, preview } or { ok: false, error }. Writes nothing. */
export async function connectPreview(parts) {
  const r = await call("bh_connect_preview", { parts });
  if (r.noCore) return { ok: true, preview: demoPreview(parts, false) };
  return r.ok ? { ok: true, preview: r.value } : { ok: false, error: r.error };
}

export async function disconnectPreview(parts) {
  const r = await call("bh_disconnect_preview", { parts: parts || [] });
  if (r.noCore) return { ok: true, preview: demoPreview(parts || [], true) };
  return r.ok ? { ok: true, preview: r.value } : { ok: false, error: r.error };
}

/** Apply exactly the previewed plan. { ok: true, status } or { ok: false, error }. */
export async function connectApply(token) {
  const r = await call("bh_connect_apply", { token });
  if (r.noCore) {
    if (!demoPending || demoPending.token !== token) return { ok: false, error: "That preview is out of date. Preview again." };
    const st = demoStatus || (demoStatus = demoInitialStatus());
    for (const p of st.parts) {
      const hit = demoPending.parts.length === 0 || demoPending.parts.includes(p.part);
      if (!hit) continue;
      p.connected = !demoPending.disconnect;
      p.pending_review = !demoPending.disconnect && p.part === "codex_hooks";
    }
    st.any_connected = st.parts.some((p) => p.connected);
    demoStatus = st;
    demoPending = null;
    emitLocal("bh:connect-status", st);
    return { ok: true, status: clone(st) };
  }
  return r.ok ? { ok: true, status: r.value } : { ok: false, error: r.error };
}

/** Disconnect all Busyholm hooks and status lines first, then delete the app data folder. */
export async function deleteEverything() {
  const r = await call("bh_delete_everything");
  if (r.noCore) {
    const st = demoStatus || (demoStatus = demoInitialStatus());
    for (const p of st.parts) {
      p.connected = false;
      p.pending_review = false;
    }
    st.any_connected = false;
    demoStatus = st;
    demoPending = null;
    localSettings = clone(DEMO_SETTINGS);
    emitLocal("bh:settings", localSettings);
    emitLocal("bh:connect-status", st);
    return { ok: true, status: clone(st) };
  }
  return r.ok ? { ok: true, status: r.value } : { ok: false, error: r.error };
}

let demoOnboarded = null;

/** First-run state: { done: bool }. */
export async function onboardingState() {
  const r = await call("bh_onboarding", { action: "get" });
  if (r.noCore) return { done: demoOnboarded ?? params().get("onboarded") !== "0" };
  return r.ok && r.value ? r.value : { done: true };
}

export async function onboardingDone() {
  const r = await call("bh_onboarding", { action: "done" });
  if (r.noCore) demoOnboarded = true;
  return r.ok || r.noCore;
}

/** Load the bundled third-party notices text from the Tauri core command. */
export async function thirdPartyNotices() {
  const r = await call("bh_third_party_notices");
  if (r.ok && typeof r.value === "string" && r.value.trim()) return r.value;
  return "Third-party notices are bundled in Busyholm.app/Contents/Resources/THIRD-PARTY-NOTICES.txt.";
}

/** Test and diagnostics hook: replay a payload as if the core had sent it (browser-only mode). */
export function injectLocal(name, payload) {
  emitLocal(name, payload);
}
