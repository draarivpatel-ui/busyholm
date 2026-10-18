/**
 * Props: village trees, decorations, moment effects (smoke, dust puff, flying plank, confetti)
 * and weather particles (rain, snow, autumn leaves). Origin bottom-centre on the ground unless noted.
 */
import { Paper, type Pt, type Fill, rect, roundRect, ellipse, circle, blob, strip } from './paper.ts';
import { tok, mix, shade } from './color.ts';
import { rng, range, hash } from './rng.ts';
import { snowOn } from './kit.ts';
import type { Season } from './terrain.ts';
import type { Token } from './tokens.ts';

// ---------------------------------------------------------------- trees

/** Big autumn tree (village scale): trunk, branches and three tones of layered crown. */
export function autumnTree(P: Paper, h: number, seed: number, palette: 0 | 1 | 2 = 0): void {
  const r = rng(seed);
  const trunkW = h * 0.09;
  P.piece([[-trunkW, 0], [-trunkW * 0.6, -h * 0.5], [trunkW * 0.6, -h * 0.5], [trunkW, 0]], 'woodDark', { shadow: 1, rim: 0.4 });
  P.line([[0, -h * 0.42], [-h * 0.16, -h * 0.62]], trunkW * 0.7, 'woodDark', { shadow: 0.8 });
  P.line([[0, -h * 0.46], [h * 0.14, -h * 0.66]], trunkW * 0.6, 'woodDark', { shadow: 0.8 });
  const tones: Token[][] = [
    ['leafRust', 'leafAmber', 'scarf2'],
    ['leafAmber', 'scarf2', 'leafRust'],
    ['meadow', 'leafAmber', 'scarf2'],
  ];
  const [a, b, c] = tones[palette];
  const cy = -h * 0.66;
  const R = h * 0.34;
  P.piece(blob(0, cy, R, R * 0.92, hash(seed, 1), 8, 0.28), shade(tok(a), -0.04), { shadow: 1.2, rim: 1 });
  P.piece(blob(-R * 0.28, cy - R * 0.22, R * 0.7, R * 0.62, hash(seed, 2), 7, 0.3), b, { shadow: 1, rim: 1 });
  P.piece(blob(R * 0.3, cy + R * 0.05, R * 0.56, R * 0.5, hash(seed, 3), 6, 0.3), mix(tok(c), tok(b), 0.4), { shadow: 1, rim: 1 });
  P.piece(blob(-R * 0.05, cy - R * 0.55, R * 0.42, R * 0.34, hash(seed, 4), 6, 0.3), mix(tok(b), tok('lampGlow'), 0.25), { shadow: 0.9, rim: 1 });
  // a few leaves on the ground
  for (let i = 0; i < 5; i++) P.piece(ellipse(range(r, -R, R), -0.3, 0.9, 0.45, 8), r() < 0.5 ? a : b, { shadow: 0.4, wobble: 0 });
  P.grain(-R * 1.4, -h - 4, R * 2.8, h + 6);
}

/** Bare winter tree with snow along the branches. */
export function winterTree(P: Paper, h: number, seed: number): void {
  const r = rng(seed);
  const trunkW = h * 0.08;
  P.piece([[-trunkW, 0], [-trunkW * 0.5, -h * 0.6], [trunkW * 0.5, -h * 0.6], [trunkW, 0]], 'woodDark', { shadow: 1, rim: 0.4 });
  const branch = (x: number, y: number, ang: number, len: number, w: number, depth: number) => {
    const x2 = x + Math.sin(ang) * len;
    const y2 = y - Math.cos(ang) * len;
    P.line([[x, y], [x2, y2]], w, 'woodDark', { shadow: 0.7 });
    if (depth > 0) {
      branch(x2, y2, ang - range(r, 0.3, 0.6), len * 0.68, w * 0.62, depth - 1);
      branch(x2, y2, ang + range(r, 0.3, 0.6), len * 0.68, w * 0.62, depth - 1);
    } else P.piece(ellipse(x2, y2 - 0.2, w * 2.2, w * 1.1, 8), 'snow', { shadow: 0.4, wobble: 0.3 });
  };
  branch(0, -h * 0.55, -0.15, h * 0.26, trunkW * 1.1, 3);
  branch(0, -h * 0.45, 0.55, h * 0.2, trunkW * 0.8, 2);
  branch(0, -h * 0.4, -0.7, h * 0.18, trunkW * 0.7, 2);
  P.grain(-h * 0.6, -h - 4, h * 1.2, h + 6);
}

