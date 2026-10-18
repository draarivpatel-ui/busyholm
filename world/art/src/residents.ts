/**
 * Residents (SPEC 4.2, 4.3): paper puppets. Each species is a set of rigid paper parts (body, head,
 * ears, tail, two arms, two feet, a scarf) that rotate at pivots; poses are joint-angle data, and
 * every state has a distinct pose AND a distinct prop, so colour is never the only cue.
 *
 * Origin: between the feet on the ground (y = 0), facing right (+x), units are strip units.
 * Heights at 1x (SPEC 3.4): beaver 24, otter 24, hare 28 with ears, frog 18, hedgehog 20.
 *
 * Instance colour: the scarf. `drawResident(..., mode: 'scarf')` renders only the visible scarf
 * pixels in white, so the renderer can tint one overlay sprite per instance colour.
 */
import { Paper, type Pt, type Fill, rect, roundRect, ellipse, circle, strip, xf } from './paper.ts';
import { tok, mix, shade, type RGB } from './color.ts';
import { PAL, type Token } from './tokens.ts';
import type { Ctx2D } from './paper.ts';

export const SPECIES = ['beaver', 'otter', 'frog', 'hare', 'hedgehog'] as const;
export type Species = (typeof SPECIES)[number];

/** Tool to species defaults live in worldmap.ts (SPECIES_BY_TOOL), keyed by the World v1 tool ids. */

/** The 8 state poses used by the silhouette test (the 6 legibility states plus 2 moments). */
export const STATE_POSES = ['working', 'needs_you', 'your_turn', 'error', 'limited', 'idle', 'celebrating', 'asleep'] as const;
export type StatePose = (typeof STATE_POSES)[number];

// ---------------------------------------------------------------- props

export type PropId =
  | 'none'
  | 'saw'
  | 'hammer'
  | 'mallet'
  | 'scroll'
  | 'spyglass'
  | 'whistle'
  | 'broom'
  | 'can'
  | 'lantern'
  | 'teacup'
  | 'plank'
  | 'sack'
  | 'roller'
  | 'basket'
  | 'rope'
  | 'stretch';

type Eyes = 'open' | 'closed' | 'happy' | 'worried' | 'wide';

export interface Pose {
  /** body lean in degrees (positive leans forward) */
  lean?: number;
  /** vertical offset of the whole body (negative = up, for hops) */
  lift?: number;
  /** sitting: body lowered, feet forward */
  sit?: boolean;
  /** lying asleep on its side */
  lie?: boolean;
  headTilt?: number;
  /** face the camera (alert anticipation, ringing, cheering) */
  front?: boolean;
  eyes?: Eyes;
  mouth?: 'none' | 'open' | 'smile' | 'o';
  /** arm angles in degrees: 0 hangs down, 90 points forward, 180 points up */
  back: number;
  fore: number;
  /** foot offsets for walking/running (units, + forward) */
  stepBack?: number;
  stepFore?: number;
  /** foot lift (units up) */
  liftBack?: number;
  liftFore?: number;
  tail?: number;
  /** prop in the front hand and its angle relative to the arm */
  prop?: PropId;
  propAngle?: number;
  /** prop in the back hand */
  propBack?: PropId;
  /** extras around the body (state cues) */
  extras?: ('cloud' | 'zzz' | 'check' | 'stone' | 'press' | 'groundlantern' | 'question' | 'pile')[];
}

// ---------------------------------------------------------------- species geometry

interface SpeciesDef {
  id: Species;
  h: number;
  fur: Token;
  /** belly and muzzle colour */
  light: RGB;
  /** hands and paws: a contrasting tone so gestures read at 24 units */
  paw: RGB;
  dark: RGB;
  body: { cx: number; cy: number; rx: number; ry: number; pear: number };
  head: { cx: number; cy: number; rx: number; ry: number };
  shoulder: Pt;
  hip: Pt;
  arm: { len: number; w: number; hand: number };
  foot: { rx: number; ry: number; gap: number };
  scarfY: number;
  scarfW: number;
  drawTail(P: Paper, d: SpeciesDef, pose: Pose): void;
  drawEars(P: Paper, d: SpeciesDef, pose: Pose, back: boolean): void;
  drawFace(P: Paper, d: SpeciesDef, pose: Pose): void;
  drawBodyExtra?(P: Paper, d: SpeciesDef, pose: Pose): void;
}

const fur = (t: Token) => tok(t);

function eyes(P: Paper, at: Pt[], kind: Eyes, r = 0.78): void {
  for (const [x, y] of at) {
    if (kind === 'closed') {
      P.line([[x - 0.9, y], [x, y + 0.45], [x + 0.9, y]], 0.42, 'ink', { shadow: 0, wobble: 0 });
    } else if (kind === 'happy') {
      P.line([[x - 0.9, y + 0.3], [x, y - 0.5], [x + 0.9, y + 0.3]], 0.45, 'ink', { shadow: 0, wobble: 0 });
    } else {
      const rr = kind === 'wide' ? r * 1.25 : r;
      P.piece(circle(x, y, rr, 12), 'ink', { shadow: 0, wobble: 0 });
      P.piece(circle(x + rr * 0.35, y - rr * 0.35, rr * 0.36, 8), 'speciesHighlight', { shadow: 0, wobble: 0 });
      if (kind === 'worried') P.line([[x - 1, y - 1.6], [x + 0.9, y - 2.1]], 0.4, 'ink', { shadow: 0, wobble: 0 });
    }
  }
}

function mouth(P: Paper, x: number, y: number, kind: Pose['mouth'], w = 1.6): void {
  if (!kind || kind === 'none') return;
  if (kind === 'open') P.piece(ellipse(x, y + 0.3, w * 0.55, w * 0.5, 10), mix(tok('ink'), tok('errorCoral'), 0.35), { shadow: 0, wobble: 0 });
  else if (kind === 'o') P.piece(ellipse(x, y + 0.3, w * 0.35, w * 0.4, 10), 'ink', { shadow: 0, wobble: 0 });
  else P.line([[x - w * 0.5, y], [x, y + w * 0.35], [x + w * 0.5, y]], 0.4, 'ink', { shadow: 0, wobble: 0 });
}

