/**
 * Reference compositor (Canvas2D). Renders a scene description to a canvas the way the PixiJS
 * renderer (WP-10) should: each paper layer is drawn untinted, multiplied by the time-of-day light,
 * hazed toward the horizon by depth, then laid over the layers behind it with a soft ink drop shadow
 * whose offset follows the sun. Emissive things (lit windows, lamps, fire, the alert flag and bell)
 * are drawn after lighting so night never dims them.
 */
import { SIZES, PAL } from './tokens.ts';
import { tok, css, mix, type RGB } from './color.ts';
import { sampleSky, skyAt, type SkySample, type Weather } from './sky.ts';
import { shadowFor, type ShadowParams } from './shadow.ts';
import { Paper, makeCanvas, type Ctx2D, ellipse, blob } from './paper.ts';
import { LAND, drawFarHills, drawMidHills, drawRiver, drawBank, drawNearWater, drawReeds, drawMountains, drawFarBank, type Season } from './terrain.ts';
import { hash, rng, range } from './rng.ts';

export interface View {
  kind: 'strip' | 'ambient';
  /** CSS pixels */
  width: number;
  height: number;
  dpr: number;
  /** ambient: left edge of the camera in strip units */
  cameraX?: number;
}

export interface Frame {
  /** canvas being drawn */
  ctx: Ctx2D;
  view: View;
  /** device px per strip unit */
  k: number;
  /** strip units per CSS px inverse: CSS px per unit */
  s: number;
  /** view width in units */
  W: number;
  /** top of the view in strip-unit y (0 for strips, negative for ambient) */
  y0: number;
  /** bottom of the view in strip-unit y */
  y1: number;
  /** horizontal camera offset in units */
  camX: number;
  sky: SkySample;
  shadow: ShadowParams;
  season: Season;
  seed: number;
}

export function makeFrame(ctx: Ctx2D, view: View, phase: number, weather: Weather, season: Season, seed: number): Frame {
  const sky = sampleSky(phase, weather);
  if (view.kind === 'strip') {
    const s = view.height / SIZES.stripHeight;
    return { ctx, view, k: s * view.dpr, s, W: view.width / s, y0: 0, y1: SIZES.stripHeight, camX: 0, sky, shadow: shadowFor(sky), season, seed };
  }
  const s = SIZES.ambientWorldScale * (view.height / 1080) ;
  const hUnits = view.height / s;
  const y1 = SIZES.stripHeight;
  return { ctx, view, k: s * view.dpr, s, W: view.width / s, y0: y1 - hUnits, y1, camX: view.cameraX ?? 0, sky, shadow: shadowFor(sky), season, seed };
}

/** Haze amount per layer (atmospheric perspective toward the sky). */
export const HAZE = {
  mountains: 0.5,
  farHills: 0.3,
  midHills: 0.15,
  river: 0.42,
  nearWater: 0.22,
  bank: 0.04,
  structures: 0,
  residents: 0,
  reeds: 0,
} as const;

let scratchA: OffscreenCanvas | HTMLCanvasElement | null = null;
let scratchB: OffscreenCanvas | HTMLCanvasElement | null = null;

function scratch(which: 'a' | 'b', w: number, h: number): { c: OffscreenCanvas | HTMLCanvasElement; g: Ctx2D } {
  let c = which === 'a' ? scratchA : scratchB;
  if (!c || c.width !== w || c.height !== h) {
    c = makeCanvas(w, h);
    if (which === 'a') scratchA = c;
    else scratchB = c;
  }
  const g = c.getContext('2d') as Ctx2D;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.clearRect(0, 0, w, h);
  return { c, g };
}

/** Paper context positioned in strip units for this frame (with camera and vertical offset). */
export function paperFor(g: Ctx2D, F: Frame, seed: number): Paper {
  g.setTransform(F.k, 0, 0, F.k, -F.camX * F.k, -F.y0 * F.k);
  return new Paper(g, F.k, seed);
}

/**
 * Draw one paper layer: `draw` paints it untinted into a scratch canvas, which is then lit
 * (multiply by the sky light), hazed (mixed toward the horizon colour by depth), and laid
 * over the frame with a sun-driven drop shadow.
 */
