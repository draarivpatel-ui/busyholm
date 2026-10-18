/**
 * Holm biome layers (SPEC 3.1, 4.1): full-width paper bands drawn per view width.
 * Back to front: mountains (ambient only), far hills, mid hills, river, holm bank, foreground reeds.
 * All y values are strip units (see tokens.ts SIZES); ambient views extend upward into negative y.
 */
import { SIZES } from './tokens.ts';
import { Paper, type Pt, type Fill, blob, ellipse, rect } from './paper.ts';
import { fbm1, rng, range, hash } from './rng.ts';
import { tok, mix, type RGB } from './color.ts';

export type Season = 'autumn' | 'winter';

/** Layer y anchors in strip units. */
export const LAND = {
  farHillsY: 50,
  midHillsY: 61,
  riverTop: 69,
  riverBottom: 80,
  bankTop: 78.5,
  bankFaceTop: 91.5,
  waterTop: 101,
} as const;

/** Polygon for a rolling ridge from x0 to x1 with its top around `y` and its bottom at `bottom`. */
export function ridge(x0: number, x1: number, y: number, amp: number, freq: number, seed: number, bottom: number, step = 3): Pt[] {
  const pts: Pt[] = [[x0, bottom]];
  for (let x = x0; x <= x1 + step; x += step) {
    const xx = Math.min(x, x1);
    pts.push([xx, y + fbm1(seed, xx * freq, 3) * amp]);
  }
  pts.push([x1, bottom]);
  return pts;
}

function ridgeY(x: number, y: number, amp: number, freq: number, seed: number): number {
  return y + fbm1(seed, x * freq, 3) * amp;
}

// ---------------------------------------------------------------- small trees for the hill layers

export function smallConifer(P: Paper, x: number, base: number, h: number, fill: Fill, snow = false): void {
  const w = h * 0.42;
  const tiers = 3;
  for (let i = 0; i < tiers; i++) {
    const t0 = base - h * (0.18 + i * 0.27);
    const tw = w * (1 - i * 0.24);
    P.piece(
      [
        [x - tw, t0 + h * 0.08],
        [x, t0 - h * 0.42],
        [x + tw, t0 + h * 0.08],
      ],
      fill,
      { shadow: 0.6 },
    );
    if (snow)
      P.piece(
        [
          [x - tw * 0.45, t0 - h * 0.2],
          [x, t0 - h * 0.42],
          [x + tw * 0.45, t0 - h * 0.2],
          [x, t0 - h * 0.27],
        ],
        'snow',
        { shadow: 0.3, wobble: 0.5 },
      );
  }
}

export function smallRoundTree(P: Paper, x: number, base: number, h: number, fill: Fill, seed: number, trunk: Fill = 'woodDark'): void {
  P.piece(rect(x - h * 0.06, base - h * 0.45, h * 0.12, h * 0.45), trunk, { shadow: 0.4, wobble: 0.3 });
  P.piece(blob(x, base - h * 0.62, h * 0.36, h * 0.36, seed, 6, 0.22), fill, { shadow: 0.7, rim: 0.6 });
}

// ---------------------------------------------------------------- layers

export interface LayerCtx {
  P: Paper;
  /** view width in units */
  W: number;
  seed: number;
  season: Season;
  /** creek cuts through the holm (x ranges in units): footbridge, mill race */
  creeks?: [number, number][];
  /** which side the light comes from (-1 left, +1 right), for lit faces */
  sunSide?: number;
}

/**
 * Ambient-only mountain range: irregular cut ridgeline (main peaks with shoulders and notches),
 * snow on the high peaks. Call twice (far and near range) with different seeds and heights.
 */
