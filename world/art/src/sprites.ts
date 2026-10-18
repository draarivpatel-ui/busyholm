/**
 * Sprite registry: every rasterised piece of the strip, with its local bounds in units.
 * Ids:
 *   st/<kind>/<stage>        structure stage (base, tinted by the sky light)
 *   st/<kind>/<stage>/lit    emissive windows and lamps for that stage (alpha = sky.lamps)
 *   st/<kind>/part           rotating part (sails, waterwheel), origin at its pivot
 *   res/<species>/<pose>     resident pose frame (see residents.ts posesFor)
 *   res/<species>/<pose>/scarf   white scarf overlay, tinted per instance
 *   hlp/<species>/<pose>(/scarf) subagent helper at 0.55 scale
 *   tree/<kind>/<i>, bush/<i>, deco/<kind>
 *   alert/flag/<question|permission|none>/<0..2>, alert/flag-furled, alert/bell/<-1|0|1>
 *   fx/smoke/<0..2>, fx/dust, fx/plank, fx/confetti, fx/glow, fx/lantern-glow
 *   wx/rain, wx/snow, wx/leaf/<0..1>, cloud/<0..3>
 *   glyph/<0-9|+|!>          Fraunces numerals for signboards (ink)
 */
import { Paper, blob } from './paper.ts';
import { tok, mix } from './color.ts';
import { STRUCTURES, type Stage, type StructureDef } from './structures.ts';
import { SPECIES, posesFor, drawResident, residentBounds } from './residents.ts';
import { villageTree, fruitTree, bush, decoration, smokePuff, dustPuff, flyingPlank, confetti, leaf, type DecoKind } from './props.ts';
import { drawFlag, drawFlagFurled, drawBell, drawBellRest, type AlertIcon } from './alert.ts';
import type { Season } from './terrain.ts';
import { SIZES } from './tokens.ts';

export interface SpriteDef {
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  seed?: number;
  draw(P: Paper): void;
}

const BELOW = new Set(['jetty', 'watermill', 'footbridge']);

export function structureBounds(def: StructureDef): [number, number, number, number] {
  const y1 = BELOW.has(def.kind) ? 33 : 4;
  return [-def.w / 2 - 10, -Math.min(SIZES.structureMaxHeight + 2, def.h + 10), def.w / 2 + 10, y1];
}

/** Helper poses (subagents follow their parent). */
export const HELPER_POSES = ['stand-0', 'walk-0', 'walk-1', 'carry-0', 'carry-1', 'work-0', 'work-1', 'cheer-0', 'sleep-0'];

