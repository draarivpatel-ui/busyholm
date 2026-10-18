/**
 * Structures batch B (drawn by a helper agent to the kit house rules; see kit.ts and structures.ts):
 * jetty, watermill, guesthouse, belltower, bakery, markethall.
 * Origin: bottom-centre on the ground (y = 0), up is -y, units are strip units.
 */
import { type Paper, type Pt, rect, roundRect, ellipse, circle, xf } from './paper.ts';
import { tok, mix } from './color.ts';
import { rng, range } from './rng.ts';
import { SCARVES } from './tokens.ts';
import type { StructureDef } from './structures.ts';
import {
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
  stonePile,
  scaffold,
  snowOn,
} from './kit.ts';
import type { Season } from './terrain.ts';

// ---------------------------------------------------------------- shared helpers

/** Thin darker joints over a stone wall: horizontal courses with staggered vertical joints. */
function stoneCourses(P: Paper, x: number, y: number, w: number, h: number, rowH: number, seed: number): void {
  const r = rng(seed);
  let row = 0;
  for (let yy = y + h - rowH; yy > y + 0.5; yy -= rowH, row++) {
    P.piece(rect(x + 0.4, yy, w - 0.8, 0.45), 'stoneDark', { shadow: 0, wobble: 0.3, alpha: 0.55 });
    let xx = x + (row % 2 ? 2.6 : 5.2) + range(r, 0, 1.5);
    while (xx < x + w - 1.5) {
      P.piece(rect(xx, yy + 0.45, 0.4, rowH - 0.45), 'stoneDark', { shadow: 0, wobble: 0.2, alpha: 0.45 });
      xx += range(r, 4.2, 6.8);
    }
  }
}

/** Bare roof frame (two rafters, ridge post, a purlin) for stage 2, centred on cx. */
function roofFrame(P: Paper, cx: number, wallTop: number, halfSpan: number, roofH: number): void {
  const peak: Pt = [cx, wallTop - roofH];
  P.line([[cx - halfSpan, wallTop + 0.6], peak], 1.0, 'wood', { shadow: 0.9 });
  P.line([[cx + halfSpan, wallTop + 0.6], peak], 1.0, 'wood', { shadow: 0.9 });
  P.line([[cx, wallTop], peak], 0.8, 'woodLight', { shadow: 0.7 });
  const t = 0.45;
  const hw = halfSpan * (1 - t);
  P.line([[cx - hw, wallTop - roofH * t], [cx + hw, wallTop - roofH * t]], 0.7, 'woodLight', { shadow: 0.7 });
}

/** A string of bunting between two points (sagging parabola), flags in the six scarf tokens. */
function bunting(P: Paper, x0: number, y0: number, x1: number, y1: number, sag: number, n: number, startIdx: number): void {
  const at = (t: number): Pt => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + sag * 4 * t * (1 - t)];
  const path: Pt[] = [];
  for (let i = 0; i <= 12; i++) path.push(at(i / 12));
  P.line(path, 0.3, 'woodDark', { shadow: 0 });
  for (let k = 0; k < n; k++) {
    const [px, py] = at((k + 0.5) / n);
    P.piece([[px - 1.25, py - 0.1], [px + 1.25, py - 0.1], [px, py + 2.5]], SCARVES[(startIdx + k) % SCARVES.length], { shadow: 0.5, wobble: 0.3 });
  }
}

/** Produce for stalls. */
function pumpkin(P: Paper, x: number, y: number, r = 1.6): void {
  P.piece(ellipse(x, y, r * 1.12, r, 14), 'leafAmber', { shadow: 0.8, rim: 0.6 });
  P.piece(rect(x - 0.15, y - r + 0.1, 0.3, r * 1.7), 'leafRust', { shadow: 0, wobble: 0, alpha: 0.5 });
  P.piece(rect(x - 0.35, y - r - 0.7, 0.7, 0.9), 'reed', { shadow: 0, wobble: 0.1 });
}
function apple(P: Paper, x: number, y: number): void {
  P.dot(x, y, 1.0, 'leafRust', 0.5);
}
function cabbage(P: Paper, x: number, y: number, r = 1.5): void {
  P.piece(circle(x, y, r, 12), 'meadowLight', { shadow: 0.8, rim: 0.5, wobble: 0.5 });
  P.piece(ellipse(x + r * 0.25, y + r * 0.1, r * 0.55, r * 0.7, 8), 'reed', { shadow: 0, wobble: 0.2, alpha: 0.55 });
}

// ---------------------------------------------------------------- jetty (river)

const JETTY_POSTS = [-15, -5, 5, 15];

/** A post standing in the near water: dark timber, wetter below the waterline, a ripple ring. */
function jettyPost(P: Paper, x: number, top: number, bottom = 30, w = 1.7): void {
  P.piece(rect(x - w / 2, top, w, bottom - top), 'woodDark', { shadow: 0.9, rim: 0.5, wobble: 0.5 });
  P.piece(rect(x - w / 2, 25.6, w, bottom - 25.6), 'riverDeep', { shadow: 0, alpha: 0.5, wobble: 0.3 });
  P.piece(ellipse(x, 25.5, w * 1.9, 0.6, 12), 'riverLight', { shadow: 0, alpha: 0.85, wobble: 0.4 });
}

function jettyDeck(P: Paper, x0: number, x1: number): void {
  P.piece(rect(x0, 12.2, x1 - x0, 1.5), 'woodDark', { shadow: 1, wobble: 0.4 });
  P.piece(rect(x0 - 0.5, 9.4, x1 - x0 + 1, 3), 'woodLight', { shadow: 1.1, rim: 0.8, wobble: 0.5 });
  for (let x = x0 + 4; x < x1 - 1; x += 4.2) P.piece(rect(x, 9.8, 0.4, 2.2), 'wood', { shadow: 0, wobble: 0, alpha: 0.7 });
}

