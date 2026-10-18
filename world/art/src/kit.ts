/**
 * Building kit: the shared vocabulary every structure is cut from, so all 12 structures read as
 * one paper set. Origin for every structure is its bottom-centre on the ground (y = 0, up is -y).
 *
 * House rules (keep the set coherent):
 *  - walls `wall` with rim; shaded side walls `wallShade`; stone footings `stone`/`stoneDark`.
 *  - roofs `roof` (terracotta), `roofThatch` (cottages, bakery), or `roofSlate` (tower, market),
 *    always with a darker eave strip and visible courses; rim on.
 *  - timber is `wood`, dark timber `woodDark`, fresh planks `woodLight`.
 *  - windows: `windowDark` pane in a `woodDark` frame; the lit version paints the same rect in
 *    `lampGlow` (see litWindow) in the emissive pass.
 *  - stage 1 = footing, stakes and string, a plank pile; stage 2 = timber frame with scaffold;
 *    stage 3 = finished with details.
 */
import { Paper, type Pt, type Fill, rect, roundRect, ellipse } from './paper.ts';
import { tok, mix } from './color.ts';
import { rng, range } from './rng.ts';
import type { Season } from './terrain.ts';

export interface DrawOpts {
  season: Season;
  seed: number;
  /** animation frame for moving parts */
  frame?: number;
}

export function wallBlock(P: Paper, x: number, y: number, w: number, h: number, fill: Fill = 'wall'): void {
  P.piece(rect(x, y, w, h), fill, { rim: 1, shadow: 1 });
}

/** Timber beams across a wall (half-timbered look). */
export function beams(P: Paper, x: number, y: number, w: number, h: number, fill: Fill = 'woodDark'): void {
  const t = 1.1;
  P.piece(rect(x, y, w, t), fill, { shadow: 0.6, wobble: 0.4 });
  P.piece(rect(x, y + h - t, w, t), fill, { shadow: 0.6, wobble: 0.4 });
  P.piece(rect(x, y, t, h), fill, { shadow: 0.6, wobble: 0.4 });
  P.piece(rect(x + w - t, y, t, h), fill, { shadow: 0.6, wobble: 0.4 });
}

/** Stone plinth along the bottom of a wall. */
export function plinth(P: Paper, x: number, w: number, h = 2.6): void {
  P.piece(rect(x - 0.6, -h, w + 1.2, h + 0.4), 'stoneDark', { shadow: 0.8, rim: 0.6 });
  const r = rng(Math.round(x * 13 + w * 7));
  let xx = x;
  while (xx < x + w - 1) {
    const sw = range(r, 2.2, 4);
    P.piece(rect(xx + 0.3, -h + 0.4, Math.min(sw, x + w - xx) - 0.6, h - 0.8), 'stone', { shadow: 0.5, wobble: 0.6 });
    xx += sw;
  }
}

/** Gable roof: trapezoid with eave strip and roof courses. cx centre, base y (eave line), w at eaves. */
export function gableRoof(P: Paper, cx: number, eaveY: number, w: number, h: number, fill: Fill = 'roof', deep: Fill = 'roofDeep', season: Season = 'autumn'): void {
  const half = w / 2;
  const ridgeHalf = Math.max(1.2, w * 0.06);
  const pts: Pt[] = [
    [cx - half, eaveY],
    [cx - ridgeHalf, eaveY - h],
    [cx + ridgeHalf, eaveY - h],
    [cx + half, eaveY],
  ];
  P.piece(pts, fill, { rim: 1.2, shadow: 1.3 });
  // roof courses: thin darker strips parallel to the eave
  const courses = Math.max(2, Math.floor(h / 3.4));
  for (let i = 1; i < courses; i++) {
    const t = i / courses;
    const y = eaveY - h * t;
    const hw = half - (half - ridgeHalf) * t;
    P.piece(rect(cx - hw + 0.4, y, hw * 2 - 0.8, 0.55), mix(tok(typeof fill === 'string' ? fill : 'roof'), tok(typeof deep === 'string' ? deep : 'roofDeep'), 0.55), { shadow: 0, wobble: 0.3 });
  }
  // eave strip
  P.piece(rect(cx - half - 0.4, eaveY - 1.2, w + 0.8, 1.6), deep, { shadow: 0.9, wobble: 0.4 });
  if (season === 'winter') snowOn(P, pts.slice(0, 4), 1.6);
}