const BEAVER: SpeciesDef = {
  id: 'beaver',
  h: 24,
  fur: 'beaver',
  light: mix(fur('beaver'), tok('cream'), 0.5),
  paw: mix(fur('beaver'), tok('cream'), 0.62),
  dark: shade(fur('beaver'), -0.12),
  body: { cx: 0, cy: -8.8, rx: 5.6, ry: 6.8, pear: 0.14 },
  head: { cx: 1, cy: -17.4, rx: 5.8, ry: 5.3 },
  shoulder: [0.4, -12.4],
  hip: [0, -4.5],
  arm: { len: 5.4, w: 2.3, hand: 1.25 },
  foot: { rx: 2.3, ry: 1.1, gap: 2.4 },
  scarfY: -12.6,
  scarfW: 10,
  drawTail(P, d, pose) {
    // the beaver's big flat paddle: its silhouette signature
    const a = ((pose.tail ?? 0) - 62) * (Math.PI / 180);
    const pts = xf(ellipse(0, -5.6, 2.7, 5.8, 18), -4.4, -3.4, a);
    P.piece(pts, mix(d.dark, tok('ink'), 0.25), { shadow: 1, rim: 0.6 });
    for (let i = 1; i <= 3; i++) {
      const s = xf([[-1.8, -2.4 * i], [1.8, -2.4 * i - 0.6]], -4.4, -3.4, a);
      P.line(s, 0.3, d.dark, { shadow: 0, wobble: 0, alpha: 0.9 });
    }
  },
  drawEars(P, d, _pose, back) {
    if (back) P.piece(circle(d.head.cx - 3.6, d.head.cy - 3.9, 1.6, 12), d.dark, { shadow: 0.6 });
    else {
      P.piece(circle(d.head.cx + 3.0, d.head.cy - 4.5, 1.5, 12), 'beaver', { shadow: 0.6, rim: 0.6 });
      P.piece(circle(d.head.cx + 3.0, d.head.cy - 4.4, 0.7, 8), d.dark, { shadow: 0, wobble: 0 });
    }
  },
  drawFace(P, d, pose) {
    const { cx, cy } = d.head;
    const f = pose.front ? -1.4 : 0;
    P.piece(ellipse(cx + 2.7 + f, cy + 1.7, 2.9, 2.1, 16), d.light, { shadow: 0.5 });
    P.piece(ellipse(cx + 4.4 + f, cy + 0.5, 1.25, 0.9, 12), mix(tok('ink'), tok('woodDark'), 0.4), { shadow: 0, wobble: 0 });
    // buck teeth
    P.piece(rect(cx + 2.4 + f, cy + 3.3, 1.5, 1.4), 'cream', { shadow: 0.4, wobble: 0 });
    P.line([[cx + 3.15 + f, cy + 3.3], [cx + 3.15 + f, cy + 4.6]], 0.22, 'ink', { shadow: 0, wobble: 0 });
    eyes(P, pose.front ? [[cx - 1.6, cy - 1.0], [cx + 2.0, cy - 1.0]] : [[cx + 0.3, cy - 1.2], [cx + 3.3, cy - 1.5]], pose.eyes ?? 'open');
    mouth(P, cx + 2.2 + f, cy + 2.9, pose.mouth === 'smile' ? 'none' : pose.mouth);
  },
};

const OTTER: SpeciesDef = {
  id: 'otter',
  h: 24,
  fur: 'otter',
  light: fur('otterFace'),
  paw: mix(fur('otterFace'), fur('otter'), 0.15),
  dark: shade(fur('otter'), -0.08),
  body: { cx: 0, cy: -9.4, rx: 4.5, ry: 7.2, pear: 0.1 },
  head: { cx: 1.3, cy: -18.4, rx: 4.9, ry: 4.6 },
  shoulder: [0.8, -13.2],
  hip: [0, -4.5],
  arm: { len: 5.6, w: 2.0, hand: 1.1 },
  foot: { rx: 2.1, ry: 1.0, gap: 2.2 },
  scarfY: -13.6,
  scarfW: 8.6,
  drawTail(P, d, pose) {
    // long tapering tail sweeping along the ground: the otter's signature
    const a = (pose.tail ?? 0) * (Math.PI / 180);
    const path = xf([[-2.6, -4.5], [-6.5, -2.6], [-10.5, -1.1], [-14.2, -0.6]], 0, 0, a);
    P.piece(strip(path, (t) => 3.2 - t * 2.3), d.dark, { shadow: 1, rim: 0.5 });
  },
  drawEars(P, d, _pose, back) {
    if (back) P.piece(circle(d.head.cx - 3.2, d.head.cy - 3.1, 1.1, 10), d.dark, { shadow: 0.5 });
    else P.piece(circle(d.head.cx + 2.4, d.head.cy - 4.0, 1.0, 10), 'otter', { shadow: 0.5, rim: 0.5 });
  },
  drawFace(P, d, pose) {
    const { cx, cy } = d.head;
    const f = pose.front ? -1.5 : 0;
    // cream face mask over the lower half of the head
    P.piece(ellipse(cx + 1.7 + f, cy + 1.3, 3.9, 2.9, 18), d.light, { shadow: 0.4 });
    P.piece(ellipse(cx + 4.0 + f, cy + 0.0, 1.15, 0.85, 12), 'ink', { shadow: 0, wobble: 0 });
    for (const dy of [-0.2, 0.9]) {
      P.line([[cx + 4.3 + f, cy + 1 + dy], [cx + 7.4 + f, cy + 0.3 + dy * 1.6]], 0.22, 'ink', { shadow: 0, wobble: 0, alpha: 0.75 });
    }
    eyes(P, pose.front ? [[cx - 1.4, cy - 1.2], [cx + 1.8, cy - 1.2]] : [[cx + 0.4, cy - 1.4], [cx + 3.0, cy - 1.6]], pose.eyes ?? 'open', 0.72);
    mouth(P, cx + 2.6 + f, cy + 2.6, pose.mouth, 1.4);
  },
  drawBodyExtra(P, d) {
    P.piece(ellipse(d.body.cx + 1.6, d.body.cy + 0.5, 2.8, 5.6, 18), d.light, { shadow: 0.3 });
  },
};

