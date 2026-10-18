/**
 * Static planes: everything that only changes with the light, the season or the World, rendered
 * once per sky key into transparent canvases and reused every frame.
 *
 * Strip (no parallax): sky, clouds (a wrapping band), the far terrain, the village (bank,
 * trees, structures, decorations, lit windows) and the foreground reeds.
 * Ambient (parallax): sky (fixed to the screen), clouds, two mountain ranges, far hills, mid
 * hills, far bank and river, the village, reeds, and a near-shore foreground band added for the
 * closer framing; each layer is a band canvas only as tall as its content.
 *
 * Building is a list of jobs so a live view can spread a rebuild over several ticks.
 */
import { tok, mix, css } from '../../../art/src/color.ts';
import { blob, ellipse, type Pt } from '../../../art/src/paper.ts';
import { rng, range, hash, fbm1 } from '../../../art/src/rng.ts';
import type { SkySample } from '../../../art/src/sky.ts';
import { shadowFor, type ShadowParams } from '../../../art/src/shadow.ts';
import type { Season } from '../../../art/src/terrain.ts';
import { LAND, drawFarBank, drawFarHills, drawMidHills, drawRiver, drawNearWater, drawBank, drawReeds, ridge } from '../../../art/src/terrain.ts';

function ridgeY(x: number, y: number, amp: number, freq: number, seed: number): number {
  return y + fbm1(seed, x * freq, 3) * amp;
}
import { drawSky, drawSunMoonStars, drawFog, HAZE, type View } from '../../../art/src/compose.ts';
import { drawFrame, type Atlas } from '../../../art/src/atlas.ts';
import { SIZES } from '../../../art/src/tokens.ts';
import { rainbow } from '../../../art/src/props.ts';
import type { StructureId } from '../../../../contracts/ts/src/types.ts';
import type { Layout } from '../layout.ts';
import { CANON_W } from '../layout.ts';
import { mapX, type ViewXf } from '../viewxf.ts';
import { makeBand, frameFor, litLayer, emissiveOn, ctx2d, canvas, type Band, type Light, type AnyCanvas } from './compose.ts';
import { drawRange } from './ranges.ts';
import type { CanonicalArtVariant } from '../api.ts';
import { getVariantParams } from './variants.ts';
import { drawWindmill, drawLighthouse, drawWatchtower } from './landmarks.ts';
import { drawDecorativeLanterns } from './reflections.ts';

export interface PlaneInput {
  xf: ViewXf;
  atlas: Atlas;
  layout: Layout;
  sky: SkySample;
  season: Season;
  dark: Set<StructureId>;
  seed: number;
  variant?: CanonicalArtVariant;
}

export interface ParallaxBand {
  band: Band;
  /** parallax factor: 1 moves with the village, 0 is fixed to the screen */
  p: number;
}

export interface Planes {
  kind: 'strip' | 'ambient';
  sky: Band;
  clouds: Band | null;
  /** wrap period of the cloud band in units */
  cloudPeriod: number;
  cloudP: number;
  /** behind the bloom */
  back: ParallaxBand[];
  /** the village plane (and anything in front of the bloom at parallax 1) */
  village: ParallaxBand;
  /** drawn after the residents */
  front: ParallaxBand[];
  /** ambient only: warm diorama vignette, screen-sized, drawn with multiply */
  vignette: AnyCanvas | null;
  light: Light;
  /** sky horizon in units (ambient), for the bloom */
  horizon: number;
  /** fake y1 for kit frames, so the kit's horizonY() returns `horizon` */
  fakeY1: number;
  variant: CanonicalArtVariant;
}

export type Job = () => void;

const GROUND = SIZES.structureBaseY;

function kitView(xf: ViewXf): View {
  return { kind: xf.surface, width: xf.width, height: xf.height, dpr: xf.res };
}

/** Ambient composition constants, in units relative to the view (tuned by eye on captures). */
export function ambientGeometry(xf: ViewXf) {
  const y0 = xf.y0;
  const horizon = LAND.farHillsY + 2;
  return {
    horizon,
    farPeak: LAND.farHillsY - 0.62 * (LAND.farHillsY - y0),
    farBottom: LAND.farHillsY + 4,
    nearPeak: LAND.farHillsY - 0.36 * (LAND.farHillsY - y0),
    nearBottom: LAND.farHillsY + 8,
  };
}