/** A ragged snow cap along the top edges of a polygon (first to last point, open). */
export function snowOn(P: Paper, top: Pt[], depth: number): void {
  const up: Pt[] = top.map(([x, y]) => [x, y - 0.5]);
  const down: Pt[] = [];
  for (let i = top.length - 1; i >= 0; i--) {
    const [x, y] = top[i];
    down.push([x, y + depth * (0.7 + 0.3 * Math.sin(i * 2.3))]);
  }
  P.piece([...up, ...down], 'snow', { shadow: 0.5, wobble: 0.6 });
}

export function windowPane(P: Paper, x: number, y: number, w: number, h: number, arched = false): void {
  const frame = arched ? roundRect(x - 0.8, y - 0.8, w + 1.6, h + 1.6, [w / 2 + 0.8, w / 2 + 0.8, 0.3, 0.3]) : rect(x - 0.8, y - 0.8, w + 1.6, h + 1.6);
  P.piece(frame, 'woodDark', { shadow: 0.9, wobble: 0.3 });
  const pane = arched ? roundRect(x, y, w, h, [w / 2, w / 2, 0, 0]) : rect(x, y, w, h);
  P.piece(pane, 'windowDark', { shadow: 0, wobble: 0 });
  P.piece(rect(x + w / 2 - 0.3, y, 0.6, h), 'woodDark', { shadow: 0, wobble: 0 });
  P.piece(rect(x, y + h * 0.45, w, 0.6), 'woodDark', { shadow: 0, wobble: 0 });
  // sill
  P.piece(rect(x - 1.1, y + h + 0.5, w + 2.2, 0.9), 'wood', { shadow: 0.7, wobble: 0.2 });
}

/** Emissive version of windowPane: warm panes plus a soft halo. Draw in the lit pass only. */
export function litWindow(P: Paper, x: number, y: number, w: number, h: number, arched = false): void {
  P.glow(x + w / 2, y + h / 2, Math.max(w, h) * 1.9, 'lampGlow', 0.45);
  const pane = arched ? roundRect(x, y, w, h, [w / 2, w / 2, 0, 0]) : rect(x, y, w, h);
  P.piece(pane, 'lampGlow', { shadow: 0, wobble: 0 });
  P.piece(rect(x + w / 2 - 0.3, y, 0.6, h), 'woodDark', { shadow: 0, wobble: 0, alpha: 0.85 });
  P.piece(rect(x, y + h * 0.45, w, 0.6), 'woodDark', { shadow: 0, wobble: 0, alpha: 0.85 });
}

export function door(P: Paper, x: number, y: number, w: number, h: number, fill: Fill = 'wood'): void {
  P.piece(roundRect(x - 0.7, y - 0.7, w + 1.4, h + 0.7, [w / 2 + 0.7, w / 2 + 0.7, 0, 0]), 'woodDark', { shadow: 1, wobble: 0.3 });
  P.piece(roundRect(x, y, w, h, [w / 2, w / 2, 0, 0]), fill, { shadow: 0.4, rim: 0.6, wobble: 0.3 });
  P.piece(rect(x + w * 0.5 - 0.25, y + 1.5, 0.5, h - 1.5), 'woodDark', { shadow: 0, wobble: 0, alpha: 0.5 });
  P.dot(x + w * 0.78, y + h * 0.58, 0.4, 'lampGlow');
}

export function chimney(P: Paper, x: number, y: number, w: number, h: number, season: Season = 'autumn'): void {
  P.piece(rect(x, y, w, h), 'stoneDark', { shadow: 1, rim: 0.8 });
  P.piece(rect(x - 0.6, y - 1, w + 1.2, 1.4), 'stone', { shadow: 0.8, wobble: 0.3 });
  if (season === 'winter') snowOn(P, [[x - 0.6, y - 1], [x + w + 0.6, y - 1]], 1);
}

/** Stage 1 footing: low stone course, corner stakes with string, a plank pile. */
export function footing(P: Paper, w: number, seed: number): void {
  const half = w / 2;
  P.piece(rect(-half, -1.6, w, 2), 'stoneDark', { shadow: 0.8, rim: 0.6 });
  const r = rng(seed);
  for (let x = -half + 0.4; x < half - 1; x += range(r, 2.6, 3.8)) P.piece(rect(x, -1.3, 2.3, 1.2), 'stone', { shadow: 0.4, wobble: 0.6 });
  for (const x of [-half, half]) {
    P.line([[x, 0], [x + 0.2, -8]], 0.8, 'woodLight', { shadow: 0.7 });
  }
  P.line([[-half, -6.5], [half, -6.2]], 0.3, 'cream', { shadow: 0.3, alpha: 0.9 });
  plankPile(P, half * 0.35, 0, 4, 12);
}