function rowboat(P: Paper, cx: number, cy: number, season: Season): void {
  const hull: Pt[] = [[-8.5, -2.6], [-4, -1.5], [4, -1.5], [8.5, -2.6], [6.6, 1.2], [2.6, 2.7], [-2.6, 2.7], [-6.6, 1.2]];
  P.piece(xf(hull, cx, cy), 'woodLight', { shadow: 1.1, rim: 0.7, wobble: 0.5 });
  // painted stripe and dark interior
  P.piece(xf([[-8.2, -2.2], [8.2, -2.2], [7.6, -1.2], [-7.6, -1.2]], cx, cy), 'roofDeep', { shadow: 0, wobble: 0.3 });
  P.piece(xf(ellipse(0, -1.9, 6.6, 0.8, 16), cx, cy), mix(tok('woodDark'), tok('ink'), 0.3), { shadow: 0, wobble: 0.2 });
  P.piece(rect(cx - 1, cy - 2.7, 2, 1.1), 'wood', { shadow: 0.5, wobble: 0.2 });
  // oar resting across the boat
  P.line([[cx - 7.5, cy - 4.4], [cx + 5, cy - 0.6]], 0.45, 'woodDark', { shadow: 0.4 });
  P.piece(ellipse(cx + 5.6, cy - 0.4, 1.4, 0.55, 8), 'woodDark', { shadow: 0.4, wobble: 0.1 });
  // waterline ripple
  P.piece(ellipse(cx, cy + 1.6, 9.6, 0.65, 18), 'riverLight', { shadow: 0, alpha: 0.85, wobble: 0.5 });
  if (season === 'winter') snowOn(P, [[cx - 7, cy - 2.2], [cx - 2, cy - 1.8], [cx + 2, cy - 1.8], [cx + 7, cy - 2.2]], 0.7);
}

const jetty: StructureDef = {
  kind: 'jetty',
  name: 'Jetty',
  w: 36,
  h: 8,
  stages: 3,
  zone: 'river',
  draw(P, stage, o) {
    if (stage === 1) {
      // a few posts, uneven heights, string and a pile of planks on the bank
      jettyPost(P, -15, 8.4);
      jettyPost(P, -5, 6.2);
      jettyPost(P, 5, 7.6);
      P.line([[-15, 8.8], [-5, 6.6], [5, 8]], 0.3, 'cream', { shadow: 0.3, alpha: 0.9 });
      plankPile(P, 14, 11.6, 4, 11);
      P.grain(-20, 4, 40, 28);
      return;
    }
    if (stage === 2) {
      for (const x of JETTY_POSTS) jettyPost(P, x, 8.6);
      // cross braces under the deck
      P.line([[-15, 14], [-5, 24]], 0.7, 'wood', { shadow: 0.6 });
      P.line([[5, 24], [15, 14]], 0.7, 'wood', { shadow: 0.6 });
      jettyDeck(P, -18, 6);
      plankPile(P, 14, 11.6, 3, 10);
      P.grain(-20, 4, 40, 28);
      return;
    }
    // finished: posts, braces, deck, mooring post, lantern post, rope coil, rowboat
    for (const x of JETTY_POSTS) jettyPost(P, x, 8.6);
    P.line([[-15, 14], [-5, 24]], 0.7, 'wood', { shadow: 0.6 });
    P.line([[5, 24], [15, 14]], 0.7, 'wood', { shadow: 0.6 });
    jettyDeck(P, -18, 18);
    if (o.season === 'winter') snowOn(P, [[-18, 9.4], [-9, 9.2], [0, 9.4], [9, 9.2], [18, 9.4]], 1.3);
    // mooring post at the left end
    P.piece(rect(-15.4, 4.4, 2.6, 6.4), 'wood', { shadow: 1, rim: 0.7, wobble: 0.4 });
    P.piece(rect(-15.9, 3.6, 3.6, 1.3), 'woodLight', { shadow: 0.8, rim: 0.5, wobble: 0.3 });
    P.piece(rect(-15.5, 6.4, 2.8, 0.7), 'reedTip', { shadow: 0, wobble: 0.2 });
    // coil of rope on the deck
    P.piece(ellipse(-7.5, 8.4, 3.1, 1.15, 18), 'reedTip', { shadow: 0.8, wobble: 0.4, holes: [ellipse(-7.5, 8.4, 1.4, 0.45, 12)] });
    P.piece(ellipse(-7.5, 7.6, 2.6, 0.95, 18), 'reedTip', { shadow: 0.6, wobble: 0.4, holes: [ellipse(-7.5, 7.6, 1.1, 0.35, 12)] });
    // lantern post at the right end
    P.piece(rect(15.2, 3.6, 1.6, 7), 'woodDark', { shadow: 0.9, rim: 0.5, wobble: 0.3 });
    P.line([[16, 3.8], [13.4, 3.8]], 0.5, 'woodDark', { shadow: 0.4 });
    P.piece(rect(12.4, 4.4, 2, 2.8), 'woodDark', { shadow: 0.7, wobble: 0.1 });
    P.piece(rect(12.8, 4.9, 1.2, 1.8), 'windowDark', { shadow: 0, wobble: 0 });
    // boat floats beside the posts, rope runs to the mooring post
    rowboat(P, 4, 27, o.season);
    P.line([[-14.1, 7.2], [-11.5, 15], [-8, 22], [-4.3, 25.2]], 0.5, 'reedTip', { shadow: 0.4 });
    P.grain(-20, 2, 40, 31);
  },
  lit(P, stage) {
    if (stage < 3) return;
    P.glow(13.4, 5.8, 6.5, 'lampGlow', 0.5);
    P.piece(rect(12.8, 4.9, 1.2, 1.8), 'lampGlow', { shadow: 0, wobble: 0 });
  },
  points() {
    return { work: [-2, 0] };
  },
};

// ---------------------------------------------------------------- watermill (river)

const MILL_X0 = -19;
const MILL_W = 32;
const MILL_X1 = MILL_X0 + MILL_W;

