/**
 * Lit sprite cache for everything that moves. Each entry is one atlas frame, multiplied by the sky
 * light, with the instance scarf tinted in and the layer's sun-driven drop shadow baked in, for
 * one facing. Entries are built on first use and dropped when the light changes, so a frame only
 * blits: no blur, no compositing, no tinting at draw time.
 */
import { tok, css, mix, type RGB } from '../../../art/src/color.ts';
import { SCARVES } from '../../../art/src/tokens.ts';
import type { Atlas } from '../../../art/src/atlas.ts';
import { canvas, ctx2d, type AnyCanvas, type Light } from './compose.ts';

export interface LitEntry {
  c: AnyCanvas;
  /** device px from the sprite's anchor to the entry's top-left */
  ax: number;
  ay: number;
}

export interface LitOpts {
  scarf?: number;
  flip?: boolean;
  /** layer depth gap for the drop shadow (0 = no shadow) */
  gap: number;
  shadowGain?: number;
  /** multiply light gain (1 = full sky light) */
  lightGain?: number;
}

const MAX_ENTRIES = 220;
const ROTATION_STEPS = 72;
const MAX_ROTATED = ROTATION_STEPS * 2;

export class LitSprites {
  private cache = new Map<string, LitEntry | null>();
  private rotated = new Map<string, LitEntry | null>();
  private lightKey = '';
  private light: Light | null = null;
  private tmp: AnyCanvas | null = null;
  private tmp2: AnyCanvas | null = null;
  private tmp3: AnyCanvas | null = null;
  atlas: Atlas;

  constructor(atlas: Atlas) {
    this.atlas = atlas;
  }

  /** Bytes held by cached entries and scratch canvases (debug). */
  bytes(): { entries: number; bytes: number } {
    let b = 0;
    for (const e of [...this.cache.values(), ...this.rotated.values()]) if (e) b += e.c.width * e.c.height * 4;
    for (const c of [this.tmp, this.tmp2, this.tmp3]) if (c) b += c.width * c.height * 4;
    return { entries: this.cache.size + this.rotated.size, bytes: b };
  }

  clear(): void {
    this.cache.clear();
    this.rotated.clear();
    this.tmp = this.tmp2 = this.tmp3 = null;
  }

  setAtlas(atlas: Atlas): void {
    if (atlas !== this.atlas) {
      this.atlas = atlas;
      this.cache.clear();
      this.rotated.clear();
    }
  }

  setLight(light: Light): void {
    this.light = light;
    // Layout revisions are not lighting revisions. The live collector publishes world inputs
    // every 30 seconds while working; retaining unchanged light keeps the rotation cache warm.
    const sp = light.shadow;
    const rgb = light.sky.light;
    const key = [rgb.r, rgb.g, rgb.b, sp.dx, sp.dy, sp.blur, sp.alpha].join('|');
    if (key !== this.lightKey) {
      this.lightKey = key;
      this.cache.clear();
      this.rotated.clear();
    }
  }

