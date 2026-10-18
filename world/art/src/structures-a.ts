/** Structures batch A (drawn by a helper agent to the kit house rules; see kit.ts and structures.ts). */
import type { StructureDef } from './structures.ts';
import { Paper, type Pt, rect, roundRect, ellipse } from './paper.ts';
import { tok, mix } from './color.ts';
import { rng, range } from './rng.ts';
import {
  beams,
  plinth,
  gableRoof,
  windowPane,
  litWindow,
  door,
  chimney,
  footing,
  plankPile,
  stonePile,
  scaffold,
  frame,
  signboard,
  snowOn,
  wallBlock,
} from './kit.ts';

// ---------------------------------------------------------------- shared little helpers

/** A hanging lantern body (dim paper version; the lit pass paints the glow). */
function lantern(P: Paper, x: number, y: number): void {
  P.line([[x, y - 1.8], [x, y]], 0.3, 'woodDark', { shadow: 0 });
  P.piece(rect(x - 1.5, y, 3, 0.8), 'woodDark', { shadow: 0.5, wobble: 0 });
  P.piece(rect(x - 1.1, y + 0.8, 2.2, 2.6), mix(tok('lampGlow'), tok('woodDark'), 0.55), { shadow: 0.3, wobble: 0 });
  P.piece(rect(x - 1.5, y + 3.4, 3, 0.7), 'woodDark', { shadow: 0.5, wobble: 0 });
}

function lanternLit(P: Paper, x: number, y: number): void {
  P.glow(x, y + 2.1, 8, 'lampGlow', 0.55);
  P.piece(rect(x - 1.1, y + 0.8, 2.2, 2.6), 'lampGlow', { shadow: 0, wobble: 0 });
}

/** Low dry-stone wall: staggered courses of mixed stone. */
function dryWall(P: Paper, x0: number, x1: number, h: number, seed: number, winter: boolean): void {
  P.piece(rect(x0, -h, x1 - x0, h + 0.4), 'stoneDark', { shadow: 1, rim: 0.7 });
  const r = rng(seed);
  const rows = Math.max(1, Math.round(h / 2.7));
  const rh = h / rows;
  for (let i = 0; i < rows; i++) {
    const y = -h + i * rh;
    let x = x0 + (i % 2 ? -range(r, 1, 2.4) : 0);
    while (x < x1) {
      const sw = range(r, 3, 5.2);
      const a = Math.max(x, x0);
      const b = Math.min(x + sw, x1);
      if (b - a > 0.9) {
        P.piece(roundRect(a + 0.25, y + 0.25, b - a - 0.5, rh - 0.5, 0.9), mix(tok('stone'), tok('stoneLight'), r()), {
          shadow: 0.6,
          wobble: 0.7,
          rim: i === 0 ? 0.6 : 0,
        });
      }
      x += sw;
    }
  }
  if (winter) snowOn(P, [[x0, -h], [(x0 + x1) / 2, -h], [x1, -h]], 1.3);
}

/** A stuck stake with a bit of string tied around it. */
function stake(P: Paper, x: number, top: number): void {
  P.line([[x, 0.4], [x + 0.2, top]], 0.9, 'woodLight', { shadow: 0.7 });
}

// ---------------------------------------------------------------- noticeboard (commons)

const noticeboard: StructureDef = {
  kind: 'noticeboard',
  name: 'Notice board',
  w: 22,
  h: 24,
  stages: 3,
  zone: 'commons',
  draw(P, stage, o) {
    const px = 8.5;
    if (stage === 1) {
      for (const x of [-px, px]) {
        P.piece(ellipse(x, 0.2, 3, 1.1, 12), 'soil', { shadow: 0.6 });
        P.line([[x, 0.4], [x + 0.15, -9.5]], 1.7, 'wood', { shadow: 0.9, rim: 0.5 });
        P.piece(ellipse(x + 2, -0.2, 1.2, 0.8, 8), 'stone', { shadow: 0.6, rim: 0.5 });
      }
      P.line([[-px, -4.5], [px, -4.3]], 0.3, 'cream', { shadow: 0.3, alpha: 0.9 });
      plankPile(P, 1, 0, 2, 12);
      P.grain(-13, -12, 26, 14);
      return;
    }
    // posts
    for (const x of [-px, px]) {
      P.piece(rect(x - 0.9, -20.5, 1.8, 20.9), 'wood', { shadow: 0.9, rim: 0.5, wobble: 0.35 });
      P.piece(ellipse(x + 1.9, -0.2, 1.2, 0.8, 8), 'stone', { shadow: 0.6, rim: 0.5 });
      P.piece(ellipse(x - 1.7, -0.1, 0.9, 0.6, 8), 'stoneDark', { shadow: 0.6 });
    }
    if (stage === 2) {
      P.piece(rect(-10, -20, 20, 11), mix(tok('wood'), tok('woodDark'), 0.3), { shadow: 0.8, rim: 0.4 });
      beams(P, -10, -20, 20, 11, 'woodLight');
      P.line([[-10, -9], [-3, -20]], 0.8, 'woodLight', { shadow: 0.6 });
      P.line([[10, -9], [3, -20]], 0.8, 'woodLight', { shadow: 0.6 });
      // bare rafters of the little cap
      P.line([[-12.3, -19.6], [0, -24]], 1, 'wood', { shadow: 0.8 });
      P.line([[12.3, -19.6], [0, -24]], 1, 'wood', { shadow: 0.8 });
      P.line([[-6, -21.8], [6, -21.8]], 0.7, 'woodLight', { shadow: 0.6 });
      plankPile(P, -16, 0, 2, 7);
      P.grain(-18, -26, 36, 28);
      return;
    }
    // the board itself
    P.piece(rect(-10, -20, 20, 11), 'woodLight', { shadow: 1.1, rim: 1 });
    for (const x of [-5, 0, 5]) P.line([[x, -19.5], [x, -9.5]], 0.3, 'wood', { shadow: 0, alpha: 0.4 });
    beams(P, -10, -20, 20, 11, 'wood');
    // notes: cream, a couple tinted with scarf colours
    const notes: { x: number; y: number; w: number; h: number; rot: number; fill: ReturnType<typeof mix> | 'cream' }[] = [
      { x: -8.6, y: -18.7, w: 5, h: 6.2, rot: -0.07, fill: 'cream' },
      { x: -2.8, y: -18.8, w: 4.4, h: 5.2, rot: 0.05, fill: mix(tok('cream'), tok('scarf2'), 0.6) },
      { x: 2.3, y: -18.6, w: 5.4, h: 4.2, rot: -0.04, fill: 'cream' },
      { x: -7.2, y: -11.7, w: 4.2, h: 2.6, rot: 0.08, fill: mix(tok('cream'), tok('scarf3'), 0.55) },
      { x: -1.2, y: -13.3, w: 4.6, h: 3.5, rot: -0.05, fill: 'cream' },
      { x: 4.4, y: -13.4, w: 4.2, h: 3.3, rot: 0.07, fill: mix(tok('cream'), tok('scarf0'), 0.45) },
    ];
    for (const n of notes) {
      P.at(n.x + n.w / 2, n.y + n.h / 2, n.rot, () => {
        P.piece(rect(-n.w / 2, -n.h / 2, n.w, n.h), n.fill, { shadow: 0.9, wobble: 0.5 });
        for (let i = 0; i < 2 + Math.floor(n.h / 3.2); i++) {
          const lw = n.w - 1.6 - (i % 2) * 1.1;
          P.line([[-n.w / 2 + 0.8, -n.h / 2 + 2.1 + i * 1.15], [-n.w / 2 + 0.8 + lw, -n.h / 2 + 2.1 + i * 1.15]], 0.25, 'ink', { shadow: 0, alpha: 0.5 });
        }
        P.dot(0, -n.h / 2 + 0.7, 0.5, i3(n.x));
      });
    }
    // little hanging signboard under the board
    signboard(P, 0, -8.2, 9.5, 3.6, '');
    P.line([[-3, -6.4], [3, -6.4]], 0.4, 'ink', { shadow: 0, alpha: 0.65 });
    P.dot(-3.9, -6.4, 0.35, 'ink');
    // the cap
    gableRoof(P, 0, -19.6, 25, 4.6, 'roof', 'roofDeep', o.season);
    P.grain(-14, -26, 28, 28);
  },
  points() {
    return { door: [0, 0], work: [-14, 0] };
  },
};

