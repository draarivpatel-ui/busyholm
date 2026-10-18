// world = grow(seed, ledger, choices): the pure progression engine (SPEC 4.5 as amended by SPEC
// Revision 1 item 6). No I/O, no clock, no Math functions beyond floor and min/max, integer arithmetic
// for every resource (half units), so the result is byte-identical in every JavaScript engine.
//
// The world is folded one local day at a time, from the founding day (or the first counted day, if
// earlier) through the as-of day. Each day:
//   1. the founding crate (founding day) and the capped history backfill (founding day) arrive;
//   2. the day's counts become planks, stone and seeds (economy in config.ts);
//   3. the stockpile is delivered, one structure at a time, to the first eligible structure in the
//      build order in force that day; a structure completes the moment its full cost is delivered;
//   4. that day's decoration choices are applied (bought with seeds, in log order);
//   5. that day's build-order choices are folded in; they take effect from the NEXT day's deliveries.
//
// Why step 5 waits a day: the ledger only has daily totals, so grow() cannot know whether a choice
// made at 3 pm came before or after a given turn. Applying a choice to the day it was made would
// re-deliver that whole day's earnings in the new order, which could take back a structure the user
// already saw completed earlier that day. Applying it from the next day keeps every recompute
// monotone: nothing shown complete is ever taken back (test/gaps.test.ts). The noticeboard can say
// "the builders start on it tomorrow".
//
// The same reasoning fixes two other rules: the market hall's active-day condition counts only
// finished days (days before the one being built on), and the first workshop blocks the queue (rather
// than being skipped) until an agent tool has been seen.
import type {
  Choices, Counts, DayTools, Ledger, MilestoneId, ProgressionStructureId, StructureVariant, Tool, World,
  WorldDecoration, WorldMilestone, WorldStructure,
} from "@busyholm/contracts";
import {
  ACTIVE_DAY_MIN_TURNS, BACKFILL_CAP, DECORATION_ZONES, DECORATIONS, DEMO_CAP, FOUNDING_CRATE, HAMLET_AT, PLANKS,
  SEEDS, STAGES, STONE, STREAK_REST_DAYS_PER_WEEK, STRUCTURES,
} from "./config.ts";
import type { Band, DecorationDef, DecorationZone, StructureCost } from "./config.ts";
import { dayNumber, dayString, weekStart } from "./days.ts";
import { MILESTONE_IDS, PROGRESSION_STRUCTURE_IDS, TOOLS } from "./ids.ts";
import { mixSeed, mulberry32, shuffled } from "./rng.ts";

export interface GrowOptions {
  /**
   * Fold through this local day. Default: the latest day named by the ledger (live days, the hooks
   * day) or the choices, and at least the founding day. Later days are ignored, so the weekly replay
   * can ask for the world as of any past day. A day before the founding day folds through the founding day.
   */
  readonly asOfDay?: string;
  /** "demo" applies the Steam demo cap (SPEC 7.3). Default "full". */
  readonly edition?: "full" | "demo";
}

/** World v1 integer fields are capped at 1e9; a schema-valid ledger can only exceed that in absurd cases. */
const COUNT_MAX = 1_000_000_000;

interface DayAgg {
  turns: number;
  workSeconds: number;
  sessions: number;
  subagentTurns: number;
  needsYou: number;
  /** Tools that did work this day (a completed turn or working time), in TOOLS order. */
  worked: Tool[];
  /** Tools with at least one completed turn, in TOOLS order. */
  withTurns: Tool[];
}

interface BuildState {
  readonly cost: StructureCost;
  /** Delivered so far, in half units. */
  planks: number;
  stone: number;
  completedDay: number | null;
  variant: StructureVariant | undefined;
}

interface Purse {
  planks: number;
  stone: number;
  seeds: number;
}

const COST_BY_ID = new Map<ProgressionStructureId, StructureCost>(STRUCTURES.map((s) => [s.id, s]));
const DECORATION_BY_ID = new Map<string, DecorationDef>(DECORATIONS.map((d) => [d.id, d]));
const TOOL_RANK = new Map<Tool, number>(TOOLS.map((t, i) => [t, i]));