const watermill: StructureDef = {
  kind: 'watermill',
  name: 'Watermill',
  w: 56,
  h: 52,
  stages: 3,
  zone: 'river',
  creek: { x0: 16, x1: 38 },
  part: {
    r: 12,
    draw(P) {
      // paddles first (the rim overlaps their inner ends), then rim, spokes, hub
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4 + Math.PI / 8;
        P.piece(xf(rect(-1.9, -12, 3.8, 3.6), 0, 0, a), i % 2 ? 'woodLight' : 'wood', { shadow: 0.8, rim: 0.5, wobble: 0.3 });
      }
      P.piece(circle(0, 0, 10.2, 40), 'woodDark', { shadow: 1, rim: 0.4, wobble: 0.5, holes: [circle(0, 0, 8.5, 34)] });
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        P.line([[0, 0], [Math.cos(a) * 9, Math.sin(a) * 9]], 0.95, 'wood', { shadow: 0.7 });
      }
      P.piece(circle(0, 0, 2.5, 14), 'woodDark', { shadow: 1, rim: 0.8, wobble: 0.2 });
      P.dot(0, 0, 0.85, 'woodLight');
    },
  },
  draw(P, stage, o) {
    const lowH = 13;
    const upH = 15;
    const cx = (MILL_X0 + MILL_X1) / 2;
    if (stage === 1) {
      P.at(cx, 0, 0, () => footing(P, MILL_W, o.seed));
      // stakes and string marking the mill race
      for (const x of [16, 38]) P.line([[x, 0], [x + 0.2, -7]], 0.8, 'woodLight', { shadow: 0.7 });
      P.line([[16, -5.6], [38, -5.4]], 0.3, 'cream', { shadow: 0.3, alpha: 0.9 });
      stonePile(P, -26, 0, 6, o.seed + 3);
      P.grain(-34, -12, 76, 24);
      return;
    }
    if (stage === 2) {
      // stone storey is up; timber frame above; axle posts where the wheel will hang
      wallBlock(P, MILL_X0, -lowH, MILL_W, lowH, 'stone');
      stoneCourses(P, MILL_X0, -lowH, MILL_W, lowH, 4.3, o.seed);
      plinth(P, MILL_X0, MILL_W, 2.2);
      for (let i = 0; i <= 4; i++) {
        const x = MILL_X0 + (MILL_W * i) / 4;
        P.line([[x, -lowH], [x, -lowH - upH]], 1, 'wood', { shadow: 0.9 });
      }
      P.line([[MILL_X0 - 1, -lowH - upH], [MILL_X1 + 1, -lowH - upH]], 1.1, 'wood', { shadow: 0.9 });
      P.line([[MILL_X0, -lowH - 6], [MILL_X1, -lowH - 6]], 0.8, 'woodLight', { shadow: 0.7 });
      roofFrame(P, cx, -lowH - upH, MILL_W / 2 + 4, 17);
      // axle posts and crossbeam
      for (const x of [21, 31]) P.line([[x, 6], [x, -13]], 1.3, 'wood', { shadow: 0.9 });
      P.line([[19, -13], [33, -13]], 1.1, 'wood', { shadow: 0.9 });
      P.line([[21, 2], [31, 2]], 1.7, 'woodDark', { shadow: 0.8 });
      P.piece(rect(37.6, -2, 3.4, 11), 'stone', { shadow: 0.9, rim: 0.6 });
      scaffold(P, MILL_X0 - 6, MILL_X0 - 1.5, -lowH - upH - 2);
      plankPile(P, -26 - 6, 0, 3, 9);
      P.grain(-34, -52, 78, 66);
      return;
    }
    // finished
    const eaveY = -lowH - upH + 1;
    // chimney first, the roof overlaps its foot
    chimney(P, 4, -50, 4, 16, o.season);
    // stone storey
    wallBlock(P, MILL_X0, -lowH, MILL_W, lowH, 'stone');
    stoneCourses(P, MILL_X0, -lowH, MILL_W, lowH, 4.3, o.seed);
    plinth(P, MILL_X0, MILL_W, 2.2);
    // timber storey (a touch proud of the stone, like a jettied upper floor)
    wallBlock(P, MILL_X0 - 0.8, -lowH - upH, MILL_W + 1.6, upH);
    beams(P, MILL_X0 - 0.8, -lowH - upH, MILL_W + 1.6, upH);
    P.piece(rect(MILL_X0 - 1, -lowH - 0.6, MILL_W + 2, 1.4), 'woodDark', { shadow: 1, wobble: 0.4 });
    P.piece(rect(cx - 0.3, -lowH - upH, 0.6, upH), 'woodDark', { shadow: 0.5, wobble: 0.3 });
    P.line([[MILL_X0, -lowH - 1.5], [MILL_X0 + 4.5, -lowH - upH + 1.5]], 0.7, 'woodDark', { shadow: 0.4 });
    P.line([[MILL_X1, -lowH - 1.5], [MILL_X1 - 4.5, -lowH - upH + 1.5]], 0.7, 'woodDark', { shadow: 0.4 });
    gableRoof(P, cx, eaveY, 40, 18, 'roof', 'roofDeep', o.season);
    // openings
    door(P, -10, -12, 6, 12);
    windowPane(P, -1, -10.5, 4.5, 4.5);
    windowPane(P, -14.5, -26, 5.5, 5.5);
    windowPane(P, 3.5, -26, 5.5, 5.5);
    // loft hatch above the door with a hoist beam and a hanging sack
    P.piece(rect(-8.4, -26.2, 3.2, 3.8), 'woodDark', { shadow: 0.6, wobble: 0.2 });
    // sacks by the door
    P.piece(ellipse(-15.6, -2.5, 2.3, 2.6, 12), 'wallShade', { shadow: 0.9, rim: 0.6 });
    P.piece(ellipse(-13.2, -1.9, 1.9, 2.0, 12), 'wall', { shadow: 0.9, rim: 0.6 });
    P.piece(rect(-16.3, -5.3, 1.4, 0.6), 'woodDark', { shadow: 0, wobble: 0 });
    // race walls either side of the wheel
    P.piece(rect(MILL_X1, -1.4, 3.4, 10), 'stone', { shadow: 0.9, rim: 0.6 });
    P.piece(rect(37.6, -2, 3.6, 11), 'stone', { shadow: 0.9, rim: 0.6 });
    P.piece(rect(37.8, 2.4, 3.2, 0.45), 'stoneDark', { shadow: 0, wobble: 0.3, alpha: 0.55 });
    P.piece(rect(MILL_X1 + 0.2, 2.8, 3, 0.45), 'stoneDark', { shadow: 0, wobble: 0.3, alpha: 0.55 });
    // wooden flume from the house wall to the top of the wheel
    P.line([[13, -4], [22, -14.6]], 0.9, 'woodDark', { shadow: 0.6 });
    P.line([[13, -11], [18.5, -16.4]], 0.7, 'woodDark', { shadow: 0.5 });
    P.piece([[13, -19.4], [30, -14.6], [30, -12.2], [13, -17]], 'wood', { shadow: 1, rim: 0.8, wobble: 0.4 });
    P.line([[13.4, -19], [29.6, -14.3]], 0.85, 'riverLight', { shadow: 0, alpha: 0.9 });
    P.line([[15, -14.6], [15.2, -17.8]], 0.5, 'woodDark', { shadow: 0.3 });
    P.line([[22, -12.7], [22.2, -16]], 0.5, 'woodDark', { shadow: 0.3 });
    if (o.season === 'winter') snowOn(P, [[13, -19.7], [21, -17.4], [30, -14.9]], 0.9);
    // water falling from the flume lip onto the wheel
    P.piece(rect(28.5, -13.4, 1.5, 4.4), 'riverLight', { shadow: 0, alpha: 0.9, wobble: 0.5 });
    P.dot(30.9, -9.4, 0.5, 'riverLight');
    P.dot(27.3, -9.8, 0.4, 'riverLight');
    P.grain(-24, -54, 66, 68);
  },
  lit(P, stage) {
    if (stage < 3) return;
    litWindow(P, -1, -10.5, 4.5, 4.5);
    litWindow(P, -14.5, -26, 5.5, 5.5);
    litWindow(P, 3.5, -26, 5.5, 5.5);
  },
  points(stage) {
    return {
      chimney: stage === 3 ? [6, -52] : undefined,
      door: [-7, 0],
      work: [-30, 0],
      pivot: stage === 3 ? [26, 2] : undefined,
    };
  },
};

