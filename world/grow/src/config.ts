// The Busyholm economy (SPEC 4.5 as amended by SPEC Revision 1, item 6). Every number that decides
// what real activity earns, what things cost and when they unlock lives here, so tuning never needs a
// ledger migration: grow() re-derives the whole world from raw daily counts on every call.
//
// Units: planks and stone can be fractional only in halves (a plank is 0.5 past the first turns), so the
// engine keeps every resource in integer HALF units internally and divides by 2 on output. That keeps
// grow() free of floating-point accumulation and identical in every JavaScript engine.
//
// Revision 1 rules this config obeys (tested in test/fairness.test.ts and test/pacing.test.ts):
// - Nothing rewards answering permission requests, or answering them quickly. No resource, gate or
//   unlock reads needs_you (contracts r1 removed quick_answers from the ledger). A user who never sees
//   a permission prompt builds at exactly the same pace as anyone else doing the same work.
// - Progress comes from capped active days (a flat daily delivery, one seed a day, and a minimum
//   number of active days before the market hall) and completed work episodes (main-session turns),
//   plus working time, each with a hard daily cap. Tokens, errors, limit hits, interrupts, sessions
//   and subagent turns earn nothing.
// - Concurrent agents count by wall-clock time. Since contracts r1 the ledger's working_seconds is
//   per-tool wall time, so sessions of one tool side by side never add up. Different tools side by
//   side still add (the ledger has no cross-tool wall time); the 6-hour daily cap on working time
//   bounds that (see contracts/CHANGES.md "Proposed" and calibration.md).

import type { ProgressionStructureId, StructureId } from "@busyholm/contracts";

/**
 * One band of a daily diminishing-returns curve. Input units (turns, or minutes) above the previous
 * band's upTo and up to this band's upTo earn `halves` half-units per `per` input units, rounded down
 * per band. Past the last band, more input earns nothing that day.
 */
export interface Band {
  readonly upTo: number;
  readonly halves: number;
  readonly per: number;
}

export interface StructureCost {
  readonly id: ProgressionStructureId;
  readonly planks: number;
  readonly stone: number;
  /**
   * "tool_seen": the queue stops here until an agent tool has been seen (the workshop needs a species).
   * Blocking, not skipped, so the first agent event of a day never re-routes deliveries already shown.
   */
  readonly needs?: "tool_seen";
  /**
   * Skipped (status waiting) until this many active days have finished, counting days before the one
   * being built on, so a day's own activity never re-routes that day's deliveries.
   */
  readonly activeDaysBefore?: number;
}

export type DecorationZone = "commons" | "workshops" | "river" | "orchard" | "village";
export type Season = "autumn" | "winter";

export interface DecorationDef {
  readonly id: string;
  readonly seeds: number;
  readonly zone: DecorationZone;
  /** A structure that must be complete before it can be bought (none: available from the start). */
  readonly requires?: ProgressionStructureId;
  /** Seasonal items: owned forever, but the renderer shows them only in their season (see seasons.ts). */
  readonly season?: Season;
}

export const ECONOMY_VERSION = 2;

/** A day is active when it has at least this many completed main-session turns (all tools summed). */
export const ACTIVE_DAY_MIN_TURNS = 1;

/**
 * Planks: a flat delivery on each active day (capped at one a day), plus completed main-session turns
 * with daily diminishing returns. Typical day (12 turns): 6 + 15 + 2 = 23. Cap (30 turns or more): 41.
 */
export const PLANKS = {
  activeDayHalves: 12,
  turnBands: [
    { upTo: 10, halves: 3, per: 1 }, // turns 1 to 10: 1.5 planks each
    { upTo: 30, halves: 2, per: 1 }, // turns 11 to 30: 1 plank each; past 30, nothing more that day
  ] as readonly Band[],
} as const;

/**
 * Stone: a flat delivery on each active day, plus working minutes with a hard daily cap. Front-loaded
 * so the first 90 minutes count most: the measured working time of a median day is uncertain (between
 * 1.4 h and 2.7 h, calibration.md), and this keeps a median day at 11 to 12 stone anywhere in that range.
 * Working time is the ledger's per-tool wall time, summed over tools. Typical day (150 min): 2 + 9 +
 * 1.5 = 12.5. Cap (6 h or more): 17.5.
 */
export const STONE = {
  activeDayHalves: 4,
  minuteBands: [
    { upTo: 90, halves: 2, per: 10 }, // first 90 min: 1 stone per 10 min
    { upTo: 360, halves: 2, per: 40 }, // 90 min to 6 h: 1 stone per 40 min; past 6 h, nothing more that day
  ] as readonly Band[],
} as const;

/** Seeds (decorations only): one per active day, one more on an active day while the streak is at least 3. */
export const SEEDS = {
  perActiveDay: 1,
  streakBonus: 1,
  streakMin: 3,
} as const;

