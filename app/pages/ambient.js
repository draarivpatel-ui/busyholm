// Busyholm placeholder ambient scene (WP-02): a slow drifting gradient and a corner card
// with counts only. Any key, click, or mouse move over 8 px exits (SPEC 6.4).
import * as bridge from "./bridge.js";
import { needsYouCount } from "./shared.js";

const boot = bridge.boot();
const FREEZE = !!(boot.test && boot.test.freeze);
const FRAME_MS = 33; // 30 fps cap
const MOVE_EXIT_PX = 8;

const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d");
const nAgents = document.getElementById("n-agents");
const lAgents = document.getElementById("l-agents");
const nNeed = document.getElementById("n-need");

let reduceSetting = !!(boot.settings && boot.settings.other && boot.settings.other.reduced_motion === "always");
function osReduced() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
let reduced = reduceSetting || osReduced();
bridge.onSettings((s) => {
  if (s && s.other) {
    reduceSetting = s.other.reduced_motion === "always";
    reduced = reduceSetting || osReduced();
  }
});

function fit() {
  // Half resolution: the gradient is smooth, CSS scales it up.
  canvas.width = Math.max(2, Math.round(window.innerWidth / 2));
  canvas.height = Math.max(2, Math.round(window.innerHeight / 2));
  draw(performance.now());
}

const BLOBS = [
  { color: "56, 90, 200", fx: 0.00011, fy: 0.00007, px: 0.0, py: 1.3, r: 0.75 },
  { color: "120, 60, 170", fx: 0.00008, fy: 0.00013, px: 2.1, py: 0.4, r: 0.65 },
  { color: "30, 130, 140", fx: 0.00013, fy: 0.00009, px: 4.2, py: 3.0, r: 0.6 },
];

function draw(now) {
  const w = canvas.width;
  const h = canvas.height;
  const speed = reduced ? 0.2 : 1;
  const t = now * speed;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#05070d";
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "lighter";
  for (const b of BLOBS) {
    const cx = w * (0.5 + 0.35 * Math.sin(t * b.fx * 6.283 + b.px));
    const cy = h * (0.5 + 0.35 * Math.sin(t * b.fy * 6.283 + b.py));
    const r = Math.max(w, h) * b.r;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, "rgba(" + b.color + ", 0.42)");
    g.addColorStop(1, "rgba(" + b.color + ", 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.globalCompositeOperation = "source-over";
}

let timer = null;
function loop() {
  timer = null;
  draw(performance.now());
  if (document.visibilityState !== "hidden") timer = setTimeout(loop, FRAME_MS);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  } else if (!FREEZE && timer === null) {
    loop();
  }
});

// ---------------------------------------------------------------------------
// Counts card (counts only, nothing else about the agents)
// ---------------------------------------------------------------------------

let snapshot = null;
function applySnapshot(s) {
  if (!s || typeof s !== "object" || !Array.isArray(s.agents)) return;
  if (snapshot && typeof s.t === "number" && s.t < snapshot.t) return;
  snapshot = s;
  nAgents.textContent = String(s.agents.length);
  lAgents.textContent = s.agents.length === 1 ? "agent" : "agents";
  nNeed.textContent = String(needsYouCount(s));
}
bridge.onSnapshot(applySnapshot);
bridge.getSnapshot().then(applySnapshot);

// ---------------------------------------------------------------------------
// Exit on input
// ---------------------------------------------------------------------------

let exiting = false;
let first = null;
function exitAmbient() {
  if (exiting) return;
  exiting = true;
  bridge.pageEvent("ambient_input").then(() => bridge.ambientExit());
}
window.addEventListener("keydown", exitAmbient, true);
window.addEventListener("mousedown", exitAmbient, true);
window.addEventListener("mousemove", (e) => {
  if (!first) {
    first = { x: e.clientX, y: e.clientY };
    return;
  }
  if (Math.hypot(e.clientX - first.x, e.clientY - first.y) > MOVE_EXIT_PX) exitAmbient();
}, true);

window.addEventListener("resize", fit);
if (!bridge.hasCore()) document.getElementById("nocore").hidden = false;
fit();
if (!FREEZE) loop();