export function stripSprites(season: Season): SpriteDef[] {
  const out: SpriteDef[] = [];
  // structures
  let si = 0;
  for (const def of Object.values(STRUCTURES)) {
    if (!def) continue;
    si++;
    const [x0, y0, x1, y1] = structureBounds(def);
    const stages = def.stages === 3 ? [1, 2, 3] : [1];
    for (const st of stages) {
      const seed = 1000 + si * 10 + st;
      const o = { season, seed: si * 31 + 7, variant: 0 };
      out.push({ id: `st/${def.kind}/${st}`, x0, y0, x1, y1, seed, draw: (P) => def.draw(P, st as Stage, o) });
      if (def.kind === 'cottage' && st === 3) {
        out.push({ id: `st/${def.kind}/3/v1`, x0, y0, x1, y1, seed, draw: (P) => def.draw(P, 3, { ...o, variant: 1 }) });
      }
      if (def.lit && (st === 3 || def.stages === 1)) {
        for (const f of def.kind === 'campfire' ? [0, 1, 2, 3] : [0]) {
          const id = def.kind === 'campfire' ? `st/${def.kind}/${st}/lit/${f}` : `st/${def.kind}/${st}/lit`;
          out.push({ id, x0, y0, x1, y1, seed, draw: (P) => def.lit!(P, st as Stage, { ...o, frame: f }) });
        }
      }
    }
    if (def.part) {
      const r = def.part.r + 2;
      out.push({ id: `st/${def.kind}/part`, x0: -r, y0: -r, x1: r, y1: r, seed: 1, draw: (P) => def.part!.draw(P, { season, seed: 3 }) });
    }
  }
  // residents and helpers
  for (const sp of SPECIES) {
    const b = residentBounds(sp);
    const poses = posesFor(sp);
    for (const [key, pose] of Object.entries(poses)) {
      out.push({ id: `res/${sp}/${key}`, ...b, seed: 101, draw: (P) => drawResident(P, sp, pose, 'base') });
      out.push({ id: `res/${sp}/${key}/scarf`, ...b, seed: 101, draw: (P) => drawResident(P, sp, pose, 'scarf') });
    }
    const hs = SIZES.helperScale;
    for (const key of HELPER_POSES) {
      const pose = poses[key];
      const hb = { x0: b.x0 * hs, y0: b.y0 * hs, x1: b.x1 * hs, y1: b.y1 * hs };
      out.push({ id: `hlp/${sp}/${key}`, ...hb, seed: 101, draw: (P) => P.at(0, 0, 0, () => drawResident(scaled(P, hs), sp, pose, 'base'), hs) });
      out.push({ id: `hlp/${sp}/${key}/scarf`, ...hb, seed: 101, draw: (P) => P.at(0, 0, 0, () => drawResident(scaled(P, hs), sp, pose, 'scarf'), hs) });
    }
  }
  // trees, bushes, decorations
  const treeH = [46, 38, 52];
  treeH.forEach((h, i) => out.push({ id: `tree/broad/${i}`, x0: -h * 0.5, y0: -h - 4, x1: h * 0.5, y1: 3, seed: 300 + i, draw: (P) => villageTree(P, h, 300 + i * 7, season, 'broad') }));
  [40, 30].forEach((h, i) => out.push({ id: `tree/conifer/${i}`, x0: -h * 0.42, y0: -h - 3, x1: h * 0.42, y1: 2, seed: 320 + i, draw: (P) => villageTree(P, h, 320 + i, season, 'conifer') }));
  [28, 24, 31].forEach((h, i) => out.push({ id: `tree/fruit/${i}`, x0: -h * 0.5, y0: -h - 3, x1: h * 0.5, y1: 2, seed: 330 + i, draw: (P) => fruitTree(P, h, 330 + i * 3, season) }));
  [10, 14, 8].forEach((w, i) => out.push({ id: `bush/${i}`, x0: -w * 0.7, y0: -w, x1: w * 0.7, y1: 2, seed: 340 + i, draw: (P) => bush(P, w, 340 + i * 5, season) }));
  const decos: DecoKind[] = ['bench', 'lamppost', 'flowers', 'birdhouse', 'pumpkins', 'snowman', 'hammock', 'crate', 'bunting'];
  for (const k of decos) out.push({ id: `deco/${k}`, x0: -22, y0: -25, x1: 22, y1: 2, seed: 360, draw: (P) => decoration(P, k, 361, season) });
  // alert sprites (emissive, drawn after lighting)
  for (const icon of ['question', 'permission', 'none'] as AlertIcon[])
    for (let w = 0; w < 3; w++) out.push({ id: `alert/flag/${icon}/${w}`, x0: -2.5, y0: -3.5, x1: 16.5, y1: 13.5, seed: 5, draw: (P) => drawFlag(P, icon, w) });
  out.push({ id: 'alert/flag-furled', x0: -1, y0: -1, x1: 4, y1: 8, seed: 5, draw: (P) => drawFlagFurled(P) });
  out.push({ id: 'alert/bell-rest', x0: -6, y0: -1, x1: 6, y1: 28, seed: 5, draw: (P) => drawBellRest(P) });
  for (const s of [-1, 0, 1]) out.push({ id: `alert/bell/${s}`, x0: -9, y0: -2, x1: 9, y1: 13, seed: 5, draw: (P) => drawBell(P, s) });
  // effects
  [3, 4.5, 6].forEach((s, i) => out.push({ id: `fx/smoke/${i}`, x0: -s * 1.4, y0: -s * 1.2, x1: s * 1.4, y1: s * 1.2, seed: 400 + i, draw: (P) => smokePuff(P, s, 400 + i) }));
  out.push({ id: 'fx/dust', x0: -26, y0: -14, x1: 26, y1: 2, seed: 410, draw: (P) => dustPuff(P, 40, 410) });
  out.push({ id: 'fx/plank', x0: -8, y0: -3, x1: 8, y1: 3, seed: 411, draw: (P) => flyingPlank(P) });
  out.push({ id: 'fx/confetti', x0: -16, y0: -16, x1: 16, y1: 2, seed: 412, draw: (P) => confetti(P, 28, 412) });
  out.push({ id: 'fx/glow', x0: -12, y0: -12, x1: 12, y1: 12, seed: 413, draw: (P) => P.glow(0, 0, 12, 'lampGlow', 0.9) });
  // weather particles
  out.push({ id: 'wx/snow', x0: -1.2, y0: -1.2, x1: 1.2, y1: 1.2, seed: 420, draw: (P) => P.piece(blob(0, 0, 0.8, 0.8, 4, 5, 0.2), 'snow', { shadow: 0.3, wobble: 0 }) });
  out.push({ id: 'wx/leaf/0', x0: -2, y0: -2, x1: 2, y1: 2, seed: 421, draw: (P) => leaf(P, 0, 0, 0, 1.5, 'leafAmber') });
  out.push({ id: 'wx/leaf/1', x0: -2, y0: -2, x1: 2, y1: 2, seed: 422, draw: (P) => leaf(P, 0, 0, 0, 1.3, 'leafRust') });
  // clouds
  for (let i = 0; i < 4; i++) {
    const w = 22 + i * 8;
    out.push({
      id: `cloud/${i}`,
      x0: -w * 0.6,
      y0: -w * 0.3,
      x1: w * 0.6,
      y1: w * 0.2,
      seed: 430 + i,
      draw: (P) => {
        P.piece(blob(0, 0, w / 2, w * 0.13, 430 + i, 6, 0.42, true), mix(tok('cream'), tok('stoneLight'), 0.3), { rim: 1, shadow: 0.6 });
        P.piece(blob(-w * 0.1, -w * 0.06, w * 0.28, w * 0.15, 431 + i, 5, 0.4, true), 'cream', { rim: 1, shadow: 0.7 });
        P.grain(-w * 0.6, -w * 0.3, w * 1.2, w * 0.5);
      },
    });
  }
  // signboard glyphs (Fraunces if loaded, serif fallback)
  for (const c of '0123456789+!') out.push({ id: `glyph/${c}`, x0: -3, y0: -4, x1: 3, y1: 4, seed: 1, draw: (P) => P.text(c, 0, 0.2, 6.4, 'ink', 700) });
  return out;
}

/** A Paper whose shadow scale matches a nested scale transform (helpers drawn at 0.55). */
function scaled(P: Paper, s: number): Paper {
  const Q = new Paper(P.ctx, P.scale * s, P.seed);
  Q.flat = P.flat;
  Q.shadowGain = P.shadowGain;
  return Q;
}