// ---------------------------------------------------------------- guesthouse (orchard)

function flowerBox(P: Paper, x: number, y: number, w: number): void {
  P.piece(rect(x - 0.8, y, w + 1.6, 1.6), 'wood', { shadow: 0.7 });
  const n = Math.max(3, Math.round(w / 1.6));
  for (let i = 0; i < n; i++) P.dot(x + 0.5 + (i * (w - 1)) / (n - 1), y - 0.5, 0.75, i % 3 === 0 ? 'scarf0' : i % 3 === 1 ? 'scarf2' : 'scarf4', 0.4);
}

const guesthouse: StructureDef = {
  kind: 'guesthouse',
  name: 'Guesthouse',
  w: 44,
  h: 50,
  stages: 3,
  zone: 'orchard',
  draw(P, stage, o) {
    const w = 32;
    const lowH = 13;
    const upW = 35;
    const upH = 12;
    if (stage === 1) {
      footing(P, w, o.seed);
      plankPile(P, -w / 2 - 6, 0, 3, 9);
      P.grain(-24, -14, 48, 18);
      return;
    }
    if (stage === 2) {
      // ground storey part-walled, both timber floors framed, bare rafters
      P.piece(rect(-w / 2, -lowH * 0.55, w, lowH * 0.55), 'wall', { rim: 1, shadow: 1 });
      plinth(P, -w / 2, w, 2.2);
      for (let i = 0; i <= 4; i++) {
        const x = -w / 2 + (w * i) / 4;
        P.line([[x, 0], [x, -lowH - upH]], 1, 'wood', { shadow: 0.9 });
      }
      P.line([[-w / 2 - 1, -lowH], [w / 2 + 1, -lowH]], 1.1, 'wood', { shadow: 0.9 });
      P.line([[-upW / 2 - 1, -lowH - upH], [upW / 2 + 1, -lowH - upH]], 1.1, 'wood', { shadow: 0.9 });
      roofFrame(P, 0, -lowH - upH, upW / 2 + 3, 18);
      scaffold(P, w / 2 + 3, w / 2 + 7.5, -lowH - upH - 3);
      plankPile(P, -w / 2 - 6, 0, 3, 9);
      P.grain(-26, -48, 56, 52);
      return;
    }
    // finished: chimney, ground storey, jettied upper storey, slate roof, dormer
    chimney(P, 11, -48, 4, 16, o.season);
    wallBlock(P, -w / 2, -lowH, w, lowH);
    beams(P, -w / 2, -lowH, w, lowH);
    plinth(P, -w / 2, w);
    // upper storey, slightly proud of the ground floor
    wallBlock(P, -upW / 2, -lowH - upH, upW, upH);
    beams(P, -upW / 2, -lowH - upH, upW, upH);
    P.piece(rect(-upW / 2 - 0.4, -lowH - 1.2, upW + 0.8, 1.6), 'woodDark', { shadow: 1, wobble: 0.4 });
    P.piece(rect(-0.3, -lowH - upH, 0.6, upH - 1.2), 'woodDark', { shadow: 0.5, wobble: 0.3 });
    // corner braces
    P.line([[-upW / 2 + 0.6, -lowH - 1.6], [-upW / 2 + 4, -lowH - upH + 1.6]], 0.7, 'woodDark', { shadow: 0.4 });
    P.line([[upW / 2 - 0.6, -lowH - 1.6], [upW / 2 - 4, -lowH - upH + 1.6]], 0.7, 'woodDark', { shadow: 0.4 });
    P.line([[-w / 2 + 0.6, -1.6], [-w / 2 + 3, -lowH + 1.6]], 0.7, 'woodDark', { shadow: 0.4 });
    gableRoof(P, 0, -lowH - upH + 1, 42, 18, 'roofSlate', 'roofSlateDeep', o.season);
    // dormer
    P.piece(rect(-4.5, -35, 9, 7), 'wall', { shadow: 1, rim: 0.8 });
    windowPane(P, -2, -33.8, 4, 4.2);
    P.piece([[-5.8, -34.6], [0, -41.2], [5.8, -34.6]], 'roofSlateDeep', { shadow: 1.1, rim: 1, wobble: 0.4 });
    if (o.season === 'winter') snowOn(P, [[-5.8, -34.6], [0, -41.2], [5.8, -34.6]], 1.1);
    // door with a hanging lantern beside it
    door(P, -12, -12, 6, 12);
    P.line([[-4.4, -12.4], [-1.4, -12.4]], 0.5, 'woodDark', { shadow: 0.4 });
    P.line([[-1.8, -12.4], [-1.8, -11.2]], 0.3, 'woodDark', { shadow: 0 });
    P.piece(rect(-3, -11.2, 2.4, 3.6), 'woodDark', { shadow: 0.7, wobble: 0.1 });
    P.piece(rect(-2.5, -10.7, 1.4, 2.4), 'windowDark', { shadow: 0, wobble: 0 });
    // windows and flower boxes
    windowPane(P, 4.75, -10.8, 5.5, 5.5);
    flowerBox(P, 4.75, -4.6, 5.5);
    for (const x of [-10.25, 4.75]) {
      windowPane(P, x, -23.5, 5.5, 5.5);
      flowerBox(P, x, -16.4, 5.5);
    }
    P.grain(-24, -50, 48, 54);
  },
  lit(P, stage) {
    if (stage < 3) return;
    litWindow(P, 4.75, -10.8, 5.5, 5.5);
    litWindow(P, -10.25, -23.5, 5.5, 5.5);
    litWindow(P, 4.75, -23.5, 5.5, 5.5);
    litWindow(P, -2, -33.8, 4, 4.2);
    // the lantern by the door
    P.glow(-1.8, -9.5, 7, 'lampGlow', 0.55);
    P.piece(rect(-2.5, -10.7, 1.4, 2.4), 'lampGlow', { shadow: 0, wobble: 0 });
  },
  points(stage) {
    return { chimney: stage === 3 ? [13, -50] : undefined, door: [-9, 0], work: [-25, 0] };
  },
};

