// WP-08 spread check: how far the pacing of each usage profile moves across day-to-day jitter.
//   node sim/spread.ts [--runs 200] [--days 90]
// For each profile: one canonical run (no jitter) and one jittered run per seed 1..runs.
// Four numbers per run: progression structures built on day 1 and on day 14, the hamlet day and the
// village day (null if the tier is not reached within --days).
import { parseArgs } from "node:util";
import { PROGRESSION_STRUCTURE_IDS } from "../src/ids.ts";
import { PROFILES, profileLedger } from "./profiles.ts";
import type { Profile } from "./profiles.ts";
import { EMPTY_CHOICES, builtCount, firstDayAtTier, simulateLedger } from "./simulate.ts";
import type { SimDay } from "./simulate.ts";

const PROFILE_KEYS = ["light", "typical", "no-prompts", "heavy"] as const;
const TOTAL_STRUCTURES = PROGRESSION_STRUCTURE_IDS.length;

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "200" },
    days: { type: "string", default: "90" },
  },
});

const runs = Number(values.runs);
const days = Number(values.days);
if (!Number.isInteger(runs) || runs < 1) {
  console.error("--runs must be a positive integer");
  process.exit(2);
}
if (!Number.isInteger(days) || days < 14 || days > 3660) {
  console.error("--days must be an integer from 14 to 3660 (day 14 is measured)");
  process.exit(2);
}

interface Measures {
  readonly built1: number;
  readonly built14: number;
  readonly hamlet: number | null;
  readonly village: number | null;
}

const METRICS: readonly { readonly key: keyof Measures; readonly label: string }[] = [
  { key: "built1", label: "built on day 1" },
  { key: "built14", label: "built on day 14" },
  { key: "hamlet", label: "hamlet day" },
  { key: "village", label: "village day" },
];

function dayOf(run: readonly SimDay[], n: number): SimDay {
  const d = run[n - 1];
  if (d === undefined) throw new Error(`simulation has no day ${n}`);
  return d;
}

function measure(run: readonly SimDay[]): Measures {
  return {
    built1: builtCount(dayOf(run, 1).world),
    built14: builtCount(dayOf(run, 14).world),
    hamlet: firstDayAtTier(run, "hamlet"),
    village: firstDayAtTier(run, "village"),
  };
}

function measureRun(profile: Profile, jitterSeed?: number): Measures {
  const ledger = profileLedger(profile, days, { jitterSeed });
  return measure(simulateLedger(ledger, EMPTY_CHOICES, days));
}

function profileNamed(name: string): Profile {
  const p = PROFILES[name];
  if (p === undefined) throw new Error(`unknown profile ${name}`);
  return p;
}

interface ProfileRuns {
  readonly canonical: Measures;
  readonly jittered: readonly Measures[];
}

const started = performance.now();
const byProfile = new Map<string, ProfileRuns>();
for (const name of PROFILE_KEYS) {
  const profile = profileNamed(name);
  const canonical = measureRun(profile);
  const jittered: Measures[] = [];
  for (let seed = 1; seed <= runs; seed++) jittered.push(measureRun(profile, seed));
  byProfile.set(name, { canonical, jittered });
}

function runsOf(name: string): ProfileRuns {
  const r = byProfile.get(name);
  if (r === undefined) throw new Error(`no runs for ${name}`);
  return r;
}

// Nearest-rank percentile on a sorted, non-empty list. p = 0 gives the minimum, p = 100 the maximum.
function nearestRank(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  const v = sorted[rank - 1];
  if (v === undefined) throw new Error("nearestRank on an empty list");
  return v;
}

function tableRow(label: string, canonical: number | null, values: readonly (number | null)[]): string {
  const present = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const missing = values.length - present.length;
  const share = `${((100 * missing) / values.length).toFixed(1)}%`;
  const cell = (p: number) => (present.length === 0 ? "-" : String(nearestRank(present, p)));
  return [
    "|", label,
    "|", canonical === null ? "-" : String(canonical),
    "|", cell(0), "|", cell(10), "|", cell(25), "|", cell(50), "|", cell(75), "|", cell(90), "|", cell(100),
    "|", share, "|",
  ].join(" ");
}

const HEADER = "| metric | canonical | min | p10 | p25 | median | p75 | p90 | max | share not reached |";
const DIVIDER = "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|";

console.log(`pacing spread: ${runs} jittered runs per profile (seeds 1 to ${runs}), ${days} days each`);
for (const name of PROFILE_KEYS) {
  const { canonical, jittered } = runsOf(name);
  console.log("");
  console.log(`### ${name}`);
  console.log(HEADER);
  console.log(DIVIDER);
  for (const m of METRICS) {
    console.log(tableRow(m.label, canonical[m.key], jittered.map((j) => j[m.key])));
  }
}

const pct = (count: number, total: number) => `${((100 * count) / total).toFixed(1)}% (${count} of ${total})`;

const typical = runsOf("typical").jittered;
const light = runsOf("light").jittered;
const heavy = runsOf("heavy").jittered;

// Pair typical and heavy runs by jitter seed (index i is seed i + 1), keeping only pairs where both reached the village.
const ratios: number[] = [];
typical.forEach((t, i) => {
  const h = heavy[i]?.village ?? null;
  if (t.village !== null && h !== null) ratios.push(t.village / h);
});
const sortedRatios = [...ratios].sort((a, b) => a - b);

console.log("");
console.log("checks (jittered runs)");
console.log(`typical: day 1 at least 3 built: ${pct(typical.filter((m) => m.built1 >= 3).length, typical.length)}`);
console.log(`light: day 1 at least 3 built: ${pct(light.filter((m) => m.built1 >= 3).length, light.length)}`);
console.log(`typical: unbuilt structure on day 14 (fewer than ${TOTAL_STRUCTURES} built): ` +
  pct(typical.filter((m) => m.built14 < TOTAL_STRUCTURES).length, typical.length));
console.log(`typical: village on days 18 to 28: ` +
  pct(typical.filter((m) => m.village !== null && m.village >= 18 && m.village <= 28).length, typical.length));
if (ratios.length === 0) {
  console.log("heavy/typical village-day ratio at most 2.2: no seed reached the village on both profiles");
  console.log("village-day ratio (typical / heavy, same seed): no pairs");
} else {
  console.log(`heavy/typical village-day ratio at most 2.2 (typical village day / heavy village day, same seed; ` +
    `${ratios.length} pairs where both reached): ` + pct(ratios.filter((r) => r <= 2.2).length, ratios.length));
  console.log(`village-day ratio (typical / heavy): min ${nearestRank(sortedRatios, 0).toFixed(2)}, ` +
    `median ${nearestRank(sortedRatios, 50).toFixed(2)}, max ${nearestRank(sortedRatios, 100).toFixed(2)}`);
}

console.log("");
console.log(`total run time: ${((performance.now() - started) / 1000).toFixed(1)} s`);
