// WP-06 acceptance test 1: in a simulated OpenCode run the plugin posts only allowlisted
// fields. Run with: node --test collector-wp06/plugin/test/
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const mod = await import("../busyholm.js");

const ALLOWED_KEYS = new Set(["v", "agent", "type", "sid", "psid", "rid", "activity", "error", "tok", "et"]);
const TYPES = new Set([
  "session.created", "session.deleted", "session.busy", "session.idle", "session.error",
  "permission.asked", "permission.replied", "question.asked", "question.replied", "tool.after", "tokens",
]);
const ACTIVITIES = new Set(["shell", "edit", "read", "web", "delegate", "other"]);
const ERRORS = new Set(["aborted", "auth", "server_error", "max_output_tokens", "network", "unknown"]);
const HEX64 = /^[0-9a-f]{64}$/;
const sha = (s) => createHash("sha256").update(s).digest("hex");

const SID = "bca1a700-0000-4000-8000-00000000007f";
const PSID = "bca1a700-0000-4000-8000-00000000007f";

function fixture(rel) {
  return JSON.parse(readFileSync(join(repo, "fixtures", rel), "utf8"));
}
function allFixtures(dir) {
  return readdirSync(join(repo, "fixtures", dir)).filter((f) => f.endsWith(".json")).sort()
    .map((f) => [f, fixture(`${dir}/${f}`)]);
}

