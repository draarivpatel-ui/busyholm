// WP-08 acceptance test 1, JavaScriptCore half: grow() gives byte-identical worlds in JavaScriptCore
// (the engine inside WKWebView, the macOS app's webview) and in Node.
// Runs the harness (test/jsc/run.ts) in a child process and asserts it exits 0. Skips where the jsc
// shell is not installed (Windows, Linux CI).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const JSC = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc";
const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, "jsc", "run.ts");

test("grow() is byte-identical in JavaScriptCore and Node over 1,000 random ledgers", { timeout: 300_000 }, (t) => {
  if (!existsSync(JSC)) return t.skip(`jsc not found at ${JSC} (this check needs macOS)`);
  const r = spawnSync(process.execPath, [RUN], { cwd: join(HERE, ".."), encoding: "utf8", timeout: 290_000, maxBuffer: 16 * 1024 * 1024 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, `jsc harness exited ${r.status} (signal ${r.signal})\n${out}`);
  assert.match(r.stdout, /^PASS:/m, out);
});
