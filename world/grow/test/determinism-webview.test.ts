// WP-08 acceptance test 1, webview half: grow() gives byte-identical worlds in Chrome and in Node.
// Runs the harness (test/webview/run.ts) in a child process and asserts it exits 0. Skips where
// Google Chrome or playwright-core is not available (the harness exits 2 with the reason; for
// example CI on Linux). Set PLAYWRIGHT_PATH if playwright-core is not installed in the repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, "webview", "run.ts");

test("grow() is byte-identical in Chrome and Node over 1,000 random ledgers", { timeout: 180_000 }, (t) => {
  const r = spawnSync(process.execPath, [RUN], { cwd: join(HERE, ".."), encoding: "utf8", timeout: 170_000, maxBuffer: 16 * 1024 * 1024 });
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.status === 2) return t.skip(out.trim());
  assert.equal(r.status, 0, `webview harness exited ${r.status} (signal ${r.signal})\n${out}`);
  assert.match(r.stdout, /^PASS:/m, out);
});