/** The pan range of the ambient camera in canonical units. */
export function panRange(xf: ViewXf): number {
  return Math.max(0, CANON_W - xf.W);
}

export function buildPlanes(inp: PlaneInput, out: { planes: Planes | null }): Job[] {
  return inp.xf.surface === 'strip' ? stripJobs(inp, out) : ambientJobs(inp, out);
}

function starsOnly(sky: SkySample): SkySample {
  return { ...sky, sun: { ...sky.sun, alpha: 0 }, moon: { ...sky.moon, alpha: 0 } };
}

// ---------------------------------------------------------------------------------- strip

function stripJobs(inp: PlaneInput, out: { planes: Planes | null }): Job[] {
  const { xf, sky, season, seed } = inp;
  const variant = inp.variant ?? xf.variant ?? 'default';
  const params = getVariantParams(variant);
  const k = xf.s * xf.res;
  const W = xf.W;
  const shadow = shadowFor(sky);
  const light: Light = { sky, shadow };
  const view = kitView(xf);
  const skyB = makeBand(k, 0, 0, W, SIZES.stripHeight);
  const cloudPeriod = W + 160;
  const cloudsB = sky.spec.cloudCover >= 0.05 ? makeBand(k, 0, 0, cloudPeriod, 44) : null;
  const backB = makeBand(k, 0, 0, W, SIZES.stripHeight);
  const villageB = makeBand(k, 0, 0, W, SIZES.stripHeight);
  const reedsB = makeBand(k, 0, SIZES.stripHeight - 26, W, 26);
  const X = (x: number) => mapX(xf, x);
  const jobs: Job[] = [
    () => {
      const F = frameFor(skyB, view, sky, shadow, season, seed);
      drawSky(F);
      // stars only: the sun and moon are drawn per frame at the current phase (no ghosting in crossfades)
      drawSunMoonStars({ ...F, sky: starsOnly(sky) });
      if (sky.spec.rainbow > 0) rainbowOn(skyB, light, seed, W * 0.64, LAND.riverTop + 4, 70, sky.spec.rainbow);
    },
    () => {
      if (cloudsB) cloudBand(cloudsB, light, seed, true, cloudPeriod, 6, 36);
    },
    () => {
      const L = (P: Parameters<Parameters<typeof litLayer>[4]>[0]) => ({ P, W: W + 20, seed, season });
      const sg = params.shadowScale;
      litLayer(backB, light, seed, { gap: 1.2 * sg, haze: HAZE.farHills, shadowGain: params.extraPaperLayers ? 1.3 : 1 }, (P) => {
        drawFarHills(L(P));
        if (params.landmarks) {
          const wX = W * 0.74;
          const wY = ridgeY(wX, LAND.farHillsY, 10, 0.0048, hash(seed, 21));
          drawWindmill(P, wX, wY + 0.5, 0.68, 0.35);
        }
      });
      if (params.extraPaperLayers) {
        litLayer(backB, light, seed + 10, { gap: 1.1 * sg, haze: 0.16, shadowGain: 1.2 }, (P) => {
          P.piece(ridge(-10, W + 30, (LAND.farHillsY + LAND.midHillsY) / 2, 7.5, 0.006, hash(seed, 81), LAND.riverBottom, 3), mix(tok('farHills'), tok('midHills'), 0.5), { rim: 1.2, shadow: 0.8 });
        });
      }
      litLayer(backB, light, seed, { gap: 1.0 * sg, haze: HAZE.midHills, shadowGain: params.extraPaperLayers ? 1.2 : 1 }, (P) => {
        drawMidHills(L(P));
        if (params.landmarks) {
          const tX = W * 0.22;
          const tY = ridgeY(tX, LAND.midHillsY, 6.5, 0.0085, hash(seed, 31));
          drawWatchtower(P, tX, tY + 0.5, 0.55);
        }
      });
      litLayer(backB, light, seed, { gap: 0.4 * sg, haze: HAZE.river, shadowGain: 0.5, lightGain: 0.6 }, (P) => drawRiver(L(P)));
    },
    () => {
      const bl = params.backlightBoost > 1 ? (params.backlightBoost - 1) * 1.1 : 0;
      villageInto(villageB, inp, light, X, W, SIZES.stripHeight, bl);
    },
    () => {
      const reedGap = params.deepForeground ? 2.5 : 1.6;
      const reedShadow = params.deepForeground ? 1.6 : 1.2;
      litLayer(reedsB, light, seed, { gap: reedGap, haze: 0, shadowGain: reedShadow }, (P) => {
        drawReeds({ P, W: W + 20, seed, season });
        if (params.deepForeground) {
          const lip = ridge(-10, W + 30, SIZES.stripHeight - 3.5, 1.4, 0.035, seed + 88, SIZES.stripHeight + 6, 2.5);
          P.piece(lip, mix(tok('conifer'), tok('ink'), 0.88), { rim: 1.3, shadow: 1.0 });
        }
      });
    },
    () => {
      out.planes = {
        kind: 'strip',
        sky: skyB,
        clouds: cloudsB,
        cloudPeriod,
        cloudP: 1,
        back: [{ band: backB, p: 1 }],
        village: { band: villageB, p: 1 },
        front: [{ band: reedsB, p: 1 }],
        vignette: null,
        light,
        horizon: LAND.riverTop + 2,
        fakeY1: SIZES.stripHeight,
        variant,
      };
    },
  ];
  return jobs;
}

