/**
 * Ambient mountain ranges with varied silhouettes. The art kit's drawMountains repeats one
 * triangular peak; at the ambient view's 4.6x scale the repetition shows. Here a range mixes broad
 * massifs, sharp horns, twin summits, saddles and low shoulders of very different widths, each a
 * cut-paper sheet with a lighter sun-facing facet and snow only on the tallest summits.
 */
import { tok, mix, type RGB } from '../../../art/src/color.ts';
import type { Paper, Pt, Fill } from '../../../art/src/paper.ts';
import { rng, range, hash, fbm1 } from '../../../art/src/rng.ts';

type Kind = 'horn' | 'massif' | 'twin' | 'shoulder';

interface Peak {
  x: number;
  /** height above the range's bottom, units */
  h: number;
  /** half-widths of the left and right flanks */
  wl: number;
  wr: number;
  kind: Kind;
}

/** Height of the range at x: the max of the peaks' profiles plus a little ridge noise. */
function profile(peaks: Peak[], x: number, seed: number, H: number): number {
  let y = H * 0.12 + fbm1(seed, x * 0.004, 3) * H * 0.08;
  for (const p of peaks) {
    const d = x - p.x;
    const w = d < 0 ? p.wl : p.wr;
    const u = Math.abs(d) / w;
    if (u >= 1) continue;
    let f: number;
    switch (p.kind) {
      case 'horn':
        f = Math.pow(1 - u, 1.35);
        break;
      case 'massif':
        f = u < 0.18 ? 1 - u * 0.25 : Math.pow(1 - (u - 0.18) / 0.82, 1.1) * 0.955;
        break;
      case 'twin': {
        const a = Math.pow(Math.max(0, 1 - Math.abs(d + w * 0.22) / (w * 0.78)), 1.25);
        const b = 0.86 * Math.pow(Math.max(0, 1 - Math.abs(d - w * 0.3) / (w * 0.7)), 1.25);
        f = Math.max(a, b);
        break;
      }
      default:
        f = Math.pow(1 - u, 0.8) * 0.9;
    }
    y = Math.max(y, f * p.h);
  }
  // fine cut-edge irregularity: notches and small steps on the ridgeline
  y += fbm1(seed + 7, x * 0.06, 2) * H * 0.018;
  return y;
}

export function drawRange(P: Paper, x0: number, x1: number, peakY: number, bottomY: number, seed: number, fill: Fill, sunSide: number, snowLine: number): void {
  const H = bottomY - peakY;
  const r = rng(hash(seed, 211));
  const peaks: Peak[] = [];
  let x = x0 - 40;
  const kinds: Kind[] = ['horn', 'massif', 'twin', 'shoulder', 'massif', 'horn'];
  while (x < x1 + 80) {
    const kind = kinds[Math.floor(r() * kinds.length)];
    const big = r() < 0.45;
    const h = H * (kind === 'shoulder' ? range(r, 0.35, 0.55) : big ? range(r, 0.78, 1) : range(r, 0.5, 0.78));
    const w = kind === 'massif' ? range(r, 90, 170) : kind === 'twin' ? range(r, 80, 130) : kind === 'horn' ? range(r, 45, 85) : range(r, 60, 120);
    const skew = range(r, 0.7, 1.35);
    peaks.push({ x: x + w * 0.6, h, wl: w * skew, wr: w / skew, kind });
    x += w * range(r, 0.75, 1.25);
  }
  const step = 2.5;
  const ridge: Pt[] = [];
  for (let xx = x0 - 30; xx <= x1 + 30; xx += step) ridge.push([xx, bottomY - profile(peaks, xx, seed, H)]);
  const base: RGB = typeof fill === 'string' ? tok(fill) : fill;
  P.piece([[x0 - 30, bottomY + 2], ...ridge, [x1 + 30, bottomY + 2]], base, { rim: 1.2, shadow: 0.5, wobble: 1.1 });
  // sun-facing facets: from each summit down the sun side of the actual ridgeline, back up a crease
  const lightFace = mix(mix(base, tok('cream'), 0.33), tok('lampGlow'), 0.28);
  const shadeFace = mix(base, tok('ink'), 0.1);
  for (let i = 1; i < ridge.length - 1; i++) {
    const [px, py] = ridge[i];
    if (!(py <= ridge[i - 1][1] && py < ridge[i + 1][1])) continue;
    const ph = bottomY - py;
    if (ph < H * 0.3) continue;
    // walk down the sun side until the ridge has dropped 55% of the summit height
    const side = sunSide < 0 ? -1 : 1;
    const pts: Pt[] = [[px, py]];
    let j = i;
    while (j + side > 0 && j + side < ridge.length - 1 && ridge[j + side][1] - py < ph * 0.55) {
      j += side;
      pts.push(ridge[j]);
    }
    const end = ridge[j];
    const crease: Pt = [px - side * ph * 0.05 + (hash(seed, i) % 7) - 3, py + ph * 0.85];
    const mid: Pt = [(end[0] + crease[0]) / 2 + side * ph * 0.06, (end[1] + crease[1]) / 2];
    P.piece([...pts, mid, crease, [px - side * ph * 0.015, py + ph * 0.25]], lightFace, { shadow: 0, wobble: 0.9, alpha: 0.8 });
    // the far side in a slightly darker sheet for a folded-paper read
    const far: Pt[] = [[px, py]];
    let k2 = i;
    while (k2 - side > 0 && k2 - side < ridge.length - 1 && ridge[k2 - side][1] - py < ph * 0.4) {
      k2 -= side;
      far.push(ridge[k2]);
    }
    if (far.length > 2) P.piece([...far, [px - side * ph * 0.02, py + ph * 0.5]], shadeFace, { shadow: 0, wobble: 0.8, alpha: 0.5 });
    // a secondary spur on the sun side: a narrower light sheet that breaks the big facet
    if (ph > H * 0.45) {
      const sx = px + side * ph * 0.16;
      const sy = py + ph * 0.32;
      P.piece([[sx, sy], [sx + side * ph * 0.2, sy + ph * 0.42], [sx + side * ph * 0.05, sy + ph * 0.5], [sx - side * ph * 0.02, sy + ph * 0.2]], mix(lightFace, tok('cream'), 0.15), { shadow: 0, wobble: 0.7, alpha: 0.55 });
    }
    if (ph > H * snowLine) {
      // snow cap following the ridge near the summit, jagged lower edge
      const capH = ph * 0.17;
      const cap: Pt[] = [];
      let a = i;
      while (a > 0 && ridge[a - 1][1] - py < capH) a--;
      let b = i;
      while (b < ridge.length - 1 && ridge[b + 1][1] - py < capH) b++;
      for (let q = a; q <= b; q++) cap.push(ridge[q]);
      const n = 5;
      for (let q = n; q >= 0; q--) {
        const xx = ridge[a][0] + ((ridge[b][0] - ridge[a][0]) * q) / n;
        cap.push([xx, py + capH * (q % 2 ? 0.95 : 0.62) + (hash(seed, i, q) % 3) * 0.4]);
      }
      if (cap.length > 3) P.piece(cap, 'mountainSnow', { shadow: 0.4, wobble: 0.5 });
    }
  }
  P.grain(x0 - 40, peakY - 10, x1 - x0 + 80, bottomY - peakY + 20);
}