export function drawMountains(L: LayerCtx, peakY: number, bottomY: number, fill: Fill = 'mountain', snowLine = 0.62): void {
  const { P, W, seed } = L;
  const r = rng(hash(seed, 11));
  const H = bottomY - peakY;
  const pts: Pt[] = [[-30, bottomY]];
  const peaks: Pt[] = [];
  let x = -30;
  let y = bottomY - H * 0.35;
  pts.push([x, y]);
  while (x < W + 60) {
    const pw = range(r, 50, 120);
    const ph = range(r, 0.45, 1) * H;
    const px = x + pw * range(r, 0.4, 0.6);
    const py = bottomY - ph;
    // left flank with a shoulder
    pts.push([x + (px - x) * 0.45, y + (py - y) * range(r, 0.35, 0.55) + range(r, -2, 2)]);
    pts.push([x + (px - x) * 0.75, y + (py - y) * range(r, 0.7, 0.85)]);
    pts.push([px, py]);
    peaks.push([px, py]);
    const nx = x + pw;
    const ny = bottomY - H * range(r, 0.18, 0.45);
    pts.push([px + (nx - px) * 0.3, py + (ny - py) * range(r, 0.2, 0.4)]);
    pts.push([px + (nx - px) * 0.65, py + (ny - py) * range(r, 0.55, 0.8) + range(r, -2, 2)]);
    pts.push([nx, ny]);
    x = nx;
    y = ny;
  }
  pts.push([W + 60, bottomY]);
  P.piece(pts, fill, { rim: 1.2, shadow: 0.5, wobble: 1.4 });
  // light face: the sun-facing slope of each peak is a lighter paper sheet
  for (const [px, py] of peaks) {
    const h = bottomY - py;
    const sunSide = L.sunSide ?? -1;
    const base = typeof fill === 'string' ? tok(fill) : fill;
    P.piece(
      [[px, py], [px + sunSide * h * 0.34, py + h * 0.58], [px + sunSide * h * 0.14, py + h * 0.52], [px - sunSide * h * 0.04, py + h * 0.92], [px - sunSide * h * 0.02, py + h * 0.2]],
      mix(mix(base, tok('cream'), 0.35), tok('lampGlow'), 0.3),
      { shadow: 0, wobble: 1, alpha: 0.85 },
    );
    if (h > H * snowLine) {
      const sz = h * 0.2;
      P.piece([[px - sz * 0.75, py + sz * 0.95], [px - sz * 0.25, py + sz * 0.6], [px + sz * 0.05, py + sz * 0.92], [px + sz * 0.4, py + sz * 0.55], [px + sz * 0.7, py + sz * 0.85], [px, py]], 'mountainSnow', { shadow: 0.4, wobble: 0.6 });
    }
  }
  P.grain(-40, peakY - 10, W + 100, bottomY - peakY + 20);
}

/** Ambient-only far bank: a dense band of small conifers and round trees across the river. */
export function drawFarBank(L: LayerCtx, y: number, bottom: number): void {
  const { P, W, seed, season } = L;
  P.piece(ridge(-10, W + 10, y, 2.5, 0.02, hash(seed, 71), bottom, 4), mix(tok('midHills'), tok('bank'), 0.4), { rim: 0.8, shadow: 0.6 });
  const r = rng(hash(seed, 72));
  for (let x = -6; x < W + 10; x += range(r, 2.5, 6)) {
    const base = ridgeY(x, y, 2.5, 0.02, hash(seed, 71)) + 1.5;
    if (r() < 0.65 || season === 'winter') smallConifer(P, x, base, range(r, 7, 13), r() < 0.5 ? 'conifer' : 'coniferLight', season === 'winter');
    else smallRoundTree(P, x, base, range(r, 6, 10), mix(tok(r() < 0.5 ? 'leafAmber' : 'leafRust'), tok('midHills'), 0.25), hash(seed, x | 0));
  }
  P.grain(-10, y - 16, W + 20, bottom - y + 16);
}

/** Far hills: soft, low contrast, a few tiny trees. */
export function drawFarHills(L: LayerCtx, bottom = LAND.riverBottom): void {
  const { P, W, seed, season } = L;
  const y = LAND.farHillsY;
  P.piece(ridge(-10, W + 10, y, 10, 0.0048, hash(seed, 21), bottom, 4), 'farHills', { rim: 1, shadow: 0.5 });
  const r = rng(hash(seed, 22));
  const n = Math.round(W / 70);
  for (let i = 0; i < n; i++) {
    const x = range(r, 0, W);
    const base = ridgeY(x, y, 10, 0.0048, hash(seed, 21)) + 1.2;
    if (r() < 0.6) smallConifer(P, x, base, range(r, 4, 7), mix(tok('farHills'), tok('conifer'), 0.35), season === 'winter');
    else smallRoundTree(P, x, base, range(r, 4, 6), mix(tok('farHills'), tok(season === 'winter' ? 'stoneDark' : 'leafAmber'), 0.3), hash(seed, i, 3));
  }
  if (season === 'winter') snowOnRidge(P, W, y, 10, 0.0048, hash(seed, 21), 1.4);
  P.grain(-10, y - 12, W + 20, bottom - y + 12);
}

