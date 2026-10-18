/**
 * World v1 to a placed village: structures at their canonical slots (SPEC 4.1, art kit SLOT_X),
 * each tool's workshop, the bell post, the build site, trees and decorations.
 * Pure (imports only data modules of the art kit), so the model runs headless in Node.
 */
import type { StructureId, Tool, World, WorldStructure } from '../../../contracts/ts/src/types.ts';
import { STRUCTURES, type Points, type Stage, type StructureDef, type StructureKind } from '../../art/src/structures.ts';
import { artFor, SLOT_X } from '../../art/src/worldmap.ts';
import { rng, range, hash } from '../../art/src/rng.ts';

/** Canonical layout width the slots are authored at. */
export const CANON_W = 1440;

export interface Placed {
  id: StructureId;
  kind: StructureKind;
  stage: Stage;
  /** stage shown until a pending plank lands (build moments arrive before the plank) */
  sprite: string;
  x: number;
  def: StructureDef;
  pts: Points;
  status: WorldStructure['status'];
  /** the tool whose workshop this is */
  tool?: Tool;
}

export interface Bell {
  x: number;
  kind: 'bellpost' | 'belltower';
  /** structure exists in the World (otherwise a post appears only while someone needs you) */
  present: boolean;
  stage: Stage;
  /** canonical x where waiting residents stand (the rope side) */
  rope: number;
}

export interface Scenery {
  x: number;
  id: string;
  behind?: boolean;
}

export interface Layout {
  seed: number;
  structures: Placed[];
  byId: Map<StructureId, Placed>;
  workshop: Map<Tool, Placed>;
  bell: Bell;
  /** the structure planks fly to: the one being built, or null */
  site: Placed | null;
  trees: Scenery[];
  decorations: Scenery[];
}

/** Decoration ids (WP-08 catalogue) to the art kit's decoration sprites. Stand-ins where the kit has no art yet. */
const DECO_ART: Record<string, string | null> = {
  wildflowers: 'deco/flowers',
  log_pile: 'deco/crate',
  lantern: 'deco/lamppost',
  bench: 'deco/bench',
  birdhouse: 'deco/birdhouse',
  reeds: 'bush/2',
  bunting: 'deco/bunting',
  leaf_pile: 'bush/0',
  signpost: 'deco/lamppost',
  wheelbarrow: 'deco/crate',
  flower_boxes: 'deco/flowers',
  washing_line: 'deco/bunting',
  snowman: 'deco/snowman',
  scarecrow: 'deco/crate',
  beehives: 'deco/crate',
  pumpkin_patch: 'deco/pumpkins',
  stepping_stones: null,
  fishing_jetty: null,
  rowboat: null,
  duck_house: 'deco/birdhouse',
  hammock: 'deco/hammock',
  sledge: 'deco/crate',
  apple_cart: 'deco/crate',
  market_stalls: 'deco/bunting',
};

/** Decoration zones (slot ranges from WP-08's economy config) to canonical x ranges. */
const ZONES: { first: number; last: number; x0: number; x1: number }[] = [
  { first: 0, last: 15, x0: 30, x1: 360 },
  { first: 16, last: 23, x0: 370, x1: 720 },
  { first: 24, last: 35, x0: 740, x1: 980 },
  { first: 36, last: 51, x0: 1000, x1: 1330 },
  { first: 52, last: 63, x0: 90, x1: 330 },
];

function occupied(structures: Placed[]): [number, number][] {
  return structures.map((s) => [s.x - s.def.w / 2 - 3, s.x + s.def.w / 2 + 3] as [number, number]);
}

function free(x: number, half: number, occ: [number, number][]): boolean {
  return occ.every(([a, b]) => x + half < a || x - half > b);
}

/** Nearest free x to `x` for an object of half-width `half`, searching outward in 2-unit steps. */
function nearestFree(x: number, half: number, occ: [number, number][], lo = 8, hi = CANON_W - 8): number | null {
  for (let d = 0; d < 160; d += 2) {
    for (const s of d === 0 ? [0] : [-d, d]) {
      const c = x + s;
      if (c - half >= lo && c + half <= hi && free(c, half, occ)) return c;
    }
  }
  return null;
}