function i3(x: number) {
  const pins = ['scarf0', 'scarf1', 'scarf4'] as const;
  return pins[Math.abs(Math.round(x)) % 3];
}

// ---------------------------------------------------------------- stoneyard (workshops, otter)

/** Tripod crane: two outer legs, a back leg, tie rope; optional hanging block. */
function crane(P: Paper, withBlock: boolean): void {
  const ax = -13;
  const ay = -34;
  P.line([[ax + 0.5, ay], [-12, 0]], 1.1, 'woodDark', { shadow: 0.6 });
  P.line([[-21, 0], [ax, ay]], 1.5, 'wood', { shadow: 0.9, rim: 0.4 });
  P.line([[-5, 0], [ax, ay]], 1.5, 'wood', { shadow: 0.9, rim: 0.4 });
  // tie across the legs
  const tl = -21 + 8 * (23 / 34);
  const tr = -5 - 8 * (23 / 34);
  P.line([[tl, -23], [tr, -23]], 0.9, 'woodLight', { shadow: 0.7 });
  // lashing
  P.dot(ax, ay + 0.6, 1.5, 'woodDark', 0.7);
  P.dot(ax, ay + 0.6, 0.6, 'roofThatch');
  P.line([[ax, ay + 1], [ax, withBlock ? -17.6 : -19]], 0.4, 'roofThatch', { shadow: 0.2 });
  if (withBlock) {
    P.line([[ax, -17.6], [-15.8, -13.4]], 0.3, 'roofThatch', { shadow: 0 });
    P.line([[ax, -17.6], [-10.2, -13.4]], 0.3, 'roofThatch', { shadow: 0 });
    P.dot(ax, -17.8, 0.8, 'stoneDark', 0.5);
    P.piece(rect(-16.2, -13.6, 6.4, 5.4), 'stoneLight', { shadow: 1, rim: 0.8 });
    P.piece(rect(-16.2, -10.2, 6.4, 2), 'stone', { shadow: 0, alpha: 0.6, wobble: 0.4 });
    P.line([[-14.8, -12.2], [-13.4, -11.4], [-12.4, -12.4]], 0.25, 'stoneDark', { shadow: 0, alpha: 0.6 });
  } else {
    P.dot(ax, -19.4, 0.9, 'stoneDark', 0.5);
  }
}

function bigStone(P: Paper, cx: number): void {
  const pts: Pt[] = [[-4.7, 0.3], [-5.2, -2.8], [-3.2, -6.2], [0.8, -7.8], [4.4, -6.2], [5.4, -2.6], [4.8, 0.3]];
  P.piece(pts.map(([x, y]) => [cx + x, y] as Pt), mix(tok('stone'), tok('stoneDark'), 0.3), { shadow: 1.1, rim: 0.9 });
  P.piece([[cx - 3.3, -5.8], [cx + 0.8, -7.3], [cx + 1.6, -4.4], [cx - 3.8, -3.4]], 'stoneLight', { shadow: 0, alpha: 0.5, wobble: 0.5 });
  // the crack the otter is working on
  P.line([[cx + 0.8, -7.6], [cx + 1.9, -5], [cx + 0.9, -3.6], [cx + 1.8, -0.4]], 0.35, 'ink', { shadow: 0, alpha: 0.55 });
}

const slateY = (x: number) => -13.5 - (7.7 * (x - 7)) / 25;

