/**
 * The papercut primitive.
 *
 * Every visible object is built from "pieces": flat paper shapes with
 *   - a slightly wobbly cut edge (seeded noise along the outline),
 *   - a soft inner drop shadow onto whatever is beneath it (baked straight down, so it stays
 *     correct whichever way the sun is; the sun-driven layer shadow is added at composite time),
 *   - optionally a light "cut core" rim along the top edge, the white core of coloured paper
 *     catching light, which is the single strongest papercut cue,
 *   - and paper grain applied once per sprite with `grain()`.
 *
 * Coordinates are strip units (see tokens.ts SIZES). `scale` is device pixels per unit and is only
 * needed because canvas shadow blur and offset are specified in device pixels.
 */
import { PAL, PAPER, type Token } from './tokens.ts';
import { tok, css, mix, shade, type RGB } from './color.ts';
import { hash, fbm1, rng } from './rng.ts';

export type Pt = [number, number];
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
/** A palette token name or a computed colour. */
export type Fill = Token | RGB;

export function rgbOf(f: Fill): RGB {
  return typeof f === 'string' ? tok(f) : f;
}
function fillCss(f: Fill, alpha = 1): string {
  if (typeof f === 'string' && alpha >= 1) return PAL[f];
  return css(rgbOf(f), alpha);
}

// ---------------------------------------------------------------- shape helpers (point lists)