/** Conifer (both seasons), tiers of cut paper. */
export function conifer(P: Paper, h: number, seed: number, season: Season): void {
  P.piece(rect(-h * 0.05, -h * 0.18, h * 0.1, h * 0.2), 'woodDark', { shadow: 0.8 });
  const tiers = 4;
  for (let i = 0; i < tiers; i++) {
    const t0 = -h * (0.14 + i * 0.2);
    const w = h * (0.36 - i * 0.065);
    const top = t0 - h * 0.34;
    const pts: Pt[] = [[-w, t0], [-w * 0.5, t0 - h * 0.05], [0, top], [w * 0.5, t0 - h * 0.05], [w, t0]];
    P.piece(pts, i % 2 ? 'conifer' : 'coniferLight', { shadow: 1.1, rim: 0.8 });
    if (season === 'winter') snowOn(P, [[-w * 0.55, t0 - h * 0.08], [0, top], [w * 0.55, t0 - h * 0.08]], h * 0.05);
  }
  void seed;
  P.grain(-h * 0.4, -h - 2, h * 0.8, h + 4);
}

/** Village tree for a season, by seeded kind. */
export function villageTree(P: Paper, h: number, seed: number, season: Season, kind: 'broad' | 'conifer'): void {
  if (kind === 'conifer') return conifer(P, h, seed, season);
  if (season === 'winter') return winterTree(P, h, seed);
  autumnTree(P, h, seed, (seed % 3) as 0 | 1 | 2);
}

/** Orchard fruit tree: short trunk, round crown with apples (autumn) or bare with snow (winter). */
export function fruitTree(P: Paper, h: number, seed: number, season: Season): void {
  if (season === 'winter') return winterTree(P, h, seed);
  const r = rng(seed);
  P.piece([[-1.3, 0], [-0.9, -h * 0.42], [0.9, -h * 0.42], [1.3, 0]], 'wood', { shadow: 1, rim: 0.4 });
  const cy = -h * 0.64;
  const R = h * 0.36;
  const green = mix(tok('meadow'), tok('leafAmber'), 0.25 + (seed % 3) * 0.12);
  P.piece(blob(0, cy, R, R * 0.86, hash(seed, 1), 7, 0.22), shade(green, -0.05), { shadow: 1.1, rim: 1 });
  P.piece(blob(-R * 0.2, cy - R * 0.18, R * 0.66, R * 0.56, hash(seed, 2), 6, 0.25), green, { shadow: 0.8, rim: 1 });
  for (let i = 0; i < 9; i++) {
    const a = range(r, 0, Math.PI * 2);
    const d = range(r, 0.2, 0.85) * R;
    P.dot(Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, range(r, 0.7, 0.95), i % 3 ? 'leafRust' : 'errorCoral', 0.5);
  }
  P.grain(-R * 1.3, -h - 3, R * 2.6, h + 5);
}

/** A little bush (decoration and filler). */
export function bush(P: Paper, w: number, seed: number, season: Season): void {
  const fill: Fill = season === 'winter' ? mix(tok('conifer'), tok('snow'), 0.15) : mix(tok('bank'), tok('leafAmber'), (seed % 4) * 0.12);
  P.piece(blob(0, -w * 0.32, w / 2, w * 0.34, seed, 6, 0.3, true), fill, { shadow: 1, rim: 0.9 });
  if (season === 'winter') snowOn(P, [[-w * 0.38, -w * 0.48], [0, -w * 0.66], [w * 0.38, -w * 0.48]], w * 0.08);
  P.grain(-w * 0.6, -w * 0.8, w * 1.2, w);
}

// ---------------------------------------------------------------- decorations

export type DecoKind = 'bench' | 'lamppost' | 'flowers' | 'birdhouse' | 'pumpkins' | 'snowman' | 'hammock' | 'crate' | 'bunting';