export function layer(F: Frame, opts: { gap: number; haze: number; shadowGain?: number; lightGain?: number }, draw: (P: Paper) => void): void {
  const w = F.ctx.canvas.width;
  const h = F.ctx.canvas.height;
  const A = scratch('a', w, h);
  draw(paperFor(A.g, F, F.seed));
  A.g.setTransform(1, 0, 0, 1, 0, 0);
  const B = scratch('b', w, h);
  // B = A multiplied by light, alpha from A
  B.g.drawImage(A.c as CanvasImageSource, 0, 0);
  B.g.globalCompositeOperation = 'multiply';
  const light = mix(tok('lightDay'), F.sky.light, opts.lightGain ?? 1);
  B.g.fillStyle = css(light);
  B.g.fillRect(0, 0, w, h);
  B.g.globalCompositeOperation = 'destination-in';
  B.g.drawImage(A.c as CanvasImageSource, 0, 0);
  const hz = Math.min(0.9, opts.haze * (1 + F.sky.hazeBoost * 3) + F.sky.hazeBoost * 0.5 * Math.min(1, opts.haze * 4));
  if (hz > 0.001) {
    B.g.globalCompositeOperation = 'source-atop';
    B.g.fillStyle = css(F.sky.haze, hz);
    B.g.fillRect(0, 0, w, h);
  }
  B.g.globalCompositeOperation = 'source-over';
  const ctx = F.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const sp = F.shadow;
  const a = sp.alpha * (opts.shadowGain ?? 1);
  if (a > 0.002 && opts.gap > 0) {
    ctx.shadowColor = css(tok('ink'), a);
    ctx.shadowOffsetX = sp.dx * opts.gap * F.k;
    ctx.shadowOffsetY = sp.dy * opts.gap * F.k;
    ctx.shadowBlur = sp.blur * opts.gap * F.k;
  }
  ctx.drawImage(B.c as CanvasImageSource, 0, 0);
  ctx.restore();
}

/** Emissive layer: drawn straight onto the frame after lighting (no tint, no haze). */
export function emissive(F: Frame, draw: (P: Paper) => void, composite: GlobalCompositeOperation = 'source-over'): void {
  const ctx = F.ctx;
  ctx.save();
  ctx.globalCompositeOperation = composite;
  draw(paperFor(ctx, F, F.seed));
  ctx.restore();
}

// ---------------------------------------------------------------- sky

/** y (strip units) of the sky horizon in this view. */
export function horizonY(F: Frame): number {
  return F.view.kind === 'strip' ? LAND.riverTop + 2 : F.y0 + SIZES.ambientSkyFraction * (F.y1 - F.y0);
}

export function drawSky(F: Frame): void {
  const ctx = F.ctx;
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const hy = (horizonY(F) - F.y0) * F.k;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const g = ctx.createLinearGradient(0, 0, 0, hy);
  if (F.view.kind === 'ambient') {
    // tall sky: zenith, then the two SPEC stops
    g.addColorStop(0, css(F.sky.zenith));
    for (let i = 1; i <= 8; i++) g.addColorStop(0.18 + (i / 8) * 0.82, css(skyAt(F.sky, i / 8)));
  } else for (let i = 0; i <= 8; i++) g.addColorStop(i / 8, css(skyAt(F.sky, i / 8)));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  // tissue-paper bands: translucent cut strips laid across the lower sky, the papercut way to grade light
  emissive(F, (P) => {
    const hzY = horizonY(F);
    const span = hzY - F.y0;
    const bands = F.view.kind === 'strip' ? 2 : 4;
    for (let i = 0; i < bands; i++) {
      const f0 = 0.35 + i * (0.6 / bands);
      const yTop = F.y0 + span * f0;
      // low warm suns colour the bands near the horizon (sunset streaks); otherwise they are lighter tissue
      const sun = F.sky.sun;
      const glowAmt = sun.alpha > 0.1 && sun.elevation < 30 && sun.elevation > -6 ? (1 - Math.max(0, sun.elevation) / 30) * (1 - F.sky.spec.cloudCover * 0.7) : 0;
      const warm = mix(tok('lampGlow'), tok('flame'), 0.45);
      const c = mix(mix(skyAt(F.sky, f0 + 0.08), tok('cream'), 0.25 + i * 0.08), warm, glowAmt * (0.15 + i * 0.12));
      const pts: [number, number][] = [];
      const x0 = F.camX - 40;
      const x1 = F.camX + F.W + 40;
      for (let x = x0; x <= x1; x += 8) pts.push([x, yTop + Math.sin(x * 0.011 + i * 1.7) * span * 0.025 + Math.sin(x * 0.037 + i) * span * 0.01]);
      pts.push([x1, hzY + 20]);
      pts.push([x0, hzY + 20]);
      P.piece(pts, c, { shadow: 0, wobble: 2.2, alpha: 0.18 + i * 0.05 });
    }
  });
}

