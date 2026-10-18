// Browser-side half of the determinism check (WP-08 acceptance test 1, webview half).
// Loaded by the page that test/webview/run.ts serves; the browser's own ES module loader follows the
// relative ".ts" imports (run.ts strips the types on the way out). Mirrors test/hash-worlds.ts.
import { grow } from "../../src/grow.ts";
import { canonicalJson } from "../../src/canonical.ts";
import { determinismInput } from "../cases.ts";

export interface BrowserResult {
  readonly userAgent: string;
  readonly digest?: string;
  readonly hashes?: string[];
  readonly error?: { readonly index: number; readonly message: string };
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  let out = "";
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, "0");
  return out;
}

function worldJson(master: number, i: number): string {
  const c = determinismInput(master, i);
  return canonicalJson(grow(c.seed, c.ledger, c.choices, c.options));
}

export async function run(master: number, count: number): Promise<BrowserResult> {
  const userAgent = navigator.userAgent;
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) {
    try {
      hashes.push(await sha256Hex(worldJson(master, i)));
    } catch (e) {
      return { userAgent, error: { index: i, message: e instanceof Error ? e.message : String(e) } };
    }
  }
  return { userAgent, hashes, digest: await sha256Hex(hashes.join("\n")) };
}

/** Canonical JSON of case i, for the mismatch report. */
export function canonicalFor(master: number, i: number): string {
  return worldJson(master, i);
}
