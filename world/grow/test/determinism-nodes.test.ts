// Runs the cross-Node determinism check (test/cross-node.ts) in a child process. Exit 0 passes, exit 3
// skips (fewer than two Node versions on this machine), anything else fails with the child's output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const growDir = path.resolve(here, "..");

test("every Node binary on this machine produces the same determinism digest", (t) => {
  const r = spawnSync(process.execPath, [path.join(here, "cross-node.ts")], {
    cwd: growDir,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `stdout:\n${r.stdout ?? ""}\nstderr:\n${r.stderr ?? ""}`;

  if (r.error) assert.fail(`cross-node.ts could not run: ${r.error.message}\n${output}`);
  if (r.status === 3) {
    t.skip("fewer than two Node versions on this machine");
    return;
  }
  assert.equal(r.status, 0, `cross-node.ts exited with ${r.status ?? r.signal}\n${output}`);
});