// ---------------------------------------------------------------- belltower (commons)

const belltower: StructureDef = {
  kind: 'belltower',
  name: 'Bell tower',
  w: 26,
  h: 64,
  stages: 3,
  zone: 'commons',
  draw(P, stage, o) {
    const bw = 22;
    if (stage === 1) {
      footing(P, bw, o.seed);
      stonePile(P, -18, 0, 6, o.seed + 5);
      P.grain(-24, -10, 48, 14);
      return;
    }
    if (stage === 2) {
      // stone base only, still ragged along the top; scaffold up the side
      wallBlock(P, -bw / 2, -17, bw, 17, 'stone');
      // uneven top courses
      P.piece(rect(-bw / 2, -20, 8.5, 3.4), 'stone', { shadow: 0.9, rim: 0.7, wobble: 0.5 });
      P.piece(rect(-bw / 2 + 8.5, -18.6, 6, 2), 'stoneLight', { shadow: 0.9, rim: 0.7, wobble: 0.5 });
      P.piece(rect(bw / 2 - 4.5, -21, 4.5, 4.4), 'stone', { shadow: 0.9, rim: 0.7, wobble: 0.5 });
      stoneCourses(P, -bw / 2, -17, bw, 17, 4.3, o.seed);
      plinth(P, -bw / 2, bw, 2.4);
      P.piece(roundRect(-3, -12, 6, 12, [3, 3, 0, 0]), 'windowDark', { shadow: 0.9, wobble: 0.2 });
      scaffold(P, bw / 2 + 2.5, bw / 2 + 7, -26);
      stonePile(P, -19, 0, 5, o.seed + 5);
      P.grain(-22, -28, 52, 32);
      return;
    }
    // finished: stone base with arched door, timber belfry with open arch, slate pyramid, flag pole
    // pole first, the roof overlaps its foot
    P.line([[0, -48.5], [0, -64.5]], 0.9, 'woodDark', { shadow: 0.6 });
    P.dot(0, -64.8, 1.2, 'woodDark', 0.8);
    // belfry: dark interior, then the timber frame with the arch cut out of it
    const arch: Pt[] = [[-5.5, -23.5], [-5.5, -33], ...ellipse(0, -33, 5.5, 5, 14, Math.PI, Math.PI * 2), [5.5, -33], [5.5, -23.5]];
    P.piece(rect(-10, -40, 20, 17), mix(tok('woodDark'), tok('ink'), 0.5), { shadow: 0, wobble: 0 });
    P.piece(rect(-10, -40, 20, 17), 'wood', { shadow: 1.1, rim: 0.8, wobble: 0.4, holes: [arch] });
    for (const x of [-8.1, 8.1]) P.piece(rect(x - 0.3, -39, 0.6, 15), 'woodDark', { shadow: 0, wobble: 0.2, alpha: 0.35 });
    for (const sx of [-1, 1]) {
      P.piece(rect(sx < 0 ? -10.4 : 8.6, -40.2, 1.8, 17.2), 'woodDark', { shadow: 0.9, rim: 0.4, wobble: 0.3 });
      P.line([[sx * 5.6, -36.6], [sx * 8.6, -39.4]], 0.6, 'woodDark', { shadow: 0.4 });
    }
    P.line([[-5.6, -37.4], [5.6, -37.4]], 0.9, 'woodDark', { shadow: 0.6 });
    // stone base
    wallBlock(P, -bw / 2, -22, bw, 22, 'stone');
    stoneCourses(P, -bw / 2, -22, bw, 22, 4.4, o.seed);
    plinth(P, -bw / 2, bw, 2.4);
    P.piece(rect(-bw / 2 - 1.6, -23.6, bw + 3.2, 2.2), 'stoneLight', { shadow: 1.1, rim: 1, wobble: 0.3 });
    P.piece(rect(-6.6, -23.4, 13.2, 1), 'wood', { shadow: 0.7, wobble: 0.2 });
    door(P, -3, -12, 6, 12);
    P.piece(rect(-4.2, -0.9, 8.4, 1), 'stoneLight', { shadow: 0.7, rim: 0.5, wobble: 0.3 });
    windowPane(P, -1.4, -20, 2.8, 5, true);
    // slate pyramid
    const roofPts: Pt[] = [[-12.6, -39.4], [0, -50], [12.6, -39.4]];
    P.piece(roofPts, 'roofSlate', { rim: 1.2, shadow: 1.3 });
    P.piece([[0, -50], [12.6, -39.4], [4.6, -39.4]], 'roofSlateDeep', { shadow: 0.4, wobble: 0.4 });
    for (let i = 1; i < 4; i++) {
      const t = i / 4;
      const hw = 12.6 * (1 - t);
      P.piece(rect(-hw + 0.4, -39.4 - 10.6 * t, hw * 2 - 0.8, 0.5), mix(tok('roofSlate'), tok('roofSlateDeep'), 0.6), { shadow: 0, wobble: 0.3 });
    }
    P.piece(rect(-13, -40.8, 26, 1.6), 'roofSlateDeep', { shadow: 0.9, wobble: 0.4 });
    if (o.season === 'winter') {
      snowOn(P, roofPts, 1.5);
      snowOn(P, [[-bw / 2 - 1.6, -23.6], [bw / 2 + 1.6, -23.6]], 1);
    }
    // wall lantern by the door
    P.line([[7.4, -12.4], [7.4, -11.2]], 0.3, 'woodDark', { shadow: 0 });
    P.piece(rect(6.2, -11.2, 2.4, 3.2), 'woodDark', { shadow: 0.7, wobble: 0.1 });
    P.piece(rect(6.7, -10.7, 1.4, 2.2), 'windowDark', { shadow: 0, wobble: 0 });
    P.grain(-15, -66, 30, 68);
  },
  lit(P, stage) {
    if (stage < 3) return;
    P.glow(0, -17.5, 7, 'lampGlow', 0.4);
    P.piece(roundRect(-1.4, -20, 2.8, 5, [1.4, 1.4, 0, 0]), 'lampGlow', { shadow: 0, wobble: 0 });
    P.glow(7.4, -9, 6.5, 'lampGlow', 0.55);
    P.piece(rect(6.7, -10.7, 1.4, 2.2), 'lampGlow', { shadow: 0, wobble: 0 });
  },
  points(stage) {
    return stage === 3
      ? { bell: [0, -36.4], flag: [0, -64], door: [0, 0], work: [-17, 0] }
      : { door: [0, 0], work: [-17, 0] };
  },
};