const FROG: SpeciesDef = {
  id: 'frog',
  h: 18,
  fur: 'frog',
  light: mix(fur('frog'), tok('cream'), 0.55),
  paw: mix(fur('frog'), tok('cream'), 0.62),
  dark: shade(fur('frog'), -0.12),
  body: { cx: 0, cy: -6.4, rx: 6.0, ry: 5.6, pear: 0.18 },
  head: { cx: 1.2, cy: -11.2, rx: 5.6, ry: 4.3 },
  shoulder: [1.6, -7.6],
  hip: [-1, -3],
  arm: { len: 4.2, w: 1.8, hand: 1.15 },
  foot: { rx: 3.0, ry: 0.9, gap: 2.8 },
  scarfY: -8.2,
  scarfW: 9.6,
  drawTail(P, d) {
    // folded hind leg (frogs have no tail; the big thigh is the silhouette signature)
    P.piece(xf(ellipse(0, 0, 3.6, 2.3, 18), -3.6, -2.8, -0.35), d.dark, { shadow: 1, rim: 0.5 });
  },
  drawEars(P, d, pose, back) {
    // eye bumps on top of the head
    const { cx, cy } = d.head;
    const pts: Pt[] = pose.front ? [[cx - 2.4, cy - 4.0], [cx + 2.6, cy - 4.0]] : [[cx - 1.4, cy - 4.2], [cx + 3.4, cy - 4.4]];
    const p = back ? pts[0] : pts[1];
    P.piece(circle(p[0], p[1], 2.15, 16), 'frog', { shadow: 0.7, rim: 0.7 });
    P.piece(circle(p[0] + 0.1, p[1] - 0.1, 1.35, 14), 'cream', { shadow: 0, wobble: 0 });
    const kind = pose.eyes ?? 'open';
    if (kind === 'closed' || kind === 'happy') {
      P.piece(ellipse(p[0], p[1] - 0.2, 1.45, 1.3, 12), 'frog', { shadow: 0, wobble: 0 });
      eyes(P, [[p[0], p[1] + 0.2]], kind);
    } else eyes(P, [[p[0] + 0.35, p[1]]], kind, 0.72);
  },
  drawFace(P, d, pose) {
    const { cx, cy } = d.head;
    const f = pose.front ? -1.8 : 0;
    if (pose.mouth === 'open' || pose.mouth === 'o') mouth(P, cx + 2.6 + f, cy + 1.6, 'open', 2.4);
    else P.line([[cx + 0.4 + f, cy + 1.6], [cx + 3.0 + f, cy + 2.3], [cx + 5.4 + f, cy + 1.2]], 0.42, mix(tok('ink'), tok('frog'), 0.3), { shadow: 0, wobble: 0 });
    // cheek spot
    P.piece(circle(cx - 1.5, cy + 0.3, 0.7, 8), d.dark, { shadow: 0, wobble: 0, alpha: 0.7 });
  },
  drawBodyExtra(P, d) {
    P.piece(ellipse(d.body.cx + 2.0, d.body.cy + 1.2, 3.2, 3.6, 16), d.light, { shadow: 0.3 });
    P.piece(circle(d.body.cx - 2.6, d.body.cy - 2.2, 0.9, 8), d.dark, { shadow: 0, wobble: 0.3 });
    P.piece(circle(d.body.cx - 3.6, d.body.cy + 0.6, 0.7, 8), d.dark, { shadow: 0, wobble: 0.3 });
  },
};

const HARE: SpeciesDef = {
  id: 'hare',
  h: 28,
  fur: 'hare',
  light: mix(fur('hare'), tok('cream'), 0.55),
  paw: mix(fur('hare'), tok('woodDark'), 0.42),
  dark: shade(fur('hare'), -0.12),
  body: { cx: 0, cy: -8.6, rx: 4.7, ry: 6.4, pear: 0.14 },
  head: { cx: 1.3, cy: -16.4, rx: 4.6, ry: 4.3 },
  shoulder: [0.7, -12.2],
  hip: [0, -4],
  arm: { len: 5.2, w: 1.9, hand: 1.05 },
  foot: { rx: 3.0, ry: 1.0, gap: 2.0 },
  scarfY: -12.2,
  scarfW: 8.8,
  drawTail(P, d) {
    P.piece(circle(-4.9, -6.0, 2.0, 14), d.light, { shadow: 0.9, rim: 0.6 });
  },
  drawEars(P, d, pose, back) {
    // long ears are the hare's silhouette signature (28 units with ears)
    const { cx, cy } = d.head;
    const droop = pose.eyes === 'worried' || pose.lie ? 0.9 : pose.eyes === 'closed' ? 0.5 : 0;
    if (back) {
      const path: Pt[] = [[cx - 1.4, cy - 2.6], [cx - 2.8 - droop * 3, cy - 7.5 + droop * 2], [cx - 3.8 - droop * 6, cy - 11.4 + droop * 5]];
      P.piece(strip(path, (t) => 2.7 - t * 1.0), d.dark, { shadow: 0.7 });
    } else {
      const path: Pt[] = [[cx + 0.4, cy - 2.9], [cx + 0.2 - droop * 3, cy - 7.8 + droop * 2.2], [cx - 0.4 - droop * 6.5, cy - 11.8 + droop * 5.5]];
      P.piece(strip(path, (t) => 2.8 - t * 1.0), 'hare', { shadow: 0.8, rim: 0.6 });
      P.piece(strip(path.map(([x, y]) => [x + 0.15, y + 0.6] as Pt).slice(0, 3), (t) => 1.1 - t * 0.5), mix(tok('hare'), tok('scarf0'), 0.35), { shadow: 0, wobble: 0.3 });
    }
  },
  drawFace(P, d, pose) {
    const { cx, cy } = d.head;
    const f = pose.front ? -1.4 : 0;
    P.piece(ellipse(cx + 2.6 + f, cy + 1.4, 2.1, 1.7, 14), d.light, { shadow: 0.3 });
    P.piece(ellipse(cx + 4.0 + f, cy + 0.5, 0.75, 0.6, 10), mix(tok('scarf0'), tok('ink'), 0.25), { shadow: 0, wobble: 0 });
    eyes(P, pose.front ? [[cx - 1.4, cy - 0.9], [cx + 1.8, cy - 0.9]] : [[cx + 0.4, cy - 1.1], [cx + 3.0, cy - 1.3]], pose.eyes ?? 'open', 0.72);
    mouth(P, cx + 2.6 + f, cy + 2.6, pose.mouth, 1.3);
  },
  drawBodyExtra(P, d) {
    P.piece(ellipse(d.body.cx + 1.5, d.body.cy + 0.8, 2.8, 4.6, 16), d.light, { shadow: 0.3 });
  },
};