/** Mid hills: darker, with clumps of trees. */
export function drawMidHills(L: LayerCtx, bottom = LAND.riverBottom): void {
  const { P, W, seed, season } = L;
  const y = LAND.midHillsY;
  const s = hash(seed, 31);
  P.piece(ridge(-10, W + 10, y, 6.5, 0.0085, s, bottom, 3), 'midHills', { rim: 1, shadow: 0.7 });
  const r = rng(hash(seed, 32));
  let x = range(r, 0, 40);
  while (x < W) {
    const clump = Math.floor(range(r, 1, 5));
    for (let k = 0; k < clump; k++) {
      const xx = x + k * range(r, 3, 6);
      const base = ridgeY(xx, y, 6.5, 0.0085, s) + 1.5;
      const h = range(r, 6, 10);
      if (r() < 0.5 || season === 'winter') smallConifer(P, xx, base, h, 'conifer', season === 'winter');
      else {
        const c = r() < 0.5 ? 'leafAmber' : 'leafRust';
        smallRoundTree(P, xx, base, h, mix(tok(c), tok('midHills'), 0.3), hash(seed, x | 0, k));
      }
    }
    x += range(r, 18, 70);
  }
  if (season === 'winter') snowOnRidge(P, W, y, 6.5, 0.0085, s, 1.6);
  P.grain(-10, y - 14, W + 20, bottom - y + 14);
}

function snowOnRidge(P: Paper, W: number, y: number, amp: number, freq: number, seed: number, depth: number): void {
  const top: Pt[] = [];
  const bot: Pt[] = [];
  for (let x = -10; x <= W + 12; x += 3) {
    const yy = ridgeY(x, y, amp, freq, seed);
    top.push([x, yy - 0.2]);
    bot.push([x, yy + depth * (0.6 + 0.4 * Math.sin(x * 0.37))]);
  }
  P.piece([...top, ...bot.reverse()], 'snow', { shadow: 0.25 });
}

/** River band behind the holm: water with paper light streaks. */
export function drawRiver(L: LayerCtx, top = LAND.riverTop, bottom = LAND.riverBottom + 2): void {
  const { P, W, seed, season } = L;
  P.piece(rect(-10, top, W + 20, bottom - top), 'river', { wobble: 0, shadow: 0 });
  // deeper water toward the near bank
  P.piece(ridge(-10, W + 10, top + (bottom - top) * 0.62, 0.8, 0.05, hash(seed, 41), bottom), 'riverDeep', { shadow: 0, alpha: 0.55 });
  const r = rng(hash(seed, 42));
  const n = Math.round(W / 18);
  for (let i = 0; i < n; i++) {
    const x = range(r, 0, W);
    const yy = range(r, top + 1.5, bottom - 2.5);
    const len = range(r, 4, 16);
    P.line(
      [
        [x, yy],
        [x + len, yy + range(r, -0.2, 0.2)],
      ],
      range(r, 0.45, 0.9),
      'riverLight',
      { shadow: 0, alpha: range(r, 0.55, 0.95) },
    );
  }
  if (season === 'winter') {
    // ice shelves along the far edge
    P.piece(ridge(-10, W + 10, top + 1.2, 0.6, 0.08, hash(seed, 43), top - 0.5), 'snow', { shadow: 0.2, alpha: 0.85 });
  }
  P.grain(-10, top, W + 20, bottom - top, 0.07);
}

/** Near water in front of the holm (its own layer so it can reflect the sky like the river). */
export function drawNearWater(L: LayerCtx, H = SIZES.stripHeight): void {
  const { P, W, seed } = L;
  P.piece(rect(-10, SIZES.structureBaseY - 1, W + 20, H - SIZES.structureBaseY + 14), 'river', { wobble: 0, shadow: 0 });
  P.piece(rect(-10, LAND.waterTop + 4, W + 20, H), 'riverDeep', { wobble: 0, shadow: 0, alpha: 0.35 });
  const r = rng(hash(seed, 52));
  for (let i = 0; i < W / 16; i++) {
    const x = range(r, 0, W);
    const yy = range(r, LAND.waterTop + 1.5, H - 1);
    P.line([[x, yy], [x + range(r, 4, 13), yy]], range(r, 0.45, 0.8), 'riverLight', { shadow: 0, alpha: range(r, 0.5, 0.9) });
  }
  P.grain(-10, SIZES.structureBaseY - 1, W + 20, H - SIZES.structureBaseY + 14, 0.06);
}

