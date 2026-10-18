// WP-01 acceptance test 2: privacy:check fails a deliberately leaky stub output
// and passes a clean one and an empty one. Also proves the scanner finds every
// supported encoding, and that the agent-side input fixtures really carry a
// canary in every content field listed in SPEC 5.7 (and research section 8.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { CANARIES } from "../canary.mjs";
import { validate } from "../../../contracts/ts/src/validate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const CHECK = join(root, "tools", "privacy", "check.mjs");
const STUB = join(root, "tools", "privacy", "stub-adapter.mjs");
const INPUTS = join(root, "fixtures", "agent-inputs");
const MARK = `${CANARIES.marker_prefix}_test_field_1`;
const RAW_ID = `${CANARIES.id_prefix}00000000002a`;

function scratch(name) {
  return mkdtempSync(join(tmpdir(), `bh-privacy-${name}-`));
}

function check(...dirs) {
  const r = spawnSync(process.execPath, [CHECK, ...dirs], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function dirWith(name, files) {
  const dir = scratch(name);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

function b64At(text, shift) {
  return Buffer.concat([Buffer.from("xyz".slice(0, shift)), Buffer.from(text)]).toString("base64");
}

test("an empty output folder passes", () => {
  const dir = scratch("empty");
  assert.equal(check(dir).status, 0);
});

test("a clean output folder passes", () => {
  const dir = dirWith("clean", {
    "events.jsonl": '{"v":1,"agent":"claude","kind":"turn_end"}\n',
    "notes/readme.txt": "Claude needs you: permission\n",
    "image.bin": Buffer.from([0, 1, 2, 3, 250, 251, 252]),
  });
  assert.equal(check(dir).status, 0);
});

test("a missing folder is a usage error, never a pass", () => {
  assert.equal(check(join(tmpdir(), "bh-privacy-does-not-exist-7f3a")).status, 2);
  assert.equal(check().status, 2);
});

const encodings = {
  "raw marker": MARK,
  "marker inside JSON": JSON.stringify({ msg: `ok ${MARK} ok` }),
  "lowercase marker": MARK.toLowerCase(),
  "mixed-case marker": "bhCanary_x",
  "UTF-16LE marker": Buffer.from(MARK, "utf16le"),
  "UTF-16BE marker": Buffer.from(Buffer.from(MARK, "utf16le").swap16()),
  "hex marker": Buffer.from(MARK).toString("hex"),
  "uppercase hex marker": Buffer.from(MARK).toString("hex").toUpperCase(),
  "base64 marker, shift 0": b64At(MARK, 0),
  "base64 marker, shift 1": b64At(MARK, 1),
  "base64 marker, shift 2": b64At(MARK, 2),
  "base64url marker": b64At(`??>${MARK}`, 0).replace(/\+/g, "-").replace(/\//g, "_"),
  "raw id": `{"session_id":"${RAW_ID}"}`,
  "raw id without dashes": RAW_ID.replace(/-/g, ""),
  "uppercase raw id": RAW_ID.toUpperCase(),
  "base64 raw id": b64At(RAW_ID, 1),
};

for (const [label, content] of Object.entries(encodings)) {
  test(`detects a ${label}`, () => {
    const dir = dirWith("leak", { "out/log.txt": Buffer.concat([Buffer.from("before "), Buffer.from(content), Buffer.from(" after")]) });
    const r = check(dir);
    assert.equal(r.status, 1, r.out);
    assert.ok(!r.out.includes(" after"), "the report must not echo surrounding content");
  });
}

test("detects a canary in a file or folder name", () => {
  const dir = dirWith("name", { [`exports/${MARK}/card.png`]: "x" });
  assert.equal(check(dir).status, 1);
});

test("checks every folder given and fails if any one leaks", () => {
  const clean = scratch("multi-clean");
  const leaky = dirWith("multi-leaky", { "a.txt": MARK });
  assert.equal(check(clean, leaky).status, 1);
});

test("agent-side input fixtures exist and every never-open file is full of canaries", () => {
  assert.ok(existsSync(join(INPUTS, "index.json")), "fixtures/agent-inputs/index.json is missing");
  const index = JSON.parse(readFileSync(join(INPUTS, "index.json"), "utf8"));
  const neverOpen = index.filter((e) => e.path.startsWith("never-open/"));
  assert.ok(neverOpen.length >= 6, "expected at least 6 never-open files");
  for (const e of neverOpen) assert.equal(check(dirWith("never", { f: readFileSync(join(INPUTS, e.path)) })).status, 1, e.path);
});

test("ACCEPTANCE: privacy:check fails the deliberately leaky stub's output", () => {
  const out = scratch("stub-leaky");
  const run = spawnSync(process.execPath, [STUB, "--mode", "leaky", INPUTS, out], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(readdirSync(out).length > 0, "the leaky stub wrote nothing");
  const r = check(out);
  assert.equal(r.status, 1, `expected a leak report, got:\n${r.out}`);
});

test("ACCEPTANCE: privacy:check passes the clean stub's output, which is valid AgentEvent v1", () => {
  const out = scratch("stub-clean");
  const run = spawnSync(process.execPath, [STUB, "--mode", "clean", INPUTS, out], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const r = check(out);
  assert.equal(r.status, 0, r.out);
  const lines = readFileSync(join(out, "events.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.ok(lines.length >= 50, `only ${lines.length} clean events`);
  for (const line of lines) {
    const res = validate("agentEvent", JSON.parse(line));
    assert.ok(res.ok, `invalid AgentEvent: ${line}`);
  }
  rmSync(out, { recursive: true, force: true });
});

test("the contract fixtures themselves are canary-free (they model outputs)", () => {
  const r = check(join(root, "fixtures", "contracts"));
  assert.equal(r.status, 0, r.out);
});

// Content fields from SPEC 5.7 rule 1, research section 8.4, account fields
// (5.7 rule 6) and raw ids (5.7 rule 4). Each must carry a canary somewhere in
// the agent-side input fixtures, so "a canary in every content field" is checked,
// not asserted.
const REQUIRED_KEYS = [
  "prompt", "last_assistant_message", "tool_input", "tool_response", "tool_output", "output", "text",
  "content", "message", "title", "session_title", "name", "summary", "task", "error_details",
  "permission_suggestions", "user_email", "input-messages", "last-assistant-message", "toolUseResult",
  "creator_user_id", "creator_account_id", "ownerAccountUuid", "ownerOrganizationUuid",
  "session_id", "sessionId", "transcript_path", "cwd", "agent_id", "thread-id",
  "prompt_response", "last_agent_message", "command", "file_path", "branch",
  "message.content",
];

function hasCanary(v) {
  if (typeof v === "string") {
    const s = v.toLowerCase();
    return CANARIES.needles.some((n) => s.includes(n.value.toLowerCase()));
  }
  if (Array.isArray(v)) return v.some(hasCanary);
  if (v && typeof v === "object") return Object.values(v).some(hasCanary);
  return false;
}

function collect(v, found, parent) {
  if (Array.isArray(v)) {
    for (const x of v) collect(x, found, parent);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (hasCanary(x)) {
        found.add(k);
        if (parent) found.add(`${parent}.${k}`);
      }
      collect(x, found, k);
    }
  }
}

test("every content, account and raw-id field carries a canary in the agent-side inputs", () => {
  const index = JSON.parse(readFileSync(join(INPUTS, "index.json"), "utf8"));
  const found = new Set();
  for (const e of index) {
    if (e.format !== "json" && e.format !== "jsonl") continue;
    const text = readFileSync(join(INPUTS, e.path), "utf8");
    const docs = e.format === "json" ? [text] : text.split("\n");
    for (const d of docs) {
      try {
        collect(JSON.parse(d), found, null);
      } catch {
        // partial or deliberately broken lines are allowed in JSONL fixtures
      }
    }
  }
  const missing = REQUIRED_KEYS.filter((k) => !found.has(k));
  assert.deepEqual(missing, [], `fields without a canary: ${missing.join(", ")}`);
});
