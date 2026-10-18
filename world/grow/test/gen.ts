// Random but reproducible Ledger v1 + Choices v1 inputs for the determinism, gap and fairness tests.
// Pure (seeded integer PRNG only), so Node and the browser generate byte-identical cases.
// Every generated ledger and choices file is schema-valid (test/contract.test.ts checks a sample),
// including the awkward corners the schemas allow: gaps of weeks, several tools a day, impossible but
// well-shaped dates (2026-02-30), huge counters, a history backfill, choices dated before founding or
// after the last active day, unknown decoration ids and repeated toggles.
import type { ChoiceEntry, Choices, Counts, DayTools, Ledger, ProgressionStructureId, Tool } from "@busyholm/contracts";
import { DECORATIONS, STRUCTURES } from "../src/config.ts";
import { dayNumber, dayString } from "../src/days.ts";
import { mixSeed, mulberry32, shuffled } from "../src/rng.ts";

export const GEN_TOOLS: readonly Tool[] = ["claude", "codex", "opencode", "antigravity", "gemini", "cursor", "aider", "other"];

export interface Case {
  readonly seed: number;
  readonly ledger: Ledger;
  readonly choices: Choices;
}

const BASE_DAY = dayNumber("2025-01-01");

/** The i-th random case for a master seed. */
export function genCase(master: number, i: number): Case {
  const next = mulberry32(mixSeed(master, i));
  const int = (n: number) => next() % n;
  const chance = (pct: number) => int(100) < pct;

  const founded = BASE_DAY + int(900);
  const span = 1 + int(chance(20) ? 400 : 90);
  const startOffset = chance(10) ? -int(5) : 0; // a few ledgers have counts before the founding day
  const density = 15 + int(85); // percent of days in the span that are listed

  const days: Record<string, DayTools> = {};
  for (let d = startOffset; d < span; d++) {
    if (!chance(density)) continue;
    days[maybeOddDay(founded + d, chance)] = genDayTools(int, chance);
  }

  const hooks = chance(70) ? dayString(founded + int(Math.max(1, span))) : null;

  let backfill: Ledger["backfill"] = null;
  if (chance(25)) {
    const bdays: Record<string, DayTools> = {};
    const n = int(32); // 0 to 31 listed days
    for (let k = 0; k < n; k++) bdays[dayString(founded - 31 + k)] = genDayTools(int, chance);
    backfill = { imported_at: 1_735_689_600_000 + int(1_000_000) * 60_000, days: bdays };
  }

  const ledger: Ledger = {
    schema_version: 1,
    privacy: { containsText: false },
    seed: next(),
    founded_day: dayString(founded),
    hooks_first_connected_day: hooks,
    days,
    backfill,
  };

  const log: ChoiceEntry[] = [];
  const nChoices = chance(30) ? 0 : int(25);
  let t = 1_735_689_600_000 + int(1_000) * 86_400_000;
  for (let k = 0; k < nChoices; k++) {
    t += 1 + int(3 * 86_400_000);
    const day = dayString(founded - 2 + int(span + 6));
    if (chance(35)) {
      const ids = shuffled(STRUCTURES.map((s) => s.id), next);
      const order: ProgressionStructureId[] = ids.slice(0, 1 + int(12));
      log.push({ t, day, kind: "build_order", order });
    } else {
      const known = DECORATIONS[int(DECORATIONS.length)]!.id;
      const decoration = chance(8) ? "not_in_catalogue" : known;
      log.push({ t, day, kind: "decoration", decoration, on: !chance(20) });
    }
  }
  // Choices are written oldest first by the core; sort by day so the log reads naturally, keeping t increasing.
  log.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  let tt = 1_735_689_600_000;
  for (const e of log) {
    tt += 1000;
    (e as { t: number }).t = tt;
  }

  return { seed: next(), ledger, choices: { schema_version: 1, privacy: { containsText: false }, log } };
}

/** Occasionally swap a real date for a well-shaped impossible one in the same month (schemas allow it). */
function maybeOddDay(n: number, chance: (pct: number) => boolean): string {
  const s = dayString(n);
  if (!chance(2)) return s;
  const month = s.slice(5, 7);
  if (month === "02") return s.slice(0, 8) + "30";
  if (month === "04" || month === "06" || month === "09" || month === "11") return s.slice(0, 8) + "31";
  return s;
}

function genDayTools(int: (n: number) => number, chance: (pct: number) => boolean): DayTools {
  const out: DayTools = {};
  const nTools = 1 + (chance(30) ? int(3) : 0);
  for (let k = 0; k < nTools; k++) {
    const tool = chance(80) ? (chance(65) ? "claude" : "codex") : GEN_TOOLS[int(GEN_TOOLS.length)]!;
    out[tool] = genCounts(int, chance);
  }
  return out;
}

function genCounts(int: (n: number) => number, chance: (pct: number) => boolean): Counts {
  const huge = chance(3);
  const turns = huge ? int(1_000_001) : chance(15) ? 0 : int(chance(20) ? 250 : 45);
  return {
    turns,
    interrupted_turns: int(6),
    sessions: chance(10) ? 0 : 1 + int(huge ? 64 : 8),
    working_seconds: huge ? int(90_001) : chance(10) ? 0 : int(chance(20) ? 72_000 : 18_000),
    needs_you: int(turns + 3),
    errors: int(4),
    recovered: int(3),
    limit_hits: chance(10) ? 1 + int(3) : 0,
    subagent_turns: chance(30) ? int(120) : 0,
  };
}