export function grow(seed: number, ledger: Ledger, choices: Choices, options: GrowOptions = {}): World {
  const worldSeed = seed >>> 0;
  const demo = options.edition === "demo";
  const founded = dayNumber(ledger.founded_day);

  // ---- Inputs normalised to day numbers (impossible dates such as 02-30 merge onto their civil day).
  const live = aggregateDays(ledger.days, ledger.day_totals);
  const liveDays = [...live.keys()].sort((a, b) => a - b);
  const entries = choices.log
    .map((e, i) => ({ e, i, n: dayNumber(e.day) }))
    .sort((a, b) => (a.n - b.n) || (a.i - b.i));
  const hooksDay = ledger.hooks_first_connected_day === null ? null : dayNumber(ledger.hooks_first_connected_day);

  const start = Math.min(founded, liveDays.length > 0 ? liveDays[0]! : founded);
  let end: number;
  if (options.asOfDay !== undefined) {
    end = Math.max(dayNumber(options.asOfDay), founded);
  } else {
    end = founded;
    if (liveDays.length > 0) end = Math.max(end, liveDays[liveDays.length - 1]!);
    if (entries.length > 0) end = Math.max(end, entries[entries.length - 1]!.n);
    if (hooksDay !== null) end = Math.max(end, hooksDay);
  }

  // ---- History backfill: the same daily curves, summed, then capped (SPEC 4.5).
  const backfill = ledger.backfill === null ? null : aggregateDays(ledger.backfill.days);
  const backfillAward = backfill === null ? null : awardBackfill(backfill);

  // ---- Fold state.
  const stock: Purse = { planks: 0, stone: 0, seeds: 0 };
  const earned: Purse = { planks: 0, stone: 0, seeds: 0 };
  const builds = new Map<ProgressionStructureId, BuildState>();
  for (const cost of STRUCTURES) builds.set(cost.id, { cost, planks: 0, stone: 0, completedDay: null, variant: undefined });
  const completionOrder: ProgressionStructureId[] = [];
  const owned = new Map<string, WorldDecoration>();
  const slots = decorationSlots(worldSeed);
  const milestones = new Map<MilestoneId, number>();
  const toolsSeen: Tool[] = [];

  let latestOrder: ProgressionStructureId[] = [...PROGRESSION_STRUCTURE_IDS];
  let orderInForce = latestOrder;
  let entryIdx = 0;
  // Choices dated before the first folded day are already in force on it.
  while (entryIdx < entries.length && entries[entryIdx]!.n < start) {
    const { e } = entries[entryIdx]!;
    if (e.kind === "build_order") latestOrder = effectiveOrder(e.order);
    entryIdx++;
  }
  orderInForce = latestOrder;
  const earlyDecorations = entries.slice(0, entryIdx).filter((x) => x.e.kind === "decoration");

  let lifetimeTurns = 0;
  let activeDays = 0;
  let streak = 0;
  let restInWeek = 0;
  let week = weekStart(start);
  let progressionComplete = 0;
  let target: ProgressionStructureId | null = null;
  let skippedOnLastDay = new Set<ProgressionStructureId>();
  let finishedActiveAtEnd = 0;

  for (let d = start; d <= end; d++) {
    // 1. Founding crate and backfill.
    if (d === founded) {
      add(stock, earned, FOUNDING_CRATE.planks * 2, FOUNDING_CRATE.stone * 2, FOUNDING_CRATE.seeds * 2);
      if (backfillAward !== null) add(stock, earned, backfillAward.planks, backfillAward.stone, backfillAward.seeds);
    }

    // 2. The day's counts.
    const finishedActive = activeDays; // active days before today: what day conditions may count
    const agg = live.get(d);
    if (weekStart(d) !== week) {
      week = weekStart(d);
      restInWeek = 0;
    }
    const active = agg !== undefined && agg.turns >= ACTIVE_DAY_MIN_TURNS;
    if (active) {
      activeDays++;
      streak++;
    } else {
      restInWeek++;
      if (restInWeek > STREAK_REST_DAYS_PER_WEEK) streak = 0;
    }
    const seenBeforeToday: readonly Tool[] = toolsSeen.slice();
    if (agg !== undefined) {
      add(stock, earned, plankHalves(agg), stoneHalves(agg), seedHalves(active, streak));
      lifetimeTurns = Math.min(COUNT_MAX, lifetimeTurns + agg.turns);
      for (const t of agg.worked) if (!toolsSeen.includes(t)) toolsSeen.push(t);
      noteMilestones(milestones, d, agg, lifetimeTurns, streak);
    }

    // 3. Deliveries, one structure at a time, in the order in force today.
    const skipped = new Set<ProgressionStructureId>();
    target = null;
    for (;;) {
      if (demo && progressionComplete >= DEMO_CAP.progressionStructures) break;
      let next: ProgressionStructureId | null = null;
      let blocked = false;
      for (const id of orderInForce) {
        const b = builds.get(id)!;
        if (b.completedDay !== null) continue;
        if (b.cost.activeDaysBefore !== undefined && finishedActive < b.cost.activeDaysBefore) {
          skipped.add(id);
          continue;
        }
        if (b.cost.needs === "tool_seen" && toolsSeen.length === 0) blocked = true;
        next = id;
        break;
      }
      target = next;
      if (next === null || blocked) break;
      const b = builds.get(next)!;
      const giveP = Math.min(stock.planks, b.cost.planks * 2 - b.planks);
      const giveS = Math.min(stock.stone, b.cost.stone * 2 - b.stone);
      if (giveP + giveS > 0 && b.variant === undefined) b.variant = decideVariant(next, toolsSeen, seenBeforeToday);
      stock.planks -= giveP;
      stock.stone -= giveS;
      b.planks += giveP;
      b.stone += giveS;
      if (b.planks === b.cost.planks * 2 && b.stone === b.cost.stone * 2) {
        if (b.variant === undefined) b.variant = decideVariant(next, toolsSeen, seenBeforeToday);
        b.completedDay = d;
        completionOrder.push(next);
        progressionComplete++;
        continue;
      }
      break;
    }

    // 4. Decoration choices made today (and, on the first day, any made before it).
    const todays: typeof entries = d === start ? [...earlyDecorations] : [];
    while (entryIdx < entries.length && entries[entryIdx]!.n === d) todays.push(entries[entryIdx++]!);
    for (const { e } of todays) {
      if (e.kind !== "decoration") continue;
      const have = owned.get(e.decoration);
      if (have !== undefined) {
        have.shown = e.on;
        continue;
      }
      if (!e.on) continue;
      const def = DECORATION_BY_ID.get(e.decoration);
      if (def === undefined) continue; // not in this version's catalogue
      if (def.requires !== undefined && builds.get(def.requires)!.completedDay === null) continue;
      if (stock.seeds < def.seeds * 2) continue; // the shop only offers what is affordable
      if (demo && owned.size >= DEMO_CAP.decorations) continue;
      stock.seeds -= def.seeds * 2;
      owned.set(def.id, { id: def.id, slot: slots.get(def.id)!, shown: true });
    }

    // 5. Build-order choices made today take effect from tomorrow.
    for (const { e } of todays) if (e.kind === "build_order") latestOrder = effectiveOrder(e.order);
    orderInForce = latestOrder;

    skippedOnLastDay = skipped;
    finishedActiveAtEnd = finishedActive;
  }

  // ---- Output.
  const structures: WorldStructure[] = [];
  structures.push({ id: "campfire", status: "complete", stage: STAGES, progress: 1, completed_day: dayString(founded) });
  structures.push({ id: "tent", status: "complete", stage: STAGES, progress: 1, completed_day: dayString(founded) });
  if (hooksDay !== null && hooksDay <= end) {
    structures.push({ id: "bell_post", status: "complete", stage: STAGES, progress: 1, completed_day: dayString(Math.max(hooksDay, founded)) });
  } else {
    structures.push({ id: "bell_post", status: "planned", stage: 0, progress: 0 });
  }
  const stone = backfill === null ? null : foundersStone(backfill);
  if (stone !== null) structures.push({ id: "founders_stone", status: "complete", stage: STAGES, progress: 1, completed_day: dayString(founded) });

  for (const id of completionOrder) {
    const b = builds.get(id)!;
    structures.push(withVariant({ id, status: "complete", stage: STAGES, progress: 1, completed_day: dayString(b.completedDay!) }, b.variant));
  }
  for (const id of latestOrder) {
    const b = builds.get(id)!;
    if (b.completedDay !== null) continue;
    const total = (b.cost.planks + b.cost.stone) * 2;
    const done = b.planks + b.stone;
    const progress = done / total;
    const stage = Math.min(STAGES - 1, Math.floor((STAGES * done) / total));
    const gate = b.cost.activeDaysBefore;
    let s: WorldStructure;
    if (gate !== undefined && skippedOnLastDay.has(id) && finishedActiveAtEnd < gate) {
      s = { id, status: "waiting", stage, progress, waiting_for: { active_days: gate - finishedActiveAtEnd } };
    } else if (id === target && done > 0) {
      s = { id, status: "building", stage, progress };
    } else {
      s = { id, status: "planned", stage, progress };
    }
    structures.push(withVariant(s, b.variant));
  }

  const half = (v: number) => v / 2;
  return {
    schema_version: 1,
    seed: worldSeed,
    as_of_day: dayString(end),
    tier: progressionComplete >= STRUCTURES.length ? "village" : progressionComplete >= HAMLET_AT ? "hamlet" : "camp",
    resources: { planks: half(stock.planks), stone: half(stock.stone), seeds: half(stock.seeds) },
    earned: { planks: half(earned.planks), stone: half(earned.stone), seeds: half(earned.seeds) },
    structures,
    decorations: [...owned.values()],
    milestones: milestoneList(milestones),
    stats: {
      lifetime_turns: lifetimeTurns,
      active_days: Math.min(COUNT_MAX, activeDays),
      streak_days: Math.min(COUNT_MAX, streak),
      tools_seen: toolsSeen,
    },
    founders_stone: stone,
    demo_capped: demo && progressionComplete >= DEMO_CAP.progressionStructures,
  };
}

