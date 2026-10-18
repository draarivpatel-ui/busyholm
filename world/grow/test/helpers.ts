// Shared test helpers (Node only).
import { createHash } from "node:crypto";
import { validate } from "@busyholm/contracts";
import type { World } from "@busyholm/contracts";
import { canonicalJson } from "../src/canonical.ts";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function worldHash(world: World): string {
  return sha256(canonicalJson(world));
}

/** Throws with the first schema issue if the world is not a valid World v1. */
export function assertWorldValid(world: unknown, label: string): void {
  const r = validate("world", world);
  if (!r.ok) throw new Error(`${label}: invalid World v1: ${JSON.stringify(r.issues.slice(0, 3))}`);
}

/** Deep-freezes a value so a test fails if grow() mutates its inputs. */
export function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** The world without the cosmetic first_answer milestone (a ribbon on the bell; it needs a prompt to exist). */
export function withoutFirstAnswer(world: World): unknown {
  const w = clone(world) as World;
  w.milestones = w.milestones.filter((m) => m.id !== "first_answer");
  return w;
}