export function plankPile(P: Paper, x: number, y: number, n: number, len: number): void {
  for (let i = 0; i < n; i++) {
    const off = (i % 2) * 1.2;
    P.piece(rect(x - len / 2 + off, y - 1.2 * (i + 1), len, 1.1), i % 2 ? 'woodLight' : 'wood', { shadow: 0.7, rim: 0.5, wobble: 0.3 });
  }
}

export function stonePile(P: Paper, x: number, y: number, n: number, seed: number): void {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const row = i < 3 ? 0 : i < 5 ? 1 : 2;
    const cx = x + (i - (row === 0 ? 1 : row === 1 ? 3.5 : 5)) * 2.6 + range(r, -0.3, 0.3);
    P.piece(ellipse(cx, y - 1.2 - row * 2.1, range(r, 1.4, 1.8), range(r, 1.1, 1.3), 12), i % 2 ? 'stone' : 'stoneLight', { shadow: 0.8, rim: 0.6 });
  }
}

/** Stage 2 scaffold: poles, ledger boards, a ladder. */
export function scaffold(P: Paper, x0: number, x1: number, top: number): void {
  for (const x of [x0, x1]) P.line([[x, 0], [x, top]], 0.8, 'woodLight', { shadow: 0.8 });
  for (let y = -6; y > top + 2; y -= 7) P.piece(rect(x0 - 0.8, y, x1 - x0 + 1.6, 1), 'wood', { shadow: 0.8, wobble: 0.3 });
  const lx = x1 - 2.5;
  P.line([[lx, 0], [lx + 1.6, top + 3]], 0.45, 'woodDark', { shadow: 0.5 });
  P.line([[lx + 2.2, 0], [lx + 3.8, top + 3]], 0.45, 'woodDark', { shadow: 0.5 });
  for (let i = 1; i < 6; i++) {
    const t = i / 6;
    const yy = top * t + 3 * t;
    P.line([[lx + 1.6 * t, yy], [lx + 2.2 + 1.6 * t, yy]], 0.35, 'woodDark', { shadow: 0.3 });
  }
}

/** Stage 2 timber frame of a wall plus bare rafters. */
export function frame(P: Paper, w: number, wallH: number, roofH: number, partialWall = 0.45): void {
  const half = w / 2;
  // a partial wall already up
  P.piece(rect(-half, -wallH * partialWall, w, wallH * partialWall), 'wall', { rim: 1, shadow: 1 });
  plinth(P, -half, w, 2.2);
  for (let i = 0; i <= 4; i++) {
    const x = -half + (w * i) / 4;
    P.line([[x, 0], [x, -wallH]], 1, 'wood', { shadow: 0.9 });
  }
  P.line([[-half - 1, -wallH], [half + 1, -wallH]], 1.1, 'wood', { shadow: 0.9 });
  // roof frame: two sloped rafters, a ridge post and purlins parallel to the eaves
  const peak: Pt = [0, -wallH - roofH];
  P.line([[-half - 2, -wallH + 0.6], peak], 1.0, 'wood', { shadow: 0.9 });
  P.line([[half + 2, -wallH + 0.6], peak], 1.0, 'wood', { shadow: 0.9 });
  P.line([[0, -wallH], peak], 0.8, 'woodLight', { shadow: 0.7 });
  for (let i = 1; i <= 2; i++) {
    const t = i / 3;
    const y = -wallH - roofH * t;
    const hw = (half + 2) * (1 - t);
    P.line([[-hw, y], [hw, y]], 0.7, 'woodLight', { shadow: 0.7 });
  }
}

/** Small hanging signboard with a short numeral or icon text (Fraunces if loaded). */
export function signboard(P: Paper, x: number, y: number, w: number, h: number, label: string): void {
  P.line([[x - w / 2 + 1, y - 2.4], [x - w / 2 + 1, y]], 0.3, 'woodDark', { shadow: 0 });
  P.line([[x + w / 2 - 1, y - 2.4], [x + w / 2 - 1, y]], 0.3, 'woodDark', { shadow: 0 });
  P.piece(roundRect(x - w / 2, y, w, h, 0.8), 'woodLight', { shadow: 1, rim: 0.8 });
  if (label) P.text(label, x, y + h / 2 + 0.2, h * 0.72, 'ink');
}
