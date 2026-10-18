// SPEC Revision 1 item 6: no unsafe incentives.
// - Answering speed has zero effect on the world. Since contracts r1 the ledger cannot even carry it
//   (quick_answers was removed), and the world has no field for it; both are checked here so a future
//   contract change that brings it back fails this test.
// - Having permission prompts at all has no effect on building: any number of needs-you episodes,
//   including none, gives the same world except the cosmetic first_answer milestone (a ribbon on the
//   bell, which needs a prompt to exist; it carries no resources).
// - Nothing gates on answers: the only extra condition a structure can wait on is active days.
// - Counters that must never pay (errors, recoveries, limit hits, interrupted turns, subagent turns,
//   needs-you episodes, sessions) earn no resources and build nothing.
// - Volume is capped: no day, however heavy, earns more than 2.2 times a typical day, and working time
//   past the daily cap, from one agent or several side by side, buys nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Counts, Ledger } from "@busyholm/contracts";
import { SCHEMAS } from "@busyholm/contracts";
import { grow } from "../src/grow.ts";
import { PROFILES, profileLedger } from "../sim/profiles.ts";
import { EMPTY_CHOICES } from "../sim/simulate.ts";
import { genCase } from "./gen.ts";
import { clone, withoutFirstAnswer } from "./helpers.ts";

function mapCounts(ledger: Ledger, f: (c: Counts, i: number) => void): Ledger {
  const l = clone(ledger);
  let i = 0;
  for (const tools of Object.values(l.days)) for (const c of Object.values(tools)) f(c, i++);
  if (l.backfill !== null) for (const tools of Object.values(l.backfill.days)) for (const c of Object.values(tools)) f(c, i++);
  return l;
}

const SPEED = /quick|answer|latency|speed|response_time/i;

test("answering speed cannot reach the world: no ledger counter or world field measures it", () => {
  const ledger = SCHEMAS.ledger as { $defs: { counts: { properties: Record<string, unknown> } } };
  const counters = Object.keys(ledger.$defs.counts.properties);
  assert.deepEqual(counters.filter((k) => SPEED.test(k)), [], `ledger counters: ${counters.join(", ")}`);
  const world = SCHEMAS.world as { $defs: { stats: { properties: Record<string, unknown> }; structure: { properties: { waiting_for: { properties: Record<string, unknown> } } } } };
  assert.deepEqual(Object.keys(world.$defs.stats.properties).filter((k) => SPEED.test(k)), []);
  assert.deepEqual(Object.keys(world.$defs.structure.properties.waiting_for.properties), ["active_days"]);
});

test("permission prompts have zero effect: none, few or many give the same world except the first_answer ribbon", () => {
  for (let i = 0; i < 300; i++) {
    const c = genCase(0xfa2, i);
    const none = mapCounts(c.ledger, (x) => { x.needs_you = 0; });
    const many = mapCounts(c.ledger, (x, k) => { x.needs_you = 1 + ((k * 7919) % 400); });
    for (const edition of ["full", "demo"] as const) {
      const a = grow(c.seed, none, c.choices, { edition });
      const b = grow(c.seed, c.ledger, c.choices, { edition });
      const m = grow(c.seed, many, c.choices, { edition });
      assert.deepEqual(withoutFirstAnswer(a), withoutFirstAnswer(b), `case ${i} ${edition}: none vs generated`);
      assert.deepEqual(withoutFirstAnswer(m), withoutFirstAnswer(b), `case ${i} ${edition}: many vs generated`);
    }
  }
});

test("nothing ever waits on answers: a waiting structure only ever waits for active days", () => {
  for (let i = 0; i < 300; i++) {
    const c = genCase(0xfa3, i);
    const w = grow(c.seed, c.ledger, c.choices);
    for (const s of w.structures) {
      if (s.status === "waiting") assert.ok(s.waiting_for !== undefined && Object.keys(s.waiting_for).join() === "active_days", `case ${i}`);
    }
  }
});