const HEDGEHOG: SpeciesDef = {
  id: 'hedgehog',
  h: 20,
  fur: 'hedgehog',
  light: mix(fur('hedgehog'), tok('cream'), 0.6),
  paw: mix(fur('hedgehog'), tok('cream'), 0.7),
  dark: shade(fur('hedgehog'), -0.14),
  body: { cx: -0.4, cy: -7.4, rx: 6.0, ry: 6.4, pear: 0.1 },
  head: { cx: 2.6, cy: -11.0, rx: 4.2, ry: 3.8 },
  shoulder: [1.6, -8.6],
  hip: [0, -3.4],
  arm: { len: 4.4, w: 1.8, hand: 1.05 },
  foot: { rx: 2.0, ry: 1.0, gap: 2.4 },
  scarfY: -8.6,
  scarfW: 8.4,
  drawTail(P, d, pose) {
    // spiky mantle over the back: the hedgehog's silhouette signature
    const k = pose.lie ? 0.75 : 1;
    const bx = d.body.cx - 0.8;
    const by = d.body.cy - 1.2;
    const pts: Pt[] = [];
    const n = 17;
    for (let i = 0; i <= n; i++) {
      const th = ((62 + (i / n) * 196) * Math.PI) / 180;
      const r0 = i % 2 ? 7.0 : 9.8;
      pts.push([bx + Math.cos(th) * r0, by - Math.sin(th) * r0 * k]);
    }
    pts.push([bx + 1, by + 2]);
    P.piece(pts, d.dark, { shadow: 1, rim: 0.5, wobble: 0.3 });
  },
  drawEars(P, d, _pose, back) {
    if (!back) P.piece(circle(d.head.cx - 0.6, d.head.cy - 3.3, 0.9, 8), d.light, { shadow: 0.4 });
  },
  drawFace(P, d, pose) {
    const { cx, cy } = d.head;
    const f = pose.front ? -1.6 : 0;
    // pointed snout
    P.piece([[cx + 1.2 + f, cy - 1.6], [cx + 6.2 + f, cy + 0.4], [cx + 1.6 + f, cy + 2.4]], d.light, { shadow: 0.4, wobble: 0.2 });
    P.piece(circle(cx + 6.1 + f, cy + 0.4, 0.8, 10), 'ink', { shadow: 0, wobble: 0 });
    eyes(P, pose.front ? [[cx - 1.2, cy - 0.8], [cx + 1.6, cy - 0.8]] : [[cx + 0.8, cy - 1.0], [cx + 2.8, cy - 1.2]], pose.eyes ?? 'open', 0.66);
    mouth(P, cx + 3.2 + f, cy + 1.9, pose.mouth, 1.2);
  },
};

export const SPECIES_DEFS: Record<Species, SpeciesDef> = {
  beaver: BEAVER,
  otter: OTTER,
  frog: FROG,
  hare: HARE,
  hedgehog: HEDGEHOG,
};

// ---------------------------------------------------------------- props drawing (in hand space: origin at the hand, +y along the arm)

function drawProp(P: Paper, id: PropId): void {
  switch (id) {
    case 'saw':
      P.piece(rect(-0.8, -1.2, 1.6, 2.6), 'wood', { shadow: 0.6, wobble: 0 });
      P.piece([[-0.9, 1.2], [1.3, 1.2], [1.0, 11], [-0.4, 11.6]], 'stoneLight', { shadow: 0.7, rim: 0.6, wobble: 0.2 });
      for (let i = 0; i < 6; i++) P.piece([[1.0, 2.4 + i * 1.5], [2.0, 3.0 + i * 1.5], [1.0, 3.6 + i * 1.5]], 'stoneDark', { shadow: 0, wobble: 0 });
      break;
    case 'hammer':
      P.line([[0, -1], [0, 6.5]], 0.75, 'wood', { shadow: 0.6 });
      P.piece(rect(-2.2, 5.6, 4.4, 2.2), 'stoneDark', { shadow: 0.8, rim: 0.6, wobble: 0 });
      break;
    case 'mallet':
      P.line([[0, -1], [0, 7.5]], 0.85, 'wood', { shadow: 0.6 });
      P.piece(roundRect(-2.6, 6.6, 5.2, 3.2, 0.6), 'woodDark', { shadow: 0.8, rim: 0.6, wobble: 0 });
      break;
    case 'scroll':
      P.piece(rect(-3.2, -0.4, 6.4, 4.2), 'cream', { shadow: 0.7, rim: 0.4, wobble: 0.2 });
      P.piece(roundRect(-3.6, -0.9, 7.2, 1.2, 0.6), 'woodLight', { shadow: 0.4, wobble: 0 });
      P.piece(roundRect(-3.6, 3.4, 7.2, 1.2, 0.6), 'woodLight', { shadow: 0.4, wobble: 0 });
      for (let i = 0; i < 3; i++) P.line([[-2.2, 0.9 + i * 0.9], [1.8, 0.9 + i * 0.9]], 0.25, 'ink', { shadow: 0, wobble: 0, alpha: 0.6 });
      break;
    case 'spyglass':
      P.piece(roundRect(-0.9, -1, 1.8, 6, 0.4), 'wood', { shadow: 0.6, wobble: 0 });
      P.piece(roundRect(-1.2, 4.6, 2.4, 3.4, 0.4), 'lampGlow', { shadow: 0.6, rim: 0.6, wobble: 0 });
      break;
    case 'whistle':
      P.piece(roundRect(-0.6, -0.8, 1.2, 3.4, 0.5), 'lampGlow', { shadow: 0.5, wobble: 0 });
      break;
    case 'broom':
      P.line([[0, -5], [0, 9]], 0.7, 'wood', { shadow: 0.6 });
      P.piece([[-1.0, 8.6], [1.0, 8.6], [2.6, 13.4], [-2.6, 13.4]], 'reedTip', { shadow: 0.8, rim: 0.5 });
      P.line([[-2.4, 10.4], [2.4, 10.4]], 0.35, 'woodDark', { shadow: 0, wobble: 0 });
      break;
    case 'can':
      P.piece(roundRect(-2.2, 0.4, 4.4, 3.8, 0.8), 'roofSlate', { shadow: 0.7, rim: 0.6, wobble: 0 });
      P.line([[2.0, 1.4], [5.0, -0.6]], 0.7, 'roofSlate', { shadow: 0.4 });
      P.line([[-1.6, 0.4], [0, -1.2], [1.6, 0.4]], 0.4, 'roofSlateDeep', { shadow: 0, wobble: 0 });
      break;
    case 'lantern':
      // a lantern hanging from the hand; the glow is added in the emissive pass
      P.line([[0, 0], [0, 1.6]], 0.25, 'ink', { shadow: 0, wobble: 0 });
      P.piece(roundRect(-1.5, 1.6, 3, 3.6, 0.6), 'lampGlow', { shadow: 0.6, wobble: 0 });
      P.piece(rect(-1.7, 1.3, 3.4, 0.7), 'woodDark', { shadow: 0, wobble: 0 });
      P.piece(rect(-1.7, 5.0, 3.4, 0.7), 'woodDark', { shadow: 0, wobble: 0 });
      break;
    case 'teacup':
      P.piece(roundRect(-1.6, -1.4, 3.2, 2.4, [0, 0, 1.2, 1.2]), 'cream', { shadow: 0.6, rim: 0.5, wobble: 0 });
      P.piece(rect(-1.6, -1.6, 3.2, 0.5), 'scarf1', { shadow: 0, wobble: 0 });
      break;
    case 'plank':
      P.piece(rect(-1, -7, 2, 14), 'woodLight', { shadow: 0.8, rim: 0.6, wobble: 0.3 });
      break;
    case 'sack':
      P.piece(roundRect(-3.6, -1, 7.2, 7.4, 2.6), mix(tok('reedTip'), tok('cream'), 0.45), { shadow: 1, rim: 0.7 });
      P.line([[-1.4, 0.2], [1.4, 0.2]], 0.5, 'woodDark', { shadow: 0, wobble: 0 });
      break;
    case 'roller':
      P.line([[0, -0.5], [0, 4.5]], 0.7, 'wood', { shadow: 0.6 });
      P.piece(roundRect(-3, 4.2, 6, 2.4, 1.1), 'ink', { shadow: 0.7, rim: 0.4, wobble: 0 });
      break;
    case 'basket':
      P.piece(roundRect(-3.2, 1, 6.4, 4, [0, 0, 1.6, 1.6]), 'reedTip', { shadow: 0.8, rim: 0.6 });
      P.line([[-2.8, 1.2], [0, -1.2], [2.8, 1.2]], 0.45, 'wood', { shadow: 0.4, wobble: 0 });
      for (const c of ['leafAmber', 'leafRust', 'scarf3'] as Token[]) P.dot(-1.6 + ['leafAmber', 'leafRust', 'scarf3'].indexOf(c) * 1.6, 0.6, 0.9, c, 0.3);
      break;
    case 'rope':
      P.line([[0, -1], [0, 16]], 0.85, mix(tok('reedTip'), tok('cream'), 0.3), { shadow: 0.3, wobble: 0 });
      break;
    default:
      break;
  }
}