/** Fog, near water, bank (with contact shadows and creeks), trees, structures, decorations, lit windows. */
function villageInto(b: Band, inp: PlaneInput, light: Light, X: (x: number) => number, W: number, H: number, backlight: number): void {
  const { atlas, layout, sky, season, seed, dark, xf } = inp;
  const variant = inp.variant ?? xf.variant ?? 'default';
  const params = getVariantParams(variant);
  const shadow = light.shadow;
  const F = frameFor(b, kitView(xf), sky, shadow, season, seed);
  drawFog(F, 0);
  const creeks: [number, number][] = [];
  for (const s of layout.structures) if (s.def.creek && s.stage >= 1) creeks.push([X(s.x) + s.def.creek.x0, X(s.x) + s.def.creek.x1]);
  const W2 = b.x0 + b.w + 20;
  const shade = xf.surface === 'ambient' ? { color: mix(tok('riverDeep'), tok('ink'), 0.45), top: 0, bottom: 0.8 } : undefined;
  litLayer(b, light, seed, { gap: 0, haze: HAZE.nearWater, lightGain: 0.6, shade }, (P) => drawNearWater({ P, W: W2, seed, season }, H as typeof SIZES.stripHeight));
  litLayer(b, light, seed, { gap: 1.4, haze: HAZE.bank, backlight: backlight * 0.8, rim: backlight * 0.5 }, (P) => {
    drawBank({ P, W: W2, seed, season, creeks }, SIZES.stripHeight);
    for (const s of layout.structures) if (!s.def.creek) contact(P, shadow, X(s.x), s.def.w * (s.stage === 1 ? 0.8 : 0.95));
    for (const t of layout.trees) contact(P, shadow, X(t.x), 14, 0.7);
  });
  // edge groves on strips wider than the authored map (as the kit's scene does)
  const edge: { x: number; id: string }[] = [];
  const margin = xf.surface === 'strip' ? (W - CANON_W) / 2 : 0;
  if (margin > 30) {
    const er = rng(hash(seed, 909));
    const ids = ['tree/broad/0', 'tree/conifer/0', 'tree/broad/1', 'bush/1', 'tree/conifer/1', 'bush/0', 'tree/broad/2', 'bush/2'];
    for (const side of [-1, 1]) {
      let d = range(er, 14, 30);
      while (d < margin - 8) {
        edge.push({ x: side < 0 ? -d : CANON_W + d, id: ids[Math.floor(er() * ids.length)] });
        d += range(er, 22, 60);
      }
    }
  }
  const rim = backlight * 0.9;
  litLayer(b, light, seed, { gap: 2.0, haze: 0.03, backlight: backlight * 0.7, rim }, (P) => {
    for (const t of [...layout.trees.filter((t) => t.behind), ...edge]) drawFrame(P.ctx, atlas, t.id, X(t.x), GROUND - 1.5);
  });
  litLayer(b, light, seed, { gap: 2.2, haze: 0, backlight, rim }, (P) => {
    for (const s of layout.structures) drawFrame(P.ctx, atlas, s.sprite, X(s.x), GROUND);
    for (const t of layout.trees.filter((t) => !t.behind)) drawFrame(P.ctx, atlas, t.id, X(t.x), GROUND + 0.5);
  });
  if (layout.decorations.length) {
    litLayer(b, light, seed, { gap: 0.9, haze: 0, backlight, rim }, (P) => {
      for (const d of layout.decorations) drawFrame(P.ctx, atlas, d.id, X(d.x), SIZES.groundY + 0.5);
    });
  }
  if (params.lanternLight) {
    litLayer(b, light, seed, { gap: 1.1, haze: 0, backlight, rim }, (P) => {
      drawDecorativeLanterns(P, layout, X, SIZES.groundY + 0.5, Math.max(sky.lamps, sky.daylight < 0.6 ? 0.45 : 0));
    });
  }
  if (sky.lamps > 0.02) {
    // lanterns light one by one: each structure has its own seeded threshold on the evening's lamp level
    emissiveOn(b, seed, (P) => {
      for (const s of layout.structures) {
        if (s.kind === 'campfire' || dark.has(s.id)) continue;
        const off = (hash(seed, s.x | 0, 31) % 1000) / 1000 * 0.45;
        const a = Math.max(0, Math.min(1, (sky.lamps - off) / 0.4));
        if (a > 0.01) {
          drawFrame(P.ctx, atlas, `st/${s.kind}/${s.stage}/lit`, X(s.x), GROUND, { alpha: a });
          if (params.lanternLight) {
            const glowA = a * 0.38;
            const g = P.ctx;
            const cx = X(s.x);
            const cy = GROUND - s.def.h * 0.38;
            const rad = g.createRadialGradient(cx, cy, 2, cx, cy, s.def.w * 0.9);
            rad.addColorStop(0, css(tok('lampGlow'), glowA));
            rad.addColorStop(1, css(tok('lampGlow'), 0));
            g.fillStyle = rad;
            g.beginPath();
            g.arc(cx, cy, s.def.w * 0.9, 0, Math.PI * 2);
            g.fill();
          }
        }
      }
    });
  }
}

