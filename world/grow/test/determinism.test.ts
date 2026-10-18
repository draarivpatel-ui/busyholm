// WP-08 acceptance test 1 (in-process half): 1,000 random ledgers give identical worlds on every call,
// every world is a valid World v1, inputs are never mutated, and the corpus digest matches the golden
// digest recorded in test/golden/determinism.json. The same digest is checked under every Node binary
// on the machine (determinism-nodes.test.ts), in Google Chrome (determinism-webview.test.ts) and in
// JavaScriptCore, the engine behind macOS WKWebView (determinism-jsc.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { grow } from "../src/grow.ts";
import { canonicalJson } from "../src/canonical.ts";
import { DETERMINISM_COUNT, DETERMINISM_MASTER, determinismInput } from "./cases.ts";
import { hashWorlds } from "./hash-worlds.ts";
import { assertWorldValid, deepFreeze } from "./helpers.ts";

test("1,000 random ledgers: same world on every call, valid World v1, inputs untouched", () => {
  for (let i = 0; i < DETERMINISM_COUNT; i++) {
    const c = determinismInput(DETERMINISM_MASTER, i);
    const before = canonicalJson(c);
    deepFreeze(c);
    const a = grow(c.seed, c.ledger, c.choices, c.options);
    const b = grow(c.seed, c.ledger, c.choices, c.options);
    assert.equal(canonicalJson(a), canonicalJson(b), `case ${i}: two calls differ`);
    assert.equal(canonicalJson(c), before, `case ${i}: inputs changed`);
    assertWorldValid(a, `case ${i}`);
  }
});

test("the corpus digest equals the recorded golden digest", () => {
  const golden = JSON.parse(readFileSync(new URL("./golden/determinism.json", import.meta.url), "utf8")) as {
    master: number; count: number; digest: string;
  };
  assert.equal(golden.master, DETERMINISM_MASTER);
  assert.equal(golden.count, DETERMINISM_COUNT);
  assert.equal(hashWorlds(DETERMINISM_MASTER, DETERMINISM_COUNT).digest, golden.digest);
});

test("the seed argument drives the world seed and decoration slots, nothing else", () => {
  for (let i = 0; i < 100; i++) {
    const c = determinismInput(DETERMINISM_MASTER, i);
    const a = grow(1, c.ledger, c.choices, c.options);
    const b = grow(2, c.ledger, c.choices, c.options);
    assert.equal(a.seed, 1);
    assert.equal(b.seed, 2);
    const strip = (w: typeof a) => ({ ...w, seed: 0, decorations: w.decorations.map((d) => ({ ...d, slot: 0 })) });
    assert.deepEqual(strip(a), strip(b), `case ${i}`);
  }
});
