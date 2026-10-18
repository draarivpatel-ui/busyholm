// Busyholm page bridge (WP-02). Wraps the core contract described in app/README.md:
// boot data, events (bh:*), and commands (bh_*). Plain ES module, no dependencies.
//
// Works without Tauri too: with no core connected every command is a harmless no-op,
// getSnapshot() returns a built-in sample, and events can be injected for tests with
//   window.dispatchEvent(new CustomEvent("bh:snapshot", { detail: snapshot }))

const HEX32 = /^[0-9a-f]{32}$/;
const RECT_KINDS = ["resident", "building", "bell", "card", "ui", "other"];
const PAGE_EVENTS = ["resident_click", "card_open", "card_close", "ambient_input"];
const SURFACES = ["strip", "ambient", "popover", "settings", "details"];
const OPEN_SURFACES = ["details", "settings", "popover", "ambient"];
const MAX_RECTS = 64;
const MAX_COORD = 16384;

// ---------------------------------------------------------------------------
// Built-in data for browser-only mode (shapes match Snapshot v2 and Settings v1).
// ---------------------------------------------------------------------------

const ROOT_CLAUDE = "5c96dbc2661405adf9ab0e86e0eef50b";
const ROOT_CODEX = "5e1805de3c344b54fb9b24e1e1b20045";
const ACCOUNT = "2f7339c66415277e5b58670b67b979a9";
const T0 = 1791806400000;

function sampleAgent(id, tool, host, ordinal, root, state, sinceOffset, extra) {
  return Object.assign(
    {
      id,
      tool,
      host,
      ordinal,
      parent: null,
      root_id: root,
      account_id: ACCOUNT,
      session_id: null,
      turn_id: null,
      request_id: null,
      state,
      confidence: "exact",
      since: T0 - sinceOffset,
      started_at: T0 - 3600000,
    },
    extra || {},
  );
}

export const SAMPLE_SNAPSHOT = {
  schema_version: 2,
  t: T0,
  demo: true,
  agents: [
    sampleAgent("e57dba886b1ea265f5dc0d5e42642641", "claude", "cli", 1, ROOT_CLAUDE, "working", 120000, {
      activity: "shell",
    }),
    sampleAgent("a1c0ffee00000000000000000000b002", "claude", "desktop", 2, ROOT_CLAUDE, "needs_you", 30000, {
      reason: "permission",
    }),
    sampleAgent("b2c0ffee00000000000000000000c003", "codex", "cli", 1, ROOT_CODEX, "your_turn", 45000),
    sampleAgent("c3c0ffee00000000000000000000d004", "codex", "cli", 2, ROOT_CODEX, "limited", 600000, {
      limited_until: T0 + 3600000,
    }),
    sampleAgent("d4c0ffee00000000000000000000e005", "claude", "vscode", 3, ROOT_CLAUDE, "idle", 900000),
  ],
  tools: [
    {
      tool: "claude",
      root_id: ROOT_CLAUDE,
      presence: "present",
      hooks: "installed",
      coverage: "verified",
      coverage_reason: null,
    },
    {
      tool: "codex",
      root_id: ROOT_CODEX,
      presence: "present",
      hooks: "installed",
      coverage: "verified",
      coverage_reason: null,
    },
  ],
  limits: [
    {
      provider: "claude",
      window: "5h",
      account_id: ACCOUNT,
      root_id: ROOT_CLAUDE,
      used_pct: 42.5,
      resets_at: T0 + 7200000,
      observed_at: T0 - 60000,
      stale: false,
    },
    {
      provider: "codex",
      window: "weekly",
      account_id: ACCOUNT,
      root_id: ROOT_CODEX,
      used_pct: 7,
      resets_at: T0 + 360000000,
      observed_at: T0 - 60000,
      stale: false,
    },
  ],
  attention: { needs_you: 1, oldest_since: T0 - 30000 },
};

export const DEFAULT_SETTINGS = {
  schema_version: 1,
  strip: {
    enabled: true,
    display: { mode: "auto" },
    height: 112,
    layer_mode: "on_top",
    hover_fade: true,
    show_over_fullscreen: false,
  },
  sky: { mode: "usage_and_clock", hemisphere: "north" },
  sound: { bell: true, volume: 0.7, quiet_hours: null },
  notifications: { needs_you: true, renotify: true, long_turn: true, errors: true },
  ambient: { idle_minutes: null, shortcut: null },
  agents: { species: {} },
  privacy: { project_names: false, history_backfill: false },
  other: { launch_at_login: false, reduced_motion: "follow_os" },
  updates: { check: false },
};

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function guessOs() {
  const p = String((typeof navigator !== "undefined" && (navigator.platform || navigator.userAgent)) || "");
  if (/mac/i.test(p)) return "macos";
  if (/win/i.test(p)) return "windows";
  return "linux";
}