// ---------------------------------------------------------------------------------------------------
// Daily earnings (all in half units)
// ---------------------------------------------------------------------------------------------------

function bandHalves(x: number, bands: readonly Band[]): number {
  let prev = 0;
  let out = 0;
  for (const b of bands) {
    if (x <= prev) break;
    const units = Math.min(x, b.upTo) - prev;
    out += Math.floor((units * b.halves) / b.per);
    prev = b.upTo;
  }
  return out;
}

function plankHalves(agg: DayAgg): number {
  if (agg.turns < ACTIVE_DAY_MIN_TURNS) return 0;
  return PLANKS.activeDayHalves + bandHalves(agg.turns, PLANKS.turnBands);
}

function stoneHalves(agg: DayAgg): number {
  const minutes = Math.floor(agg.workSeconds / 60);
  return (agg.turns >= ACTIVE_DAY_MIN_TURNS ? STONE.activeDayHalves : 0) + bandHalves(minutes, STONE.minuteBands);
}

function seedHalves(active: boolean, streak: number): number {
  if (!active) return 0;
  return 2 * (SEEDS.perActiveDay + (streak >= SEEDS.streakMin ? SEEDS.streakBonus : 0));
}

function awardBackfill(days: Map<number, DayAgg>): Purse {
  let planks = 0;
  let stone = 0;
  let seeds = 0;
  for (const agg of days.values()) {
    planks += plankHalves(agg);
    stone += stoneHalves(agg);
    seeds += agg.turns >= ACTIVE_DAY_MIN_TURNS ? 2 * SEEDS.perActiveDay : 0;
  }
  return {
    planks: Math.min(planks, BACKFILL_CAP.planks * 2),
    stone: Math.min(stone, BACKFILL_CAP.stone * 2),
    seeds: Math.min(seeds, BACKFILL_CAP.seeds * 2),
  };
}