const stoneyard: StructureDef = {
  kind: 'stoneyard',
  name: 'Stoneyard',
  w: 62,
  h: 36,
  stages: 3,
  zone: 'workshops',
  draw(P, stage, o) {
    const winter = o.season === 'winter';
    if (stage === 1) {
      for (const x of [-28, -10, 10, 28]) stake(P, x, -7.5);
      P.line([[-28, -6.6], [-10, -6.2], [10, -6.4], [28, -6.6]], 0.3, 'cream', { shadow: 0.3, alpha: 0.9 });
      bigStone(P, -1);
      stonePile(P, 17, 0, 6, o.seed);
      P.piece(ellipse(-20, -0.9, 2.2, 1.4, 12), 'stone', { shadow: 0.8, rim: 0.6 });
      P.piece(ellipse(-23.5, -0.7, 1.6, 1.0, 10), 'stoneLight', { shadow: 0.8, rim: 0.6 });
      P.grain(-31, -9, 62, 11);
      return;
    }
    if (stage === 2) {
      dryWall(P, -31, -9, 3.2, o.seed + 3, winter);
      crane(P, false);
      bigStone(P, 4);
      // half-built shed: two posts and one rafter
      P.line([[10, 0], [10, slateY(10) + 1]], 1.6, 'woodLight', { shadow: 0.9 });
      P.line([[29, 0], [29, slateY(29) + 1]], 1.6, 'woodLight', { shadow: 0.9 });
      P.line([[7, slateY(7) + 1.4], [31, slateY(31) + 1.4]], 1.3, 'wood', { shadow: 0.9 });
      stonePile(P, 19, 0, 6, o.seed);
      P.grain(-31, -36, 63, 38);
      return;
    }
    // stage 3
    dryWall(P, -31, -9, 5.6, o.seed + 3, winter);
    crane(P, true);
    bigStone(P, 4);
    // chips on the ground
    for (const [x, y, rx] of [[-2.5, -0.5, 0.9], [10.5, -0.4, 0.7], [-6.8, -0.4, 0.6]] as const) P.piece(ellipse(x, y, rx, rx * 0.7, 8), 'stoneLight', { shadow: 0.6 });
    // the lean-to shed: dark interior, stacked cut blocks, posts, slate roof
    P.piece([[9.5, 0], [9.5, slateY(9.5) + 1], [30, slateY(30) + 1], [30, 0]], mix(tok('woodDark'), tok('ink'), 0.4), { shadow: 1, rim: 0.3 });
    for (const x of [14, 19.5, 25]) P.line([[x, -0.4], [x, slateY(x) + 1]], 0.3, 'ink', { shadow: 0, alpha: 0.35 });
    const blocks: [number, number, number][] = [[12.5, 0, 6.2], [19, 0, 6.2], [25, 0, 5.4], [14, -3.6, 6.2], [20.6, -3.6, 5.8], [16.8, -7.2, 6.4]];
    blocks.forEach(([x, y, w], i) => {
      P.piece(rect(x, y - 3.4, w, 3.4), i % 2 ? 'stoneLight' : mix(tok('stone'), tok('stoneLight'), 0.5), { shadow: 0.9, rim: 0.7, wobble: 0.35 });
    });
    lantern(P, 25.5, slateY(25.5) + 1.2);
    // posts
    P.piece(rect(9.2, slateY(10) + 0.6, 1.7, -slateY(10) - 0.6 + 0.4), 'wood', { shadow: 0.9, rim: 0.5, wobble: 0.3 });
    P.piece(rect(28.4, slateY(29) + 0.6, 1.7, -slateY(29) - 0.6 + 0.4), 'wood', { shadow: 0.9, rim: 0.5, wobble: 0.3 });
    P.line([[29, -4], [24.5, slateY(24.5) + 1.2]], 0.7, 'woodDark', { shadow: 0.5 });
    // slate roof (pent roof seen from the side: high at the back)
    const roofPts: Pt[] = [[6.5, slateY(6.5) + 1.2], [6.5, slateY(6.5) - 2.6], [31.5, slateY(31.5) - 2.6], [31.5, slateY(31.5) + 1.2]];
    P.piece(roofPts, 'roofSlate', { rim: 1.1, shadow: 1.3 });
    for (let x = 9; x < 31; x += 3.6) P.line([[x, slateY(x) - 2.3], [x, slateY(x) + 0.7]], 0.3, 'roofSlateDeep', { shadow: 0, alpha: 0.7 });
    P.piece([[6.5, slateY(6.5) - 0.2], [31.5, slateY(31.5) - 0.2], [31.5, slateY(31.5) + 1.2], [6.5, slateY(6.5) + 1.2]], 'roofSlateDeep', { shadow: 0.8, wobble: 0.4 });
    if (winter) snowOn(P, [[6.5, slateY(6.5) - 2.6], [19, slateY(19) - 2.6], [31.5, slateY(31.5) - 2.6]], 1.6);
    if (winter) snowOn(P, [[-5.2, -6.2], [-0.6, -8.2], [4, -9.1], [8.4, -8.2], [10.2, -5.8]].map(([x, y]) => [x + 0.2, y + 1.4] as Pt), 1.1);
    P.grain(-32, -36, 66, 38);
  },
  lit(P, stage) {
    if (stage < 3) return;
    lanternLit(P, 25.5, slateY(25.5) + 1.2);
  },
  points() {
    return { work: [-3.5, 0], door: [20, 0] };
  },
};

// ---------------------------------------------------------------- printshop (workshops, frog)

const PW = 32; // wall width
const PH = 26; // wall height
const PR = 13; // roof height

function pressShape(P: Paper, a: number): void {
  const c = mix(tok('ink'), tok('woodDark'), 0.3);
  // bed and paper stack
  P.piece(rect(-12.6, -7.1, 9.2, 1.7), c, { shadow: 0, wobble: 0, alpha: a });
  P.piece(rect(-11.2, -8.6, 3.2, 1.6), 'cream', { shadow: 0, wobble: 0, alpha: a * 0.85 });
  // uprights, top beam, screw, platen, lever
  P.piece(rect(-12, -14.4, 1.5, 7.4), c, { shadow: 0, wobble: 0, alpha: a });
  P.piece(rect(-5.5, -14.4, 1.5, 7.4), c, { shadow: 0, wobble: 0, alpha: a });
  P.piece(rect(-12.6, -14.9, 9.2, 1.7), c, { shadow: 0, wobble: 0, alpha: a });
  P.piece(rect(-8.9, -13.2, 1, 4.4), c, { shadow: 0, wobble: 0, alpha: a });
  P.piece(rect(-10.6, -9.8, 4.4, 1.1), c, { shadow: 0, wobble: 0, alpha: a });
  P.piece(rect(-11.8, -12.2, 9.8, 0.7), c, { shadow: 0, wobble: 0, alpha: a });
  P.piece(rect(-2, -12.5, 0.9, 1.7), c, { shadow: 0, wobble: 0, alpha: a });
}

