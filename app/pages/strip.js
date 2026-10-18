// Busyholm placeholder strip (WP-02). Draws one resident per agent along a ground line,
// publishes HitRects for every interactive object, and honours the page contract in
// app/README.md. The real world renderer (WP-10) replaces this page in dist/.
import * as bridge from "./bridge.js";
import { sortedAgents, stateLabel, toolLabel } from "./shared.js";

const boot = bridge.boot();
const FREEZE = !!(boot.test && boot.test.freeze);
const FIXED_RECT = !!(boot.test && boot.test.fixed_rect);

const RES_W = 22;
const RES_H = 26;
const SLOT = 36;
const PAD_X = 20;
const GROUND_OFFSET = 10; // ground line sits this far above the bottom edge
const SPRITE = 18;
const SPRITE_TOP_ABOVE_BOTTOM = 30;
const CARD_W = 120;
const CARD_H = 30;
const FRAME_MS = Math.round(1000 / 12);
const MIN_SEND_GAP_MS = 17; // never more than one HitRects message per frame (60 Hz)

const STATE_COLOR = {
  working: "#3b82f6",
  needs_you: "#f59e0b",
  your_turn: "#22c55e",
  error: "#ef4444",
  limited: "#9ca3af",
  starting: "#7a8394",
  idle: "#7a8394",
  unknown: "#7a8394",
};

const canvas = document.getElementById("scenery");
const ctx = canvas.getContext("2d");
const spriteEl = document.getElementById("test-sprite");
const cardEl = document.getElementById("card");
const cardTitle = document.getElementById("card-title");
const cardState = document.getElementById("card-state");
const noCoreEl = document.getElementById("nocore");

let snapshot = null;
let W = window.innerWidth;
let H = window.innerHeight;
let dpr = window.devicePixelRatio || 1;
let visible = true;
let faded = false;
let dirtyWhileHidden = false;
let loopTimer = null;
let openCardAgent = null; // agent id whose card is open
let residents = []; // { id, tool, ordinal, state, x, y, i }
let rects = []; // the full interactive set, in CSS px
let spriteRect = null;
let cardRect = null;
const frameTimes = [];

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function layout() {
  const agents = sortedAgents(snapshot);
  const n = agents.length;
  const spacing = n > 1 ? Math.max(4, Math.min(SLOT, (W - 2 * PAD_X - RES_W) / (n - 1))) : SLOT;
  const baseY = H - GROUND_OFFSET - RES_H;
  residents = agents.map((a, i) => ({
    id: a.id,
    tool: a.tool,
    ordinal: a.ordinal,
    state: a.state,
    x: PAD_X + i * spacing,
    y: baseY,
    i,
  }));

  // A card whose agent is gone closes by itself.
  if (openCardAgent && !residents.some((r) => r.id === openCardAgent)) {
    openCardAgent = null;
    bridge.pageEvent("card_close");
  }

  const list = residents.map((r) => ({
    x: r.x - 2,
    y: r.y - 10,
    w: RES_W + 4,
    h: RES_H + 10,
    kind: "resident",
    agent: r.id,
  }));

  spriteRect = null;
  if (FIXED_RECT) {
    spriteRect = { x: (W - SPRITE) / 2, y: H - SPRITE_TOP_ABOVE_BOTTOM, w: SPRITE, h: SPRITE, kind: "other" };
    list.push(spriteRect);
  }

  cardRect = null;
  const owner = openCardAgent ? residents.find((r) => r.id === openCardAgent) : null;
  if (owner) {
    const cw = Math.min(CARD_W, W);
    cardRect = {
      x: Math.min(Math.max(0, owner.x + RES_W / 2 - cw / 2), Math.max(0, W - cw)),
      y: Math.max(0, owner.y - 4 - CARD_H),
      w: cw,
      h: CARD_H,
      kind: "card",
      agent: owner.id,
    };
    list.push(cardRect);
  }

  rects = list;
  syncDom(owner);
  scheduleRects();
}

function syncDom(owner) {
  if (spriteRect) {
    spriteEl.hidden = false;
    spriteEl.style.left = spriteRect.x + "px";
    spriteEl.style.top = spriteRect.y + "px";
  } else {
    spriteEl.hidden = true;
  }
  if (cardRect && owner) {
    cardEl.hidden = false;
    cardEl.style.left = cardRect.x + "px";
    cardEl.style.top = cardRect.y + "px";
    cardEl.style.width = cardRect.w + "px";
    cardTitle.textContent = toolLabel(owner.tool) + " #" + owner.ordinal;
    cardState.textContent = stateLabel(owner.state);
  } else {
    cardEl.hidden = true;
  }
}

