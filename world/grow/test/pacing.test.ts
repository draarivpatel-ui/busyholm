// WP-08 acceptance test 2: the pacing simulation meets SPEC 4.5 for the calibrated profiles.
// Day n is the n-th calendar day counting the founding day as day 1.
// Revision 1 item 6: a user who never sees a permission prompt ("no-prompts") builds at the same pace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROFILES } from "../sim/profiles.ts";
import { builtCount, firstDayAtTier, simulate } from "../sim/simulate.ts";
import type { SimDay } from "../sim/simulate.ts";

const DAYS = 60;
const run = (name: string): SimDay[] => simulate(PROFILES[name]!, DAYS);
const light = run("light");
const typical = run("typical");
const noPrompts = run("no-prompts");
const heavy = run("heavy");

const at = (r: SimDay[], n: number) => r[n - 1]!.world;

test("day 1: light and typical each have at least 3 structures built", () => {
  assert.ok(builtCount(at(light, 1)) >= 3, `light day 1 built ${builtCount(at(light, 1))}`);
  assert.ok(builtCount(at(typical, 1)) >= 3, `typical day 1 built ${builtCount(at(typical, 1))}`);
});

test("typical: at least one structure is still unbuilt on day 14", () => {
  assert.ok(builtCount(at(typical, 14)) < 12, `typical day 14 built ${builtCount(at(typical, 14))}`);
});

test("typical: reaches the village between day 18 and day 28", () => {
  const v = firstDayAtTier(typical, "village");
  assert.ok(v !== null && v >= 18 && v <= 28, `typical village on day ${v}`);
});

test("heavy: faster than typical, but at most 2.2 times as fast", () => {
  const tv = firstDayAtTier(typical, "village");
  const hv = firstDayAtTier(heavy, "village");
  assert.ok(tv !== null && hv !== null, `village days typical ${tv} heavy ${hv}`);
  assert.ok(hv < tv, `heavy ${hv} should beat typical ${tv}`);
  assert.ok(tv / hv <= 2.2, `typical ${tv} / heavy ${hv} = ${(tv / hv).toFixed(2)} > 2.2`);
});

test("heavy earns at most 2.2 times typical over every prefix of the first 28 days", () => {
  for (let n = 1; n <= 28; n++) {
    const h = at(heavy, n).earned;
    const t = at(typical, n).earned;
    const hv = h.planks + h.stone;
    const tv = t.planks + t.stone;
    assert.ok(hv <= 2.2 * tv, `day ${n}: heavy planks+stone ${hv} > 2.2 x typical ${tv}`);
  }
});

test("no-prompts: same build days as typical and reaches the village in the same window", () => {
  const v = firstDayAtTier(noPrompts, "village");
  assert.ok(v !== null && v >= 18 && v <= 28, `no-prompts village on day ${v}`);
  for (let n = 1; n <= DAYS; n++) {
    const a = at(noPrompts, n).structures.map((s) => `${s.id}:${s.status}:${s.completed_day ?? ""}`);
    const b = at(typical, n).structures.map((s) => `${s.id}:${s.status}:${s.completed_day ?? ""}`);
    assert.deepEqual(a, b, `day ${n} structures differ`);
    assert.deepEqual(at(noPrompts, n).earned, at(typical, n).earned, `day ${n} earned differs`);
  }
});

test("light: reaches the hamlet within four weeks and sees a new build stage every week until the village", () => {
  const h = firstDayAtTier(light, "hamlet");
  assert.ok(h !== null && h <= 28, `light hamlet on day ${h}`);
  const visible = (n: number) => at(light, n).structures.reduce((sum, s) => sum + s.stage, 0);
  for (let n = 7; n + 7 <= DAYS; n += 7) {
    if (at(light, n).tier === "village") break;
    assert.ok(visible(n + 7) > visible(n), `light: no new build stage between day ${n} and day ${n + 7}`);
  }
});