/** State cues placed around the resident (cloud, zzz, check sign, ...). Local resident space. */
function drawExtra(P: Paper, d: SpeciesDef, e: NonNullable<Pose['extras']>[number], pose: Pose): void {
  const top = -d.h;
  switch (e) {
    case 'cloud': {
      // small worry rain cloud over the head (SPEC 4.3 error). It sits in the sky band even over short
      // species, and has a cream paper backing so it separates from dark hills and light sky alike.
      const cy = -Math.max(d.h + 7, 31);
      const cx = 0.6;
      const k = 1.15;
      const lobes = (grow: number) => [
        ellipse(cx, cy + 1 * k, 6.4 * k + grow, 2.3 * k + grow, 18),
        circle(cx - 2.2 * k, cy - 0.4 * k, 2.6 * k + grow, 14),
        circle(cx + 1.8 * k, cy - 1.0 * k, 3.1 * k + grow, 14),
      ];
      for (const l of lobes(0.9)) P.piece(l, 'cream', { shadow: 0.6, wobble: 0.3 });
      const [a, b, c] = lobes(0);
      P.piece(a, 'worrySlate', { shadow: 0.5, rim: 0.6 });
      P.piece(b, 'worrySlate', { shadow: 0.3, rim: 0.7 });
      P.piece(c, 'worrySlate', { shadow: 0.3, rim: 0.7 });
      for (const [x, y] of [[-3, 4.2], [0, 5.2], [3, 4.4]] as Pt[]) P.line([[cx + x * k, cy + y * k], [cx + x * k - 0.6, cy + y * k + 2.2]], 0.7, 'river', { shadow: 0, wobble: 0 });
      break;
    }
    case 'zzz': {
      const x0 = 4;
      const y0 = top - 1;
      const z = (x: number, y: number, s: number) =>
        P.piece(
          [
            [x, y],
            [x + s, y],
            [x + s, y + s * 0.28],
            [x + s * 0.32, y + s * 0.78],
            [x + s, y + s * 0.78],
            [x + s, y + s * 1.06],
            [x, y + s * 1.06],
            [x, y + s * 0.78],
            [x + s * 0.68, y + s * 0.28],
            [x, y + s * 0.28],
          ],
          'cream',
          { shadow: 0.9, wobble: 0.15 },
        );
      z(x0, y0 - 2, 2.6);
      z(x0 + 3.2, y0 - 6.2, 3.4);
      z(x0 + 7.4, y0 - 11.2, 4.2);
      break;
    }
    case 'check': {
      // small "your turn" sign on a stake beside the resident (SPEC 4.3)
      const x = d.id === 'hedgehog' ? -13 : -9.5;
      P.line([[x, 0], [x, -8]], 0.8, 'wood', { shadow: 0.7 });
      P.piece(roundRect(x - 3.6, -13.6, 7.2, 6.2, 0.9), 'yourTurnSage', { shadow: 1, rim: 0.7 });
      P.line([[x - 1.9, -10.6], [x - 0.5, -9.0], [x + 2.0, -12.2]], 0.95, 'ink', { shadow: 0, wobble: 0 });
      break;
    }
    case 'stone':
      P.piece(ellipse(8.5, -2.2, 3.6, 2.4, 16), 'stone', { shadow: 1, rim: 0.7 });
      P.line([[7.6, -4.4], [8.4, -2.4], [7.9, -0.8]], 0.3, 'stoneDark', { shadow: 0, wobble: 0 });
      break;
    case 'pile':
      for (let i = 0; i < 3; i++) P.piece(rect(-10.5 + i * 0.6, -1.2 - i * 1.2, 7, 1.1), i % 2 ? 'woodLight' : 'wood', { shadow: 0.7, rim: 0.4 });
      break;
    case 'press': {
      // a small type press block in front of the frog
      const x = 11.5;
      P.piece(rect(x - 3.4, -5.2, 6.8, 5.2), 'woodDark', { shadow: 1, rim: 0.6 });
      P.piece(rect(x - 2.8, -6.4, 5.6, 1.4), 'cream', { shadow: 0.6, wobble: 0 });
      P.line([[x - 2, -5.8], [x + 2, -5.8]], 0.3, 'ink', { shadow: 0, wobble: 0 });
      break;
    }
    case 'groundlantern':
      P.piece(roundRect(6.2, -4.6, 3, 3.6, 0.6), 'lampGlow', { shadow: 0.6, wobble: 0 });
      P.piece(rect(6, -4.9, 3.4, 0.7), 'woodDark', { shadow: 0, wobble: 0 });
      P.piece(rect(6, -1.2, 3.4, 0.7), 'woodDark', { shadow: 0, wobble: 0 });
      break;
    case 'question':
      break;
  }
  void pose;
}

