// Authoring aid: checks one contract's fixture module in memory, without writing files.
// Usage: node tools/fixtures/verify.mjs <contract folder, e.g. snapshot.v2>
// Prints every valid fixture that is rejected, every invalid fixture that is accepted,
// and every invalid fixture rejected at a different path than it claims.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_DIRS } from "./generate.mjs";
import { validate } from "../../contracts/ts/src/validate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2];
const key = Object.keys(CONTRACT_DIRS).find((k) => CONTRACT_DIRS[k] === dir);
if (!key) {
  console.error(`usage: node tools/fixtures/verify.mjs <one of ${Object.values(CONTRACT_DIRS).join(", ")}>`);
  process.exit(2);
}
const mod = await import(join(here, "contracts", `${dir}.mjs`));
const valid = mod.valid();
const invalid = mod.invalid();
let bad = 0;
for (const f of valid) {
  const r = validate(key, f.data);
  if (!r.ok) {
    bad++;
    console.log(`VALID REJECTED  ${f.name}: ${r.issues.slice(0, 4).map((i) => `${i.path || "/"} ${i.keyword} ${i.message}`).join(" | ")}`);
  }
}
for (const f of invalid) {
  const r = validate(key, f.data);
  if (r.ok) {
    bad++;
    console.log(`INVALID ACCEPTED ${f.name}: ${f.note}`);
  } else if (!r.issues.some((i) => i.path === f.path || i.path.startsWith(`${f.path}/`))) {
    bad++;
    console.log(`WRONG PATH      ${f.name}: claims "${f.path}", issues at ${[...new Set(r.issues.map((i) => i.path || "/"))].join(", ")}`);
  }
}
console.log(`${dir}: ${valid.length} valid, ${invalid.length} invalid, ${bad} problem(s)`);
process.exit(bad === 0 && valid.length >= 30 && invalid.length >= 30 ? 0 : 1);