/** Where the sun or moon sits on screen (units), given elevation. */
export function celestialPos(F: Frame, x: number, elevation: number): [number, number] {
  if (F.view.kind === 'strip') return [F.camX + x * F.W, 47 - elevation * 0.95];
  const hy = horizonY(F);
  const span = hy - F.y0 - 30;
  // low suns sink between the peaks; high suns climb toward the top of the sky
  return [F.camX + x * F.W, hy - 22 - Math.min(span - 22, elevation * 2.4)];
}

export function drawSunMoonStars(F: Frame): void {
  const { sky } = F;
  const strip = F.view.kind === 'strip';
  // stars
  if (sky.stars > 0.01) {
    emissive(F, (P) => {
      const r = rng(hash(F.seed, 901));
      const n = Math.round(F.W * (strip ? 0.09 : 0.45));
      const yTop = F.y0 + 2;
      const yBot = horizonY(F) - (strip ? 22 : 40);
      for (let i = 0; i < n; i++) {
        const x = F.camX + range(r, 0, F.W);
        const y = range(r, yTop, yBot);
        const big = r() < 0.12;
        const a = sky.stars * range(r, 0.35, 1) * (1 - (y - yTop) / (yBot - yTop + 1) * 0.5);
        const rr = (big ? 0.55 : 0.32) * (strip ? 1 : 0.75);
        P.piece(
          [
            [x, y - rr * 2.2],
            [x + rr * 0.5, y - rr * 0.5],
            [x + rr * 2.2, y],
            [x + rr * 0.5, y + rr * 0.5],
            [x, y + rr * 2.2],
            [x - rr * 0.5, y + rr * 0.5],
            [x - rr * 2.2, y],
            [x - rr * 0.5, y - rr * 0.5],
          ],
          'cream',
          { wobble: 0, shadow: 0, alpha: a },
        );
      }
    });
  }
  // sun: a papercut sunburst of stacked translucent paper discs, warmer and bigger when low
  if (sky.sun.alpha > 0.01 && sky.sun.elevation > -6) {
    const [x, y] = celestialPos(F, sky.sun.x, sky.sun.elevation);
    const lowness = 1 - Math.min(1, Math.max(0, sky.sun.elevation / 40));
    const r = strip ? 6.5 : 15;
    const warm = mix(tok('lampGlow'), tok('flame'), lowness * 0.55);
    emissive(F, (P) => {
      P.glow(x, y, r * (5 + lowness * 7), warm, 0.6 * sky.sun.alpha * (0.4 + lowness * 0.6));
      P.glow(x, y, r * 2.4, mix(tok('cream'), warm, 0.4), 0.75 * sky.sun.alpha);
    }, 'source-over');
    emissive(F, (P) => {
      const rings = [3.2, 2.3, 1.6];
      rings.forEach((m, i) => P.piece(ellipse(x, y, r * m, r * m, 48), mix(warm, tok('cream'), 0.3 + i * 0.15), { shadow: 0, wobble: 1.6, alpha: (0.1 + i * 0.05) * sky.sun.alpha }));
      P.piece(ellipse(x, y, r, r, 40), mix(tok('speciesHighlight'), warm, 0.12 + lowness * 0.18), { shadow: 0, alpha: sky.sun.alpha, rim: 0 });
    });
  }
  // moon: a paper crescent
  if (sky.moon.alpha > 0.01) {
    const [x, y] = celestialPos(F, sky.moon.x, sky.moon.elevation);
    const r = strip ? 5.5 : 12;
    emissive(F, (P) => {
      P.glow(x, y, r * 4, tok('cream'), 0.18 * sky.moon.alpha);
    }, 'screen');
    // the crescent is cut on a scratch canvas (cutting on the frame would punch a hole in the sky)
    const ctx = F.ctx;
    const pad = 2;
    const size = Math.ceil((r * 2 + pad * 2) * F.k);
    const sc = makeCanvas(size, size);
    const sg = sc.getContext('2d') as Ctx2D;
    sg.setTransform(F.k, 0, 0, F.k, (r + pad) * F.k, (r + pad) * F.k);
    const Q = new Paper(sg, F.k, 9);
    Q.piece(ellipse(0, 0, r, r, 40), 'cream', { shadow: 0 });
    sg.globalCompositeOperation = 'destination-out';
    Q.piece(ellipse(r * 0.55, -r * 0.25, r * 0.88, r * 0.88, 40), 'ink', { shadow: 0, wobble: 0.5 });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = sky.moon.alpha;
    ctx.drawImage(sc as CanvasImageSource, Math.round((x - F.camX - r - pad) * F.k), Math.round((y - F.y0 - r - pad) * F.k));
    ctx.restore();
  }
}