  get(id: string, o: LitOpts): LitEntry | null {
    const key = `${id}|${o.scarf ?? -1}|${o.flip ? 1 : 0}|${o.gap}|${o.shadowGain ?? 1}|${o.lightGain ?? 1}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const e = this.build(id, o);
    if (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, e);
    return e;
  }

  /**
   * Strip mill parts use five-degree paper steps. Bake the rotation and its sun-directed blur
   * once per orientation, rather than running a GPU shadow filter on every committed frame.
   * The shadow offsets stay in device space; rotating a pre-shadowed sprite would rotate the sun.
   */
  getRotated(id: string, angle: number, gap: number): LitEntry | null {
    const turn = Math.PI * 2;
    const frame = Math.round((((angle % turn) + turn) % turn) * ROTATION_STEPS / turn) % ROTATION_STEPS;
    const key = `${id}|${frame}|${gap}`;
    const hit = this.rotated.get(key);
    if (hit !== undefined) return hit;
    const base = this.get(id, { gap: 0 });
    if (!base || !this.light) return null;
    const theta = frame * turn / ROTATION_STEPS;
    const cos = Math.cos(theta), sin = Math.sin(theta);
    const corners = [[base.ax, base.ay], [base.ax + base.c.width, base.ay],
      [base.ax, base.ay + base.c.height], [base.ax + base.c.width, base.ay + base.c.height]];
    const xs = corners.map(([x, y]) => x * cos - y * sin);
    const ys = corners.map(([x, y]) => x * sin + y * cos);
    const sp = this.light.shadow;
    const shadow = gap > 0 && sp.alpha > 0.002;
    const k = this.atlas.scale;
    const sx = shadow ? sp.dx * gap * k : 0;
    const sy = shadow ? sp.dy * gap * k : 0;
    const blur = shadow ? sp.blur * gap * k : 0;
    const pad = Math.ceil(Math.abs(sx) + Math.abs(sy) + blur * 1.6 + 2);
    const ax = Math.floor(Math.min(...xs)) - pad;
    const ay = Math.floor(Math.min(...ys)) - pad;
    const c = canvas(Math.ceil(Math.max(...xs)) - ax + pad, Math.ceil(Math.max(...ys)) - ay + pad);
    const g = c.getContext('2d', { willReadFrequently: true }) as ReturnType<typeof ctx2d>;
    if (shadow) {
      g.shadowColor = css(tok('ink'), sp.alpha);
      g.shadowOffsetX = sx;
      g.shadowOffsetY = sy;
      g.shadowBlur = blur;
    }
    g.translate(-ax, -ay);
    g.rotate(theta);
    g.drawImage(base.c as CanvasImageSource, base.ax, base.ay);
    const e = { c, ax, ay };
    if (this.rotated.size >= MAX_ROTATED) this.rotated.delete(this.rotated.keys().next().value as string);
    this.rotated.set(key, e);
    return e;
  }

  private scratch(which: 1 | 2 | 3, w: number, h: number): AnyCanvas {
    let c = which === 1 ? this.tmp : which === 2 ? this.tmp2 : this.tmp3;
    if (!c || c.width < w || c.height < h) {
      c = canvas(Math.max(w, 64, c?.width ?? 0), Math.max(h, 64, c?.height ?? 0));
      if (which === 1) this.tmp = c;
      else if (which === 2) this.tmp2 = c;
      else this.tmp3 = c;
    }
    const g = ctx2d(c);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.shadowColor = 'transparent';
    g.clearRect(0, 0, c.width, c.height);
    return c;
  }

  private build(id: string, o: LitOpts): LitEntry | null {
    const f = this.atlas.frames.get(id);
    if (!f || !this.light) return null;
    const page = this.atlas.pages[f.page] as CanvasImageSource;
    const k = this.atlas.scale;
    const { sw, sh } = f;
    // base, plus the tinted scarf overlay
    const A = this.scratch(1, sw, sh);
    const ga = ctx2d(A);
    ga.drawImage(page, f.sx, f.sy, sw, sh, 0, 0, sw, sh);
    if (o.scarf !== undefined && o.scarf >= 0) {
      const sf = this.atlas.frames.get(`${id}/scarf`);
      if (sf) {
        const S = this.scratch(2, sf.sw, sf.sh);
        const gs = ctx2d(S);
        const sp = this.atlas.pages[sf.page] as CanvasImageSource;
        gs.drawImage(sp, sf.sx, sf.sy, sf.sw, sf.sh, 0, 0, sf.sw, sf.sh);
        gs.globalCompositeOperation = 'multiply';
        gs.fillStyle = css(tok(SCARVES[o.scarf % SCARVES.length]));
        gs.fillRect(0, 0, sf.sw, sf.sh);
        gs.globalCompositeOperation = 'destination-in';
        gs.drawImage(sp, sf.sx, sf.sy, sf.sw, sf.sh, 0, 0, sf.sw, sf.sh);
        ga.drawImage(S as CanvasImageSource, 0, 0, sf.sw, sf.sh, 0, 0, sf.sw, sf.sh);
      }
    }
    // light: multiply, keeping the paper's own alpha
    const ref = this.scratch(3, sw, sh);
    ctx2d(ref).drawImage(A as CanvasImageSource, 0, 0, sw, sh, 0, 0, sw, sh);
    const light: RGB = mix(tok('lightDay'), this.light.sky.light, o.lightGain ?? 1);
    ga.globalCompositeOperation = 'multiply';
    ga.fillStyle = css(light);
    ga.fillRect(0, 0, sw, sh);
    ga.globalCompositeOperation = 'destination-in';
    ga.drawImage(ref as CanvasImageSource, 0, 0, sw, sh, 0, 0, sw, sh);
    ga.globalCompositeOperation = 'source-over';
    // drop shadow baked in (shadow offsets ignore the transform, so a flipped sprite still shadows away from the sun)
    const sp = this.light.shadow;
    const a = sp.alpha * (o.shadowGain ?? 1);
    const withShadow = o.gap > 0 && a > 0.002;
    const sx = withShadow ? sp.dx * o.gap * k : 0;
    const sy = withShadow ? sp.dy * o.gap * k : 0;
    const blur = withShadow ? sp.blur * o.gap * k : 0;
    const pad = Math.ceil(Math.abs(sx) + Math.abs(sy) + blur * 1.6 + 2);
    const cw = sw + pad * 2;
    const ch = sh + pad * 2;
    const out = canvas(cw, ch);
    const go = ctx2d(out);
    if (o.flip) {
      go.translate(cw, 0);
      go.scale(-1, 1);
    }
    if (withShadow) {
      go.shadowColor = css(tok('ink'), a);
      go.shadowOffsetX = sx;
      go.shadowOffsetY = sy;
      go.shadowBlur = blur;
    }
    go.drawImage(A as CanvasImageSource, 0, 0, sw, sh, pad, pad, sw, sh);
    const ax = o.flip ? -(sw + pad + f.x0 * k) : f.x0 * k - pad;
    return { c: out, ax, ay: f.y0 * k - pad };
  }
}
