/**
 * Structures (SPEC 4.1, 4.5): the 12 buildable structures, the per-species workshops, and the
 * free Commons pieces (campfire, tent, bell post). Each draws at 3 growth stages.
 * Origin: bottom-centre on the ground (y = 0), up is -y, units are strip units.
 */
import { Paper, type Pt, rect, roundRect, ellipse, blob } from './paper.ts';
import { tok, mix } from './color.ts';
import { rng, range, hash } from './rng.ts';
import {
  type DrawOpts,
  wallBlock,
  beams,
  plinth,
  gableRoof,
  windowPane,
  litWindow,
  door,
  chimney,
  footing,
  plankPile,
  scaffold,
  frame,
  signboard,
  snowOn,
} from './kit.ts';

export type StructureKind =
  | 'noticeboard'
  | 'sawmill'
  | 'stoneyard'
  | 'printshop'
  | 'windmill'
  | 'well'
  | 'cottage'
  | 'garden'
  | 'footbridge'
  | 'jetty'
  | 'watermill'
  | 'guesthouse'
  | 'belltower'
  | 'bakery'
  | 'markethall'
  | 'campfire'
  | 'tent'
  | 'bellpost'
  | 'founders'
  | 'plot';

export type Stage = 1 | 2 | 3;

export interface Points {
  chimney?: Pt;
  door?: Pt;
  /** where the resident stands to work */
  work?: Pt;
  /** where the alert flag hangs (pole top) */
  flag?: Pt;
  /** where the bell hangs */
  bell?: Pt;
  /** pivot of a rotating part */
  pivot?: Pt;
}

export interface StructureDef {
  kind: StructureKind;
  name: string;
  /** footprint width (units) */
  w: number;
  /** height at stage 3 (units above ground, excluding rotating parts) */
  h: number;
  stages: 1 | 3;
  /** variant count (e.g. cottage roof colours) */
  variants?: number;
  draw(P: Paper, stage: Stage, o: DrawOpts & { variant?: number }): void;
  /** emissive parts (lit windows, lamps); drawn after lighting with alpha = sky.lamps */
  lit?(P: Paper, stage: Stage, o: DrawOpts & { variant?: number }): void;
  /** a rotating part (windmill sails, waterwheel) drawn as its own sprite around (0,0) */
  part?: { r: number; draw(P: Paper, o: DrawOpts): void };
  /**
   * Optional creek cut through the holm bank under this structure (footbridge, watermill race),
   * x range relative to the structure origin. The terrain renders water in the cut.
   */
  creek?: { x0: number; x1: number };
  /** zone in the authored map (SPEC 4.1) */
  zone?: 'commons' | 'workshops' | 'river' | 'orchard';
  points(stage: Stage): Points;
}

// ---------------------------------------------------------------- cottage

const cottage: StructureDef = {
  kind: 'cottage',
  name: 'Cottage',
  w: 40,
  h: 44,
  stages: 3,
  variants: 2,
  draw(P, stage, o) {
    const w = 34;
    const wallH = 19;
    const roofH = 17;
    if (stage === 1) {
      footing(P, w, o.seed);
      return;
    }
    if (stage === 2) {
      frame(P, w, wallH, roofH, 0.5);
      scaffold(P, w / 2 + 2, w / 2 + 6, -wallH - 4);
      plankPile(P, -w / 2 - 4, 0, 3, 9);
      return;
    }
    const thatch = (o.variant ?? 0) % 2 === 1;
    chimney(P, w * 0.2, -wallH - roofH + 1, 4, 10, o.season);
    wallBlock(P, -w / 2, -wallH, w, wallH);
    beams(P, -w / 2, -wallH, w, wallH);
    plinth(P, -w / 2, w);
    gableRoof(P, 0, -wallH + 1, w + 7, roofH, thatch ? 'roofThatch' : 'roof', thatch ? 'roofThatchDeep' : 'roofDeep', o.season);
    door(P, -3, -12.5, 6, 12.5);
    windowPane(P, -w / 2 + 4.5, -14, 5.5, 5.5);
    windowPane(P, w / 2 - 10, -14, 5.5, 5.5);
    // flower box and a lantern hook by the door
    P.piece(rect(w / 2 - 10.8, -7.4, 7.2, 1.6), 'wood', { shadow: 0.7 });
    for (let i = 0; i < 4; i++) P.dot(w / 2 - 10 + i * 1.8, -8, 0.75, i % 2 ? 'scarf0' : 'scarf2', 0.4);
    P.grain(-w / 2 - 6, -wallH - roofH - 12, w + 12, wallH + roofH + 14);
  },
  lit(P, stage) {
    if (stage < 3) return;
    const w = 34;
    litWindow(P, -w / 2 + 4.5, -14, 5.5, 5.5);
    litWindow(P, w / 2 - 10, -14, 5.5, 5.5);
  },
  points(stage) {
    return { chimney: stage === 3 ? [8.8, -46] : undefined, door: [0, 0], work: [-22, 0] };
  },
};