function fit() {
  W = window.innerWidth;
  H = window.innerHeight;
  dpr = window.devicePixelRatio || 1;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  canvas.width = Math.max(1, Math.round(W * dpr));
  canvas.height = Math.max(1, Math.round(H * dpr));
  layout();
  requestRender();
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function roundRectPath(x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawResident(r, now) {
  const bob = FREEZE ? 0 : (Math.sin(now / 380 + r.i * 0.9) * 0.5 + 0.5) * 2.5;
  const x = r.x;
  const y = r.y - bob;
  ctx.save();
  ctx.globalAlpha = r.state === "idle" || r.state === "unknown" || r.state === "starting" ? 0.8 : 1;
  roundRectPath(x, y, RES_W, RES_H, 7);
  ctx.fillStyle = STATE_COLOR[r.state] || STATE_COLOR.unknown;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
  ctx.stroke();
  // eyes
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x + 6, y + 8, 4, 4);
  ctx.fillRect(x + 12, y + 8, 4, 4);
  ctx.fillStyle = "#111827";
  ctx.fillRect(x + 7.5, y + 9.5, 2, 2);
  ctx.fillRect(x + 13.5, y + 9.5, 2, 2);
  if (r.state === "needs_you") {
    // small flag on a pole
    ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + RES_W / 2, y);
    ctx.lineTo(x + RES_W / 2, y - 9);
    ctx.stroke();
    ctx.fillStyle = "#dc2626";
    ctx.beginPath();
    ctx.moveTo(x + RES_W / 2, y - 9);
    ctx.lineTo(x + RES_W / 2 + 8, y - 6);
    ctx.lineTo(x + RES_W / 2, y - 3);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function renderFrame() {
  const now = performance.now();
  frameTimes.push(now);
  if (frameTimes.length > 120) frameTimes.shift();
  dirtyWhileHidden = false;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  // ground line: a dark line with a light edge so it reads on any wallpaper
  const gy = H - GROUND_OFFSET;
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(8, gy, Math.max(0, W - 16), 1.5);
  ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
  ctx.fillRect(8, gy + 1.5, Math.max(0, W - 16), 1);
  for (const r of residents) drawResident(r, Date.now());
}

/** Draw now when the loop is not running (frozen or on a change); the loop covers the rest. */
function requestRender() {
  if (!visible) {
    dirtyWhileHidden = true;
    return;
  }
  renderFrame();
}

function startLoop() {
  if (loopTimer !== null || FREEZE || !visible) return;
  const tick = () => {
    loopTimer = null;
    if (!visible || FREEZE) return;
    renderFrame();
    loopTimer = setTimeout(tick, FRAME_MS);
  };
  loopTimer = setTimeout(tick, FRAME_MS);
}

function stopLoop() {
  if (loopTimer !== null) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
}

function currentFps() {
  const cutoff = performance.now() - 1000;
  let n = 0;
  for (let i = frameTimes.length - 1; i >= 0 && frameTimes[i] >= cutoff; i--) n++;
  return n;
}

// ---------------------------------------------------------------------------
// HitRects publishing: only when the set changed, never faster than one per frame
// ---------------------------------------------------------------------------

let sentOnce = false;
let lastKey = "";
let lastSendAt = 0;
let sendTimer = null;
let lastSendError = null;

function rectsKey() {
  return [W, H, dpr, JSON.stringify(rects)].join("|");
}

function scheduleRects() {
  if (sendTimer !== null) return;
  const wait = Math.max(0, MIN_SEND_GAP_MS - (performance.now() - lastSendAt));
  sendTimer = setTimeout(flushRects, wait);
}

function flushRects() {
  sendTimer = null;
  const key = rectsKey();
  if (sentOnce && key === lastKey) return;
  sentOnce = true;
  lastKey = key;
  lastSendAt = performance.now();
  bridge.sendHitRects(rects).then(
    (err) => {
      lastSendError = err || null;
      if (err) console.warn("hit rects rejected:", err);
    },
    () => {},
  );
}

// ---------------------------------------------------------------------------
// Input: the core only makes the window clickable over hit rects
// ---------------------------------------------------------------------------

function inside(r, x, y) {
  return !!r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

function closeCard() {
  if (!openCardAgent) return;
  openCardAgent = null;
  layout();
  bridge.pageEvent("card_close");
}

document.addEventListener("mousedown", (e) => {
  const x = e.clientX;
  const y = e.clientY;
  if (inside(cardRect, x, y)) {
    closeCard();
    return;
  }
  // Topmost resident wins (later ones are drawn later).
  let hit = null;
  for (const res of residents) {
    if (inside({ x: res.x - 2, y: res.y - 10, w: RES_W + 4, h: RES_H + 10 }, x, y)) hit = res;
  }
  if (!hit) return;
  bridge.pageEvent("resident_click");
  if (openCardAgent === hit.id) {
    closeCard();
    return;
  }
  const hadCard = !!openCardAgent;
  openCardAgent = hit.id;
  layout();
  if (hadCard) bridge.pageEvent("card_close");
  bridge.pageEvent("card_open");
});

// ---------------------------------------------------------------------------
// Core events
// ---------------------------------------------------------------------------

function applySnapshot(s) {
  // Drop anything malformed and keep the last good state.
  if (!s || typeof s !== "object" || !Array.isArray(s.agents)) return;
  snapshot = s;
  layout();
  requestRender();
}

bridge.onSnapshot(applySnapshot);

bridge.onStripFade((p) => {
  faded = !!(p && p.on);
  canvas.style.opacity = faded ? "0.2" : "1";
});

bridge.onVisibility((p) => {
  const next = !!(p && p.visible);
  if (next === visible) return;
  visible = next;
  if (visible) {
    renderFrame();
    startLoop();
  } else {
    stopLoop();
  }
  bridge.visibilityAck(visible);
});

bridge.onStripGeometry(() => {
  fit();
  setTimeout(fit, 120); // the OS window may settle a moment after the event
});

window.addEventListener("resize", fit);
(function watchScale() {
  const mq = window.matchMedia("(resolution: " + (window.devicePixelRatio || 1) + "dppx)");
  const h = () => {
    fit();
    watchScale();
  };
  if (mq.addEventListener) mq.addEventListener("change", h, { once: true });
})();

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

window.__stripDebug = () => ({
  rects: rects.map((r) => Object.assign({}, r)),
  fps: currentFps(),
  visible,
  faded,
});

if (!bridge.hasCore()) noCoreEl.hidden = false;
fit();
startLoop();
bridge.getSnapshot().then((s) => {
  // An event may already have delivered something newer.
  if (!snapshot || (s && typeof s.t === "number" && s.t >= snapshot.t)) applySnapshot(s);
});