const printshop: StructureDef = {
  kind: 'printshop',
  name: 'Print shop',
  w: 54,
  h: 40,
  stages: 3,
  zone: 'workshops',
  draw(P, stage, o) {
    const winter = o.season === 'winter';
    P.at(-4, 0, 0, () => {
      if (stage === 1) {
        footing(P, PW, o.seed);
        // a crate of paper reams and an ink barrel
        for (let i = 0; i < 3; i++) P.piece(rect(-PW / 2 - 10, -2.4 - i * 2.2, 6.5, 2.1), i % 2 ? 'cream' : 'wall', { shadow: 0.8, rim: 0.6, wobble: 0.4 });
        P.piece(roundRect(PW / 2 + 5, -6, 5, 6, 1), 'woodDark', { shadow: 1, rim: 0.5 });
        P.piece(rect(PW / 2 + 5, -4.4, 5, 0.7), 'stoneDark', { shadow: 0, wobble: 0.2 });
        return;
      }
      if (stage === 2) {
        frame(P, PW, PH, PR, 0.35);
        scaffold(P, -PW / 2 - 7, -PW / 2 - 2.5, -PH - 5);
        plankPile(P, PW / 2 + 9, 0, 3, 9);
        return;
      }
      // ---- stage 3
      chimney(P, 8, -PH - PR + 1, 4, 13, o.season);
      wallBlock(P, -PW / 2, -PH, PW, PH);
      beams(P, -PW / 2, -PH, PW, PH);
      // mid beam, verticals and braces make it half-timbered
      P.piece(rect(-PW / 2, -17.6, PW, 1.3), 'woodDark', { shadow: 0.7, wobble: 0.4 });
      for (const x of [-1.5, 3.2, 11.8]) P.piece(rect(x - 0.55, -PH, 1.1, PH - 0.4), 'woodDark', { shadow: 0.5, wobble: 0.4 });
      P.line([[-PW / 2 + 0.6, -17.4], [-11.6, -24.8]], 0.9, 'woodDark', { shadow: 0.4 });
      P.line([[-1.5, -24.8], [-5.6, -18]], 0.9, 'woodDark', { shadow: 0.4 });
      P.line([[3.2, -24.8], [PW / 2 - 0.6, -18]], 0.9, 'woodDark', { shadow: 0.4 });
      plinth(P, -PW / 2, PW);
      // the big window with the press inside
      const wx = -14;
      const wy = -16;
      const ww = 12.5;
      const wh = 10.5;
      P.piece(rect(wx - 0.9, wy - 0.9, ww + 1.8, wh + 1.8), 'woodDark', { shadow: 0.9, wobble: 0.3 });
      P.piece(rect(wx, wy, ww, wh), 'windowDark', { shadow: 0, wobble: 0 });
      P.at(0.7, -0.3, 0, () => pressShape(P, 1));
      P.piece([[wx + 0.6, wy + 0.4], [wx + 3.2, wy + 0.4], [wx + 0.6, wy + 4.2]], 'cream', { shadow: 0, wobble: 0, alpha: 0.13 });
      P.piece(rect(wx - 1.3, wy + wh + 0.9, ww + 2.6, 1), 'wood', { shadow: 0.7, wobble: 0.2 });
      door(P, 5, -12, 5.6, 12);
      windowPane(P, -11.5, -23.6, 4.8, 4.8);
      windowPane(P, 5.4, -23.6, 4.8, 4.8);
      // hanging sign on a bracket at the left corner
      P.line([[-PW / 2 + 0.4, -22.5], [-PW / 2 - 8.6, -22.5]], 0.9, 'woodDark', { shadow: 0.7 });
      P.line([[-PW / 2 + 0.4, -17.8], [-PW / 2 - 5.4, -22.2]], 0.6, 'woodDark', { shadow: 0.5 });
      P.line([[-PW / 2 - 7.6, -22.3], [-PW / 2 - 7.6, -20.4]], 0.3, 'woodDark', { shadow: 0 });
      P.line([[-PW / 2 - 1.6, -22.3], [-PW / 2 - 1.6, -20.4]], 0.3, 'woodDark', { shadow: 0 });
      P.piece(roundRect(-PW / 2 - 8.4, -20.4, 7.6, 5.6, 0.8), 'woodLight', { shadow: 1, rim: 0.8 });
      P.line([[-PW / 2 - 7, -18.9], [-PW / 2 - 2.4, -18.9]], 0.5, 'ink', { shadow: 0, alpha: 0.8 });
      P.line([[-PW / 2 - 6.4, -17.7], [-PW / 2 - 3, -17.7]], 0.5, 'ink', { shadow: 0, alpha: 0.8 });
      P.line([[-PW / 2 - 6.9, -16.5], [-PW / 2 - 2.6, -16.5]], 0.5, 'ink', { shadow: 0, alpha: 0.8 });
      gableRoof(P, 0, -PH + 1, PW + 6, PR, 'roof', 'roofDeep', o.season);
      // drying line: two poles and cream sheets
      const ax = 19.5;
      const bx = 28;
      P.line([[ax, 0.4], [ax + 0.1, -17.5]], 1.2, 'wood', { shadow: 0.8, rim: 0.4 });
      P.line([[bx, 0.4], [bx - 0.1, -16.6]], 1.2, 'wood', { shadow: 0.8, rim: 0.4 });
      const ly = (t: number) => -16.6 + 0.8 * t + 1.5 * Math.sin(Math.PI * t);
      const lpath: Pt[] = [];
      for (let i = 0; i <= 10; i++) lpath.push([ax + (bx - ax) * (i / 10), ly(i / 10)]);
      P.line(lpath, 0.3, 'roofThatchDeep', { shadow: 0.15 });
      [0.17, 0.5, 0.83].forEach((t, i) => {
        const sx = ax + (bx - ax) * t;
        const sy = ly(t);
        P.at(sx, sy, (i - 1) * 0.06, () => {
          P.piece(rect(-1.45, 0.1, 2.9, 5.4 - (i % 2) * 0.9), i === 1 ? mix(tok('cream'), tok('scarf2'), 0.35) : 'cream', { shadow: 0.8, wobble: 0.5 });
          P.line([[-0.9, 1.4], [0.9, 1.4]], 0.22, 'ink', { shadow: 0, alpha: 0.5 });
          P.line([[-0.9, 2.3], [0.9, 2.3]], 0.22, 'ink', { shadow: 0, alpha: 0.5 });
          P.dot(0, 0.1, 0.45, 'woodDark');
        });
      });
      if (winter) {
        snowOn(P, [[ax - 0.9, -17.6], [ax + 1, -17.6]], 0.9);
        snowOn(P, [[bx - 0.9, -16.7], [bx + 1, -16.7]], 0.9);
      }
    });
    P.grain(-32, -45, 66, 47);
  },
  lit(P, stage) {
    if (stage < 3) return;
    P.at(-4, 0, 0, () => {
      litWindow(P, -14, -16, 12.5, 10.5);
      P.at(0.7, -0.3, 0, () => pressShape(P, 0.85));
      litWindow(P, -11.5, -23.6, 4.8, 4.8);
      litWindow(P, 5.4, -23.6, 4.8, 4.8);
    });
  },
  points(stage) {
    return { chimney: stage === 3 ? [10 - 4, -PH - PR - 1] : undefined, door: [7.8 - 4, 0], work: [27, 0] };
  },
};

// ---------------------------------------------------------------- windmill (workshops, hare)

const halfAt = (y: number) => 13 - (5 * -y) / 44;

function windmillBase(P: Paper): void {
  P.piece([[-13.6, 0.3], [-12.2, -7.2], [12.2, -7.2], [13.6, 0.3]], 'stoneDark', { shadow: 1, rim: 0.7 });
  const r = rng(31);
  [[-6.8, 0], [-3.5, 1]].forEach(([y0, off]) => {
    const hw = halfAt(y0 + 1.5) - 0.3;
    let x = -hw - off * 1.5;
    while (x < hw) {
      const sw = range(r, 3, 4.6);
      const a = Math.max(x, -hw);
      const b = Math.min(x + sw, hw);
      if (b - a > 0.8) P.piece(roundRect(a + 0.2, y0, b - a - 0.4, 3.1, 0.8), mix(tok('stone'), tok('stoneLight'), r()), { shadow: 0.5, wobble: 0.5 });
      x += sw;
    }
  });
}