/** Paper clouds; coverage from the weather (weekly window). Lit and hazed like other paper. */
export function drawClouds(F: Frame, t = 0): void {
  const cover = F.sky.spec.cloudCover;
  if (cover < 0.05) return;
  const strip = F.view.kind === 'strip';
  const grey = mix(tok('cream'), tok('worrySlate'), Math.max(0, F.sky.spec.skyMix - 0.2) * 0.75);
  layer(F, { gap: 1.4, haze: 0.18, shadowGain: 0.8 }, (P) => {
    const r = rng(hash(F.seed, 77));
    const n = Math.round((F.W / (strip ? 260 : 160)) * (0.5 + cover * 2.6));
    const yTop = F.y0 + (strip ? 6 : 24);
    const yBot = strip ? 36 : horizonY(F) - 70;
    for (let i = 0; i < n; i++) {
      const w = range(r, strip ? 34 : 70, strip ? 80 : 190) * (0.75 + cover * 0.5);
      const x = F.camX + ((range(r, -0.1, 1.1) * F.W + t * range(r, 0.4, 1.2)) % (F.W + 60)) - 30;
      const y = range(r, yTop, yBot);
      const hgt = w * range(r, 0.2, 0.3);
      const seed = hash(F.seed, 78, i);
      const under = mix(grey, tok('skyDuskTop'), 0.22);
      const topc = mix(grey, tok('lampGlow'), 0.18);
      P.piece(blob(x, y, w / 2, hgt / 2, seed, 6, 0.42, true), under, { rim: 1, shadow: 0.6 });
      P.piece(blob(x - w * 0.08, y - hgt * 0.22, w * 0.36, hgt * 0.36, seed + 1, 5, 0.4, true), mix(grey, tok('stoneLight'), 0.3), { rim: 1, shadow: 0.7 });
      P.piece(blob(x - w * 0.14, y - hgt * 0.36, w * 0.22, hgt * 0.26, seed + 2, 5, 0.4, true), topc, { rim: 1, shadow: 0.7 });
    }
    P.grain(F.camX - 40, F.y0, F.W + 80, yBot - F.y0 + 20);
  });
}

// ---------------------------------------------------------------- terrain stack

export interface TerrainOpts {
  /** extra drawing on top of the bank (contact shadows etc.) */
  onBank?: (P: Paper) => void;
}

