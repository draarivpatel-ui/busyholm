"use strict";
(() => {
  // src/tokens.ts
  var PAL = {
    // SPEC: paper and ink
    ink: "#2B2A33",
    cream: "#F7EEDC",
    // SPEC: land
    farHills: "#A7B5A0",
    midHills: "#7E9C76",
    meadow: "#5F8758",
    bank: "#3E6646",
    river: "#6FA6B6",
    riverLight: "#CFE5E6",
    // SPEC: buildings
    wall: "#F1E4CC",
    roof: "#C2654A",
    wood: "#94673F",
    stone: "#B5AEA2",
    lampGlow: "#FFC86B",
    // SPEC: state accents
    alertFlag: "#FFB000",
    errorCoral: "#D9534A",
    worrySlate: "#5B6478",
    yourTurnSage: "#8FBFA6",
    // SPEC: species
    beaver: "#8B5A3C",
    otter: "#5E4B3E",
    otterFace: "#E9D6B6",
    hare: "#CDB89A",
    frog: "#6FA04F",
    mole: "#4A4453",
    heron: "#9AA9B8",
    hedgehog: "#7A6650",
    // SPEC: instance scarves
    scarf0: "#E07A5F",
    scarf1: "#3D84A8",
    scarf2: "#F2CC8F",
    scarf3: "#81B29A",
    scarf4: "#B56576",
    scarf5: "#6D597A",
    // SPEC: seasons
    leafAmber: "#D98C3F",
    leafRust: "#B5523B",
    snow: "#F4F7FA",
    // SPEC: sky keyframes (top / horizon)
    skyDawnTop: "#F2C4A6",
    skyDawnHorizon: "#FBE6C8",
    skyDayTop: "#8EC3E0",
    skyDayHorizon: "#E2F0EA",
    skyGoldenTop: "#EFAE78",
    skyGoldenHorizon: "#FCE0A8",
    skyDuskTop: "#5F4E86",
    skyDuskHorizon: "#E39275",
    skyNightTop: "#1B2140",
    skyNightHorizon: "#363C63",
    skyRainTop: "#8C97A6",
    skyRainHorizon: "#C9CFD4",
    // WP-09: shades of the SPEC building and land colours (paper of the same family, one step darker or lighter)
    wallShade: "#E0CDAE",
    roofDeep: "#9E4E3B",
    roofThatch: "#C9A15E",
    roofThatchDeep: "#A98345",
    roofSlate: "#6F7C8A",
    roofSlateDeep: "#56616D",
    woodDark: "#6B4A2F",
    woodLight: "#B88B5C",
    stoneDark: "#8E877C",
    stoneLight: "#D3CDC2",
    windowDark: "#3A4157",
    soil: "#7A5A44",
    soilDeep: "#56402F",
    conifer: "#2F5640",
    coniferLight: "#41704F",
    reed: "#4E6E42",
    reedTip: "#A9824F",
    meadowLight: "#76A06A",
    riverDeep: "#4E8496",
    mountain: "#8E9DB0",
    mountainSnow: "#E9EEF2",
    flame: "#F08A3C",
    ember: "#C8462E",
    speciesHighlight: "#FFF8EA",
    // WP-09: multiply light per sky keyframe (how lit paper is tinted at that time of day)
    lightDawn: "#F7DCCB",
    lightDay: "#FFFCF4",
    lightGolden: "#FFD6A3",
    lightDusk: "#B7A2C4",
    lightNight: "#53608F",
    lightRain: "#C3C9D1",
    // WP-09: technical white for tint masks (scarf overlays are painted white, then tinted per instance)
    maskWhite: "#FFFFFF",
    // WP-09: gallery page chrome only (never used in the world)
    uiPage: "#17181D",
    uiPanel: "#22242B",
    uiText: "#ECE6DA",
    uiMuted: "#9C978E",
    desktopTop: "#3B4A63",
    desktopBottom: "#1C2230"
  };
  var SCARVES = ["scarf0", "scarf1", "scarf2", "scarf3", "scarf4", "scarf5"];
  var SIZES = {
    stripHeight: 112,
    stripMinHeight: 72,
    stripMaxHeight: 160,
    /** residents stand here: 30 px above the strip bottom */
    groundY: 82,
    /** structures stand slightly behind the path, so residents overlap their footings */
    structureBaseY: 80,
    /**
     * WP-09 deviation from SPEC 3.4 (40 to 88 px tall): with the ground at 82, an 88 px building
     * would leave the strip. Structures are 28 to 76 units tall (roof top never above y = 4).
     */
    structureMaxHeight: 76,
    /** pole top 96 px above the strip bottom */
    poleTopY: 16,
    flagW: 14,
    flagH: 10,
    bell: 10,
    /** within this horizontal distance of the bell post, roofs stay below this y so the flag reads against sky */
    flagClearRadius: 40,
    flagClearRoofY: 30,
    resident: { beaver: 24, otter: 24, hare: 28, frog: 18, hedgehog: 20 },
    helperScale: 0.55,
    sign: 18,
    ambientWorldScale: 3,
    /** ambient: sky takes the top 60% of the screen */
    ambientSkyFraction: 0.6
  };
  var PAPER = {
    wobbleAmp: 0.32,
    wobbleStep: 2.6,
    grainAlpha: 0.1,
    innerShadowOffset: 0.55,
    innerShadowBlur: 0.9,
    innerShadowAlpha: 0.28,
    rimAlpha: 0.55
  };

  // src/color.ts
  var cache = /* @__PURE__ */ new Map();
  function hexToRgb(hex) {
    const hit = cache.get(hex);
    if (hit) return hit;
    const h = hex.replace("#", "");
    if (h.length !== 6) throw new Error(`bad colour ${hex}`);
    const v = { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    cache.set(hex, v);
    return v;
  }
  function tok(name) {
    return hexToRgb(PAL[name]);
  }
  var clamp255 = (x) => Math.max(0, Math.min(255, x));
  function css(c, alpha = 1) {
    const r = Math.round(clamp255(c.r));
    const g = Math.round(clamp255(c.g));
    const b = Math.round(clamp255(c.b));
    return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${Math.max(0, alpha).toFixed(3)})`;
  }
  var toLin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  var fromLin = (l) => {
    const s = l <= 31308e-7 ? l * 12.92 : 1.055 * Math.pow(Math.max(0, l), 1 / 2.4) - 0.055;
    return s * 255;
  };
  function toOklab(c) {
    const r = toLin(c.r);
    const g = toLin(c.g);
    const b = toLin(c.b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return {
      L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    };
  }
  function fromOklab(c) {
    const l = Math.pow(c.L + 0.3963377774 * c.a + 0.2158037573 * c.b, 3);
    const m = Math.pow(c.L - 0.1055613458 * c.a - 0.0638541728 * c.b, 3);
    const s = Math.pow(c.L - 0.0894841775 * c.a - 1.291485548 * c.b, 3);
    return {
      r: clamp255(fromLin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
      g: clamp255(fromLin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
      b: clamp255(fromLin(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s))
    };
  }
  function mix(a, b, t) {
    if (t <= 0) return a;
    if (t >= 1) return b;
    const A = toOklab(a);
    const B = toOklab(b);
    return fromOklab({ L: A.L + (B.L - A.L) * t, a: A.a + (B.a - A.a) * t, b: A.b + (B.b - A.b) * t });
  }
  function shade(c, dL) {
    const o = toOklab(c);
    return fromOklab({ L: Math.max(0, Math.min(1, o.L + dL)), a: o.a, b: o.b });
  }

  // src/rng.ts
  function hash(...xs) {
    let h = 2166136261 | 0;
    for (const x of xs) {
      let k = Math.imul((x | 0) ^ (x * 4096 | 0), 1540483477);
      k ^= k >>> 15;
      h = Math.imul(h ^ k, 16777619);
    }
    h ^= h >>> 13;
    h = Math.imul(h, 1540483477);
    h ^= h >>> 15;
    return h >>> 0;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = a + 1831565813 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  var range = (r, a, b) => a + (b - a) * r();
  var lattice = (seed, i) => hash(seed, i) / 4294967296;
  function noise1(seed, x) {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    const a = lattice(seed, i);
    const b = lattice(seed, i + 1);
    return (a + (b - a) * u) * 2 - 1;
  }
  function fbm1(seed, x, octaves = 3) {
    let v = 0;
    let amp = 0.6;
    let f = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      v += noise1(seed + o * 101, x * f) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return v / norm;
  }

  // src/paper.ts
  function rgbOf(f) {
    return typeof f === "string" ? tok(f) : f;
  }
  function fillCss(f, alpha = 1) {
    if (typeof f === "string" && alpha >= 1) return PAL[f];
    return css(rgbOf(f), alpha);
  }
  function rect(x, y, w, h) {
    return [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h]
    ];
  }
  function ellipse(cx, cy, rx, ry, n = 0, a0 = 0, a1 = Math.PI * 2) {
    const segs = n || Math.max(10, Math.round((rx + ry) * 2.2));
    const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6;
    const out = [];
    const count = full ? segs : segs + 1;
    for (let i = 0; i < count; i++) {
      const a = a0 + (a1 - a0) * i / segs;
      out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
    }
    return out;
  }
  function circle(cx, cy, r, n = 0) {
    return ellipse(cx, cy, r, r, n);
  }
  function roundRect(x, y, w, h, r) {
    const [tl, tr, br, bl] = typeof r === "number" ? [r, r, r, r] : r;
    const out = [];
    const corner = (cx, cy, rr, a0) => {
      if (rr <= 0) {
        out.push([cx, cy]);
        return;
      }
      const n = Math.max(3, Math.round(rr * 2));
      for (let i = 0; i <= n; i++) {
        const a = a0 + Math.PI / 2 * (i / n);
        out.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
      }
    };
    corner(x + tl, y + tl, tl, Math.PI);
    if (tl <= 0) out[out.length - 1] = [x, y];
    corner(x + w - tr, y + tr, tr, -Math.PI / 2);
    if (tr <= 0) out[out.length - 1] = [x + w, y];
    corner(x + w - br, y + h - br, br, 0);
    if (br <= 0) out[out.length - 1] = [x + w, y + h];
    corner(x + bl, y + h - bl, bl, Math.PI / 2);
    if (bl <= 0) out[out.length - 1] = [x, y + h];
    return out;
  }
  function blob(cx, cy, rx, ry, seed, lumps = 7, depth = 0.18, flatBottom = false) {
    const r = rng(seed);
    const phases = Array.from({ length: lumps }, () => r());
    const n = Math.max(24, lumps * 6);
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2;
      const k = i / n * lumps;
      const j = Math.floor(k);
      const f = k - j;
      const bump = Math.sin(f * Math.PI) * (0.6 + 0.8 * phases[j % lumps]);
      let x = cx + Math.cos(a) * rx * (1 + depth * (bump - 0.5));
      let y = cy + Math.sin(a) * ry * (1 + depth * (bump - 0.5));
      if (flatBottom && y > cy) y = cy + (y - cy) * 0.35;
      out.push([x, y]);
    }
    return out;
  }
  function strip(path, width) {
    const left = [];
    const right = [];
    const w = typeof width === "number" ? () => width : width;
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      const a = path[Math.max(0, i - 1)];
      const b = path[Math.min(path.length - 1, i + 1)];
      let dx = b[0] - a[0];
      let dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const hw = w(i / Math.max(1, path.length - 1)) / 2;
      left.push([p[0] - dy * hw, p[1] + dx * hw]);
      right.push([p[0] + dy * hw, p[1] - dx * hw]);
    }
    return [...left, ...right.reverse()];
  }
  function xf(pts, tx, ty, rot = 0, sx = 1, sy = sx) {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    return pts.map(([x, y]) => [tx + x * sx * c - y * sy * s, ty + x * sx * s + y * sy * c]);
  }
  function cutPath(pts, seed, amp = PAPER.wobbleAmp, step = PAPER.wobbleStep, closed = true) {
    const path = new Path2D();
    if (pts.length < 2) return path;
    if (amp <= 0) {
      path.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
      if (closed) path.closePath();
      return path;
    }
    const n = pts.length;
    const edges = closed ? n : n - 1;
    let s = 0;
    let first = true;
    for (let e = 0; e < edges; e++) {
      const a = pts[e];
      const b = pts[(e + 1) % n];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const nx = -dy / len;
      const ny = dx / len;
      const segs = Math.max(1, Math.ceil(len / (step * 0.5)));
      for (let k = 0; k < segs; k++) {
        const t = k / segs;
        const d = fbm1(seed, (s + len * t) / step, 2) * amp;
        const x = a[0] + dx * t + nx * d;
        const y = a[1] + dy * t + ny * d;
        if (first) {
          path.moveTo(x, y);
          first = false;
        } else path.lineTo(x, y);
      }
      s += len;
    }
    if (!closed) {
      const last = pts[n - 1];
      path.lineTo(last[0], last[1]);
    } else path.closePath();
    return path;
  }
  var grainCache = /* @__PURE__ */ new Map();
  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  function grainTexture(size = 192, seed = 7) {
    const key = `${size}:${seed}`;
    const hit = grainCache.get(key);
    if (hit) return hit;
    const N = size * size;
    const v = new Float32Array(N);
    const r = rng(seed);
    const cells = 6;
    const lat = Array.from({ length: cells * cells }, () => r() * 2 - 1);
    const at = (i, j) => lat[(j + cells) % cells * cells + (i + cells) % cells];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const fx = x / size * cells;
        const fy = y / size * cells;
        const i = Math.floor(fx);
        const j = Math.floor(fy);
        const ux = (fx - i) * (fx - i) * (3 - 2 * (fx - i));
        const uy = (fy - j) * (fy - j) * (3 - 2 * (fy - j));
        const a = at(i, j) + (at(i + 1, j) - at(i, j)) * ux;
        const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * ux;
        v[y * size + x] = (a + (b - a) * uy) * 0.35 + (r() * 2 - 1) * 0.45;
      }
    }
    const fibres = Math.round(size * size * 65e-4);
    for (let f = 0; f < fibres; f++) {
      let x = r() * size;
      let y = r() * size;
      let ang = r() * Math.PI * 2;
      const len = 4 + r() * 14;
      const sign = r() < 0.55 ? 1 : -1;
      const strength = (0.5 + r() * 0.7) * sign;
      for (let k = 0; k < len; k++) {
        const xi = (Math.round(x) % size + size) % size;
        const yi = (Math.round(y) % size + size) % size;
        v[yi * size + xi] += strength;
        ang += (r() - 0.5) * 0.5;
        x += Math.cos(ang);
        y += Math.sin(ang);
      }
    }
    const c = makeCanvas(size, size);
    const g = c.getContext("2d");
    const img = g.createImageData(size, size);
    const light = tok("speciesHighlight");
    const dark = tok("ink");
    for (let i = 0; i < N; i++) {
      const val = Math.max(-1, Math.min(1, v[i]));
      const col = val >= 0 ? light : dark;
      img.data[i * 4] = col.r;
      img.data[i * 4 + 1] = col.g;
      img.data[i * 4 + 2] = col.b;
      img.data[i * 4 + 3] = Math.round(Math.abs(val) * 255);
    }
    g.putImageData(img, 0, 0);
    grainCache.set(key, c);
    return c;
  }
  var BLUR_MIN_SCALE = 3.5;
  var PAPER_DEBUG = { noShadow: false, noGrain: false, noRim: false };
  var Paper = class {
    ctx;
    /** device pixels per unit */
    scale;
    seed;
    n = 0;
    /** global multiplier on inner shadows (0 when drawing silhouettes) */
    shadowGain = 1;
    /** when set, every piece is filled with this colour and no shadow (mask / silhouette mode) */
    flat = null;
    constructor(ctx, scale, seed = 1) {
      this.ctx = ctx;
      this.scale = scale;
      this.seed = seed;
    }
    nextSeed() {
      return hash(this.seed, this.n++);
    }
    path(pts, opts = {}) {
      const seed = opts.seed ?? this.nextSeed();
      const amp = PAPER.wobbleAmp * (opts.wobble ?? 1);
      const p = cutPath(pts, seed, amp);
      if (opts.holes) for (const h of opts.holes) p.addPath(cutPath(h, hash(seed, 77), amp));
      return p;
    }
    /** A paper piece. */
    piece(pts, fill, opts = {}) {
      const ctx = this.ctx;
      const path = pts instanceof Path2D ? pts : this.path(pts, opts);
      const rule = opts.holes ? "evenodd" : "nonzero";
      if (this.flat) {
        ctx.fillStyle = this.flat;
        ctx.fill(path, rule);
        return path;
      }
      const alpha = opts.alpha ?? 1;
      const sh = PAPER_DEBUG.noShadow ? 0 : (opts.shadow ?? 1) * this.shadowGain;
      const base = rgbOf(fill);
      const rim = PAPER_DEBUG.noRim ? 0 : opts.rim ? typeof opts.rim === "number" ? opts.rim : 1 : 0;
      const blurred = sh > 0 && this.scale >= BLUR_MIN_SCALE;
      ctx.save();
      if (sh > 0 && !blurred) this.steppedShadow(path, rule, sh, alpha);
      if (blurred) {
        ctx.shadowColor = css(tok("ink"), PAPER.innerShadowAlpha * Math.min(1.5, sh) * alpha);
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = PAPER.innerShadowOffset * this.scale * Math.min(1.6, sh);
        ctx.shadowBlur = PAPER.innerShadowBlur * this.scale * Math.min(1.6, sh);
      }
      if (rim > 0) {
        ctx.fillStyle = css(mix(base, tok("cream"), PAPER.rimAlpha), alpha);
        ctx.fill(path, rule);
        ctx.restore();
        ctx.save();
        ctx.clip(path, rule);
        ctx.translate(0, 0.42 * rim * 2 / Math.max(1, this.scale / 2) + 0.18 * rim);
        ctx.fillStyle = fillCss(fill, alpha);
        ctx.fill(path, rule);
        ctx.restore();
        return path;
      }
      ctx.fillStyle = fillCss(fill, alpha);
      ctx.fill(path, rule);
      ctx.restore();
      return path;
    }
    /**
     * Cheap soft shadow for small scales: two offset fills straight down in DEVICE space (so rotated
     * puppet parts still shadow downward), approximating a ~1 px blur at a fraction of the cost.
     */
    steppedShadow(path, rule, sh, alpha) {
      const ctx = this.ctx;
      const m = ctx.getTransform();
      const det = m.a * m.d - m.b * m.c;
      if (!det) return;
      const dev = PAPER.innerShadowOffset * this.scale * Math.min(1.6, sh);
      const lx = -m.c * dev / det;
      const ly = m.a * dev / det;
      const a = PAPER.innerShadowAlpha * Math.min(1.5, sh) * alpha;
      ctx.save();
      ctx.translate(lx * 0.55, ly * 0.55);
      ctx.fillStyle = css(tok("ink"), a * 0.5);
      ctx.fill(path, rule);
      ctx.translate(lx * 0.75, ly * 0.75);
      ctx.fillStyle = css(tok("ink"), a * 0.42);
      ctx.fill(path, rule);
      ctx.restore();
    }
    /** Clean-edged piece (tiny details: eyes, window panes). */
    dot(cx, cy, r, fill, shadow = 0) {
      this.piece(circle(cx, cy, r, 10), fill, { wobble: 0, shadow });
    }
    /** A thin paper strip along a polyline (rope, pole, branch). */
    line(path, width, fill, opts = {}) {
      return this.piece(strip(path, width), fill, { wobble: 0.35, ...opts });
    }
    /** Shade helper: a token one step lighter or darker. */
    tone(f, dL) {
      return shade(rgbOf(f), dL);
    }
    /** Run fn with a local transform (translate, rotate radians, scale). */
    at(x, y, rot, fn, sx = 1, sy = sx) {
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(x, y);
      if (rot) ctx.rotate(rot);
      if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
      fn();
      ctx.restore();
    }
    /** Lay paper grain over everything already drawn inside the box (source-atop). */
    grain(x, y, w, h, alpha = PAPER.grainAlpha) {
      if (this.flat || PAPER_DEBUG.noGrain) return;
      const ctx = this.ctx;
      const tex = grainTexture();
      const pat = ctx.createPattern(tex, "repeat");
      if (!pat) return;
      const g = Math.max(1, Math.min(2.2, this.scale / 2.5));
      const m = ctx.getTransform().inverse().multiply(new DOMMatrix().scale(g, g));
      pat.setTransform(m);
      ctx.save();
      ctx.globalCompositeOperation = "source-atop";
      ctx.globalAlpha = alpha;
      ctx.fillStyle = pat;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }
    /** Soft radial glow (emissive pass only: lamps, windows, fire). No grain, no wobble. */
    glow(cx, cy, r, fill, alpha = 1) {
      if (this.flat) return;
      const ctx = this.ctx;
      const c = rgbOf(fill);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, css(c, alpha));
      g.addColorStop(0.35, css(c, alpha * 0.45));
      g.addColorStop(1, css(c, 0));
      ctx.save();
      ctx.fillStyle = g;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      ctx.restore();
    }
    /** Short text (signboard numerals), drawn as ink on paper. */
    text(s, x, y, size, fill, weight = 600, align = "center") {
      const ctx = this.ctx;
      ctx.save();
      ctx.font = `${weight} ${size}px "Fraunces", "Iowan Old Style", Georgia, serif`;
      ctx.textAlign = align;
      ctx.textBaseline = "middle";
      ctx.fillStyle = this.flat ?? fillCss(fill);
      ctx.fillText(s, x, y);
      ctx.restore();
    }
  };

  // src/kit.ts
  function wallBlock(P, x, y, w, h, fill = "wall") {
    P.piece(rect(x, y, w, h), fill, { rim: 1, shadow: 1 });
  }
  function beams(P, x, y, w, h, fill = "woodDark") {
    const t = 1.1;
    P.piece(rect(x, y, w, t), fill, { shadow: 0.6, wobble: 0.4 });
    P.piece(rect(x, y + h - t, w, t), fill, { shadow: 0.6, wobble: 0.4 });
    P.piece(rect(x, y, t, h), fill, { shadow: 0.6, wobble: 0.4 });
    P.piece(rect(x + w - t, y, t, h), fill, { shadow: 0.6, wobble: 0.4 });
  }
  function plinth(P, x, w, h = 2.6) {
    P.piece(rect(x - 0.6, -h, w + 1.2, h + 0.4), "stoneDark", { shadow: 0.8, rim: 0.6 });
    const r = rng(Math.round(x * 13 + w * 7));
    let xx = x;
    while (xx < x + w - 1) {
      const sw = range(r, 2.2, 4);
      P.piece(rect(xx + 0.3, -h + 0.4, Math.min(sw, x + w - xx) - 0.6, h - 0.8), "stone", { shadow: 0.5, wobble: 0.6 });
      xx += sw;
    }
  }
  function gableRoof(P, cx, eaveY, w, h, fill = "roof", deep = "roofDeep", season = "autumn") {
    const half = w / 2;
    const ridgeHalf = Math.max(1.2, w * 0.06);
    const pts = [
      [cx - half, eaveY],
      [cx - ridgeHalf, eaveY - h],
      [cx + ridgeHalf, eaveY - h],
      [cx + half, eaveY]
    ];
    P.piece(pts, fill, { rim: 1.2, shadow: 1.3 });
    const courses = Math.max(2, Math.floor(h / 3.4));
    for (let i = 1; i < courses; i++) {
      const t = i / courses;
      const y = eaveY - h * t;
      const hw = half - (half - ridgeHalf) * t;
      P.piece(rect(cx - hw + 0.4, y, hw * 2 - 0.8, 0.55), mix(tok(typeof fill === "string" ? fill : "roof"), tok(typeof deep === "string" ? deep : "roofDeep"), 0.55), { shadow: 0, wobble: 0.3 });
    }
    P.piece(rect(cx - half - 0.4, eaveY - 1.2, w + 0.8, 1.6), deep, { shadow: 0.9, wobble: 0.4 });
    if (season === "winter") snowOn(P, pts.slice(0, 4), 1.6);
  }
  function snowOn(P, top, depth) {
    const up = top.map(([x, y]) => [x, y - 0.5]);
    const down = [];
    for (let i = top.length - 1; i >= 0; i--) {
      const [x, y] = top[i];
      down.push([x, y + depth * (0.7 + 0.3 * Math.sin(i * 2.3))]);
    }
    P.piece([...up, ...down], "snow", { shadow: 0.5, wobble: 0.6 });
  }
  function windowPane(P, x, y, w, h, arched = false) {
    const frame2 = arched ? roundRect(x - 0.8, y - 0.8, w + 1.6, h + 1.6, [w / 2 + 0.8, w / 2 + 0.8, 0.3, 0.3]) : rect(x - 0.8, y - 0.8, w + 1.6, h + 1.6);
    P.piece(frame2, "woodDark", { shadow: 0.9, wobble: 0.3 });
    const pane = arched ? roundRect(x, y, w, h, [w / 2, w / 2, 0, 0]) : rect(x, y, w, h);
    P.piece(pane, "windowDark", { shadow: 0, wobble: 0 });
    P.piece(rect(x + w / 2 - 0.3, y, 0.6, h), "woodDark", { shadow: 0, wobble: 0 });
    P.piece(rect(x, y + h * 0.45, w, 0.6), "woodDark", { shadow: 0, wobble: 0 });
    P.piece(rect(x - 1.1, y + h + 0.5, w + 2.2, 0.9), "wood", { shadow: 0.7, wobble: 0.2 });
  }
  function litWindow(P, x, y, w, h, arched = false) {
    P.glow(x + w / 2, y + h / 2, Math.max(w, h) * 1.9, "lampGlow", 0.45);
    const pane = arched ? roundRect(x, y, w, h, [w / 2, w / 2, 0, 0]) : rect(x, y, w, h);
    P.piece(pane, "lampGlow", { shadow: 0, wobble: 0 });
    P.piece(rect(x + w / 2 - 0.3, y, 0.6, h), "woodDark", { shadow: 0, wobble: 0, alpha: 0.85 });
    P.piece(rect(x, y + h * 0.45, w, 0.6), "woodDark", { shadow: 0, wobble: 0, alpha: 0.85 });
  }
  function door(P, x, y, w, h, fill = "wood") {
    P.piece(roundRect(x - 0.7, y - 0.7, w + 1.4, h + 0.7, [w / 2 + 0.7, w / 2 + 0.7, 0, 0]), "woodDark", { shadow: 1, wobble: 0.3 });
    P.piece(roundRect(x, y, w, h, [w / 2, w / 2, 0, 0]), fill, { shadow: 0.4, rim: 0.6, wobble: 0.3 });
    P.piece(rect(x + w * 0.5 - 0.25, y + 1.5, 0.5, h - 1.5), "woodDark", { shadow: 0, wobble: 0, alpha: 0.5 });
    P.dot(x + w * 0.78, y + h * 0.58, 0.4, "lampGlow");
  }
  function chimney(P, x, y, w, h, season = "autumn") {
    P.piece(rect(x, y, w, h), "stoneDark", { shadow: 1, rim: 0.8 });
    P.piece(rect(x - 0.6, y - 1, w + 1.2, 1.4), "stone", { shadow: 0.8, wobble: 0.3 });
    if (season === "winter") snowOn(P, [[x - 0.6, y - 1], [x + w + 0.6, y - 1]], 1);
  }
  function footing(P, w, seed) {
    const half = w / 2;
    P.piece(rect(-half, -1.6, w, 2), "stoneDark", { shadow: 0.8, rim: 0.6 });
    const r = rng(seed);
    for (let x = -half + 0.4; x < half - 1; x += range(r, 2.6, 3.8)) P.piece(rect(x, -1.3, 2.3, 1.2), "stone", { shadow: 0.4, wobble: 0.6 });
    for (const x of [-half, half]) {
      P.line([[x, 0], [x + 0.2, -8]], 0.8, "woodLight", { shadow: 0.7 });
    }
    P.line([[-half, -6.5], [half, -6.2]], 0.3, "cream", { shadow: 0.3, alpha: 0.9 });
    plankPile(P, half * 0.35, 0, 4, 12);
  }
  function plankPile(P, x, y, n, len) {
    for (let i = 0; i < n; i++) {
      const off = i % 2 * 1.2;
      P.piece(rect(x - len / 2 + off, y - 1.2 * (i + 1), len, 1.1), i % 2 ? "woodLight" : "wood", { shadow: 0.7, rim: 0.5, wobble: 0.3 });
    }
  }
  function stonePile(P, x, y, n, seed) {
    const r = rng(seed);
    for (let i = 0; i < n; i++) {
      const row = i < 3 ? 0 : i < 5 ? 1 : 2;
      const cx = x + (i - (row === 0 ? 1 : row === 1 ? 3.5 : 5)) * 2.6 + range(r, -0.3, 0.3);
      P.piece(ellipse(cx, y - 1.2 - row * 2.1, range(r, 1.4, 1.8), range(r, 1.1, 1.3), 12), i % 2 ? "stone" : "stoneLight", { shadow: 0.8, rim: 0.6 });
    }
  }
  function scaffold(P, x0, x1, top) {
    for (const x of [x0, x1]) P.line([[x, 0], [x, top]], 0.8, "woodLight", { shadow: 0.8 });
    for (let y = -6; y > top + 2; y -= 7) P.piece(rect(x0 - 0.8, y, x1 - x0 + 1.6, 1), "wood", { shadow: 0.8, wobble: 0.3 });
    const lx = x1 - 2.5;
    P.line([[lx, 0], [lx + 1.6, top + 3]], 0.45, "woodDark", { shadow: 0.5 });
    P.line([[lx + 2.2, 0], [lx + 3.8, top + 3]], 0.45, "woodDark", { shadow: 0.5 });
    for (let i = 1; i < 6; i++) {
      const t = i / 6;
      const yy = top * t + 3 * t;
      P.line([[lx + 1.6 * t, yy], [lx + 2.2 + 1.6 * t, yy]], 0.35, "woodDark", { shadow: 0.3 });
    }
  }
  function frame(P, w, wallH, roofH, partialWall = 0.45) {
    const half = w / 2;
    P.piece(rect(-half, -wallH * partialWall, w, wallH * partialWall), "wall", { rim: 1, shadow: 1 });
    plinth(P, -half, w, 2.2);
    for (let i = 0; i <= 4; i++) {
      const x = -half + w * i / 4;
      P.line([[x, 0], [x, -wallH]], 1, "wood", { shadow: 0.9 });
    }
    P.line([[-half - 1, -wallH], [half + 1, -wallH]], 1.1, "wood", { shadow: 0.9 });
    const peak = [0, -wallH - roofH];
    P.line([[-half - 2, -wallH + 0.6], peak], 1, "wood", { shadow: 0.9 });
    P.line([[half + 2, -wallH + 0.6], peak], 1, "wood", { shadow: 0.9 });
    P.line([[0, -wallH], peak], 0.8, "woodLight", { shadow: 0.7 });
    for (let i = 1; i <= 2; i++) {
      const t = i / 3;
      const y = -wallH - roofH * t;
      const hw = (half + 2) * (1 - t);
      P.line([[-hw, y], [hw, y]], 0.7, "woodLight", { shadow: 0.7 });
    }
  }
  function signboard(P, x, y, w, h, label) {
    P.line([[x - w / 2 + 1, y - 2.4], [x - w / 2 + 1, y]], 0.3, "woodDark", { shadow: 0 });
    P.line([[x + w / 2 - 1, y - 2.4], [x + w / 2 - 1, y]], 0.3, "woodDark", { shadow: 0 });
    P.piece(roundRect(x - w / 2, y, w, h, 0.8), "woodLight", { shadow: 1, rim: 0.8 });
    if (label) P.text(label, x, y + h / 2 + 0.2, h * 0.72, "ink");
  }

  // src/structures-a.ts
  function lantern(P, x, y) {
    P.line([[x, y - 1.8], [x, y]], 0.3, "woodDark", { shadow: 0 });
    P.piece(rect(x - 1.5, y, 3, 0.8), "woodDark", { shadow: 0.5, wobble: 0 });
    P.piece(rect(x - 1.1, y + 0.8, 2.2, 2.6), mix(tok("lampGlow"), tok("woodDark"), 0.55), { shadow: 0.3, wobble: 0 });
    P.piece(rect(x - 1.5, y + 3.4, 3, 0.7), "woodDark", { shadow: 0.5, wobble: 0 });
  }
  function lanternLit(P, x, y) {
    P.glow(x, y + 2.1, 8, "lampGlow", 0.55);
    P.piece(rect(x - 1.1, y + 0.8, 2.2, 2.6), "lampGlow", { shadow: 0, wobble: 0 });
  }
  function dryWall(P, x0, x1, h, seed, winter) {
    P.piece(rect(x0, -h, x1 - x0, h + 0.4), "stoneDark", { shadow: 1, rim: 0.7 });
    const r = rng(seed);
    const rows = Math.max(1, Math.round(h / 2.7));
    const rh = h / rows;
    for (let i = 0; i < rows; i++) {
      const y = -h + i * rh;
      let x = x0 + (i % 2 ? -range(r, 1, 2.4) : 0);
      while (x < x1) {
        const sw = range(r, 3, 5.2);
        const a = Math.max(x, x0);
        const b = Math.min(x + sw, x1);
        if (b - a > 0.9) {
          P.piece(roundRect(a + 0.25, y + 0.25, b - a - 0.5, rh - 0.5, 0.9), mix(tok("stone"), tok("stoneLight"), r()), {
            shadow: 0.6,
            wobble: 0.7,
            rim: i === 0 ? 0.6 : 0
          });
        }
        x += sw;
      }
    }
    if (winter) snowOn(P, [[x0, -h], [(x0 + x1) / 2, -h], [x1, -h]], 1.3);
  }
  function stake(P, x, top) {
    P.line([[x, 0.4], [x + 0.2, top]], 0.9, "woodLight", { shadow: 0.7 });
  }
  var noticeboard = {
    kind: "noticeboard",
    name: "Notice board",
    w: 22,
    h: 24,
    stages: 3,
    zone: "commons",
    draw(P, stage, o) {
      const px = 8.5;
      if (stage === 1) {
        for (const x of [-px, px]) {
          P.piece(ellipse(x, 0.2, 3, 1.1, 12), "soil", { shadow: 0.6 });
          P.line([[x, 0.4], [x + 0.15, -9.5]], 1.7, "wood", { shadow: 0.9, rim: 0.5 });
          P.piece(ellipse(x + 2, -0.2, 1.2, 0.8, 8), "stone", { shadow: 0.6, rim: 0.5 });
        }
        P.line([[-px, -4.5], [px, -4.3]], 0.3, "cream", { shadow: 0.3, alpha: 0.9 });
        plankPile(P, 1, 0, 2, 12);
        P.grain(-13, -12, 26, 14);
        return;
      }
      for (const x of [-px, px]) {
        P.piece(rect(x - 0.9, -20.5, 1.8, 20.9), "wood", { shadow: 0.9, rim: 0.5, wobble: 0.35 });
        P.piece(ellipse(x + 1.9, -0.2, 1.2, 0.8, 8), "stone", { shadow: 0.6, rim: 0.5 });
        P.piece(ellipse(x - 1.7, -0.1, 0.9, 0.6, 8), "stoneDark", { shadow: 0.6 });
      }
      if (stage === 2) {
        P.piece(rect(-10, -20, 20, 11), mix(tok("wood"), tok("woodDark"), 0.3), { shadow: 0.8, rim: 0.4 });
        beams(P, -10, -20, 20, 11, "woodLight");
        P.line([[-10, -9], [-3, -20]], 0.8, "woodLight", { shadow: 0.6 });
        P.line([[10, -9], [3, -20]], 0.8, "woodLight", { shadow: 0.6 });
        P.line([[-12.3, -19.6], [0, -24]], 1, "wood", { shadow: 0.8 });
        P.line([[12.3, -19.6], [0, -24]], 1, "wood", { shadow: 0.8 });
        P.line([[-6, -21.8], [6, -21.8]], 0.7, "woodLight", { shadow: 0.6 });
        plankPile(P, -16, 0, 2, 7);
        P.grain(-18, -26, 36, 28);
        return;
      }
      P.piece(rect(-10, -20, 20, 11), "woodLight", { shadow: 1.1, rim: 1 });
      for (const x of [-5, 0, 5]) P.line([[x, -19.5], [x, -9.5]], 0.3, "wood", { shadow: 0, alpha: 0.4 });
      beams(P, -10, -20, 20, 11, "wood");
      const notes = [
        { x: -8.6, y: -18.7, w: 5, h: 6.2, rot: -0.07, fill: "cream" },
        { x: -2.8, y: -18.8, w: 4.4, h: 5.2, rot: 0.05, fill: mix(tok("cream"), tok("scarf2"), 0.6) },
        { x: 2.3, y: -18.6, w: 5.4, h: 4.2, rot: -0.04, fill: "cream" },
        { x: -7.2, y: -11.7, w: 4.2, h: 2.6, rot: 0.08, fill: mix(tok("cream"), tok("scarf3"), 0.55) },
        { x: -1.2, y: -13.3, w: 4.6, h: 3.5, rot: -0.05, fill: "cream" },
        { x: 4.4, y: -13.4, w: 4.2, h: 3.3, rot: 0.07, fill: mix(tok("cream"), tok("scarf0"), 0.45) }
      ];
      for (const n of notes) {
        P.at(n.x + n.w / 2, n.y + n.h / 2, n.rot, () => {
          P.piece(rect(-n.w / 2, -n.h / 2, n.w, n.h), n.fill, { shadow: 0.9, wobble: 0.5 });
          for (let i = 0; i < 2 + Math.floor(n.h / 3.2); i++) {
            const lw = n.w - 1.6 - i % 2 * 1.1;
            P.line([[-n.w / 2 + 0.8, -n.h / 2 + 2.1 + i * 1.15], [-n.w / 2 + 0.8 + lw, -n.h / 2 + 2.1 + i * 1.15]], 0.25, "ink", { shadow: 0, alpha: 0.5 });
          }
          P.dot(0, -n.h / 2 + 0.7, 0.5, i3(n.x));
        });
      }
      signboard(P, 0, -8.2, 9.5, 3.6, "");
      P.line([[-3, -6.4], [3, -6.4]], 0.4, "ink", { shadow: 0, alpha: 0.65 });
      P.dot(-3.9, -6.4, 0.35, "ink");
      gableRoof(P, 0, -19.6, 25, 4.6, "roof", "roofDeep", o.season);
      P.grain(-14, -26, 28, 28);
    },
    points() {
      return { door: [0, 0], work: [-14, 0] };
    }
  };
  function i3(x) {
    const pins = ["scarf0", "scarf1", "scarf4"];
    return pins[Math.abs(Math.round(x)) % 3];
  }
  function crane(P, withBlock) {
    const ax = -13;
    const ay = -34;
    P.line([[ax + 0.5, ay], [-12, 0]], 1.1, "woodDark", { shadow: 0.6 });
    P.line([[-21, 0], [ax, ay]], 1.5, "wood", { shadow: 0.9, rim: 0.4 });
    P.line([[-5, 0], [ax, ay]], 1.5, "wood", { shadow: 0.9, rim: 0.4 });
    const tl = -21 + 8 * (23 / 34);
    const tr = -5 - 8 * (23 / 34);
    P.line([[tl, -23], [tr, -23]], 0.9, "woodLight", { shadow: 0.7 });
    P.dot(ax, ay + 0.6, 1.5, "woodDark", 0.7);
    P.dot(ax, ay + 0.6, 0.6, "roofThatch");
    P.line([[ax, ay + 1], [ax, withBlock ? -17.6 : -19]], 0.4, "roofThatch", { shadow: 0.2 });
    if (withBlock) {
      P.line([[ax, -17.6], [-15.8, -13.4]], 0.3, "roofThatch", { shadow: 0 });
      P.line([[ax, -17.6], [-10.2, -13.4]], 0.3, "roofThatch", { shadow: 0 });
      P.dot(ax, -17.8, 0.8, "stoneDark", 0.5);
      P.piece(rect(-16.2, -13.6, 6.4, 5.4), "stoneLight", { shadow: 1, rim: 0.8 });
      P.piece(rect(-16.2, -10.2, 6.4, 2), "stone", { shadow: 0, alpha: 0.6, wobble: 0.4 });
      P.line([[-14.8, -12.2], [-13.4, -11.4], [-12.4, -12.4]], 0.25, "stoneDark", { shadow: 0, alpha: 0.6 });
    } else {
      P.dot(ax, -19.4, 0.9, "stoneDark", 0.5);
    }
  }
  function bigStone(P, cx) {
    const pts = [[-4.7, 0.3], [-5.2, -2.8], [-3.2, -6.2], [0.8, -7.8], [4.4, -6.2], [5.4, -2.6], [4.8, 0.3]];
    P.piece(pts.map(([x, y]) => [cx + x, y]), mix(tok("stone"), tok("stoneDark"), 0.3), { shadow: 1.1, rim: 0.9 });
    P.piece([[cx - 3.3, -5.8], [cx + 0.8, -7.3], [cx + 1.6, -4.4], [cx - 3.8, -3.4]], "stoneLight", { shadow: 0, alpha: 0.5, wobble: 0.5 });
    P.line([[cx + 0.8, -7.6], [cx + 1.9, -5], [cx + 0.9, -3.6], [cx + 1.8, -0.4]], 0.35, "ink", { shadow: 0, alpha: 0.55 });
  }
  var slateY = (x) => -13.5 - 7.7 * (x - 7) / 25;
  var stoneyard = {
    kind: "stoneyard",
    name: "Stoneyard",
    w: 62,
    h: 36,
    stages: 3,
    zone: "workshops",
    draw(P, stage, o) {
      const winter = o.season === "winter";
      if (stage === 1) {
        for (const x of [-28, -10, 10, 28]) stake(P, x, -7.5);
        P.line([[-28, -6.6], [-10, -6.2], [10, -6.4], [28, -6.6]], 0.3, "cream", { shadow: 0.3, alpha: 0.9 });
        bigStone(P, -1);
        stonePile(P, 17, 0, 6, o.seed);
        P.piece(ellipse(-20, -0.9, 2.2, 1.4, 12), "stone", { shadow: 0.8, rim: 0.6 });
        P.piece(ellipse(-23.5, -0.7, 1.6, 1, 10), "stoneLight", { shadow: 0.8, rim: 0.6 });
        P.grain(-31, -9, 62, 11);
        return;
      }
      if (stage === 2) {
        dryWall(P, -31, -9, 3.2, o.seed + 3, winter);
        crane(P, false);
        bigStone(P, 4);
        P.line([[10, 0], [10, slateY(10) + 1]], 1.6, "woodLight", { shadow: 0.9 });
        P.line([[29, 0], [29, slateY(29) + 1]], 1.6, "woodLight", { shadow: 0.9 });
        P.line([[7, slateY(7) + 1.4], [31, slateY(31) + 1.4]], 1.3, "wood", { shadow: 0.9 });
        stonePile(P, 19, 0, 6, o.seed);
        P.grain(-31, -36, 63, 38);
        return;
      }
      dryWall(P, -31, -9, 5.6, o.seed + 3, winter);
      crane(P, true);
      bigStone(P, 4);
      for (const [x, y, rx] of [[-2.5, -0.5, 0.9], [10.5, -0.4, 0.7], [-6.8, -0.4, 0.6]]) P.piece(ellipse(x, y, rx, rx * 0.7, 8), "stoneLight", { shadow: 0.6 });
      P.piece([[9.5, 0], [9.5, slateY(9.5) + 1], [30, slateY(30) + 1], [30, 0]], mix(tok("woodDark"), tok("ink"), 0.4), { shadow: 1, rim: 0.3 });
      for (const x of [14, 19.5, 25]) P.line([[x, -0.4], [x, slateY(x) + 1]], 0.3, "ink", { shadow: 0, alpha: 0.35 });
      const blocks = [[12.5, 0, 6.2], [19, 0, 6.2], [25, 0, 5.4], [14, -3.6, 6.2], [20.6, -3.6, 5.8], [16.8, -7.2, 6.4]];
      blocks.forEach(([x, y, w], i) => {
        P.piece(rect(x, y - 3.4, w, 3.4), i % 2 ? "stoneLight" : mix(tok("stone"), tok("stoneLight"), 0.5), { shadow: 0.9, rim: 0.7, wobble: 0.35 });
      });
      lantern(P, 25.5, slateY(25.5) + 1.2);
      P.piece(rect(9.2, slateY(10) + 0.6, 1.7, -slateY(10) - 0.6 + 0.4), "wood", { shadow: 0.9, rim: 0.5, wobble: 0.3 });
      P.piece(rect(28.4, slateY(29) + 0.6, 1.7, -slateY(29) - 0.6 + 0.4), "wood", { shadow: 0.9, rim: 0.5, wobble: 0.3 });
      P.line([[29, -4], [24.5, slateY(24.5) + 1.2]], 0.7, "woodDark", { shadow: 0.5 });
      const roofPts = [[6.5, slateY(6.5) + 1.2], [6.5, slateY(6.5) - 2.6], [31.5, slateY(31.5) - 2.6], [31.5, slateY(31.5) + 1.2]];
      P.piece(roofPts, "roofSlate", { rim: 1.1, shadow: 1.3 });
      for (let x = 9; x < 31; x += 3.6) P.line([[x, slateY(x) - 2.3], [x, slateY(x) + 0.7]], 0.3, "roofSlateDeep", { shadow: 0, alpha: 0.7 });
      P.piece([[6.5, slateY(6.5) - 0.2], [31.5, slateY(31.5) - 0.2], [31.5, slateY(31.5) + 1.2], [6.5, slateY(6.5) + 1.2]], "roofSlateDeep", { shadow: 0.8, wobble: 0.4 });
      if (winter) snowOn(P, [[6.5, slateY(6.5) - 2.6], [19, slateY(19) - 2.6], [31.5, slateY(31.5) - 2.6]], 1.6);
      if (winter) snowOn(P, [[-5.2, -6.2], [-0.6, -8.2], [4, -9.1], [8.4, -8.2], [10.2, -5.8]].map(([x, y]) => [x + 0.2, y + 1.4]), 1.1);
      P.grain(-32, -36, 66, 38);
    },
    lit(P, stage) {
      if (stage < 3) return;
      lanternLit(P, 25.5, slateY(25.5) + 1.2);
    },
    points() {
      return { work: [-3.5, 0], door: [20, 0] };
    }
  };
  var PW = 32;
  var PH = 26;
  var PR = 13;
  function pressShape(P, a) {
    const c = mix(tok("ink"), tok("woodDark"), 0.3);
    P.piece(rect(-12.6, -7.1, 9.2, 1.7), c, { shadow: 0, wobble: 0, alpha: a });
    P.piece(rect(-11.2, -8.6, 3.2, 1.6), "cream", { shadow: 0, wobble: 0, alpha: a * 0.85 });
    P.piece(rect(-12, -14.4, 1.5, 7.4), c, { shadow: 0, wobble: 0, alpha: a });
    P.piece(rect(-5.5, -14.4, 1.5, 7.4), c, { shadow: 0, wobble: 0, alpha: a });
    P.piece(rect(-12.6, -14.9, 9.2, 1.7), c, { shadow: 0, wobble: 0, alpha: a });
    P.piece(rect(-8.9, -13.2, 1, 4.4), c, { shadow: 0, wobble: 0, alpha: a });
    P.piece(rect(-10.6, -9.8, 4.4, 1.1), c, { shadow: 0, wobble: 0, alpha: a });
    P.piece(rect(-11.8, -12.2, 9.8, 0.7), c, { shadow: 0, wobble: 0, alpha: a });
    P.piece(rect(-2, -12.5, 0.9, 1.7), c, { shadow: 0, wobble: 0, alpha: a });
  }
  var printshop = {
    kind: "printshop",
    name: "Print shop",
    w: 54,
    h: 40,
    stages: 3,
    zone: "workshops",
    draw(P, stage, o) {
      const winter = o.season === "winter";
      P.at(-4, 0, 0, () => {
        if (stage === 1) {
          footing(P, PW, o.seed);
          for (let i = 0; i < 3; i++) P.piece(rect(-PW / 2 - 10, -2.4 - i * 2.2, 6.5, 2.1), i % 2 ? "cream" : "wall", { shadow: 0.8, rim: 0.6, wobble: 0.4 });
          P.piece(roundRect(PW / 2 + 5, -6, 5, 6, 1), "woodDark", { shadow: 1, rim: 0.5 });
          P.piece(rect(PW / 2 + 5, -4.4, 5, 0.7), "stoneDark", { shadow: 0, wobble: 0.2 });
          return;
        }
        if (stage === 2) {
          frame(P, PW, PH, PR, 0.35);
          scaffold(P, -PW / 2 - 7, -PW / 2 - 2.5, -PH - 5);
          plankPile(P, PW / 2 + 9, 0, 3, 9);
          return;
        }
        chimney(P, 8, -PH - PR + 1, 4, 13, o.season);
        wallBlock(P, -PW / 2, -PH, PW, PH);
        beams(P, -PW / 2, -PH, PW, PH);
        P.piece(rect(-PW / 2, -17.6, PW, 1.3), "woodDark", { shadow: 0.7, wobble: 0.4 });
        for (const x of [-1.5, 3.2, 11.8]) P.piece(rect(x - 0.55, -PH, 1.1, PH - 0.4), "woodDark", { shadow: 0.5, wobble: 0.4 });
        P.line([[-PW / 2 + 0.6, -17.4], [-11.6, -24.8]], 0.9, "woodDark", { shadow: 0.4 });
        P.line([[-1.5, -24.8], [-5.6, -18]], 0.9, "woodDark", { shadow: 0.4 });
        P.line([[3.2, -24.8], [PW / 2 - 0.6, -18]], 0.9, "woodDark", { shadow: 0.4 });
        plinth(P, -PW / 2, PW);
        const wx = -14;
        const wy = -16;
        const ww = 12.5;
        const wh = 10.5;
        P.piece(rect(wx - 0.9, wy - 0.9, ww + 1.8, wh + 1.8), "woodDark", { shadow: 0.9, wobble: 0.3 });
        P.piece(rect(wx, wy, ww, wh), "windowDark", { shadow: 0, wobble: 0 });
        P.at(0.7, -0.3, 0, () => pressShape(P, 1));
        P.piece([[wx + 0.6, wy + 0.4], [wx + 3.2, wy + 0.4], [wx + 0.6, wy + 4.2]], "cream", { shadow: 0, wobble: 0, alpha: 0.13 });
        P.piece(rect(wx - 1.3, wy + wh + 0.9, ww + 2.6, 1), "wood", { shadow: 0.7, wobble: 0.2 });
        door(P, 5, -12, 5.6, 12);
        windowPane(P, -11.5, -23.6, 4.8, 4.8);
        windowPane(P, 5.4, -23.6, 4.8, 4.8);
        P.line([[-PW / 2 + 0.4, -22.5], [-PW / 2 - 8.6, -22.5]], 0.9, "woodDark", { shadow: 0.7 });
        P.line([[-PW / 2 + 0.4, -17.8], [-PW / 2 - 5.4, -22.2]], 0.6, "woodDark", { shadow: 0.5 });
        P.line([[-PW / 2 - 7.6, -22.3], [-PW / 2 - 7.6, -20.4]], 0.3, "woodDark", { shadow: 0 });
        P.line([[-PW / 2 - 1.6, -22.3], [-PW / 2 - 1.6, -20.4]], 0.3, "woodDark", { shadow: 0 });
        P.piece(roundRect(-PW / 2 - 8.4, -20.4, 7.6, 5.6, 0.8), "woodLight", { shadow: 1, rim: 0.8 });
        P.line([[-PW / 2 - 7, -18.9], [-PW / 2 - 2.4, -18.9]], 0.5, "ink", { shadow: 0, alpha: 0.8 });
        P.line([[-PW / 2 - 6.4, -17.7], [-PW / 2 - 3, -17.7]], 0.5, "ink", { shadow: 0, alpha: 0.8 });
        P.line([[-PW / 2 - 6.9, -16.5], [-PW / 2 - 2.6, -16.5]], 0.5, "ink", { shadow: 0, alpha: 0.8 });
        gableRoof(P, 0, -PH + 1, PW + 6, PR, "roof", "roofDeep", o.season);
        const ax = 19.5;
        const bx = 28;
        P.line([[ax, 0.4], [ax + 0.1, -17.5]], 1.2, "wood", { shadow: 0.8, rim: 0.4 });
        P.line([[bx, 0.4], [bx - 0.1, -16.6]], 1.2, "wood", { shadow: 0.8, rim: 0.4 });
        const ly = (t) => -16.6 + 0.8 * t + 1.5 * Math.sin(Math.PI * t);
        const lpath = [];
        for (let i = 0; i <= 10; i++) lpath.push([ax + (bx - ax) * (i / 10), ly(i / 10)]);
        P.line(lpath, 0.3, "roofThatchDeep", { shadow: 0.15 });
        [0.17, 0.5, 0.83].forEach((t, i) => {
          const sx = ax + (bx - ax) * t;
          const sy = ly(t);
          P.at(sx, sy, (i - 1) * 0.06, () => {
            P.piece(rect(-1.45, 0.1, 2.9, 5.4 - i % 2 * 0.9), i === 1 ? mix(tok("cream"), tok("scarf2"), 0.35) : "cream", { shadow: 0.8, wobble: 0.5 });
            P.line([[-0.9, 1.4], [0.9, 1.4]], 0.22, "ink", { shadow: 0, alpha: 0.5 });
            P.line([[-0.9, 2.3], [0.9, 2.3]], 0.22, "ink", { shadow: 0, alpha: 0.5 });
            P.dot(0, 0.1, 0.45, "woodDark");
          });
        });
        if (winter) {
          snowOn(P, [[ax - 0.9, -17.6], [ax + 1, -17.6]], 0.9);
          snowOn(P, [[bx - 0.9, -16.7], [bx + 1, -16.7]], 0.9);
        }
      });
      P.grain(-32, -45, 66, 47);
    },
    lit(P, stage) {
      if (stage < 3) return;
      P.at(-4, 0, 0, () => {
        litWindow(P, -14, -16, 12.5, 10.5);
        P.at(0.7, -0.3, 0, () => pressShape(P, 0.85));
        litWindow(P, -11.5, -23.6, 4.8, 4.8);
        litWindow(P, 5.4, -23.6, 4.8, 4.8);
      });
    },
    points(stage) {
      return { chimney: stage === 3 ? [10 - 4, -PH - PR - 1] : void 0, door: [7.8 - 4, 0], work: [27, 0] };
    }
  };
  var halfAt = (y) => 13 - 5 * -y / 44;
  function windmillBase(P) {
    P.piece([[-13.6, 0.3], [-12.2, -7.2], [12.2, -7.2], [13.6, 0.3]], "stoneDark", { shadow: 1, rim: 0.7 });
    const r = rng(31);
    [[-6.8, 0], [-3.5, 1]].forEach(([y0, off]) => {
      const hw = halfAt(y0 + 1.5) - 0.3;
      let x = -hw - off * 1.5;
      while (x < hw) {
        const sw = range(r, 3, 4.6);
        const a = Math.max(x, -hw);
        const b = Math.min(x + sw, hw);
        if (b - a > 0.8) P.piece(roundRect(a + 0.2, y0, b - a - 0.4, 3.1, 0.8), mix(tok("stone"), tok("stoneLight"), r()), { shadow: 0.5, wobble: 0.5 });
        x += sw;
      }
    });
  }
  function sail(P) {
    const x0 = 0.5;
    const x1 = 5.8;
    const y0 = -20.6;
    const y1 = -7.4;
    P.piece(rect(x0, y0, x1 - x0, y1 - y0), mix(tok("cream"), tok("wall"), 0.35), { shadow: 0.7, rim: 0.5, alpha: 0.92, wobble: 0.6 });
    for (let j = 1; j < 4; j++) P.line([[x0, y0 + (y1 - y0) * j / 4], [x1, y0 + (y1 - y0) * j / 4]], 0.5, "woodLight", { shadow: 0.2, wobble: 0.1 });
    P.line([[(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1]], 0.5, "woodLight", { shadow: 0.2, wobble: 0.1 });
    P.line([[x0, y0], [x1, y0]], 0.9, "wood", { shadow: 0.4, wobble: 0.2 });
    P.line([[x0, y1], [x1, y1]], 0.9, "wood", { shadow: 0.4, wobble: 0.2 });
    P.line([[x1, y0], [x1, y1]], 0.9, "wood", { shadow: 0.4, wobble: 0.2 });
    P.line([[0, -1], [0, -22]], 1.4, "woodDark", { shadow: 0.7, wobble: 0.2 });
  }
  var windmill = {
    kind: "windmill",
    name: "Windmill",
    w: 28,
    h: 53,
    stages: 3,
    zone: "workshops",
    draw(P, stage, o) {
      const winter = o.season === "winter";
      if (stage === 1) {
        footing(P, 26, o.seed);
        P.piece(ellipse(-19, -2.3, 5, 2.3, 18), "stoneLight", { shadow: 1, rim: 0.8 });
        P.piece(ellipse(-19, -3, 1.2, 0.6, 8), "stoneDark", { shadow: 0, wobble: 0.2 });
        P.grain(-26, -12, 52, 14);
        return;
      }
      if (stage === 2) {
        P.piece([[-13, 0], [-11.1, -17], [11.1, -17], [13, 0]], "wall", { rim: 1, shadow: 1 });
        windmillBase(P);
        P.line([[-13, 0], [-8, -44]], 1.3, "wood", { shadow: 0.9 });
        P.line([[13, 0], [8, -44]], 1.3, "wood", { shadow: 0.9 });
        P.line([[-4.4, -17], [-2.8, -44]], 1, "wood", { shadow: 0.8 });
        P.line([[4.4, -17], [2.8, -44]], 1, "wood", { shadow: 0.8 });
        for (const y of [-17, -30, -44]) P.line([[-halfAt(y) - 0.4, y], [halfAt(y) + 0.4, y]], 1.1, "wood", { shadow: 0.9 });
        P.line([[-halfAt(-17), -17], [-halfAt(-30) + 4, -30]], 0.7, "woodLight", { shadow: 0.6 });
        P.line([[halfAt(-17), -17], [halfAt(-30) - 4, -30]], 0.7, "woodLight", { shadow: 0.6 });
        P.line([[-halfAt(-30), -30], [-2.8, -44]], 0.7, "woodLight", { shadow: 0.6 });
        P.line([[halfAt(-30), -30], [2.8, -44]], 0.7, "woodLight", { shadow: 0.6 });
        P.line([[-9.6, -44], [0, -53]], 1, "wood", { shadow: 0.8 });
        P.line([[9.6, -44], [0, -53]], 1, "wood", { shadow: 0.8 });
        P.line([[-5, -48.6], [5, -48.6]], 0.7, "woodLight", { shadow: 0.6 });
        scaffold(P, 16, 21.5, -36);
        plankPile(P, -21, 0, 3, 9);
        P.grain(-26, -56, 52, 58);
        return;
      }
      P.piece([[-13, 0], [-8, -44], [8, -44], [13, 0]], "wall", { rim: 1, shadow: 1.1 });
      P.piece([[4.6, 0], [2.4, -44], [8, -44], [13, 0]], "wallShade", { shadow: 0, alpha: 0.65, wobble: 0.4 });
      windmillBase(P);
      for (const y of [-16, -32]) P.piece(rect(-halfAt(y) - 0.2, y, halfAt(y) * 2 + 0.4, 1.2), "woodDark", { shadow: 0.7, wobble: 0.3 });
      door(P, -3, -11.6, 6, 11.6);
      windowPane(P, -2.5, -36.8, 5, 5.2);
      P.piece(rect(-14.6, -22, 29.2, 1.5), "wood", { shadow: 1, rim: 0.7, wobble: 0.3 });
      P.line([[-13.6, -20.5], [-10.4, -16.6]], 0.7, "woodDark", { shadow: 0.4 });
      P.line([[13.6, -20.5], [10.4, -16.6]], 0.7, "woodDark", { shadow: 0.4 });
      for (let i = 0; i < 6; i++) {
        const x = -14 + i * 5.6;
        P.line([[x, -22], [x, -26.4]], 0.8, "woodLight", { shadow: 0.5 });
      }
      P.line([[-14.2, -26.2], [14.2, -26.2]], 0.9, "woodLight", { shadow: 0.6 });
      if (winter) snowOn(P, [[-14.6, -22], [14.6, -22]], 1.1);
      const cap = [[-10.9, -43.2], [-9.6, -47], [-6, -50.6], [-2, -52.8], [2, -52.8], [6, -50.6], [9.6, -47], [10.9, -43.2]];
      P.piece(cap, "roof", { rim: 1.2, shadow: 1.3 });
      for (const y of [-46.6, -49.8]) {
        const hw = y > -48 ? 9.7 : 6.4;
        P.piece(rect(-hw, y, hw * 2, 0.55), mix(tok("roof"), tok("roofDeep"), 0.55), { shadow: 0, wobble: 0.3 });
      }
      P.piece(rect(-11.6, -44.7, 23.2, 1.7), "roofDeep", { shadow: 0.9, wobble: 0.4 });
      P.dot(0, -53.2, 0.9, "woodDark", 0.5);
      if (winter) snowOn(P, cap.slice(1, 7), 1.6);
      P.piece(ellipse(0, -47.8, 2.1, 2.1, 12), "woodDark", { shadow: 0.8, rim: 0.5 });
      P.grain(-17, -56, 34, 58);
    },
    lit(P, stage) {
      if (stage < 3) return;
      litWindow(P, -2.5, -36.8, 5, 5.2);
    },
    part: {
      r: 22,
      draw(P) {
        for (let k = 0; k < 4; k++) P.at(0, 0, k * Math.PI / 2, () => sail(P));
        P.dot(0, 0, 2.5, "wood", 0.8);
        P.dot(0, 0, 1.2, "woodDark");
        P.dot(0, 0, 0.45, "stoneLight");
        P.grain(-24, -24, 48, 48);
      }
    },
    points(stage) {
      return { door: [0, 0], work: [-21, 0], pivot: stage === 3 ? [0, -48] : void 0 };
    }
  };
  var well = {
    kind: "well",
    name: "Well",
    w: 20,
    h: 24,
    stages: 3,
    zone: "commons",
    draw(P, stage, o) {
      const winter = o.season === "winter";
      const ring = (withTop) => {
        P.piece(roundRect(-7, -7.6, 14, 7.9, [1.2, 1.2, 1.6, 1.6]), "stoneDark", { shadow: 1, rim: 0.7 });
        const r = rng(77);
        for (let row = 0; row < 3; row++) {
          let x = -7 - row % 2 * 1.8;
          while (x < 7) {
            const sw = range(r, 2.6, 3.8);
            const a = Math.max(x, -7);
            const b = Math.min(x + sw, 7);
            if (b - a > 0.8) P.piece(roundRect(a + 0.25, -7.4 + row * 2.5, b - a - 0.5, 2.3, 0.7), mix(tok("stone"), tok("stoneLight"), r()), { shadow: 0.5, wobble: 0.5 });
            x += sw;
          }
        }
        if (withTop) {
          P.piece(ellipse(0, -7.6, 7.4, 2, 24), "stoneLight", { shadow: 0.8, rim: 0.6 });
          P.piece(ellipse(0, -7.5, 5.7, 1.2, 20), mix(tok("ink"), tok("windowDark"), 0.5), { shadow: 0, wobble: 0.3 });
          if (winter) snowOn(P, [[-7.2, -8.4], [-3, -9.5], [3, -9.5], [7.2, -8.4]], 1);
        }
      };
      if (stage === 1) {
        stonePile(P, 3, 0, 6, o.seed);
        for (const x of [-9, -3.5, 9]) stake(P, x, -6.5);
        P.line([[-9, -5.8], [-3.5, -5.6]], 0.3, "cream", { shadow: 0.3, alpha: 0.9 });
        P.piece(ellipse(-6.5, -0.7, 1.7, 1, 10), "stone", { shadow: 0.8, rim: 0.6 });
        P.grain(-12, -9, 24, 11);
        return;
      }
      if (stage === 2) {
        ring(true);
        for (const x of [-9.8, 9.8]) stake(P, x, -6);
        P.piece(ellipse(-11.5, -0.9, 1.6, 1, 10), "stoneLight", { shadow: 0.8, rim: 0.6 });
        P.grain(-12, -11, 24, 13);
        return;
      }
      for (const x of [-5.6, 5.6]) P.piece(rect(x - 0.8, -19, 1.6, 12.6), "woodDark", { shadow: 0.9, rim: 0.4, wobble: 0.3 });
      P.piece(rect(-6.6, -17.6, 13.2, 1.2), "wood", { shadow: 0.8, rim: 0.5, wobble: 0.3 });
      ring(true);
      P.line([[-1.4, -16.9], [-1.4, -11.4]], 0.4, "roofThatch", { shadow: 0.2 });
      P.piece([[-3, -11.4], [0.2, -11.4], [-0.1, -7.6], [-2.7, -7.6]], "wood", { shadow: 0.9, rim: 0.5, wobble: 0.3 });
      P.piece(rect(-2.95, -10.2, 3.2, 0.5), "woodDark", { shadow: 0, wobble: 0.1 });
      P.piece(rect(-2.8, -8.5, 2.9, 0.5), "woodDark", { shadow: 0, wobble: 0.1 });
      P.line([[-3, -11.2], [-1.4, -12.8], [0.2, -11.2]], 0.3, "woodDark", { shadow: 0 });
      P.line([[6.6, -17], [10, -17]], 0.8, "woodDark", { shadow: 0.5 });
      P.line([[10, -17], [10, -13.6]], 0.8, "woodDark", { shadow: 0.5 });
      P.dot(10, -13.4, 0.9, "woodLight", 0.5);
      gableRoof(P, 0, -18.4, 18, 5.6, "roof", "roofDeep", o.season);
      P.grain(-12, -25, 24, 27);
    },
    points() {
      return { door: [0, 0], work: [-12, 0] };
    }
  };
  function bed(P, x0, x1, ridges, winter) {
    P.piece(roundRect(x0, -3.4, x1 - x0, 4, [1.2, 1.2, 0.6, 0.6]), "soil", { rim: 0.7, shadow: 1 });
    if (ridges) {
      for (let x = x0 + 1.4; x < x1 - 1; x += 2.6) P.piece(ellipse(x, -3.3, 1.35, 0.9, 10), mix(tok("soil"), tok("woodLight"), 0.28), { shadow: 0.5, wobble: 0.4 });
    }
    for (let i = 0; i < 3; i++) P.piece(rect(x0 + 0.8, -2.5 + i * 0.95, x1 - x0 - 1.6, 0.4), "soilDeep", { shadow: 0, wobble: 0.8, alpha: 0.85 });
    if (winter) snowOn(P, [[x0 + 0.3, -3.4], [(x0 + x1) / 2, -3.4], [x1 - 0.3, -3.4]], 1.3);
  }
  function cabbage(P, x, winter) {
    P.piece(ellipse(x, -4, 3.5, 1.2, 14), mix(tok("meadow"), tok("meadowLight"), 0.4), { shadow: 0.8, wobble: 0.5 });
    P.piece(ellipse(x, -5.5, 2.5, 2.2, 14), "meadowLight", { shadow: 0.8, rim: 0.6, wobble: 0.5 });
    P.piece(ellipse(x, -5.8, 1.45, 1.35, 12), mix(tok("meadowLight"), tok("cream"), 0.32), { shadow: 0.3, wobble: 0.4 });
    P.line([[x - 0.9, -4.3], [x - 0.7, -6.8]], 0.25, "meadow", { shadow: 0, alpha: 0.7 });
    P.line([[x + 0.9, -4.3], [x + 0.8, -6.7]], 0.25, "meadow", { shadow: 0, alpha: 0.7 });
    if (winter) snowOn(P, [[x - 1.7, -7.2], [x, -7.9], [x + 1.7, -7.2]], 0.8);
  }
  function pumpkin(P, x, s, winter) {
    const amber = tok("leafAmber");
    const rust = mix(amber, tok("leafRust"), 0.4);
    const cy = -3.4 - 2.2 * s;
    P.piece(ellipse(x - 1.55 * s, cy, 1.5 * s, 2 * s, 12), rust, { shadow: 0.8, wobble: 0.4 });
    P.piece(ellipse(x + 1.55 * s, cy, 1.5 * s, 2 * s, 12), rust, { shadow: 0.8, wobble: 0.4 });
    P.piece(ellipse(x, cy, 1.9 * s, 2.2 * s, 14), "leafAmber", { shadow: 0.9, rim: 0.7, wobble: 0.4 });
    P.piece(rect(x - 0.35, cy - 2.2 * s - 1, 0.7, 1.4), "woodDark", { shadow: 0.4, wobble: 0.2 });
    P.piece(ellipse(x + 2.2 * s, cy - 1.8 * s, 1.5 * s, 0.7 * s, 8, 0, Math.PI * 2), "meadow", { shadow: 0.5, wobble: 0.3 });
    if (winter) snowOn(P, [[x - 1.7 * s, cy - 1.9 * s], [x, cy - 2.6 * s], [x + 1.7 * s, cy - 1.9 * s]], 0.8);
  }
  function beanPoles(P, c, winter) {
    P.line([[c - 3.2, -3.2], [c + 0.3, -13.6]], 0.8, "woodLight", { shadow: 0.7 });
    P.line([[c + 3.2, -3.2], [c - 0.3, -13.6]], 0.8, "woodLight", { shadow: 0.7 });
    P.line([[c, -3.2], [c, -13.2]], 0.8, "wood", { shadow: 0.7 });
    P.dot(c, -13.2, 0.7, "roofThatch", 0.4);
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      P.dot(c - 1.4 + i % 2 * 2.8 - (1 - t) * (i % 2 ? 0.2 : -0.2), -4.6 - t * 7.2, 0.95, i % 2 ? "meadow" : "meadowLight", 0.4);
    }
    P.dot(c + 0.4, -9.8, 0.55, "scarf0");
    P.dot(c - 1, -6.6, 0.55, "scarf0");
    if (winter) snowOn(P, [[c - 0.8, -13.9], [c + 0.8, -13.9]], 0.8);
  }
  function scarecrow(P, winter) {
    const tunic = mix(tok("scarf1"), tok("wall"), 0.15);
    const sleeve = mix(tok("scarf1"), tok("ink"), 0.15);
    P.line([[0, -3], [0, -14.5]], 1, "wood", { shadow: 0.9 });
    P.line([[-5.2, -9.8], [0, -10.6], [5.2, -9.8]], 0.9, "wood", { shadow: 0.8 });
    P.piece([[-2.2, -11], [-5.4, -10.2], [-5.2, -8.5], [-2.2, -8.8]], sleeve, { shadow: 0.7, wobble: 0.4 });
    P.piece([[2.2, -11], [5.4, -10.2], [5.2, -8.5], [2.2, -8.8]], sleeve, { shadow: 0.7, wobble: 0.4 });
    for (const sx of [-1, 1]) {
      P.line([[sx * 5.2, -9.4], [sx * 6.4, -8.4]], 0.4, "roofThatch", { shadow: 0 });
      P.line([[sx * 5.2, -9.4], [sx * 6.5, -9.6]], 0.4, "roofThatch", { shadow: 0 });
      P.line([[sx * 5.2, -9.4], [sx * 6.2, -10.6]], 0.4, "roofThatch", { shadow: 0 });
    }
    P.piece([[-2.3, -11], [2.3, -11], [2.9, -6], [1.6, -6.7], [0.6, -5.8], [-0.6, -6.6], [-1.8, -5.8], [-2.9, -6]], tunic, { shadow: 0.9, rim: 0.5, wobble: 0.4 });
    P.piece(rect(0.4, -9.4, 1.5, 1.4), "scarf2", { shadow: 0.3, wobble: 0.3 });
    for (const x of [-1.2, 0.2, 1.3]) P.line([[x, -6.2], [x + 0.2, -4.6]], 0.3, "roofThatch", { shadow: 0 });
    P.piece(ellipse(0, -13.2, 2.1, 2.1, 12), mix(tok("roofThatch"), tok("cream"), 0.35), { shadow: 0.8, rim: 0.5 });
    P.dot(-0.8, -13.4, 0.3, "ink");
    P.dot(0.8, -13.4, 0.3, "ink");
    P.line([[-0.8, -12.3], [0.8, -12.3]], 0.22, "ink", { shadow: 0, alpha: 0.8 });
    P.piece(rect(-2.2, -11.7, 4.4, 1.1), "scarf0", { shadow: 0.6, wobble: 0.3 });
    P.piece([[1.4, -11.4], [4.4, -10.2], [4.8, -9], [1.9, -10]], "scarf0", { shadow: 0.6, wobble: 0.3 });
    P.piece([[2.6, -10.9], [3.6, -10.5], [3.6, -10.1], [2.7, -10.4]], "scarf2", { shadow: 0, wobble: 0.1 });
    P.piece(rect(-3.4, -15.1, 6.8, 0.9), "woodDark", { shadow: 0.8, wobble: 0.3 });
    P.piece(roundRect(-1.9, -17.2, 3.8, 2.3, [1, 1, 0, 0]), "wood", { shadow: 0.8, rim: 0.6, wobble: 0.3 });
    P.piece(rect(-1.9, -15.7, 3.8, 0.55), "scarf0", { shadow: 0, wobble: 0.1 });
    if (winter) snowOn(P, [[-3.4, -15.3], [0, -17.7], [3.4, -15.3]], 0.9);
  }
  function wattleFence(P, x0, x1, winter) {
    const h = 8;
    for (let b = 0; b < 3; b++) {
      const y = -1.6 - b * 2.3;
      const path = [];
      for (let x = x0; x <= x1; x += 1.5) path.push([x, y + Math.sin(x * 0.9 + b) * 0.55]);
      P.line(path, 1.35, b % 2 ? "wood" : "woodLight", { shadow: 0.7, wobble: 0.5 });
    }
    for (let x = x0 + 1; x <= x1; x += 3.1) P.line([[x, 0.4], [x + 0.1, -h]], 0.9, "woodDark", { shadow: 0.6 });
    if (winter) snowOn(P, [[x0, -h + 0.5], [(x0 + x1) / 2, -h + 0.5], [x1, -h + 0.5]], 1.2);
  }
  var garden = {
    kind: "garden",
    name: "Garden",
    w: 54,
    h: 17,
    stages: 3,
    zone: "orchard",
    draw(P, stage, o) {
      const winter = o.season === "winter";
      if (stage === 1) {
        P.piece(roundRect(-23, -1.8, 46, 2.4, [1, 1, 0.6, 0.6]), "soil", { rim: 0.6, shadow: 0.9 });
        for (let i = 0; i < 2; i++) P.piece(rect(-21.5, -1 + i * 0.9, 43, 0.35), "soilDeep", { shadow: 0, wobble: 0.8, alpha: 0.8 });
        for (const x of [-24, -8, 8, 24]) stake(P, x, -8);
        P.line([[-24, -7], [-8, -6.6], [8, -6.8], [24, -7]], 0.3, "cream", { shadow: 0.3, alpha: 0.9 });
        if (winter) snowOn(P, [[-23, -1.8], [0, -1.8], [23, -1.8]], 1.1);
        P.line([[13, -1.5], [13.4, -9.4]], 0.7, "wood", { shadow: 0.6 });
        P.piece(roundRect(11.8, -2.2, 3.2, 3.4, [0.2, 0.2, 1.4, 1.4]), "stoneDark", { shadow: 0.7, wobble: 0.3 });
        P.grain(-27, -12, 54, 14);
        return;
      }
      if (stage === 2) {
        wattleFence(P, -26, -4, winter);
        bed(P, -25, -10, true, winter);
        bed(P, -8, 8, true, winter);
        bed(P, 10, 25, false, winter);
        for (const x of [10.6, 24.4]) stake(P, x, -8);
        P.line([[10.6, -7.2], [24.4, -7.2]], 0.3, "cream", { shadow: 0.3, alpha: 0.9 });
        P.line([[4.6, -3.3], [5, -11]], 0.7, "wood", { shadow: 0.6 });
        P.piece(roundRect(3.4, -4, 3.2, 3.4, [0.2, 0.2, 1.4, 1.4]), "stoneDark", { shadow: 0.7, wobble: 0.3 });
        P.grain(-28, -14, 56, 16);
        return;
      }
      wattleFence(P, -26, 26, winter);
      bed(P, -25, -10, false, winter);
      bed(P, -8, 8, false, winter);
      bed(P, 10, 25, false, winter);
      for (const x of [-21.5, -17.5, -13.5]) cabbage(P, x, winter);
      for (const x of [-6.1, 6.2]) pumpkin(P, x, 0.9, winter);
      pumpkin(P, -3.1, 0.62, winter);
      pumpkin(P, 3.2, 0.72, winter);
      P.line([[-5.8, -3.5], [-4.2, -3.9], [-3, -3.6]], 0.3, "meadow", { shadow: 0 });
      P.line([[3, -3.6], [4.6, -3.9], [6, -3.6]], 0.3, "meadow", { shadow: 0 });
      beanPoles(P, 14.8, winter);
      beanPoles(P, 21.2, winter);
      scarecrow(P, winter);
      P.grain(-28, -19, 56, 21);
    },
    points() {
      return { work: [-9, 0], door: [0, 0] };
    }
  };
  var deckY = (x) => -6 * (1 - x / 20 * (x / 20));
  var deckT = (x) => 2.1 * (1 - Math.pow(Math.abs(x) / 20, 4));
  function abutment(P, side, seed) {
    const x0 = side > 0 ? 14.4 : -18.4;
    P.piece(rect(x0, -1, 4, 7.4), "stoneDark", { shadow: 1, rim: 0.7 });
    const r = rng(seed + (side > 0 ? 1 : 5));
    for (let row = 0; row < 3; row++) {
      let x = x0 - row % 2 * 1.2;
      while (x < x0 + 4) {
        const sw = range(r, 2.2, 3.4);
        const a = Math.max(x, x0);
        const b = Math.min(x + sw, x0 + 4);
        if (b - a > 0.8) P.piece(roundRect(a + 0.2, -0.8 + row * 2.4, b - a - 0.4, 2.2, 0.7), mix(tok("stone"), tok("stoneLight"), r()), { shadow: 0.5, wobble: 0.5 });
        x += sw;
      }
    }
  }
  function piers(P) {
    for (const x of [-9, 9]) {
      P.line([[x, deckY(x) + 1], [x + 0.1, 10]], 2, "woodDark", { shadow: 0.8, rim: 0.4 });
      P.line([[x, 5.5], [x * 0.5, deckY(x * 0.5) + deckT(x * 0.5) - 0.2]], 0.9, "wood", { shadow: 0.5 });
    }
    P.line([[-9, 4.2], [9, 4.2]], 1, "wood", { shadow: 0.6 });
  }
  var footbridge = {
    kind: "footbridge",
    name: "Footbridge",
    w: 42,
    h: 18,
    stages: 3,
    zone: "river",
    creek: { x0: -15, x1: 15 },
    draw(P, stage, o) {
      const winter = o.season === "winter";
      if (stage === 1) {
        abutment(P, -1, o.seed);
        abutment(P, 1, o.seed);
        P.line([[-14.4, -1.3], [-10, -2.6]], 1.4, "woodLight", { shadow: 0.8, rim: 0.4 });
        P.line([[14.4, -1.3], [10, -2.6]], 1.4, "woodLight", { shadow: 0.8, rim: 0.4 });
        plankPile(P, -22.5, 0, 3, 8);
        stonePile(P, 22, 0, 3, o.seed);
        P.grain(-28, -8, 56, 16);
        return;
      }
      piers(P);
      const top = [];
      const bot = [];
      for (let x = -20; x <= 20.01; x += 2) {
        top.push([x, deckY(x)]);
        bot.push([x, deckY(x) + deckT(x)]);
      }
      abutment(P, -1, o.seed);
      abutment(P, 1, o.seed);
      const bearer = [];
      for (let x = -15; x <= 15.01; x += 2.5) bearer.push([x, deckY(x) + deckT(x) + 0.5]);
      P.line(bearer, 1.1, "woodDark", { shadow: 0.6 });
      P.piece([...top, ...bot.reverse()], "wood", { rim: 1, shadow: 1.1 });
      const surface = [];
      for (let x = -19; x <= 19.01; x += 2) surface.push([x, deckY(x) + 0.55]);
      P.line(surface, 0.9, "woodLight", { shadow: 0, alpha: 0.9 });
      for (let x = -18; x <= 18.01; x += 2.4) P.line([[x, deckY(x) + 0.2], [x, deckY(x) + Math.max(0.4, deckT(x) - 0.2)]], 0.28, "woodDark", { shadow: 0, alpha: 0.5 });
      if (winter) snowOn(P, surface.filter((_, i) => i % 2 === 0).map(([x, y]) => [x, y - 0.4]), 1);
      if (stage === 2) {
        P.grain(-24, -14, 48, 26);
        return;
      }
      const rail = [];
      const mid = [];
      for (let x = -18; x <= 18.01; x += 2) {
        rail.push([x, deckY(x) - 5.4]);
        mid.push([x, deckY(x) - 2.7]);
      }
      for (const x of [-18, -12, -6, 0, 6, 12, 18]) {
        const end = Math.abs(x) === 18;
        const tp = x === -18 ? 10.8 : end ? 6.6 : 5.4;
        P.line([[x, deckY(x) + 0.6], [x, deckY(x) - tp]], 1, "wood", { shadow: 0.8, rim: 0.4 });
        if (end) P.dot(x, deckY(x) - tp - 0.2, 0.9, "woodLight", 0.5);
      }
      P.line(mid, 0.7, "wood", { shadow: 0.6 });
      P.line(rail, 1.1, "woodLight", { shadow: 0.8, rim: 0.4 });
      P.line([[-18, deckY(-18) - 10.8], [-15.2, deckY(-18) - 10.8]], 0.7, "woodDark", { shadow: 0.5 });
      lantern(P, -15.2, deckY(-18) - 10.4);
      if (winter) snowOn(P, rail.filter((_, i) => i % 2 === 0).map(([x, y]) => [x, y - 0.6]), 0.9);
      P.grain(-24, -20, 48, 32);
    },
    lit(P, stage) {
      if (stage < 3) return;
      lanternLit(P, -15.2, deckY(-18) - 10.4);
    },
    points() {
      return { work: [0, -6], door: void 0 };
    }
  };
  var STRUCTURES_A = [noticeboard, stoneyard, printshop, windmill, well, garden, footbridge];

  // src/structures-b.ts
  function stoneCourses(P, x, y, w, h, rowH, seed) {
    const r = rng(seed);
    let row = 0;
    for (let yy = y + h - rowH; yy > y + 0.5; yy -= rowH, row++) {
      P.piece(rect(x + 0.4, yy, w - 0.8, 0.45), "stoneDark", { shadow: 0, wobble: 0.3, alpha: 0.55 });
      let xx = x + (row % 2 ? 2.6 : 5.2) + range(r, 0, 1.5);
      while (xx < x + w - 1.5) {
        P.piece(rect(xx, yy + 0.45, 0.4, rowH - 0.45), "stoneDark", { shadow: 0, wobble: 0.2, alpha: 0.45 });
        xx += range(r, 4.2, 6.8);
      }
    }
  }
  function roofFrame(P, cx, wallTop, halfSpan, roofH) {
    const peak = [cx, wallTop - roofH];
    P.line([[cx - halfSpan, wallTop + 0.6], peak], 1, "wood", { shadow: 0.9 });
    P.line([[cx + halfSpan, wallTop + 0.6], peak], 1, "wood", { shadow: 0.9 });
    P.line([[cx, wallTop], peak], 0.8, "woodLight", { shadow: 0.7 });
    const t = 0.45;
    const hw = halfSpan * (1 - t);
    P.line([[cx - hw, wallTop - roofH * t], [cx + hw, wallTop - roofH * t]], 0.7, "woodLight", { shadow: 0.7 });
  }
  function bunting(P, x0, y0, x1, y1, sag, n, startIdx) {
    const at = (t) => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + sag * 4 * t * (1 - t)];
    const path = [];
    for (let i = 0; i <= 12; i++) path.push(at(i / 12));
    P.line(path, 0.3, "woodDark", { shadow: 0 });
    for (let k = 0; k < n; k++) {
      const [px, py] = at((k + 0.5) / n);
      P.piece([[px - 1.25, py - 0.1], [px + 1.25, py - 0.1], [px, py + 2.5]], SCARVES[(startIdx + k) % SCARVES.length], { shadow: 0.5, wobble: 0.3 });
    }
  }
  function pumpkin2(P, x, y, r = 1.6) {
    P.piece(ellipse(x, y, r * 1.12, r, 14), "leafAmber", { shadow: 0.8, rim: 0.6 });
    P.piece(rect(x - 0.15, y - r + 0.1, 0.3, r * 1.7), "leafRust", { shadow: 0, wobble: 0, alpha: 0.5 });
    P.piece(rect(x - 0.35, y - r - 0.7, 0.7, 0.9), "reed", { shadow: 0, wobble: 0.1 });
  }
  function apple(P, x, y) {
    P.dot(x, y, 1, "leafRust", 0.5);
  }
  function cabbage2(P, x, y, r = 1.5) {
    P.piece(circle(x, y, r, 12), "meadowLight", { shadow: 0.8, rim: 0.5, wobble: 0.5 });
    P.piece(ellipse(x + r * 0.25, y + r * 0.1, r * 0.55, r * 0.7, 8), "reed", { shadow: 0, wobble: 0.2, alpha: 0.55 });
  }
  var JETTY_POSTS = [-15, -5, 5, 15];
  function jettyPost(P, x, top, bottom = 30, w = 1.7) {
    P.piece(rect(x - w / 2, top, w, bottom - top), "woodDark", { shadow: 0.9, rim: 0.5, wobble: 0.5 });
    P.piece(rect(x - w / 2, 25.6, w, bottom - 25.6), "riverDeep", { shadow: 0, alpha: 0.5, wobble: 0.3 });
    P.piece(ellipse(x, 25.5, w * 1.9, 0.6, 12), "riverLight", { shadow: 0, alpha: 0.85, wobble: 0.4 });
  }
  function jettyDeck(P, x0, x1) {
    P.piece(rect(x0, 12.2, x1 - x0, 1.5), "woodDark", { shadow: 1, wobble: 0.4 });
    P.piece(rect(x0 - 0.5, 9.4, x1 - x0 + 1, 3), "woodLight", { shadow: 1.1, rim: 0.8, wobble: 0.5 });
    for (let x = x0 + 4; x < x1 - 1; x += 4.2) P.piece(rect(x, 9.8, 0.4, 2.2), "wood", { shadow: 0, wobble: 0, alpha: 0.7 });
  }
  function rowboat(P, cx, cy, season) {
    const hull = [[-8.5, -2.6], [-4, -1.5], [4, -1.5], [8.5, -2.6], [6.6, 1.2], [2.6, 2.7], [-2.6, 2.7], [-6.6, 1.2]];
    P.piece(xf(hull, cx, cy), "woodLight", { shadow: 1.1, rim: 0.7, wobble: 0.5 });
    P.piece(xf([[-8.2, -2.2], [8.2, -2.2], [7.6, -1.2], [-7.6, -1.2]], cx, cy), "roofDeep", { shadow: 0, wobble: 0.3 });
    P.piece(xf(ellipse(0, -1.9, 6.6, 0.8, 16), cx, cy), mix(tok("woodDark"), tok("ink"), 0.3), { shadow: 0, wobble: 0.2 });
    P.piece(rect(cx - 1, cy - 2.7, 2, 1.1), "wood", { shadow: 0.5, wobble: 0.2 });
    P.line([[cx - 7.5, cy - 4.4], [cx + 5, cy - 0.6]], 0.45, "woodDark", { shadow: 0.4 });
    P.piece(ellipse(cx + 5.6, cy - 0.4, 1.4, 0.55, 8), "woodDark", { shadow: 0.4, wobble: 0.1 });
    P.piece(ellipse(cx, cy + 1.6, 9.6, 0.65, 18), "riverLight", { shadow: 0, alpha: 0.85, wobble: 0.5 });
    if (season === "winter") snowOn(P, [[cx - 7, cy - 2.2], [cx - 2, cy - 1.8], [cx + 2, cy - 1.8], [cx + 7, cy - 2.2]], 0.7);
  }
  var jetty = {
    kind: "jetty",
    name: "Jetty",
    w: 36,
    h: 8,
    stages: 3,
    zone: "river",
    draw(P, stage, o) {
      if (stage === 1) {
        jettyPost(P, -15, 8.4);
        jettyPost(P, -5, 6.2);
        jettyPost(P, 5, 7.6);
        P.line([[-15, 8.8], [-5, 6.6], [5, 8]], 0.3, "cream", { shadow: 0.3, alpha: 0.9 });
        plankPile(P, 14, 11.6, 4, 11);
        P.grain(-20, 4, 40, 28);
        return;
      }
      if (stage === 2) {
        for (const x of JETTY_POSTS) jettyPost(P, x, 8.6);
        P.line([[-15, 14], [-5, 24]], 0.7, "wood", { shadow: 0.6 });
        P.line([[5, 24], [15, 14]], 0.7, "wood", { shadow: 0.6 });
        jettyDeck(P, -18, 6);
        plankPile(P, 14, 11.6, 3, 10);
        P.grain(-20, 4, 40, 28);
        return;
      }
      for (const x of JETTY_POSTS) jettyPost(P, x, 8.6);
      P.line([[-15, 14], [-5, 24]], 0.7, "wood", { shadow: 0.6 });
      P.line([[5, 24], [15, 14]], 0.7, "wood", { shadow: 0.6 });
      jettyDeck(P, -18, 18);
      if (o.season === "winter") snowOn(P, [[-18, 9.4], [-9, 9.2], [0, 9.4], [9, 9.2], [18, 9.4]], 1.3);
      P.piece(rect(-15.4, 4.4, 2.6, 6.4), "wood", { shadow: 1, rim: 0.7, wobble: 0.4 });
      P.piece(rect(-15.9, 3.6, 3.6, 1.3), "woodLight", { shadow: 0.8, rim: 0.5, wobble: 0.3 });
      P.piece(rect(-15.5, 6.4, 2.8, 0.7), "reedTip", { shadow: 0, wobble: 0.2 });
      P.piece(ellipse(-7.5, 8.4, 3.1, 1.15, 18), "reedTip", { shadow: 0.8, wobble: 0.4, holes: [ellipse(-7.5, 8.4, 1.4, 0.45, 12)] });
      P.piece(ellipse(-7.5, 7.6, 2.6, 0.95, 18), "reedTip", { shadow: 0.6, wobble: 0.4, holes: [ellipse(-7.5, 7.6, 1.1, 0.35, 12)] });
      P.piece(rect(15.2, 3.6, 1.6, 7), "woodDark", { shadow: 0.9, rim: 0.5, wobble: 0.3 });
      P.line([[16, 3.8], [13.4, 3.8]], 0.5, "woodDark", { shadow: 0.4 });
      P.piece(rect(12.4, 4.4, 2, 2.8), "woodDark", { shadow: 0.7, wobble: 0.1 });
      P.piece(rect(12.8, 4.9, 1.2, 1.8), "windowDark", { shadow: 0, wobble: 0 });
      rowboat(P, 4, 27, o.season);
      P.line([[-14.1, 7.2], [-11.5, 15], [-8, 22], [-4.3, 25.2]], 0.5, "reedTip", { shadow: 0.4 });
      P.grain(-20, 2, 40, 31);
    },
    lit(P, stage) {
      if (stage < 3) return;
      P.glow(13.4, 5.8, 6.5, "lampGlow", 0.5);
      P.piece(rect(12.8, 4.9, 1.2, 1.8), "lampGlow", { shadow: 0, wobble: 0 });
    },
    points() {
      return { work: [-2, 0] };
    }
  };
  var MILL_X0 = -19;
  var MILL_W = 32;
  var MILL_X1 = MILL_X0 + MILL_W;
  var watermill = {
    kind: "watermill",
    name: "Watermill",
    w: 56,
    h: 52,
    stages: 3,
    zone: "river",
    creek: { x0: 16, x1: 38 },
    part: {
      r: 12,
      draw(P) {
        for (let i = 0; i < 8; i++) {
          const a = i * Math.PI / 4 + Math.PI / 8;
          P.piece(xf(rect(-1.9, -12, 3.8, 3.6), 0, 0, a), i % 2 ? "woodLight" : "wood", { shadow: 0.8, rim: 0.5, wobble: 0.3 });
        }
        P.piece(circle(0, 0, 10.2, 40), "woodDark", { shadow: 1, rim: 0.4, wobble: 0.5, holes: [circle(0, 0, 8.5, 34)] });
        for (let i = 0; i < 8; i++) {
          const a = i * Math.PI / 4;
          P.line([[0, 0], [Math.cos(a) * 9, Math.sin(a) * 9]], 0.95, "wood", { shadow: 0.7 });
        }
        P.piece(circle(0, 0, 2.5, 14), "woodDark", { shadow: 1, rim: 0.8, wobble: 0.2 });
        P.dot(0, 0, 0.85, "woodLight");
      }
    },
    draw(P, stage, o) {
      const lowH = 13;
      const upH = 15;
      const cx = (MILL_X0 + MILL_X1) / 2;
      if (stage === 1) {
        P.at(cx, 0, 0, () => footing(P, MILL_W, o.seed));
        for (const x of [16, 38]) P.line([[x, 0], [x + 0.2, -7]], 0.8, "woodLight", { shadow: 0.7 });
        P.line([[16, -5.6], [38, -5.4]], 0.3, "cream", { shadow: 0.3, alpha: 0.9 });
        stonePile(P, -26, 0, 6, o.seed + 3);
        P.grain(-34, -12, 76, 24);
        return;
      }
      if (stage === 2) {
        wallBlock(P, MILL_X0, -lowH, MILL_W, lowH, "stone");
        stoneCourses(P, MILL_X0, -lowH, MILL_W, lowH, 4.3, o.seed);
        plinth(P, MILL_X0, MILL_W, 2.2);
        for (let i = 0; i <= 4; i++) {
          const x = MILL_X0 + MILL_W * i / 4;
          P.line([[x, -lowH], [x, -lowH - upH]], 1, "wood", { shadow: 0.9 });
        }
        P.line([[MILL_X0 - 1, -lowH - upH], [MILL_X1 + 1, -lowH - upH]], 1.1, "wood", { shadow: 0.9 });
        P.line([[MILL_X0, -lowH - 6], [MILL_X1, -lowH - 6]], 0.8, "woodLight", { shadow: 0.7 });
        roofFrame(P, cx, -lowH - upH, MILL_W / 2 + 4, 17);
        for (const x of [21, 31]) P.line([[x, 6], [x, -13]], 1.3, "wood", { shadow: 0.9 });
        P.line([[19, -13], [33, -13]], 1.1, "wood", { shadow: 0.9 });
        P.line([[21, 2], [31, 2]], 1.7, "woodDark", { shadow: 0.8 });
        P.piece(rect(37.6, -2, 3.4, 11), "stone", { shadow: 0.9, rim: 0.6 });
        scaffold(P, MILL_X0 - 6, MILL_X0 - 1.5, -lowH - upH - 2);
        plankPile(P, -26 - 6, 0, 3, 9);
        P.grain(-34, -52, 78, 66);
        return;
      }
      const eaveY = -lowH - upH + 1;
      chimney(P, 4, -50, 4, 16, o.season);
      wallBlock(P, MILL_X0, -lowH, MILL_W, lowH, "stone");
      stoneCourses(P, MILL_X0, -lowH, MILL_W, lowH, 4.3, o.seed);
      plinth(P, MILL_X0, MILL_W, 2.2);
      wallBlock(P, MILL_X0 - 0.8, -lowH - upH, MILL_W + 1.6, upH);
      beams(P, MILL_X0 - 0.8, -lowH - upH, MILL_W + 1.6, upH);
      P.piece(rect(MILL_X0 - 1, -lowH - 0.6, MILL_W + 2, 1.4), "woodDark", { shadow: 1, wobble: 0.4 });
      P.piece(rect(cx - 0.3, -lowH - upH, 0.6, upH), "woodDark", { shadow: 0.5, wobble: 0.3 });
      P.line([[MILL_X0, -lowH - 1.5], [MILL_X0 + 4.5, -lowH - upH + 1.5]], 0.7, "woodDark", { shadow: 0.4 });
      P.line([[MILL_X1, -lowH - 1.5], [MILL_X1 - 4.5, -lowH - upH + 1.5]], 0.7, "woodDark", { shadow: 0.4 });
      gableRoof(P, cx, eaveY, 40, 18, "roof", "roofDeep", o.season);
      door(P, -10, -12, 6, 12);
      windowPane(P, -1, -10.5, 4.5, 4.5);
      windowPane(P, -14.5, -26, 5.5, 5.5);
      windowPane(P, 3.5, -26, 5.5, 5.5);
      P.piece(rect(-8.4, -26.2, 3.2, 3.8), "woodDark", { shadow: 0.6, wobble: 0.2 });
      P.piece(ellipse(-15.6, -2.5, 2.3, 2.6, 12), "wallShade", { shadow: 0.9, rim: 0.6 });
      P.piece(ellipse(-13.2, -1.9, 1.9, 2, 12), "wall", { shadow: 0.9, rim: 0.6 });
      P.piece(rect(-16.3, -5.3, 1.4, 0.6), "woodDark", { shadow: 0, wobble: 0 });
      P.piece(rect(MILL_X1, -1.4, 3.4, 10), "stone", { shadow: 0.9, rim: 0.6 });
      P.piece(rect(37.6, -2, 3.6, 11), "stone", { shadow: 0.9, rim: 0.6 });
      P.piece(rect(37.8, 2.4, 3.2, 0.45), "stoneDark", { shadow: 0, wobble: 0.3, alpha: 0.55 });
      P.piece(rect(MILL_X1 + 0.2, 2.8, 3, 0.45), "stoneDark", { shadow: 0, wobble: 0.3, alpha: 0.55 });
      P.line([[13, -4], [22, -14.6]], 0.9, "woodDark", { shadow: 0.6 });
      P.line([[13, -11], [18.5, -16.4]], 0.7, "woodDark", { shadow: 0.5 });
      P.piece([[13, -19.4], [30, -14.6], [30, -12.2], [13, -17]], "wood", { shadow: 1, rim: 0.8, wobble: 0.4 });
      P.line([[13.4, -19], [29.6, -14.3]], 0.85, "riverLight", { shadow: 0, alpha: 0.9 });
      P.line([[15, -14.6], [15.2, -17.8]], 0.5, "woodDark", { shadow: 0.3 });
      P.line([[22, -12.7], [22.2, -16]], 0.5, "woodDark", { shadow: 0.3 });
      if (o.season === "winter") snowOn(P, [[13, -19.7], [21, -17.4], [30, -14.9]], 0.9);
      P.piece(rect(28.5, -13.4, 1.5, 4.4), "riverLight", { shadow: 0, alpha: 0.9, wobble: 0.5 });
      P.dot(30.9, -9.4, 0.5, "riverLight");
      P.dot(27.3, -9.8, 0.4, "riverLight");
      P.grain(-24, -54, 66, 68);
    },
    lit(P, stage) {
      if (stage < 3) return;
      litWindow(P, -1, -10.5, 4.5, 4.5);
      litWindow(P, -14.5, -26, 5.5, 5.5);
      litWindow(P, 3.5, -26, 5.5, 5.5);
    },
    points(stage) {
      return {
        chimney: stage === 3 ? [6, -52] : void 0,
        door: [-7, 0],
        work: [-30, 0],
        pivot: stage === 3 ? [26, 2] : void 0
      };
    }
  };
  function flowerBox(P, x, y, w) {
    P.piece(rect(x - 0.8, y, w + 1.6, 1.6), "wood", { shadow: 0.7 });
    const n = Math.max(3, Math.round(w / 1.6));
    for (let i = 0; i < n; i++) P.dot(x + 0.5 + i * (w - 1) / (n - 1), y - 0.5, 0.75, i % 3 === 0 ? "scarf0" : i % 3 === 1 ? "scarf2" : "scarf4", 0.4);
  }
  var guesthouse = {
    kind: "guesthouse",
    name: "Guesthouse",
    w: 44,
    h: 50,
    stages: 3,
    zone: "orchard",
    draw(P, stage, o) {
      const w = 32;
      const lowH = 13;
      const upW = 35;
      const upH = 12;
      if (stage === 1) {
        footing(P, w, o.seed);
        plankPile(P, -w / 2 - 6, 0, 3, 9);
        P.grain(-24, -14, 48, 18);
        return;
      }
      if (stage === 2) {
        P.piece(rect(-w / 2, -lowH * 0.55, w, lowH * 0.55), "wall", { rim: 1, shadow: 1 });
        plinth(P, -w / 2, w, 2.2);
        for (let i = 0; i <= 4; i++) {
          const x = -w / 2 + w * i / 4;
          P.line([[x, 0], [x, -lowH - upH]], 1, "wood", { shadow: 0.9 });
        }
        P.line([[-w / 2 - 1, -lowH], [w / 2 + 1, -lowH]], 1.1, "wood", { shadow: 0.9 });
        P.line([[-upW / 2 - 1, -lowH - upH], [upW / 2 + 1, -lowH - upH]], 1.1, "wood", { shadow: 0.9 });
        roofFrame(P, 0, -lowH - upH, upW / 2 + 3, 18);
        scaffold(P, w / 2 + 3, w / 2 + 7.5, -lowH - upH - 3);
        plankPile(P, -w / 2 - 6, 0, 3, 9);
        P.grain(-26, -48, 56, 52);
        return;
      }
      chimney(P, 11, -48, 4, 16, o.season);
      wallBlock(P, -w / 2, -lowH, w, lowH);
      beams(P, -w / 2, -lowH, w, lowH);
      plinth(P, -w / 2, w);
      wallBlock(P, -upW / 2, -lowH - upH, upW, upH);
      beams(P, -upW / 2, -lowH - upH, upW, upH);
      P.piece(rect(-upW / 2 - 0.4, -lowH - 1.2, upW + 0.8, 1.6), "woodDark", { shadow: 1, wobble: 0.4 });
      P.piece(rect(-0.3, -lowH - upH, 0.6, upH - 1.2), "woodDark", { shadow: 0.5, wobble: 0.3 });
      P.line([[-upW / 2 + 0.6, -lowH - 1.6], [-upW / 2 + 4, -lowH - upH + 1.6]], 0.7, "woodDark", { shadow: 0.4 });
      P.line([[upW / 2 - 0.6, -lowH - 1.6], [upW / 2 - 4, -lowH - upH + 1.6]], 0.7, "woodDark", { shadow: 0.4 });
      P.line([[-w / 2 + 0.6, -1.6], [-w / 2 + 3, -lowH + 1.6]], 0.7, "woodDark", { shadow: 0.4 });
      gableRoof(P, 0, -lowH - upH + 1, 42, 18, "roofSlate", "roofSlateDeep", o.season);
      P.piece(rect(-4.5, -35, 9, 7), "wall", { shadow: 1, rim: 0.8 });
      windowPane(P, -2, -33.8, 4, 4.2);
      P.piece([[-5.8, -34.6], [0, -41.2], [5.8, -34.6]], "roofSlateDeep", { shadow: 1.1, rim: 1, wobble: 0.4 });
      if (o.season === "winter") snowOn(P, [[-5.8, -34.6], [0, -41.2], [5.8, -34.6]], 1.1);
      door(P, -12, -12, 6, 12);
      P.line([[-4.4, -12.4], [-1.4, -12.4]], 0.5, "woodDark", { shadow: 0.4 });
      P.line([[-1.8, -12.4], [-1.8, -11.2]], 0.3, "woodDark", { shadow: 0 });
      P.piece(rect(-3, -11.2, 2.4, 3.6), "woodDark", { shadow: 0.7, wobble: 0.1 });
      P.piece(rect(-2.5, -10.7, 1.4, 2.4), "windowDark", { shadow: 0, wobble: 0 });
      windowPane(P, 4.75, -10.8, 5.5, 5.5);
      flowerBox(P, 4.75, -4.6, 5.5);
      for (const x of [-10.25, 4.75]) {
        windowPane(P, x, -23.5, 5.5, 5.5);
        flowerBox(P, x, -16.4, 5.5);
      }
      P.grain(-24, -50, 48, 54);
    },
    lit(P, stage) {
      if (stage < 3) return;
      litWindow(P, 4.75, -10.8, 5.5, 5.5);
      litWindow(P, -10.25, -23.5, 5.5, 5.5);
      litWindow(P, 4.75, -23.5, 5.5, 5.5);
      litWindow(P, -2, -33.8, 4, 4.2);
      P.glow(-1.8, -9.5, 7, "lampGlow", 0.55);
      P.piece(rect(-2.5, -10.7, 1.4, 2.4), "lampGlow", { shadow: 0, wobble: 0 });
    },
    points(stage) {
      return { chimney: stage === 3 ? [13, -50] : void 0, door: [-9, 0], work: [-25, 0] };
    }
  };
  var belltower = {
    kind: "belltower",
    name: "Bell tower",
    w: 26,
    h: 64,
    stages: 3,
    zone: "commons",
    draw(P, stage, o) {
      const bw = 22;
      if (stage === 1) {
        footing(P, bw, o.seed);
        stonePile(P, -18, 0, 6, o.seed + 5);
        P.grain(-24, -10, 48, 14);
        return;
      }
      if (stage === 2) {
        wallBlock(P, -bw / 2, -17, bw, 17, "stone");
        P.piece(rect(-bw / 2, -20, 8.5, 3.4), "stone", { shadow: 0.9, rim: 0.7, wobble: 0.5 });
        P.piece(rect(-bw / 2 + 8.5, -18.6, 6, 2), "stoneLight", { shadow: 0.9, rim: 0.7, wobble: 0.5 });
        P.piece(rect(bw / 2 - 4.5, -21, 4.5, 4.4), "stone", { shadow: 0.9, rim: 0.7, wobble: 0.5 });
        stoneCourses(P, -bw / 2, -17, bw, 17, 4.3, o.seed);
        plinth(P, -bw / 2, bw, 2.4);
        P.piece(roundRect(-3, -12, 6, 12, [3, 3, 0, 0]), "windowDark", { shadow: 0.9, wobble: 0.2 });
        scaffold(P, bw / 2 + 2.5, bw / 2 + 7, -26);
        stonePile(P, -19, 0, 5, o.seed + 5);
        P.grain(-22, -28, 52, 32);
        return;
      }
      P.line([[0, -48.5], [0, -64.5]], 0.9, "woodDark", { shadow: 0.6 });
      P.dot(0, -64.8, 1.2, "woodDark", 0.8);
      const arch = [[-5.5, -23.5], [-5.5, -33], ...ellipse(0, -33, 5.5, 5, 14, Math.PI, Math.PI * 2), [5.5, -33], [5.5, -23.5]];
      P.piece(rect(-10, -40, 20, 17), mix(tok("woodDark"), tok("ink"), 0.5), { shadow: 0, wobble: 0 });
      P.piece(rect(-10, -40, 20, 17), "wood", { shadow: 1.1, rim: 0.8, wobble: 0.4, holes: [arch] });
      for (const x of [-8.1, 8.1]) P.piece(rect(x - 0.3, -39, 0.6, 15), "woodDark", { shadow: 0, wobble: 0.2, alpha: 0.35 });
      for (const sx of [-1, 1]) {
        P.piece(rect(sx < 0 ? -10.4 : 8.6, -40.2, 1.8, 17.2), "woodDark", { shadow: 0.9, rim: 0.4, wobble: 0.3 });
        P.line([[sx * 5.6, -36.6], [sx * 8.6, -39.4]], 0.6, "woodDark", { shadow: 0.4 });
      }
      P.line([[-5.6, -37.4], [5.6, -37.4]], 0.9, "woodDark", { shadow: 0.6 });
      wallBlock(P, -bw / 2, -22, bw, 22, "stone");
      stoneCourses(P, -bw / 2, -22, bw, 22, 4.4, o.seed);
      plinth(P, -bw / 2, bw, 2.4);
      P.piece(rect(-bw / 2 - 1.6, -23.6, bw + 3.2, 2.2), "stoneLight", { shadow: 1.1, rim: 1, wobble: 0.3 });
      P.piece(rect(-6.6, -23.4, 13.2, 1), "wood", { shadow: 0.7, wobble: 0.2 });
      door(P, -3, -12, 6, 12);
      P.piece(rect(-4.2, -0.9, 8.4, 1), "stoneLight", { shadow: 0.7, rim: 0.5, wobble: 0.3 });
      windowPane(P, -1.4, -20, 2.8, 5, true);
      const roofPts = [[-12.6, -39.4], [0, -50], [12.6, -39.4]];
      P.piece(roofPts, "roofSlate", { rim: 1.2, shadow: 1.3 });
      P.piece([[0, -50], [12.6, -39.4], [4.6, -39.4]], "roofSlateDeep", { shadow: 0.4, wobble: 0.4 });
      for (let i = 1; i < 4; i++) {
        const t = i / 4;
        const hw = 12.6 * (1 - t);
        P.piece(rect(-hw + 0.4, -39.4 - 10.6 * t, hw * 2 - 0.8, 0.5), mix(tok("roofSlate"), tok("roofSlateDeep"), 0.6), { shadow: 0, wobble: 0.3 });
      }
      P.piece(rect(-13, -40.8, 26, 1.6), "roofSlateDeep", { shadow: 0.9, wobble: 0.4 });
      if (o.season === "winter") {
        snowOn(P, roofPts, 1.5);
        snowOn(P, [[-bw / 2 - 1.6, -23.6], [bw / 2 + 1.6, -23.6]], 1);
      }
      P.line([[7.4, -12.4], [7.4, -11.2]], 0.3, "woodDark", { shadow: 0 });
      P.piece(rect(6.2, -11.2, 2.4, 3.2), "woodDark", { shadow: 0.7, wobble: 0.1 });
      P.piece(rect(6.7, -10.7, 1.4, 2.2), "windowDark", { shadow: 0, wobble: 0 });
      P.grain(-15, -66, 30, 68);
    },
    lit(P, stage) {
      if (stage < 3) return;
      P.glow(0, -17.5, 7, "lampGlow", 0.4);
      P.piece(roundRect(-1.4, -20, 2.8, 5, [1.4, 1.4, 0, 0]), "lampGlow", { shadow: 0, wobble: 0 });
      P.glow(7.4, -9, 6.5, "lampGlow", 0.55);
      P.piece(rect(6.7, -10.7, 1.4, 2.2), "lampGlow", { shadow: 0, wobble: 0 });
    },
    points(stage) {
      return stage === 3 ? { bell: [0, -36.4], flag: [0, -64], door: [0, 0], work: [-17, 0] } : { door: [0, 0], work: [-17, 0] };
    }
  };
  var bakery = {
    kind: "bakery",
    name: "Bakery",
    w: 48,
    h: 46,
    stages: 3,
    zone: "orchard",
    draw(P, stage, o) {
      const x0 = -20;
      const w = 26;
      const wallH = 21;
      const roofH = 22;
      const bodyCx = x0 + w / 2;
      if (stage === 1) {
        P.at(bodyCx, 0, 0, () => footing(P, w, o.seed));
        stonePile(P, 17, 0, 6, o.seed + 2);
        P.grain(-30, -10, 60, 14);
        return;
      }
      if (stage === 2) {
        P.at(bodyCx, 0, 0, () => {
          P.piece(rect(-w / 2, -wallH * 0.45, w, wallH * 0.45), "wall", { rim: 1, shadow: 1 });
          plinth(P, -w / 2, w, 2.2);
          for (let i = 0; i <= 4; i++) {
            const x = -w / 2 + w * i / 4;
            P.line([[x, 0], [x, -wallH]], 1, "wood", { shadow: 0.9 });
          }
          P.line([[-w / 2 - 1, -wallH], [w / 2 + 1, -wallH]], 1.1, "wood", { shadow: 0.9 });
          roofFrame(P, 0, -wallH, w / 2 + 2, roofH);
        });
        P.piece([...ellipse(15, 0, 9, 7, 16, Math.PI, Math.PI * 2)], "stone", { shadow: 1, rim: 0.8, wobble: 0.5 });
        P.piece(rect(5, -1.8, 20, 1.8), "stoneDark", { shadow: 0.8, rim: 0.6 });
        scaffold(P, -31, -26.5, -wallH - 4);
        plankPile(P, 30, 0, 3, 9);
        P.grain(-34, -48, 74, 52);
        return;
      }
      chimney(P, 13.6, -24, 3.8, 14, o.season);
      wallBlock(P, x0, -wallH, w, wallH);
      beams(P, x0, -wallH, w, wallH);
      plinth(P, x0, w);
      gableRoof(P, bodyCx - 1, -wallH + 1, 34, roofH, "roofThatch", "roofThatchDeep", o.season);
      P.dot(bodyCx - 1, -29.5, 2.7, "woodDark", 0.6);
      P.dot(bodyCx - 1, -29.5, 1.9, "windowDark");
      door(P, -8, -12, 6, 12);
      windowPane(P, -17.5, -16, 5.5, 5.5);
      windowPane(P, 0.5, -16, 5.5, 5.5);
      const dome = ellipse(15, 0, 9, 12.5, 26, Math.PI, Math.PI * 2);
      P.piece(dome, "stone", { shadow: 1.2, rim: 1, wobble: 0.5 });
      for (const k of [0.74, 0.48]) P.line(ellipse(15, 0, 9 * k, 12.5 * k, 16, Math.PI * 1.04, Math.PI * 1.96), 0.4, "stoneDark", { shadow: 0, alpha: 0.6 });
      for (const a of [1.22, 1.38, 1.62, 1.78]) {
        const ca = Math.cos(Math.PI * a);
        const sa = Math.sin(Math.PI * a);
        P.line([[15 + ca * 4.4, sa * 6.2], [15 + ca * 8.8, sa * 12.2]], 0.35, "stoneDark", { shadow: 0, alpha: 0.5 });
      }
      P.piece(rect(5.2, -2, 19.6, 2), "stoneDark", { shadow: 0.9, rim: 0.6, wobble: 0.3 });
      P.piece(roundRect(11.7, -7, 6.6, 7, [3.3, 3.3, 0, 0]), "stoneLight", { shadow: 0.8, rim: 0.6, wobble: 0.2 });
      P.piece(roundRect(12.6, -6.2, 4.8, 6.2, [2.4, 2.4, 0, 0]), "windowDark", { shadow: 0.7, wobble: 0.1 });
      if (o.season === "winter") snowOn(P, ellipse(15, 0, 9, 12.5, 10, Math.PI * 1.22, Math.PI * 1.78), 1.4);
      P.line([[-20.6, -17.6], [-26.8, -17.6]], 0.8, "woodDark", { shadow: 0.5 });
      P.line([[-20.6, -14.6], [-24.4, -17.6]], 0.6, "woodDark", { shadow: 0.4 });
      P.line([[-26.2, -17.4], [-26.2, -15.6]], 0.3, "woodDark", { shadow: 0 });
      P.line([[-21.8, -17.4], [-21.8, -15.6]], 0.3, "woodDark", { shadow: 0 });
      P.piece(roundRect(-27.8, -15.6, 7, 6.6, 1.2), "woodLight", { shadow: 1, rim: 0.8 });
      P.piece(ellipse(-24.3, -12.1, 2.7, 2.2, 16), "roofThatchDeep", { shadow: 0.5, wobble: 0.3, holes: [ellipse(-24.3, -12.1, 1.5, 1.1, 10)] });
      P.line([[-25.8, -11], [-22.8, -13.2]], 0.55, "roofThatchDeep", { shadow: 0.3 });
      P.line([[-25.8, -13.2], [-22.8, -11]], 0.55, "roofThatchDeep", { shadow: 0.3 });
      P.line([[-18.5, 0], [-18.5, -3.8]], 0.9, "woodDark", { shadow: 0.6 });
      P.line([[-9.5, 0], [-9.5, -3.8]], 0.9, "woodDark", { shadow: 0.6 });
      P.piece(rect(-19.8, -4.8, 11.6, 1.4), "wood", { shadow: 0.9, rim: 0.6 });
      P.piece(ellipse(-16.6, -6, 2.3, 1.3, 12), "roofThatch", { shadow: 0.7, rim: 0.6 });
      P.piece(ellipse(-12.4, -6, 2, 1.3, 12), "woodLight", { shadow: 0.7, rim: 0.6 });
      P.dot(-9.9, -6, 1.2, "roofThatch", 0.6);
      for (const x of [-17.4, -16.6, -15.8]) P.line([[x, -6.6], [x + 0.5, -5.5]], 0.25, "roofThatchDeep", { shadow: 0, alpha: 0.9 });
      P.grain(-31, -48, 62, 52);
    },
    lit(P, stage) {
      if (stage < 3) return;
      litWindow(P, -17.5, -16, 5.5, 5.5);
      litWindow(P, 0.5, -16, 5.5, 5.5);
      P.glow(-8, -29.5, 6, "lampGlow", 0.4);
      P.piece(circle(-8, -29.5, 1.9, 10), "lampGlow", { shadow: 0, wobble: 0 });
      P.glow(15, -3.4, 12, "lampGlow", 0.5);
      P.piece(roundRect(12.6, -6.2, 4.8, 6.2, [2.4, 2.4, 0, 0]), "ember", { shadow: 0, wobble: 0.1 });
      P.piece([[13.4, -0.4], [14.2, -3.8], [15, -2], [15.8, -4.6], [16.6, -0.4]], "flame", { shadow: 0, wobble: 0.3 });
      P.piece([[14.4, -0.4], [15, -2.4], [15.8, -0.4]], "lampGlow", { shadow: 0, wobble: 0.2 });
    },
    points(stage) {
      return { chimney: stage === 3 ? [15.5, -26] : void 0, door: [-5, 0], work: [29, 0] };
    }
  };
  var MARKET_BAYS = [-24, -12, 0, 12, 24];
  var MARKET_PIERS = [-30, -18, -6, 6, 18, 30];
  function archOutline(cx, hw) {
    return [[cx - hw, 0], [cx - hw, -13], ...ellipse(cx, -13, hw, hw, 14, Math.PI, Math.PI * 2), [cx + hw, -13], [cx + hw, 0]];
  }
  function arcade(P, withStalls) {
    P.piece(rect(-32, -23, 64, 23), mix(tok("woodDark"), tok("ink"), 0.35), { shadow: 0, wobble: 0 });
    if (withStalls) {
      MARKET_BAYS.forEach((cx, i) => {
        const flap = [[cx - 4.3, -13.6], [cx + 4.3, -13.6], [cx + 4.3, -11.2]];
        for (let k = 4; k >= 0; k--) flap.push([cx - 4.3 + (k + 0.5) * 1.72, -9.6], [cx - 4.3 + k * 1.72, -11.2]);
        P.piece(flap, SCARVES[(i * 2 + 1) % SCARVES.length], { shadow: 0.8, wobble: 0.3 });
        P.piece(rect(cx - 3.6, -4.2, 7.2, 4.2), "wood", { shadow: 1, rim: 0.4, wobble: 0.3 });
        P.piece(rect(cx - 3.9, -5, 7.8, 1), "woodLight", { shadow: 0.8, rim: 0.7, wobble: 0.3 });
        if (i === 0 || i === 4) {
          pumpkin2(P, cx - 2.2, -6.5);
          pumpkin2(P, cx + 0.2, -6.4, 1.8);
          pumpkin2(P, cx + 2.5, -6.3, 1.5);
          pumpkin2(P, cx - 0.9, -8.3, 1.3);
        } else if (i === 1) {
          P.piece(rect(cx - 3, -7.2, 6, 2.4), "woodLight", { shadow: 0.7, rim: 0.4, wobble: 0.3 });
          for (let k = 0; k < 6; k++) apple(P, cx - 2.5 + k * 1, -7.6 - k % 2 * 0.6);
          for (let k = 0; k < 4; k++) apple(P, cx - 1.6 + k * 1.1, -8.6 - k % 2 * 0.4);
        } else if (i === 2) {
          cabbage2(P, cx - 2.4, -6.5);
          cabbage2(P, cx + 0.3, -6.7, 1.7);
          cabbage2(P, cx + 2.6, -6.4, 1.4);
          cabbage2(P, cx - 1, -8.5, 1.3);
        } else {
          pumpkin2(P, cx - 2.4, -6.4, 1.5);
          for (let k = 0; k < 4; k++) apple(P, cx + 0.2 + k * 1.1, -5.9 - k % 2 * 0.7);
          cabbage2(P, cx + 0.6, -8, 1.3);
        }
      });
    }
    P.piece(rect(-32, -23, 64, 23), "stone", { shadow: 1.2, rim: 1, wobble: 0.4, holes: MARKET_BAYS.map((cx) => archOutline(cx, 4.2)) });
    for (const cx of MARKET_BAYS) {
      P.piece(archOutline(cx, 5.2), "stoneLight", { shadow: 0.7, rim: 0.8, wobble: 0.3, holes: [archOutline(cx, 4.2)] });
      P.piece(rect(cx - 1, -19.6, 2, 2.6), "stoneLight", { shadow: 0.6, rim: 0.6, wobble: 0.2 });
    }
    for (const px of MARKET_PIERS) {
      P.piece(rect(px - 2.4, -1.8, 4.8, 1.8), "stoneDark", { shadow: 0.8, rim: 0.5, wobble: 0.3 });
      P.piece(rect(px - 2.2, -22.2, 4.4, 1.3), "stoneDark", { shadow: 0.5, wobble: 0.3, alpha: 0.5 });
    }
  }
  var markethall = {
    kind: "markethall",
    name: "Market hall",
    w: 76,
    h: 50,
    stages: 3,
    zone: "orchard",
    draw(P, stage, o) {
      const faceTop = -23;
      if (stage === 1) {
        footing(P, 64, o.seed);
        for (const px of MARKET_PIERS) P.piece(rect(px - 1.9, -4.6, 3.8, 4.6), px % 12 ? "stone" : "stoneDark", { shadow: 0.9, rim: 0.6, wobble: 0.4 });
        stonePile(P, 8, 0, 6, o.seed + 1);
        P.grain(-36, -12, 72, 16);
        return;
      }
      if (stage === 2) {
        arcade(P, false);
        P.piece(rect(-33.6, faceTop - 2, 67.2, 2.6), "stoneLight", { shadow: 1.1, rim: 1, wobble: 0.3 });
        P.line([[-35, faceTop - 2.4], [35, faceTop - 2.4]], 1.2, "wood", { shadow: 0.9 });
        for (const x of [-24, 0, 24]) {
          P.line([[x - 11, faceTop - 2.4], [x, faceTop - 12]], 0.9, "wood", { shadow: 0.8 });
          P.line([[x + 11, faceTop - 2.4], [x, faceTop - 12]], 0.9, "wood", { shadow: 0.8 });
          P.line([[x, faceTop - 2.4], [x, faceTop - 12]], 0.8, "woodLight", { shadow: 0.6 });
        }
        P.line([[-24, faceTop - 12], [24, faceTop - 12]], 0.8, "woodLight", { shadow: 0.6 });
        scaffold(P, 35, 39.5, -30);
        plankPile(P, -37, 0, 3, 9);
        P.grain(-42, -40, 86, 44);
        return;
      }
      arcade(P, true);
      P.piece(rect(-33.6, faceTop - 2, 67.2, 2.6), "stoneLight", { shadow: 1.1, rim: 1, wobble: 0.3 });
      gableRoof(P, 0, faceTop - 2, 76, 15, "roof", "roofDeep", o.season);
      P.piece(rect(-6.8, -41.5, 13.6, 9.8), "wall", { shadow: 1, rim: 0.8 });
      P.piece(rect(-6.8, -33.2, 13.6, 1.1), "woodDark", { shadow: 0.7, wobble: 0.3 });
      const gable = [[-8.4, -41.3], [0, -50], [8.4, -41.3]];
      P.piece(gable, "roofDeep", { shadow: 1.1, rim: 1, wobble: 0.4 });
      if (o.season === "winter") snowOn(P, gable, 1.2);
      P.dot(0, -37.4, 3.7, "woodDark", 0.7);
      P.dot(0, -37.4, 3.1, "cream");
      P.line([[0, -37.4], [0, -39.6]], 0.4, "ink", { shadow: 0 });
      P.line([[0, -37.4], [1.7, -36.9]], 0.4, "ink", { shadow: 0 });
      for (let i = 0; i < MARKET_PIERS.length - 1; i++) bunting(P, MARKET_PIERS[i], -21.6, MARKET_PIERS[i + 1], -21.6, 1.7, 3, i * 3);
      for (const px of MARKET_PIERS.slice(1, 5)) {
        P.line([[px, -21.8], [px, -20.6]], 0.3, "woodDark", { shadow: 0 });
        P.piece(rect(px - 1.2, -20.6, 2.4, 3.4), "woodDark", { shadow: 0.7, wobble: 0.1 });
        P.piece(rect(px - 0.7, -20.1, 1.4, 2.4), "windowDark", { shadow: 0, wobble: 0 });
      }
      P.grain(-40, -52, 80, 56);
    },
    lit(P, stage) {
      if (stage < 3) return;
      for (const px of MARKET_PIERS.slice(1, 5)) {
        P.glow(px, -18.9, 8, "lampGlow", 0.55);
        P.piece(rect(px - 0.7, -20.1, 1.4, 2.4), "lampGlow", { shadow: 0, wobble: 0 });
      }
      P.glow(0, -37.4, 6, "lampGlow", 0.3);
    },
    points() {
      return { door: [0, 0], work: [44, 0] };
    }
  };
  var STRUCTURES_B = [jetty, watermill, guesthouse, belltower, bakery, markethall];

  // src/structures.ts
  var cottage = {
    kind: "cottage",
    name: "Cottage",
    w: 40,
    h: 44,
    stages: 3,
    variants: 2,
    draw(P, stage, o) {
      const w = 34;
      const wallH = 19;
      const roofH = 17;
      if (stage === 1) {
        footing(P, w, o.seed);
        return;
      }
      if (stage === 2) {
        frame(P, w, wallH, roofH, 0.5);
        scaffold(P, w / 2 + 2, w / 2 + 6, -wallH - 4);
        plankPile(P, -w / 2 - 4, 0, 3, 9);
        return;
      }
      const thatch = (o.variant ?? 0) % 2 === 1;
      chimney(P, w * 0.2, -wallH - roofH + 1, 4, 10, o.season);
      wallBlock(P, -w / 2, -wallH, w, wallH);
      beams(P, -w / 2, -wallH, w, wallH);
      plinth(P, -w / 2, w);
      gableRoof(P, 0, -wallH + 1, w + 7, roofH, thatch ? "roofThatch" : "roof", thatch ? "roofThatchDeep" : "roofDeep", o.season);
      door(P, -3, -12.5, 6, 12.5);
      windowPane(P, -w / 2 + 4.5, -14, 5.5, 5.5);
      windowPane(P, w / 2 - 10, -14, 5.5, 5.5);
      P.piece(rect(w / 2 - 10.8, -7.4, 7.2, 1.6), "wood", { shadow: 0.7 });
      for (let i = 0; i < 4; i++) P.dot(w / 2 - 10 + i * 1.8, -8, 0.75, i % 2 ? "scarf0" : "scarf2", 0.4);
      P.grain(-w / 2 - 6, -wallH - roofH - 12, w + 12, wallH + roofH + 14);
    },
    lit(P, stage) {
      if (stage < 3) return;
      const w = 34;
      litWindow(P, -w / 2 + 4.5, -14, 5.5, 5.5);
      litWindow(P, w / 2 - 10, -14, 5.5, 5.5);
    },
    points(stage) {
      return { chimney: stage === 3 ? [8.8, -46] : void 0, door: [0, 0], work: [-22, 0] };
    }
  };
  var sawmill = {
    kind: "sawmill",
    name: "Sawmill",
    w: 64,
    h: 46,
    stages: 3,
    draw(P, stage, o) {
      const w = 46;
      const wallH = 20;
      const roofH = 15;
      if (stage === 1) {
        footing(P, w, o.seed);
        plankPile(P, -w / 2 + 2, 0, 3, 10);
        return;
      }
      if (stage === 2) {
        frame(P, w, wallH, roofH, 0.35);
        scaffold(P, -w / 2 - 6, -w / 2 - 2, -wallH - 4);
        sawhorse(P, w / 2 + 8);
        return;
      }
      P.piece(rect(-w / 2, -wallH, w, wallH), mix(tok("woodDark"), tok("ink"), 0.25), { shadow: 1, rim: 0.4 });
      P.piece(ellipse(-4, -9, 6.5, 6.5, 32), "stoneLight", { shadow: 0.8, rim: 1 });
      const teeth = [];
      for (let i = 0; i < 24; i++) {
        const a = i / 24 * Math.PI * 2;
        const rr = i % 2 ? 6.4 : 7.4;
        teeth.push([-4 + Math.cos(a) * rr, -9 + Math.sin(a) * rr]);
      }
      P.piece(teeth, "stone", { shadow: 0.4, wobble: 0 });
      P.dot(-4, -9, 1.4, "woodDark");
      P.piece(rect(-w / 2 + 2, -4, w - 4, 2.5), "wood", { shadow: 0.9, rim: 0.6 });
      for (const x of [-w / 2, -w / 6, w / 6, w / 2 - 2]) P.piece(rect(x, -wallH, 2, wallH), "wood", { shadow: 0.9, rim: 0.5 });
      gableRoof(P, 0, -wallH + 1, w + 8, roofH, "roof", "roofDeep", o.season);
      for (let row = 0; row < 3; row++)
        for (let i = 0; i < 3 - row; i++) {
          const cx = -w / 2 - 6 + i * 4 + row * 2;
          const cy = -2 - row * 3.6;
          P.piece(ellipse(cx, cy, 1.9, 1.9, 14), "wood", { shadow: 0.9, rim: 0.4 });
          P.piece(ellipse(cx, cy, 1.2, 1.2, 12), "woodLight", { shadow: 0, wobble: 0.2 });
        }
      sawhorse(P, w / 2 + 8);
      plankPile(P, w / 2 + 8, -5.5, 2, 9);
      signboard(P, 0, -wallH - 2.5, 10, 4.2, "");
      P.grain(-w / 2 - 12, -wallH - roofH - 4, w + 30, wallH + roofH + 6);
    },
    points(stage) {
      return { work: [32, 0], chimney: void 0, door: [0, 0], pivot: stage === 3 ? [-4, -9] : void 0 };
    }
  };
  function sawhorse(P, x) {
    P.line([[x - 4, 0], [x - 2, -5]], 0.8, "woodDark", { shadow: 0.6 });
    P.line([[x + 4, 0], [x + 2, -5]], 0.8, "woodDark", { shadow: 0.6 });
    P.piece(rect(x - 5, -5.6, 10, 1.3), "wood", { shadow: 0.8, rim: 0.5 });
  }
  var campfire = {
    kind: "campfire",
    name: "Campfire",
    w: 14,
    h: 8,
    stages: 1,
    draw(P, _s, o) {
      const r = rng(o.seed);
      for (let i = 0; i < 7; i++) {
        const a = Math.PI + i / 6 * Math.PI;
        P.piece(ellipse(Math.cos(a) * 5.2, -0.8 + Math.sin(a) * 0.9, 1.5, 1.1, 10), i % 2 ? "stone" : "stoneDark", { shadow: 0.8, rim: 0.6 });
      }
      P.line([[-4, -0.6], [3.5, -3.2]], 1.2, "wood", { shadow: 0.8 });
      P.line([[4, -0.6], [-3.4, -3.4]], 1.2, "woodDark", { shadow: 0.8 });
      for (const x of [-11, 11]) P.piece(roundRect(x - 3.5, -2.6, 7, 2.6, 1.2), "wood", { shadow: 1, rim: 0.7 });
      void r;
      if (o.season === "winter") snowOn(P, [[-14.5, -2.6], [-7.5, -2.6]], 0.8);
    },
    lit(P, _s, o) {
      const f = o.frame ?? 0;
      P.glow(0, -4, 14, "lampGlow", 0.5);
      const flick = [0, 0.7, -0.5, 0.3][f % 4];
      P.piece([[-3, -1.2], [-1.6 + flick * 0.3, -6.5], [0, -4.4], [0.6 + flick, -9], [2.2, -4.2], [3, -1.2]], "flame", { shadow: 0, wobble: 0.6 });
      P.piece([[-1.6, -1.2], [-0.6, -4.5], [0.4 + flick * 0.5, -6.4], [1.7, -1.2]], "lampGlow", { shadow: 0, wobble: 0.4 });
    },
    points() {
      return { work: [-11, 0] };
    }
  };
  var tent = {
    kind: "tent",
    name: "Tent",
    w: 26,
    h: 18,
    stages: 1,
    draw(P, _s, o) {
      P.piece([[-12, 0], [0, -17], [12, 0]], "scarf2", { shadow: 1.2, rim: 1 });
      P.piece([[-12, 0], [0, -17], [-5, 0]], mix(tok("scarf2"), tok("wood"), 0.3), { shadow: 0.6 });
      P.piece([[-3.5, 0], [0, -9], [3.5, 0]], mix(tok("ink"), tok("woodDark"), 0.5), { shadow: 0.5, wobble: 0.3 });
      P.line([[0, -17], [0.4, -20]], 0.6, "woodDark", { shadow: 0.5 });
      P.line([[-12, 0], [-15, 0.5]], 0.25, "woodDark", { shadow: 0 });
      P.line([[12, 0], [15, 0.5]], 0.25, "woodDark", { shadow: 0 });
      if (o.season === "winter") snowOn(P, [[-6, -8.5], [0, -17], [6, -8.5]], 1.2);
      P.grain(-15, -21, 30, 22);
    },
    points() {
      return { door: [0, 0], work: [16, 0] };
    }
  };
  var bellpost = {
    kind: "bellpost",
    name: "Bell post",
    w: 12,
    h: 64,
    stages: 1,
    draw(P, _s, o) {
      P.piece(rect(-3, -3, 6, 3.4), "stoneDark", { shadow: 1, rim: 0.7 });
      P.piece(rect(-1, -64.5, 2, 62), "wood", { shadow: 1.1, rim: 0.6, wobble: 0.3 });
      P.dot(0, -64.8, 1.3, "woodDark", 0.8);
      P.piece(rect(-0.5, -50.6, 7.5, 1.4), "woodDark", { shadow: 0.9, wobble: 0.2 });
      P.line([[1, -44], [4.5, -50]], 0.7, "woodDark", { shadow: 0.5 });
      P.piece(rect(-2.2, -14, 1.4, 3), "woodDark", { shadow: 0.6, wobble: 0 });
      if (o.season === "winter") snowOn(P, [[-3, -3], [3, -3]], 0.8);
    },
    points() {
      return { flag: [1, -64], bell: [6, -50], work: [-5, 0] };
    }
  };
  var founders = {
    kind: "founders",
    name: "Founders' stone",
    w: 16,
    h: 22,
    stages: 1,
    zone: "commons",
    draw(P, _s, o) {
      P.piece(rect(-7.5, -2.2, 15, 2.6), "stoneDark", { shadow: 1, rim: 0.6 });
      P.piece([[-5.6, -2], [-6.2, -15], [-3.6, -20.5], [1.8, -21.6], [5.6, -18], [6.2, -2]], "stone", { shadow: 1.2, rim: 1.2 });
      P.piece([[-5.6, -2], [-6.2, -15], [-4.6, -17.8], [-3.4, -3]], "stoneDark", { shadow: 0, alpha: 0.55 });
      for (let i = 0; i < 3; i++) P.line([[-2.6, -15.5 + i * 3.6], [3.4, -15.8 + i * 3.6]], 0.45, "stoneDark", { shadow: 0, wobble: 0.3 });
      P.text("1", 0.4, -6.2, 4.6, "stoneDark", 700);
      P.piece(blob(-4.6, -1.4, 3, 1.3, 7, 5, 0.4, true), o.season === "winter" ? "snow" : "meadowLight", { shadow: 0.6 });
      if (o.season === "winter") snowOn(P, [[-3.6, -20.5], [1.8, -21.6], [5.6, -18]], 1.2);
      P.grain(-9, -24, 18, 26);
    },
    points() {
      return { work: [-10, 0] };
    }
  };
  var plot = {
    kind: "plot",
    name: "Build plot",
    w: 30,
    h: 12,
    stages: 1,
    draw(P) {
      for (const x of [-13, 13]) P.line([[x, 0.5], [x + 0.2, -6]], 0.7, "woodLight", { shadow: 0.7 });
      P.line([[-13, -4.6], [13, -4.4]], 0.28, "cream", { shadow: 0.3, alpha: 0.9 });
      P.line([[11, 0.5], [11.2, -11]], 0.5, "wood", { shadow: 0.6 });
      P.piece([[11.4, -11], [16, -9.6], [11.4, -8]], "scarf2", { shadow: 0.6, wobble: 0 });
      P.grain(-15, -12, 32, 13);
    },
    points() {
      return { work: [-16, 0] };
    }
  };
  var STRUCTURES = {
    cottage,
    sawmill,
    campfire,
    tent,
    bellpost,
    founders,
    plot
  };
  for (const def of [...STRUCTURES_A, ...STRUCTURES_B]) STRUCTURES[def.kind] = def;

  // src/residents.ts
  var SPECIES = ["beaver", "otter", "frog", "hare", "hedgehog"];
  var fur = (t) => tok(t);
  function eyes(P, at, kind, r = 0.78) {
    for (const [x, y] of at) {
      if (kind === "closed") {
        P.line([[x - 0.9, y], [x, y + 0.45], [x + 0.9, y]], 0.42, "ink", { shadow: 0, wobble: 0 });
      } else if (kind === "happy") {
        P.line([[x - 0.9, y + 0.3], [x, y - 0.5], [x + 0.9, y + 0.3]], 0.45, "ink", { shadow: 0, wobble: 0 });
      } else {
        const rr = kind === "wide" ? r * 1.25 : r;
        P.piece(circle(x, y, rr, 12), "ink", { shadow: 0, wobble: 0 });
        P.piece(circle(x + rr * 0.35, y - rr * 0.35, rr * 0.36, 8), "speciesHighlight", { shadow: 0, wobble: 0 });
        if (kind === "worried") P.line([[x - 1, y - 1.6], [x + 0.9, y - 2.1]], 0.4, "ink", { shadow: 0, wobble: 0 });
      }
    }
  }
  function mouth(P, x, y, kind, w = 1.6) {
    if (!kind || kind === "none") return;
    if (kind === "open") P.piece(ellipse(x, y + 0.3, w * 0.55, w * 0.5, 10), mix(tok("ink"), tok("errorCoral"), 0.35), { shadow: 0, wobble: 0 });
    else if (kind === "o") P.piece(ellipse(x, y + 0.3, w * 0.35, w * 0.4, 10), "ink", { shadow: 0, wobble: 0 });
    else P.line([[x - w * 0.5, y], [x, y + w * 0.35], [x + w * 0.5, y]], 0.4, "ink", { shadow: 0, wobble: 0 });
  }
  var BEAVER = {
    id: "beaver",
    h: 24,
    fur: "beaver",
    light: mix(fur("beaver"), tok("cream"), 0.5),
    paw: mix(fur("beaver"), tok("cream"), 0.62),
    dark: shade(fur("beaver"), -0.12),
    body: { cx: 0, cy: -8.8, rx: 5.6, ry: 6.8, pear: 0.14 },
    head: { cx: 1, cy: -17.4, rx: 5.8, ry: 5.3 },
    shoulder: [0.4, -12.4],
    hip: [0, -4.5],
    arm: { len: 5.4, w: 2.3, hand: 1.25 },
    foot: { rx: 2.3, ry: 1.1, gap: 2.4 },
    scarfY: -12.6,
    scarfW: 10,
    drawTail(P, d, pose) {
      const a = ((pose.tail ?? 0) - 62) * (Math.PI / 180);
      const pts = xf(ellipse(0, -5.6, 2.7, 5.8, 18), -4.4, -3.4, a);
      P.piece(pts, mix(d.dark, tok("ink"), 0.25), { shadow: 1, rim: 0.6 });
      for (let i = 1; i <= 3; i++) {
        const s = xf([[-1.8, -2.4 * i], [1.8, -2.4 * i - 0.6]], -4.4, -3.4, a);
        P.line(s, 0.3, d.dark, { shadow: 0, wobble: 0, alpha: 0.9 });
      }
    },
    drawEars(P, d, _pose, back) {
      if (back) P.piece(circle(d.head.cx - 3.6, d.head.cy - 3.9, 1.6, 12), d.dark, { shadow: 0.6 });
      else {
        P.piece(circle(d.head.cx + 3, d.head.cy - 4.5, 1.5, 12), "beaver", { shadow: 0.6, rim: 0.6 });
        P.piece(circle(d.head.cx + 3, d.head.cy - 4.4, 0.7, 8), d.dark, { shadow: 0, wobble: 0 });
      }
    },
    drawFace(P, d, pose) {
      const { cx, cy } = d.head;
      const f = pose.front ? -1.4 : 0;
      P.piece(ellipse(cx + 2.7 + f, cy + 1.7, 2.9, 2.1, 16), d.light, { shadow: 0.5 });
      P.piece(ellipse(cx + 4.4 + f, cy + 0.5, 1.25, 0.9, 12), mix(tok("ink"), tok("woodDark"), 0.4), { shadow: 0, wobble: 0 });
      P.piece(rect(cx + 2.4 + f, cy + 3.3, 1.5, 1.4), "cream", { shadow: 0.4, wobble: 0 });
      P.line([[cx + 3.15 + f, cy + 3.3], [cx + 3.15 + f, cy + 4.6]], 0.22, "ink", { shadow: 0, wobble: 0 });
      eyes(P, pose.front ? [[cx - 1.6, cy - 1], [cx + 2, cy - 1]] : [[cx + 0.3, cy - 1.2], [cx + 3.3, cy - 1.5]], pose.eyes ?? "open");
      mouth(P, cx + 2.2 + f, cy + 2.9, pose.mouth === "smile" ? "none" : pose.mouth);
    }
  };
  var OTTER = {
    id: "otter",
    h: 24,
    fur: "otter",
    light: fur("otterFace"),
    paw: mix(fur("otterFace"), fur("otter"), 0.15),
    dark: shade(fur("otter"), -0.08),
    body: { cx: 0, cy: -9.4, rx: 4.5, ry: 7.2, pear: 0.1 },
    head: { cx: 1.3, cy: -18.4, rx: 4.9, ry: 4.6 },
    shoulder: [0.8, -13.2],
    hip: [0, -4.5],
    arm: { len: 5.6, w: 2, hand: 1.1 },
    foot: { rx: 2.1, ry: 1, gap: 2.2 },
    scarfY: -13.6,
    scarfW: 8.6,
    drawTail(P, d, pose) {
      const a = (pose.tail ?? 0) * (Math.PI / 180);
      const path = xf([[-2.6, -4.5], [-6.5, -2.6], [-10.5, -1.1], [-14.2, -0.6]], 0, 0, a);
      P.piece(strip(path, (t) => 3.2 - t * 2.3), d.dark, { shadow: 1, rim: 0.5 });
    },
    drawEars(P, d, _pose, back) {
      if (back) P.piece(circle(d.head.cx - 3.2, d.head.cy - 3.1, 1.1, 10), d.dark, { shadow: 0.5 });
      else P.piece(circle(d.head.cx + 2.4, d.head.cy - 4, 1, 10), "otter", { shadow: 0.5, rim: 0.5 });
    },
    drawFace(P, d, pose) {
      const { cx, cy } = d.head;
      const f = pose.front ? -1.5 : 0;
      P.piece(ellipse(cx + 1.7 + f, cy + 1.3, 3.9, 2.9, 18), d.light, { shadow: 0.4 });
      P.piece(ellipse(cx + 4 + f, cy + 0, 1.15, 0.85, 12), "ink", { shadow: 0, wobble: 0 });
      for (const dy of [-0.2, 0.9]) {
        P.line([[cx + 4.3 + f, cy + 1 + dy], [cx + 7.4 + f, cy + 0.3 + dy * 1.6]], 0.22, "ink", { shadow: 0, wobble: 0, alpha: 0.75 });
      }
      eyes(P, pose.front ? [[cx - 1.4, cy - 1.2], [cx + 1.8, cy - 1.2]] : [[cx + 0.4, cy - 1.4], [cx + 3, cy - 1.6]], pose.eyes ?? "open", 0.72);
      mouth(P, cx + 2.6 + f, cy + 2.6, pose.mouth, 1.4);
    },
    drawBodyExtra(P, d) {
      P.piece(ellipse(d.body.cx + 1.6, d.body.cy + 0.5, 2.8, 5.6, 18), d.light, { shadow: 0.3 });
    }
  };
  var FROG = {
    id: "frog",
    h: 18,
    fur: "frog",
    light: mix(fur("frog"), tok("cream"), 0.55),
    paw: mix(fur("frog"), tok("cream"), 0.62),
    dark: shade(fur("frog"), -0.12),
    body: { cx: 0, cy: -6.4, rx: 6, ry: 5.6, pear: 0.18 },
    head: { cx: 1.2, cy: -11.2, rx: 5.6, ry: 4.3 },
    shoulder: [1.6, -7.6],
    hip: [-1, -3],
    arm: { len: 4.2, w: 1.8, hand: 1.15 },
    foot: { rx: 3, ry: 0.9, gap: 2.8 },
    scarfY: -8.2,
    scarfW: 9.6,
    drawTail(P, d) {
      P.piece(xf(ellipse(0, 0, 3.6, 2.3, 18), -3.6, -2.8, -0.35), d.dark, { shadow: 1, rim: 0.5 });
    },
    drawEars(P, d, pose, back) {
      const { cx, cy } = d.head;
      const pts = pose.front ? [[cx - 2.4, cy - 4], [cx + 2.6, cy - 4]] : [[cx - 1.4, cy - 4.2], [cx + 3.4, cy - 4.4]];
      const p = back ? pts[0] : pts[1];
      P.piece(circle(p[0], p[1], 2.15, 16), "frog", { shadow: 0.7, rim: 0.7 });
      P.piece(circle(p[0] + 0.1, p[1] - 0.1, 1.35, 14), "cream", { shadow: 0, wobble: 0 });
      const kind = pose.eyes ?? "open";
      if (kind === "closed" || kind === "happy") {
        P.piece(ellipse(p[0], p[1] - 0.2, 1.45, 1.3, 12), "frog", { shadow: 0, wobble: 0 });
        eyes(P, [[p[0], p[1] + 0.2]], kind);
      } else eyes(P, [[p[0] + 0.35, p[1]]], kind, 0.72);
    },
    drawFace(P, d, pose) {
      const { cx, cy } = d.head;
      const f = pose.front ? -1.8 : 0;
      if (pose.mouth === "open" || pose.mouth === "o") mouth(P, cx + 2.6 + f, cy + 1.6, "open", 2.4);
      else P.line([[cx + 0.4 + f, cy + 1.6], [cx + 3 + f, cy + 2.3], [cx + 5.4 + f, cy + 1.2]], 0.42, mix(tok("ink"), tok("frog"), 0.3), { shadow: 0, wobble: 0 });
      P.piece(circle(cx - 1.5, cy + 0.3, 0.7, 8), d.dark, { shadow: 0, wobble: 0, alpha: 0.7 });
    },
    drawBodyExtra(P, d) {
      P.piece(ellipse(d.body.cx + 2, d.body.cy + 1.2, 3.2, 3.6, 16), d.light, { shadow: 0.3 });
      P.piece(circle(d.body.cx - 2.6, d.body.cy - 2.2, 0.9, 8), d.dark, { shadow: 0, wobble: 0.3 });
      P.piece(circle(d.body.cx - 3.6, d.body.cy + 0.6, 0.7, 8), d.dark, { shadow: 0, wobble: 0.3 });
    }
  };
  var HARE = {
    id: "hare",
    h: 28,
    fur: "hare",
    light: mix(fur("hare"), tok("cream"), 0.55),
    paw: mix(fur("hare"), tok("woodDark"), 0.42),
    dark: shade(fur("hare"), -0.12),
    body: { cx: 0, cy: -8.6, rx: 4.7, ry: 6.4, pear: 0.14 },
    head: { cx: 1.3, cy: -16.4, rx: 4.6, ry: 4.3 },
    shoulder: [0.7, -12.2],
    hip: [0, -4],
    arm: { len: 5.2, w: 1.9, hand: 1.05 },
    foot: { rx: 3, ry: 1, gap: 2 },
    scarfY: -12.2,
    scarfW: 8.8,
    drawTail(P, d) {
      P.piece(circle(-4.9, -6, 2, 14), d.light, { shadow: 0.9, rim: 0.6 });
    },
    drawEars(P, d, pose, back) {
      const { cx, cy } = d.head;
      const droop = pose.eyes === "worried" || pose.lie ? 0.9 : pose.eyes === "closed" ? 0.5 : 0;
      if (back) {
        const path = [[cx - 1.4, cy - 2.6], [cx - 2.8 - droop * 3, cy - 7.5 + droop * 2], [cx - 3.8 - droop * 6, cy - 11.4 + droop * 5]];
        P.piece(strip(path, (t) => 2.7 - t * 1), d.dark, { shadow: 0.7 });
      } else {
        const path = [[cx + 0.4, cy - 2.9], [cx + 0.2 - droop * 3, cy - 7.8 + droop * 2.2], [cx - 0.4 - droop * 6.5, cy - 11.8 + droop * 5.5]];
        P.piece(strip(path, (t) => 2.8 - t * 1), "hare", { shadow: 0.8, rim: 0.6 });
        P.piece(strip(path.map(([x, y]) => [x + 0.15, y + 0.6]).slice(0, 3), (t) => 1.1 - t * 0.5), mix(tok("hare"), tok("scarf0"), 0.35), { shadow: 0, wobble: 0.3 });
      }
    },
    drawFace(P, d, pose) {
      const { cx, cy } = d.head;
      const f = pose.front ? -1.4 : 0;
      P.piece(ellipse(cx + 2.6 + f, cy + 1.4, 2.1, 1.7, 14), d.light, { shadow: 0.3 });
      P.piece(ellipse(cx + 4 + f, cy + 0.5, 0.75, 0.6, 10), mix(tok("scarf0"), tok("ink"), 0.25), { shadow: 0, wobble: 0 });
      eyes(P, pose.front ? [[cx - 1.4, cy - 0.9], [cx + 1.8, cy - 0.9]] : [[cx + 0.4, cy - 1.1], [cx + 3, cy - 1.3]], pose.eyes ?? "open", 0.72);
      mouth(P, cx + 2.6 + f, cy + 2.6, pose.mouth, 1.3);
    },
    drawBodyExtra(P, d) {
      P.piece(ellipse(d.body.cx + 1.5, d.body.cy + 0.8, 2.8, 4.6, 16), d.light, { shadow: 0.3 });
    }
  };
  var HEDGEHOG = {
    id: "hedgehog",
    h: 20,
    fur: "hedgehog",
    light: mix(fur("hedgehog"), tok("cream"), 0.6),
    paw: mix(fur("hedgehog"), tok("cream"), 0.7),
    dark: shade(fur("hedgehog"), -0.14),
    body: { cx: -0.4, cy: -7.4, rx: 6, ry: 6.4, pear: 0.1 },
    head: { cx: 2.6, cy: -11, rx: 4.2, ry: 3.8 },
    shoulder: [1.6, -8.6],
    hip: [0, -3.4],
    arm: { len: 4.4, w: 1.8, hand: 1.05 },
    foot: { rx: 2, ry: 1, gap: 2.4 },
    scarfY: -8.6,
    scarfW: 8.4,
    drawTail(P, d, pose) {
      const k = pose.lie ? 0.75 : 1;
      const bx = d.body.cx - 0.8;
      const by = d.body.cy - 1.2;
      const pts = [];
      const n = 17;
      for (let i = 0; i <= n; i++) {
        const th = (62 + i / n * 196) * Math.PI / 180;
        const r0 = i % 2 ? 7 : 9.8;
        pts.push([bx + Math.cos(th) * r0, by - Math.sin(th) * r0 * k]);
      }
      pts.push([bx + 1, by + 2]);
      P.piece(pts, d.dark, { shadow: 1, rim: 0.5, wobble: 0.3 });
    },
    drawEars(P, d, _pose, back) {
      if (!back) P.piece(circle(d.head.cx - 0.6, d.head.cy - 3.3, 0.9, 8), d.light, { shadow: 0.4 });
    },
    drawFace(P, d, pose) {
      const { cx, cy } = d.head;
      const f = pose.front ? -1.6 : 0;
      P.piece([[cx + 1.2 + f, cy - 1.6], [cx + 6.2 + f, cy + 0.4], [cx + 1.6 + f, cy + 2.4]], d.light, { shadow: 0.4, wobble: 0.2 });
      P.piece(circle(cx + 6.1 + f, cy + 0.4, 0.8, 10), "ink", { shadow: 0, wobble: 0 });
      eyes(P, pose.front ? [[cx - 1.2, cy - 0.8], [cx + 1.6, cy - 0.8]] : [[cx + 0.8, cy - 1], [cx + 2.8, cy - 1.2]], pose.eyes ?? "open", 0.66);
      mouth(P, cx + 3.2 + f, cy + 1.9, pose.mouth, 1.2);
    }
  };
  var SPECIES_DEFS = {
    beaver: BEAVER,
    otter: OTTER,
    frog: FROG,
    hare: HARE,
    hedgehog: HEDGEHOG
  };
  function drawProp(P, id) {
    switch (id) {
      case "saw":
        P.piece(rect(-0.8, -1.2, 1.6, 2.6), "wood", { shadow: 0.6, wobble: 0 });
        P.piece([[-0.9, 1.2], [1.3, 1.2], [1, 11], [-0.4, 11.6]], "stoneLight", { shadow: 0.7, rim: 0.6, wobble: 0.2 });
        for (let i = 0; i < 6; i++) P.piece([[1, 2.4 + i * 1.5], [2, 3 + i * 1.5], [1, 3.6 + i * 1.5]], "stoneDark", { shadow: 0, wobble: 0 });
        break;
      case "hammer":
        P.line([[0, -1], [0, 6.5]], 0.75, "wood", { shadow: 0.6 });
        P.piece(rect(-2.2, 5.6, 4.4, 2.2), "stoneDark", { shadow: 0.8, rim: 0.6, wobble: 0 });
        break;
      case "mallet":
        P.line([[0, -1], [0, 7.5]], 0.85, "wood", { shadow: 0.6 });
        P.piece(roundRect(-2.6, 6.6, 5.2, 3.2, 0.6), "woodDark", { shadow: 0.8, rim: 0.6, wobble: 0 });
        break;
      case "scroll":
        P.piece(rect(-3.2, -0.4, 6.4, 4.2), "cream", { shadow: 0.7, rim: 0.4, wobble: 0.2 });
        P.piece(roundRect(-3.6, -0.9, 7.2, 1.2, 0.6), "woodLight", { shadow: 0.4, wobble: 0 });
        P.piece(roundRect(-3.6, 3.4, 7.2, 1.2, 0.6), "woodLight", { shadow: 0.4, wobble: 0 });
        for (let i = 0; i < 3; i++) P.line([[-2.2, 0.9 + i * 0.9], [1.8, 0.9 + i * 0.9]], 0.25, "ink", { shadow: 0, wobble: 0, alpha: 0.6 });
        break;
      case "spyglass":
        P.piece(roundRect(-0.9, -1, 1.8, 6, 0.4), "wood", { shadow: 0.6, wobble: 0 });
        P.piece(roundRect(-1.2, 4.6, 2.4, 3.4, 0.4), "lampGlow", { shadow: 0.6, rim: 0.6, wobble: 0 });
        break;
      case "whistle":
        P.piece(roundRect(-0.6, -0.8, 1.2, 3.4, 0.5), "lampGlow", { shadow: 0.5, wobble: 0 });
        break;
      case "broom":
        P.line([[0, -5], [0, 9]], 0.7, "wood", { shadow: 0.6 });
        P.piece([[-1, 8.6], [1, 8.6], [2.6, 13.4], [-2.6, 13.4]], "reedTip", { shadow: 0.8, rim: 0.5 });
        P.line([[-2.4, 10.4], [2.4, 10.4]], 0.35, "woodDark", { shadow: 0, wobble: 0 });
        break;
      case "can":
        P.piece(roundRect(-2.2, 0.4, 4.4, 3.8, 0.8), "roofSlate", { shadow: 0.7, rim: 0.6, wobble: 0 });
        P.line([[2, 1.4], [5, -0.6]], 0.7, "roofSlate", { shadow: 0.4 });
        P.line([[-1.6, 0.4], [0, -1.2], [1.6, 0.4]], 0.4, "roofSlateDeep", { shadow: 0, wobble: 0 });
        break;
      case "lantern":
        P.line([[0, 0], [0, 1.6]], 0.25, "ink", { shadow: 0, wobble: 0 });
        P.piece(roundRect(-1.5, 1.6, 3, 3.6, 0.6), "lampGlow", { shadow: 0.6, wobble: 0 });
        P.piece(rect(-1.7, 1.3, 3.4, 0.7), "woodDark", { shadow: 0, wobble: 0 });
        P.piece(rect(-1.7, 5, 3.4, 0.7), "woodDark", { shadow: 0, wobble: 0 });
        break;
      case "teacup":
        P.piece(roundRect(-1.6, -1.4, 3.2, 2.4, [0, 0, 1.2, 1.2]), "cream", { shadow: 0.6, rim: 0.5, wobble: 0 });
        P.piece(rect(-1.6, -1.6, 3.2, 0.5), "scarf1", { shadow: 0, wobble: 0 });
        break;
      case "plank":
        P.piece(rect(-1, -7, 2, 14), "woodLight", { shadow: 0.8, rim: 0.6, wobble: 0.3 });
        break;
      case "sack":
        P.piece(roundRect(-3.6, -1, 7.2, 7.4, 2.6), mix(tok("reedTip"), tok("cream"), 0.45), { shadow: 1, rim: 0.7 });
        P.line([[-1.4, 0.2], [1.4, 0.2]], 0.5, "woodDark", { shadow: 0, wobble: 0 });
        break;
      case "roller":
        P.line([[0, -0.5], [0, 4.5]], 0.7, "wood", { shadow: 0.6 });
        P.piece(roundRect(-3, 4.2, 6, 2.4, 1.1), "ink", { shadow: 0.7, rim: 0.4, wobble: 0 });
        break;
      case "basket":
        P.piece(roundRect(-3.2, 1, 6.4, 4, [0, 0, 1.6, 1.6]), "reedTip", { shadow: 0.8, rim: 0.6 });
        P.line([[-2.8, 1.2], [0, -1.2], [2.8, 1.2]], 0.45, "wood", { shadow: 0.4, wobble: 0 });
        for (const c of ["leafAmber", "leafRust", "scarf3"]) P.dot(-1.6 + ["leafAmber", "leafRust", "scarf3"].indexOf(c) * 1.6, 0.6, 0.9, c, 0.3);
        break;
      case "rope":
        P.line([[0, -1], [0, 16]], 0.85, mix(tok("reedTip"), tok("cream"), 0.3), { shadow: 0.3, wobble: 0 });
        break;
      default:
        break;
    }
  }
  function drawExtra(P, d, e, pose) {
    const top = -d.h;
    switch (e) {
      case "cloud": {
        const cy = -Math.max(d.h + 7, 31);
        const cx = 0.6;
        const k = 1.15;
        const lobes = (grow) => [
          ellipse(cx, cy + 1 * k, 6.4 * k + grow, 2.3 * k + grow, 18),
          circle(cx - 2.2 * k, cy - 0.4 * k, 2.6 * k + grow, 14),
          circle(cx + 1.8 * k, cy - 1 * k, 3.1 * k + grow, 14)
        ];
        for (const l of lobes(0.9)) P.piece(l, "cream", { shadow: 0.6, wobble: 0.3 });
        const [a, b, c] = lobes(0);
        P.piece(a, "worrySlate", { shadow: 0.5, rim: 0.6 });
        P.piece(b, "worrySlate", { shadow: 0.3, rim: 0.7 });
        P.piece(c, "worrySlate", { shadow: 0.3, rim: 0.7 });
        for (const [x, y] of [[-3, 4.2], [0, 5.2], [3, 4.4]]) P.line([[cx + x * k, cy + y * k], [cx + x * k - 0.6, cy + y * k + 2.2]], 0.7, "river", { shadow: 0, wobble: 0 });
        break;
      }
      case "zzz": {
        const x0 = 4;
        const y0 = top - 1;
        const z = (x, y, s) => P.piece(
          [
            [x, y],
            [x + s, y],
            [x + s, y + s * 0.28],
            [x + s * 0.32, y + s * 0.78],
            [x + s, y + s * 0.78],
            [x + s, y + s * 1.06],
            [x, y + s * 1.06],
            [x, y + s * 0.78],
            [x + s * 0.68, y + s * 0.28],
            [x, y + s * 0.28]
          ],
          "cream",
          { shadow: 0.9, wobble: 0.15 }
        );
        z(x0, y0 - 2, 2.6);
        z(x0 + 3.2, y0 - 6.2, 3.4);
        z(x0 + 7.4, y0 - 11.2, 4.2);
        break;
      }
      case "check": {
        const x = d.id === "hedgehog" ? -13 : -9.5;
        P.line([[x, 0], [x, -8]], 0.8, "wood", { shadow: 0.7 });
        P.piece(roundRect(x - 3.6, -13.6, 7.2, 6.2, 0.9), "yourTurnSage", { shadow: 1, rim: 0.7 });
        P.line([[x - 1.9, -10.6], [x - 0.5, -9], [x + 2, -12.2]], 0.95, "ink", { shadow: 0, wobble: 0 });
        break;
      }
      case "stone":
        P.piece(ellipse(8.5, -2.2, 3.6, 2.4, 16), "stone", { shadow: 1, rim: 0.7 });
        P.line([[7.6, -4.4], [8.4, -2.4], [7.9, -0.8]], 0.3, "stoneDark", { shadow: 0, wobble: 0 });
        break;
      case "pile":
        for (let i = 0; i < 3; i++) P.piece(rect(-10.5 + i * 0.6, -1.2 - i * 1.2, 7, 1.1), i % 2 ? "woodLight" : "wood", { shadow: 0.7, rim: 0.4 });
        break;
      case "press": {
        const x = 11.5;
        P.piece(rect(x - 3.4, -5.2, 6.8, 5.2), "woodDark", { shadow: 1, rim: 0.6 });
        P.piece(rect(x - 2.8, -6.4, 5.6, 1.4), "cream", { shadow: 0.6, wobble: 0 });
        P.line([[x - 2, -5.8], [x + 2, -5.8]], 0.3, "ink", { shadow: 0, wobble: 0 });
        break;
      }
      case "groundlantern":
        P.piece(roundRect(6.2, -4.6, 3, 3.6, 0.6), "lampGlow", { shadow: 0.6, wobble: 0 });
        P.piece(rect(6, -4.9, 3.4, 0.7), "woodDark", { shadow: 0, wobble: 0 });
        P.piece(rect(6, -1.2, 3.4, 0.7), "woodDark", { shadow: 0, wobble: 0 });
        break;
      case "question":
        break;
    }
    void pose;
  }
  var DEG = Math.PI / 180;
  function egg(cx, cy, rx, ry, pear) {
    const pts = ellipse(cx, cy, rx, ry, 28);
    return pts.map(([x, y]) => [cx + (x - cx) * (1 + pear * ((y - cy) / ry)), y]);
  }
  function drawArm(P, d, angle, sh, fill, prop, propAngle = 0, mirror = false) {
    const a = (mirror ? -angle : angle) * DEG;
    P.at(sh[0], sh[1], -a, () => {
      P.piece(roundRect(-d.arm.w / 2, -d.arm.w / 2, d.arm.w, d.arm.len + d.arm.w / 2, d.arm.w / 2), fill, { shadow: 1.3, wobble: 0.25 });
      P.piece(circle(0, d.arm.len, d.arm.hand, 12), d.paw, { shadow: 0.8, wobble: 0.2 });
      if (prop && prop !== "none") P.at(0, d.arm.len, propAngle * DEG, () => drawProp(P, prop));
    });
  }
  function drawResident(P, species, pose, mode = "base") {
    const d = SPECIES_DEFS[species];
    const ctx = P.ctx;
    const steps = [];
    const add = (fn, scarf = false) => steps.push({ scarf, fn });
    const lift = pose.lift ?? 0;
    const sitDrop = pose.sit ? (d.hip[1] + 1.2) * -1 * 0.6 : 0;
    const lean = (pose.lean ?? 0) * DEG;
    if (pose.lie) {
      drawLying(P, d, pose, mode);
      return;
    }
    const bodyAt = (fn) => P.at(0, lift + sitDrop, 0, () => P.at(d.hip[0], d.hip[1], lean, () => P.at(-d.hip[0], -d.hip[1], 0, fn)));
    if (pose.extras?.includes("check")) add(() => drawExtra(P, d, "check", pose));
    if (pose.extras?.includes("pile")) add(() => drawExtra(P, d, "pile", pose));
    const backSh = pose.front ? [d.body.cx - d.body.rx * 0.62, d.shoulder[1] + 0.4] : [d.shoulder[0] - 1.2, d.shoulder[1] + 0.2];
    const foreSh = pose.front ? [d.body.cx + d.body.rx * 0.62, d.shoulder[1] + 0.4] : d.shoulder;
    add(() => bodyAt(() => drawArm(P, d, pose.back, backSh, d.dark, pose.propBack, 0, !!pose.front)));
    const feet = (fore) => {
      const step = fore ? pose.stepFore ?? 0 : pose.stepBack ?? 0;
      const up = fore ? pose.liftFore ?? 0 : pose.liftBack ?? 0;
      const gx = (fore ? d.foot.gap / 2 : -d.foot.gap / 2) + step;
      const fy = pose.sit ? -0.9 : -d.foot.ry - up + lift;
      const fx = pose.sit ? gx + 3.2 : gx;
      const col = fore ? tok(d.fur) : d.dark;
      P.at(0, sitDrop * 0.2, 0, () => {
        if (!pose.sit) P.line([[gx * 0.5, d.hip[1] + lift], [fx, fy]], d.foot.ry * 1.7, col, { shadow: 0.5 });
        P.piece(ellipse(fx + 0.8, fy, d.foot.rx, d.foot.ry, 14), col, { shadow: 0.8, wobble: 0.2 });
      });
    };
    add(
      () => bodyAt(() => {
        const [sx, sy] = [d.body.cx - d.scarfW * 0.32, d.scarfY + 0.6];
        P.piece(
          [
            [sx + 1, sy - 0.6],
            [sx - 1.6, sy + 3.6],
            [sx - 3.2, sy + 6.2],
            [sx - 1.4, sy + 6.6],
            [sx + 1.2, sy + 1.4]
          ],
          "cream",
          { shadow: 0.7, wobble: 0.3 }
        );
      }),
      true
    );
    add(() => d.drawTail(P, d, pose));
    add(() => feet(false));
    add(
      () => bodyAt(() => {
        P.piece(egg(d.body.cx, d.body.cy, d.body.rx, d.body.ry, d.body.pear), d.fur, { shadow: 1, rim: 0.8 });
        if (d.drawBodyExtra) d.drawBodyExtra(P, d, pose);
        else P.piece(ellipse(d.body.cx + 1.5, d.body.cy + 1, d.body.rx * 0.55, d.body.ry * 0.62, 18), d.light, { shadow: 0.3 });
      })
    );
    add(() => feet(true));
    const headAt = (fn) => bodyAt(() => P.at(d.head.cx - 1, d.head.cy + d.head.ry * 0.8, (pose.headTilt ?? 0) * DEG, () => P.at(-(d.head.cx - 1), -(d.head.cy + d.head.ry * 0.8), 0, fn)));
    add(() => headAt(() => d.drawEars(P, d, pose, true)));
    add(
      () => bodyAt(() => {
        P.piece(roundRect(d.body.cx - d.scarfW / 2, d.scarfY - 1.25, d.scarfW, 2.6, 1.2), "cream", { shadow: 1, rim: 0.6, wobble: 0.3 });
        P.piece(roundRect(d.body.cx + d.scarfW * 0.12, d.scarfY, 2.2, 3.6, 0.8), "cream", { shadow: 0.8, wobble: 0.3 });
      }),
      true
    );
    add(
      () => headAt(() => {
        const h = d.head;
        P.piece(ellipse(h.cx, h.cy, h.rx, h.ry, 26), d.fur, { shadow: 1, rim: 1 });
        d.drawEars(P, d, pose, false);
        d.drawFace(P, d, pose);
      })
    );
    add(() => bodyAt(() => drawArm(P, d, pose.fore, foreSh, shade(tok(d.fur), -0.035), pose.prop, pose.propAngle ?? 0)));
    if (pose.front && pose.back > 100) add(() => bodyAt(() => drawArm(P, d, pose.back, backSh, shade(tok(d.fur), -0.07), pose.propBack, 0, true)));
    for (const e of pose.extras ?? []) if (e !== "check" && e !== "pile") add(() => drawExtra(P, d, e, pose));
    runSteps(P, steps, mode, d.h);
    void ctx;
  }
  function runSteps(P, steps, mode, h) {
    const ctx = P.ctx;
    if (mode === "base") {
      for (const s of steps) s.fn();
      P.grain(-24, -h - 20, 50, h + 24);
      return;
    }
    const prevFlat = P.flat;
    const prevGain = P.shadowGain;
    P.shadowGain = 0;
    let seen = false;
    for (const s of steps) {
      ctx.save();
      P.flat = WHITE;
      if (s.scarf) {
        seen = true;
        ctx.globalCompositeOperation = "source-over";
      } else if (seen) ctx.globalCompositeOperation = "destination-out";
      else ctx.globalAlpha = 0;
      s.fn();
      ctx.restore();
    }
    P.flat = prevFlat;
    P.shadowGain = prevGain;
    P.grain(-24, -h - 20, 50, h + 24);
  }
  var WHITE = PAL.maskWhite;
  function drawLying(P, d, pose, mode) {
    const len = d.body.ry * 1.25;
    const hgt = d.body.rx * 0.95;
    const hx = len * 0.95;
    const hy = -d.head.ry * 0.95;
    const closed = { ...pose, eyes: "closed", mouth: "none" };
    const headAt = (fn) => P.at(hx - d.head.cx, hy - d.head.cy, 0.25, fn);
    const steps = [
      { scarf: false, fn: () => P.at(1.5, 0, 0, () => d.drawTail(P, d, { ...pose, tail: 40 })) },
      {
        scarf: false,
        fn: () => {
          P.piece(ellipse(0, -hgt, len, hgt, 26), d.fur, { shadow: 1, rim: 0.8 });
          P.piece(ellipse(1, -hgt * 0.7, len * 0.7, hgt * 0.5, 20), d.light, { shadow: 0.3 });
        }
      },
      { scarf: false, fn: () => headAt(() => d.drawEars(P, d, closed, true)) },
      {
        scarf: true,
        fn: () => headAt(() => P.piece(roundRect(d.head.cx - d.scarfW / 2 - 2, d.head.cy + d.head.ry * 0.55, d.scarfW, 2.5, 1.1), "cream", { shadow: 0.8 }))
      },
      {
        scarf: false,
        fn: () => headAt(() => {
          P.piece(ellipse(d.head.cx, d.head.cy, d.head.rx, d.head.ry, 24), d.fur, { shadow: 1, rim: 1 });
          d.drawEars(P, d, closed, false);
          d.drawFace(P, d, closed);
        })
      },
      { scarf: false, fn: () => {
        for (const e of pose.extras ?? []) drawExtra(P, { ...d, h: d.h * 0.55 }, e, pose);
      } }
    ];
    runSteps(P, steps, mode, d.h);
  }
  function posesFor(species) {
    const sig = signature(species);
    return {
      "stand-0": { back: 8, fore: -6, eyes: "open" },
      "stand-1": { back: 10, fore: -4, eyes: "closed" },
      "walk-0": { back: -25, fore: 25, stepBack: -1.4, stepFore: 1.4, lift: -0.4 },
      "walk-1": { back: 25, fore: -25, stepBack: 1.2, stepFore: -1.2, liftFore: 0.8 },
      "run-0": { lean: 14, back: -50, fore: 60, stepBack: -2.6, stepFore: 2.8, lift: -1.2, liftBack: 1.4, eyes: "wide", mouth: "o" },
      "run-1": { lean: 16, back: 45, fore: -40, stepBack: 2.2, stepFore: -2, lift: -0.2, liftFore: 1.2, eyes: "wide", mouth: "o" },
      "run-2": { lean: 12, back: -20, fore: 20, stepBack: -0.8, stepFore: 0.8, lift: -1.8, liftBack: 0.8, liftFore: 0.8, eyes: "wide", mouth: "o" },
      // alert anticipation: freeze and turn to camera (SPEC 3.5)
      "turn-0": { front: true, back: 35, fore: 35, eyes: "wide", mouth: "o", lift: -0.6 },
      // needs_you: pulling the bell rope with one arm high, the other flung out
      "ring-0": { front: true, back: 118, fore: 158, prop: "rope", propAngle: -10, eyes: "wide", mouth: "open", lean: -6 },
      "ring-1": { front: true, back: 96, fore: 140, prop: "rope", propAngle: -30, eyes: "wide", mouth: "open", lean: -2, lift: -0.8 },
      // finished: hop and cheer
      "cheer-0": { front: true, back: 138, fore: 138, lift: -4.2, eyes: "happy", mouth: "open", liftBack: 0.6, liftFore: 0.6 },
      "cheer-1": { front: true, back: 120, fore: 125, lift: -1, eyes: "happy", mouth: "open" },
      // your_turn: sits by the door with a lit lantern and a check sign
      "sit-lantern-0": { sit: true, back: 20, fore: 95, prop: "lantern", propAngle: 95, eyes: "open", mouth: "smile", extras: ["check"] },
      // error: head in hands under a small rain cloud
      "worried-0": { front: true, back: 158, fore: 158, headTilt: 12, lean: 4, eyes: "worried", mouth: "o", extras: ["cloud"] },
      "worried-1": { front: true, back: 150, fore: 162, headTilt: 6, lean: 2, eyes: "worried", mouth: "o", extras: ["cloud"] },
      // limited: sits with a teacup, dozing, zzz
      "tea-0": { sit: true, back: 30, fore: 62, prop: "teacup", propAngle: 62, eyes: "closed", headTilt: 10, extras: ["zzz"] },
      // idle: sweeping
      "sweep-0": { back: 70, fore: 40, prop: "broom", propAngle: 20, lean: 10, headTilt: 10 },
      "sweep-1": { back: 50, fore: 20, prop: "broom", propAngle: 5, lean: 6, headTilt: 12 },
      // idle: gardening with a watering can
      "garden-0": { back: 20, fore: 70, prop: "can", propAngle: 70, lean: 6 },
      "garden-1": { back: 20, fore: 80, prop: "can", propAngle: 110, lean: 10 },
      // idle evening: sits by the campfire
      "sit-0": { sit: true, back: 40, fore: 50, eyes: "open", mouth: "smile" },
      // asleep: lying down
      "sleep-0": { lie: true, back: 0, fore: 0, eyes: "closed", extras: ["zzz"] },
      // starting: stretch and yawn
      "stretch-0": { front: true, back: 172, fore: 172, eyes: "closed", mouth: "o", lift: -0.6 },
      // activity variants from the tool name (SPEC 4.2)
      "hammer-0": { lean: 10, back: 30, fore: 165, prop: "hammer", propAngle: 0 },
      "hammer-1": { lean: 16, back: 30, fore: 85, prop: "hammer", propAngle: 10 },
      "saw-0": { lean: 14, back: 70, fore: 95, prop: "saw", propAngle: -10, extras: ["pile"] },
      "saw-1": { lean: 18, back: 80, fore: 75, prop: "saw", propAngle: 0, extras: ["pile"] },
      "read-0": { back: 85, fore: 95, prop: "scroll", propAngle: 95, headTilt: 12 },
      "spyglass-0": { back: 20, fore: 120, prop: "spyglass", propAngle: 30, lean: -4 },
      "whistle-0": { front: true, back: 90, fore: 150, prop: "whistle", propAngle: 150, eyes: "closed", lift: -0.6 },
      "carry-0": { back: 170, fore: 170, prop: "plank", propAngle: 90, stepBack: -1, stepFore: 1 },
      "carry-1": { back: 170, fore: 170, prop: "plank", propAngle: 90, stepBack: 1, stepFore: -1, lift: -0.5 },
      // the species' signature work loop (SPEC 4.2)
      "work-0": sig[0],
      "work-1": sig[1]
    };
  }
  function signature(species) {
    switch (species) {
      case "beaver":
        return [
          { lean: 14, back: 70, fore: 95, prop: "saw", propAngle: -10, extras: ["pile"] },
          { lean: 18, back: 80, fore: 75, prop: "saw", propAngle: 0, extras: ["pile"] }
        ];
      case "otter":
        return [
          { lean: -4, back: 150, fore: 175, prop: "mallet", propAngle: 0, extras: ["stone"] },
          { lean: 20, back: 70, fore: 80, prop: "mallet", propAngle: 20, extras: ["stone"] }
        ];
      case "frog":
        return [
          { lean: 12, back: 60, fore: 105, prop: "roller", propAngle: 55, extras: ["press"] },
          { lean: 18, back: 70, fore: 85, prop: "roller", propAngle: 45, extras: ["press"] }
        ];
      case "hare":
        return [
          { lean: 16, back: 165, fore: 150, propBack: "sack", prop: "none", stepBack: -1.2, stepFore: 1.2 },
          { lean: 18, back: 165, fore: 150, propBack: "sack", prop: "none", stepBack: 1.2, stepFore: -1.2, lift: -0.6 }
        ];
      default:
        return [
          { back: 70, fore: 70, prop: "basket", propAngle: 70, stepBack: -1, stepFore: 1 },
          { back: 70, fore: 70, prop: "basket", propAngle: 70, stepBack: 1, stepFore: -1, lift: -0.5 }
        ];
    }
  }
  function residentBounds(species) {
    const h = SPECIES_DEFS[species].h;
    return { x0: -20, y0: -h - 18, x1: 22, y1: 2 };
  }

  // src/props.ts
  function autumnTree(P, h, seed, palette = 0) {
    const r = rng(seed);
    const trunkW = h * 0.09;
    P.piece([[-trunkW, 0], [-trunkW * 0.6, -h * 0.5], [trunkW * 0.6, -h * 0.5], [trunkW, 0]], "woodDark", { shadow: 1, rim: 0.4 });
    P.line([[0, -h * 0.42], [-h * 0.16, -h * 0.62]], trunkW * 0.7, "woodDark", { shadow: 0.8 });
    P.line([[0, -h * 0.46], [h * 0.14, -h * 0.66]], trunkW * 0.6, "woodDark", { shadow: 0.8 });
    const tones = [
      ["leafRust", "leafAmber", "scarf2"],
      ["leafAmber", "scarf2", "leafRust"],
      ["meadow", "leafAmber", "scarf2"]
    ];
    const [a, b, c] = tones[palette];
    const cy = -h * 0.66;
    const R = h * 0.34;
    P.piece(blob(0, cy, R, R * 0.92, hash(seed, 1), 8, 0.28), shade(tok(a), -0.04), { shadow: 1.2, rim: 1 });
    P.piece(blob(-R * 0.28, cy - R * 0.22, R * 0.7, R * 0.62, hash(seed, 2), 7, 0.3), b, { shadow: 1, rim: 1 });
    P.piece(blob(R * 0.3, cy + R * 0.05, R * 0.56, R * 0.5, hash(seed, 3), 6, 0.3), mix(tok(c), tok(b), 0.4), { shadow: 1, rim: 1 });
    P.piece(blob(-R * 0.05, cy - R * 0.55, R * 0.42, R * 0.34, hash(seed, 4), 6, 0.3), mix(tok(b), tok("lampGlow"), 0.25), { shadow: 0.9, rim: 1 });
    for (let i = 0; i < 5; i++) P.piece(ellipse(range(r, -R, R), -0.3, 0.9, 0.45, 8), r() < 0.5 ? a : b, { shadow: 0.4, wobble: 0 });
    P.grain(-R * 1.4, -h - 4, R * 2.8, h + 6);
  }
  function winterTree(P, h, seed) {
    const r = rng(seed);
    const trunkW = h * 0.08;
    P.piece([[-trunkW, 0], [-trunkW * 0.5, -h * 0.6], [trunkW * 0.5, -h * 0.6], [trunkW, 0]], "woodDark", { shadow: 1, rim: 0.4 });
    const branch = (x, y, ang, len, w, depth) => {
      const x2 = x + Math.sin(ang) * len;
      const y2 = y - Math.cos(ang) * len;
      P.line([[x, y], [x2, y2]], w, "woodDark", { shadow: 0.7 });
      if (depth > 0) {
        branch(x2, y2, ang - range(r, 0.3, 0.6), len * 0.68, w * 0.62, depth - 1);
        branch(x2, y2, ang + range(r, 0.3, 0.6), len * 0.68, w * 0.62, depth - 1);
      } else P.piece(ellipse(x2, y2 - 0.2, w * 2.2, w * 1.1, 8), "snow", { shadow: 0.4, wobble: 0.3 });
    };
    branch(0, -h * 0.55, -0.15, h * 0.26, trunkW * 1.1, 3);
    branch(0, -h * 0.45, 0.55, h * 0.2, trunkW * 0.8, 2);
    branch(0, -h * 0.4, -0.7, h * 0.18, trunkW * 0.7, 2);
    P.grain(-h * 0.6, -h - 4, h * 1.2, h + 6);
  }
  function conifer(P, h, seed, season) {
    P.piece(rect(-h * 0.05, -h * 0.18, h * 0.1, h * 0.2), "woodDark", { shadow: 0.8 });
    const tiers = 4;
    for (let i = 0; i < tiers; i++) {
      const t0 = -h * (0.14 + i * 0.2);
      const w = h * (0.36 - i * 0.065);
      const top = t0 - h * 0.34;
      const pts = [[-w, t0], [-w * 0.5, t0 - h * 0.05], [0, top], [w * 0.5, t0 - h * 0.05], [w, t0]];
      P.piece(pts, i % 2 ? "conifer" : "coniferLight", { shadow: 1.1, rim: 0.8 });
      if (season === "winter") snowOn(P, [[-w * 0.55, t0 - h * 0.08], [0, top], [w * 0.55, t0 - h * 0.08]], h * 0.05);
    }
    void seed;
    P.grain(-h * 0.4, -h - 2, h * 0.8, h + 4);
  }
  function villageTree(P, h, seed, season, kind) {
    if (kind === "conifer") return conifer(P, h, seed, season);
    if (season === "winter") return winterTree(P, h, seed);
    autumnTree(P, h, seed, seed % 3);
  }
  function fruitTree(P, h, seed, season) {
    if (season === "winter") return winterTree(P, h, seed);
    const r = rng(seed);
    P.piece([[-1.3, 0], [-0.9, -h * 0.42], [0.9, -h * 0.42], [1.3, 0]], "wood", { shadow: 1, rim: 0.4 });
    const cy = -h * 0.64;
    const R = h * 0.36;
    const green = mix(tok("meadow"), tok("leafAmber"), 0.25 + seed % 3 * 0.12);
    P.piece(blob(0, cy, R, R * 0.86, hash(seed, 1), 7, 0.22), shade(green, -0.05), { shadow: 1.1, rim: 1 });
    P.piece(blob(-R * 0.2, cy - R * 0.18, R * 0.66, R * 0.56, hash(seed, 2), 6, 0.25), green, { shadow: 0.8, rim: 1 });
    for (let i = 0; i < 9; i++) {
      const a = range(r, 0, Math.PI * 2);
      const d = range(r, 0.2, 0.85) * R;
      P.dot(Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, range(r, 0.7, 0.95), i % 3 ? "leafRust" : "errorCoral", 0.5);
    }
    P.grain(-R * 1.3, -h - 3, R * 2.6, h + 5);
  }
  function bush(P, w, seed, season) {
    const fill = season === "winter" ? mix(tok("conifer"), tok("snow"), 0.15) : mix(tok("bank"), tok("leafAmber"), seed % 4 * 0.12);
    P.piece(blob(0, -w * 0.32, w / 2, w * 0.34, seed, 6, 0.3, true), fill, { shadow: 1, rim: 0.9 });
    if (season === "winter") snowOn(P, [[-w * 0.38, -w * 0.48], [0, -w * 0.66], [w * 0.38, -w * 0.48]], w * 0.08);
    P.grain(-w * 0.6, -w * 0.8, w * 1.2, w);
  }
  function decoration(P, kind, seed, season) {
    const r = rng(seed);
    switch (kind) {
      case "bench":
        P.piece(rect(-6, -4.2, 12, 1.4), "wood", { shadow: 1, rim: 0.6 });
        P.piece(rect(-6, -8, 12, 1.2), "wood", { shadow: 0.8, rim: 0.5 });
        for (const x of [-5, 4]) P.piece(rect(x, -8, 1, 8), "woodDark", { shadow: 0.7 });
        if (season === "winter") snowOn(P, [[-6, -4.2], [6, -4.2]], 0.7);
        break;
      case "lamppost":
        P.piece(rect(-0.6, -16, 1.2, 16), "ink", { shadow: 0.9 });
        P.piece(rect(-2, -20, 4, 4.4), mix(tok("ink"), tok("lampGlow"), 0.35), { shadow: 0.8, wobble: 0 });
        P.piece([[-2.6, -20], [0, -22.4], [2.6, -20]], "ink", { shadow: 0.6, wobble: 0 });
        break;
      case "flowers":
        for (let i = 0; i < 6; i++) {
          const x = range(r, -5, 5);
          const h = range(r, 2.5, 5);
          P.line([[x, 0], [x, -h]], 0.4, "bank", { shadow: 0 });
          P.dot(x, -h, 0.9, ["scarf0", "scarf2", "scarf4", "cream"][i % 4], 0.5);
        }
        break;
      case "birdhouse":
        P.piece(rect(-0.5, -14, 1, 14), "wood", { shadow: 0.8 });
        P.piece(rect(-2.6, -19, 5.2, 5), "scarf1", { shadow: 1, rim: 0.6 });
        P.piece([[-3.4, -18.6], [0, -22], [3.4, -18.6]], "roof", { shadow: 0.8, rim: 0.6 });
        P.dot(0, -16.6, 0.8, "ink");
        break;
      case "pumpkins":
        for (let i = 0; i < 3; i++) {
          const x = -4 + i * 4 + range(r, -0.5, 0.5);
          const s = range(r, 1.6, 2.4);
          P.piece(ellipse(x, -s, s * 1.3, s, 14), "leafAmber", { shadow: 1, rim: 0.7 });
          P.line([[x - s * 0.4, -s * 1.8], [x - s * 0.4, -0.3]], 0.25, shade(tok("leafAmber"), -0.12), { shadow: 0 });
          P.line([[x, -s * 2], [x + 0.4, -s * 2.5]], 0.5, "bank", { shadow: 0 });
        }
        break;
      case "snowman":
        P.piece(circle(0, -3.6, 3.8, 18), "snow", { shadow: 1, rim: 0.6 });
        P.piece(circle(0, -9.4, 2.7, 16), "snow", { shadow: 1, rim: 0.6 });
        P.piece(rect(-2.4, -10.6, 4.8, 1.2), "scarf0", { shadow: 0.6 });
        P.dot(-0.8, -10.2, 0.35, "ink");
        P.dot(0.9, -10.2, 0.35, "ink");
        P.piece([[0.2, -9.6], [2.6, -9.2], [0.2, -9]], "leafAmber", { shadow: 0, wobble: 0 });
        break;
      case "hammock":
        P.line([[-12, 0], [-12, -9]], 0.9, "woodDark", { shadow: 0.8 });
        P.line([[12, 0], [12, -9]], 0.9, "woodDark", { shadow: 0.8 });
        P.piece(strip([[-11.5, -8], [-6, -4.6], [0, -3.8], [6, -4.6], [11.5, -8]], 1.6), "scarf1", { shadow: 1 });
        break;
      case "crate":
        P.piece(rect(-3, -5, 6, 5), "woodLight", { shadow: 1, rim: 0.6 });
        P.line([[-3, -5], [3, 0]], 0.4, "wood", { shadow: 0 });
        P.line([[3, -5], [-3, 0]], 0.4, "wood", { shadow: 0 });
        break;
      case "bunting": {
        const cols = ["scarf0", "scarf1", "scarf2", "scarf3", "scarf4", "scarf5"];
        P.line([[-20, -16], [0, -13], [20, -16]], 0.25, "ink", { shadow: 0 });
        for (let i = 0; i < 9; i++) {
          const x = -18 + i * 4.5;
          const y = -16 + 3 * (1 - Math.pow(x / 20, 2));
          P.piece([[x - 1.4, y], [x + 1.4, y], [x, y + 2.8]], cols[i % 6], { shadow: 0.5, wobble: 0 });
        }
        break;
      }
    }
    P.grain(-14, -24, 28, 25);
  }
  function smokePuff(P, size, seed) {
    P.piece(blob(0, 0, size, size * 0.8, seed, 6, 0.35), "cream", { shadow: 0.4, rim: 0.4 });
  }
  function dustPuff(P, w, seed) {
    const r = rng(seed);
    for (let i = 0; i < 7; i++) {
      const x = (i - 3) * (w / 7) + range(r, -1, 1);
      const s = range(r, 2.6, 4.4);
      P.piece(blob(x, -s * 0.8 - Math.abs(i - 3) * 0.6, s, s * 0.75, hash(seed, i), 6, 0.35), mix(tok("stoneLight"), tok("cream"), 0.5), { shadow: 0.6, rim: 0.5 });
    }
  }
  function flyingPlank(P) {
    P.piece(rect(-6, -0.9, 12, 1.8), "woodLight", { shadow: 1, rim: 0.8 });
    P.line([[-4, -0.2], [4, 0.1]], 0.25, "wood", { shadow: 0, wobble: 0 });
  }
  function confetti(P, w, seed) {
    const r = rng(seed);
    const cols = ["scarf0", "scarf1", "scarf2", "scarf3", "scarf4", "alertFlag", "cream"];
    for (let i = 0; i < 22; i++) {
      const x = range(r, -w / 2, w / 2);
      const y = range(r, -w * 0.45, 0);
      P.at(x, y, range(r, 0, Math.PI), () => P.piece(rect(-0.7, -0.35, 1.4, 0.7), cols[i % cols.length], { shadow: 0.3, wobble: 0 }));
    }
  }
  function leaf(P, x, y, rot, s, t) {
    P.at(x, y, rot, () => {
      P.piece([[-s, 0], [-s * 0.3, -s * 0.5], [s, 0], [-s * 0.3, s * 0.5]], t, { shadow: 0.5, wobble: 0 });
    });
  }

  // src/alert.ts
  var FLAG_STYLE = {
    fill: "alertFlag",
    outlines: ["ink", "cream"],
    widths: [0.9, 1]
  };
  function outlined(P, pts, fill) {
    const ctx = P.ctx;
    const path = new Path2D();
    path.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
    path.closePath();
    ctx.save();
    ctx.lineJoin = "round";
    const [wIn, wOut] = FLAG_STYLE.widths;
    const outer = FLAG_STYLE.outlines[1];
    const inner = FLAG_STYLE.outlines[0];
    if (P.flat) {
      ctx.fillStyle = P.flat;
      ctx.strokeStyle = P.flat;
      ctx.lineWidth = 2 * (wIn + wOut);
      ctx.stroke(path);
      ctx.fill(path);
      ctx.restore();
      return;
    }
    ctx.strokeStyle = PALCSS(outer);
    ctx.lineWidth = 2 * (wIn + wOut);
    ctx.stroke(path);
    ctx.strokeStyle = PALCSS(inner);
    ctx.lineWidth = 2 * wIn;
    ctx.stroke(path);
    ctx.restore();
    P.piece(pts, fill, { wobble: 0, shadow: 0 });
  }
  var PALCSS = (t) => PAL[t];
  function drawFlag(P, icon, wave = 0) {
    const W = 14;
    const H = 10;
    const d = [0, 0.9, -0.7][wave % 3];
    const pts = [
      [0, 0],
      [W * 0.5, d * 0.6],
      [W, -d * 0.2],
      [W - 2.6, H / 2],
      [W, H - d * 0.2],
      [W * 0.5, H + d * 0.6],
      [0, H]
    ];
    outlined(P, pts, FLAG_STYLE.fill);
    const ink = "ink";
    if (icon === "question") {
      P.piece(rect(5.3, 1.7, 1.9, 4.5), ink, { wobble: 0, shadow: 0 });
      P.piece(rect(5.3, 7.1, 1.9, 1.7), ink, { wobble: 0, shadow: 0 });
    } else if (icon === "permission") {
      const ctx = P.ctx;
      ctx.save();
      ctx.strokeStyle = P.flat ?? PAL.ink;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(3.6, 5, 1.75, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      P.piece(rect(5.2, 4.35, 5.6, 1.3), ink, { wobble: 0, shadow: 0 });
      P.piece(rect(8.6, 5.4, 1.2, 1.8), ink, { wobble: 0, shadow: 0 });
      P.piece(rect(10.2, 5.4, 0.9, 1.4), ink, { wobble: 0, shadow: 0 });
    }
  }
  function drawFlagFurled(P) {
    P.piece(rect(0, 0, 2.4, 6), mix(tok("alertFlag"), tok("wood"), 0.35), { shadow: 0.8, rim: 0.6 });
    P.piece(rect(-0.2, 1.8, 2.8, 0.7), "woodDark", { shadow: 0, wobble: 0 });
  }
  function drawBellRest(P) {
    const brass = mix(tok("alertFlag"), tok("wood"), 0.45);
    P.piece([[-1.2, 0.6], [1.2, 0.6], [2.4, 2.2], [2.9, 5.8], [4.4, 8.2], [-4.4, 8.2], [-2.9, 5.8], [-2.4, 2.2]], brass, { shadow: 1, rim: 0.8, wobble: 0.2 });
    P.piece(rect(-3.2, 6.2, 6.4, 0.8), mix(tok("alertFlag"), tok("woodDark"), 0.6), { wobble: 0, shadow: 0 });
    P.piece(ellipse(0, 9.2, 1, 1, 10), "woodDark", { wobble: 0, shadow: 0.4 });
    P.line([[0, 9.6], [0.4, 26]], 0.7, mix(tok("reedTip"), tok("cream"), 0.3), { shadow: 0.4, wobble: 0 });
  }
  function drawBell(P, swing = 0) {
    const ctx = P.ctx;
    ctx.save();
    ctx.rotate(swing * 0.42);
    const pts = [
      [-1.2, 0.6],
      [1.2, 0.6],
      [2.4, 2.2],
      [2.9, 5.8],
      [4.4, 8.2],
      [-4.4, 8.2],
      [-2.9, 5.8],
      [-2.4, 2.2]
    ];
    outlined(P, pts, mix(tok("alertFlag"), tok("wood"), 0.25));
    P.piece(rect(-3.2, 6.2, 6.4, 0.8), mix(tok("alertFlag"), tok("woodDark"), 0.55), { wobble: 0, shadow: 0 });
    P.piece(ellipse(swing * -1.4, 9.4, 1.1, 1.1, 10), "ink", { wobble: 0, shadow: 0 });
    ctx.restore();
  }

  // src/sprites.ts
  var BELOW = /* @__PURE__ */ new Set(["jetty", "watermill", "footbridge"]);
  function structureBounds(def) {
    const y1 = BELOW.has(def.kind) ? 33 : 4;
    return [-def.w / 2 - 10, -Math.min(SIZES.structureMaxHeight + 2, def.h + 10), def.w / 2 + 10, y1];
  }
  var HELPER_POSES = ["stand-0", "walk-0", "walk-1", "carry-0", "carry-1", "work-0", "work-1", "cheer-0", "sleep-0"];
  function stripSprites(season) {
    const out = [];
    let si = 0;
    for (const def of Object.values(STRUCTURES)) {
      if (!def) continue;
      si++;
      const [x0, y0, x1, y1] = structureBounds(def);
      const stages = def.stages === 3 ? [1, 2, 3] : [1];
      for (const st of stages) {
        const seed = 1e3 + si * 10 + st;
        const o = { season, seed: si * 31 + 7, variant: 0 };
        out.push({ id: `st/${def.kind}/${st}`, x0, y0, x1, y1, seed, draw: (P) => def.draw(P, st, o) });
        if (def.kind === "cottage" && st === 3) {
          out.push({ id: `st/${def.kind}/3/v1`, x0, y0, x1, y1, seed, draw: (P) => def.draw(P, 3, { ...o, variant: 1 }) });
        }
        if (def.lit && (st === 3 || def.stages === 1)) {
          for (const f of def.kind === "campfire" ? [0, 1, 2, 3] : [0]) {
            const id = def.kind === "campfire" ? `st/${def.kind}/${st}/lit/${f}` : `st/${def.kind}/${st}/lit`;
            out.push({ id, x0, y0, x1, y1, seed, draw: (P) => def.lit(P, st, { ...o, frame: f }) });
          }
        }
      }
      if (def.part) {
        const r = def.part.r + 2;
        out.push({ id: `st/${def.kind}/part`, x0: -r, y0: -r, x1: r, y1: r, seed: 1, draw: (P) => def.part.draw(P, { season, seed: 3 }) });
      }
    }
    for (const sp of SPECIES) {
      const b = residentBounds(sp);
      const poses = posesFor(sp);
      for (const [key, pose] of Object.entries(poses)) {
        out.push({ id: `res/${sp}/${key}`, ...b, seed: 101, draw: (P) => drawResident(P, sp, pose, "base") });
        out.push({ id: `res/${sp}/${key}/scarf`, ...b, seed: 101, draw: (P) => drawResident(P, sp, pose, "scarf") });
      }
      const hs = SIZES.helperScale;
      for (const key of HELPER_POSES) {
        const pose = poses[key];
        const hb = { x0: b.x0 * hs, y0: b.y0 * hs, x1: b.x1 * hs, y1: b.y1 * hs };
        out.push({ id: `hlp/${sp}/${key}`, ...hb, seed: 101, draw: (P) => P.at(0, 0, 0, () => drawResident(scaled(P, hs), sp, pose, "base"), hs) });
        out.push({ id: `hlp/${sp}/${key}/scarf`, ...hb, seed: 101, draw: (P) => P.at(0, 0, 0, () => drawResident(scaled(P, hs), sp, pose, "scarf"), hs) });
      }
    }
    const treeH = [46, 38, 52];
    treeH.forEach((h, i) => out.push({ id: `tree/broad/${i}`, x0: -h * 0.5, y0: -h - 4, x1: h * 0.5, y1: 3, seed: 300 + i, draw: (P) => villageTree(P, h, 300 + i * 7, season, "broad") }));
    [40, 30].forEach((h, i) => out.push({ id: `tree/conifer/${i}`, x0: -h * 0.42, y0: -h - 3, x1: h * 0.42, y1: 2, seed: 320 + i, draw: (P) => villageTree(P, h, 320 + i, season, "conifer") }));
    [28, 24, 31].forEach((h, i) => out.push({ id: `tree/fruit/${i}`, x0: -h * 0.5, y0: -h - 3, x1: h * 0.5, y1: 2, seed: 330 + i, draw: (P) => fruitTree(P, h, 330 + i * 3, season) }));
    [10, 14, 8].forEach((w, i) => out.push({ id: `bush/${i}`, x0: -w * 0.7, y0: -w, x1: w * 0.7, y1: 2, seed: 340 + i, draw: (P) => bush(P, w, 340 + i * 5, season) }));
    const decos = ["bench", "lamppost", "flowers", "birdhouse", "pumpkins", "snowman", "hammock", "crate", "bunting"];
    for (const k of decos) out.push({ id: `deco/${k}`, x0: -22, y0: -25, x1: 22, y1: 2, seed: 360, draw: (P) => decoration(P, k, 361, season) });
    for (const icon of ["question", "permission", "none"])
      for (let w = 0; w < 3; w++) out.push({ id: `alert/flag/${icon}/${w}`, x0: -2.5, y0: -3.5, x1: 16.5, y1: 13.5, seed: 5, draw: (P) => drawFlag(P, icon, w) });
    out.push({ id: "alert/flag-furled", x0: -1, y0: -1, x1: 4, y1: 8, seed: 5, draw: (P) => drawFlagFurled(P) });
    out.push({ id: "alert/bell-rest", x0: -6, y0: -1, x1: 6, y1: 28, seed: 5, draw: (P) => drawBellRest(P) });
    for (const s of [-1, 0, 1]) out.push({ id: `alert/bell/${s}`, x0: -9, y0: -2, x1: 9, y1: 13, seed: 5, draw: (P) => drawBell(P, s) });
    [3, 4.5, 6].forEach((s, i) => out.push({ id: `fx/smoke/${i}`, x0: -s * 1.4, y0: -s * 1.2, x1: s * 1.4, y1: s * 1.2, seed: 400 + i, draw: (P) => smokePuff(P, s, 400 + i) }));
    out.push({ id: "fx/dust", x0: -26, y0: -14, x1: 26, y1: 2, seed: 410, draw: (P) => dustPuff(P, 40, 410) });
    out.push({ id: "fx/plank", x0: -8, y0: -3, x1: 8, y1: 3, seed: 411, draw: (P) => flyingPlank(P) });
    out.push({ id: "fx/confetti", x0: -16, y0: -16, x1: 16, y1: 2, seed: 412, draw: (P) => confetti(P, 28, 412) });
    out.push({ id: "fx/glow", x0: -12, y0: -12, x1: 12, y1: 12, seed: 413, draw: (P) => P.glow(0, 0, 12, "lampGlow", 0.9) });
    out.push({ id: "wx/snow", x0: -1.2, y0: -1.2, x1: 1.2, y1: 1.2, seed: 420, draw: (P) => P.piece(blob(0, 0, 0.8, 0.8, 4, 5, 0.2), "snow", { shadow: 0.3, wobble: 0 }) });
    out.push({ id: "wx/leaf/0", x0: -2, y0: -2, x1: 2, y1: 2, seed: 421, draw: (P) => leaf(P, 0, 0, 0, 1.5, "leafAmber") });
    out.push({ id: "wx/leaf/1", x0: -2, y0: -2, x1: 2, y1: 2, seed: 422, draw: (P) => leaf(P, 0, 0, 0, 1.3, "leafRust") });
    for (let i = 0; i < 4; i++) {
      const w = 22 + i * 8;
      out.push({
        id: `cloud/${i}`,
        x0: -w * 0.6,
        y0: -w * 0.3,
        x1: w * 0.6,
        y1: w * 0.2,
        seed: 430 + i,
        draw: (P) => {
          P.piece(blob(0, 0, w / 2, w * 0.13, 430 + i, 6, 0.42, true), mix(tok("cream"), tok("stoneLight"), 0.3), { rim: 1, shadow: 0.6 });
          P.piece(blob(-w * 0.1, -w * 0.06, w * 0.28, w * 0.15, 431 + i, 5, 0.4, true), "cream", { rim: 1, shadow: 0.7 });
          P.grain(-w * 0.6, -w * 0.3, w * 1.2, w * 0.5);
        }
      });
    }
    for (const c of "0123456789+!") out.push({ id: `glyph/${c}`, x0: -3, y0: -4, x1: 3, y1: 4, seed: 1, draw: (P) => P.text(c, 0, 0.2, 6.4, "ink", 700) });
    return out;
  }
  function scaled(P, s) {
    const Q = new Paper(P.ctx, P.scale * s, P.seed);
    Q.flat = P.flat;
    Q.shadowGain = P.shadowGain;
    return Q;
  }

  // src/atlas.ts
  var PAD = 2;
  var MAX = 4096;
  function buildAtlas(defs, scale) {
    const t0 = performance.now();
    const items = defs.map((d) => ({
      d,
      w: Math.ceil((d.x1 - d.x0) * scale) + PAD * 2,
      h: Math.ceil((d.y1 - d.y0) * scale) + PAD * 2
    }));
    const order = items.map((_, i) => i).sort((a, b) => items[b].h - items[a].h || items[b].w - items[a].w);
    const pageW = Math.min(MAX, Math.max(1024, nextPow2(Math.sqrt(items.reduce((s, it) => s + it.w * it.h, 0) * 1.25))));
    const placed = new Array(items.length);
    const pageHeights = [];
    let page = 0;
    let x = 0;
    let y = 0;
    let shelfH = 0;
    for (const i of order) {
      const it = items[i];
      if (x + it.w > pageW) {
        y += shelfH;
        x = 0;
        shelfH = 0;
      }
      if (y + it.h > MAX) {
        pageHeights[page] = y;
        page++;
        x = 0;
        y = 0;
        shelfH = 0;
      }
      placed[i] = { page, x, y };
      x += it.w;
      shelfH = Math.max(shelfH, it.h);
    }
    pageHeights[page] = y + shelfH;
    const pages = pageHeights.map((h) => makeCanvas(pageW, Math.max(1, h)));
    const ctxs = pages.map((c) => c.getContext("2d"));
    const frames = /* @__PURE__ */ new Map();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const pl = placed[i];
      const g = ctxs[pl.page];
      const ox = pl.x + PAD;
      const oy = pl.y + PAD;
      g.save();
      g.beginPath();
      g.rect(pl.x, pl.y, it.w, it.h);
      g.clip();
      g.setTransform(scale, 0, 0, scale, ox - it.d.x0 * scale, oy - it.d.y0 * scale);
      const P = new Paper(g, scale, it.d.seed ?? 1);
      it.d.draw(P);
      g.restore();
      frames.set(it.d.id, { page: pl.page, sx: ox, sy: oy, sw: it.w - PAD * 2, sh: it.h - PAD * 2, x0: it.d.x0, y0: it.d.y0 });
    }
    return { scale, pages, frames, ms: performance.now() - t0 };
  }
  function nextPow2(v) {
    let p = 1;
    while (p < v) p *= 2;
    return p;
  }

  // src/bench-main.ts
  var settle = (pages) => {
    for (const p of pages) p.getContext("2d").getImageData(0, 0, 1, 1);
  };
  function bench(label, filter = () => true) {
    const defs = stripSprites("autumn").filter((d) => filter(d.id));
    settle(buildAtlas(defs, 2).pages);
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const a = buildAtlas(defs, 2);
      settle(a.pages);
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    console.log(label.padEnd(28), String(defs.length).padStart(4), "sprites", runs[1].toFixed(1), "ms");
  }
  bench("all");
  bench("structures", (id) => id.startsWith("st/"));
  bench("residents base", (id) => id.startsWith("res/") && !id.endsWith("/scarf"));
  bench("residents scarf", (id) => id.startsWith("res/") && id.endsWith("/scarf"));
  bench("helpers", (id) => id.startsWith("hlp/"));
  bench("other", (id) => !id.startsWith("st/") && !id.startsWith("res/") && !id.startsWith("hlp/"));
  PAPER_DEBUG.noShadow = true;
  bench("all, no shadow");
  PAPER_DEBUG.noShadow = false;
  PAPER_DEBUG.noGrain = true;
  bench("all, no grain");
  PAPER_DEBUG.noGrain = false;
  PAPER_DEBUG.noRim = true;
  bench("all, no rim");
  PAPER_DEBUG.noRim = false;
  window.__goldenReady = true;
})();