function contact(P: Parameters<Parameters<typeof litLayer>[4]>[0], sp: ShadowParams, x: number, w: number, alpha = 1): void {
  const a = Math.min(0.5, sp.alpha * 2.2) * alpha;
  if (a < 0.01) return;
  const stretch = 1 + sp.length * 0.25;
  P.piece(ellipse(x + sp.side * w * 0.22 * sp.length * 0.4, SIZES.groundY - 0.4, (w / 2) * stretch, 1.6 + w * 0.025, 24), 'ink', { shadow: 0, wobble: 0, alpha: a });
}

/** Paper clouds in a band that wraps horizontally with the given period (the kit's cloud shapes). */
function cloudBand(b: Band, light: Light, seed: number, strip: boolean, period: number, yTop: number, yBot: number): void {
  const sky = light.sky;
  const cover = sky.spec.cloudCover;
  const grey = mix(tok('cream'), tok('worrySlate'), Math.max(0, sky.spec.skyMix - 0.2) * 0.75);
  litLayer(b, light, seed, { gap: 1.4, haze: 0.18, shadowGain: 0.8 }, (P) => {
    const r = rng(hash(seed, 77));
    const n = Math.round((period / (strip ? 260 : 170)) * (0.5 + cover * 2.6));
    for (let i = 0; i < n; i++) {
      const w = range(r, strip ? 34 : 70, strip ? 80 : 200) * (0.75 + cover * 0.5);
      const x0 = range(r, 0, period);
      const y = range(r, yTop, yBot);
      const hgt = w * range(r, 0.2, 0.3);
      const cs = hash(seed, 78, i);
      const under = mix(grey, tok('skyDuskTop'), 0.22);
      const topc = mix(grey, tok('lampGlow'), 0.18);
      for (const x of [x0 - period, x0, x0 + period]) {
        if (x + w < b.x0 - 4 || x - w > b.x0 + b.w + 4) continue;
        P.piece(blob(x, y, w / 2, hgt / 2, cs, 6, 0.42, true), under, { rim: 1, shadow: 0.6 });
        P.piece(blob(x - w * 0.08, y - hgt * 0.22, w * 0.36, hgt * 0.36, cs + 1, 5, 0.4, true), mix(grey, tok('stoneLight'), 0.3), { rim: 1, shadow: 0.7 });
        P.piece(blob(x - w * 0.14, y - hgt * 0.36, w * 0.22, hgt * 0.26, cs + 2, 5, 0.4, true), topc, { rim: 1, shadow: 0.7 });
      }
    }
    P.grain(b.x0, b.y0, b.w, b.h);
  });
}

