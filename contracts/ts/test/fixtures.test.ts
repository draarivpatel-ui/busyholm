// WP-01 acceptance test 1 (TypeScript side): for every contract, every valid
// fixture is accepted and every invalid fixture is rejected, with at least one
// validation issue pointing at or below the path the fixture says it breaks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../src/validate.ts";
import type { ContractKey } from "../src/types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fixturesRoot = join(root, "fixtures", "contracts");
const MIN_EACH = 30;

interface Manifest {
  contract: ContractKey;
  schema: string;
  valid: Record<string, { note: string }>;
  invalid: Record<string, { note: string; path: string }>;
}

const dirs = readdirSync(fixturesRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

test("fixtures exist for all ten contracts", () => {
  assert.deepEqual(dirs, [
    "agent-event.v1",
    "choices.v1",
    "hit-rects.v1",
    "install-manifest.v1",
    "ledger.v1",
    "moment.v1",
    "pending-alerts.v1",
    "settings.v1",
    "snapshot.v2",
    "world.v1",
  ]);
});

for (const dir of dirs) {
  const manifest = JSON.parse(readFileSync(join(fixturesRoot, dir, "manifest.json"), "utf8")) as Manifest;

  for (const kind of ["valid", "invalid"] as const) {
    const files = readdirSync(join(fixturesRoot, dir, kind)).filter((f) => f.endsWith(".json")).sort();

    test(`${dir}: at least ${MIN_EACH} ${kind} fixtures, all listed in the manifest`, () => {
      assert.ok(files.length >= MIN_EACH, `${dir}/${kind} has only ${files.length}`);
      assert.deepEqual(files, Object.keys(manifest[kind]).sort());
    });

    test(`${dir}: every ${kind} fixture is ${kind === "valid" ? "accepted" : "rejected"}`, () => {
      const failures: string[] = [];
      for (const file of files) {
        const data: unknown = JSON.parse(readFileSync(join(fixturesRoot, dir, kind, file), "utf8"));
        const result = validate(manifest.contract, data);
        if (kind === "valid") {
          if (!result.ok) {
            const why = result.issues.slice(0, 3).map((i) => `${i.path || "/"} ${i.message}`).join("; ");
            failures.push(`${file} rejected: ${why}`);
          }
        } else if (result.ok) {
          failures.push(`${file} accepted, but it should break: ${manifest.invalid[file]?.note}`);
        } else {
          const expected = manifest.invalid[file]?.path ?? "";
          const hit = result.issues.some((i) => i.path === expected || i.path.startsWith(`${expected}/`));
          if (!hit) {
            const got = [...new Set(result.issues.map((i) => i.path || "/"))].join(", ");
            failures.push(`${file} rejected, but not at "${expected || "/"}" (issues at ${got})`);
          }
        }
      }
      assert.deepEqual(failures, [], failures.join("\n"));
    });
  }
}