// ---------------------------------------------------------------- sawmill (Claude Code: beaver)

const sawmill: StructureDef = {
  kind: 'sawmill',
  name: 'Sawmill',
  w: 64,
  h: 46,
  stages: 3,
  draw(P, stage, o) {
    const w = 46;
    const wallH = 20;
    const roofH = 15;
    if (stage === 1) {
      footing(P, w, o.seed);
      plankPile(P, -w / 2 + 2, 0, 3, 10);
      return;
    }
    if (stage === 2) {
      frame(P, w, wallH, roofH, 0.35);
      scaffold(P, -w / 2 - 6, -w / 2 - 2, -wallH - 4);
      sawhorse(P, w / 2 + 8);
      return;
    }
    // open-sided shed: dark interior, posts, a big saw blade, log stack, sawhorse outside
    P.piece(rect(-w / 2, -wallH, w, wallH), mix(tok('woodDark'), tok('ink'), 0.25), { shadow: 1, rim: 0.4 });
    // the blade inside
    P.piece(ellipse(-4, -9, 6.5, 6.5, 32), 'stoneLight', { shadow: 0.8, rim: 1 });
    const teeth: Pt[] = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const rr = i % 2 ? 6.4 : 7.4;
      teeth.push([-4 + Math.cos(a) * rr, -9 + Math.sin(a) * rr]);
    }
    P.piece(teeth, 'stone', { shadow: 0.4, wobble: 0 });
    P.dot(-4, -9, 1.4, 'woodDark');
    P.piece(rect(-w / 2 + 2, -4, w - 4, 2.5), 'wood', { shadow: 0.9, rim: 0.6 });
    for (const x of [-w / 2, -w / 6, w / 6, w / 2 - 2]) P.piece(rect(x, -wallH, 2, wallH), 'wood', { shadow: 0.9, rim: 0.5 });
    gableRoof(P, 0, -wallH + 1, w + 8, roofH, 'roof', 'roofDeep', o.season);
    // log stack at the left
    for (let row = 0; row < 3; row++)
      for (let i = 0; i < 3 - row; i++) {
        const cx = -w / 2 - 6 + i * 4 + row * 2;
        const cy = -2 - row * 3.6;
        P.piece(ellipse(cx, cy, 1.9, 1.9, 14), 'wood', { shadow: 0.9, rim: 0.4 });
        P.piece(ellipse(cx, cy, 1.2, 1.2, 12), 'woodLight', { shadow: 0, wobble: 0.2 });
      }
    sawhorse(P, w / 2 + 8);
    plankPile(P, w / 2 + 8, -5.5, 2, 9);
    signboard(P, 0, -wallH - 2.5, 10, 4.2, '');
    P.grain(-w / 2 - 12, -wallH - roofH - 4, w + 30, wallH + roofH + 6);
  },
  points(stage) {
    return { work: [32, 0], chimney: undefined, door: [0, 0], pivot: stage === 3 ? [-4, -9] : undefined };
  },
};