export function drawTerrainBack(F: Frame): void {
  const L = (P: Paper) => ({ P, W: F.W + F.camX + 20, seed: F.seed, season: F.season });
  if (F.view.kind === 'ambient') {
    const hz = horizonY(F);
    const sunSide = F.sky.sun.alpha > 0.1 ? (F.sky.sun.x < 0.5 ? -1 : 1) : -1;
    layer(F, { gap: 1.6, haze: 0.5 }, (P) => drawMountains({ ...L(P), seed: F.seed + 1, sunSide }, hz - 22, LAND.farHillsY + 4, 'mountain', 0.7));
    layer(F, { gap: 1.6, haze: 0.28 }, (P) => drawMountains({ ...L(P), seed: F.seed + 2, sunSide }, hz + 14, LAND.farHillsY + 8, mix(tok('mountain'), tok('midHills'), 0.35), 0.8));
  }
  layer(F, { gap: 1.2, haze: HAZE.farHills }, (P) => drawFarHills(L(P)));
  layer(F, { gap: 1.0, haze: HAZE.midHills }, (P) => drawMidHills(L(P)));
  if (F.view.kind === 'ambient') layer(F, { gap: 0.8, haze: 0.12 }, (P) => drawFarBank(L(P), LAND.riverTop - 1.5, LAND.riverTop + 3));
  layer(F, { gap: 0.4, haze: HAZE.river, shadowGain: 0.5, lightGain: 0.6 }, (P) => drawRiver(L(P)));
}

/** Light bloom: the low sun's glow bleeding over the ridges (drawn after the far layers). */
export function drawSunBloom(F: Frame): void {
  const sun = F.sky.sun;
  if (sun.alpha < 0.05 || sun.elevation < -4 || sun.elevation > 30) return;
  const [x, y] = celestialPos(F, sun.x, sun.elevation);
  const lowness = 1 - Math.max(0, sun.elevation) / 30;
  const r = F.view.kind === 'strip' ? 70 : 260;
  emissive(F, (P) => P.glow(x, y + (F.view.kind === 'strip' ? 6 : 20), r, mix(tok('lampGlow'), tok('cream'), 0.4), 0.38 * lowness * sun.alpha * (1 - F.sky.spec.cloudCover * 0.6)), 'screen');
}

export function drawFog(F: Frame, t = 0): void {
  const fog = F.sky.spec.fogBand;
  if (fog <= 0.01) return;
  // translucent paper bands of mist lying over the river, slowly drifting
  emissive(F, (P) => {
    const r = rng(hash(F.seed, 333));
    const c = mix(tok('cream'), F.sky.horizon, 0.35);
    for (let band = 0; band < 3; band++) {
      const y = LAND.riverTop - 6 + band * 4.5;
      const pts: [number, number][] = [];
      const x0 = F.camX - 20;
      const x1 = F.camX + F.W + 20;
      for (let x = x0; x <= x1; x += 4) pts.push([x, y - 2.5 - Math.sin(x * 0.03 + band + t * 0.02) * 1.6 - range(r, 0, 0.8)]);
      for (let x = x1; x >= x0; x -= 4) pts.push([x, y + 3 + Math.sin(x * 0.021 + band * 2) * 1.4]);
      P.piece(pts, c, { shadow: 0, alpha: fog * (0.42 - band * 0.08), wobble: 2 });
    }
  });
}

export function drawBankLayer(F: Frame, onBank?: (P: Paper) => void, creeks: [number, number][] = []): void {
  layer(F, { gap: 0, haze: HAZE.nearWater, lightGain: 0.6 }, (P) => drawNearWater({ P, W: F.W + F.camX + 20, seed: F.seed, season: F.season }));
  layer(F, { gap: 1.4, haze: HAZE.bank }, (P) => {
    drawBank({ P, W: F.W + F.camX + 20, seed: F.seed, season: F.season, creeks });
    if (onBank) onBank(P);
  });
}

export function drawReedsLayer(F: Frame): void {
  layer(F, { gap: 1.6, haze: 0, shadowGain: 1.2 }, (P) => drawReeds({ P, W: F.W + F.camX + 20, seed: F.seed, season: F.season }));
}

export { PAL };
export type { RGB };