function rainbowOn(b: Band, light: Light, seed: number, cx: number, cy: number, R: number, alpha: number): void {
  litLayer(b, light, seed, { gap: 0.6, haze: 0.2, shadowGain: 0.3 }, (P) => P.at(cx, cy, 0, () => rainbow(P, R, 0.75 * alpha)));
}

// ---------------------------------------------------------------------------------- ambient

function ambientJobs(inp: PlaneInput, out: { planes: Planes | null }): Job[] {
  const { xf, sky, season, seed } = inp;
  const variant = inp.variant ?? xf.variant ?? 'default';
  const params = getVariantParams(variant);
  const k = xf.s * xf.res;
  const Wv = xf.W;
  const R = panRange(xf);
  const shadow = shadowFor(sky);
  const light: Light = { sky, shadow };
  const view = kitView(xf);
  const geo = ambientGeometry(xf);
  const y0 = xf.y0;
  const y1 = xf.y1;
  // the kit's horizonY() is y0 + 0.6 (y1 - y0); a fake y1 puts the sky's horizon where this framing wants it
  const fakeY1 = y0 + (geo.horizon - y0) / SIZES.ambientSkyFraction;
  const wFor = (p: number) => Wv + R * p + 60;
  const sunSide = sky.sun.alpha > 0.1 ? (sky.sun.x < 0.5 ? -1 : 1) : -1;

  // hazy, distant and smooth layers are rendered at half the plane resolution and upscaled when drawn:
  // a quarter of the memory, and no visible loss behind the atmospheric haze
  const kf = k * 0.5;
  const skyB = makeBand(kf, 0, y0, Wv, y1 - y0);
  const cloudP = 0.12;
  const cloudPeriod = wFor(cloudP) + 260;
  const cloudsB = sky.spec.cloudCover >= 0.05 ? makeBand(kf, 0, y0, cloudPeriod, geo.farPeak - y0 + 10) : null;
  const mtFar = { band: makeBand(kf, -30, geo.farPeak - 12, wFor(0.2), geo.farBottom - geo.farPeak + 22), p: 0.2 };
  const mtNear = { band: makeBand(kf, -30, geo.nearPeak - 12, wFor(0.3), geo.nearBottom - geo.nearPeak + 22), p: 0.3 };
  const mtFoothills = params.extraPaperLayers
    ? { band: makeBand(kf, -30, (geo.nearPeak + LAND.farHillsY) / 2 - 14, wFor(0.36), LAND.riverBottom - (geo.nearPeak + LAND.farHillsY) / 2 + 20), p: 0.36 }
    : null;
  const farTopPad = params.landmarks ? 38 : 16;
  const midTopPad = params.landmarks ? 34 : 16;
  const farHills = { band: makeBand(kf, -30, LAND.farHillsY - farTopPad, wFor(0.45), LAND.riverBottom - LAND.farHillsY + farTopPad + 6), p: 0.45 };
  const midHills = { band: makeBand(k, -30, LAND.midHillsY - midTopPad, wFor(0.6), LAND.riverBottom - LAND.midHillsY + midTopPad + 6), p: 0.6 };
  const river = { band: makeBand(k, -30, LAND.riverTop - 16, wFor(0.78), LAND.riverBottom - LAND.riverTop + 24), p: 0.78 };
  const villageTop = 0;
  const village = { band: makeBand(k, -40, villageTop, CANON_W + 80, y1 - villageTop + 2), p: 1 };
  const reeds = { band: makeBand(k, -40, SIZES.stripHeight - 26, CANON_W + 80, 30), p: 1 };
  const foreTop = y1 - 12;
  const fore = { band: makeBand(k, -40, foreTop - 84, wFor(1.3) + 80, y1 - foreTop + 88), p: 1.3 };
  const foreNear = params.deepForeground
    ? { band: makeBand(k, -40, foreTop - 36, wFor(1.48) + 80, y1 - foreTop + 40), p: 1.48 }
    : null;
  const low = sky.sun.alpha > 0.05 ? 1 : 0;
  const sg = params.shadowScale;
  const bl = low * (params.backlightBoost > 1 ? params.backlightBoost : 1);

  const L = (P: Parameters<Parameters<typeof litLayer>[4]>[0], W: number) => ({ P, W, seed, season, sunSide });
  const jobs: Job[] = [
    () => {
      const F = frameFor(skyB, view, sky, shadow, season, seed, fakeY1);
      drawSky(F);
      drawSunMoonStars({ ...F, sky: starsOnly(sky) });
      if (sky.spec.rainbow > 0) rainbowOn(skyB, light, seed, Wv * 0.62, LAND.riverTop, 220, sky.spec.rainbow);
    },
    () => {
      if (cloudsB) cloudBand(cloudsB, light, seed, false, cloudPeriod, y0 + 18, geo.farPeak - 14);
    },
    () => litLayer(mtFar.band, light, seed, { gap: 1.6 * sg, haze: 0.5, shadowGain: params.extraPaperLayers ? 1.25 : undefined }, (P) => drawRange(P, mtFar.band.x0, mtFar.band.x0 + mtFar.band.w, geo.farPeak, geo.farBottom, seed + 1, 'mountain', sunSide, params.snowyPeaks ? 0.38 : 0.6)),
    () => litLayer(mtNear.band, light, seed, { gap: 1.6 * sg, haze: 0.28, shadowGain: params.extraPaperLayers ? 1.25 : undefined }, (P) => drawRange(P, mtNear.band.x0, mtNear.band.x0 + mtNear.band.w, geo.nearPeak, geo.nearBottom, seed + 2, mix(tok('mountain'), tok('midHills'), 0.35), sunSide, params.snowyPeaks ? 0.48 : 0.74)),
    ...(mtFoothills
      ? [
          () =>
            litLayer(mtFoothills.band, light, seed + 9, { gap: 1.3 * sg, haze: 0.22, shadowGain: 1.2 }, (P) =>
              drawRange(P, mtFoothills.band.x0, mtFoothills.band.x0 + mtFoothills.band.w, (geo.nearPeak + LAND.farHillsY) / 2, LAND.riverBottom, seed + 9, mix(tok('mountain'), tok('farHills'), 0.5), sunSide, 0.7),
            ),
        ]
      : []),
    () => litLayer(farHills.band, light, seed, { gap: 1.2 * sg, haze: HAZE.farHills, shadowGain: params.extraPaperLayers ? 1.3 : undefined }, (P) => {
      drawFarHills(L(P, farHills.band.w));
      if (params.landmarks) {
        const lhX = 392;
        const lhY = ridgeY(lhX, LAND.farHillsY, 10, 0.0048, hash(seed, 21));
        drawLighthouse(P, lhX, lhY + 0.5, 1.2, sky.lamps > 0.05);
        const wmX = 66;
        const wmY = ridgeY(wmX, LAND.farHillsY, 10, 0.0048, hash(seed, 21));
        drawWindmill(P, wmX, wmY + 0.5, 1.05, 0.38);
      }
    }),
    () => litLayer(midHills.band, light, seed, { gap: 1.0 * sg, haze: HAZE.midHills, shadowGain: params.extraPaperLayers ? 1.2 : undefined }, (P) => {
      drawMidHills(L(P, midHills.band.w));
      if (params.landmarks) {
        const wtX = 188;
        const wtY = ridgeY(wtX, LAND.midHillsY, 6.5, 0.0085, hash(seed, 31));
        drawWatchtower(P, wtX, wtY + 0.5, 0.85);
      }
    }),
    () => {
      litLayer(river.band, light, seed, { gap: 0.8 * sg, haze: 0.12 }, (P) => drawFarBank(L(P, river.band.w), LAND.riverTop - 1.5, LAND.riverTop + 3));
      litLayer(river.band, light, seed, { gap: 0.4 * sg, haze: HAZE.river, shadowGain: 0.5, lightGain: 0.6 }, (P) => drawRiver(L(P, river.band.w)));
    },
    () => villageInto(village.band, inp, light, (x) => x, CANON_W + 40, y1 + 2, bl),
    () => litLayer(reeds.band, light, seed, { gap: 1.6 * sg, haze: 0, shadowGain: params.extraPaperLayers ? 1.4 : 1.2, backlight: bl * 1.3, rim: bl * 0.6, lightGain: 0.8 }, (P) => drawReeds({ P, W: CANON_W + 40, seed, season })),
    () => litLayer(fore.band, light, seed + 5, { gap: 2.6 * sg, haze: 0, shadowGain: params.deepForeground ? 1.6 : 1.3, backlight: bl * 1.4, rim: bl * 0.6, lightGain: 0.55 }, (P) => drawForeground(P, fore.band, foreTop, season, seed)),
    ...(foreNear
      ? [
          () =>
            litLayer(foreNear.band, light, seed + 15, { gap: 3.2, haze: 0, shadowGain: 1.8, backlight: bl * 1.6, rim: bl * 0.75, lightGain: 0.35 }, (P) =>
              drawForegroundSilhouette(P, foreNear.band, foreTop + 6, seed + 15),
            ),
        ]
      : []),
    () => {
      out.planes = {
        kind: 'ambient',
        sky: skyB,
        clouds: cloudsB,
        cloudPeriod,
        cloudP,
        back: mtFoothills ? [mtFar, mtNear, mtFoothills, farHills, midHills, river] : [mtFar, mtNear, farHills, midHills, river],
        village,
        front: foreNear ? [reeds, fore, foreNear] : [reeds, fore],
        vignette: vignette(xf, sky, variant),
        light,
        horizon: geo.horizon,
        fakeY1,
        variant,
      };
    },
  ];
  return jobs;
}