/** The holm: meadow where residents walk, a green bank face with a thin earth lip, tufts and stones. */
export function drawBank(L: LayerCtx, H = SIZES.stripHeight): void {
  const { P, W, seed, season } = L;
  const s = hash(seed, 51);
  const r = rng(hash(seed, 52));
  const winter = season === 'winter';
  const faceTop = (x: number) => ridgeY(x, LAND.bankFaceTop, 1.3, 0.02, s + 1);
  const lipY = (x: number) => LAND.waterTop + 0.6 + fbm1(s + 2, x * 0.05) * 1.1;
  // earth lip just above the water line (thin, mostly hidden by grass)
  const lip: Pt[] = [];
  for (let x = -10; x <= W + 12; x += 3) lip.push([x, lipY(x) - 3.2 + fbm1(s + 7, x * 0.08) * 0.9]);
  const lipB: Pt[] = [];
  for (let x = W + 12; x >= -10; x -= 3) lipB.push([x, lipY(x) + 0.8]);
  P.piece([...lip, ...lipB], 'soilDeep', { shadow: 0.8 });
  // the bank face: dark green, falling to the water
  const face: Pt[] = [];
  for (let x = -10; x <= W + 12; x += 3) face.push([x, faceTop(x)]);
  const faceB: Pt[] = [];
  for (let x = W + 12; x >= -10; x -= 3) faceB.push([x, lipY(x) - 2.2 + fbm1(s + 8, x * 0.11) * 0.8]);
  P.piece([...face, ...faceB], winter ? mix(tok('bank'), tok('snow'), 0.55) : 'bank', { shadow: 1, rim: 0.7 });
  // exposed earth and stones in the face
  for (let i = 0; i < W / 55; i++) {
    const x = range(r, 0, W);
    const yy = range(r, faceTop(x) + 3, LAND.waterTop - 2.5);
    P.piece(ellipse(x, yy, range(r, 2.5, 6), range(r, 0.9, 1.6), 14), 'soil', { shadow: 0.5, wobble: 0.8, alpha: 0.85 });
  }
  for (let i = 0; i < W / 45; i++) {
    const x = range(r, 0, W);
    const yy = range(r, faceTop(x) + 2, LAND.waterTop - 1);
    P.piece(ellipse(x, yy, range(r, 0.9, 1.9), range(r, 0.6, 1.1), 10), r() < 0.5 ? 'stone' : 'stoneDark', { shadow: 0.6, rim: 0.5 });
  }
  // meadow surface down to the face
  const top: Pt[] = [];
  for (let x = -10; x <= W + 12; x += 2.5) top.push([x, ridgeY(x, LAND.bankTop, 0.7, 0.04, s + 4)]);
  const meadowB: Pt[] = [];
  for (let x = W + 12; x >= -10; x -= 3) meadowB.push([x, faceTop(x) + 1.4]);
  P.piece([...top, ...meadowB], winter ? 'snow' : 'meadow', { shadow: 1, rim: 1 });
  // a soft worn path where residents walk
  const path: Pt[] = [];
  for (let x = -10; x <= W + 12; x += 3) path.push([x, SIZES.groundY - 1.2 + fbm1(s + 5, x * 0.03) * 0.5]);
  const pathB: Pt[] = [];
  for (let x = W + 12; x >= -10; x -= 3) pathB.push([x, SIZES.groundY + 2.6 + fbm1(s + 6, x * 0.03) * 0.7]);
  P.piece([...path, ...pathB], winter ? mix(tok('snow'), tok('stone'), 0.25) : mix(tok('meadow'), tok('woodLight'), 0.28), { shadow: 0.25, alpha: 0.8 });
  // flowers and pebbles scattered on the meadow below the path
  if (!winter)
    for (let i = 0; i < W / 9; i++) {
      const x = range(r, 0, W);
      const yy = range(r, SIZES.groundY + 4, faceTop(x) - 0.5);
      if (r() < 0.6) P.dot(x, yy, range(r, 0.35, 0.6), (['cream', 'scarf2', 'leafAmber', 'scarf4'] as const)[i % 4], 0.4);
      else P.piece(ellipse(x, yy, 0.8, 0.45, 8), 'meadowLight', { shadow: 0.3, wobble: 0 });
    }
  // grass tufts along the front lip (autumn) or snow lumps (winter), hanging over the face
  for (let x = range(r, 0, 6); x < W; x += range(r, 3.5, 9)) {
    const y0 = faceTop(x) + 1.2;
    const tuft = winter ? 'snow' : r() < 0.35 ? 'meadowLight' : 'meadow';
    const h = range(r, 1.8, 3.8);
    P.piece(
      [
        [x - 2, y0 - 0.6],
        [x - 1.1, y0 + h * 0.7],
        [x - 0.3, y0 + 0.2],
        [x + 0.4, y0 + h],
        [x + 1.0, y0 + 0.2],
        [x + 1.7, y0 + h * 0.6],
        [x + 2.3, y0 - 0.6],
      ],
      tuft,
      { shadow: 0.7, wobble: 0.3 },
    );
  }
  P.grain(-10, LAND.bankTop - 4, W + 20, H - LAND.bankTop + 14);
  for (const [a, b] of L.creeks ?? []) cutCreek(P, a, b, H, hash(seed, a | 0));
}

