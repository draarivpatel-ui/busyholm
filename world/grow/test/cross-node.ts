// Cross-Node determinism check for WP-08. Runs test/hash-worlds.ts under each Node binary found on this
// machine and checks that every binary prints the same digest.
// Usage (from world/grow): node test/cross-node.ts [master] [count]
// Binaries: the colon-separated absolute paths in BUSYHOLM_NODES if set, else only the Node running this
// script (which always gives a SKIP, since two versions are needed). Example:
//   BUSYHOLM_NODES=/path/to/node-a/bin/node:/path/to/node-b/bin/node node test/cross-node.ts
// Exit codes: 0 PASS, 1 FAIL, 3 SKIP (fewer than two distinct Node versions available).
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GROW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "test/hash-worlds.ts";
const STRIP_FLAG = "--experimental-strip-types";
const TIMEOUT_MS = 300_000;
const EXCERPT_CHARS = 1000;
const ELECTRON_MARKER = "Visual Studio Code.app";

type Env = Record<string, string | undefined>;

interface Candidate {
  readonly path: string;
  readonly electron: boolean;
}

interface Result {
  readonly path: string;
  version: string;
  digest?: string;
  ms: number;
  error?: string;
  stderr: string;
}

function childEnv(c: Candidate): Env {
  const env: Env = { ...process.env };
  if (c.electron) env.ELECTRON_RUN_AS_NODE = "1";
  else delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function candidates(): Candidate[] {
  const raw = process.env.BUSYHOLM_NODES;
  const listed = raw !== undefined && raw.trim() !== "" ? raw.split(":") : [process.execPath];
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const entry of listed) {
    const p = entry.trim();
    if (p === "" || seen.has(p)) continue;
    seen.add(p);
    if (!path.isAbsolute(p)) {
      console.log(`ignored (not an absolute path): ${p}`);
      continue;
    }
    if (!existsSync(p)) continue;
    out.push({ path: p, electron: p.includes(ELECTRON_MARKER) });
  }
  return out;
}

// The line Node prints for the thrown error (e.g. "Error: ..."), else the first non-empty line.
function errorLine(s: string): string {
  const lines = s.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return lines.find((l) => /^[A-Za-z]*Error: /.test(l)) ?? lines[0] ?? "";
}

// Asks the binary for its version without running the engine. "unknown" if it cannot answer.
function probeVersion(c: Candidate): string {
  const r = spawnSync(c.path, ["-p", "process.version"], {
    cwd: GROW_DIR,
    encoding: "utf8",
    timeout: 60_000,
    env: childEnv(c),
  });
  const last = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  return r.status === 0 && /^v\d+\.\d+\.\d+$/.test(last) ? last : "unknown";
}

function runScript(c: Candidate, flags: string[], args: string[]): SpawnSyncReturns<string> {
  return spawnSync(c.path, [...flags, "--no-warnings", SCRIPT, ...args], {
    cwd: GROW_DIR,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    env: childEnv(c),
    maxBuffer: 64 * 1024 * 1024,
  });
}

// True only when the binary refused the flag itself (not when the script failed while mentioning it).
function rejectsStripFlag(r: SpawnSyncReturns<string>): boolean {
  const err = r.stderr ?? "";
  return r.status !== 0 && err.includes(STRIP_FLAG) && /(bad|unknown|not allowed) option/i.test(err);
}

