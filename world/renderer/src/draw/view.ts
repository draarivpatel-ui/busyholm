/**
 * The canvas view: draws a display list onto the page canvas.
 *
 * Per frame it only blits: cached static planes (rebuilt when the light, season or World
 * change, then crossfaded), lit sprites from the cache, a few emissive sprites, and pattern fills
 * for weather. The strip keeps one composed background canvas (sky, clouds, terrain, village) and
 * recomposes it only when the clouds step a device pixel or the light changes.
 */
import { tok, css, mix } from '../../../art/src/color.ts';
import { Paper, ellipse, blob, type Ctx2D } from '../../../art/src/paper.ts';
import { buildAtlas, drawFrame, type Atlas } from '../../../art/src/atlas.ts';
import { stripSprites, type SpriteDef } from '../../../art/src/sprites.ts';
import { sampleSky, type SkySample } from '../../../art/src/sky.ts';
import { shadowFor } from '../../../art/src/shadow.ts';
import { drawSunBloom, celestialPos } from '../../../art/src/compose.ts';
import { STRUCTURES } from '../../../art/src/structures.ts';
import { SCARVES, SIZES } from '../../../art/src/tokens.ts';
import { firefly, rainStroke, snowflake, leaf } from '../../../art/src/props.ts';
import { rng, range, hash } from '../../../art/src/rng.ts';
import { LAND, type Season } from '../../../art/src/terrain.ts';
import type { RendererOptions } from '../api.ts';
import type { View } from '../renderer.ts';
import type { DisplayList } from '../model.ts';
import { mapX, type ViewXf } from '../viewxf.ts';
import { buildPlanes, type Planes, type Job } from './planes.ts';
import { canvas, ctx2d, frameFor, makeBand, releaseScratch, scratchBytes, type AnyCanvas, type Light } from './compose.ts';
import { LitSprites } from './sprites.ts';
import { getVariantParams } from './variants.ts';
import { drawWaterReflections } from './reflections.ts';

const GROUND = SIZES.groundY;
const BASE = SIZES.structureBaseY;
const FADE_S = 0.9;

interface PlaneSet {
  planes: Planes;
  key: string;
  phase: number;
  /** renderer time the set became current */
  at: number;
}

export class CanvasView implements View {
  private c: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private xf: ViewXf;
  private sync: boolean;
  private atlas: Atlas | null = null;
  private atlasKey = '';
  private sprites: LitSprites | null = null;
  private cur: PlaneSet | null = null;
  private prev: PlaneSet | null = null;
  private build: { jobs: Job[]; out: { planes: Planes | null }; key: string; phase: number; startedAt: number } | null = null;
  private lastBuildAt = -99;
  private bg: AnyCanvas | null = null;
  private bgPrev: AnyCanvas | null = null;
  private bgKey = '';
  private fly: AnyCanvas | null = null;
  private now = 0;
  private fadeOn = false;

  constructor(c: HTMLCanvasElement, xf: ViewXf, opts: RendererOptions) {
    this.c = c;
    this.g = c.getContext('2d', { alpha: true }) as CanvasRenderingContext2D;
    this.xf = xf;
    this.sync = opts.scheduler === 'manual';
    this.size();
    c.style.transition = 'opacity 220ms ease';
  }

  private size(): void {
    const { xf } = this;
    this.c.width = Math.round(xf.width * xf.res);
    this.c.height = Math.round(xf.height * xf.res);
    this.c.style.width = `${xf.width}px`;
    this.c.style.height = `${xf.height}px`;
  }

  resize(xf: ViewXf): void {
    this.xf = xf;
    this.size();
    this.cur = this.prev = null;
    this.build = null;
    this.bg = null;
    this.bgKey = '';
    this.tiles.clear();
  }

  setFade(on: boolean): void {
    this.fadeOn = on;
    this.c.style.opacity = on ? '0.2' : '1';
  }

  /** Hidden ambient views give back every cache (planes, atlas, sprites); they rebuild on show. */
  setVisible(v: boolean): void {
    if (v || this.xf.surface !== 'ambient') return;
    this.cur = this.prev = null;
    this.build = null;
    this.atlas = null;
    this.atlasKey = '';
    this.sprites?.clear();
    this.bg = this.bgPrev = null;
    this.bgKey = '';
    this.tiles.clear();
    this.fly = null;
    releaseScratch();
  }

  destroy(): void {
    this.cur = this.prev = null;
    this.build = null;
    this.atlas = null;
    this.sprites = null;
  }

  /** Megabytes of canvas memory this view holds, by category (debug and the WP-14 memory gate). */
  memory(): Record<string, number> {
    const mb = (b: number) => Math.round((b / 1048576) * 10) / 10;
    const px = (c: AnyCanvas | null | undefined) => (c ? c.width * c.height * 4 : 0);
    const planes = (set: PlaneSet | null) => {
      if (!set) return 0;
      const P = set.planes;
      let b = px(P.sky.canvas) + px(P.clouds?.canvas) + px(P.vignette) + px(P.village.band.canvas);
      for (const x of [...P.back, ...P.front]) b += px(x.band.canvas);
      return b;
    };
    const lit = this.sprites?.bytes() ?? { entries: 0, bytes: 0 };
    return {
      atlasMB: mb((this.atlas?.pages ?? []).reduce((n, c) => n + px(c), 0)),
      atlasPages: this.atlas?.pages.length ?? 0,
      planesMB: mb(planes(this.cur)),
      prevPlanesMB: mb(planes(this.prev)),
      buildingMB: mb(this.build ? 1 : 0),
      bgMB: mb(px(this.bg) + px(this.bgPrev)),
      litMB: mb(lit.bytes),
      litEntries: lit.entries,
      scratchMB: mb(scratchBytes()),
      mainMB: mb(this.c.width * this.c.height * 4),
    };
  }