function sawhorse(P: Paper, x: number): void {
  P.line([[x - 4, 0], [x - 2, -5]], 0.8, 'woodDark', { shadow: 0.6 });
  P.line([[x + 4, 0], [x + 2, -5]], 0.8, 'woodDark', { shadow: 0.6 });
  P.piece(rect(x - 5, -5.6, 10, 1.3), 'wood', { shadow: 0.8, rim: 0.5 });
}

// ---------------------------------------------------------------- commons: campfire, tent, bell post

const campfire: StructureDef = {
  kind: 'campfire',
  name: 'Campfire',
  w: 14,
  h: 8,
  stages: 1,
  draw(P, _s, o) {
    const r = rng(o.seed);
    for (let i = 0; i < 7; i++) {
      const a = Math.PI + (i / 6) * Math.PI;
      P.piece(ellipse(Math.cos(a) * 5.2, -0.8 + Math.sin(a) * 0.9, 1.5, 1.1, 10), i % 2 ? 'stone' : 'stoneDark', { shadow: 0.8, rim: 0.6 });
    }
    P.line([[-4, -0.6], [3.5, -3.2]], 1.2, 'wood', { shadow: 0.8 });
    P.line([[4, -0.6], [-3.4, -3.4]], 1.2, 'woodDark', { shadow: 0.8 });
    // log benches either side
    for (const x of [-11, 11]) P.piece(roundRect(x - 3.5, -2.6, 7, 2.6, 1.2), 'wood', { shadow: 1, rim: 0.7 });
    void r;
    if (o.season === 'winter') snowOn(P, [[-14.5, -2.6], [-7.5, -2.6]], 0.8);
  },
  lit(P, _s, o) {
    // the fire itself is always emissive (flames), frame flickers
    const f = o.frame ?? 0;
    P.glow(0, -4, 14, 'lampGlow', 0.5);
    const flick = [0, 0.7, -0.5, 0.3][f % 4];
    P.piece([[-3, -1.2], [-1.6 + flick * 0.3, -6.5], [0, -4.4], [0.6 + flick, -9], [2.2, -4.2], [3, -1.2]], 'flame', { shadow: 0, wobble: 0.6 });
    P.piece([[-1.6, -1.2], [-0.6, -4.5], [0.4 + flick * 0.5, -6.4], [1.7, -1.2]], 'lampGlow', { shadow: 0, wobble: 0.4 });
  },
  points() {
    return { work: [-11, 0] };
  },
};

const tent: StructureDef = {
  kind: 'tent',
  name: 'Tent',
  w: 26,
  h: 18,
  stages: 1,
  draw(P, _s, o) {
    P.piece([[-12, 0], [0, -17], [12, 0]], 'scarf2', { shadow: 1.2, rim: 1 });
    P.piece([[-12, 0], [0, -17], [-5, 0]], mix(tok('scarf2'), tok('wood'), 0.3), { shadow: 0.6 });
    P.piece([[-3.5, 0], [0, -9], [3.5, 0]], mix(tok('ink'), tok('woodDark'), 0.5), { shadow: 0.5, wobble: 0.3 });
    P.line([[0, -17], [0.4, -20]], 0.6, 'woodDark', { shadow: 0.5 });
    P.line([[-12, 0], [-15, 0.5]], 0.25, 'woodDark', { shadow: 0 });
    P.line([[12, 0], [15, 0.5]], 0.25, 'woodDark', { shadow: 0 });
    if (o.season === 'winter') snowOn(P, [[-6, -8.5], [0, -17], [6, -8.5]], 1.2);
    P.grain(-15, -21, 30, 22);
  },
  points() {
    return { door: [0, 0], work: [16, 0] };
  },
};

