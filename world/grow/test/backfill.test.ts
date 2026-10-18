// WP-08 acceptance test 4: the history backfill never exceeds its cap (SPEC 4.5: at most 50 planks,
// 24 stone and 6 seeds whatever the history size), and engraves the Founders' Stone.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Counts, DayTools, Ledger } from "@busyholm/contracts";
import { grow } from "../src/grow.ts";
import { BACKFILL_CAP } from "../src/config.ts";
import { dayNumber, dayString } from "../src/days.ts";
import { EMPTY_CHOICES } from "../sim/simulate.ts";
import { genCase } from "./gen.ts";
import { clone } from "./helpers.ts";

const big: Counts = {
  turns: 1_000_000, interrupted_turns: 0, sessions: 64, working_seconds: 90_000, needs_you: 0,
  errors: 0, recovered: 0, limit_hits: 0, subagent_turns: 0,
};

function ledgerWithBackfill(days: number, perTool: DayTools): Ledger {
  const founded = dayNumber("2026-10-12");
  const bdays: Record<string, DayTools> = {};
  for (let k = 1; k <= days; k++) bdays[dayString(founded - k)] = clone(perTool);
  return {
    schema_version: 1, privacy: { containsText: false }, seed: 99, founded_day: "2026-10-12",
    hooks_first_connected_day: "2026-10-12", days: {}, backfill: { imported_at: 1_760_270_400_000, days: bdays },
  };
}

const withoutBackfill = (l: Ledger): Ledger => ({ ...clone(l), backfill: null });

test("a huge 31-day history earns exactly the cap, never more", () => {
  const l = ledgerWithBackfill(31, { claude: big, codex: big, opencode: big });
  const a = grow(l.seed, l, EMPTY_CHOICES).earned;
  const b = grow(l.seed, withoutBackfill(l), EMPTY_CHOICES).earned;
  assert.equal(a.planks - b.planks, BACKFILL_CAP.planks);
  assert.equal(a.stone - b.stone, BACKFILL_CAP.stone);
  assert.equal(a.seeds - b.seeds, BACKFILL_CAP.seeds);
});

test("random backfills never add more than the cap, on any day of the world", () => {
  let withBackfill = 0;
  for (let i = 0; i < 400; i++) {
    const c = genCase(0xbac, i);
    if (c.ledger.backfill === null) continue;
    withBackfill++;
    for (const extra of [0, 3, 30]) {
      const asOfDay = dayString(dayNumber(c.ledger.founded_day) + extra);
      const a = grow(c.seed, c.ledger, c.choices, { asOfDay }).earned;
      const b = grow(c.seed, withoutBackfill(c.ledger), c.choices, { asOfDay }).earned;
      assert.ok(a.planks - b.planks <= BACKFILL_CAP.planks + 1e-9, `case ${i}: backfill planks ${a.planks - b.planks}`);
      assert.ok(a.stone - b.stone <= BACKFILL_CAP.stone + 1e-9, `case ${i}: backfill stone ${a.stone - b.stone}`);
      assert.ok(a.seeds - b.seeds <= BACKFILL_CAP.seeds + 1e-9, `case ${i}: backfill seeds ${a.seeds - b.seeds}`);
      assert.ok(a.planks >= b.planks && a.stone >= b.stone && a.seeds >= b.seeds, `case ${i}: backfill took something away`);
    }
  }
  assert.ok(withBackfill > 50, `only ${withBackfill} generated cases had a backfill`);
});

test("a small history earns what its days earn, under the cap", () => {
  const l = ledgerWithBackfill(2, { claude: { ...big, turns: 3, working_seconds: 1800, sessions: 1 } });
  const a = grow(l.seed, l, EMPTY_CHOICES).earned;
  const b = grow(l.seed, withoutBackfill(l), EMPTY_CHOICES).earned;
  assert.ok(a.planks - b.planks > 0 && a.planks - b.planks < BACKFILL_CAP.planks);
  assert.ok(a.stone - b.stone > 0 && a.stone - b.stone < BACKFILL_CAP.stone);
});

test("the Founders' Stone is engraved with the history's counts and stands from the founding day", () => {
  const l = ledgerWithBackfill(5, { claude: { ...big, turns: 10, sessions: 2, working_seconds: 7200 }, codex: { ...big, turns: 4, sessions: 1, working_seconds: 1800 } });
  const w = grow(l.seed, l, EMPTY_CHOICES);
  assert.deepEqual(w.founders_stone, { days: 5, turns: 70, sessions: 15, working_hours: 12.5 });
  const s = w.structures.find((x) => x.id === "founders_stone");
  assert.ok(s !== undefined && s.status === "complete" && s.completed_day === l.founded_day);
});

test("history does not count toward live stats or milestones", () => {
  const l = ledgerWithBackfill(31, { claude: big });
  const w = grow(l.seed, l, EMPTY_CHOICES);
  assert.equal(w.stats.lifetime_turns, 0);
  assert.equal(w.stats.active_days, 0);
  assert.deepEqual(w.milestones, []);
});

test("no backfill, or a backfill with no days, means no Founders' Stone", () => {
  const l = ledgerWithBackfill(0, {});
  for (const ledger of [l, withoutBackfill(l)]) {
    const w = grow(ledger.seed, ledger, EMPTY_CHOICES);
    assert.equal(w.founders_stone, null);
    assert.ok(!w.structures.some((s) => s.id === "founders_stone"));
  }
});