export function decoration(P: Paper, kind: DecoKind, seed: number, season: Season): void {
  const r = rng(seed);
  switch (kind) {
    case 'bench':
      P.piece(rect(-6, -4.2, 12, 1.4), 'wood', { shadow: 1, rim: 0.6 });
      P.piece(rect(-6, -8, 12, 1.2), 'wood', { shadow: 0.8, rim: 0.5 });
      for (const x of [-5, 4]) P.piece(rect(x, -8, 1, 8), 'woodDark', { shadow: 0.7 });
      if (season === 'winter') snowOn(P, [[-6, -4.2], [6, -4.2]], 0.7);
      break;
    case 'lamppost':
      P.piece(rect(-0.6, -16, 1.2, 16), 'ink', { shadow: 0.9 });
      P.piece(rect(-2, -20, 4, 4.4), mix(tok('ink'), tok('lampGlow'), 0.35), { shadow: 0.8, wobble: 0 });
      P.piece([[-2.6, -20], [0, -22.4], [2.6, -20]], 'ink', { shadow: 0.6, wobble: 0 });
      break;
    case 'flowers':
      for (let i = 0; i < 6; i++) {
        const x = range(r, -5, 5);
        const h = range(r, 2.5, 5);
        P.line([[x, 0], [x, -h]], 0.4, 'bank', { shadow: 0 });
        P.dot(x, -h, 0.9, (['scarf0', 'scarf2', 'scarf4', 'cream'] as Token[])[i % 4], 0.5);
      }
      break;
    case 'birdhouse':
      P.piece(rect(-0.5, -14, 1, 14), 'wood', { shadow: 0.8 });
      P.piece(rect(-2.6, -19, 5.2, 5), 'scarf1', { shadow: 1, rim: 0.6 });
      P.piece([[-3.4, -18.6], [0, -22], [3.4, -18.6]], 'roof', { shadow: 0.8, rim: 0.6 });
      P.dot(0, -16.6, 0.8, 'ink');
      break;
    case 'pumpkins':
      for (let i = 0; i < 3; i++) {
        const x = -4 + i * 4 + range(r, -0.5, 0.5);
        const s = range(r, 1.6, 2.4);
        P.piece(ellipse(x, -s, s * 1.3, s, 14), 'leafAmber', { shadow: 1, rim: 0.7 });
        P.line([[x - s * 0.4, -s * 1.8], [x - s * 0.4, -0.3]], 0.25, shade(tok('leafAmber'), -0.12), { shadow: 0 });
        P.line([[x, -s * 2], [x + 0.4, -s * 2.5]], 0.5, 'bank', { shadow: 0 });
      }
      break;
    case 'snowman':
      P.piece(circle(0, -3.6, 3.8, 18), 'snow', { shadow: 1, rim: 0.6 });
      P.piece(circle(0, -9.4, 2.7, 16), 'snow', { shadow: 1, rim: 0.6 });
      P.piece(rect(-2.4, -10.6, 4.8, 1.2), 'scarf0', { shadow: 0.6 });
      P.dot(-0.8, -10.2, 0.35, 'ink');
      P.dot(0.9, -10.2, 0.35, 'ink');
      P.piece([[0.2, -9.6], [2.6, -9.2], [0.2, -9]], 'leafAmber', { shadow: 0, wobble: 0 });
      break;
    case 'hammock':
      P.line([[-12, 0], [-12, -9]], 0.9, 'woodDark', { shadow: 0.8 });
      P.line([[12, 0], [12, -9]], 0.9, 'woodDark', { shadow: 0.8 });
      P.piece(strip([[-11.5, -8], [-6, -4.6], [0, -3.8], [6, -4.6], [11.5, -8]], 1.6), 'scarf1', { shadow: 1 });
      break;
    case 'crate':
      P.piece(rect(-3, -5, 6, 5), 'woodLight', { shadow: 1, rim: 0.6 });
      P.line([[-3, -5], [3, 0]], 0.4, 'wood', { shadow: 0 });
      P.line([[3, -5], [-3, 0]], 0.4, 'wood', { shadow: 0 });
      break;
    case 'bunting': {
      const cols: Token[] = ['scarf0', 'scarf1', 'scarf2', 'scarf3', 'scarf4', 'scarf5'];
      P.line([[-20, -16], [0, -13], [20, -16]], 0.25, 'ink', { shadow: 0 });
      for (let i = 0; i < 9; i++) {
        const x = -18 + i * 4.5;
        const y = -16 + 3 * (1 - Math.pow((x / 20), 2));
        P.piece([[x - 1.4, y], [x + 1.4, y], [x, y + 2.8]], cols[i % 6], { shadow: 0.5, wobble: 0 });
      }
      break;
    }
  }
  P.grain(-14, -24, 28, 25);
}

