/**
 * Plane compositing for the renderer. A plane is a transparent canvas holding one or more paper
 * layers, each lit exactly as the art kit's reference compositor does (src/compose.ts layer():
 * drawn untinted, multiplied by the sky light, hazed by depth, laid down with a sun-driven ink drop
 * shadow), so the frames match the approved goldens. Additions over the kit:
 * - a plane can be a horizontal band (y0..y1 units) of any width, so ambient parallax layers stay small;
 * - an optional rim light on sun-facing edges and an optional backlight (darker, warmer near ground)
 *   for low suns, the two changes ART-NOTES suggests for the golden-hour hero frame.
 */
import { tok, css, mix, type RGB } from '../../../art/src/color.ts';
import { Paper, type Ctx2D } from '../../../art/src/paper.ts';
import type { SkySample } from '../../../art/src/sky.ts';
import type { ShadowParams } from '../../../art/src/shadow.ts';
import type { Frame, View } from '../../../art/src/compose.ts';
import type { Season } from '../../../art/src/terrain.ts';

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

export function canvas(w: number, h: number): AnyCanvas {
  const W = Math.max(1, Math.ceil(w));
  const H = Math.max(1, Math.ceil(h));
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(W, H);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  return c;
}

export function ctx2d(c: AnyCanvas): Ctx2D {
  return c.getContext('2d') as Ctx2D;
}

/** A band canvas plus the unit-space window it covers. */
export interface Band {
  canvas: AnyCanvas;
  /** device px per unit */
  k: number;
  /** unit x at the band's left edge, unit y at its top edge */
  x0: number;
  y0: number;
  /** size in units */
  w: number;
  h: number;
}

export function makeBand(k: number, x0: number, y0: number, w: number, h: number): Band {
  return { canvas: canvas(w * k, h * k), k, x0, y0, w, h };
}

/** A kit Frame aimed at a band (for the kit's layer-level helpers that take a Frame). */
export function frameFor(b: Band, view: View, sky: SkySample, shadow: ShadowParams, season: Season, seed: number, fakeY1?: number, ctx?: Ctx2D): Frame {
  return {
    ctx: ctx ?? ctx2d(b.canvas),
    view,
    k: b.k,
    s: b.k / view.dpr,
    W: b.w,
    y0: b.y0,
    y1: fakeY1 ?? b.y0 + b.h,
    camX: b.x0,
    sky,
    shadow,
    season,
    seed,
  };
}

let scratchA: AnyCanvas | null = null;
let scratchB: AnyCanvas | null = null;
let scratchC: AnyCanvas | null = null;

/**
 * Build scratch is CPU-backed (willReadFrequently): in WebKit every accelerated canvas becomes a
 * GPU-process surface, and big transient ones stay pooled after release (measured: about 100 MB of
 * GPU-process footprint for the ambient view), while the CPU copies are freed like any memory.
 */
function scratchCtx(c: AnyCanvas): Ctx2D {
  return c.getContext('2d', { willReadFrequently: true }) as Ctx2D;
}

function scratch(which: 'a' | 'b' | 'c', w: number, h: number): { c: AnyCanvas; g: Ctx2D } {
  let c = which === 'a' ? scratchA : which === 'b' ? scratchB : scratchC;
  if (!c || c.width < w || c.height < h) {
    c = canvas(Math.max(w, c?.width ?? 0), Math.max(h, c?.height ?? 0));
    if (which === 'a') scratchA = c;
    else if (which === 'b') scratchB = c;
    else scratchC = c;
  }
  const g = scratchCtx(c);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.shadowColor = 'transparent';
  g.clearRect(0, 0, w, h);
  return { c, g };
}

/** Bytes held by the scratch canvases (debug). */
export function scratchBytes(): number {
  return [scratchA, scratchB, scratchC].reduce((n, c) => n + (c ? c.width * c.height * 4 : 0), 0);
}

/** Release the big scratch canvases (after a plane rebuild). */
export function releaseScratch(): void {
  scratchA = scratchB = scratchC = null;
}

export interface LayerOpts {
  gap: number;
  haze: number;
  shadowGain?: number;
  lightGain?: number;
  /** rim light on edges facing the sun: strength 0..1 */
  rim?: number;
  /** backlight: darken toward warm ink, strength 0..1, stronger toward the bottom of the band */
  backlight?: number;
  /** a fixed depth gradient (water darkening toward the viewer): colour and alpha at the band top and bottom */
  shade?: { color: RGB; top: number; bottom: number };
}

export interface Light {
  sky: SkySample;
  shadow: ShadowParams;
}

/** Paper positioned in units on a band. */
export function paperOn(g: Ctx2D, b: Band, seed: number): Paper {
  g.setTransform(b.k, 0, 0, b.k, -b.x0 * b.k, -b.y0 * b.k);
  return new Paper(g, b.k, seed);
}

/**
 * Draw one lit paper layer into a band (the kit's layer(), generalised). `draw` paints untinted
 * paper in unit space.
 */