function guessSurface() {
  const m = String((typeof location !== "undefined" && location.pathname) || "").match(/([a-z]+)\.html?$/i);
  const s = m ? m[1].toLowerCase() : "";
  return SURFACES.includes(s) ? s : "strip";
}

let bootCache = null;

/** The boot object the core sets before page scripts run, or a sensible default. */
export function boot() {
  if (typeof window !== "undefined" && window.__BUSYHOLM_BOOT__) return window.__BUSYHOLM_BOOT__;
  if (!bootCache) {
    bootCache = {
      surface: guessSurface(),
      os: guessOs(),
      settings: clone(DEFAULT_SETTINGS),
      strip: null,
      test: { freeze: false, fixed_rect: false },
    };
  }
  return bootCache;
}

// ---------------------------------------------------------------------------
// Core access. Nothing here ever throws.
// ---------------------------------------------------------------------------

function tauri() {
  return typeof window !== "undefined" ? window.__TAURI__ : undefined;
}

/** True when a Tauri core is reachable (invoke and listen both exist). */
export function hasCore() {
  const t = tauri();
  return !!(t && t.core && typeof t.core.invoke === "function" && t.event && typeof t.event.listen === "function");
}

/** Invoke a command. Resolves { ok, value } or { ok: false, error: string }; never rejects. */
async function call(cmd, args) {
  const t = tauri();
  if (!t || !t.core || typeof t.core.invoke !== "function") {
    return { ok: false, error: "no core connected", noCore: true };
  }
  try {
    const value = await t.core.invoke(cmd, args);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

function errorText(e) {
  if (typeof e === "string") return e;
  if (e && typeof e.message === "string") return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return "unknown error";
  }
}

/** Listen for a core event. Returns an unlisten function (safe to call at any time). */
function listen(name, cb) {
  if (typeof cb !== "function") return () => {};
  let cancelled = false;
  let unlisten = null;
  if (hasCore()) {
    try {
      const p = tauri().event.listen(name, (ev) => {
        if (!cancelled) safeRun(cb, ev ? ev.payload : undefined);
      });
      Promise.resolve(p).then(
        (fn) => {
          unlisten = typeof fn === "function" ? fn : null;
          if (cancelled && unlisten) unlisten();
        },
        () => {},
      );
    } catch {
      /* ignore */
    }
  } else if (typeof window !== "undefined") {
    // Browser-only mode: tests can inject events as CustomEvents on window.
    const h = (ev) => {
      if (!cancelled) safeRun(cb, ev.detail);
    };
    window.addEventListener(name, h);
    unlisten = () => window.removeEventListener(name, h);
  }
  return () => {
    cancelled = true;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}

function safeRun(cb, payload) {
  try {
    cb(payload);
  } catch (e) {
    if (typeof console !== "undefined") console.error("busyholm page handler failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Events (core to page)
// ---------------------------------------------------------------------------

export const onSnapshot = (cb) => listen("bh:snapshot", cb);
export const onMoment = (cb) => listen("bh:moment", cb);
export const onSettings = (cb) => listen("bh:settings", cb);
export const onStripFade = (cb) => listen("bh:strip-fade", cb);
export const onStripGeometry = (cb) => listen("bh:strip-geometry", cb);

/** bh:visibility. In browser-only mode the page's own visibility drives it as well. */
export function onVisibility(cb) {
  const off = listen("bh:visibility", cb);
  if (hasCore() || typeof document === "undefined") return off;
  const h = () => {
    const visible = document.visibilityState !== "hidden";
    safeRun(cb, { visible, reason: visible ? "shown" : "hidden" });
  };
  document.addEventListener("visibilitychange", h);
  return () => {
    off();
    document.removeEventListener("visibilitychange", h);
  };
}

// ---------------------------------------------------------------------------
// Commands (page to core)
// ---------------------------------------------------------------------------

/** Latest snapshot from the core, or null. Browser-only mode returns SAMPLE_SNAPSHOT. */
export async function getSnapshot() {
  const r = await call("bh_get_snapshot");
  if (r.noCore) return clone(SAMPLE_SNAPSHOT);
  return r.ok && r.value ? r.value : null;
}

/**
 * Build a valid HitRects v1 message. Rects are clamped inside the viewport, empty or
 * non-finite ones are dropped, at most 64 are kept. `viewport` is optional ({w,h}); when
 * omitted (the normal case) the current window.innerWidth/innerHeight are used.
 */
export function buildHitRects(rects, viewport) {
  const clampNum = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const vwRaw = viewport && Number.isFinite(viewport.w) && viewport.w > 0 ? viewport.w : window.innerWidth;
  const vhRaw = viewport && Number.isFinite(viewport.h) && viewport.h > 0 ? viewport.h : window.innerHeight;
  const vw = clampNum(Number.isFinite(vwRaw) && vwRaw > 0 ? vwRaw : 1, 0.01, MAX_COORD);
  const vh = clampNum(Number.isFinite(vhRaw) && vhRaw > 0 ? vhRaw : 1, 0.01, MAX_COORD);
  const out = [];
  for (const r of Array.isArray(rects) ? rects : []) {
    if (out.length >= MAX_RECTS) break;
    if (!r || ![r.x, r.y, r.w, r.h].every(Number.isFinite)) continue;
    const x0 = clampNum(r.x, 0, vw);
    const y0 = clampNum(r.y, 0, vh);
    const x1 = clampNum(r.x + r.w, 0, vw);
    const y1 = clampNum(r.y + r.h, 0, vh);
    const w = x1 - x0;
    const h = y1 - y0;
    if (!(w > 0) || !(h > 0)) continue;
    const item = { x: round2(x0), y: round2(y0), w: round2(w), h: round2(h), kind: RECT_KINDS.includes(r.kind) ? r.kind : "other" };
    if (item.w <= 0 || item.h <= 0) continue;
    if (typeof r.agent === "string" && HEX32.test(r.agent)) item.agent = r.agent;
    out.push(item);
  }
  const dpr = Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1;
  return {
    schema_version: 1,
    t: Math.trunc(Date.now()),
    surface: "strip",
    viewport: { w: round2(vw), h: round2(vh) },
    scale: clampNum(dpr, 0.5, 8),
    rects: out,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** The last HitRects message built (also in browser-only mode), for tests. */
export let lastHitRectsMessage = null;

/** Send a full replacement HitRects set. Resolves to null on success or an error string. */
export async function sendHitRects(rects, viewport) {
  const msg = buildHitRects(rects, viewport);
  lastHitRectsMessage = msg;
  const r = await call("bh_hit_rects", { msg });
  if (r.noCore) return null;
  if (!r.ok) return r.error;
  return typeof r.value === "string" ? r.value : null;
}

export async function visibilityAck(visible) {
  await call("bh_visibility_ack", { visible: !!visible });
}

export async function ambientExit() {
  await call("bh_ambient_exit");
}

/** Settings v1 from the core (boot settings or defaults in browser-only mode). */
export async function getSettings() {
  const r = await call("bh_get_settings");
  if (r.ok && r.value && typeof r.value === "object") return r.value;
  return clone(boot().settings || DEFAULT_SETTINGS);
}

let localSettings = null;

/**
 * Save settings. Resolves { ok: true, settings } or { ok: false, error: string }.
 * (The core returns Settings v1 or an error string; this normalises both.)
 */
export async function setSettings(settings) {
  const r = await call("bh_set_settings", { settings });
  if (r.noCore) {
    localSettings = clone(settings);
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("bh:settings", { detail: clone(localSettings) }));
    return { ok: true, settings: clone(localSettings) };
  }
  if (!r.ok) return { ok: false, error: r.error };
  if (typeof r.value === "string") return { ok: false, error: r.value };
  return { ok: true, settings: r.value && typeof r.value === "object" ? r.value : settings };
}

export async function open(surface) {
  if (!OPEN_SURFACES.includes(surface)) return;
  await call("bh_open", { surface });
}

export async function close() {
  await call("bh_close");
}

/** Tell the core about a page-level happening (used by acceptance tests and diagnostics). */
export async function pageEvent(name) {
  if (!PAGE_EVENTS.includes(name)) return;
  await call("bh_page_event", { name });
}