function sail(P: Paper): void {
  const x0 = 0.5;
  const x1 = 5.8;
  const y0 = -20.6;
  const y1 = -7.4;
  P.piece(rect(x0, y0, x1 - x0, y1 - y0), mix(tok('cream'), tok('wall'), 0.35), { shadow: 0.7, rim: 0.5, alpha: 0.92, wobble: 0.6 });
  for (let j = 1; j < 4; j++) P.line([[x0, y0 + ((y1 - y0) * j) / 4], [x1, y0 + ((y1 - y0) * j) / 4]], 0.5, 'woodLight', { shadow: 0.2, wobble: 0.1 });
  P.line([[(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1]], 0.5, 'woodLight', { shadow: 0.2, wobble: 0.1 });
  P.line([[x0, y0], [x1, y0]], 0.9, 'wood', { shadow: 0.4, wobble: 0.2 });
  P.line([[x0, y1], [x1, y1]], 0.9, 'wood', { shadow: 0.4, wobble: 0.2 });
  P.line([[x1, y0], [x1, y1]], 0.9, 'wood', { shadow: 0.4, wobble: 0.2 });
  P.line([[0, -1], [0, -22]], 1.4, 'woodDark', { shadow: 0.7, wobble: 0.2 });
}

const windmill: StructureDef = {
  kind: 'windmill',
  name: 'Windmill',
  w: 28,
  h: 53,
  stages: 3,
  zone: 'workshops',
  draw(P, stage, o) {
    const winter = o.season === 'winter';
    if (stage === 1) {
      footing(P, 26, o.seed);
      // a millstone waiting its turn
      P.piece(ellipse(-19, -2.3, 5, 2.3, 18), 'stoneLight', { shadow: 1, rim: 0.8 });
      P.piece(ellipse(-19, -3, 1.2, 0.6, 8), 'stoneDark', { shadow: 0, wobble: 0.2 });
      P.grain(-26, -12, 52, 14);
      return;
    }
    if (stage === 2) {
      // half-built tapered tower: stone base and lower wall, then a bare timber frame
      P.piece([[-13, 0], [-11.1, -17], [11.1, -17], [13, 0]], 'wall', { rim: 1, shadow: 1 });
      windmillBase(P);
      P.line([[-13, 0], [-8, -44]], 1.3, 'wood', { shadow: 0.9 });
      P.line([[13, 0], [8, -44]], 1.3, 'wood', { shadow: 0.9 });
      P.line([[-4.4, -17], [-2.8, -44]], 1, 'wood', { shadow: 0.8 });
      P.line([[4.4, -17], [2.8, -44]], 1, 'wood', { shadow: 0.8 });
      for (const y of [-17, -30, -44]) P.line([[-halfAt(y) - 0.4, y], [halfAt(y) + 0.4, y]], 1.1, 'wood', { shadow: 0.9 });
      P.line([[-halfAt(-17), -17], [-halfAt(-30) + 4, -30]], 0.7, 'woodLight', { shadow: 0.6 });
      P.line([[halfAt(-17), -17], [halfAt(-30) - 4, -30]], 0.7, 'woodLight', { shadow: 0.6 });
      P.line([[-halfAt(-30), -30], [-2.8, -44]], 0.7, 'woodLight', { shadow: 0.6 });
      P.line([[halfAt(-30), -30], [2.8, -44]], 0.7, 'woodLight', { shadow: 0.6 });
      // bare cap rafters
      P.line([[-9.6, -44], [0, -53]], 1, 'wood', { shadow: 0.8 });
      P.line([[9.6, -44], [0, -53]], 1, 'wood', { shadow: 0.8 });
      P.line([[-5, -48.6], [5, -48.6]], 0.7, 'woodLight', { shadow: 0.6 });
      scaffold(P, 16, 21.5, -36);
      plankPile(P, -21, 0, 3, 9);
      P.grain(-26, -56, 52, 58);
      return;
    }
    // ---- stage 3: the tapered tower
    P.piece([[-13, 0], [-8, -44], [8, -44], [13, 0]], 'wall', { rim: 1, shadow: 1.1 });
    P.piece([[4.6, 0], [2.4, -44], [8, -44], [13, 0]], 'wallShade', { shadow: 0, alpha: 0.65, wobble: 0.4 });
    windmillBase(P);
    for (const y of [-16, -32]) P.piece(rect(-halfAt(y) - 0.2, y, halfAt(y) * 2 + 0.4, 1.2), 'woodDark', { shadow: 0.7, wobble: 0.3 });
    door(P, -3, -11.6, 6, 11.6);
    windowPane(P, -2.5, -36.8, 5, 5.2);
    // gallery with railing
    P.piece(rect(-14.6, -22, 29.2, 1.5), 'wood', { shadow: 1, rim: 0.7, wobble: 0.3 });
    P.line([[-13.6, -20.5], [-10.4, -16.6]], 0.7, 'woodDark', { shadow: 0.4 });
    P.line([[13.6, -20.5], [10.4, -16.6]], 0.7, 'woodDark', { shadow: 0.4 });
    for (let i = 0; i < 6; i++) {
      const x = -14 + i * 5.6;
      P.line([[x, -22], [x, -26.4]], 0.8, 'woodLight', { shadow: 0.5 });
    }
    P.line([[-14.2, -26.2], [14.2, -26.2]], 0.9, 'woodLight', { shadow: 0.6 });
    if (winter) snowOn(P, [[-14.6, -22], [14.6, -22]], 1.1);
    // cap roof with courses
    const cap: Pt[] = [[-10.9, -43.2], [-9.6, -47], [-6, -50.6], [-2, -52.8], [2, -52.8], [6, -50.6], [9.6, -47], [10.9, -43.2]];
    P.piece(cap, 'roof', { rim: 1.2, shadow: 1.3 });
    for (const y of [-46.6, -49.8]) {
      const hw = y > -48 ? 9.7 : 6.4;
      P.piece(rect(-hw, y, hw * 2, 0.55), mix(tok('roof'), tok('roofDeep'), 0.55), { shadow: 0, wobble: 0.3 });
    }
    P.piece(rect(-11.6, -44.7, 23.2, 1.7), 'roofDeep', { shadow: 0.9, wobble: 0.4 });
    P.dot(0, -53.2, 0.9, 'woodDark', 0.5);
    if (winter) snowOn(P, cap.slice(1, 7), 1.6);
    // axle stub the sails turn on
    P.piece(ellipse(0, -47.8, 2.1, 2.1, 12), 'woodDark', { shadow: 0.8, rim: 0.5 });
    P.grain(-17, -56, 34, 58);
  },
  lit(P, stage) {
    if (stage < 3) return;
    litWindow(P, -2.5, -36.8, 5, 5.2);
  },
  part: {
    r: 22,
    draw(P) {
      for (let k = 0; k < 4; k++) P.at(0, 0, (k * Math.PI) / 2, () => sail(P));
      P.dot(0, 0, 2.5, 'wood', 0.8);
      P.dot(0, 0, 1.2, 'woodDark');
      P.dot(0, 0, 0.45, 'stoneLight');
      P.grain(-24, -24, 48, 48);
    },
  },
  points(stage) {
    return { door: [0, 0], work: [-21, 0], pivot: stage === 3 ? [0, -48] : undefined };
  },
};

// ---------------------------------------------------------------- well (commons)

const well: StructureDef = {
  kind: 'well',
  name: 'Well',
  w: 20,
  h: 24,
  stages: 3,
  zone: 'commons',
  draw(P, stage, o) {
    const winter = o.season === 'winter';
    const ring = (withTop: boolean) => {
      // short wide stone drum seen from the side
      P.piece(roundRect(-7, -7.6, 14, 7.9, [1.2, 1.2, 1.6, 1.6]), 'stoneDark', { shadow: 1, rim: 0.7 });
      const r = rng(77);
      for (let row = 0; row < 3; row++) {
        let x = -7 - (row % 2) * 1.8;
        while (x < 7) {
          const sw = range(r, 2.6, 3.8);
          const a = Math.max(x, -7);
          const b = Math.min(x + sw, 7);
          if (b - a > 0.8) P.piece(roundRect(a + 0.25, -7.4 + row * 2.5, b - a - 0.5, 2.3, 0.7), mix(tok('stone'), tok('stoneLight'), r()), { shadow: 0.5, wobble: 0.5 });
          x += sw;
        }
      }
      if (withTop) {
        P.piece(ellipse(0, -7.6, 7.4, 2, 24), 'stoneLight', { shadow: 0.8, rim: 0.6 });
        P.piece(ellipse(0, -7.5, 5.7, 1.2, 20), mix(tok('ink'), tok('windowDark'), 0.5), { shadow: 0, wobble: 0.3 });
        if (winter) snowOn(P, [[-7.2, -8.4], [-3, -9.5], [3, -9.5], [7.2, -8.4]], 1);
      }
    };
    if (stage === 1) {
      stonePile(P, 3, 0, 6, o.seed);
      for (const x of [-9, -3.5, 9]) stake(P, x, -6.5);
      P.line([[-9, -5.8], [-3.5, -5.6]], 0.3, 'cream', { shadow: 0.3, alpha: 0.9 });
      P.piece(ellipse(-6.5, -0.7, 1.7, 1, 10), 'stone', { shadow: 0.8, rim: 0.6 });
      P.grain(-12, -9, 24, 11);
      return;
    }
    if (stage === 2) {
      ring(true);
      for (const x of [-9.8, 9.8]) stake(P, x, -6);
      P.piece(ellipse(-11.5, -0.9, 1.6, 1, 10), 'stoneLight', { shadow: 0.8, rim: 0.6 });
      P.grain(-12, -11, 24, 13);
      return;
    }
    // posts (behind the drum), axle, roof
    for (const x of [-5.6, 5.6]) P.piece(rect(x - 0.8, -19, 1.6, 12.6), 'woodDark', { shadow: 0.9, rim: 0.4, wobble: 0.3 });
    P.piece(rect(-6.6, -17.6, 13.2, 1.2), 'wood', { shadow: 0.8, rim: 0.5, wobble: 0.3 });
    ring(true);
    // rope and bucket hang down into the opening
    P.line([[-1.4, -16.9], [-1.4, -11.4]], 0.4, 'roofThatch', { shadow: 0.2 });
    P.piece([[-3, -11.4], [0.2, -11.4], [-0.1, -7.6], [-2.7, -7.6]], 'wood', { shadow: 0.9, rim: 0.5, wobble: 0.3 });
    P.piece(rect(-2.95, -10.2, 3.2, 0.5), 'woodDark', { shadow: 0, wobble: 0.1 });
    P.piece(rect(-2.8, -8.5, 2.9, 0.5), 'woodDark', { shadow: 0, wobble: 0.1 });
    P.line([[-3, -11.2], [-1.4, -12.8], [0.2, -11.2]], 0.3, 'woodDark', { shadow: 0 });
    // crank at the right end of the axle
    P.line([[6.6, -17], [10, -17]], 0.8, 'woodDark', { shadow: 0.5 });
    P.line([[10, -17], [10, -13.6]], 0.8, 'woodDark', { shadow: 0.5 });
    P.dot(10, -13.4, 0.9, 'woodLight', 0.5);
    gableRoof(P, 0, -18.4, 18, 5.6, 'roof', 'roofDeep', o.season);
    P.grain(-12, -25, 24, 27);
  },
  points() {
    return { door: [0, 0], work: [-12, 0] };
  },
};

// ---------------------------------------------------------------- garden (orchard)

function bed(P: Paper, x0: number, x1: number, ridges: boolean, winter: boolean): void {
  P.piece(roundRect(x0, -3.4, x1 - x0, 4, [1.2, 1.2, 0.6, 0.6]), 'soil', { rim: 0.7, shadow: 1 });
  if (ridges) {
    for (let x = x0 + 1.4; x < x1 - 1; x += 2.6) P.piece(ellipse(x, -3.3, 1.35, 0.9, 10), mix(tok('soil'), tok('woodLight'), 0.28), { shadow: 0.5, wobble: 0.4 });
  }
  for (let i = 0; i < 3; i++) P.piece(rect(x0 + 0.8, -2.5 + i * 0.95, x1 - x0 - 1.6, 0.4), 'soilDeep', { shadow: 0, wobble: 0.8, alpha: 0.85 });
  if (winter) snowOn(P, [[x0 + 0.3, -3.4], [(x0 + x1) / 2, -3.4], [x1 - 0.3, -3.4]], 1.3);
}

function cabbage(P: Paper, x: number, winter: boolean): void {
  P.piece(ellipse(x, -4, 3.5, 1.2, 14), mix(tok('meadow'), tok('meadowLight'), 0.4), { shadow: 0.8, wobble: 0.5 });
  P.piece(ellipse(x, -5.5, 2.5, 2.2, 14), 'meadowLight', { shadow: 0.8, rim: 0.6, wobble: 0.5 });
  P.piece(ellipse(x, -5.8, 1.45, 1.35, 12), mix(tok('meadowLight'), tok('cream'), 0.32), { shadow: 0.3, wobble: 0.4 });
  P.line([[x - 0.9, -4.3], [x - 0.7, -6.8]], 0.25, 'meadow', { shadow: 0, alpha: 0.7 });
  P.line([[x + 0.9, -4.3], [x + 0.8, -6.7]], 0.25, 'meadow', { shadow: 0, alpha: 0.7 });
  if (winter) snowOn(P, [[x - 1.7, -7.2], [x, -7.9], [x + 1.7, -7.2]], 0.8);
}

function pumpkin(P: Paper, x: number, s: number, winter: boolean): void {
  const amber = tok('leafAmber');
  const rust = mix(amber, tok('leafRust'), 0.4);
  const cy = -3.4 - 2.2 * s;
  P.piece(ellipse(x - 1.55 * s, cy, 1.5 * s, 2.0 * s, 12), rust, { shadow: 0.8, wobble: 0.4 });
  P.piece(ellipse(x + 1.55 * s, cy, 1.5 * s, 2.0 * s, 12), rust, { shadow: 0.8, wobble: 0.4 });
  P.piece(ellipse(x, cy, 1.9 * s, 2.2 * s, 14), 'leafAmber', { shadow: 0.9, rim: 0.7, wobble: 0.4 });
  P.piece(rect(x - 0.35, cy - 2.2 * s - 1, 0.7, 1.4), 'woodDark', { shadow: 0.4, wobble: 0.2 });
  P.piece(ellipse(x + 2.2 * s, cy - 1.8 * s, 1.5 * s, 0.7 * s, 8, 0, Math.PI * 2), 'meadow', { shadow: 0.5, wobble: 0.3 });
  if (winter) snowOn(P, [[x - 1.7 * s, cy - 1.9 * s], [x, cy - 2.6 * s], [x + 1.7 * s, cy - 1.9 * s]], 0.8);
}

function beanPoles(P: Paper, c: number, winter: boolean): void {
  P.line([[c - 3.2, -3.2], [c + 0.3, -13.6]], 0.8, 'woodLight', { shadow: 0.7 });
  P.line([[c + 3.2, -3.2], [c - 0.3, -13.6]], 0.8, 'woodLight', { shadow: 0.7 });
  P.line([[c, -3.2], [c, -13.2]], 0.8, 'wood', { shadow: 0.7 });
  P.dot(c, -13.2, 0.7, 'roofThatch', 0.4);
  for (let i = 0; i < 6; i++) {
    const t = i / 5;
    P.dot(c - 1.4 + (i % 2) * 2.8 - (1 - t) * (i % 2 ? 0.2 : -0.2), -4.6 - t * 7.2, 0.95, i % 2 ? 'meadow' : 'meadowLight', 0.4);
  }
  P.dot(c + 0.4, -9.8, 0.55, 'scarf0');
  P.dot(c - 1, -6.6, 0.55, 'scarf0');
  if (winter) snowOn(P, [[c - 0.8, -13.9], [c + 0.8, -13.9]], 0.8);
}

function scarecrow(P: Paper, winter: boolean): void {
  const tunic = mix(tok('scarf1'), tok('wall'), 0.15);
  const sleeve = mix(tok('scarf1'), tok('ink'), 0.15);
  P.line([[0, -3], [0, -14.5]], 1, 'wood', { shadow: 0.9 });
  P.line([[-5.2, -9.8], [0, -10.6], [5.2, -9.8]], 0.9, 'wood', { shadow: 0.8 });
  P.piece([[-2.2, -11], [-5.4, -10.2], [-5.2, -8.5], [-2.2, -8.8]], sleeve, { shadow: 0.7, wobble: 0.4 });
  P.piece([[2.2, -11], [5.4, -10.2], [5.2, -8.5], [2.2, -8.8]], sleeve, { shadow: 0.7, wobble: 0.4 });
  for (const sx of [-1, 1]) {
    P.line([[sx * 5.2, -9.4], [sx * 6.4, -8.4]], 0.4, 'roofThatch', { shadow: 0 });
    P.line([[sx * 5.2, -9.4], [sx * 6.5, -9.6]], 0.4, 'roofThatch', { shadow: 0 });
    P.line([[sx * 5.2, -9.4], [sx * 6.2, -10.6]], 0.4, 'roofThatch', { shadow: 0 });
  }
  P.piece([[-2.3, -11], [2.3, -11], [2.9, -6], [1.6, -6.7], [0.6, -5.8], [-0.6, -6.6], [-1.8, -5.8], [-2.9, -6]], tunic, { shadow: 0.9, rim: 0.5, wobble: 0.4 });
  P.piece(rect(0.4, -9.4, 1.5, 1.4), 'scarf2', { shadow: 0.3, wobble: 0.3 });
  for (const x of [-1.2, 0.2, 1.3]) P.line([[x, -6.2], [x + 0.2, -4.6]], 0.3, 'roofThatch', { shadow: 0 });
  // head: a stuffed sack
  P.piece(ellipse(0, -13.2, 2.1, 2.1, 12), mix(tok('roofThatch'), tok('cream'), 0.35), { shadow: 0.8, rim: 0.5 });
  P.dot(-0.8, -13.4, 0.3, 'ink');
  P.dot(0.8, -13.4, 0.3, 'ink');
  P.line([[-0.8, -12.3], [0.8, -12.3]], 0.22, 'ink', { shadow: 0, alpha: 0.8 });
  // scarf with a fluttering tail
  P.piece(rect(-2.2, -11.7, 4.4, 1.1), 'scarf0', { shadow: 0.6, wobble: 0.3 });
  P.piece([[1.4, -11.4], [4.4, -10.2], [4.8, -9], [1.9, -10]], 'scarf0', { shadow: 0.6, wobble: 0.3 });
  P.piece([[2.6, -10.9], [3.6, -10.5], [3.6, -10.1], [2.7, -10.4]], 'scarf2', { shadow: 0, wobble: 0.1 });
  // hat
  P.piece(rect(-3.4, -15.1, 6.8, 0.9), 'woodDark', { shadow: 0.8, wobble: 0.3 });
  P.piece(roundRect(-1.9, -17.2, 3.8, 2.3, [1, 1, 0, 0]), 'wood', { shadow: 0.8, rim: 0.6, wobble: 0.3 });
  P.piece(rect(-1.9, -15.7, 3.8, 0.55), 'scarf0', { shadow: 0, wobble: 0.1 });
  if (winter) snowOn(P, [[-3.4, -15.3], [0, -17.7], [3.4, -15.3]], 0.9);
}

function wattleFence(P: Paper, x0: number, x1: number, winter: boolean): void {
  const h = 8;
  for (let b = 0; b < 3; b++) {
    const y = -1.6 - b * 2.3;
    const path: Pt[] = [];
    for (let x = x0; x <= x1; x += 1.5) path.push([x, y + Math.sin(x * 0.9 + b) * 0.55]);
    P.line(path, 1.35, b % 2 ? 'wood' : 'woodLight', { shadow: 0.7, wobble: 0.5 });
  }
  for (let x = x0 + 1; x <= x1; x += 3.1) P.line([[x, 0.4], [x + 0.1, -h]], 0.9, 'woodDark', { shadow: 0.6 });
  if (winter) snowOn(P, [[x0, -h + 0.5], [(x0 + x1) / 2, -h + 0.5], [x1, -h + 0.5]], 1.2);
}

const garden: StructureDef = {
  kind: 'garden',
  name: 'Garden',
  w: 54,
  h: 17,
  stages: 3,
  zone: 'orchard',
  draw(P, stage, o) {
    const winter = o.season === 'winter';
    if (stage === 1) {
      // a staked-out plot: flat bare soil, corner stakes, string
      P.piece(roundRect(-23, -1.8, 46, 2.4, [1, 1, 0.6, 0.6]), 'soil', { rim: 0.6, shadow: 0.9 });
      for (let i = 0; i < 2; i++) P.piece(rect(-21.5, -1 + i * 0.9, 43, 0.35), 'soilDeep', { shadow: 0, wobble: 0.8, alpha: 0.8 });
      for (const x of [-24, -8, 8, 24]) stake(P, x, -8);
      P.line([[-24, -7], [-8, -6.6], [8, -6.8], [24, -7]], 0.3, 'cream', { shadow: 0.3, alpha: 0.9 });
      if (winter) snowOn(P, [[-23, -1.8], [0, -1.8], [23, -1.8]], 1.1);
      // a spade stuck in the soil
      P.line([[13, -1.5], [13.4, -9.4]], 0.7, 'wood', { shadow: 0.6 });
      P.piece(roundRect(11.8, -2.2, 3.2, 3.4, [0.2, 0.2, 1.4, 1.4]), 'stoneDark', { shadow: 0.7, wobble: 0.3 });
      P.grain(-27, -12, 54, 14);
      return;
    }
    if (stage === 2) {
      wattleFence(P, -26, -4, winter);
      bed(P, -25, -10, true, winter);
      bed(P, -8, 8, true, winter);
      bed(P, 10, 25, false, winter);
      for (const x of [10.6, 24.4]) stake(P, x, -8);
      P.line([[10.6, -7.2], [24.4, -7.2]], 0.3, 'cream', { shadow: 0.3, alpha: 0.9 });
      P.line([[4.6, -3.3], [5, -11]], 0.7, 'wood', { shadow: 0.6 });
      P.piece(roundRect(3.4, -4, 3.2, 3.4, [0.2, 0.2, 1.4, 1.4]), 'stoneDark', { shadow: 0.7, wobble: 0.3 });
      P.grain(-28, -14, 56, 16);
      return;
    }
    wattleFence(P, -26, 26, winter);
    bed(P, -25, -10, false, winter);
    bed(P, -8, 8, false, winter);
    bed(P, 10, 25, false, winter);
    for (const x of [-21.5, -17.5, -13.5]) cabbage(P, x, winter);
    for (const x of [-6.1, 6.2]) pumpkin(P, x, 0.9, winter);
    pumpkin(P, -3.1, 0.62, winter);
    pumpkin(P, 3.2, 0.72, winter);
    // trailing vine between the pumpkins
    P.line([[-5.8, -3.5], [-4.2, -3.9], [-3, -3.6]], 0.3, 'meadow', { shadow: 0 });
    P.line([[3, -3.6], [4.6, -3.9], [6, -3.6]], 0.3, 'meadow', { shadow: 0 });
    beanPoles(P, 14.8, winter);
    beanPoles(P, 21.2, winter);
    scarecrow(P, winter);
    P.grain(-28, -19, 56, 21);
  },
  points() {
    return { work: [-9, 0], door: [0, 0] };
  },
};

// ---------------------------------------------------------------- footbridge (river)

const deckY = (x: number) => -6 * (1 - (x / 20) * (x / 20));
const deckT = (x: number) => 2.1 * (1 - Math.pow(Math.abs(x) / 20, 4));

function abutment(P: Paper, side: -1 | 1, seed: number): void {
  const x0 = side > 0 ? 14.4 : -18.4;
  P.piece(rect(x0, -1, 4, 7.4), 'stoneDark', { shadow: 1, rim: 0.7 });
  const r = rng(seed + (side > 0 ? 1 : 5));
  for (let row = 0; row < 3; row++) {
    let x = x0 - (row % 2) * 1.2;
    while (x < x0 + 4) {
      const sw = range(r, 2.2, 3.4);
      const a = Math.max(x, x0);
      const b = Math.min(x + sw, x0 + 4);
      if (b - a > 0.8) P.piece(roundRect(a + 0.2, -0.8 + row * 2.4, b - a - 0.4, 2.2, 0.7), mix(tok('stone'), tok('stoneLight'), r()), { shadow: 0.5, wobble: 0.5 });
      x += sw;
    }
  }
}

function piers(P: Paper): void {
  for (const x of [-9, 9]) {
    P.line([[x, deckY(x) + 1], [x + 0.1, 10]], 2, 'woodDark', { shadow: 0.8, rim: 0.4 });
    P.line([[x, 5.5], [x * 0.5, deckY(x * 0.5) + deckT(x * 0.5) - 0.2]], 0.9, 'wood', { shadow: 0.5 });
  }
  P.line([[-9, 4.2], [9, 4.2]], 1, 'wood', { shadow: 0.6 });
}

const footbridge: StructureDef = {
  kind: 'footbridge',
  name: 'Footbridge',
  w: 42,
  h: 18,
  stages: 3,
  zone: 'river',
  creek: { x0: -15, x1: 15 },
  draw(P, stage, o) {
    const winter = o.season === 'winter';
    if (stage === 1) {
      abutment(P, -1, o.seed);
      abutment(P, 1, o.seed);
      // planks laid out, stubs reaching from both banks
      P.line([[-14.4, -1.3], [-10, -2.6]], 1.4, 'woodLight', { shadow: 0.8, rim: 0.4 });
      P.line([[14.4, -1.3], [10, -2.6]], 1.4, 'woodLight', { shadow: 0.8, rim: 0.4 });
      plankPile(P, -22.5, 0, 3, 8);
      stonePile(P, 22, 0, 3, o.seed);
      P.grain(-28, -8, 56, 16);
      return;
    }
    piers(P);
    // arched deck: top edge, bottom edge (pinches to nothing at the ends)
    const top: Pt[] = [];
    const bot: Pt[] = [];
    for (let x = -20; x <= 20.01; x += 2) {
      top.push([x, deckY(x)]);
      bot.push([x, deckY(x) + deckT(x)]);
    }
    abutment(P, -1, o.seed);
    abutment(P, 1, o.seed);
    // curved bearer beneath
    const bearer: Pt[] = [];
    for (let x = -15; x <= 15.01; x += 2.5) bearer.push([x, deckY(x) + deckT(x) + 0.5]);
    P.line(bearer, 1.1, 'woodDark', { shadow: 0.6 });
    P.piece([...top, ...bot.reverse()], 'wood', { rim: 1, shadow: 1.1 });
    const surface: Pt[] = [];
    for (let x = -19; x <= 19.01; x += 2) surface.push([x, deckY(x) + 0.55]);
    P.line(surface, 0.9, 'woodLight', { shadow: 0, alpha: 0.9 });
    for (let x = -18; x <= 18.01; x += 2.4) P.line([[x, deckY(x) + 0.2], [x, deckY(x) + Math.max(0.4, deckT(x) - 0.2)]], 0.28, 'woodDark', { shadow: 0, alpha: 0.5 });
    if (winter) snowOn(P, surface.filter((_, i) => i % 2 === 0).map(([x, y]) => [x, y - 0.4] as Pt), 1);
    if (stage === 2) {
      P.grain(-24, -14, 48, 26);
      return;
    }
    // railings: newel posts and two rails
    const rail: Pt[] = [];
    const mid: Pt[] = [];
    for (let x = -18; x <= 18.01; x += 2) {
      rail.push([x, deckY(x) - 5.4]);
      mid.push([x, deckY(x) - 2.7]);
    }
    for (const x of [-18, -12, -6, 0, 6, 12, 18]) {
      const end = Math.abs(x) === 18;
      const tp = x === -18 ? 10.8 : end ? 6.6 : 5.4;
      P.line([[x, deckY(x) + 0.6], [x, deckY(x) - tp]], 1, 'wood', { shadow: 0.8, rim: 0.4 });
      if (end) P.dot(x, deckY(x) - tp - 0.2, 0.9, 'woodLight', 0.5);
    }
    P.line(mid, 0.7, 'wood', { shadow: 0.6 });
    P.line(rail, 1.1, 'woodLight', { shadow: 0.8, rim: 0.4 });
    // a lantern on a short arm at the left newel
    P.line([[-18, deckY(-18) - 10.8], [-15.2, deckY(-18) - 10.8]], 0.7, 'woodDark', { shadow: 0.5 });
    lantern(P, -15.2, deckY(-18) - 10.4);
    if (winter) snowOn(P, rail.filter((_, i) => i % 2 === 0).map(([x, y]) => [x, y - 0.6] as Pt), 0.9);
    P.grain(-24, -20, 48, 32);
  },
  lit(P, stage) {
    if (stage < 3) return;
    lanternLit(P, -15.2, deckY(-18) - 10.4);
  },
  points() {
    return { work: [0, -6], door: undefined };
  },
};

export const STRUCTURES_A: StructureDef[] = [noticeboard, stoneyard, printshop, windmill, well, garden, footbridge];