// ---------------------------------------------------------------- the rig

const DEG = Math.PI / 180;

function egg(cx: number, cy: number, rx: number, ry: number, pear: number): Pt[] {
  const pts = ellipse(cx, cy, rx, ry, 28);
  return pts.map(([x, y]) => [cx + (x - cx) * (1 + pear * ((y - cy) / ry)), y]);
}

/** Hand position for an arm angle. */
function handAt(d: SpeciesDef, angle: number, sh: Pt): Pt {
  const a = angle * DEG;
  return [sh[0] + Math.sin(a) * d.arm.len, sh[1] + Math.cos(a) * d.arm.len];
}

function drawArm(P: Paper, d: SpeciesDef, angle: number, sh: Pt, fill: Fill, prop?: PropId, propAngle = 0, mirror = false): void {
  const a = (mirror ? -angle : angle) * DEG;
  P.at(sh[0], sh[1], -a, () => {
    P.piece(roundRect(-d.arm.w / 2, -d.arm.w / 2, d.arm.w, d.arm.len + d.arm.w / 2, d.arm.w / 2), fill, { shadow: 1.3, wobble: 0.25 });
    P.piece(circle(0, d.arm.len, d.arm.hand, 12), d.paw, { shadow: 0.8, wobble: 0.2 });
    if (prop && prop !== 'none') P.at(0, d.arm.len, propAngle * DEG, () => drawProp(P, prop));
  });
}

export type DrawMode = 'base' | 'scarf';

/**
 * Draw a resident in a pose. In 'scarf' mode only the visible scarf area is painted (white), with
 * everything in front of it erased, so the renderer can tint the overlay per instance.
 */
export function drawResident(P: Paper, species: Species, pose: Pose, mode: DrawMode = 'base'): void {
  const d = SPECIES_DEFS[species];
  const ctx = P.ctx;
  const steps: { scarf: boolean; fn: () => void }[] = [];
  const add = (fn: () => void, scarf = false) => steps.push({ scarf, fn });

  const lift = pose.lift ?? 0;
  const sitDrop = pose.sit ? (d.hip[1] + 1.2) * -1 * 0.6 : 0;
  const lean = (pose.lean ?? 0) * DEG;

  if (pose.lie) {
    drawLying(P, d, pose, mode);
    return;
  }

  // body transform: rotate about the hip, then lift
  const bodyAt = (fn: () => void) =>
    P.at(0, lift + sitDrop, 0, () => P.at(d.hip[0], d.hip[1], lean, () => P.at(-d.hip[0], -d.hip[1], 0, fn)));

  // extras behind (check sign stands behind)
  if (pose.extras?.includes('check')) add(() => drawExtra(P, d, 'check', pose));
  if (pose.extras?.includes('pile')) add(() => drawExtra(P, d, 'pile', pose));

  // back arm (front-facing poses put the shoulders either side and mirror the back arm)
  const backSh: Pt = pose.front ? [d.body.cx - d.body.rx * 0.62, d.shoulder[1] + 0.4] : [d.shoulder[0] - 1.2, d.shoulder[1] + 0.2];
  const foreSh: Pt = pose.front ? [d.body.cx + d.body.rx * 0.62, d.shoulder[1] + 0.4] : d.shoulder;
  add(() => bodyAt(() => drawArm(P, d, pose.back, backSh, d.dark, pose.propBack, 0, !!pose.front)));
  // back foot
  const feet = (fore: boolean) => {
    const step = fore ? pose.stepFore ?? 0 : pose.stepBack ?? 0;
    const up = fore ? pose.liftFore ?? 0 : pose.liftBack ?? 0;
    const gx = (fore ? d.foot.gap / 2 : -d.foot.gap / 2) + step;
    const fy = pose.sit ? -0.9 : -d.foot.ry - up + lift;
    const fx = pose.sit ? gx + 3.2 : gx;
    const col = fore ? tok(d.fur) : d.dark;
    P.at(0, sitDrop * 0.2, 0, () => {
      if (!pose.sit) P.line([[gx * 0.5, d.hip[1] + lift], [fx, fy]], d.foot.ry * 1.7, col, { shadow: 0.5 });
      P.piece(ellipse(fx + 0.8, fy, d.foot.rx, d.foot.ry, 14), col, { shadow: 0.8, wobble: 0.2 });
    });
  };
  // scarf tail flutters behind the neck (scarf layer)
  add(
    () =>
      bodyAt(() => {
        const [sx, sy] = [d.body.cx - d.scarfW * 0.32, d.scarfY + 0.6];
        P.piece(
          [
            [sx + 1, sy - 0.6],
            [sx - 1.6, sy + 3.6],
            [sx - 3.2, sy + 6.2],
            [sx - 1.4, sy + 6.6],
            [sx + 1.2, sy + 1.4],
          ],
          'cream',
          { shadow: 0.7, wobble: 0.3 },
        );
      }),
    true,
  );
  add(() => d.drawTail(P, d, pose));
  add(() => feet(false));
  add(() =>
    bodyAt(() => {
      P.piece(egg(d.body.cx, d.body.cy, d.body.rx, d.body.ry, d.body.pear), d.fur, { shadow: 1, rim: 0.8 });
      if (d.drawBodyExtra) d.drawBodyExtra(P, d, pose);
      else P.piece(ellipse(d.body.cx + 1.5, d.body.cy + 1.0, d.body.rx * 0.55, d.body.ry * 0.62, 18), d.light, { shadow: 0.3 });
    }),
  );
  add(() => feet(true));
  // head group
  const headAt = (fn: () => void) =>
    bodyAt(() => P.at(d.head.cx - 1, d.head.cy + d.head.ry * 0.8, (pose.headTilt ?? 0) * DEG, () => P.at(-(d.head.cx - 1), -(d.head.cy + d.head.ry * 0.8), 0, fn)));
  add(() => headAt(() => d.drawEars(P, d, pose, true)));
  // scarf wrap (in front of body, under the chin)
  add(
    () =>
      bodyAt(() => {
        P.piece(roundRect(d.body.cx - d.scarfW / 2, d.scarfY - 1.25, d.scarfW, 2.6, 1.2), 'cream', { shadow: 1, rim: 0.6, wobble: 0.3 });
        P.piece(roundRect(d.body.cx + d.scarfW * 0.12, d.scarfY, 2.2, 3.6, 0.8), 'cream', { shadow: 0.8, wobble: 0.3 });
      }),
    true,
  );
  add(() =>
    headAt(() => {
      const h = d.head;
      P.piece(ellipse(h.cx, h.cy, h.rx, h.ry, 26), d.fur, { shadow: 1, rim: 1 });
      d.drawEars(P, d, pose, false);
      d.drawFace(P, d, pose);
    }),
  );
  // front arm with prop
  add(() => bodyAt(() => drawArm(P, d, pose.fore, foreSh, shade(tok(d.fur), -0.035), pose.prop, pose.propAngle ?? 0)));
  // in front-facing poses the back arm is on the near side too: draw its hand again on top so both gestures read
  if (pose.front && pose.back > 100) add(() => bodyAt(() => drawArm(P, d, pose.back, backSh, shade(tok(d.fur), -0.07), pose.propBack, 0, true)));
  // extras in front
  for (const e of pose.extras ?? []) if (e !== 'check' && e !== 'pile') add(() => drawExtra(P, d, e, pose));

  runSteps(P, steps, mode, d.h);
  void ctx;
}