  busy(): boolean {
    return !!this.build || (!!this.prev && !!this.cur && this.now - this.cur.at < FADE_S);
  }

  key(): string {
    const fade = this.prev && this.cur ? Math.min(1, (this.now - this.cur.at) / FADE_S) : 1;
    return `${this.cur?.key ?? 'none'}|${Math.round(fade * 24)}`;
  }

  // ------------------------------------------------------------------ atlas and planes

  private k(): number {
    return this.xf.s * this.xf.res;
  }

  private ensureAtlas(dl: DisplayList): void {
    const k = this.k();
    const species = [...new Set(dl.residents.map((r) => r.species))].sort();
    const kinds = [...new Set(dl.layout.structures.map((s) => s.kind))].sort();
    const key = `${k.toFixed(4)}|${dl.sky.season}|${species.join(',')}|${kinds.join(',')}`;
    if (key === this.atlasKey && this.atlas) return;
    // keep a superset: never rebuild for a species we already have
    const defs = stripSprites(dl.sky.season as Season);
    let pick: SpriteDef[] = defs;
    {
      // only the sprites in use: species present (all poses) and structures present
      const want = (id: string) => {
        if (id.startsWith('res/') || id.startsWith('hlp/')) return species.includes(id.split('/')[1] as never) || species.length === 0;
        if (id.startsWith('st/')) return kinds.includes(id.split('/')[1] as never) || id.startsWith('st/plot') || id.startsWith('st/bellpost') || id.startsWith('st/campfire');
        return true;
      };
      pick = defs.filter((d) => want(d.id));
    }
    this.atlas = buildAtlas(pick, k);
    this.atlasKey = key;
    if (this.sprites) this.sprites.setAtlas(this.atlas);
    else this.sprites = new LitSprites(this.atlas);
    this.cur = this.prev = null;
    this.build = null;
    this.bgKey = '';
  }

  private planeKey(dl: DisplayList): string {
    const variant = this.xf.variant ?? 'default';
    return `${variant}|${dl.sky.weather}|${dl.sky.season}|${dl.layoutKey}|${this.atlasKey}`;
  }

  private ensurePlanes(dl: DisplayList): void {
    const key = this.planeKey(dl);
    const phase = dl.sky.phase;
    const stale = !this.cur || this.cur.key !== key || phaseDist(this.cur.phase, phase) > 0.006;
    if (stale && !this.build) {
      const minGap = this.cur && this.cur.key === key ? 0.45 : 0;
      if (dl.t - this.lastBuildAt >= minGap || !this.cur) {
        const sky = sampleSky(phase, dl.sky.weather);
        const out = { planes: null as Planes | null };
        const jobs = buildPlanes({ xf: this.xf, atlas: this.atlas!, layout: dl.layout, sky, season: dl.sky.season as Season, dark: dl.dark, seed: dl.layout.seed, variant: this.xf.variant }, out);
        this.build = { jobs, out, key, phase, startedAt: dl.t };
        this.lastBuildAt = dl.t;
      }
    }
    if (this.build) {
      const t0 = performance.now();
      const budget = this.sync || !this.cur ? Infinity : 10;
      while (this.build.jobs.length && performance.now() - t0 < budget) this.build.jobs.shift()!();
      if (!this.build.jobs.length && this.build.out.planes) {
        this.prev = this.cur;
        this.cur = { planes: this.build.out.planes, key: this.build.key, phase: this.build.phase, at: dl.t };
        if (!this.prev) this.cur.at = dl.t - FADE_S;
        this.build = null;
        this.bgKey = '';
        releaseScratch();
      }
    }
    if (this.prev && this.cur && dl.t - this.cur.at >= FADE_S) this.prev = null;
  }

  // ------------------------------------------------------------------ frame

