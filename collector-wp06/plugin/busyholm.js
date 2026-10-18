// Busyholm plugin for OpenCode (WP-06). One file, no dependencies, nothing else in
// ~/.config/opencode is edited. It tells the local Busyholm app WHEN things happen in
// OpenCode, never WHAT: only the allowlisted fields below ever leave this process.
//
//   type      one of a fixed set of names (session.created, session.busy, session.idle, ...)
//   sid/psid  SHA-256 hex of the session id / parent session id (the raw id stays here);
//             psid is present on every event of a subagent session whose parent was seen
//   rid       SHA-256 hex of a permission or question request id
//   activity  class derived from the tool NAME only: shell | edit | read | web | delegate | other
//   error     class derived from the error NAME only: aborted | auth | server_error | ...
//   tok       a token count (integer)
//   et        this machine's clock in ms
//
// Prompts, replies, tool arguments and output, file paths, titles, commands, error
// messages and the project directory are never read into the posted object.
//
// Failure is silent by design: no receiver, no runtime file, a hung or failing POST all
// end quietly, and the hooks return at once so OpenCode is never slowed or interrupted.
//
// OpenCode's loader accepts either named function exports or ONE default export shaped
// { id, server }. This file has only the default export, because any other export that is
// not a function makes the legacy loader throw.

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// The installer may replace this line with the absolute runtime file path.
const RUNTIME_FILE_OVERRIDE = null; // BUSYHOLM-INSTALL: runtime file path

const MAX_IN_FLIGHT = 16;
const MAX_URGENT_IN_FLIGHT = 32;
const REQUEST_TIMEOUT_MS = 1000;
// Runtime file handling (review r1 M7, M8): a bounded asynchronous read, refreshed in the background.
const MAX_RUNTIME_BYTES = 4096;
const RUNTIME_READ_TIMEOUT_MS = 1000;
const RUNTIME_TTL_MS = 60000;
const MIN_RETRY_MS = 250;
const MAX_RETRY_MS = 5000;
const PENDING_CAP = 16;
const PENDING_MAX_AGE_MS = 30000;
// Volume events are not worth a retry; everything else (alerts above all) is retried once.
const NO_RETRY = new Set(["tool.after", "tokens"]);
const SEEN_CAP = 256;

const ACTIVITY = new Map([
  ["bash", "shell"], ["shell", "shell"],
  ["edit", "edit"], ["write", "edit"], ["patch", "edit"], ["apply_patch", "edit"], ["multiedit", "edit"],
  ["read", "read"], ["grep", "read"], ["glob", "read"], ["list", "read"], ["ls", "read"],
  ["webfetch", "web"], ["websearch", "web"], ["codesearch", "web"],
  ["task", "delegate"],
]);

const ERROR_CLASS = new Map([
  ["MessageAbortedError", "aborted"],
  ["ProviderAuthError", "auth"],
  ["MessageOutputLengthError", "max_output_tokens"],
  ["APIError", "server_error"],
]);

const URGENT = new Set(["permission.asked", "question.asked"]);

const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const isObj = (v) => v !== null && typeof v === "object";
const str = (v) => (typeof v === "string" && v.length > 0 && v.length <= 512 ? v : null);
const count = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 1e9) : 0);

function defaultRuntimeFile() {
  if (typeof RUNTIME_FILE_OVERRIDE === "string") return RUNTIME_FILE_OVERRIDE;
  if (process.env.BUSYHOLM_RUNTIME_FILE) return process.env.BUSYHOLM_RUNTIME_FILE;
  const home = homedir();
  switch (platform()) {
    case "darwin": return join(home, "Library", "Application Support", "Busyholm", "runtime.json");
    case "win32": return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Busyholm", "runtime.json");
    default: return join(process.env.XDG_RUNTIME_DIR || join(home, ".local", "share"), "busyholm", "runtime.json");
  }
}