function foundersStone(days: Map<number, DayAgg>): World["founders_stone"] {
  if (days.size === 0) return null;
  let turns = 0;
  let sessions = 0;
  let seconds = 0;
  for (const agg of days.values()) {
    turns += agg.turns;
    sessions += agg.sessions;
    seconds += agg.workSeconds;
  }
  return {
    days: days.size,
    turns: Math.min(COUNT_MAX, turns),
    sessions: Math.min(COUNT_MAX, sessions),
    working_hours: Math.round(seconds / 360) / 10,
  };
}

function add(stock: Purse, earned: Purse, planks: number, stone: number, seeds: number): void {
  stock.planks += planks;
  stock.stone += stone;
  stock.seeds += seeds;
  earned.planks += planks;
  earned.stone += stone;
  earned.seeds += seeds;
}

// ---------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------

/**
 * `dayTotals` (the optional Ledger v1 `day_totals`) holds, per day, the wall seconds with at least one
 * main session of any tool working. When a listed day has an entry its working time is that union, so
 * tools working side by side are not summed; otherwise it is the per-tool sum, exactly as before.
 * Entries for days that have no `days` record are ignored (nothing was counted on them). Keys that land
 * on the same day number add up like the per-tool values do.
 */
function aggregateDays(
  days: Readonly<Record<string, DayTools>>,
  dayTotals?: Readonly<Record<string, { readonly working_seconds: number }>>,
): Map<number, DayAgg> {
  const out = new Map<number, DayAgg>();
  // Sorted keys so merged impossible dates always sum in the same order.
  for (const key of Object.keys(days).sort()) {
    const n = dayNumber(key);
    let agg = out.get(n);
    if (agg === undefined) {
      agg = { turns: 0, workSeconds: 0, sessions: 0, subagentTurns: 0, needsYou: 0, worked: [], withTurns: [] };
      out.set(n, agg);
    }
    const tools = days[key]!;
    const union = dayTotals !== undefined && Object.hasOwn(dayTotals, key) ? dayTotals[key]!.working_seconds : undefined;
    if (union !== undefined) agg.workSeconds += union;
    for (const tool of TOOLS) {
      const c: Counts | undefined = tools[tool];
      if (c === undefined) continue;
      agg.turns += c.turns;
      if (union === undefined) agg.workSeconds += c.working_seconds;
      agg.sessions += c.sessions;
      agg.subagentTurns += c.subagent_turns;
      agg.needsYou += c.needs_you;
      if ((c.turns > 0 || c.working_seconds > 0) && !agg.worked.includes(tool)) agg.worked.push(tool);
      if (c.turns > 0 && !agg.withTurns.includes(tool)) agg.withTurns.push(tool);
    }
    agg.worked.sort((a, b) => TOOL_RANK.get(a)! - TOOL_RANK.get(b)!);
    agg.withTurns.sort((a, b) => TOOL_RANK.get(a)! - TOOL_RANK.get(b)!);
  }
  return out;
}