/** The near shore we look across: tall, dark grass and reeds rising from a thin turf cut off by the frame. */
function drawForeground(P: Parameters<Parameters<typeof litLayer>[4]>[0], b: Band, top: number, season: Season, seed: number): void {
  const W = b.x0 + b.w + 20;
  const bottom = b.y0 + b.h + 4;
  const s = hash(seed, 6101);
  const r = rng(hash(seed, 6102));
  const winter = season === 'winter';
  // near silhouette: deep warm darks, only a whisper of green
  const turf = mix(mix(tok('conifer'), tok('ink'), 0.78), tok('soilDeep'), 0.15);
  const cols = winter
    ? [mix(tok('reedTip'), tok('ink'), 0.72), mix(tok('reed'), tok('ink'), 0.78), mix(tok('stoneDark'), tok('ink'), 0.72)]
    : [mix(tok('reed'), tok('ink'), 0.7), mix(tok('conifer'), tok('ink'), 0.66), mix(tok('reed'), tok('ink'), 0.8), mix(tok('soilDeep'), tok('ink'), 0.6)];
  const blade = (x: number, base: number, h: number, w: number, lean: number, c: ReturnType<typeof tok>) => {
    const tip: Pt = [x + lean * h, base - h];
    const mid: Pt = [x + lean * h * 0.42, base - h * 0.55];
    P.piece([[x - w / 2, base], [mid[0] - w * 0.3, mid[1]], tip, [mid[0] + w * 0.26, mid[1]], [x + w / 2, base]], c, { shadow: 0.6, wobble: 0.3, rim: 0 });
  };
  P.piece(ridge(b.x0 - 10, W, top, 2.6, 0.016, s, bottom, 4), turf, { rim: 0, shadow: 1 });
  let x = b.x0 + range(r, 0, 20);
  while (x < W) {
    const giant = r() < 0.12;
    const n = Math.floor(range(r, giant ? 18 : 9, giant ? 28 : 17));
    const tall = giant || r() < 0.6;
    const base = top + 3 + range(r, 0, 4);
    for (let i = 0; i < n; i++) {
      const xx = x + range(r, -9, 9);
      // never taller than the gap to the village ground line, so no clump hides a resident
      const h = Math.min(range(r, 10, giant ? 80 : tall ? 50 : 26), base - (SIZES.groundY + 6));
      blade(xx + (giant ? range(r, -6, 6) : 0), base + range(r, 0, 3), h, range(r, 1.8, giant ? 4.2 : 3.2), range(r, -0.3, 0.3), cols[Math.floor(r() * cols.length)]);
      if (tall && r() < 0.18) {
        const lean = range(r, -0.1, 0.1);
        const hh = h + range(r, 6, 12);
        P.line([[xx, base], [xx + lean * hh, base - hh]], 0.8, cols[2], { shadow: 0.4 });
        P.piece(ellipse(xx + lean * hh * 0.92, base - hh * 0.9, 1.8, 4.8, 12), mix(tok('reedTip'), tok('ink'), 0.35), { shadow: 0.6, rim: 0 });
      }
    }
    if (!winter && r() < 0.35) {
      const fx = x + range(r, 14, 34);
      const fy = top - range(r, 8, 18);
      P.line([[fx, top + 4], [fx + 1, fy]], 0.7, cols[2], { shadow: 0.4 });
      for (let j = 0; j < 4; j++) P.piece(ellipse(fx + 1 + range(r, -2.2, 2.2), fy + range(r, -2, 1), 1.4, 1.4, 8), mix(tok(r() < 0.5 ? 'leafAmber' : 'leafRust'), tok('ink'), 0.15), { shadow: 0.5, rim: 0 });
    }
    x += range(r, 14, 44);
  }
  P.grain(b.x0, b.y0, b.w, b.h, 0.06);
}

