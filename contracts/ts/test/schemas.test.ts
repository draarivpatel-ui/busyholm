// Consistency checks across the nine schemas, the TypeScript const arrays and
// the WP-01 docs. These guard against drift when one copy changes and another
// does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as T from "../src/types.ts";
import { SCHEMAS, validate } from "../src/validate.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const schemaDir = join(root, "contracts", "schemas");

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const files = readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json")).sort();
const schemas: Record<string, { [k: string]: Json }> = Object.fromEntries(
  files.map((f) => [f.replace(".schema.json", ""), JSON.parse(readFileSync(join(schemaDir, f), "utf8"))]),
);

function at(doc: Json, pointer: string): Json {
  let cur: Json = doc;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object") throw new Error(`no ${pointer}`);
    cur = Array.isArray(cur) ? cur[Number(key)] : cur[key];
    if (cur === undefined) throw new Error(`no ${pointer}`);
  }
  return cur;
}

function withoutDescriptions(x: Json): Json {
  if (Array.isArray(x)) return x.map(withoutDescriptions);
  if (x !== null && typeof x === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(x)) if (k !== "description") out[k] = withoutDescriptions(v);
    return out;
  }
  return x;
}

test("there are exactly ten schemas and each is wired into the validator", () => {
  assert.deepEqual(Object.keys(schemas), [
    "agent-event.v1", "choices.v1", "hit-rects.v1", "install-manifest.v1", "ledger.v1",
    "moment.v1", "pending-alerts.v1", "settings.v1", "snapshot.v2", "world.v1",
  ]);
  assert.deepEqual(Object.keys(T.CONTRACTS).sort(), Object.keys(SCHEMAS).sort());
  for (const [key, file] of Object.entries(T.CONTRACTS)) {
    assert.deepEqual(SCHEMAS[key as T.ContractKey], schemas[file.replace(".schema.json", "")], `${key} -> ${file}`);
  }
});

test("every schema is draft 2020-12, closed at the root, and compiles in strict mode", () => {
  for (const [name, s] of Object.entries(schemas)) {
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema", name);
    assert.equal(s.$id, `https://busyholm.invalid/contracts/${name}.schema.json`, name);
    assert.equal(typeof s.title, "string", name);
    assert.equal(s.additionalProperties, false, name);
  }
  for (const key of Object.keys(SCHEMAS) as T.ContractKey[]) {
    assert.doesNotThrow(() => validate(key, null), key);
  }
});

test("shared definitions are identical wherever they are copied", () => {
  const byName = new Map<string, { file: string; def: Json }[]>();
  for (const [file, s] of Object.entries(schemas)) {
    const defs = (s.$defs ?? {}) as { [k: string]: Json };
    for (const [name, def] of Object.entries(defs)) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name)!.push({ file, def: withoutDescriptions(def) });
    }
  }
  const shared = ["ms", "day", "tool", "host", "instance", "confidence", "provider", "window", "pct", "activity", "reason"];
  for (const name of shared) {
    const copies = byName.get(name) ?? [];
    assert.ok(copies.length >= 2, `$defs/${name} should be shared`);
    for (const c of copies) assert.deepEqual(c.def, copies[0]!.def, `$defs/${name} in ${c.file} differs from ${copies[0]!.file}`);
  }
  // Same meaning under different names.
  const pairs: [string, string, string, string][] = [
    ["moment.v1", "/$defs/structure/enum", "world.v1", "/$defs/structureId/enum"],
    ["moment.v1", "/$defs/milestone/enum", "world.v1", "/$defs/milestoneReached/properties/id/enum"],
    ["ledger.v1", "/$defs/seed", "world.v1", "/properties/seed"],
    ["agent-event.v1", "/$defs/tool/enum", "world.v1", "/$defs/structure/properties/variant/enum"],
  ];
  for (const [fa, pa, fb, pb] of pairs) {
    const a = withoutDescriptions(at(schemas[fa]!, pa));
    const b = withoutDescriptions(at(schemas[fb]!, pb));
    if (pa.endsWith("tool/enum")) {
      for (const tool of a as string[]) assert.ok((b as string[]).includes(tool), `${fb}${pb} lacks ${tool}`);
    } else {
      assert.deepEqual(a, b, `${fa}${pa} vs ${fb}${pb}`);
    }
  }
  const progression = at(schemas["choices.v1"]!, "/$defs/progressionStructure/enum") as string[];
  const all = at(schemas["moment.v1"]!, "/$defs/structure/enum") as string[];
  for (const s of progression) assert.ok(all.includes(s), `progression structure ${s} is not a structure id`);
});