// The runtime file is written by the Busyholm app with mode 0600: { v: 1, port, secret, token }
// (the collector's RuntimeInfo).
// Everything is validated, and a file that does not look right is treated as absent.
function parseRuntime(text) {
  try {
    const r = JSON.parse(text);
    if (!isObj(r)) return null;
    const ok = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{8,256}$/.test(s);
    if (r.v !== 1) return null;
    if (!Number.isInteger(r.port) || r.port < 1024 || r.port > 65535) return null;
    if (!ok(r.secret) || !ok(r.token)) return null;
    return { port: r.port, secret: r.secret, token: r.token };
  } catch {
    return null;
  }
}

function activityOf(tool) {
  return typeof tool === "string" ? ACTIVITY.get(tool.toLowerCase()) ?? "other" : "other";
}

// Build a fresh object from validated primitives. Nothing is copied from the source event.
function wire(type, fields) {
  const body = { v: 1, agent: "opencode", type };
  if (fields.sid) body.sid = fields.sid;
  if (fields.psid) body.psid = fields.psid;
  if (fields.rid) body.rid = fields.rid;
  if (fields.activity) body.activity = fields.activity;
  if (fields.error) body.error = fields.error;
  if (fields.tok) body.tok = fields.tok;
  body.et = Date.now();
  return body;
}

function sessionIdOf(props) {
  return str(props.sessionID) ?? (isObj(props.info) ? str(props.info.sessionID) ?? str(props.info.id) : null);
}

// sid plus, for a subagent session whose parent we have seen, psid.
function ids(state, id) {
  const psid = state.parents.get(id);
  return psid ? { sid: digest(id), psid } : { sid: digest(id) };
}

function learnParent(state, info) {
  const id = str(info.id);
  const parent = str(info.parentID);
  if (!id || !parent) return;
  state.parents.delete(id);
  state.parents.set(id, digest(parent));
  if (state.parents.size > SEEN_CAP * 2) state.parents.delete(state.parents.keys().next().value);
}

// Map one OpenCode bus event to zero or one wire bodies.
function fromEvent(event, state) {
  if (!isObj(event) || typeof event.type !== "string") return null;
  const props = isObj(event.properties) ? event.properties : isObj(event.data) ? event.data : {};
  switch (event.type) {
    case "session.created": {
      const info = isObj(props.info) ? props.info : {};
      const id = str(info.id);
      if (!id) return null;
      learnParent(state, info);
      return wire("session.created", ids(state, id));
    }
    case "session.updated": {
      // Never posted; only used to learn which sessions are children.
      if (isObj(props.info)) learnParent(state, props.info);
      return null;
    }
    case "session.deleted": {
      const id = isObj(props.info) ? str(props.info.id) : null;
      return id ? wire("session.deleted", ids(state, id)) : null;
    }
    case "session.status": {
      const id = str(props.sessionID);
      const kind = isObj(props.status) ? props.status.type : null;
      return id && kind === "busy" ? wire("session.busy", ids(state, id)) : null;
    }
    case "session.idle": {
      const id = str(props.sessionID);
      return id ? wire("session.idle", ids(state, id)) : null;
    }
    case "session.error": {
      const id = str(props.sessionID);
      if (!id) return null;
      const name = isObj(props.error) && typeof props.error.name === "string" ? props.error.name : "";
      return wire("session.error", { ...ids(state, id), error: ERROR_CLASS.get(name) ?? "unknown" });
    }
    case "permission.asked":
    case "permission.updated":
    case "permission.v2.asked":
    case "question.asked":
    case "question.v2.asked": {
      const id = str(props.sessionID);
      const req = str(props.id);
      if (!id) return null;
      const rid = req ? digest(req) : null;
      if (rid) {
        if (state.seenRequests.has(rid)) return null;
        state.seenRequests.add(rid);
        if (state.seenRequests.size > SEEN_CAP) state.seenRequests.delete(state.seenRequests.values().next().value);
      }
      const type = event.type.startsWith("question") ? "question.asked" : "permission.asked";
      return wire(type, { ...ids(state, id), rid });
    }
    case "permission.replied":
    case "permission.v2.replied":
    case "question.replied":
    case "question.v2.replied":
    case "question.rejected":
    case "question.v2.rejected": {
      const id = str(props.sessionID);
      const req = str(props.requestID) ?? str(props.permissionID);
      if (!id) return null;
      const type = event.type.startsWith("question") ? "question.replied" : "permission.replied";
      return wire(type, { ...ids(state, id), rid: req ? digest(req) : null });
    }
    case "message.updated": {
      const info = isObj(props.info) ? props.info : null;
      if (!info || info.role !== "assistant" || !isObj(info.tokens)) return null;
      const mid = str(info.id);
      const sid = str(info.sessionID);
      if (!mid || !sid) return null;
      const t = info.tokens;
      const cache = isObj(t.cache) ? t.cache : {};
      const total = count(t.input) + count(t.output) + count(t.reasoning) + count(cache.read) + count(cache.write);
      const last = state.tokensByMessage.get(mid) ?? 0;
      state.tokensByMessage.delete(mid);
      state.tokensByMessage.set(mid, Math.max(total, last));
      if (state.tokensByMessage.size > SEEN_CAP) state.tokensByMessage.delete(state.tokensByMessage.keys().next().value);
      const delta = total - last;
      return delta > 0 ? wire("tokens", { ...ids(state, sid), tok: Math.min(delta, 1e9) }) : null;
    }
    default:
      return null;
  }
}