function recorder({ withRuntime = true, hang = false, fail = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bh-plugin-"));
  const runtimeFile = join(dir, "runtime.json");
  if (withRuntime) {
    writeFileSync(runtimeFile, JSON.stringify({ v: 1, port: 48123, secret: "s3cretpath_0123456789", token: "t0ken_value_0123456789" }), { mode: 0o600 });
  }
  const posts = [];
  const transport = (url, init) => {
    posts.push({ url, headers: init.headers, body: JSON.parse(init.body), raw: init.body });
    if (hang) return new Promise(() => {});
    if (fail) return Promise.reject(new Error("connect ECONNREFUSED BHCANARY_should_not_print"));
    return Promise.resolve({ ok: true, status: 204 });
  };
  return { posts, options: { runtimeFile, transport } };
}
const tick = () => new Promise((r) => setImmediate(r));
async function start(options) {
  return mod.default.server({ directory: "/Users/someone/code/BHCANARY_plugin_dir", worktree: "/x", project: { id: "bca1a700-0000-4000-8000-000000000081" } }, options);
}

test("the module has exactly one export, a default object with id and server() (OpenCode loader rule)", () => {
  assert.deepEqual(Object.keys(mod), ["default"]);
  assert.equal(typeof mod.default, "object");
  assert.equal(typeof mod.default.id, "string");
  assert.equal(typeof mod.default.server, "function");
});

test("every posted body has only allowlisted keys with closed, well-typed values", async () => {
  const { posts, options } = recorder();
  const hooks = await start(options);
  for (const dir of ["agent-inputs/opencode/plugin", "wp06/opencode/plugin-v2"]) {
    for (const [name, ev] of allFixtures(dir)) {
      if (ev.input && ev.type?.startsWith("tool.execute")) {
        await hooks[ev.type]?.(ev.input, ev.output);
      } else {
        await hooks.event?.({ event: ev });
      }
    }
  }
  await tick();
  assert.ok(posts.length >= 8, `expected several posts, got ${posts.length}`);
  for (const p of posts) {
    for (const [k, v] of Object.entries(p.body)) {
      assert.ok(ALLOWED_KEYS.has(k), `key ${k} is not allowlisted`);
      if (["sid", "psid", "rid"].includes(k)) assert.match(v, HEX64);
    }
    assert.equal(p.body.v, 1);
    assert.equal(p.body.agent, "opencode");
    assert.ok(TYPES.has(p.body.type), p.body.type);
    if ("activity" in p.body) assert.ok(ACTIVITIES.has(p.body.activity));
    if ("error" in p.body) assert.ok(ERRORS.has(p.body.error));
    if ("tok" in p.body) assert.ok(Number.isInteger(p.body.tok) && p.body.tok >= 0 && p.body.tok <= 1e9);
    if ("et" in p.body) assert.ok(Number.isInteger(p.body.et) && p.body.et > 946684800000);
    assert.ok(p.raw.length < 600, "bodies stay tiny");
  }
});

test("no canary: text markers never reach the wire, and raw session ids never reach the wire either (digests only)", async () => {
  const { posts, options } = recorder();
  const hooks = await start(options);
  for (const dir of ["agent-inputs/opencode/plugin", "wp06/opencode/plugin-v2"]) {
    for (const [, ev] of allFixtures(dir)) {
      if (ev.input && ev.type?.startsWith("tool.execute")) await hooks[ev.type]?.(ev.input, ev.output);
      else await hooks.event?.({ event: ev });
    }
  }
  await tick();
  const wire = JSON.stringify(posts.map((p) => ({ url: p.url.replace(/s3cretpath_0123456789/, "SECRET"), h: Object.keys(p.headers), b: p.raw })));
  assert.doesNotMatch(wire, /BHCANARY/i);
  assert.doesNotMatch(wire, /bca1a700/i);
  assert.doesNotMatch(wire, /bca1a700000040008000/i);
});

test("session lifecycle maps to the closed event names with hashed ids", async () => {
  const { posts, options } = recorder();
  const hooks = await start(options);
  const send = (name) => hooks.event({ event: fixture(name) });
  await send("agent-inputs/opencode/plugin/session-created.json");
  await send("agent-inputs/opencode/plugin/session-created-subagent.json");
  await send("agent-inputs/opencode/plugin/session-status-busy.json");
  await send("agent-inputs/opencode/plugin/session-idle.json");
  await send("wp06/opencode/plugin-v2/session-deleted.json");
  await tick();
  assert.deepEqual(posts.map((p) => p.body.type), ["session.created", "session.created", "session.busy", "session.idle", "session.deleted"]);
  assert.equal(posts[0].body.sid, sha(SID));
  assert.equal(posts[0].body.psid, undefined);
  assert.equal(posts[1].body.sid, sha("bca1a700-0000-4000-8000-000000000080"));
  assert.equal(posts[1].body.psid, sha(PSID));
  assert.ok(posts.every((p) => Number.isInteger(p.body.et)));
});

test("noise is dropped: retry status, part updates, file edits, session.updated, tool.execute.before", async () => {
  const { posts, options } = recorder();
  const hooks = await start(options);
  await hooks.event({ event: fixture("wp06/opencode/plugin-v2/session-status-retry.json") });
  await hooks.event({ event: fixture("agent-inputs/opencode/plugin/message-part-updated.json") });
  await hooks.event({ event: fixture("agent-inputs/opencode/plugin/file-edited.json") });
  await hooks.event({ event: fixture("agent-inputs/opencode/plugin/session-updated.json") });
  const before = fixture("agent-inputs/opencode/plugin/tool-execute-before.json");
  await hooks["tool.execute.before"]?.(before.input, before.output);
  await tick();
  assert.equal(posts.length, 0);
});

test("permission and question events, both payload shapes, are deduplicated by request id", async () => {
  const { posts, options } = recorder();
  const hooks = await start(options);
  await hooks.event({ event: fixture("agent-inputs/opencode/plugin/permission-asked.json") });   // v1 shape
  await hooks.event({ event: fixture("agent-inputs/opencode/plugin/permission-asked.json") });   // duplicate delivery
  await hooks.event({ event: fixture("wp06/opencode/plugin-v2/permission-asked-v2.json") });     // v2 shape, other id
  await hooks.event({ event: fixture("agent-inputs/opencode/plugin/permission-replied.json") }); // v1 reply
  await hooks.event({ event: fixture("wp06/opencode/plugin-v2/permission-replied-v2.json") });   // v2 reply
  await hooks.event({ event: fixture("wp06/opencode/plugin-v2/question-asked.json") });
  await hooks.event({ event: fixture("wp06/opencode/plugin-v2/question-replied.json") });
  await tick();
  assert.deepEqual(posts.map((p) => p.body.type), [
    "permission.asked", "permission.asked", "permission.replied", "permission.replied", "question.asked", "question.replied",
  ]);
  assert.equal(posts[0].body.rid, sha("bca1a700-0000-4000-8000-000000000086"));
  assert.equal(posts[1].body.rid, sha("bca1a700-0000-4000-8000-0000000000a1"));
  assert.equal(posts[0].body.sid, sha(SID));
});

test("errors are reduced to a closed class; the message text is never read", async () => {
  const { posts, options } = recorder();
  const hooks = await start(options);
  await hooks.event({ event: fixture("agent-inputs/opencode/plugin/session-error.json") });
  await hooks.event({ event: fixture("wp06/opencode/plugin-v2/session-error-aborted.json") });
  await hooks.event({ event: fixture("wp06/opencode/plugin-v2/session-error-auth.json") });
  await tick();
  assert.deepEqual(posts.map((p) => [p.body.type, p.body.error]), [
    ["session.error", "unknown"], ["session.error", "aborted"], ["session.error", "auth"],
  ]);
});

test("tool.execute.after posts the activity class from the tool NAME, never the name, args or output", async () => {
  const { posts, options } = recorder();
  const hooks = await start(options);
  const after = fixture("agent-inputs/opencode/plugin/tool-execute-after.json");
  await hooks["tool.execute.after"](after.input, after.output);
  const names = { bash: "shell", edit: "edit", write: "edit", patch: "edit", read: "read", grep: "read", glob: "read", list: "read", webfetch: "web", websearch: "web", task: "delegate", "BHCANARY_mcp_tool_name": "other" };
  for (const [tool, want] of Object.entries(names)) {
    await hooks["tool.execute.after"]({ ...after.input, tool }, after.output);
  }
  await tick();
  assert.equal(posts[0].body.type, "tool.after");
  assert.equal(posts[0].body.activity, "shell");
  assert.deepEqual(posts.slice(1).map((p) => p.body.activity), Object.values(names));
  assert.doesNotMatch(JSON.stringify(posts.map((p) => p.body)), /BHCANARY/i);
});

test("token deltas: first sight counts the message total, repeats add nothing, growth posts the difference", async () => {
  const { posts, options } = recorder();
  const hooks = await start(options);
  const ev = fixture("wp06/opencode/plugin-v2/message-updated-assistant.json");
  await hooks.event({ event: ev });
  await hooks.event({ event: ev });
  const bigger = structuredClone(ev);
  bigger.properties.info.tokens.output = 700; // +500
  await hooks.event({ event: bigger });
  const user = structuredClone(ev); user.properties.info.role = "user";
  await hooks.event({ event: user });
  await tick();
  assert.deepEqual(posts.map((p) => [p.body.type, p.body.tok]), [["tokens", 1590], ["tokens", 500]]);
});

test("transport: loopback URL with the path secret, token and agent headers, no Origin", async () => {
  const { posts, options } = recorder();
  const hooks = await start(options);
  await hooks.event({ event: fixture("agent-inputs/opencode/plugin/session-idle.json") });
  await tick();
  const p = posts[0];
  assert.equal(p.url, "http://127.0.0.1:48123/e/s3cretpath_0123456789");
  const h = Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(h["x-busyholm-token"], "t0ken_value_0123456789");
  assert.equal(h["x-busyholm-agent"], "opencode");
  assert.equal(h["content-type"], "application/json");
  assert.equal(h["origin"], undefined);
});

test("receiver absent, hung, failing, or runtime file missing or corrupt: silent, fast, never throws", async () => {
  const captured = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  for (const k of Object.keys(orig)) console[k] = (...a) => captured.push(a.join(" "));
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const cases = [recorder({ withRuntime: false }), recorder({ hang: true }), recorder({ fail: true })];
    const corrupt = recorder(); writeFileSync(corrupt.options.runtimeFile, "{not json BHCANARY_corrupt"); cases.push(corrupt);
    const badPort = recorder(); writeFileSync(badPort.options.runtimeFile, JSON.stringify({ port: 22, secret: "../../etc/passwd", token: "x" })); cases.push(badPort);
    for (const c of cases) {
      const hooks = await start(c.options);
      const t0 = Date.now();
      await hooks.event({ event: fixture("agent-inputs/opencode/plugin/permission-asked.json") });
      await hooks["tool.execute.after"]({ tool: "bash", sessionID: SID, callID: "c" }, {});
      assert.ok(Date.now() - t0 < 200, "hooks return immediately");
    }
    await tick(); await tick();
    assert.equal(cases[1].posts.length > 0, true, "the hung receiver was still attempted");
    assert.equal(cases[0].posts.length, 0);
    assert.equal(cases[3].posts.length, 0);
    assert.equal(cases[4].posts.length, 0, "an unsafe runtime file is refused");
  } finally {
    Object.assign(console, orig);
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(captured, []);
  assert.deepEqual(unhandled, []);
});

test("a malformed event never throws", async () => {
  const { posts, options } = recorder();
  const hooks = await start(options);
  for (const bad of [undefined, null, 5, "x", {}, { event: null }, { event: { type: "session.idle" } }, { event: { type: "session.idle", properties: { sessionID: 42 } } }, { event: { type: "session.created", properties: { info: [] } } }]) {
    await hooks.event(bad);
  }
  await hooks["tool.execute.after"](undefined, undefined);
  await hooks["tool.execute.after"]({ tool: 5, sessionID: null }, null);
  await tick();
  assert.equal(posts.length, 0);
});

test("a subagent session keeps its parent link on every later event; session.updated is learned from, never posted", async () => {
  const { posts, options } = recorder();
  const hooks = await start(options);
  await hooks.event({ event: fixture("agent-inputs/opencode/plugin/session-created-subagent.json") });
  const CHILD = "bca1a700-0000-4000-8000-000000000080";
  await hooks.event({ event: { type: "session.status", properties: { sessionID: CHILD, status: { type: "busy" } } } });
  await hooks["tool.execute.after"]({ tool: "task", sessionID: CHILD, callID: "c" }, {});
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: CHILD } } });
  // a child first seen through session.updated
  const LATE = "bca1a700-0000-4000-8000-0000000000d1";
  await hooks.event({ event: { type: "session.updated", properties: { info: { id: LATE, parentID: SID } } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: LATE } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: SID } } });
  await tick();
  assert.deepEqual(posts.map((p) => p.body.type), ["session.created", "session.busy", "tool.after", "session.idle", "session.idle", "session.idle"]);
  for (const p of posts.slice(0, 4)) assert.equal(p.body.psid, sha(PSID));
  assert.equal(posts[4].body.psid, sha(SID));
  assert.equal(posts[5].body.psid, undefined);
});
