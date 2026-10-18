/**
 * Atlas builder: rasterises sprite definitions at one device scale into texture pages.
 *
 * Output is renderer-agnostic: pages are canvases (or OffscreenCanvases) and frames are pixel
 * rectangles plus the sprite's local origin, so PixiJS v8 can wrap each page with
 * `Texture.from(page)` and each frame with `new Texture({ source, frame })`.
 * Sprites are packed on shelves (tallest first) into pages of at most 4096 px.
 */
import { Paper, makeCanvas, type Ctx2D } from './paper.ts';
import { stripSprites, type SpriteDef } from './sprites.ts';
import type { Season } from './terrain.ts';

export interface AtlasFrame {
  page: number;
  /** pixel rect in the page */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** local bounds origin in units: the sprite's (x0, y0) maps to (sx, sy) */
  x0: number;
  y0: number;
}

export interface Atlas {
  /** device pixels per unit */
  scale: number;
  pages: (OffscreenCanvas | HTMLCanvasElement)[];
  frames: Map<string, AtlasFrame>;
  ms: number;
}

export interface AtlasResult {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  sprites: number;
  width: number;
  height: number;
  atlas: Atlas;
}

const PAD = 2;
const MAX = 4096;

export function buildAtlas(defs: SpriteDef[], scale: number): Atlas {
  const t0 = performance.now();
  const items = defs.map((d) => ({
    d,
    w: Math.ceil((d.x1 - d.x0) * scale) + PAD * 2,
    h: Math.ceil((d.y1 - d.y0) * scale) + PAD * 2,
  }));
  // pack: sort by height, fill shelves left to right
  const order = items.map((_, i) => i).sort((a, b) => items[b].h - items[a].h || items[b].w - items[a].w);
  const pageW = Math.min(MAX, Math.max(1024, nextPow2(Math.sqrt(items.reduce((s, it) => s + it.w * it.h, 0) * 1.25))));
  const placed: { page: number; x: number; y: number }[] = new Array(items.length);
  const pageHeights: number[] = [];
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
  const ctxs = pages.map((c) => c.getContext('2d') as Ctx2D);
  const frames = new Map<string, AtlasFrame>();
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

function nextPow2(v: number): number {
  let p = 1;
  while (p < v) p *= 2;
  return p;
}

/** The strip atlas for a season at a device scale (strip height / 112 x devicePixelRatio). */
export function buildStripAtlas(scale: number, season: Season = 'autumn'): AtlasResult {
  const defs = stripSprites(season);
  const atlas = buildAtlas(defs, scale);
  const canvas = atlas.pages[0];
  return { canvas, sprites: defs.length, width: canvas.width, height: atlas.pages.reduce((s, p) => s + p.height, 0), atlas };
}

export interface DrawFrameOpts {
  flip?: boolean;
  alpha?: number;
  rot?: number;
  scale?: number;
  /** draw this image instead of the atlas page (same frame layout, e.g. a tinted scarf scratch at (0,0)) */
  source?: CanvasImageSource;
  sourceAt?: [number, number];
}

/**
 * Draw a frame with its anchor at (wx, wy) in the context's CURRENT unit space (the layer transform).
 * Unrotated frames are snapped to whole device pixels so a 1:1 blit stays sharp.
 */
export function drawFrame(g: Ctx2D, atlas: Atlas, id: string, wx: number, wy: number, opts: DrawFrameOpts = {}): boolean {
  const f = atlas.frames.get(id);
  if (!f) return false;
  const src = opts.source ?? (atlas.pages[f.page] as CanvasImageSource);
  const [sx, sy] = opts.sourceAt ?? [f.sx, f.sy];
  const s = opts.scale ?? 1;
  const m = g.getTransform();
  g.save();
  if (opts.alpha !== undefined) g.globalAlpha *= opts.alpha;
  if (!opts.rot && m.b === 0 && m.c === 0) {
    const r = (m.a / atlas.scale) * s;
    const ax = m.a * wx + m.e;
    const left = m.a * (wx + f.x0 * s) + m.e;
    const top = Math.round(m.d * (wy + f.y0 * s) + m.f);
    const w = f.sw * r;
    const h = f.sh * r;
    if (opts.flip) {
      const l2 = Math.round(2 * ax - left - w);
      g.setTransform(-1, 0, 0, 1, l2 + w, 0);
      g.drawImage(src, sx, sy, f.sw, f.sh, 0, top, w, h);
    } else {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(src, sx, sy, f.sw, f.sh, Math.round(left), top, w, h);
    }
  } else {
    g.translate(wx, wy);
    if (opts.rot) g.rotate(opts.rot);
    if (opts.flip) g.scale(-1, 1);
    g.drawImage(src, sx, sy, f.sw, f.sh, f.x0 * s, f.y0 * s, (f.sw / atlas.scale) * s, (f.sh / atlas.scale) * s);
  }
  g.restore();
  return true;
}