type Step = { scarf: boolean; fn: () => void };

/**
 * Base mode draws every step. Scarf mode draws nothing before the first scarf step (but runs it with
 * zero alpha so the wobble seeds stay in step with the base sprite), paints scarf steps white, and
 * erases every later step, leaving exactly the visible scarf pixels.
 */
function runSteps(P: Paper, steps: Step[], mode: DrawMode, h: number): void {
  const ctx = P.ctx;
  if (mode === 'base') {
    for (const s of steps) s.fn();
    P.grain(-24, -h - 20, 50, h + 24);
    return;
  }
  const prevFlat = P.flat;
  const prevGain = P.shadowGain;
  P.shadowGain = 0;
  let seen = false;
  for (const s of steps) {
    ctx.save();
    P.flat = WHITE;
    if (s.scarf) {
      seen = true;
      ctx.globalCompositeOperation = 'source-over';
    } else if (seen) ctx.globalCompositeOperation = 'destination-out';
    else ctx.globalAlpha = 0;
    s.fn();
    ctx.restore();
  }
  P.flat = prevFlat;
  P.shadowGain = prevGain;
  P.grain(-24, -h - 20, 50, h + 24);
}

const WHITE = PAL.maskWhite;

/** Lying asleep on its side (asleep state): a long low silhouette with closed eyes and zzz. */
function drawLying(P: Paper, d: SpeciesDef, pose: Pose, mode: DrawMode): void {
  const len = d.body.ry * 1.25;
  const hgt = d.body.rx * 0.95;
  const hx = len * 0.95;
  const hy = -d.head.ry * 0.95;
  const closed: Pose = { ...pose, eyes: 'closed', mouth: 'none' };
  const headAt = (fn: () => void) => P.at(hx - d.head.cx, hy - d.head.cy, 0.25, fn);
  const steps: Step[] = [
    { scarf: false, fn: () => P.at(1.5, 0, 0, () => d.drawTail(P, d, { ...pose, tail: 40 })) },
    {
      scarf: false,
      fn: () => {
        P.piece(ellipse(0, -hgt, len, hgt, 26), d.fur, { shadow: 1, rim: 0.8 });
        P.piece(ellipse(1, -hgt * 0.7, len * 0.7, hgt * 0.5, 20), d.light, { shadow: 0.3 });
      },
    },
    { scarf: false, fn: () => headAt(() => d.drawEars(P, d, closed, true)) },
    {
      scarf: true,
      fn: () => headAt(() => P.piece(roundRect(d.head.cx - d.scarfW / 2 - 2, d.head.cy + d.head.ry * 0.55, d.scarfW, 2.5, 1.1), 'cream', { shadow: 0.8 })),
    },
    {
      scarf: false,
      fn: () =>
        headAt(() => {
          P.piece(ellipse(d.head.cx, d.head.cy, d.head.rx, d.head.ry, 24), d.fur, { shadow: 1, rim: 1 });
          d.drawEars(P, d, closed, false);
          d.drawFace(P, d, closed);
        }),
    },
    { scarf: false, fn: () => { for (const e of pose.extras ?? []) drawExtra(P, { ...d, h: d.h * 0.55 }, e, pose); } },
  ];
  runSteps(P, steps, mode, d.h);
}


// ---------------------------------------------------------------- pose library

