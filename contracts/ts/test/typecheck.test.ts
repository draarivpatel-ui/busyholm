// The TypeScript types must never be stricter than the schemas: every valid
// fixture, written as an object literal annotated with its contract type, must
// compile. This writes contracts/ts/.typecheck/ (gitignored) and runs tsc on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { CONTRACTS, type ContractKey } from "../src/types.ts";

const tsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(tsDir, "..", "..");
const outDir = join(tsDir, ".typecheck");

const TYPE_NAMES: Record<ContractKey, string> = {
  agentEvent: "AgentEvent",
  snapshot: "Snapshot",
  moment: "Moment",
  ledger: "Ledger",
  choices: "Choices",
  world: "World",
  hitRects: "HitRects",
  settings: "Settings",
  installManifest: "InstallManifest",
  pendingAlerts: "PendingAlerts",
};

test("every valid fixture type-checks against its TypeScript contract type", () => {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const names = Object.values(TYPE_NAMES).join(", ");
  let count = 0;
  for (const [key, file] of Object.entries(CONTRACTS) as [ContractKey, string][]) {
    const dir = join(root, "fixtures", "contracts", file.replace(".schema.json", ""), "valid");
    const lines = [`import type { ${names} } from "../src/types.ts";`, ""];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      const body = readFileSync(join(dir, f), "utf8").trim();
      lines.push(`// ${f}`, `export const v${count++}: ${TYPE_NAMES[key]} = ${body};`, "");
    }
    writeFileSync(join(outDir, `${key}.ts`), lines.join("\n"));
  }
  writeFileSync(
    join(outDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "es2022",
        module: "nodenext",
        moduleResolution: "nodenext",
        allowImportingTsExtensions: true,
        verbatimModuleSyntax: true,
        skipLibCheck: true,
        types: [],
      },
      include: ["*.ts"],
    }),
  );
  // Run the tsc bin script with this node, so it works the same on Windows.
  const require = createRequire(import.meta.url);
  const tscBin = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
  const run = spawnSync(process.execPath, [tscBin, "-p", outDir], { encoding: "utf8" });
  assert.ok(count >= 10 * 30, `only ${count} valid fixtures found`);
  assert.equal(run.status, 0, `tsc failed:\n${run.stdout}\n${run.stderr}`);
});