  draw(dl: DisplayList, xf: ViewXf): void {
    this.xf = xf;
    this.now = dl.t;
    this.ensureAtlas(dl);
    this.ensurePlanes(dl);
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, this.c.width, this.c.height);
    if (!this.cur) return;
    const light = this.cur.planes.light;
    this.sprites!.setLight(light);
    const fade = this.prev ? Math.min(1, (dl.t - this.cur.at) / FADE_S) : 1;
    if (xf.surface === 'strip') this.drawStrip(dl, fade);
    else this.drawAmbient(dl, fade);
  }

  private camPx(dl: DisplayList, p: number): number {
    return dl.camX * p * this.k();
  }

  private drawStrip(dl: DisplayList, fade: number): void {
    const g = this.g;
    const k = this.k();
    const cloudPx = Math.round(dl.clouds * k);
    const fading = !!this.prev && fade < 1;
    const bgKey = `${this.cur!.key}|${this.cur!.phase}|${cloudPx}|${dl.sky.phase.toFixed(4)}`;
    if (bgKey !== this.bgKey || !this.bg) {
      this.bg = this.stackInto(this.bg, (b) => this.composeStripBg(b, this.cur!.planes, dl));
      this.bgKey = bgKey;
    }
    if (fading) {
      // crossfade whole composed backgrounds; fading layer by layer would wash the village into the sky
      this.bgPrev = this.stackInto(this.bgPrev, (b) => this.composeStripBg(b, this.prev!.planes, dl));
      g.drawImage(this.bgPrev as CanvasImageSource, 0, 0);
      g.globalAlpha = fade;
    }
    g.drawImage(this.bg as CanvasImageSource, 0, 0);
    g.globalAlpha = 1;
    if (this.cur!.planes.variant === 'evening_warmth') this.drawReflections(dl);
    this.drawDynamic(dl);
    if (fading) for (const f of this.prev!.planes.front) this.blitBand(g, f.band, dl, f.p);
    g.globalAlpha = fading ? fade : 1;
    for (const f of this.cur!.planes.front) this.blitBand(g, f.band, dl, f.p);
    g.globalAlpha = 1;
    this.drawWeather(dl);
    this.drawAlert(dl);
  }

  /** Draw into a reusable screen-sized canvas. */
  private stackInto(c: AnyCanvas | null, fn: (b: Ctx2D) => void): AnyCanvas {
    if (!c || c.width !== this.c.width || c.height !== this.c.height) c = canvas(this.c.width, this.c.height);
    const b = ctx2d(c);
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalAlpha = 1;
    b.globalCompositeOperation = 'source-over';
    b.clearRect(0, 0, c.width, c.height);
    fn(b);
    return c;
  }

  private composeStripBg(b: Ctx2D, P: Planes, dl: DisplayList): void {
    const k = this.k();
    b.drawImage(P.sky.canvas as CanvasImageSource, 0, 0);
    this.celestial(b, dl, P);
    if (P.clouds) this.blitClouds(b, P, dl, 0);
    for (const x of P.back) b.drawImage(x.band.canvas as CanvasImageSource, Math.round(x.band.x0 * k), Math.round((x.band.y0 - this.xf.y0) * k));
    this.bloom(b, P, 1);
    b.drawImage(P.village.band.canvas as CanvasImageSource, Math.round(P.village.band.x0 * k), Math.round((P.village.band.y0 - this.xf.y0) * k));
  }

  private drawAmbient(dl: DisplayList, fade: number): void {
    const g = this.g;
    const fading = !!this.prev && fade < 1;
    const back = (b: Ctx2D, P: Planes) => {
      b.drawImage(P.sky.canvas as CanvasImageSource, 0, 0, this.c.width, this.c.height);
      this.celestial(b, dl, P);
      if (P.clouds) this.blitClouds(b, P, dl, P.cloudP);
      for (const x of P.back) this.blitBand(b, x.band, dl, x.p);
      this.bloom(b, P, 1);
      this.blitBand(b, P.village.band, dl, 1);
    };
    if (fading) {
      this.bgPrev = this.stackInto(this.bgPrev, (b) => back(b, this.prev!.planes));
      this.bg = this.stackInto(this.bg, (b) => back(b, this.cur!.planes));
      this.bgKey = '';
      g.drawImage(this.bgPrev as CanvasImageSource, 0, 0);
      g.globalAlpha = fade;
      g.drawImage(this.bg as CanvasImageSource, 0, 0);
      g.globalAlpha = 1;
    } else back(g, this.cur!.planes);
    this.glitter(dl);
    if (this.cur!.planes.variant === 'evening_warmth') this.drawReflections(dl);
    this.drawDynamic(dl);
    if (fading) for (const f of this.prev!.planes.front) this.blitBand(g, f.band, dl, f.p);
    g.globalAlpha = fading ? fade : 1;
    for (const f of this.cur!.planes.front) this.blitBand(g, f.band, dl, f.p);
    g.globalAlpha = 1;
    this.drawWeather(dl);
    const vig = this.cur!.planes.vignette;
    if (vig) {
      g.globalCompositeOperation = 'multiply';
      g.drawImage(vig as CanvasImageSource, 0, 0, this.c.width, this.c.height);
      g.globalCompositeOperation = 'source-over';
    }
    this.drawAlert(dl);
  }

  private drawReflections(dl: DisplayList): void {
    const sky = this.cur!.planes.light.sky;
    const lamps = sky.lamps;
    const low = sky.sun.alpha > 0.05 ? Math.max(0, Math.min(1, (12 - sky.sun.elevation) / 16)) : 0;
    const intensity = Math.max(lamps, low * 0.45);
    if (intensity <= 0.02) return;
    const g = this.g;
    const k = this.k();
    const xf = this.xf;
    const strip = xf.surface === 'strip';
    const yTop = strip ? 61 : LAND.riverTop + 2;
    const yBot = strip ? SIZES.stripHeight : LAND.riverBottom + 2;
    drawWaterReflections(
      g,
      dl.layout,
      k,
      xf.y0,
      xf.surface,
      xf.W,
      yTop,
      yBot,
      intensity,
      dl.t,
      (x) => mapX(xf, x),
      strip ? 0 : dl.camX,
    );
  }

  private blitBand(g: Ctx2D, band: { canvas: AnyCanvas; x0: number; y0: number; k: number }, dl: DisplayList, p: number): void {
    const k = this.k();
    const x = band.x0 * k - this.camPx(dl, p);
    const y = (band.y0 - this.xf.y0) * k;
    // sub-pixel camera offsets give the smooth pan (only the camera, sky and particles move smoothly)
    if (band.k === k) g.drawImage(band.canvas as CanvasImageSource, this.xf.surface === 'strip' ? Math.round(x) : x, Math.round(y));
    else g.drawImage(band.canvas as CanvasImageSource, x, y, band.canvas.width * (k / band.k), band.canvas.height * (k / band.k));
  }

  private blitClouds(g: Ctx2D, P: Planes, dl: DisplayList, p: number): void {
    const band = P.clouds!;
    const k = this.k();
    const sc = k / band.k;
    const period = P.cloudPeriod * k;
    let off = ((dl.camX * p + -dl.clouds) * k) % period;
    if (off < 0) off += period;
    const y = Math.round((band.y0 - this.xf.y0) * k);
    const x = this.xf.surface === 'strip' ? Math.round(-off) : -off;
    const w = band.canvas.width * sc;
    const h = band.canvas.height * sc;
    g.drawImage(band.canvas as CanvasImageSource, x, y, w, h);
    if (w + x < this.c.width) g.drawImage(band.canvas as CanvasImageSource, x + period, y, w, h);
  }

  private bloom(g: Ctx2D, P: Planes, alpha: number): void {
    const sky = P.light.sky;
    if (sky.sun.alpha < 0.05 || sky.sun.elevation < -4 || sky.sun.elevation > 30) return;
    const xf = this.xf;
    const band = makeBandView(xf);
    const F = frameFor(band, { kind: xf.surface, width: xf.width, height: xf.height, dpr: xf.res }, sky, P.light.shadow, 'autumn', 1, P.fakeY1, g);
    g.save();
    g.globalAlpha = alpha;
    drawSunBloom(F);
    g.restore();
  }

  private moonSprite: { k: number; c: AnyCanvas; r: number } | null = null;
  private skyAtPhase: { key: string; sky: SkySample } | null = null;

  /**
   * The sun and moon at the current phase, fixed to the screen, drawn the way the art kit's
   * drawSunMoonStars draws them (stacked paper discs and glow; a cut paper crescent).
   */
  private celestial(g: Ctx2D, dl: DisplayList, P: Planes): void {
    const key = `${dl.sky.phase.toFixed(4)}|${dl.sky.weather}`;
    if (!this.skyAtPhase || this.skyAtPhase.key !== key) this.skyAtPhase = { key, sky: sampleSky(dl.sky.phase, dl.sky.weather) };
    const sky = this.skyAtPhase.sky;
    const xf = this.xf;
    const k = this.k();
    const strip = xf.surface === 'strip';
    const F = frameFor(makeBandView(xf), { kind: xf.surface, width: xf.width, height: xf.height, dpr: xf.res }, sky, P.light.shadow, 'autumn', 1, P.fakeY1, g);
    g.save();
    g.setTransform(k, 0, 0, k, 0, -xf.y0 * k);
    const Pp = new Paper(g, k, 7);
    if (sky.sun.alpha > 0.01 && sky.sun.elevation > -6) {
      const [x, y] = celestialPos(F, sky.sun.x, sky.sun.elevation);
      const lowness = 1 - Math.min(1, Math.max(0, sky.sun.elevation / 40));
      const r = strip ? 6.5 : 15;
      const warm = mix(tok('lampGlow'), tok('flame'), lowness * 0.55);
      Pp.glow(x, y, r * (5 + lowness * 7), warm, 0.6 * sky.sun.alpha * (0.4 + lowness * 0.6));
      Pp.glow(x, y, r * 2.4, mix(tok('cream'), warm, 0.4), 0.75 * sky.sun.alpha);
      [3.2, 2.3, 1.6].forEach((m, i) => Pp.piece(ellipse(x, y, r * m, r * m, 48), mix(warm, tok('cream'), 0.3 + i * 0.15), { shadow: 0, wobble: 1.6, alpha: (0.1 + i * 0.05) * sky.sun.alpha }));
      Pp.piece(ellipse(x, y, r, r, 40), mix(tok('speciesHighlight'), warm, 0.12 + lowness * 0.18), { shadow: 0, alpha: sky.sun.alpha, rim: 0 });
    }
    if (sky.moon.alpha > 0.01) {
      const [x, y] = celestialPos(F, sky.moon.x, sky.moon.elevation);
      const r = strip ? 5.5 : 12;
      Pp.glow(x, y, r * 4, tok('cream'), 0.14 * sky.moon.alpha);
      if (!this.moonSprite || this.moonSprite.k !== k) {
        const pad = 2;
        const size = Math.ceil((r * 2 + pad * 2) * k);
        const c = canvas(size, size);
        const mg = ctx2d(c);
        mg.setTransform(k, 0, 0, k, (r + pad) * k, (r + pad) * k);
        const Q = new Paper(mg, k, 9);
        Q.piece(ellipse(0, 0, r, r, 40), 'cream', { shadow: 0 });
        mg.globalCompositeOperation = 'destination-out';
        Q.piece(ellipse(r * 0.55, -r * 0.25, r * 0.88, r * 0.88, 40), 'ink', { shadow: 0, wobble: 0.5 });
        this.moonSprite = { k, c, r: r + pad };
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = sky.moon.alpha;
      g.drawImage(this.moonSprite.c as CanvasImageSource, Math.round((x - this.moonSprite.r) * k), Math.round((y - xf.y0 - this.moonSprite.r) * k));
    }
    g.restore();
  }

  /** Low sun: a path of warm glints on the near water under the sun, fixed to the screen like a real reflection. */
  private glitter(dl: DisplayList): void {
    const sky = this.cur!.planes.light.sky;
    if (sky.sun.alpha < 0.05 || sky.sun.elevation < -3 || sky.sun.elevation > 32) return;
    const low = Math.max(0, Math.min(1, 1 - sky.sun.elevation / 32)) * (1 - sky.spec.cloudCover * 0.8);
    if (low < 0.05) return;
    const g = this.g;
    const k = this.k();
    const xf = this.xf;
    const cx = sky.sun.x * xf.W;
    const r = rng(hash(dl.layout.seed, 4711));
    const top = 102.5;
    const bot = xf.y1;
    const shimmer = Math.floor(dl.t * 4);
    g.setTransform(k, 0, 0, k, 0, -xf.y0 * k);
    const warm = mix(tok('lampGlow'), tok('cream'), 0.45);
    for (let i = 0; i < 70; i++) {
      const y = top + Math.pow(r(), 1.4) * (bot - top);
      const spread = 6 + (y - top) * 0.9;
      const x = cx + (r() - 0.5) * 2 * spread;
      const len = 1.5 + r() * 5 * (0.6 + (y - top) / (bot - top));
      const on = (hash(i, shimmer) % 100) / 100 < 0.72;
      if (!on) continue;
      g.globalAlpha = low * (0.35 + 0.5 * r()) * (1 - Math.abs(x - cx) / (spread * 1.2));
      g.fillStyle = css(warm);
      g.fillRect(x - len / 2, y, len, 0.45 + (y - top) * 0.008);
    }
    g.globalAlpha = 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Unit-space transform for dynamic drawing at parallax 1. */
  private unitXf(g: Ctx2D, dl: DisplayList): void {
    const k = this.k();
    g.setTransform(k, 0, 0, k, -dl.camX * k, -this.xf.y0 * k);
  }

  private dev(dl: DisplayList, x: number, y: number): [number, number] {
    const k = this.k();
    return [(mapX(this.xf, x) - dl.camX) * k, (y - this.xf.y0) * k];
  }

  private lit(dl: DisplayList, id: string, x: number, y: number, o: Parameters<LitSprites['get']>[1], alpha = 1): void {
    const e = this.sprites!.get(id, o);
    if (!e) return;
    const [dx, dy] = this.dev(dl, x, y);
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = alpha;
    g.drawImage(e.c as CanvasImageSource, Math.round(dx + e.ax), Math.round(dy + e.ay));
    g.globalAlpha = 1;
  }

  /** Strip mill shadows are cached by orientation; short-lived effects and ambient cast them live. */
  private litRotated(dl: DisplayList, id: string, x: number, y: number, rot: number, gap: number, scale = 1, alpha = 1): void {
    if (this.xf.surface === 'strip' && id.endsWith('/part') && scale === 1) {
      const e = this.sprites!.getRotated(id, rot, gap);
      if (!e) return;
      const [dx, dy] = this.dev(dl, x, y);
      const g = this.g;
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = alpha;
      g.drawImage(e.c as CanvasImageSource, Math.round(dx + e.ax), Math.round(dy + e.ay));
      g.restore();
      return;
    }
    const e = this.sprites!.get(id, { gap: 0 });
    const f = this.atlas!.frames.get(id);
    if (!e || !f) return;
    const k = this.k();
    const [dx, dy] = this.dev(dl, x, y);
    const g = this.g;
    const L = this.cur!.planes.light;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = alpha;
    if (gap > 0 && L.shadow.alpha > 0.002) {
      g.shadowColor = css(tok('ink'), L.shadow.alpha);
      g.shadowOffsetX = L.shadow.dx * gap * k;
      g.shadowOffsetY = L.shadow.dy * gap * k;
      g.shadowBlur = L.shadow.blur * gap * k;
    }
    g.translate(dx, dy);
    g.rotate(rot);
    g.scale(scale, scale);
    g.drawImage(e.c as CanvasImageSource, e.ax, e.ay);
    g.restore();
  }

  private drawDynamic(dl: DisplayList): void {
    const g = this.g;
    const L = this.cur!.planes.light;
    const sky = L.sky;
    const atlas = this.atlas!;
    const layout = dl.layout;
    // bell post appearing for an alert before hooks are connected
    if (!layout.bell.present && dl.bellVisible) this.lit(dl, 'st/bellpost/1', layout.bell.x, BASE, { gap: 2.2 });
    // rotating parts (sails, waterwheel)
    for (const s of layout.structures) {
      const a = dl.parts.get(s.id);
      if (a === undefined || !s.pts.pivot) continue;
      this.litRotated(dl, `st/${s.kind}/part`, s.x + s.pts.pivot[0], BASE + s.pts.pivot[1], a, 2.2);
    }
    // resting bell
    if (dl.bellVisible && !dl.flag.ringing) {
      const pts = STRUCTURES[layout.bell.kind]!.points(layout.bell.stage);
      if (pts.bell) this.lit(dl, 'alert/bell-rest', layout.bell.x + pts.bell[0], BASE + pts.bell[1], { gap: 2.2 });
    }
    // smoke from chimneys: paper puffs stepped at 4 fps
    const step6 = Math.floor(dl.t * 4) / 4;
    for (const id of dl.smoke) {
      const s = layout.byId.get(id);
      const c = s?.pts.chimney;
      if (!s || !c) continue;
      const r = rng(hash(layout.seed, s.x | 0));
      const lean = 1.2 + sky.spec.wind * 3;
      for (let i = 0; i < 4; i++) {
        const ph = (i + ((step6 * 0.35 + r()) % 1)) / 4;
        const x = s.x + c[0] + ph * lean * 6 + Math.sin(ph * 6 + i) * 0.8;
        const y = BASE + c[1] - 2 - ph * 16;
        this.lit(dl, `fx/smoke/${Math.min(2, Math.floor(ph * 3))}`, x, y, { gap: 0.8, shadowGain: 0.5 }, 0.85 * (1 - ph * 0.85));
      }
    }
    // contact shadows under residents, then the residents
    const sp = L.shadow;
    const ca = Math.min(0.5, sp.alpha * 2.2) * 0.9;
    if (ca > 0.01) {
      this.unitXf(g, dl);
      g.fillStyle = css(tok('ink'), ca);
      for (const r of dl.residents) {
        if (r.dy) continue;
        const w = r.helper ? 5 : 10;
        const x = mapX(this.xf, r.x) + sp.side * w * 0.22 * sp.length * 0.4;
        g.beginPath();
        g.ellipse(x, GROUND - 0.4, (w / 2) * (1 + sp.length * 0.25), 1.6 + w * 0.025, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
    for (const r of dl.residents) {
      const pre = r.helper ? 'hlp' : 'res';
      this.lit(dl, `${pre}/${r.species}/${r.pose}`, r.x, GROUND + r.dy, { gap: 0.9, scarf: r.scarf, flip: r.facing === -1 }, r.alpha);
    }
    // flying planks, dust, confetti
    for (const p of dl.planks) this.litRotated(dl, 'fx/plank', p.x, GROUND + p.y, p.rot, 0.9);
    for (const d of dl.dust) this.litRotated(dl, 'fx/dust', d.x, BASE + 1 + d.dy, 0, 0, d.scale, d.alpha);
    if (dl.confetti.length) {
      this.unitXf(g, dl);
      const cols = SCARVES.map((t) => css(mix(tok(t), tok('cream'), 0.08)));
      for (const c of dl.confetti) {
        g.save();
        g.translate(mapX(this.xf, c.x), GROUND + c.y);
        g.rotate(c.rot);
        g.globalAlpha = c.alpha;
        g.fillStyle = cols[c.color % cols.length];
        g.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
        g.restore();
      }
    }
    // "+N" over crowded workshops
    for (const e of dl.extras) {
      const text = `+${e.n}`;
      let x = e.x - (text.length - 1) * 2.6;
      for (const ch of text) {
        this.lit(dl, `glyph/${ch}`, x, e.y, { gap: 0.6 });
        x += 5.2;
      }
    }
    // emissive: campfire flames, lanterns of residents waiting for their turn, fireflies
    this.unitXf(g, dl);
    for (const s of layout.structures) if (s.kind === 'campfire') {
      g.setTransform(1, 0, 0, 1, 0, 0);
      this.unitXf(g, dl);
      drawFrame(g, atlas, `st/campfire/1/lit/${Math.floor(dl.t * 8) % 4}`, mapX(this.xf, s.x), BASE);
    }
    for (const r of dl.residents) {
      if (!r.glow) continue;
      this.unitXf(g, dl);
      drawFrame(g, atlas, 'fx/glow', mapX(this.xf, r.x) + r.facing * 6, GROUND - 8, { alpha: 0.35 + 0.5 * Math.max(dl.sky.lamps, 0.3), scale: 0.9 });
    }
    const variant = this.cur?.planes.variant ?? this.xf.variant ?? 'default';
    const params = getVariantParams(variant);
    const fireflyActive = dl.fireflies || (params.fireflies && (dl.sky.lamps > 0.05 || dl.sky.phase > 0.58 || dl.sky.phase < 0.22));
    if (fireflyActive && dl.particleStep >= 0) this.drawFireflies(dl);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawFireflies(dl: DisplayList): void {
    const g = this.g;
    const k = this.k();
    if (!this.fly) {
      const r = Math.ceil(4 * k);
      this.fly = canvas(r * 2, r * 2);
      const fg = ctx2d(this.fly);
      fg.setTransform(k, 0, 0, k, r, r);
      firefly(new Paper(fg, k, 3), 0, 0, 1);
    }
    const variant = this.cur?.planes.variant ?? this.xf.variant ?? 'default';
    const params = getVariantParams(variant);
    let n = this.xf.surface === 'strip' ? Math.round(this.xf.W / 40) : 46;
    if (params.fireflies) n = Math.round(n * 1.6);
    const r = rng(hash(dl.layout.seed, 555));
    const t = dl.particleStep / 6;
    const x0 = dl.camX - 20;
    const span = this.xf.surface === 'strip' ? this.xf.W + 40 : CANON_SPAN;
    g.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = 0; i < n; i++) {
      const bx = (this.xf.surface === 'strip' ? 0 : -20) + range(r, 0, span);
      const by = range(r, GROUND - 30, GROUND + 4);
      const ph = range(r, 0, 6.28);
      const sp = range(r, 0.25, 0.6);
      const x = bx + Math.sin(t * sp + ph) * 6;
      const y = by + Math.sin(t * sp * 1.3 + ph * 2) * 3;
      const blink = 0.5 + 0.5 * Math.sin(t * 1.7 + ph * 3);
      const a = blink * Math.max(dl.sky.lamps, params.fireflies ? 0.35 : 0.2);
      if (a < 0.08) continue;
      const [dx, dy] = this.devRaw(dl, x, y);
      if (dx < -20 || dx > this.c.width + 20) continue;
      g.globalAlpha = a;
      g.drawImage(this.fly as CanvasImageSource, Math.round(dx - this.fly.width / 2), Math.round(dy - this.fly.height / 2));
    }
    g.globalAlpha = 1;
    void x0;
  }

  /** Canonical x already in view units for the strip map. */
  private devRaw(dl: DisplayList, x: number, y: number): [number, number] {
    const k = this.k();
    return [(x - (this.xf.surface === 'strip' ? 0 : dl.camX)) * k, (y - this.xf.y0) * k];
  }

  // ------------------------------------------------------------------ weather

  private tiles = new Map<string, { pattern: CanvasPattern; w: number; h: number }>();

  /** A tileable weather sheet (rain, light rain, snow, leaves), rasterised once per scale and light. */
  private tile(kind: 'rain' | 'rain-light' | 'snow' | 'leaves', sky: SkySample): { pattern: CanvasPattern; w: number; h: number } | null {
    const k = this.k();
    const night = Math.round(sky.lamps * 4) / 4;
    const key = `${kind}|${k.toFixed(3)}|${night}|${sky.spec.wind}`;
    const hit = this.tiles.get(key);
    if (hit) return hit;
    const tw = 96;
    const th = 64;
    const c = canvas(tw * k, th * k);
    const g = ctx2d(c);
    g.setTransform(k, 0, 0, k, 0, 0);
    const P = new Paper(g, k, 5);
    const r = rng(777);
    const wind = sky.spec.wind;
    const wrapDraw = (x: number, y: number, fn: (x: number, y: number) => void) => {
      for (const ox of [-tw, 0, tw]) for (const oy of [-th, 0, th]) fn(x + ox, y + oy);
    };
    if (kind === 'rain' || kind === 'rain-light') {
      // ink strokes by day, pale strokes at night so rain still reads against a dark sky
      const col = mix(tok('ink'), tok('stoneLight'), Math.min(1, sky.lamps * 1.1));
      const n = Math.round((tw * th) / (kind === 'rain-light' ? 620 : 260));
      for (let i = 0; i < n; i++) {
        const x = range(r, 0, tw);
        const y = range(r, 0, th);
        const len = range(r, 3.5, 6);
        const a = range(r, 0.3, 0.55);
        const slant = 0.12 + wind * 0.25;
        wrapDraw(x, y, (xx, yy) => P.line([[xx, yy], [xx + slant * len, yy + len]], 0.42, col, { shadow: 0, wobble: 0, alpha: a }));
      }
    } else if (kind === 'snow') {
      const n = Math.round((tw * th) / 140);
      for (let i = 0; i < n; i++) {
        const x = range(r, 0, tw);
        const y = range(r, 0, th);
        const s = range(r, 0.45, 1.05) * (this.xf.surface === 'strip' ? 1 : 0.8);
        const a = range(r, 0.6, 1);
        wrapDraw(x, y, (xx, yy) => snowflake(P, xx, yy, s, a));
      }
    } else {
      const n = sky.spec.particles === 'leaves' ? 7 : 2;
      for (let i = 0; i < n; i++) {
        const x = range(r, 0, tw);
        const y = range(r, 0, th);
        const rot = range(r, 0, 6.28);
        wrapDraw(x, y, (xx, yy) => leaf(P, xx, yy, rot, i % 2 ? 1.3 : 1.5, i % 2 ? 'leafRust' : 'leafAmber'));
      }
    }
    const pattern = this.g.createPattern(c as CanvasImageSource, 'repeat');
    if (!pattern) return null;
    pattern.setTransform?.(new DOMMatrix([1 / k, 0, 0, 1 / k, 0, 0]));
    const t = { pattern, w: tw, h: th };
    if (this.tiles.size > 12) this.tiles.clear();
    this.tiles.set(key, t);
    return t;
  }

  /** Fill a unit-space rectangle with a falling tile, offset by the particle step. */
  private fillTile(dl: DisplayList, t: { pattern: CanvasPattern; w: number; h: number }, fall: number, drift: number, rate: number, x0: number, y0: number, w: number, h: number): void {
    const g = this.g;
    const k = this.k();
    const st = dl.particleStep / rate;
    const ox = (((st * drift - dl.camX * 0.5) % t.w) + t.w) % t.w;
    const oy = (st * fall) % t.h;
    g.save();
    g.setTransform(k, 0, 0, k, (ox - (this.xf.surface === 'strip' ? 0 : 0)) * k, (oy - this.xf.y0) * k);
    g.fillStyle = t.pattern;
    g.fillRect(x0 - ox, y0 - oy, w, h);
    g.restore();
  }

  private drawWeather(dl: DisplayList): void {
    const sky = this.cur!.planes.light.sky;
    const g = this.g;
    const k = this.k();
    const spec = sky.spec;
    // local shower clouds over limited providers' workshops
    for (const [a0, b0] of dl.showers) {
      const a = mapX(this.xf, a0);
      const b = mapX(this.xf, b0);
      this.unitXf(g, dl);
      const P = new Paper(g, k, 9);
      const cy = this.xf.surface === 'strip' ? 12 : -10;
      const w = b - a;
      const dim = (c: ReturnType<typeof tok>) => mix(c, tok('skyNightTop'), Math.min(0.6, sky.lamps * 0.55));
      for (let i = 0; i < 4; i++) P.piece(ellipse(a + w * (0.15 + i * 0.24), cy + (i % 2) * 2.2, w * 0.2, 5.2, 24), dim(mix(tok('worrySlate'), tok('stone'), 0.25 + (i % 2) * 0.15)), { rim: 1, shadow: 1 });
      P.piece(ellipse(a + w * 0.5, cy + 3.5, w * 0.48, 4.2, 30), dim(tok('worrySlate')), { rim: 0.6, shadow: 1 });
    }
    if (dl.particleStep < 0) return;
    const top = this.xf.y0 - 70;
    const span = this.xf.y1 - top + 70;
    const wide = this.xf.W + 200;
    const autumnWind = dl.sky.season === 'autumn' && spec.wind > 0.2;
    const variant = this.cur?.planes.variant ?? this.xf.variant ?? 'default';
    const params = getVariantParams(variant);
    let kind: 'rain' | 'rain-light' | 'snow' | 'leaves' | null =
      spec.particles === 'rain' || spec.particles === 'rain-light' || spec.particles === 'snow'
        ? spec.particles
        : spec.particles === 'leaves' || autumnWind
          ? 'leaves'
          : null;
    if (!kind && params.seasonalRichness) {
      if (dl.sky.season === 'autumn') kind = 'leaves';
      else if (dl.sky.season === 'winter') kind = 'snow';
    }
    if (kind) {
      const t = this.tile(kind, sky);
      const rain = kind === 'rain' || kind === 'rain-light';
      if (t) this.fillTile(dl, t, rain ? 120 : kind === 'snow' ? 9 : 7, rain ? 14 + spec.wind * 30 : kind === 'snow' ? 3 + spec.wind * 6 : 10 + spec.wind * 14, rain ? 12 : 6, -100, top, wide, span);
    }
    if (dl.showers.length) {
      const t = this.tile('rain', sky);
      if (t) {
        for (const [a0, b0] of dl.showers) {
          const a = mapX(this.xf, a0) - dl.camX;
          const b = mapX(this.xf, b0) - dl.camX;
          const sTop = this.xf.surface === 'strip' ? 16 : -6;
          this.fillTile(dl, t, 120, 6, 12, a + 4, sTop, b - a - 8, GROUND + 6 - sTop);
        }
      }
    }
  }

  // ------------------------------------------------------------------ alert

  private drawAlert(dl: DisplayList): void {
    const layout = dl.layout;
    if (!dl.bellVisible) return;
    const g = this.g;
    const atlas = this.atlas!;
    const pts = STRUCTURES[layout.bell.kind]!.points(layout.bell.stage);
    const x = mapX(this.xf, layout.bell.x);
    const k = this.k();
    this.unitXf(g, dl);
    const P = new Paper(g, k, 3);
    const f = dl.flag;
    if (pts.flag) {
      const fx = x + pts.flag[0];
      const fy = BASE + pts.flag[1];
      if (f.raised) {
        const drop = (1 - f.rise) * 9;
        P.glow(fx + 7, fy + 5 + drop, 16, mix(tok('alertFlag'), tok('cream'), 0.4), 0.42 * Math.max(0.3, f.rise));
        this.unitXf(g, dl);
        drawFrame(g, atlas, `alert/flag/${f.icon}/${f.wave}`, fx, fy + drop);
      } else {
        this.unitXf(g, dl);
        drawFrame(g, atlas, 'alert/flag-furled', fx - 1.2, BASE - 20);
      }
    }
    if (pts.bell && f.ringing) {
      const bx = x + pts.bell[0];
      const by = BASE + pts.bell[1];
      this.unitXf(g, dl);
      drawFrame(g, atlas, `alert/bell/${f.swing}`, bx, by);
      this.unitXf(g, dl);
      for (const side of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const ang = (-0.5 + i * 0.5) * 0.9;
          const cx = bx + side * 0.5;
          const cy = by + 5;
          const p0: [number, number] = [cx + side * Math.cos(ang) * 7.5, cy + Math.sin(ang) * 7.5];
          const p1: [number, number] = [cx + side * Math.cos(ang) * 10.5, cy + Math.sin(ang) * 10.5];
          P.line([p0, p1], 1.5, 'cream', { shadow: 0, wobble: 0 });
          P.line([p0, p1], 0.7, 'ink', { shadow: 0, wobble: 0 });
        }
      }
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
}

const CANON_SPAN = 1480;

function phaseDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d);
}

function makeBandView(xf: ViewXf) {
  return { canvas: null as unknown as AnyCanvas, k: xf.s * xf.res, x0: 0, y0: xf.y0, w: xf.W, h: xf.y1 - xf.y0 };
}

export { blob, shadowFor };
export type { Light };