// ---------------------------------------------------------------- moments and effects

/** A paper smoke puff (cream). size ~4..8. */
export function smokePuff(P: Paper, size: number, seed: number): void {
  P.piece(blob(0, 0, size, size * 0.8, seed, 6, 0.35), 'cream', { shadow: 0.4, rim: 0.4 });
}

/** Dust puff when a stage completes: a ring of paper clouds. */
export function dustPuff(P: Paper, w: number, seed: number): void {
  const r = rng(seed);
  for (let i = 0; i < 7; i++) {
    const x = (i - 3) * (w / 7) + range(r, -1, 1);
    const s = range(r, 2.6, 4.4);
    P.piece(blob(x, -s * 0.8 - Math.abs(i - 3) * 0.6, s, s * 0.75, hash(seed, i), 6, 0.35), mix(tok('stoneLight'), tok('cream'), 0.5), { shadow: 0.6, rim: 0.5 });
  }
}

/** The plank that arcs from a resident to the build site (SPEC 4.3 finished). Centred at origin. */
export function flyingPlank(P: Paper): void {
  P.piece(rect(-6, -0.9, 12, 1.8), 'woodLight', { shadow: 1, rim: 0.8 });
  P.line([[-4, -0.2], [4, 0.1]], 0.25, 'wood', { shadow: 0, wobble: 0 });
}

/** Confetti in palette colours (finished moment). Centred around the origin, spread ~w. */
export function confetti(P: Paper, w: number, seed: number): void {
  const r = rng(seed);
  const cols: Token[] = ['scarf0', 'scarf1', 'scarf2', 'scarf3', 'scarf4', 'alertFlag', 'cream'];
  for (let i = 0; i < 22; i++) {
    const x = range(r, -w / 2, w / 2);
    const y = range(r, -w * 0.45, 0);
    P.at(x, y, range(r, 0, Math.PI), () => P.piece(rect(-0.7, -0.35, 1.4, 0.7), cols[i % cols.length], { shadow: 0.3, wobble: 0 }));
  }
}

/** Firefly (emissive): a warm dot with a glow. */
export function firefly(P: Paper, x: number, y: number, a: number): void {
  P.glow(x, y, 3.2, 'lampGlow', 0.6 * a);
  P.piece(circle(x, y, 0.45, 8), mix(tok('lampGlow'), tok('cream'), 0.5), { shadow: 0, wobble: 0, alpha: a });
}

// ---------------------------------------------------------------- weather particles

/** Rain: short ink strokes, slanted by wind. */
export function rainStroke(P: Paper, x: number, y: number, len: number, slant: number, alpha: number): void {
  P.line([[x, y], [x + slant * len, y + len]], 0.42, 'ink', { shadow: 0, wobble: 0, alpha });
}

/** Snowflake: a small paper disc, or a 6-point star at larger scales. */
export function snowflake(P: Paper, x: number, y: number, r: number, alpha: number): void {
  P.piece(circle(x, y, r, 8), 'snow', { shadow: 0.25, wobble: 0, alpha });
}

/** Falling autumn leaf. */
export function leaf(P: Paper, x: number, y: number, rot: number, s: number, t: Token): void {
  P.at(x, y, rot, () => {
    P.piece([[-s, 0], [-s * 0.3, -s * 0.5], [s, 0], [-s * 0.3, s * 0.5]], t, { shadow: 0.5, wobble: 0 });
  });
}

/** Rainbow (weekly reset): paper bands in an arc over the river. Centre at origin (ground). */
export function rainbow(P: Paper, R: number, alpha: number): void {
  const bands: Token[] = ['scarf4', 'scarf0', 'scarf2', 'scarf3', 'scarf1', 'scarf5'];
  const bw = R * 0.055;
  bands.forEach((t, i) => {
    const r0 = R - i * bw;
    const outer = ellipse(0, 0, r0, r0 * 0.62, 60, Math.PI, Math.PI * 2);
    const inner = ellipse(0, 0, r0 - bw, (r0 - bw) * 0.62, 60, Math.PI, Math.PI * 2).reverse();
    P.piece([...outer, ...inner], t, { shadow: 0.5, wobble: 0.4, alpha });
  });
}

export { roundRect };