/** Bell post: pole with yoke. The flag and bell are separate emissive sprites (see alert sprites). */
const bellpost: StructureDef = {
  kind: 'bellpost',
  name: 'Bell post',
  w: 12,
  h: 64,
  stages: 1,
  draw(P, _s, o) {
    P.piece(rect(-3, -3, 6, 3.4), 'stoneDark', { shadow: 1, rim: 0.7 });
    P.piece(rect(-1, -64.5, 2, 62), 'wood', { shadow: 1.1, rim: 0.6, wobble: 0.3 });
    P.dot(0, -64.8, 1.3, 'woodDark', 0.8);
    // yoke arm for the bell
    P.piece(rect(-0.5, -50.6, 7.5, 1.4), 'woodDark', { shadow: 0.9, wobble: 0.2 });
    P.line([[1, -44], [4.5, -50]], 0.7, 'woodDark', { shadow: 0.5 });
    // cleat for the halyard
    P.piece(rect(-2.2, -14, 1.4, 3), 'woodDark', { shadow: 0.6, wobble: 0 });
    if (o.season === 'winter') snowOn(P, [[-3, -3], [3, -3]], 0.8);
  },
  points() {
    return { flag: [1, -64], bell: [6, -50], work: [-5, 0] };
  },
};

// ---------------------------------------------------------------- founders' stone and build plot

/** The Founders' Stone (history backfill, SPEC 4.5): a standing stone engraved with counts. */
const founders: StructureDef = {
  kind: 'founders',
  name: "Founders' stone",
  w: 16,
  h: 22,
  stages: 1,
  zone: 'commons',
  draw(P, _s, o) {
    P.piece(rect(-7.5, -2.2, 15, 2.6), 'stoneDark', { shadow: 1, rim: 0.6 });
    P.piece([[-5.6, -2], [-6.2, -15], [-3.6, -20.5], [1.8, -21.6], [5.6, -18], [6.2, -2]], 'stone', { shadow: 1.2, rim: 1.2 });
    P.piece([[-5.6, -2], [-6.2, -15], [-4.6, -17.8], [-3.4, -3]], 'stoneDark', { shadow: 0, alpha: 0.55 });
    for (let i = 0; i < 3; i++) P.line([[-2.6, -15.5 + i * 3.6], [3.4, -15.8 + i * 3.6]], 0.45, 'stoneDark', { shadow: 0, wobble: 0.3 });
    P.text('1', 0.4, -6.2, 4.6, 'stoneDark', 700);
    // moss at the foot
    P.piece(blob(-4.6, -1.4, 3, 1.3, 7, 5, 0.4, true), o.season === 'winter' ? 'snow' : 'meadowLight', { shadow: 0.6 });
    if (o.season === 'winter') snowOn(P, [[-3.6, -20.5], [1.8, -21.6], [5.6, -18]], 1.2);
    P.grain(-9, -24, 18, 26);
  },
  points() {
    return { work: [-10, 0] };
  },
};

/** A staked build plot: where the next queued structure will go (stage 0, status building). */
const plot: StructureDef = {
  kind: 'plot',
  name: 'Build plot',
  w: 30,
  h: 12,
  stages: 1,
  draw(P) {
    for (const x of [-13, 13]) P.line([[x, 0.5], [x + 0.2, -6]], 0.7, 'woodLight', { shadow: 0.7 });
    P.line([[-13, -4.6], [13, -4.4]], 0.28, 'cream', { shadow: 0.3, alpha: 0.9 });
    P.line([[11, 0.5], [11.2, -11]], 0.5, 'wood', { shadow: 0.6 });
    P.piece([[11.4, -11], [16, -9.6], [11.4, -8]], 'scarf2', { shadow: 0.6, wobble: 0 });
    P.grain(-15, -12, 32, 13);
  },
  points() {
    return { work: [-16, 0] };
  },
};

// ---------------------------------------------------------------- registry

import { STRUCTURES_A } from './structures-a.ts';
import { STRUCTURES_B } from './structures-b.ts';

export const STRUCTURES: Partial<Record<StructureKind, StructureDef>> = {
  cottage,
  sawmill,
  campfire,
  tent,
  bellpost,
  founders,
  plot,
};
for (const def of [...STRUCTURES_A, ...STRUCTURES_B]) STRUCTURES[def.kind] = def;

export { hash, range, blob, roundRect, snowOn };