/**
 * A creek channel through the holm: the bank is cut away (the near-water layer behind shows through)
 * and sloped earth banks frame the cut.
 */
function cutCreek(P: Paper, a: number, b: number, H: number, seed: number): void {
  const ctx = P.ctx;
  const top = LAND.bankTop - 1.5;
  const trench: Pt[] = [
    [a - 4, top],
    [a + 2, SIZES.groundY + 4],
    [b - 2, SIZES.groundY + 4],
    [b + 4, top],
    [b + 5, H + 4],
    [a - 5, H + 4],
  ];
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  P.piece(trench, 'ink', { shadow: 0, wobble: 0.6 });
  ctx.restore();
  void seed;
  // sloped earth banks: wide at the top, tucking under toward the water
  const wl = LAND.waterTop + 1;
  P.piece([[a - 5, top - 0.5], [a + 2.4, SIZES.groundY + 4.5], [a + 1.2, wl], [a - 6, wl + 1]], 'soil', { shadow: 1, rim: 0.7 });
  P.piece([[a - 5.5, top + 4], [a - 0.5, SIZES.groundY + 6], [a - 0.8, wl], [a - 6, wl + 1]], 'soilDeep', { shadow: 0.4, alpha: 0.8 });
  P.piece([[b + 5, top - 0.5], [b - 2.4, SIZES.groundY + 4.5], [b - 1.2, wl], [b + 6, wl + 1]], 'soilDeep', { shadow: 1, rim: 0.7 });
  P.piece([[b + 5, top - 0.3], [b + 1.5, top + 1.5], [b + 6, top + 2.5]], 'meadow', { shadow: 0.5 });
  P.piece([[a - 5, top - 0.3], [a - 1.5, top + 1.5], [a - 6, top + 2.5]], 'meadow', { shadow: 0.5 });
}

/** Foreground reeds and cattails in the near water: a darker framing layer, kept low so it never hides residents. */
export function drawReeds(L: LayerCtx, H = SIZES.stripHeight): void {
  const { P, W, seed, season } = L;
  const r = rng(hash(seed, 61));
  const dark = season === 'winter' ? mix(tok('reed'), tok('reedTip'), 0.45) : mix(tok('reed'), tok('conifer'), 0.45);
  let x = range(r, 0, 16);
  while (x < W + 10) {
    const n = Math.floor(range(r, 4, 10));
    const tall = r() < 0.35;
    for (let k = 0; k < n; k++) {
      const xx = x + range(r, -5, 5);
      const h = range(r, 6, tall ? 17 : 11);
      const lean = range(r, -0.22, 0.22);
      const base = H + 2;
      const tip: Pt = [xx + lean * h, base - h];
      P.piece([[xx - 0.8, base], [tip[0], tip[1]], [xx + 0.8, base]], k % 3 === 0 ? 'reed' : dark, { shadow: 0.7, wobble: 0.3 });
      if (tall && r() < 0.35) {
        const cx = xx + lean * h * 0.8;
        const cy = base - h * 0.8;
        P.line([[cx, cy + 3.5], [cx, cy - 4.5]], 0.5, dark, { shadow: 0.4 });
        P.piece(ellipse(cx, cy - 1.2, 0.95, 2.3, 10), 'reedTip', { shadow: 0.6, rim: 0.6 });
      }
    }
    // low fans of grass blades between reed beds
    for (let g = 0; g < 2; g++) {
      const gx = x + range(r, 10, 30);
      const blades = 5;
      for (let b = 0; b < blades; b++) {
        const a = -0.7 + (b / (blades - 1)) * 1.4;
        const h = range(r, 3, 5.5);
        P.piece([[gx - 0.5, H + 1], [gx + Math.sin(a) * h, H + 1 - Math.cos(a) * h], [gx + 0.5, H + 1]], dark, { shadow: 0.5, wobble: 0.2 });
      }
    }
    x += range(r, 26, 90);
  }
  P.grain(-10, H - 20, W + 20, 24);
}

export function hazeColor(a: RGB, b: RGB, t: number): RGB {
  return mix(a, b, t);
}