// ---------------------------------------------------------------- bakery (orchard)

const bakery: StructureDef = {
  kind: 'bakery',
  name: 'Bakery',
  w: 48,
  h: 46,
  stages: 3,
  zone: 'orchard',
  draw(P, stage, o) {
    const x0 = -20;
    const w = 26;
    const wallH = 21;
    const roofH = 22;
    const bodyCx = x0 + w / 2;
    if (stage === 1) {
      P.at(bodyCx, 0, 0, () => footing(P, w, o.seed));
      stonePile(P, 17, 0, 6, o.seed + 2);
      P.grain(-30, -10, 60, 14);
      return;
    }
    if (stage === 2) {
      // timber frame for the body, the oven's stone ring half-built
      P.at(bodyCx, 0, 0, () => {
        P.piece(rect(-w / 2, -wallH * 0.45, w, wallH * 0.45), 'wall', { rim: 1, shadow: 1 });
        plinth(P, -w / 2, w, 2.2);
        for (let i = 0; i <= 4; i++) {
          const x = -w / 2 + (w * i) / 4;
          P.line([[x, 0], [x, -wallH]], 1, 'wood', { shadow: 0.9 });
        }
        P.line([[-w / 2 - 1, -wallH], [w / 2 + 1, -wallH]], 1.1, 'wood', { shadow: 0.9 });
        roofFrame(P, 0, -wallH, w / 2 + 2, roofH);
      });
      P.piece([...ellipse(15, 0, 9, 7, 16, Math.PI, Math.PI * 2)], 'stone', { shadow: 1, rim: 0.8, wobble: 0.5 });
      P.piece(rect(5, -1.8, 20, 1.8), 'stoneDark', { shadow: 0.8, rim: 0.6 });
      scaffold(P, -31, -26.5, -wallH - 4);
      plankPile(P, 30, 0, 3, 9);
      P.grain(-34, -48, 74, 52);
      return;
    }
    // finished
    // oven chimney first (the dome overlaps its foot)
    chimney(P, 13.6, -24, 3.8, 14, o.season);
    wallBlock(P, x0, -wallH, w, wallH);
    beams(P, x0, -wallH, w, wallH);
    plinth(P, x0, w);
    gableRoof(P, bodyCx - 1, -wallH + 1, 34, roofH, 'roofThatch', 'roofThatchDeep', o.season);
    // round attic window in the gable
    P.dot(bodyCx - 1, -29.5, 2.7, 'woodDark', 0.6);
    P.dot(bodyCx - 1, -29.5, 1.9, 'windowDark');
    // door and windows
    door(P, -8, -12, 6, 12);
    windowPane(P, -17.5, -16, 5.5, 5.5);
    windowPane(P, 0.5, -16, 5.5, 5.5);
    // the oven: stone dome with courses, a mouth and a base ring
    const dome: Pt[] = ellipse(15, 0, 9, 12.5, 26, Math.PI, Math.PI * 2);
    P.piece(dome, 'stone', { shadow: 1.2, rim: 1, wobble: 0.5 });
    for (const k of [0.74, 0.48]) P.line(ellipse(15, 0, 9 * k, 12.5 * k, 16, Math.PI * 1.04, Math.PI * 1.96), 0.4, 'stoneDark', { shadow: 0, alpha: 0.6 });
    for (const a of [1.22, 1.38, 1.62, 1.78]) {
      const ca = Math.cos(Math.PI * a);
      const sa = Math.sin(Math.PI * a);
      P.line([[15 + ca * 4.4, sa * 6.2], [15 + ca * 8.8, sa * 12.2]], 0.35, 'stoneDark', { shadow: 0, alpha: 0.5 });
    }
    P.piece(rect(5.2, -2, 19.6, 2), 'stoneDark', { shadow: 0.9, rim: 0.6, wobble: 0.3 });
    P.piece(roundRect(11.7, -7, 6.6, 7, [3.3, 3.3, 0, 0]), 'stoneLight', { shadow: 0.8, rim: 0.6, wobble: 0.2 });
    P.piece(roundRect(12.6, -6.2, 4.8, 6.2, [2.4, 2.4, 0, 0]), 'windowDark', { shadow: 0.7, wobble: 0.1 });
    if (o.season === 'winter') snowOn(P, ellipse(15, 0, 9, 12.5, 10, Math.PI * 1.22, Math.PI * 1.78), 1.4);
    // pretzel sign on a bracket at the left corner
    P.line([[-20.6, -17.6], [-26.8, -17.6]], 0.8, 'woodDark', { shadow: 0.5 });
    P.line([[-20.6, -14.6], [-24.4, -17.6]], 0.6, 'woodDark', { shadow: 0.4 });
    P.line([[-26.2, -17.4], [-26.2, -15.6]], 0.3, 'woodDark', { shadow: 0 });
    P.line([[-21.8, -17.4], [-21.8, -15.6]], 0.3, 'woodDark', { shadow: 0 });
    P.piece(roundRect(-27.8, -15.6, 7, 6.6, 1.2), 'woodLight', { shadow: 1, rim: 0.8 });
    P.piece(ellipse(-24.3, -12.1, 2.7, 2.2, 16), 'roofThatchDeep', { shadow: 0.5, wobble: 0.3, holes: [ellipse(-24.3, -12.1, 1.5, 1.1, 10)] });
    P.line([[-25.8, -11], [-22.8, -13.2]], 0.55, 'roofThatchDeep', { shadow: 0.3 });
    P.line([[-25.8, -13.2], [-22.8, -11]], 0.55, 'roofThatchDeep', { shadow: 0.3 });
    // bench with loaves
    P.line([[-18.5, 0], [-18.5, -3.8]], 0.9, 'woodDark', { shadow: 0.6 });
    P.line([[-9.5, 0], [-9.5, -3.8]], 0.9, 'woodDark', { shadow: 0.6 });
    P.piece(rect(-19.8, -4.8, 11.6, 1.4), 'wood', { shadow: 0.9, rim: 0.6 });
    P.piece(ellipse(-16.6, -6, 2.3, 1.3, 12), 'roofThatch', { shadow: 0.7, rim: 0.6 });
    P.piece(ellipse(-12.4, -6, 2.0, 1.3, 12), 'woodLight', { shadow: 0.7, rim: 0.6 });
    P.dot(-9.9, -6, 1.2, 'roofThatch', 0.6);
    for (const x of [-17.4, -16.6, -15.8]) P.line([[x, -6.6], [x + 0.5, -5.5]], 0.25, 'roofThatchDeep', { shadow: 0, alpha: 0.9 });
    P.grain(-31, -48, 62, 52);
  },
  lit(P, stage) {
    if (stage < 3) return;
    litWindow(P, -17.5, -16, 5.5, 5.5);
    litWindow(P, 0.5, -16, 5.5, 5.5);
    // attic window and the glowing oven mouth
    P.glow(-8, -29.5, 6, 'lampGlow', 0.4);
    P.piece(circle(-8, -29.5, 1.9, 10), 'lampGlow', { shadow: 0, wobble: 0 });
    P.glow(15, -3.4, 12, 'lampGlow', 0.5);
    P.piece(roundRect(12.6, -6.2, 4.8, 6.2, [2.4, 2.4, 0, 0]), 'ember', { shadow: 0, wobble: 0.1 });
    P.piece([[13.4, -0.4], [14.2, -3.8], [15, -2], [15.8, -4.6], [16.6, -0.4]], 'flame', { shadow: 0, wobble: 0.3 });
    P.piece([[14.4, -0.4], [15, -2.4], [15.8, -0.4]], 'lampGlow', { shadow: 0, wobble: 0.2 });
  },
  points(stage) {
    return { chimney: stage === 3 ? [15.5, -26] : undefined, door: [-5, 0], work: [29, 0] };
  },
};