test("errors, recoveries, limit hits, interrupts, subagent turns, prompts and sessions earn nothing", () => {
  for (let i = 0; i < 300; i++) {
    const c = genCase(0xfa4, i);
    const quiet = mapCounts(c.ledger, (x) => {
      x.errors = 0; x.recovered = 0; x.limit_hits = 0; x.interrupted_turns = 0; x.subagent_turns = 0; x.needs_you = 0; x.sessions = 0;
    });
    const loud = mapCounts(c.ledger, (x, k) => {
      x.errors = 50 + k; x.recovered = 40; x.limit_hits = 9; x.interrupted_turns = 300; x.subagent_turns = 900; x.needs_you = 500; x.sessions = 64;
    });
    const a = grow(c.seed, quiet, c.choices);
    const b = grow(c.seed, loud, c.choices);
    assert.deepEqual(a.earned, b.earned, `case ${i} earned`);
    assert.deepEqual(a.resources, b.resources, `case ${i} resources`);
    assert.deepEqual(a.structures, b.structures, `case ${i} structures`);
    assert.deepEqual(a.decorations, b.decorations, `case ${i} decorations`);
  }
});

function oneDay(counts: Partial<Counts>[]): Ledger {
  const base: Counts = { turns: 0, interrupted_turns: 0, sessions: 1, working_seconds: 0, needs_you: 0, errors: 0, recovered: 0, limit_hits: 0, subagent_turns: 0 };
  const tools = ["claude", "codex", "opencode", "antigravity"] as const;
  const day: Ledger["days"][string] = {};
  counts.forEach((c, i) => { day[tools[i]!] = { ...base, ...c }; });
  return { schema_version: 1, privacy: { containsText: false }, seed: 1, founded_day: "2026-10-12", hooks_first_connected_day: null, days: { "2026-10-13": day }, backfill: null };
}

function dayEarned(counts: Partial<Counts>[]): { planks: number; stone: number; seeds: number } {
  const l = oneDay(counts);
  const after = grow(1, l, EMPTY_CHOICES).earned;
  const before = grow(1, l, EMPTY_CHOICES, { asOfDay: "2026-10-12" }).earned;
  return { planks: after.planks - before.planks, stone: after.stone - before.stone, seeds: after.seeds - before.seeds };
}

test("no single day earns more than 2.2 times a typical day, whatever the volume", () => {
  const t = PROFILES.typical!.day[0]!;
  const typical = dayEarned([{ turns: t.turns, working_seconds: t.workingMinutes * 60 }]);
  const max = dayEarned([
    { turns: 1_000_000, working_seconds: 90_000, subagent_turns: 1_000_000, sessions: 1_000_000 },
    { turns: 1_000_000, working_seconds: 90_000 },
    { turns: 1_000_000, working_seconds: 90_000 },
    { turns: 1_000_000, working_seconds: 90_000 },
  ]);
  assert.ok(max.planks <= 2.2 * typical.planks, `planks ${max.planks} vs typical ${typical.planks}`);
  assert.ok(max.stone <= 2.2 * typical.stone, `stone ${max.stone} vs typical ${typical.stone}`);
  assert.ok(max.seeds <= 2.2 * Math.max(1, typical.seeds), `seeds ${max.seeds} vs typical ${typical.seeds}`);
});

test("concurrency: the same work split across more agents or sessions never earns more", () => {
  // Same-tool concurrency is already wall time in the ledger (contracts r1). Across tools the ledger
  // still sums per-tool wall time; the daily cap bounds what side-by-side tools can add (calibration.md).
  const one = dayEarned([{ turns: 12, working_seconds: 9000, sessions: 1 }]);
  const split = dayEarned([
    { turns: 4, working_seconds: 3000, sessions: 3 },
    { turns: 4, working_seconds: 3000, sessions: 3 },
    { turns: 4, working_seconds: 3000, sessions: 3 },
  ]);
  assert.deepEqual(split, one);
  const fourAgentsSixHours = dayEarned([1, 2, 3, 4].map(() => ({ turns: 10, working_seconds: 6 * 3600 })));
  const oneAgentSixHours = dayEarned([{ turns: 40, working_seconds: 6 * 3600 }]);
  assert.deepEqual(fourAgentsSixHours, oneAgentSixHours, "summed time past the daily cap buys nothing");
});

test("sessions alone earn nothing: starting and stopping sessions is not work", () => {
  const idle = dayEarned([{ turns: 0, sessions: 200, working_seconds: 0 }]);
  assert.deepEqual(idle, { planks: 0, stone: 0, seeds: 0 });
});

test("no-prompts profile ledger has zero prompts and the same earnings as typical", () => {
  const a = profileLedger(PROFILES["no-prompts"]!, 28);
  const b = profileLedger(PROFILES.typical!, 28);
  for (const tools of Object.values(a.days)) for (const c of Object.values(tools)) assert.equal(c.needs_you, 0);
  assert.deepEqual(grow(a.seed, a, EMPTY_CHOICES).earned, grow(b.seed, b, EMPTY_CHOICES).earned);
});