/** The user's priority list first, then every other structure in default order. */
function effectiveOrder(order: readonly ProgressionStructureId[]): ProgressionStructureId[] {
  const out: ProgressionStructureId[] = [];
  for (const id of order) if (COST_BY_ID.has(id) && !out.includes(id)) out.push(id);
  for (const id of PROGRESSION_STRUCTURE_IDS) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * Variants are fixed at the first delivery and never change afterwards:
 * - workshop_1: the first tool seen (ties on the same day broken by the contract's tool order);
 * - workshop_2: the second tool seen on an earlier day, else a guest house;
 * - crossing: a footbridge once two tools were seen on earlier days, else a jetty.
 * workshop_2 and crossing look only at finished days, so a tool's first appearance later in the day
 * never changes a structure the user already watched being started.
 */
function decideVariant(id: ProgressionStructureId, toolsSeen: readonly Tool[], seenBefore: readonly Tool[]): StructureVariant | undefined {
  if (id === "workshop_1") return toolsSeen[0];
  if (id === "workshop_2") return seenBefore.length >= 2 ? seenBefore[1] : "guest_house";
  if (id === "crossing") return seenBefore.length >= 2 ? "footbridge" : "jetty";
  return undefined;
}

function withVariant(s: WorldStructure, variant: StructureVariant | undefined): WorldStructure {
  return variant === undefined ? s : { ...s, variant };
}

// ---------------------------------------------------------------------------------------------------
// Milestones and decorations
// ---------------------------------------------------------------------------------------------------

function noteMilestones(m: Map<MilestoneId, number>, d: number, agg: DayAgg, lifetimeTurns: number, streak: number): void {
  const reach = (id: MilestoneId, ok: boolean) => {
    if (ok && !m.has(id)) m.set(id, d);
  };
  reach("first_turn", agg.turns > 0);
  reach("first_answer", agg.needsYou > 0);
  reach("first_subagent", agg.subagentTurns > 0);
  reach("two_tools_day", agg.withTurns.length >= 2);
  reach("turns_100", lifetimeTurns >= 100);
  reach("streak_7", streak >= 7);
  reach("turns_1000", lifetimeTurns >= 1000);
}

function milestoneList(m: Map<MilestoneId, number>): WorldMilestone[] {
  return MILESTONE_IDS.filter((id) => m.has(id))
    .map((id) => ({ id, n: m.get(id)! }))
    .sort((a, b) => (a.n - b.n) || (MILESTONE_IDS.indexOf(a.id) - MILESTONE_IDS.indexOf(b.id)))
    .map(({ id, n }) => ({ id, day: dayString(n) }));
}

/** Each decoration's slot: a seeded shuffle of its zone's slots, so slots never depend on purchase order. */
function decorationSlots(seed: number): Map<string, number> {
  const out = new Map<string, number>();
  const zones = Object.keys(DECORATION_ZONES) as DecorationZone[];
  zones.forEach((zone, zi) => {
    const r = DECORATION_ZONES[zone];
    const all: number[] = [];
    for (let s = r.first; s <= r.last; s++) all.push(s);
    const order = shuffled(all, mulberry32(mixSeed(seed, zi + 1)));
    let k = 0;
    for (const d of DECORATIONS) if (d.zone === zone) out.set(d.id, order[k++]!);
  });
  return out;
}
