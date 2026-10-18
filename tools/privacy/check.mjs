#!/usr/bin/env node
// privacy:check (SPEC 5.7 rule 10). Usage: npm run privacy:check -- <dir> [<dir> ...]
// Exit 0: no canary anywhere under the given folders. Exit 1: at least one canary
// found (each hit is listed with file, byte offset, needle and encoding, never the
// surrounding content). Exit 2: usage error, for example a folder that does not exist
// (a typo must never pass as "clean").
//
// Scans every regular file at any depth, without following symlinks: the relative
// path (file and folder names) and the full contents. Contents are searched for
// every needle in fixtures/privacy/canaries.json as UTF-8 (case-insensitive),
// UTF-16LE, UTF-16BE, hex and base64 (3 alignments, standard and URL-safe).
// Not detected: compressed data (for example zTXt chunks inside a PNG, gzip),
// encryption, and encodings other than those listed.
import { lstatSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CANARIES, searchPatterns, textHits } from "./canary.mjs";
import { isMain } from "../is-main.mjs";

/** Lists regular files under dir, depth first, never following symlinks. */
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}

/** Scans one folder. Returns { files, hits: [{ file, where, offset, needle, encoding }] }. */
export function scan(dir) {
  const patterns = searchPatterns();
  const lowerNeedles = CANARIES.needles.map((n) => ({ name: n.name, value: n.value.toLowerCase() }));
  const hits = [];
  let files = 0;
  for (const file of walk(dir)) {
    files++;
    const rel = relative(dir, file);
    for (const needle of textHits(rel)) hits.push({ file: rel, where: "name", offset: -1, needle, encoding: "path" });
    const buf = readFileSync(file);
    const seenAt = new Set();
    // Case-insensitive ASCII/UTF-8 pass over the whole file.
    const lower = buf.toString("latin1").toLowerCase();
    for (const n of lowerNeedles) {
      let at = lower.indexOf(n.value);
      while (at !== -1) {
        seenAt.add(at);
        hits.push({ file: rel, where: "content", offset: at, needle: n.name, encoding: "utf8" });
        at = lower.indexOf(n.value, at + 1);
      }
    }
    // Encoded forms.
    for (const p of patterns) {
      if (p.encoding === "utf8") continue;
      let at = buf.indexOf(p.bytes);
      while (at !== -1) {
        if (!seenAt.has(at)) hits.push({ file: rel, where: "content", offset: at, needle: p.needle, encoding: p.encoding });
        at = buf.indexOf(p.bytes, at + 1);
      }
    }
  }
  return { files, hits };
}

function main(argv) {
  const dirs = argv.filter((a) => a !== "--");
  if (dirs.length === 0) {
    console.error("usage: npm run privacy:check -- <dir> [<dir> ...]");
    return 2;
  }
  let total = 0;
  for (const d of dirs) {
    const dir = resolve(d);
    if (!existsSync(dir) || !lstatSync(dir).isDirectory()) {
      console.error(`privacy:check: not a folder: ${d}`);
      return 2;
    }
    const { files, hits } = scan(dir);
    total += hits.length;
    if (hits.length === 0) {
      console.log(`privacy:check: clean, ${files} file(s) scanned in ${d}`);
    } else {
      console.error(`privacy:check: LEAK, ${hits.length} canary hit(s) in ${d} (${files} file(s) scanned)`);
      for (const h of hits.slice(0, 50)) {
        const at = h.where === "name" ? "file name" : `byte ${h.offset}`;
        console.error(`  ${h.file}: ${at}: ${h.needle} (${h.encoding})`);
      }
      if (hits.length > 50) console.error(`  ... and ${hits.length - 50} more`);
    }
  }
  return total === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
