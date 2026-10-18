// The engine's runtime id lists and economy catalogue agree with the contracts, and the generated test
// inputs are themselves valid Ledger v1 and Choices v1 documents.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as contracts from "@busyholm/contracts";
import { validate } from "@busyholm/contracts";
import { MILESTONE_IDS, PROGRESSION_STRUCTURE_IDS, STRUCTURE_IDS, TOOLS } from "../src/ids.ts";
import { DECORATIONS, DECORATION_ZONES, STRUCTURES } from "../src/config.ts";
import { genCase } from "./gen.ts";
import { PROFILES, PROFILE_NAMES, profileLedger } from "../sim/profiles.ts";

test("runtime id lists equal the contract's", () => {
  assert.deepEqual(TOOLS, contracts.TOOLS);
  assert.deepEqual(STRUCTURE_IDS, contracts.STRUCTURE_IDS);
  assert.deepEqual(PROGRESSION_STRUCTURE_IDS, contracts.PROGRESSION_STRUCTURE_IDS);
  assert.deepEqual(MILESTONE_IDS, contracts.MILESTONE_IDS);
  assert.deepEqual(STRUCTURES.map((s) => s.id), [...contracts.PROGRESSION_STRUCTURE_IDS]);
});

test("decoration catalogue: 24 items, 1 to 6 seeds each, about 70 in total, valid ids, room in every zone", () => {
  assert.equal(DECORATIONS.length, 24);
  const ids = new Set(DECORATIONS.map((d) => d.id));
  assert.equal(ids.size, 24);
  let total = 0;
  for (const d of DECORATIONS) {
    assert.match(d.id, /^[a-z][a-z0-9_]{1,31}$/);
    assert.ok(Number.isInteger(d.seeds) && d.seeds >= 1 && d.seeds <= 6, d.id);
    total += d.seeds;
  }
  assert.ok(total >= 60 && total <= 80, `total ${total}`);
  for (const [zone, r] of Object.entries(DECORATION_ZONES)) {
    const n = DECORATIONS.filter((d) => d.zone === zone).length;
    assert.ok(n <= r.last - r.first + 1, `zone ${zone} has ${n} items for ${r.last - r.first + 1} slots`);
    assert.ok(r.first >= 0 && r.last <= 255);
  }
  assert.ok(DECORATIONS.some((d) => d.season === "autumn") && DECORATIONS.some((d) => d.season === "winter"));
});

test("generated ledgers and choices are valid contract documents", () => {
  for (let i = 0; i < 300; i++) {
    const c = genCase(0xc047, i);
    const l = validate("ledger", c.ledger);
    assert.ok(l.ok, `case ${i} ledger: ${l.ok ? "" : JSON.stringify(l.issues.slice(0, 2))}`);
    const ch = validate("choices", c.choices);
    assert.ok(ch.ok, `case ${i} choices: ${ch.ok ? "" : JSON.stringify(ch.issues.slice(0, 2))}`);
  }
  for (const name of PROFILE_NAMES) {
    const r = validate("ledger", profileLedger(PROFILES[name]!, 60, { jitterSeed: 3 }));
    assert.ok(r.ok, `profile ${name}: ${r.ok ? "" : JSON.stringify(r.issues.slice(0, 2))}`);
  }
});