// ---------------------------------------------------------------- markethall (orchard)

const MARKET_PITCH = 12;
const MARKET_BAYS = [-24, -12, 0, 12, 24];
const MARKET_PIERS = [-30, -18, -6, 6, 18, 30];

/** Outline of a round-arched opening, half-width hw, spring line at -13, base on the ground. */
function archOutline(cx: number, hw: number): Pt[] {
  return [[cx - hw, 0], [cx - hw, -13], ...ellipse(cx, -13, hw, hw, 14, Math.PI, Math.PI * 2), [cx + hw, -13], [cx + hw, 0]];
}

/** The arcade: dark back wall, stalls, the stone face with arches cut out, archivolts, capitals. */
function arcade(P: Paper, withStalls: boolean): void {
  P.piece(rect(-32, -23, 64, 23), mix(tok('woodDark'), tok('ink'), 0.35), { shadow: 0, wobble: 0 });
  if (withStalls) {
    MARKET_BAYS.forEach((cx, i) => {
      // awning flap hanging inside the arch
      const flap: Pt[] = [[cx - 4.3, -13.6], [cx + 4.3, -13.6], [cx + 4.3, -11.2]];
      for (let k = 4; k >= 0; k--) flap.push([cx - 4.3 + (k + 0.5) * 1.72, -9.6], [cx - 4.3 + k * 1.72, -11.2]);
      P.piece(flap, SCARVES[(i * 2 + 1) % SCARVES.length], { shadow: 0.8, wobble: 0.3 });
      // counter
      P.piece(rect(cx - 3.6, -4.2, 7.2, 4.2), 'wood', { shadow: 1, rim: 0.4, wobble: 0.3 });
      P.piece(rect(cx - 3.9, -5, 7.8, 1), 'woodLight', { shadow: 0.8, rim: 0.7, wobble: 0.3 });
      if (i === 0 || i === 4) {
        pumpkin(P, cx - 2.2, -6.5);
        pumpkin(P, cx + 0.2, -6.4, 1.8);
        pumpkin(P, cx + 2.5, -6.3, 1.5);
        pumpkin(P, cx - 0.9, -8.3, 1.3);
      } else if (i === 1) {
        P.piece(rect(cx - 3, -7.2, 6, 2.4), 'woodLight', { shadow: 0.7, rim: 0.4, wobble: 0.3 });
        for (let k = 0; k < 6; k++) apple(P, cx - 2.5 + k * 1.0, -7.6 - (k % 2) * 0.6);
        for (let k = 0; k < 4; k++) apple(P, cx - 1.6 + k * 1.1, -8.6 - (k % 2) * 0.4);
      } else if (i === 2) {
        cabbage(P, cx - 2.4, -6.5);
        cabbage(P, cx + 0.3, -6.7, 1.7);
        cabbage(P, cx + 2.6, -6.4, 1.4);
        cabbage(P, cx - 1, -8.5, 1.3);
      } else {
        pumpkin(P, cx - 2.4, -6.4, 1.5);
        for (let k = 0; k < 4; k++) apple(P, cx + 0.2 + k * 1.1, -5.9 - (k % 2) * 0.7);
        cabbage(P, cx + 0.6, -8, 1.3);
      }
    });
  }
  // stone face with the arched openings cut through it
  P.piece(rect(-32, -23, 64, 23), 'stone', { shadow: 1.2, rim: 1, wobble: 0.4, holes: MARKET_BAYS.map((cx) => archOutline(cx, 4.2)) });
  // archivolts: lighter stone rims around each opening
  for (const cx of MARKET_BAYS) {
    P.piece(archOutline(cx, 5.2), 'stoneLight', { shadow: 0.7, rim: 0.8, wobble: 0.3, holes: [archOutline(cx, 4.2)] });
    P.piece(rect(cx - 1, -19.6, 2, 2.6), 'stoneLight', { shadow: 0.6, rim: 0.6, wobble: 0.2 });
  }
  // pier capitals and bases
  for (const px of MARKET_PIERS) {
    P.piece(rect(px - 2.4, -1.8, 4.8, 1.8), 'stoneDark', { shadow: 0.8, rim: 0.5, wobble: 0.3 });
    P.piece(rect(px - 2.2, -22.2, 4.4, 1.3), 'stoneDark', { shadow: 0.5, wobble: 0.3, alpha: 0.5 });
  }
}

