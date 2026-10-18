// Helpers for the contract fixture modules in tools/fixtures/contracts/.
// Everything is deterministic: no randomness, no clock, no environment.
import { createHash } from "node:crypto";

/** 2026-10-12T12:00:00Z in ms: the reference "now" of every fixture. */
export const T0 = 1791806400000;
export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY_MS = 24 * HOUR;

/** Smallest and largest legal ms timestamps (see contracts/CHANGES.md). */
export const MS_MIN = 946684800000;
export const MS_MAX = 4102444800000;

/** A deterministic 32-lowercase-hex id (the shape of a salted instance hash). */
export function hid(label) {
  return createHash("sha256").update(`busyholm-fixture-id:${label}`).digest("hex").slice(0, 32);
}

/** A deterministic 64-lowercase-hex sha256 value. */
export function sha(label) {
  return createHash("sha256").update(`busyholm-fixture-sha:${label}`).digest("hex");
}

/** Local day string offset from 2026-10-12 by n days. */
export function day(n = 0) {
  const d = new Date(Date.UTC(2026, 9, 12 + n));
  return d.toISOString().slice(0, 10);
}

export const clone = (x) => structuredClone(x);

/** Marker value: delete the property at this path. */
export const DELETE = Symbol("delete");

function walk(obj, path) {
  const parts = Array.isArray(path) ? path : String(path).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] === undefined || cur[p] === null || typeof cur[p] !== "object") {
      throw new Error(`fixture path "${parts.join(".")}" does not exist at "${p}"`);
    }
    cur = cur[p];
  }
  return [cur, parts[parts.length - 1]];
}

/**
 * Returns a deep copy of base with edits applied. edits maps a dotted path
 * ("agents.0.state") to a new value, or to DELETE to remove the property.
 * Array indexes are written as numbers in the path.
 */
export function edit(base, edits) {
  const out = clone(base);
  for (const [path, value] of Object.entries(edits)) {
    const [parent, key] = walk(out, path);
    if (value === DELETE) {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else {
      parent[key] = clone(value);
    }
  }
  return out;
}

/**
 * Builds a fixture record. name: short kebab-case, unique within its list.
 * note: one sentence saying what it covers (valid) or which rule it breaks (invalid).
 * path (invalid only): JSON Pointer of the value that breaks the rule ("" for the root);
 * the TypeScript test checks that some validation error points at or below it.
 */
export function fx(name, note, data, path) {
  const rec = { name, note, data };
  if (path !== undefined) rec.path = path;
  return rec;
}
