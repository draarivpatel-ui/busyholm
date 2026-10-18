/**
 * World v1 (contracts/ts) to art: which sprite, stage and slot each World structure shows, and which
 * species each tool's residents are. Read-only use of the WP-01 contract; nothing here changes it.
 */
import type { StructureId, StructureVariant, Tool, WorldStructure } from '../../../contracts/ts/src/types.ts';
import type { StructureKind, Stage } from './structures.ts';
import type { Species } from './residents.ts';

/** SPEC 4.2 defaults (the user can reassign species per tool in settings). */
export const SPECIES_BY_TOOL: Record<Tool, Species> = {
  claude: 'beaver',
  codex: 'otter',
  opencode: 'frog',
  antigravity: 'hare',
  gemini: 'hare',
  // v0.3 species (mole, heron) are not drawn in v0.1; they fall back to the "other" hedgehog
  cursor: 'hedgehog',
  aider: 'hedgehog',
  other: 'hedgehog',
};

/** Workshop art per tool (SPEC 4.2). Tools without a v0.1 workshop use the guest house shape. */
export const WORKSHOP_BY_TOOL: Record<Tool, StructureKind> = {
  claude: 'sawmill',
  codex: 'stoneyard',
  opencode: 'printshop',
  antigravity: 'windmill',
  gemini: 'windmill',
  cursor: 'guesthouse',
  aider: 'guesthouse',
  other: 'guesthouse',
};

/** Canonical slot x (units, 1440-unit layout) for every World structure id (SPEC 4.1 zones). */
export const SLOT_X: Record<StructureId, number> = {
  campfire: 64,
  tent: 108,
  cottage_1: 112,
  cottage_2: 168,
  noticeboard: 218,
  bell_post: 256,
  bell_tower: 256,
  well: 296,
  founders_stone: 336,
  workshop_1: 405,
  workshop_2: 615,
  crossing: 792,
  watermill: 872,
  garden_plots: 1062,
  bakery: 1146,
  market_hall: 1252,
};

function kindFor(id: StructureId, variant: StructureVariant | undefined): StructureKind | null {
  switch (id) {
    case 'campfire':
      return 'campfire';
    case 'tent':
      return 'tent';
    case 'bell_post':
      return 'bellpost';
    case 'bell_tower':
      return 'belltower';
    case 'noticeboard':
      return 'noticeboard';
    case 'well':
      return 'well';
    case 'cottage_1':
    case 'cottage_2':
      return 'cottage';
    case 'garden_plots':
      return 'garden';
    case 'crossing':
      return variant === 'jetty' ? 'jetty' : 'footbridge';
    case 'watermill':
      return 'watermill';
    case 'bakery':
      return 'bakery';
    case 'market_hall':
      return 'markethall';
    case 'founders_stone':
      return 'founders';
    case 'workshop_1':
    case 'workshop_2':
      if (variant === 'guest_house') return 'guesthouse';
      if (!variant || variant === 'footbridge' || variant === 'jetty') return null;
      return WORKSHOP_BY_TOOL[variant as Tool] ?? 'guesthouse';
  }
}

const SINGLE_STAGE = new Set<StructureKind>(['campfire', 'tent', 'bellpost', 'founders', 'plot']);

export interface StructureArt {
  kind: StructureKind;
  stage: Stage;
  /** sprite id in the strip atlas */
  sprite: string;
  x: number;
}

/**
 * Art for one World structure, or null when nothing is drawn (stage 0 and not being built).
 * A structure at stage 0 that is `building` shows the staked plot so the next build site is visible.
 */
export function artFor(s: WorldStructure): StructureArt | null {
  const x = SLOT_X[s.id];
  if (s.stage <= 0) return s.status === 'building' ? { kind: 'plot', stage: 1, sprite: 'st/plot/1', x } : null;
  const kind = kindFor(s.id, s.variant) ?? (s.status === 'building' ? 'plot' : null);
  if (!kind) return null;
  const stage = (SINGLE_STAGE.has(kind) ? 1 : Math.min(3, Math.max(1, Math.round(s.stage)))) as Stage;
  const sprite = kind === 'cottage' && s.id === 'cottage_2' && stage === 3 ? 'st/cottage/3/v1' : `st/${kind}/${stage}`;
  return { kind, stage, sprite, x };
}
