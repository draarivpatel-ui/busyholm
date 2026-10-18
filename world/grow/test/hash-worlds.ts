// Prints the determinism digest for N random cases: SHA-256 over the newline-joined per-world SHA-256
// hashes of canonical JSON. Run by test/cross-node.ts under every Node binary found, and mirrored in
// the browser by test/webview/. Usage: node test/hash-worlds.ts [master] [count]
import { createHash } from "node:crypto";
import { grow } from "../src/grow.ts";
import { canonicalJson } from "../src/canonical.ts";
import { DETERMINISM_COUNT, DETERMINISM_MASTER, determinismInput } from "./cases.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function hashWorlds(master: number, count: number): { digest: string; hashes: string[] } {
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) {
    const c = determinismInput(master, i);
    hashes.push(sha(canonicalJson(grow(c.seed, c.ledger, c.choices, c.options))));
  }
  return { digest: sha(hashes.join("\n")), hashes };
}

if (process.argv[1] !== undefined && /hash-worlds\.ts$/.test(process.argv[1])) {
  const master = process.argv[2] === undefined ? DETERMINISM_MASTER : Number(process.argv[2]);
  const count = process.argv[3] === undefined ? DETERMINISM_COUNT : Number(process.argv[3]);
  const { digest, hashes } = hashWorlds(master, count);
  console.log(JSON.stringify({ node: process.version, master, count, digest, first: hashes[0], last: hashes[hashes.length - 1] }));
}