export function buildLayout(world: World | null, seedFallback = 11): Layout {
  const seed = world?.seed ?? seedFallback;
  const structures: Placed[] = [];
  // the bell tower shares the bell post's slot: it appears when complete and then replaces the post
  const towerDone = (world?.structures ?? []).some((s) => s.id === 'bell_tower' && s.status === 'complete');
  const hasPost = (world?.structures ?? []).some((s) => s.id === 'bell_post' && s.stage > 0);
  for (const s of world?.structures ?? []) {
    if (s.id === 'bell_tower' && !towerDone && hasPost) continue;
    if (s.id === 'bell_post' && towerDone) continue;
    const art = artFor(s);
    if (!art) continue;
    const def = STRUCTURES[art.kind];
    if (!def) continue;
    const tool = (s.id === 'workshop_1' || s.id === 'workshop_2') && s.variant && s.variant !== 'guest_house' ? (s.variant as Tool) : undefined;
    structures.push({ id: s.id, kind: art.kind, stage: art.stage, sprite: art.sprite, x: art.x, def, pts: def.points(art.stage), status: s.status, tool });
  }
  const byId = new Map(structures.map((s) => [s.id, s] as [StructureId, Placed]));
  const workshop = new Map<Tool, Placed>();
  for (const s of structures) if (s.tool && !workshop.has(s.tool)) workshop.set(s.tool, s);
  // antigravity and gemini share the hare's windmill
  if (workshop.has('antigravity') && !workshop.has('gemini')) workshop.set('gemini', workshop.get('antigravity')!);
  if (workshop.has('gemini') && !workshop.has('antigravity')) workshop.set('antigravity', workshop.get('gemini')!);

  const tower = byId.get('bell_tower');
  const post = byId.get('bell_post');
  const b = tower && tower.stage === 3 ? tower : post ?? tower;
  const bell: Bell = b
    ? { x: b.x, kind: b.kind === 'belltower' ? 'belltower' : 'bellpost', present: true, stage: b.stage, rope: b.x + (b.pts.work?.[0] ?? -5) }
    : { x: SLOT_X.bell_post, kind: 'bellpost', present: false, stage: 1, rope: SLOT_X.bell_post - 5 };

  // build site: the first structure being built (the World lists structures in build order)
  const site = structures.find((s) => s.status === 'building') ?? null;

  // trees in the gaps, seeded per world (the art kit's goldens use the same mix)
  const occ = occupied(structures);
  occ.push([bell.x - 8, bell.x + 8]);
  const r = rng(hash(seed, 4401));
  const trees: Scenery[] = [];
  const ids = ['tree/broad/0', 'tree/conifer/0', 'tree/broad/1', 'tree/conifer/1', 'tree/broad/2', 'bush/1', 'bush/0'];
  let x = range(r, 10, 30);
  while (x < CANON_W - 10) {
    const orchard = x > 1100 && x < 1380;
    const nearBell = Math.abs(x - bell.x) < 44;
    const id = orchard ? `tree/fruit/${Math.floor(r() * 3)}` : nearBell ? `bush/${Math.floor(r() * 3)}` : ids[Math.floor(r() * ids.length)];
    const half = id.startsWith('bush') ? 6 : 12;
    const behind = !orchard && r() < 0.55;
    if (behind ? free(x, half * 0.4, occ) || r() < 0.5 : free(x, half, occ)) {
      trees.push({ x, id, behind });
      if (!behind) occ.push([x - half, x + half]);
    }
    x += orchard ? range(r, 34, 46) : range(r, 38, 92);
  }

  const decorations: Scenery[] = [];
  for (const d of world?.decorations ?? []) {
    if (!d.shown) continue;
    const art = DECO_ART[d.id];
    if (!art) continue;
    const z = ZONES.find((zz) => d.slot >= zz.first && d.slot <= zz.last) ?? ZONES[0];
    const f = (d.slot - z.first + 0.5) / (z.last - z.first + 1);
    const want = z.x0 + (z.x1 - z.x0) * f;
    const at = nearestFree(want, 10, occ);
    if (at === null) continue;
    decorations.push({ x: at, id: art });
    occ.push([at - 10, at + 10]);
  }

  return { seed, structures, byId, workshop, bell, site, trees, decorations };
}

/** Where a tool's residents live and work when it has no workshop yet: around the camp. */
export function campSpot(layout: Layout): number {
  const fire = layout.byId.get('campfire');
  const tent = layout.byId.get('tent');
  return fire ? fire.x + 22 : tent ? tent.x + 24 : 90;
}

/** Nearest tree (for shelter and tea) to x, or null. */
export function nearestTree(layout: Layout, x: number): Scenery | null {
  let best: Scenery | null = null;
  for (const t of layout.trees) if (!t.id.startsWith('bush') && (!best || Math.abs(t.x - x) < Math.abs(best.x - x))) best = t;
  return best;
}
