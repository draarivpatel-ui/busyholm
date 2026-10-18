// FIX-C (review r1 M7, M8, M9): bounded asynchronous runtime refresh, explicit HTTP status
// handling with a bounded recovery policy, and no redirects off loopback.
// Run with: node --test collector-wp06/plugin/test/
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const mod = await import("../busyholm.js");
const fixture = (rel) => JSON.parse(readFileSync(join(repo, "fixtures", rel), "utf8"));
const PERMISSION = () => fixture("agent-inputs/opencode/plugin/permission-asked.json");
const IDLE = () => fixture("agent-inputs/opencode/plugin/session-idle.json");

const runtimeJson = (port, secret = "s3cretpath_0123456789") =>
  JSON.stringify({ v: 1, port, secret, token: "t0ken_value_0123456789" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}
const start = (options) => mod.default.server({ directory: "/x", worktree: "/x", project: { id: "p" } }, options);

function setup(port = 48123) {
  const dir = mkdtempSync(join(tmpdir(), "bh-rt-"));
  const runtimeFile = join(dir, "runtime.json");
  writeFileSync(runtimeFile, runtimeJson(port), { mode: 0o600 });
  return { dir, runtimeFile };
}

test("M7: a runtime path that never yields data (a FIFO) cannot block the plugin or its host", () => {
  const dir = mkdtempSync(join(tmpdir(), "bh-fifo-"));
  const fifo = join(dir, "runtime.json");
  const made = spawnSync("mkfifo", [fifo]);
  if (made.status !== 0) return; // no mkfifo here (Windows)
  const script = `
    const m = await import(${JSON.stringify(join(here, "..", "busyholm.js"))});
    const hooks = await m.default.server({}, { runtimeFile: ${JSON.stringify(fifo)}, transport: () => Promise.resolve({ ok: true, status: 204 }) });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "abc12345-0000-4000-8000-000000000001" } } });
    console.log("returned");
    process.exit(0);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 4000, encoding: "utf8" });
  assert.equal(r.error, undefined, "the plugin hung on a FIFO runtime file: " + String(r.error));
  assert.match(r.stdout, /returned/);
});

test("M7: an oversized runtime file is refused instead of read whole", async () => {
  const { runtimeFile } = setup();
  writeFileSync(runtimeFile, runtimeJson(48123) + " ".repeat(2 * 1024 * 1024));
  const posts = [];
  const hooks = await start({ runtimeFile, transport: (u, i) => { posts.push(u); return Promise.resolve({ ok: true, status: 204 }); } });
  await hooks.event({ event: IDLE() });
  await sleep(100);
  assert.equal(posts.length, 0);
});

test("M7: the hooks do not read the runtime file themselves (events after the initial load use cached primitives)", async () => {
  const { runtimeFile } = setup();
  const posts = [];
  const hooks = await start({ runtimeFile, transport: (u) => { posts.push(u); return Promise.resolve({ ok: true, status: 204 }); } });
  writeFileSync(runtimeFile, "{not json");
  await hooks.event({ event: IDLE() });
  assert.equal(posts.length, 1, "posted at once from the cached runtime, with no file read in the hook");
});

test("M9: every POST refuses redirects so event data cannot leave loopback", async () => {
  const { runtimeFile } = setup();
  const inits = [];
  const hooks = await start({ runtimeFile, transport: (u, i) => { inits.push(i); return Promise.resolve({ ok: true, status: 204 }); } });
  await hooks.event({ event: IDLE() });
  assert.equal(inits[0].redirect, "error");
});

test("M8: a rejected (404) response drops the cached runtime, so a restarted app is found at once", async () => {
  const { runtimeFile } = setup(48123);
  const urls = [];
  const hooks = await start({ runtimeFile, transport: (u) => { urls.push(u); return Promise.resolve(urls.length === 1 ? { ok: false, status: 404 } : { ok: true, status: 204 }); } });
  await hooks.event({ event: IDLE() });
  await sleep(20);
  writeFileSync(runtimeFile, runtimeJson(49000, "newsecret_0123456789"));
  await hooks.event({ event: IDLE() });
  assert.ok(await waitFor(() => urls.some((u) => u.includes(":49000/e/newsecret_0123456789"))), "second event reached the new receiver: " + urls.join(" "));
});

test("M8: a transient server error (503) keeps the runtime and does not pause later events", async () => {
  const { runtimeFile } = setup(48123);
  const urls = [];
  const hooks = await start({ runtimeFile, transport: (u) => { urls.push(u); return Promise.resolve(urls.length === 1 ? { ok: false, status: 503 } : { ok: true, status: 204 }); } });
  await hooks.event({ event: IDLE() });
  await sleep(20);
  await hooks.event({ event: IDLE() });
  assert.ok(await waitFor(() => urls.length >= 2));
  assert.ok(urls.every((u) => u === "http://127.0.0.1:48123/e/s3cretpath_0123456789"));
});

test("M8: after a network failure an urgent alert is not lost; the plugin recovers within a second, not five", async () => {
  const { runtimeFile } = setup(48123);
  const bodies = [];
  let calls = 0;
  const hooks = await start({
    runtimeFile,
    transport: (u, i) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("connect ECONNREFUSED"));
      bodies.push(JSON.parse(i.body));
      return Promise.resolve({ ok: true, status: 204 });
    },
  });
  await hooks.event({ event: PERMISSION() });
  assert.ok(await waitFor(() => bodies.some((b) => b.type === "permission.asked"), 1500), "the permission alert was delivered after the failure");
});

test("M8: a failure shortly after a refresh does not black out the next events for seconds", async () => {
  const { runtimeFile } = setup(48123);
  const seen = [];
  let calls = 0;
  const hooks = await start({
    runtimeFile,
    transport: (u, i) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("ECONNRESET"));
      seen.push(JSON.parse(i.body).type);
      return Promise.resolve({ ok: true, status: 204 });
    },
  });
  await hooks.event({ event: IDLE() });
  await sleep(20);
  await hooks["tool.execute.after"]({ tool: "bash", sessionID: "abc12345-0000-4000-8000-000000000001", callID: "c" }, {});
  assert.ok(await waitFor(() => seen.includes("tool.after"), 1500), "the event after the failure was posted within 1.5 s: " + seen.join(","));
});

test("M8: with the receiver gone for good, refresh attempts are bounded (backoff), not a busy loop", async () => {
  const { runtimeFile } = setup(48123);
  let calls = 0;
  const hooks = await start({ runtimeFile, transport: () => { calls += 1; return Promise.reject(new Error("ECONNREFUSED")); } });
  for (let i = 0; i < 50; i++) await hooks.event({ event: IDLE() });
  await sleep(700);
  assert.ok(calls < 40, "attempts stay bounded, got " + calls);
});
