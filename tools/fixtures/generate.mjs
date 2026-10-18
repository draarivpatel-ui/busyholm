// Regenerates fixtures/contracts/<contract>/ from the modules in tools/fixtures/contracts/
// and fixtures/agent-inputs/ from tools/fixtures/agent-inputs.mjs.
// Usage: node tools/fixtures/generate.mjs
// The output is committed; tests read it and never regenerate it.
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../is-main.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const outRoot = join(root, "fixtures", "contracts");

/** Contract key -> fixture folder (matches the schema file name without .schema.json). */
export const CONTRACT_DIRS = {
  agentEvent: "agent-event.v1",
  snapshot: "snapshot.v2",
  moment: "moment.v1",
  ledger: "ledger.v1",
  choices: "choices.v1",
  world: "world.v1",
  hitRects: "hit-rects.v1",
  settings: "settings.v1",
  installManifest: "install-manifest.v1",
  pendingAlerts: "pending-alerts.v1",
};

const MIN_EACH = 30;
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function pad(n) {
  return String(n).padStart(3, "0");
}

function check(dir, kind, list) {
  if (!Array.isArray(list) || list.length < MIN_EACH) {
    throw new Error(`${dir}: ${kind} has ${list?.length ?? 0} fixtures, need at least ${MIN_EACH}`);
  }
  const names = new Set();
  const bodies = new Map();
  for (const f of list) {
    if (!NAME.test(f.name)) throw new Error(`${dir}/${kind}: bad fixture name "${f.name}"`);
    if (names.has(f.name)) throw new Error(`${dir}/${kind}: duplicate fixture name "${f.name}"`);
    names.add(f.name);
    if (typeof f.note !== "string" || f.note.length < 8) throw new Error(`${dir}/${kind}/${f.name}: missing note`);
    if (/[–—]/.test(f.note)) throw new Error(`${dir}/${kind}/${f.name}: note contains an en or em dash`);
    if (kind === "invalid" && typeof f.path !== "string") throw new Error(`${dir}/invalid/${f.name}: missing path`);
    const body = JSON.stringify(f.data);
    if (body === undefined) throw new Error(`${dir}/${kind}/${f.name}: data is not JSON-serialisable`);
    if (bodies.has(body)) throw new Error(`${dir}/${kind}/${f.name}: identical to ${bodies.get(body)}`);
    bodies.set(body, f.name);
  }
}

async function main() {
  const onlyAt = process.argv.indexOf("--only");
  const only = onlyAt === -1 ? null : process.argv[onlyAt + 1];
  if (only !== null && !Object.values(CONTRACT_DIRS).includes(only)) throw new Error(`--only: unknown contract folder "${only}"`);
  const manifest = {};
  for (const [key, dir] of Object.entries(CONTRACT_DIRS)) {
    if (only !== null && dir !== only) continue;
    const modPath = join(here, "contracts", `${dir}.mjs`);
    if (!existsSync(modPath)) throw new Error(`missing fixture module ${modPath}`);
    const mod = await import(modPath);
    const valid = mod.valid();
    const invalid = mod.invalid();
    check(dir, "valid", valid);
    check(dir, "invalid", invalid);
    const validBodies = new Set(valid.map((f) => JSON.stringify(f.data)));
    for (const f of invalid) {
      if (validBodies.has(JSON.stringify(f.data))) throw new Error(`${dir}: invalid/${f.name} is identical to a valid fixture`);
    }
    const target = join(outRoot, dir);
    rmSync(target, { recursive: true, force: true });
    const entries = { contract: key, schema: `contracts/schemas/${dir}.schema.json`, valid: {}, invalid: {} };
    for (const [kind, list] of [["valid", valid], ["invalid", invalid]]) {
      mkdirSync(join(target, kind), { recursive: true });
      list.forEach((f, i) => {
        const file = `${pad(i + 1)}-${f.name}.json`;
        writeFileSync(join(target, kind, file), JSON.stringify(f.data, null, 2) + "\n");
        entries[kind][file] = kind === "invalid" ? { note: f.note, path: f.path } : { note: f.note };
      });
    }
    writeFileSync(join(target, "manifest.json"), JSON.stringify(entries, null, 2) + "\n");
    manifest[dir] = { valid: valid.length, invalid: invalid.length };
  }
  for (const [dir, n] of Object.entries(manifest)) console.log(`${dir}: ${n.valid} valid, ${n.invalid} invalid`);
  if (only !== null) return;
  writeFileSync(join(outRoot, "index.json"), JSON.stringify(manifest, null, 2) + "\n");

  const inputsPath = join(here, "agent-inputs.mjs");
  if (existsSync(inputsPath)) {
    const { writeAgentInputs } = await import(inputsPath);
    const count = writeAgentInputs(join(root, "fixtures", "agent-inputs"));
    console.log(`agent-inputs: ${count} files`);
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