function runOne(c: Candidate, args: string[], probed: string): Result {
  const start = Date.now();
  let r = runScript(c, [STRIP_FLAG], args);
  if (rejectsStripFlag(r)) r = runScript(c, [], args);
  const ms = Date.now() - start;
  const stderr = r.stderr ?? "";
  const base = { path: c.path, version: probed, ms, stderr };

  if (r.error) return { ...base, error: r.error.message };
  if (r.signal) return { ...base, error: `killed by ${r.signal}` };
  if (r.status !== 0) return { ...base, error: `exit ${r.status}: ${errorLine(stderr)}` };

  const line = (r.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (line === undefined) return { ...base, error: "no JSON line on stdout" };

  let parsed: { node?: unknown; digest?: unknown };
  try {
    parsed = JSON.parse(line) as { node?: unknown; digest?: unknown };
  } catch {
    return { ...base, error: "last JSON line did not parse" };
  }
  if (typeof parsed.digest !== "string" || !/^[0-9a-f]{64}$/.test(parsed.digest)) {
    return { ...base, error: "JSON line has no sha256 digest" };
  }
  const version = typeof parsed.node === "string" ? parsed.node : probed;
  return { path: c.path, version, digest: parsed.digest, ms, stderr };
}

function printTable(results: Result[]): void {
  const rows = [
    ["binary", "node", "digest", "ms", "result"],
    ...results.map((r) => [
      r.path,
      r.version,
      r.digest !== undefined ? r.digest.slice(0, 16) : "-",
      String(r.ms),
      r.error !== undefined ? `ERROR ${r.error.slice(0, 120)}` : "ok",
    ]),
  ];
  const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((row) => (row[i] ?? "").length)));
  for (const row of rows) {
    console.log(row.map((cell, i) => (i < 4 ? cell.padEnd(widths[i] ?? 0) : cell)).join("  "));
  }
}

function printExcerpt(r: Result): void {
  const text = r.stderr.trim();
  console.log(`--- stderr ${r.path} (first ${Math.min(text.length, EXCERPT_CHARS)} of ${text.length} chars) ---`);
  console.log(text === "" ? "(empty)" : text.slice(0, EXCERPT_CHARS));
}

function main(): number {
  const args = process.argv.slice(2);
  const cands = candidates();
  console.log(`cross-node check in ${GROW_DIR}: ${cands.length} binar${cands.length === 1 ? "y" : "ies"} found`);

  const probed = new Map(cands.map((c) => [c.path, probeVersion(c)]));
  const versions = new Set([...probed.values()].filter((v) => v !== "unknown"));
  if (versions.size < 2) {
    console.log(`SKIP: fewer than two distinct Node versions available (found ${versions.size})`);
    if (!process.env.BUSYHOLM_NODES?.trim()) {
      console.log("hint: set BUSYHOLM_NODES to the colon-separated absolute paths of two or more Node binaries");
    }
    return 3;
  }

  const results = cands.map((c) => runOne(c, args, probed.get(c.path) ?? "unknown"));
  printTable(results);

  const ok = results.filter((r) => r.digest !== undefined);
  const failed = results.filter((r) => r.error !== undefined);
  const okVersions = new Set(ok.map((r) => r.version));
  const groups = new Map<string, string[]>();
  for (const r of ok) {
    const digest = r.digest ?? "";
    groups.set(digest, [...(groups.get(digest) ?? []), `${r.path} (${r.version})`]);
  }

  const problems: string[] = [];
  if (failed.length > 0) problems.push(`${failed.length} binar${failed.length === 1 ? "y" : "ies"} errored`);
  if (okVersions.size < 2) problems.push(`only ${okVersions.size} distinct Node version(s) produced a digest, need 2`);
  if (groups.size > 1) problems.push(`digests differ across binaries`);

  if (problems.length === 0) {
    const [digest] = [...groups.keys()];
    console.log(`PASS: ${ok.length} binaries on ${okVersions.size} Node versions agree, sha256 ${digest}`);
    return 0;
  }

  console.log(`FAIL: ${problems.join("; ")}`);
  for (const [digest, who] of groups) console.log(`  digest ${digest}: ${who.join(", ")}`);
  for (const r of failed) console.log(`  error ${r.path} (${r.version}): ${r.error}`);
  for (const r of failed) printExcerpt(r);
  if (groups.size > 1) for (const r of ok) if (r.stderr.trim() !== "") printExcerpt(r);
  return 1;
}

try {
  process.exitCode = main();
} catch (err) {
  console.log(`FAIL: runner error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