// Review r1 M2: Ledger v1's optional day_totals holds the wall-time union across tools, so tools working
// at the same time are not summed. Without it the per-tool values are summed exactly as before.
function dayEarnedWith(counts: Partial<Counts>[], dayTotalSeconds?: number): { planks: number; stone: number; seeds: number } {
  const l = oneDay(counts);
  if (dayTotalSeconds !== undefined) l.day_totals = { "2026-10-13": { working_seconds: dayTotalSeconds } };
  const after = grow(1, l, EMPTY_CHOICES).earned;
  const before = grow(1, l, EMPTY_CHOICES, { asOfDay: "2026-10-12" }).earned;
  return { planks: after.planks - before.planks, stone: after.stone - before.stone, seeds: after.seeds - before.seeds };
}

test("day_totals: Claude and Codex genuinely overlapping for 3 h earn what one tool working 3 h earns", () => {
  const oneTool = dayEarnedWith([{ turns: 20, working_seconds: 10_800 }]);
  const overlap = dayEarnedWith([
    { turns: 10, working_seconds: 10_800 },
    { turns: 10, working_seconds: 10_800 },
  ], 10_800);
  assert.ok(oneTool.stone > 0, "the comparison needs a day that earns stone");
  assert.deepEqual(overlap, oneTool);
  // Without day_totals the same ledger is the old behaviour: the per-tool wall times are summed (6 h).
  const summed = dayEarnedWith([
    { turns: 10, working_seconds: 10_800 },
    { turns: 10, working_seconds: 10_800 },
  ]);
  assert.ok(summed.stone > oneTool.stone, "the old sum is higher, which is the bug day_totals fixes");
  assert.deepEqual(summed, dayEarnedWith([{ turns: 20, working_seconds: 21_600 }]));
});

test("day_totals absent, empty, or listing other days leaves the world exactly as before", () => {
  const counts = [{ turns: 10, working_seconds: 10_800 }, { turns: 10, working_seconds: 7_200 }];
  const plain = oneDay(counts);
  const empty = { ...clone(plain), day_totals: {} };
  const other = { ...clone(plain), day_totals: { "2026-10-20": { working_seconds: 60 } } };
  const base = grow(1, plain, EMPTY_CHOICES);
  assert.deepEqual(grow(1, empty, EMPTY_CHOICES), base);
  assert.deepEqual(grow(1, other, EMPTY_CHOICES), base);
  // A day_totals value equal to the per-tool sum changes nothing either.
  assert.deepEqual(dayEarnedWith(counts, 18_000), dayEarnedWith(counts));
});

test("day_totals replaces the per-tool sum even down to zero, and a day_totals day without counts earns nothing", () => {
  const counts = [{ turns: 10, working_seconds: 3_600 }];
  assert.deepEqual(dayEarnedWith(counts, 0), dayEarnedWith([{ turns: 10, working_seconds: 0 }]));
  const stray = oneDay([{ turns: 0, working_seconds: 0 }]);
  stray.days = {};
  stray.day_totals = { "2026-10-13": { working_seconds: 90_000 } };
  assert.deepEqual(grow(1, stray, EMPTY_CHOICES).earned, grow(1, { ...clone(stray), day_totals: {} }, EMPTY_CHOICES).earned);
});

test("day_totals merge like days: impossible dates that land on one day add their totals", () => {
  // 2027-02-30 and 2027-03-02 are the same civil day; each key carries its own union.
  const base: Counts = { turns: 6, interrupted_turns: 0, sessions: 1, working_seconds: 3_600, needs_you: 0, errors: 0, recovered: 0, limit_hits: 0, subagent_turns: 0 };
  const merged: Ledger = {
    schema_version: 1, privacy: { containsText: false }, seed: 1, founded_day: "2027-02-01", hooks_first_connected_day: null,
    days: { "2027-02-30": { claude: base, codex: base }, "2027-03-02": { claude: base } },
    day_totals: { "2027-02-30": { working_seconds: 3_600 }, "2027-03-02": { working_seconds: 3_600 } },
    backfill: null,
  };
  const single: Ledger = {
    ...clone(merged),
    days: { "2027-03-02": { claude: { ...base, turns: 18, working_seconds: 7_200 } } },
    day_totals: { "2027-03-02": { working_seconds: 7_200 } },
  };
  assert.deepEqual(grow(1, merged, EMPTY_CHOICES).earned, grow(1, single, EMPTY_CHOICES).earned);
});