// Monotonic milliseconds: immune to wall-clock jumps.
const mono = () => Number(process.hrtime.bigint() / 1000000n);

// Read the runtime file without ever blocking the event loop or trusting its size: open without
// waiting for a writer (a FIFO or other special file is refused), require a regular file of at most
// MAX_RUNTIME_BYTES, and give up after RUNTIME_READ_TIMEOUT_MS.
async function readRuntimeFile(file) {
  const work = (async () => {
    let fh;
    try {
      fh = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
      const st = await fh.stat();
      if (!st.isFile() || st.size > MAX_RUNTIME_BYTES) return null;
      const buf = Buffer.alloc(MAX_RUNTIME_BYTES + 1);
      const { bytesRead } = await fh.read(buf, 0, MAX_RUNTIME_BYTES + 1, 0);
      if (bytesRead > MAX_RUNTIME_BYTES) return null;
      return parseRuntime(buf.toString("utf8", 0, bytesRead));
    } catch {
      return null;
    } finally {
      if (fh) fh.close().catch(() => {});
    }
  })();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), RUNTIME_READ_TIMEOUT_MS);
    if (typeof timer?.unref === "function") timer.unref();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function server(_input, options) {
  const opts = isObj(options) ? options : {};
  const runtimeFile = typeof opts.runtimeFile === "string" ? opts.runtimeFile : defaultRuntimeFile();
  const transport = typeof opts.transport === "function" ? opts.transport : (url, init) => fetch(url, init);

  const state = { seenRequests: new Set(), tokensByMessage: new Map(), parents: new Map() };
  // Cached primitives only: the hooks never touch the file system.
  let runtime = null;
  let runtimeAt = 0;
  let generation = 0; // bumps when the cached runtime is replaced or dropped
  let failures = 0; // consecutive failed generations; reset by a 2xx
  let nextAttemptAt = 0; // monotonic ms before which no new file read starts
  let refreshing = null;
  let retryTimer = null;
  let inFlight = 0;
  const pending = []; // { body, at, retried } held only while there is no usable runtime

  const backoff = () => Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** Math.max(0, Math.min(failures, 10) - 1));

  function refresh() {
    if (refreshing) return refreshing;
    refreshing = readRuntimeFile(runtimeFile)
      .then((rt) => {
        generation += 1;
        runtime = rt;
        runtimeAt = mono();
        if (!rt) {
          failures += 1;
          nextAttemptAt = mono() + backoff();
        }
      })
      .catch(() => { runtime = null; })
      .finally(() => {
        refreshing = null;
        flush();
        scheduleRetry();
      });
    return refreshing;
  }

  // The current runtime failed (network error or a rejecting status): drop it and allow a re-read
  // after a short, growing pause. Several failures from one generation count once.
  function invalidate(gen) {
    if (gen !== generation) return;
    generation += 1;
    runtime = null;
    failures += 1;
    nextAttemptAt = mono() + backoff();
  }

  function scheduleRetry(delay) {
    if (retryTimer || pending.length === 0) return;
    const wait = delay ?? Math.max(0, nextAttemptAt - mono());
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (runtime) flush();
      else if (!refreshing) void refresh();
    }, wait);
    if (typeof retryTimer?.unref === "function") retryTimer.unref();
  }

  function enqueue(body, retried) {
    pending.push({ body, at: mono(), retried });
    while (pending.length > PENDING_CAP) pending.shift();
  }

  function flush() {
    if (!runtime) return;
    const now = mono();
    const batch = pending.splice(0, pending.length);
    for (const item of batch) if (now - item.at <= PENDING_MAX_AGE_MS) send(item.body, item.retried);
  }

  function requeue(body, retried, delay) {
    if (retried || NO_RETRY.has(body.type)) return;
    enqueue(body, true);
    scheduleRetry(delay);
  }

  function send(body, retried) {
    const rt = runtime;
    if (!rt) return;
    const gen = generation;
    const limit = URGENT.has(body.type) ? MAX_URGENT_IN_FLIGHT : MAX_IN_FLIGHT;
    if (inFlight >= limit) return;
    inFlight += 1;
    let freed = false;
    const free = () => { if (!freed) { freed = true; inFlight -= 1; clearTimeout(timer); } };
    // A transport that ignores the abort signal must not pin the slot forever.
    const timer = setTimeout(free, REQUEST_TIMEOUT_MS * 2);
    if (typeof timer?.unref === "function") timer.unref();
    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-busyholm-token": rt.token,
        "x-busyholm-agent": "opencode",
      },
      body: JSON.stringify(body),
      // Event data must never follow a redirect off loopback (a stale port can be taken by anything).
      redirect: "error",
      signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
    };
    const failed = () => { invalidate(gen); requeue(body, retried, Math.max(0, nextAttemptAt - mono())); };
    const handle = (res) => {
      free();
      const status = isObj(res) && typeof res.status === "number" ? res.status : 204;
      try { const c = res?.body?.cancel?.(); if (c && typeof c.catch === "function") c.catch(() => {}); } catch { /* ignore */ }
      if (status >= 200 && status < 300) { failures = 0; return; }
      // Not our receiver any more (wrong or stale secret or token): look for fresh runtime details.
      if (status === 401 || status === 403 || status === 404 || status === 410) { failed(); return; }
      // Transient: keep the runtime and retry the event once shortly.
      if (status === 408 || status === 429 || status >= 500) { requeue(body, retried, MIN_RETRY_MS); return; }
      // Any other status means this event was refused; nothing to repair.
    };
    let pendingResponse;
    try {
      pendingResponse = transport(`http://127.0.0.1:${rt.port}/e/${rt.secret}`, init);
    } catch {
      free();
      failed();
      return;
    }
    Promise.resolve(pendingResponse).then(handle, () => { free(); failed(); });
  }

  // Fire and forget. Never throws, never awaits, never logs, never reads a file.
  function post(body) {
    try {
      if (!body) return;
      if (runtime && mono() - runtimeAt > RUNTIME_TTL_MS && !refreshing) void refresh();
      if (runtime) {
        send(body, false);
        return;
      }
      enqueue(body, false);
      if (!refreshing && mono() >= nextAttemptAt) void refresh();
      else scheduleRetry();
    } catch {
      // swallow
    }
  }

  // One bounded read at load, so the first events find the runtime already cached.
  await refresh();

  return {
    event: async (input) => {
      try {
        post(fromEvent(isObj(input) ? input.event : null, state));
      } catch {
        // swallow
      }
    },
    "tool.execute.after": async (input) => {
      try {
        if (!isObj(input)) return;
        const id = str(input.sessionID);
        if (!id) return;
        post(wire("tool.after", { ...ids(state, id), activity: activityOf(input.tool) }));
      } catch {
        // swallow
      }
    },
  };
}

export default { id: "busyholm", server };