/** Up to this many rest days per calendar week (Monday to Sunday) do not break a streak. */
export const STREAK_REST_DAYS_PER_WEEK = 2;

/**
 * Founding crate on the founding day. SPEC 4.5 said 15 / 6 / 3; raised to 18 / 9 so that ANY active
 * first day (even one turn and a few minutes, which is what the calibration's real first day looked
 * like) completes the first three structures once an agent is seen. It moves the village by less than
 * a day for every profile.
 */
export const FOUNDING_CRATE = { planks: 18, stone: 9, seeds: 3 } as const;

/** History backfill: earned with the normal daily curves, then capped whatever the history size (SPEC 4.5). */
export const BACKFILL_CAP = { planks: 50, stone: 24, seeds: 6 } as const;

/** Steam demo (SPEC 7.3): the founding plus three progression structures and six decorations. */
export const DEMO_CAP = { progressionStructures: 3, decorations: 6 } as const;

/** Structures free on the founding day. */
export const FOUNDING_STRUCTURES: readonly StructureId[] = ["campfire", "tent"];

/** Progression structures in default build order (SPEC 4.5 table order). */
export const STRUCTURES: readonly StructureCost[] = [
  { id: "noticeboard", planks: 4, stone: 0 },
  { id: "workshop_1", planks: 10, stone: 4, needs: "tool_seen" },
  { id: "well", planks: 8, stone: 6 },
  { id: "cottage_1", planks: 20, stone: 6 },
  { id: "garden_plots", planks: 25, stone: 10 },
  { id: "crossing", planks: 30, stone: 15 },
  { id: "watermill", planks: 40, stone: 15 },
  { id: "workshop_2", planks: 40, stone: 20 },
  { id: "cottage_2", planks: 45, stone: 20 },
  { id: "bell_tower", planks: 40, stone: 25 },
  { id: "bakery", planks: 60, stone: 30 },
  { id: "market_hall", planks: 80, stone: 40, activeDaysBefore: 12 }, // the market needs regulars: two working weeks
];

/** Hamlet at this many complete progression structures, village at all of them. */
export const HAMLET_AT = 6;

/** Visible build stages per structure (stage 3 is complete). */
export const STAGES = 3;

/** Decoration slot ranges per zone (inclusive). The renderer maps a slot to a position in its zone. */
export const DECORATION_ZONES: Readonly<Record<DecorationZone, { readonly first: number; readonly last: number }>> = {
  commons: { first: 0, last: 15 },
  workshops: { first: 16, last: 23 },
  river: { first: 24, last: 35 },
  orchard: { first: 36, last: 51 },
  village: { first: 52, last: 63 },
};

/**
 * The 24 decorations (SPEC 4.5: 1 to 6 seeds each, about 70 in total). Catalogue order is the unlock
 * order shown in the shop: the first eight need nothing, the rest arrive with the structure they belong to.
 */
export const DECORATIONS: readonly DecorationDef[] = [
  { id: "wildflowers", seeds: 1, zone: "commons" },
  { id: "log_pile", seeds: 1, zone: "commons" },
  { id: "lantern", seeds: 2, zone: "commons" },
  { id: "bench", seeds: 2, zone: "commons" },
  { id: "birdhouse", seeds: 2, zone: "commons" },
  { id: "reeds", seeds: 1, zone: "river" },
  { id: "bunting", seeds: 3, zone: "commons" },
  { id: "leaf_pile", seeds: 1, zone: "commons", season: "autumn" },
  { id: "signpost", seeds: 2, zone: "commons", requires: "noticeboard" },
  { id: "wheelbarrow", seeds: 3, zone: "workshops", requires: "workshop_1" },
  { id: "flower_boxes", seeds: 2, zone: "village", requires: "cottage_1" },
  { id: "washing_line", seeds: 2, zone: "village", requires: "cottage_1" },
  { id: "snowman", seeds: 3, zone: "commons", requires: "cottage_1", season: "winter" },
  { id: "scarecrow", seeds: 3, zone: "orchard", requires: "garden_plots" },
  { id: "beehives", seeds: 4, zone: "orchard", requires: "garden_plots" },
  { id: "pumpkin_patch", seeds: 4, zone: "orchard", requires: "garden_plots", season: "autumn" },
  { id: "stepping_stones", seeds: 2, zone: "river", requires: "crossing" },
  { id: "fishing_jetty", seeds: 6, zone: "river", requires: "crossing" },
  { id: "rowboat", seeds: 5, zone: "river", requires: "watermill" },
  { id: "duck_house", seeds: 3, zone: "river", requires: "watermill" },
  { id: "hammock", seeds: 4, zone: "orchard", requires: "cottage_2" },
  { id: "sledge", seeds: 2, zone: "commons", requires: "cottage_2", season: "winter" },
  { id: "apple_cart", seeds: 3, zone: "orchard", requires: "bakery" },
  { id: "market_stalls", seeds: 5, zone: "village", requires: "market_hall" },
];