test("TypeScript const arrays equal the schema enums, in order", () => {
  const table: [keyof typeof T, string, string][] = [
    ["TOOLS", "agent-event.v1", "/$defs/tool/enum"],
    ["HOSTS", "agent-event.v1", "/$defs/host/enum"],
    ["PROVIDERS", "agent-event.v1", "/$defs/provider/enum"],
    ["WINDOWS", "agent-event.v1", "/$defs/window/enum"],
    ["LIMIT_WINDOWS", "agent-event.v1", "/$defs/limit/properties/window/enum"],
    ["ACTIVITIES", "agent-event.v1", "/$defs/activity/enum"],
    ["AGENT_EVENT_KINDS", "agent-event.v1", "/properties/kind/enum"],
    ["EVENT_SOURCES", "agent-event.v1", "/properties/source/enum"],
    ["CONFIDENCES", "agent-event.v1", "/$defs/confidence/enum"],
    ["ERROR_CLASSES", "agent-event.v1", "/$defs/detail/properties/error_class/enum"],
    ["NOTIFICATION_TYPES", "agent-event.v1", "/$defs/detail/properties/notification/enum"],
    ["STOP_REASONS", "agent-event.v1", "/$defs/detail/properties/stop_reason/enum"],
    ["END_REASONS", "agent-event.v1", "/$defs/detail/properties/end_reason/enum"],
    ["AGENT_STATES", "snapshot.v2", "/$defs/agent/properties/state/enum"],
    ["NEEDS_YOU_REASONS", "snapshot.v2", "/$defs/reason/enum"],
    ["PRESENCES", "snapshot.v2", "/$defs/toolStatus/properties/presence/enum"],
    ["HOOK_STATES", "snapshot.v2", "/$defs/toolStatus/properties/hooks/enum"],
    ["COVERAGE_STATES", "snapshot.v2", "/$defs/toolStatus/properties/coverage/enum"],
    ["COVERAGE_REASONS", "snapshot.v2", "/$defs/coverageReason/enum"],
    ["MOMENT_KINDS", "moment.v1", "/properties/kind/enum"],
    ["STRUCTURE_IDS", "moment.v1", "/$defs/structure/enum"],
    ["MILESTONE_IDS", "moment.v1", "/$defs/milestone/enum"],
    ["PROGRESSION_STRUCTURE_IDS", "choices.v1", "/$defs/progressionStructure/enum"],
    ["CHOICE_KINDS", "choices.v1", "/$defs/entry/properties/kind/enum"],
    ["STRUCTURE_STATUSES", "world.v1", "/$defs/structure/properties/status/enum"],
    ["STRUCTURE_VARIANTS", "world.v1", "/$defs/structure/properties/variant/enum"],
    ["TIERS", "world.v1", "/properties/tier/enum"],
    ["SPECIES", "settings.v1", "/$defs/species/enum"],
    ["LAYER_MODES", "settings.v1", "/properties/strip/properties/layer_mode/enum"],
    ["SKY_MODES", "settings.v1", "/properties/sky/properties/mode/enum"],
    ["HEMISPHERES", "settings.v1", "/properties/sky/properties/hemisphere/enum"],
    ["REDUCED_MOTION_MODES", "settings.v1", "/properties/other/properties/reduced_motion/enum"],
    ["RECT_KINDS", "hit-rects.v1", "/$defs/rect/properties/kind/enum"],
    ["SURFACES", "hit-rects.v1", "/properties/surface/enum"],
    ["INSTALL_TOOLS", "install-manifest.v1", "/$defs/entry/properties/tool/anyOf/0/enum"],
    ["INSTALL_TARGETS", "install-manifest.v1", "/$defs/entry/properties/target/enum"],
    ["INSTALL_ACTIONS", "install-manifest.v1", "/$defs/entry/properties/action/enum"],
    ["INSTALL_STATES", "install-manifest.v1", "/$defs/entry/properties/state/enum"],
  ];
  for (const [name, file, pointer] of table) {
    assert.deepEqual([...(T[name] as readonly string[])], at(schemas[file]!, pointer), `${name} vs ${file}${pointer}`);
  }
  const exported = Object.entries(T).filter(([k, v]) => Array.isArray(v) && /^[A-Z_]+$/.test(k)).map(([k]) => k).sort();
  assert.deepEqual(exported, table.map(([n]) => n as string).sort(), "every exported const array is checked against a schema");
});

test("WP-01 docs, schema descriptions and fixture notes contain no en or em dashes", () => {
  const docs = [
    "README.md",
    "contracts/CHANGES.md",
    "fixtures/README.md",
    ...files.map((f) => `contracts/schemas/${f}`),
  ];
  const fixtureRoot = join(root, "fixtures", "contracts");
  if (existsSync(fixtureRoot)) {
    for (const d of readdirSync(fixtureRoot, { withFileTypes: true })) {
      if (d.isDirectory()) docs.push(`fixtures/contracts/${d.name}/manifest.json`);
    }
  }
  const offenders: string[] = [];
  for (const rel of docs) {
    const p = join(root, rel);
    if (!existsSync(p)) {
      offenders.push(`${rel} is missing`);
      continue;
    }
    readFileSync(p, "utf8").split("\n").forEach((line, i) => {
      if (/[–—]/.test(line)) offenders.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});