const markethall: StructureDef = {
  kind: 'markethall',
  name: 'Market hall',
  w: 76,
  h: 50,
  stages: 3,
  zone: 'orchard',
  draw(P, stage, o) {
    const faceTop = -23;
    if (stage === 1) {
      footing(P, 64, o.seed);
      for (const px of MARKET_PIERS) P.piece(rect(px - 1.9, -4.6, 3.8, 4.6), px % 12 ? 'stone' : 'stoneDark', { shadow: 0.9, rim: 0.6, wobble: 0.4 });
      stonePile(P, 8, 0, 6, o.seed + 1);
      P.grain(-36, -12, 72, 16);
      return;
    }
    if (stage === 2) {
      // columns and arches up, cornice on, no roof yet: bare trusses and a scaffold
      arcade(P, false);
      P.piece(rect(-33.6, faceTop - 2, 67.2, 2.6), 'stoneLight', { shadow: 1.1, rim: 1, wobble: 0.3 });
      P.line([[-35, faceTop - 2.4], [35, faceTop - 2.4]], 1.2, 'wood', { shadow: 0.9 });
      for (const x of [-24, 0, 24]) {
        P.line([[x - 11, faceTop - 2.4], [x, faceTop - 12]], 0.9, 'wood', { shadow: 0.8 });
        P.line([[x + 11, faceTop - 2.4], [x, faceTop - 12]], 0.9, 'wood', { shadow: 0.8 });
        P.line([[x, faceTop - 2.4], [x, faceTop - 12]], 0.8, 'woodLight', { shadow: 0.6 });
      }
      P.line([[-24, faceTop - 12], [24, faceTop - 12]], 0.8, 'woodLight', { shadow: 0.6 });
      scaffold(P, 35, 39.5, -30);
      plankPile(P, -37, 0, 3, 9);
      P.grain(-42, -40, 86, 44);
      return;
    }
    // finished
    arcade(P, true);
    P.piece(rect(-33.6, faceTop - 2, 67.2, 2.6), 'stoneLight', { shadow: 1.1, rim: 1, wobble: 0.3 });
    // clock gable first, the roof overlaps its foot
    gableRoof(P, 0, faceTop - 2, 76, 15, 'roof', 'roofDeep', o.season);
    P.piece(rect(-6.8, -41.5, 13.6, 9.8), 'wall', { shadow: 1, rim: 0.8 });
    P.piece(rect(-6.8, -33.2, 13.6, 1.1), 'woodDark', { shadow: 0.7, wobble: 0.3 });
    const gable: Pt[] = [[-8.4, -41.3], [0, -50], [8.4, -41.3]];
    P.piece(gable, 'roofDeep', { shadow: 1.1, rim: 1, wobble: 0.4 });
    if (o.season === 'winter') snowOn(P, gable, 1.2);
    P.dot(0, -37.4, 3.7, 'woodDark', 0.7);
    P.dot(0, -37.4, 3.1, 'cream');
    P.line([[0, -37.4], [0, -39.6]], 0.4, 'ink', { shadow: 0 });
    P.line([[0, -37.4], [1.7, -36.9]], 0.4, 'ink', { shadow: 0 });
    // bunting along the eaves, lanterns on the inner piers
    for (let i = 0; i < MARKET_PIERS.length - 1; i++) bunting(P, MARKET_PIERS[i], -21.6, MARKET_PIERS[i + 1], -21.6, 1.7, 3, i * 3);
    for (const px of MARKET_PIERS.slice(1, 5)) {
      P.line([[px, -21.8], [px, -20.6]], 0.3, 'woodDark', { shadow: 0 });
      P.piece(rect(px - 1.2, -20.6, 2.4, 3.4), 'woodDark', { shadow: 0.7, wobble: 0.1 });
      P.piece(rect(px - 0.7, -20.1, 1.4, 2.4), 'windowDark', { shadow: 0, wobble: 0 });
    }
    P.grain(-40, -52, 80, 56);
  },
  lit(P, stage) {
    if (stage < 3) return;
    for (const px of MARKET_PIERS.slice(1, 5)) {
      P.glow(px, -18.9, 8, 'lampGlow', 0.55);
      P.piece(rect(px - 0.7, -20.1, 1.4, 2.4), 'lampGlow', { shadow: 0, wobble: 0 });
    }
    // the clock face glows faintly
    P.glow(0, -37.4, 6, 'lampGlow', 0.3);
  },
  points() {
    return { door: [0, 0], work: [44, 0] };
  },
};

export const STRUCTURES_B: StructureDef[] = [jetty, watermill, guesthouse, belltower, bakery, markethall];