export function litLayer(b: Band, L: Light, seed: number, opts: LayerOpts, draw: (P: Paper) => void): void {
  const w = b.canvas.width;
  const h = b.canvas.height;
  const A = scratch('a', w, h);
  draw(paperOn(A.g, b, seed));
  A.g.setTransform(1, 0, 0, 1, 0, 0);
  const B = scratch('b', w, h);
  B.g.drawImage(A.c as CanvasImageSource, 0, 0, w, h, 0, 0, w, h);
  B.g.globalCompositeOperation = 'multiply';
  const light = mix(tok('lightDay'), L.sky.light, opts.lightGain ?? 1);
  B.g.fillStyle = css(light);
  B.g.fillRect(0, 0, w, h);
  B.g.globalCompositeOperation = 'destination-in';
  B.g.drawImage(A.c as CanvasImageSource, 0, 0, w, h, 0, 0, w, h);
  const sky = L.sky;
  const hz = Math.min(0.9, opts.haze * (1 + sky.hazeBoost * 3) + sky.hazeBoost * 0.5 * Math.min(1, opts.haze * 4));
  if (hz > 0.001) {
    B.g.globalCompositeOperation = 'source-atop';
    B.g.fillStyle = css(sky.haze, hz);
    B.g.fillRect(0, 0, w, h);
  }
  if (opts.shade) {
    const grad = B.g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, css(opts.shade.color, opts.shade.top));
    grad.addColorStop(1, css(opts.shade.color, opts.shade.bottom));
    B.g.globalCompositeOperation = 'source-atop';
    B.g.fillStyle = grad;
    B.g.fillRect(0, 0, w, h);
  }
  const low = lowSun(sky);
  if (opts.backlight && low > 0.01) {
    // backlit near ground: the near paper falls into warm shadow when the sun sits low behind the hills
    const amt = Math.min(0.94, opts.backlight * Math.pow(low, 0.7));
    const dark = mix(mix(tok('ink'), tok('roofDeep'), 0.28), sky.light, 0.16);
    const grad = B.g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, css(dark, amt * 0.42));
    grad.addColorStop(1, css(dark, amt * 0.82));
    B.g.globalCompositeOperation = 'source-atop';
    B.g.fillStyle = grad;
    B.g.fillRect(0, 0, w, h);
  }
  if (opts.rim && low > 0.01 && sky.sun.alpha > 0.05) {
    // rim light: the sun-facing cut edges catch warm light (edge = paper whose neighbour toward the sun is empty)
    const side = sky.sun.x < 0.5 ? -1 : 1;
    const r = Math.max(1, 0.42 * b.k);
    const C = scratch('c', w, h);
    C.g.drawImage(A.c as CanvasImageSource, 0, 0, w, h, 0, 0, w, h);
    C.g.globalCompositeOperation = 'destination-out';
    C.g.drawImage(A.c as CanvasImageSource, 0, 0, w, h, -side * r, r * 0.55, w, h);
    C.g.globalCompositeOperation = 'source-in';
    C.g.fillStyle = css(mix(mix(tok('lampGlow'), tok('flame'), 0.18), sky.light, 0.15));
    C.g.fillRect(0, 0, w, h);
    B.g.globalCompositeOperation = 'source-atop';
    B.g.globalAlpha = Math.min(0.9, opts.rim * Math.sqrt(low) * sky.sun.alpha);
    B.g.drawImage(C.c as CanvasImageSource, 0, 0, w, h, 0, 0, w, h);
    B.g.globalAlpha = 1;
  }
  B.g.globalCompositeOperation = 'source-over';
  const g = ctx2d(b.canvas);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  const sp = L.shadow;
  const a = sp.alpha * (opts.shadowGain ?? 1);
  if (a > 0.002 && opts.gap > 0) {
    g.shadowColor = css(tok('ink'), a);
    g.shadowOffsetX = sp.dx * opts.gap * b.k;
    g.shadowOffsetY = sp.dy * opts.gap * b.k;
    g.shadowBlur = sp.blur * opts.gap * b.k;
  }
  g.drawImage(B.c as CanvasImageSource, 0, 0, w, h, 0, 0, w, h);
  g.restore();
}

/** Emissive drawing straight into a band (no light, no haze). */
export function emissiveOn(b: Band, seed: number, draw: (P: Paper) => void, composite: GlobalCompositeOperation = 'source-over'): void {
  const g = ctx2d(b.canvas);
  g.save();
  g.globalCompositeOperation = composite;
  draw(paperOn(g, b, seed));
  g.restore();
}

/** 0 at high sun, 1 when the sun sits on the horizon (and fades out below it). */
export function lowSun(sky: SkySample): number {
  const e = sky.sun.elevation;
  if (sky.sun.alpha < 0.05 || e < -5) return 0;
  const lowness = 1 - Math.max(0, Math.min(1, e / 28));
  const fade = Math.max(0, Math.min(1, (e + 5) / 6));
  return lowness * fade * (1 - sky.spec.cloudCover * 0.7);
}

export type { RGB, Ctx2D };