export function rect(x: number, y: number, w: number, h: number): Pt[] {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

export function ellipse(cx: number, cy: number, rx: number, ry: number, n = 0, a0 = 0, a1 = Math.PI * 2): Pt[] {
  const segs = n || Math.max(10, Math.round((rx + ry) * 2.2));
  const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6;
  const out: Pt[] = [];
  const count = full ? segs : segs + 1;
  for (let i = 0; i < count; i++) {
    const a = a0 + ((a1 - a0) * i) / segs;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
}

export function circle(cx: number, cy: number, r: number, n = 0): Pt[] {
  return ellipse(cx, cy, r, r, n);
}

/** Rounded rectangle; r may be [tl, tr, br, bl]. */
export function roundRect(x: number, y: number, w: number, h: number, r: number | number[]): Pt[] {
  const [tl, tr, br, bl] = typeof r === 'number' ? [r, r, r, r] : r;
  const out: Pt[] = [];
  const corner = (cx: number, cy: number, rr: number, a0: number) => {
    if (rr <= 0) {
      out.push([cx, cy]);
      return;
    }
    const n = Math.max(3, Math.round(rr * 2));
    for (let i = 0; i <= n; i++) {
      const a = a0 + (Math.PI / 2) * (i / n);
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

/** Lumpy blob (bush, tree crown, cloud). `lumps` bumps around an ellipse. */
export function blob(cx: number, cy: number, rx: number, ry: number, seed: number, lumps = 7, depth = 0.18, flatBottom = false): Pt[] {
  const r = rng(seed);
  const phases = Array.from({ length: lumps }, () => r());
  const n = Math.max(24, lumps * 6);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = (i / n) * lumps;
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

/** Thick polyline outline (a paper strip): returns a closed polygon around the path. */
export function strip(path: Pt[], width: number | ((t: number) => number)): Pt[] {
  const left: Pt[] = [];
  const right: Pt[] = [];
  const w = typeof width === 'number' ? () => width : width;
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

/** Transform helper for point lists. */
export function xf(pts: Pt[], tx: number, ty: number, rot = 0, sx = 1, sy = sx): Pt[] {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return pts.map(([x, y]) => [tx + (x * sx) * c - (y * sy) * s, ty + (x * sx) * s + (y * sy) * c]);
}

// ---------------------------------------------------------------- wobbly cut path

/** Build a Path2D whose outline wobbles like a scissor cut. amp in units (0 = clean). */
export function cutPath(pts: Pt[], seed: number, amp: number = PAPER.wobbleAmp, step: number = PAPER.wobbleStep, closed = true): Path2D {
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

// ---------------------------------------------------------------- grain texture

const grainCache = new Map<string, OffscreenCanvas | HTMLCanvasElement>();

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
export { makeCanvas };

/**
 * Tileable paper grain, generated in code: low-frequency mottling, fine speckle and short fibres,
 * stored as light and dark specks with alpha so it can be laid over any colour with source-atop.
 */
export function grainTexture(size = 192, seed = 7): OffscreenCanvas | HTMLCanvasElement {
  const key = `${size}:${seed}`;
  const hit = grainCache.get(key);
  if (hit) return hit;
  const N = size * size;
  const v = new Float32Array(N);
  const r = rng(seed);
  // mottling: periodic value noise on a coarse lattice
  const cells = 6;
  const lat = Array.from({ length: cells * cells }, () => r() * 2 - 1);
  const at = (i: number, j: number) => lat[((j + cells) % cells) * cells + ((i + cells) % cells)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells;
      const fy = (y / size) * cells;
      const i = Math.floor(fx);
      const j = Math.floor(fy);
      const ux = (fx - i) * (fx - i) * (3 - 2 * (fx - i));
      const uy = (fy - j) * (fy - j) * (3 - 2 * (fy - j));
      const a = at(i, j) + (at(i + 1, j) - at(i, j)) * ux;
      const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * ux;
      v[y * size + x] = (a + (b - a) * uy) * 0.35 + (r() * 2 - 1) * 0.45;
    }
  }
  // fibres: short wandering strokes, light and dark, wrapping at the edges
  const fibres = Math.round(size * size * 0.0065);
  for (let f = 0; f < fibres; f++) {
    let x = r() * size;
    let y = r() * size;
    let ang = r() * Math.PI * 2;
    const len = 4 + r() * 14;
    const sign = r() < 0.55 ? 1 : -1;
    const strength = (0.5 + r() * 0.7) * sign;
    for (let k = 0; k < len; k++) {
      const xi = ((Math.round(x) % size) + size) % size;
      const yi = ((Math.round(y) % size) + size) % size;
      v[yi * size + xi] += strength;
      ang += (r() - 0.5) * 0.5;
      x += Math.cos(ang);
      y += Math.sin(ang);
    }
  }
  const c = makeCanvas(size, size);
  const g = c.getContext('2d') as Ctx2D;
  const img = g.createImageData(size, size);
  const light = tok('speciesHighlight');
  const dark = tok('ink');
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

// ---------------------------------------------------------------- the Paper drawing context

export interface PieceOpts {
  /** inner drop shadow strength multiplier (0 = none, default 1) */
  shadow?: number;
  /** light cut-core rim along the top edge (default false) */
  rim?: boolean | number;
  /** wobble amplitude multiplier (0 = clean edge, default 1) */
  wobble?: number;
  /** fill opacity */
  alpha?: number;
  /** explicit seed for the wobble (default: next in sequence) */
  seed?: number;
  /** holes cut through the piece (even-odd) */
  holes?: Pt[][];
}

/** At or above this many device px per unit, inner shadows use a real blur (ambient); below, stepped fills (strip). */
export const BLUR_MIN_SCALE = 3.5;

/** Global switches for profiling (not used in production paths). */
export const PAPER_DEBUG = { noShadow: false, noGrain: false, noRim: false };

export class Paper {
  ctx: Ctx2D;
  /** device pixels per unit */
  scale: number;
  seed: number;
  n = 0;
  /** global multiplier on inner shadows (0 when drawing silhouettes) */
  shadowGain = 1;
  /** when set, every piece is filled with this colour and no shadow (mask / silhouette mode) */
  flat: string | null = null;

  constructor(ctx: Ctx2D, scale: number, seed = 1) {
    this.ctx = ctx;
    this.scale = scale;
    this.seed = seed;
  }

  nextSeed(): number {
    return hash(this.seed, this.n++);
  }

  path(pts: Pt[], opts: PieceOpts = {}): Path2D {
    const seed = opts.seed ?? this.nextSeed();
    const amp = PAPER.wobbleAmp * (opts.wobble ?? 1);
    const p = cutPath(pts, seed, amp);
    if (opts.holes) for (const h of opts.holes) p.addPath(cutPath(h, hash(seed, 77), amp));
    return p;
  }

  /** A paper piece. */
  piece(pts: Pt[] | Path2D, fill: Fill, opts: PieceOpts = {}): Path2D {
    const ctx = this.ctx;
    const path = pts instanceof Path2D ? pts : this.path(pts, opts);
    const rule: CanvasFillRule = opts.holes ? 'evenodd' : 'nonzero';
    if (this.flat) {
      ctx.fillStyle = this.flat;
      ctx.fill(path, rule);
      return path;
    }
    const alpha = opts.alpha ?? 1;
    const sh = PAPER_DEBUG.noShadow ? 0 : (opts.shadow ?? 1) * this.shadowGain;
    const base = rgbOf(fill);
    const rim = PAPER_DEBUG.noRim ? 0 : opts.rim ? (typeof opts.rim === 'number' ? opts.rim : 1) : 0;
    const blurred = sh > 0 && this.scale >= BLUR_MIN_SCALE;
    ctx.save();
    if (sh > 0 && !blurred) this.steppedShadow(path, rule, sh, alpha);
    if (blurred) {
      ctx.shadowColor = css(tok('ink'), PAPER.innerShadowAlpha * Math.min(1.5, sh) * alpha);
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = PAPER.innerShadowOffset * this.scale * Math.min(1.6, sh);
      ctx.shadowBlur = PAPER.innerShadowBlur * this.scale * Math.min(1.6, sh);
    }
    if (rim > 0) {
      // cut core: lighter paper underneath, base colour shifted down, so a sliver shows on top edges
      ctx.fillStyle = css(mix(base, tok('cream'), PAPER.rimAlpha), alpha);
      ctx.fill(path, rule);
      ctx.restore();
      ctx.save();
      ctx.clip(path, rule);
      ctx.translate(0, (0.42 * rim * 2) / Math.max(1, this.scale / 2) + 0.18 * rim);
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
  private steppedShadow(path: Path2D, rule: CanvasFillRule, sh: number, alpha: number): void {
    const ctx = this.ctx;
    const m = ctx.getTransform();
    const det = m.a * m.d - m.b * m.c;
    if (!det) return;
    const dev = PAPER.innerShadowOffset * this.scale * Math.min(1.6, sh);
    // local vector that maps to (0, dev) in device space
    const lx = (-m.c * dev) / det;
    const ly = (m.a * dev) / det;
    const a = PAPER.innerShadowAlpha * Math.min(1.5, sh) * alpha;
    ctx.save();
    ctx.translate(lx * 0.55, ly * 0.55);
    ctx.fillStyle = css(tok('ink'), a * 0.5);
    ctx.fill(path, rule);
    ctx.translate(lx * 0.75, ly * 0.75);
    ctx.fillStyle = css(tok('ink'), a * 0.42);
    ctx.fill(path, rule);
    ctx.restore();
  }

  /** Clean-edged piece (tiny details: eyes, window panes). */
  dot(cx: number, cy: number, r: number, fill: Fill, shadow = 0): void {
    this.piece(circle(cx, cy, r, 10), fill, { wobble: 0, shadow });
  }

  /** A thin paper strip along a polyline (rope, pole, branch). */
  line(path: Pt[], width: number, fill: Fill, opts: PieceOpts = {}): Path2D {
    return this.piece(strip(path, width), fill, { wobble: 0.35, ...opts });
  }

  /** Shade helper: a token one step lighter or darker. */
  tone(f: Fill, dL: number): RGB {
    return shade(rgbOf(f), dL);
  }

  /** Run fn with a local transform (translate, rotate radians, scale). */
  at(x: number, y: number, rot: number, fn: () => void, sx = 1, sy = sx): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    if (rot) ctx.rotate(rot);
    if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
    fn();
    ctx.restore();
  }

  /** Lay paper grain over everything already drawn inside the box (source-atop). */
  grain(x: number, y: number, w: number, h: number, alpha: number = PAPER.grainAlpha): void {
    if (this.flat || PAPER_DEBUG.noGrain) return;
    const ctx = this.ctx;
    const tex = grainTexture();
    const pat = ctx.createPattern(tex as CanvasImageSource, 'repeat');
    if (!pat) return;
    const g = Math.max(1, Math.min(2.2, this.scale / 2.5));
    const m = ctx.getTransform().inverse().multiply(new DOMMatrix().scale(g, g));
    pat.setTransform(m);
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.globalAlpha = alpha;
    ctx.fillStyle = pat;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }

  /** Soft radial glow (emissive pass only: lamps, windows, fire). No grain, no wobble. */
  glow(cx: number, cy: number, r: number, fill: Fill, alpha = 1): void {
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
  text(s: string, x: number, y: number, size: number, fill: Fill, weight = 600, align: CanvasTextAlign = 'center'): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `${weight} ${size}px "Fraunces", "Iowan Old Style", Georgia, serif`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.flat ?? fillCss(fill);
    ctx.fillText(s, x, y);
    ctx.restore();
  }
}