/**
 * Extra front silhouette layer for Variant A (Deeper Papercut).
 * Tall, bold papercut reeds, cattails and dark grass cuts rising from the bottom frame edge
 * with crisp rim light catching the sun.
 */
function drawForegroundSilhouette(P: Parameters<Parameters<typeof litLayer>[4]>[0], b: Band, top: number, seed: number): void {
  const W = b.x0 + b.w + 20;
  const bottom = b.y0 + b.h + 4;
  const s = hash(seed, 9101);
  const r = rng(hash(seed, 9102));
  const turf = mix(tok('conifer'), tok('ink'), 0.88);
  const cols = [
    mix(tok('ink'), tok('conifer'), 0.12),
    mix(tok('ink'), tok('soilDeep'), 0.18),
    mix(tok('ink'), tok('reed'), 0.15),
  ];
  P.piece(ridge(b.x0 - 10, W, top, 2.8, 0.018, s, bottom, 4), turf, { rim: 1.2, shadow: 1.2 });
  let x = b.x0 + range(r, 0, 16);
  while (x < W) {
    const n = Math.floor(range(r, 8, 16));
    const base = top + 2 + range(r, 0, 3);
    for (let i = 0; i < n; i++) {
      const xx = x + range(r, -8, 8);
      const h = range(r, 16, 48);
      const lean = range(r, -0.22, 0.22);
      const tip: Pt = [xx + lean * h, base - h];
      const mid: Pt = [xx + lean * h * 0.42, base - h * 0.5];
      const w = range(r, 2.2, 4.4);
      P.piece([[xx - w / 2, base], [mid[0] - w * 0.3, mid[1]], tip, [mid[0] + w * 0.3, mid[1]], [xx + w / 2, base]], cols[i % cols.length], { shadow: 0.8, wobble: 0.25, rim: 1.1 });
      if (r() < 0.25) {
        const hh = h + range(r, 6, 12);
        P.line([[xx, base], [xx + lean * hh, base - hh]], 0.9, cols[0], { shadow: 0.5 });
        P.piece(ellipse(xx + lean * hh * 0.92, base - hh * 0.9, 2.2, 5.8, 12), tok('ink'), { shadow: 0.8, rim: 1.2 });
      }
    }
    x += range(r, 18, 38);
  }
}

/** Warm diorama vignette (clear centre, warm-dark edges), as the kit's ambient goldens. Drawn with multiply. */
function vignette(xf: ViewXf, sky: SkySample, variant: CanonicalArtVariant = 'default'): AnyCanvas {
  const w = Math.round(xf.width * xf.res * 0.5);
  const h = Math.round(xf.height * xf.res * 0.5);
  const c = canvas(w, h);
  const g = ctx2d(c);
  const params = getVariantParams(variant);
  const edge = params.vignetteWarmth
    ? mix(mix(tok('ink'), sky.light, 0.45), tok('flame'), 0.22 * Math.max(sky.daylight, 0.35))
    : mix(mix(tok('ink'), sky.light, 0.55), tok('flame'), 0.12 * sky.daylight);
  const rad = g.createRadialGradient(w * 0.5, h * 0.55, Math.min(w, h) * 0.32, w * 0.5, h * 0.55, Math.max(w, h) * 0.78);
  rad.addColorStop(0, css(tok('maskWhite'), 0));
  rad.addColorStop(1, css(edge, params.vignetteWarmth ? 0.48 : 0.42));
  g.fillStyle = rad;
  g.fillRect(0, 0, w, h);
  return c;
}
