// WP-08 acceptance test 3: ledgers with gaps never lose structures. Because the live app recomputes
// grow() on every ledger flush, "never lost" must hold along every path the inputs can grow:
//   (a) more days pass, with or without activity (gaps of any length);
//   (b) today's counters go up;
//   (c) a choice dated today is appended.
// In each case every structure complete before stays complete with the same completed_day; earned
// resources, owned decorations and milestones never shrink; the tier never drops.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Choices, Ledger, ProgressionStructureId, World } from "@busyholm/contracts";
import { grow } from "../src/grow.ts";
import { PROGRESSION_STRUCTURE_IDS } from "../src/ids.ts";
import { dayNumber, dayString } from "../src/days.ts";
import { PROFILES, profileLedger } from "../sim/profiles.ts";
import { EMPTY_CHOICES } from "../sim/simulate.ts";
import { genCase } from "./gen.ts";
import { clone } from "./helpers.ts";

const TIER = { camp: 0, hamlet: 1, village: 2 } as const;

function assertNothingLost(before: World, after: World, label: string, sameDay: boolean): void {
  const afterById = new Map(after.structures.map((s) => [s.id, s]));
  for (const s of before.structures) {
    if (s.status !== "complete") continue;
    const a = afterById.get(s.id);
    assert.ok(a !== undefined && a.status === "complete", `${label}: ${s.id} was complete, now ${a?.status ?? "missing"}`);
    assert.equal(a.completed_day, s.completed_day, `${label}: ${s.id} completed_day moved`);
    if (!sameDay || s.completed_day !== before.as_of_day) assert.equal(a.variant, s.variant, `${label}: ${s.id} variant changed`);
  }
  assert.ok(TIER[after.tier] >= TIER[before.tier], `${label}: tier dropped ${before.tier} -> ${after.tier}`);
  for (const k of ["planks", "stone", "seeds"] as const) {
    assert.ok(after.earned[k] >= before.earned[k], `${label}: earned ${k} shrank`);
  }
  const owned = new Map(after.decorations.map((d) => [d.id, d.slot]));
  for (const d of before.decorations) assert.equal(owned.get(d.id), d.slot, `${label}: decoration ${d.id} lost or moved`);
  const ms = new Map(after.milestones.map((m) => [m.id, m.day]));
  for (const m of before.milestones) assert.equal(ms.get(m.id), m.day, `${label}: milestone ${m.id} lost or moved`);
  assert.ok(after.stats.lifetime_turns >= before.stats.lifetime_turns, `${label}: lifetime turns shrank`);
}

function lastDayOf(ledger: Ledger, choices: Choices): number {
  let last = dayNumber(ledger.founded_day);
  for (const d of Object.keys(ledger.days)) last = Math.max(last, dayNumber(d));
  for (const e of choices.log) last = Math.max(last, dayNumber(e.day));
  return last;
}

test("(a) random gapped ledgers: the world at each later day keeps everything from the day before", () => {
  for (let i = 0; i < 120; i++) {
    const c = genCase(0x6a95, i);
    const start = dayNumber(c.ledger.founded_day);
    const end = Math.min(lastDayOf(c.ledger, c.choices) + 10, start + 150);
    let prev: World | null = null;
    for (let d = start; d <= end; d++) {
      const w = grow(c.seed, c.ledger, c.choices, { asOfDay: dayString(d) });
      if (prev !== null) assertNothingLost(prev, w, `case ${i} day ${dayString(d)}`, false);
      prev = w;
    }
  }
});

test("(a) a 60-day break in the middle of typical use loses nothing and nothing decays", () => {
  const full = profileLedger(PROFILES.typical!, 90);
  const ledger = clone(full);
  const founded = dayNumber(ledger.founded_day);
  for (const d of Object.keys(ledger.days)) {
    const n = dayNumber(d) - founded;
    if (n >= 10 && n < 70) delete ledger.days[d];
  }
  const before = grow(ledger.seed, ledger, EMPTY_CHOICES, { asOfDay: dayString(founded + 9) });
  const during = grow(ledger.seed, ledger, EMPTY_CHOICES, { asOfDay: dayString(founded + 69) });
  const after = grow(ledger.seed, ledger, EMPTY_CHOICES, { asOfDay: dayString(founded + 89) });
  assertNothingLost(before, during, "end of the break", false);
  assertNothingLost(during, after, "after the break", false);
  assert.deepEqual(during.earned, before.earned, "nothing is earned or lost during the break");
  assert.deepEqual(during.resources, before.resources, "the stockpile does not decay during the break");
  assert.ok(after.earned.planks > during.earned.planks, "building resumes after the break");
});

test("(b) today's counters going up never removes anything", () => {
  for (let i = 0; i < 150; i++) {
    const c = genCase(0xb0b, i);
    const days = Object.keys(c.ledger.days).sort();
    if (days.length === 0) continue;
    const today = days[days.length - 1]!;
    let ledger = c.ledger;
    let prev = grow(c.seed, ledger, c.choices, { asOfDay: today });
    for (let step = 0; step < 12; step++) {
      ledger = clone(ledger);
      const tools = ledger.days[today]!;
      for (const counts of Object.values(tools)) {
        counts.turns = Math.min(1_000_000, counts.turns + 1 + step);
        counts.working_seconds = Math.min(5_529_600, counts.working_seconds + 300 * (step + 1));
        counts.sessions = Math.min(1_000_000, counts.sessions + (step % 3 === 0 ? 1 : 0));
      }
      const w = grow(c.seed, ledger, c.choices, { asOfDay: today });
      assertNothingLost(prev, w, `case ${i} step ${step}`, true);
      prev = w;
    }
  }
});

test("(b) the first agent event of the founding day never takes back a structure the crate built", () => {
  const ledger: Ledger = {
    schema_version: 1, privacy: { containsText: false }, seed: 7, founded_day: "2026-10-12",
    hooks_first_connected_day: null, days: {}, backfill: null,
  };
  const empty = grow(7, ledger, EMPTY_CHOICES);
  const withTurn = clone(ledger);
  withTurn.days["2026-10-12"] = { codex: { turns: 1, interrupted_turns: 0, sessions: 1, working_seconds: 120, needs_you: 0, errors: 0, recovered: 0, limit_hits: 0, subagent_turns: 0 } };
  assertNothingLost(empty, grow(7, withTurn, EMPTY_CHOICES), "first turn", true);
});

test("(c) a build-order or decoration choice dated today never removes anything", () => {
  for (let i = 0; i < 150; i++) {
    const c = genCase(0xc0c, i);
    const today = dayString(lastDayOf(c.ledger, c.choices));
    const before = grow(c.seed, c.ledger, c.choices, { asOfDay: today });
    const reversed = before.structures.map((s) => s.id).reverse()
      .filter((id): id is ProgressionStructureId => (PROGRESSION_STRUCTURE_IDS as readonly string[]).includes(id));
    const choices: Choices = clone(c.choices);
    const t = 4_000_000_000_000;
    choices.log.push({ t, day: today, kind: "build_order", order: reversed });
    choices.log.push({ t: t + 1, day: today, kind: "decoration", decoration: "wildflowers", on: true });
    const after = grow(c.seed, c.ledger, choices, { asOfDay: today });
    assertNothingLost(before, after, `case ${i}`, true);
  }
});
