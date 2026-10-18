// Pacing simulation CLI (WP-08).
//   npm run sim -- --profile light|typical|no-prompts|heavy|max [--days 30] [--edition demo] [--jitter <seed>] [--shop greedy|none] [--json]
// Run from world/grow. By default a simple shopper buys each decoration as soon as it is unlocked and affordable.
// Prints the world at the end of each calendar day: what was earned, what is in stock, what is built.
import { parseArgs } from "node:util";
import { isoWeekday, dayNumber } from "../src/days.ts";
import { PROFILES, PROFILE_NAMES, profileLedger } from "./profiles.ts";
import { EMPTY_CHOICES, builtCount, firstDayAtTier, simulateLedger, simulateWithShop } from "./simulate.ts";
import type { World } from "@busyholm/contracts";

const { values } = parseArgs({
  options: {
    profile: { type: "string", default: "typical" },
    days: { type: "string", default: "30" },
    edition: { type: "string", default: "full" },
    jitter: { type: "string" },
    shop: { type: "string", default: "greedy" },
    json: { type: "boolean", default: false },
  },
});

const profile = PROFILES[values.profile ?? "typical"];
if (profile === undefined) {
  console.error(`unknown profile "${values.profile}"; one of: ${PROFILE_NAMES.join(", ")}`);
  process.exit(2);
}
const days = Number(values.days);
if (!Number.isInteger(days) || days < 1 || days > 3660) {
  console.error("--days must be an integer from 1 to 3660");
  process.exit(2);
}
const edition = values.edition === "demo" ? "demo" : "full";
const jitterSeed = values.jitter === undefined ? undefined : Number(values.jitter) >>> 0;

const ledger = profileLedger(profile, days, jitterSeed === undefined ? {} : { jitterSeed });
const shop = values.shop === "none" ? "none" : "greedy";
const run = shop === "none" ? simulateLedger(ledger, EMPTY_CHOICES, days, edition) : simulateWithShop(ledger, days, edition).run;

if (values.json) {
  console.log(JSON.stringify(run.map((d) => ({ n: d.n, day: d.day, world: d.world }))));
  process.exit(0);
}

const WEEKDAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

console.log(`Busyholm pacing: profile ${profile.name} (${profile.summary}), ${days} days, edition ${edition}` +
  (jitterSeed === undefined ? "" : `, jitter seed ${jitterSeed}`) + `, shop ${shop}`);
console.log("");
console.log(
  [pad("day", 4), pad("date", 15), lpad("turns", 6), lpad("work h", 7), lpad("+planks", 8), lpad("+stone", 7), lpad("+seeds", 7),
    lpad("planks", 7), lpad("stone", 6), lpad("seeds", 6), lpad("built", 6), pad(" tier", 8), pad("building", 22), "completed today / decorations"].join(" "),
);
let prev: World | null = null;
for (const d of run) {
  const w = d.world;
  const counts = ledger.days[d.day];
  let turns = 0;
  let secs = 0;
  if (counts !== undefined) for (const c of Object.values(counts)) { turns += c.turns; secs += c.working_seconds; }
  const e0 = prev?.earned ?? { planks: 0, stone: 0, seeds: 0 };
  const building = w.structures.find((s) => s.status === "building");
  const doneToday = w.structures.filter((s) => s.status === "complete" && s.completed_day === d.day).map((s) => s.id + (s.variant ? `(${s.variant})` : ""));
  const decoNew = w.decorations.length - (prev?.decorations.length ?? 0);
  const line = [
    pad(String(d.n), 4),
    pad(`${d.day} ${WEEKDAY[isoWeekday(dayNumber(d.day))]}`, 15),
    lpad(String(turns), 6),
    lpad((secs / 3600).toFixed(1), 7),
    lpad(fmt(w.earned.planks - e0.planks), 8),
    lpad(fmt(w.earned.stone - e0.stone), 7),
    lpad(fmt(w.earned.seeds - e0.seeds), 7),
    lpad(fmt(w.resources.planks), 7),
    lpad(fmt(w.resources.stone), 6),
    lpad(fmt(w.resources.seeds), 6),
    lpad(`${builtCount(w)}/12`, 6),
    pad(" " + w.tier + (w.demo_capped ? "*" : ""), 8),
    pad(building ? `${building.id} s${building.stage} ${Math.floor(building.progress * 100)}%` : "-", 22),
    doneToday.join(", ") + (decoNew > 0 ? `  [+${decoNew} decoration${decoNew > 1 ? "s" : ""}]` : ""),
  ].join(" ");
  console.log(line);
  prev = w;
}
const last = run[run.length - 1]!.world;
console.log("");
console.log(`hamlet on day ${firstDayAtTier(run, "hamlet") ?? "-"}, village on day ${firstDayAtTier(run, "village") ?? "-"}; ` +
  `streak ${last.stats.streak_days}, active days ${last.stats.active_days}, lifetime turns ${last.stats.lifetime_turns}` +
  (edition === "demo" ? `; demo capped: ${last.demo_capped}` : ""));
console.log(`milestones: ${last.milestones.map((m) => `${m.id} (${m.day})`).join(", ") || "-"}`);
console.log(`decorations: ${last.decorations.length} of 24 owned` + (last.decorations.length > 0 ? ` (${last.decorations.map((d) => d.id).join(", ")})` : ""));