/** All named poses. Frames of a loop are separate entries (`saw-0`, `saw-1`). */
export function posesFor(species: Species): Record<string, Pose> {
  const sig = signature(species);
  return {
    'stand-0': { back: 8, fore: -6, eyes: 'open' },
    'stand-1': { back: 10, fore: -4, eyes: 'closed' },
    'walk-0': { back: -25, fore: 25, stepBack: -1.4, stepFore: 1.4, lift: -0.4 },
    'walk-1': { back: 25, fore: -25, stepBack: 1.2, stepFore: -1.2, liftFore: 0.8 },
    'run-0': { lean: 14, back: -50, fore: 60, stepBack: -2.6, stepFore: 2.8, lift: -1.2, liftBack: 1.4, eyes: 'wide', mouth: 'o' },
    'run-1': { lean: 16, back: 45, fore: -40, stepBack: 2.2, stepFore: -2.0, lift: -0.2, liftFore: 1.2, eyes: 'wide', mouth: 'o' },
    'run-2': { lean: 12, back: -20, fore: 20, stepBack: -0.8, stepFore: 0.8, lift: -1.8, liftBack: 0.8, liftFore: 0.8, eyes: 'wide', mouth: 'o' },
    // alert anticipation: freeze and turn to camera (SPEC 3.5)
    'turn-0': { front: true, back: 35, fore: 35, eyes: 'wide', mouth: 'o', lift: -0.6 },
    // needs_you: pulling the bell rope with one arm high, the other flung out
    'ring-0': { front: true, back: 118, fore: 158, prop: 'rope', propAngle: -10, eyes: 'wide', mouth: 'open', lean: -6 },
    'ring-1': { front: true, back: 96, fore: 140, prop: 'rope', propAngle: -30, eyes: 'wide', mouth: 'open', lean: -2, lift: -0.8 },
    // finished: hop and cheer
    'cheer-0': { front: true, back: 138, fore: 138, lift: -4.2, eyes: 'happy', mouth: 'open', liftBack: 0.6, liftFore: 0.6 },
    'cheer-1': { front: true, back: 120, fore: 125, lift: -1, eyes: 'happy', mouth: 'open' },
    // your_turn: sits by the door with a lit lantern and a check sign
    'sit-lantern-0': { sit: true, back: 20, fore: 95, prop: 'lantern', propAngle: 95, eyes: 'open', mouth: 'smile', extras: ['check'] },
    // error: head in hands under a small rain cloud
    'worried-0': { front: true, back: 158, fore: 158, headTilt: 12, lean: 4, eyes: 'worried', mouth: 'o', extras: ['cloud'] },
    'worried-1': { front: true, back: 150, fore: 162, headTilt: 6, lean: 2, eyes: 'worried', mouth: 'o', extras: ['cloud'] },
    // limited: sits with a teacup, dozing, zzz
    'tea-0': { sit: true, back: 30, fore: 62, prop: 'teacup', propAngle: 62, eyes: 'closed', headTilt: 10, extras: ['zzz'] },
    // idle: sweeping
    'sweep-0': { back: 70, fore: 40, prop: 'broom', propAngle: 20, lean: 10, headTilt: 10 },
    'sweep-1': { back: 50, fore: 20, prop: 'broom', propAngle: 5, lean: 6, headTilt: 12 },
    // idle: gardening with a watering can
    'garden-0': { back: 20, fore: 70, prop: 'can', propAngle: 70, lean: 6 },
    'garden-1': { back: 20, fore: 80, prop: 'can', propAngle: 110, lean: 10 },
    // idle evening: sits by the campfire
    'sit-0': { sit: true, back: 40, fore: 50, eyes: 'open', mouth: 'smile' },
    // asleep: lying down
    'sleep-0': { lie: true, back: 0, fore: 0, eyes: 'closed', extras: ['zzz'] },
    // starting: stretch and yawn
    'stretch-0': { front: true, back: 172, fore: 172, eyes: 'closed', mouth: 'o', lift: -0.6 },
    // activity variants from the tool name (SPEC 4.2)
    'hammer-0': { lean: 10, back: 30, fore: 165, prop: 'hammer', propAngle: 0 },
    'hammer-1': { lean: 16, back: 30, fore: 85, prop: 'hammer', propAngle: 10 },
    'saw-0': { lean: 14, back: 70, fore: 95, prop: 'saw', propAngle: -10, extras: ['pile'] },
    'saw-1': { lean: 18, back: 80, fore: 75, prop: 'saw', propAngle: 0, extras: ['pile'] },
    'read-0': { back: 85, fore: 95, prop: 'scroll', propAngle: 95, headTilt: 12 },
    'spyglass-0': { back: 20, fore: 120, prop: 'spyglass', propAngle: 30, lean: -4 },
    'whistle-0': { front: true, back: 90, fore: 150, prop: 'whistle', propAngle: 150, eyes: 'closed', lift: -0.6 },
    'carry-0': { back: 170, fore: 170, prop: 'plank', propAngle: 90, stepBack: -1, stepFore: 1 },
    'carry-1': { back: 170, fore: 170, prop: 'plank', propAngle: 90, stepBack: 1, stepFore: -1, lift: -0.5 },
    // the species' signature work loop (SPEC 4.2)
    'work-0': sig[0],
    'work-1': sig[1],
  };
}

function signature(species: Species): [Pose, Pose] {
  switch (species) {
    case 'beaver': // sawing planks
      return [
        { lean: 14, back: 70, fore: 95, prop: 'saw', propAngle: -10, extras: ['pile'] },
        { lean: 18, back: 80, fore: 75, prop: 'saw', propAngle: 0, extras: ['pile'] },
      ];
    case 'otter': // cracking stones with a mallet
      return [
        { lean: -4, back: 150, fore: 175, prop: 'mallet', propAngle: 0, extras: ['stone'] },
        { lean: 20, back: 70, fore: 80, prop: 'mallet', propAngle: 20, extras: ['stone'] },
      ];
    case 'frog': // inking a press with a roller
      return [
        { lean: 12, back: 60, fore: 105, prop: 'roller', propAngle: 55, extras: ['press'] },
        { lean: 18, back: 70, fore: 85, prop: 'roller', propAngle: 45, extras: ['press'] },
      ];
    case 'hare': // hauling sacks
      return [
        { lean: 16, back: 165, fore: 150, propBack: 'sack', prop: 'none', stepBack: -1.2, stepFore: 1.2 },
        { lean: 18, back: 165, fore: 150, propBack: 'sack', prop: 'none', stepBack: 1.2, stepFore: -1.2, lift: -0.6 },
      ];
    default: // hedgehog: carrying a basket
      return [
        { back: 70, fore: 70, prop: 'basket', propAngle: 70, stepBack: -1, stepFore: 1 },
        { back: 70, fore: 70, prop: 'basket', propAngle: 70, stepBack: 1, stepFore: -1, lift: -0.5 },
      ];
  }
}

/** The pose key each state shows (frame 0), used by the silhouette test and the gallery. */
export const STATE_POSE_KEY: Record<StatePose, string> = {
  working: 'work-0',
  needs_you: 'ring-0',
  your_turn: 'sit-lantern-0',
  error: 'worried-0',
  limited: 'tea-0',
  idle: 'sweep-0',
  celebrating: 'cheer-0',
  asleep: 'sleep-0',
};

/** Bounds of a resident sprite in local units (generous, includes props and cues). */
export function residentBounds(species: Species): { x0: number; y0: number; x1: number; y1: number } {
  const h = SPECIES_DEFS[species].h;
  return { x0: -20, y0: -h - 18, x1: 22, y1: 2 };
}

/** Convenience for tests: draw a state pose into a bare 2D context at the given scale. */
export function drawPose(ctx: Ctx2D, species: Species, pose: string, scale = 1, flat: string | null = null): void {
  const P = new Paper(ctx, scale, 101);
  P.flat = flat;
  const key = (STATE_POSE_KEY as Record<string, string>)[pose] ?? pose;
  drawResident(P, species, posesFor(species)[key]);
}
