// Day-by-day simulation shared by the CLI (sim/sim.ts) and the pacing tests.
import type { Choices, Ledger, World } from "@busyholm/contracts";
import { PROGRESSION_STRUCTURE_IDS } from "../src/ids.ts";
import { grow } from "../src/grow.ts";
import { DECORATIONS } from "../src/config.ts";
import type { GrowOptions } from "../src/grow.ts";
import { dayNumber, dayString } from "../src/days.ts";
import { profileLedger } from "./profiles.ts";
import type { LedgerOptions, Profile } from "./profiles.ts";

export const EMPTY_CHOICES: Choices = { schema_version: 1, privacy: { containsText: false }, log: [] };

export interface SimDay {
  /** 1-based calendar day; day 1 is the founding day. */
  readonly n: number;
  readonly day: string;
  readonly world: World;
}

/** The world at the end of each calendar day 1..days. */
export function simulate(profile: Profile, days: number, opts: LedgerOptions & { edition?: GrowOptions["edition"] } = {}): SimDay[] {
  const ledger = profileLedger(profile, days, opts);
  return simulateLedger(ledger, EMPTY_CHOICES, days, opts.edition);
}

export function simulateLedger(ledger: Ledger, choices: Choices, days: number, edition?: GrowOptions["edition"]): SimDay[] {
  const founded = dayNumber(ledger.founded_day);
  const out: SimDay[] = [];
  for (let i = 0; i < days; i++) {
    const day = dayString(founded + i);
    const options: GrowOptions = edition === undefined ? { asOfDay: day } : { asOfDay: day, edition };
    out.push({ n: i + 1, day, world: grow(ledger.seed, ledger, choices, options) });
  }
  return out;
}

const PROGRESSION = new Set<string>(PROGRESSION_STRUCTURE_IDS);

/** Complete progression structures (the 12 of SPEC 4.5; free and backfill structures excluded). */
export function builtCount(world: World): number {
  return world.structures.filter((s) => PROGRESSION.has(s.id) && s.status === "complete").length;
}

/** First 1-based day on which the world reached the tier, or null. */
export function firstDayAtTier(run: readonly SimDay[], tier: World["tier"]): number | null {
  const rank = { camp: 0, hamlet: 1, village: 2 } as const;
  for (const d of run) if (rank[d.world.tier] >= rank[tier]) return d.n;
  return null;
}

/**
 * Like simulateLedger, but a simple shopper buys decorations as soon as it can: at the end of each day
 * it buys the first unlocked, affordable, not-yet-owned decoration in catalogue order, and repeats
 * until nothing more is affordable. Shows the decoration pacing; the choices it makes are returned.
 */
export function simulateWithShop(ledger: Ledger, days: number, edition?: GrowOptions["edition"]): { run: SimDay[]; choices: Choices } {
  const founded = dayNumber(ledger.founded_day);
  const choices: Choices = { schema_version: 1, privacy: { containsText: false }, log: [] };
  const out: SimDay[] = [];
  let t = 1_760_000_000_000;
  for (let i = 0; i < days; i++) {
    const day = dayString(founded + i);
    const options: GrowOptions = edition === undefined ? { asOfDay: day } : { asOfDay: day, edition };
    let world = grow(ledger.seed, ledger, choices, options);
    for (;;) {
      const owned = new Set(world.decorations.map((d) => d.id));
      const done = new Set(world.structures.filter((s) => s.status === "complete").map((s) => s.id as string));
      const pick = DECORATIONS.find((d) => !owned.has(d.id) && d.seeds <= world.resources.seeds && (d.requires === undefined || done.has(d.requires)));
      if (pick === undefined) break;
      choices.log.push({ t: t++, day, kind: "decoration", decoration: pick.id, on: true });
      const next = grow(ledger.seed, ledger, choices, options);
      if (next.decorations.length === world.decorations.length) { choices.log.pop(); break; } // refused (demo cap)
      world = next;
    }
    out.push({ n: i + 1, day, world });
  }
  return { run: out, choices };
}
