// WP-08 acceptance test 5: the Steam demo cap (SPEC 7.3: the founding plus three progression structures
// and six decorations) stops building while counts continue, and the full edition catches up at once
// from the same ledger ("your village has been saving planks for you").
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Choices } from "@busyholm/contracts";
import { grow } from "../src/grow.ts";
import { DECORATIONS, DEMO_CAP } from "../src/config.ts";
import { PROFILES, profileLedger } from "../sim/profiles.ts";
import { builtCount, simulateLedger, EMPTY_CHOICES } from "../sim/simulate.ts";
import { deepFreeze } from "./helpers.ts";

const ledger = deepFreeze(profileLedger(PROFILES.typical!, 30));

test("demo edition: never more than three progression structures, at any day", () => {
  const run = simulateLedger(ledger, EMPTY_CHOICES, 30, "demo");
  for (const d of run) {
    assert.ok(builtCount(d.world) <= DEMO_CAP.progressionStructures, `day ${d.n}: ${builtCount(d.world)} built`);
    assert.ok(!d.world.structures.some((s) => s.status === "building" && builtCount(d.world) >= DEMO_CAP.progressionStructures),
      `day ${d.n}: a fourth structure started`);
  }
  const last = run[run.length - 1]!.world;
  assert.equal(builtCount(last), DEMO_CAP.progressionStructures);
  assert.equal(last.demo_capped, true);
});

test("demo edition: counts keep accruing past the cap", () => {
  const run = simulateLedger(ledger, EMPTY_CHOICES, 30, "demo");
  const capDay = run.find((d) => d.world.demo_capped)!;
  const last = run[run.length - 1]!.world;
  assert.ok(last.earned.planks > capDay.world.earned.planks, "planks keep being earned");
  assert.ok(last.earned.stone > capDay.world.earned.stone, "stone keeps being earned");
  assert.ok(last.resources.planks > capDay.world.resources.planks, "the stockpile grows");
  assert.equal(last.stats.lifetime_turns, grow(ledger.seed, ledger, EMPTY_CHOICES).stats.lifetime_turns);
});

test("the full edition on the same ledger catches up at once", () => {
  const demo = grow(ledger.seed, ledger, EMPTY_CHOICES, { edition: "demo" });
  const full = grow(ledger.seed, ledger, EMPTY_CHOICES, { edition: "full" });
  assert.equal(full.demo_capped, false);
  assert.ok(builtCount(full) > builtCount(demo));
  assert.deepEqual(full.earned, demo.earned, "the same ledger earns the same in both editions");
  assert.deepEqual(full, grow(ledger.seed, ledger, EMPTY_CHOICES), "full is the default edition");
});

test("demo edition: at most six decorations, even when more are chosen and affordable", () => {
  let t = 1_760_300_000_000;
  const log: Choices["log"] = [];
  for (const d of DECORATIONS) log.push({ t: t++, day: "2026-11-10", kind: "decoration", decoration: d.id, on: true });
  const choices: Choices = { schema_version: 1, privacy: { containsText: false }, log };
  const demo = grow(ledger.seed, ledger, choices, { edition: "demo" });
  const full = grow(ledger.seed, ledger, choices, { edition: "full" });
  assert.equal(demo.decorations.length, DEMO_CAP.decorations);
  assert.ok(full.decorations.length > DEMO_CAP.decorations);
});

test("grow() never mutates its inputs, the demo sandbox ledger included", () => {
  // deepFreeze above makes any mutation of the ledger throw inside grow().
  assert.doesNotThrow(() => grow(ledger.seed, ledger, EMPTY_CHOICES, { edition: "demo" }));
});
