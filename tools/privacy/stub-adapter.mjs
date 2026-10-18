// TEST STUB for tools/privacy tests. It is NOT a reference adapter: WP-04, WP-05 and
// WP-06 must not copy it. Its only job is to prove the privacy checker works, by
// producing one output that must leak canaries (leaky mode) and one that must not
// (clean mode), from the fixtures written by tools/fixtures/agent-inputs.mjs.
//
// CLI: node tools/privacy/stub-adapter.mjs --mode leaky|clean <inputDir> <outDir>
//
// leaky: copies the raw JSON or log line of every record into outDir/leaky.log.
// clean: a tiny allowlist mapper. Each record becomes at most one AgentEvent v1 in
//        outDir/events.jsonl, built only from enums, numbers and a salted hash.
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { validate } from "../../contracts/ts/src/validate.ts";
import { isMain } from "../is-main.mjs";

const CLOCK_START = 1791806400000;
const SALT = "busyholm-test-salt";

/** Lists input files (sorted, depth first, no symlinks), skipping index.json and never-open/. */
function listInputs(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out
    .map((abs) => ({ abs, rel: relative(dir, abs).split("\\").join("/") }))
    .filter((f) => f.rel !== "index.json" && !f.rel.startsWith("never-open/"));
}

/** Yields the raw records of one file: { raw, parsed } (parsed is undefined when not JSON). */
function* records(file) {
  const text = readFileSync(file.abs, "utf8");
  if (file.rel.endsWith(".json")) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* unparseable */ }
    yield { raw: text.trim(), parsed };
    return;
  }
  // Split on LF only: U+2028 inside a JSON string is not a line break.
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (file.rel.endsWith(".jsonl")) {
      let parsed;
      try { parsed = JSON.parse(line); } catch { /* skip */ }
      yield { raw: line, parsed };
    } else {
      yield { raw: line, parsed: undefined };
    }
  }
}

// ----------------------------------------------------------------- clean mode
const hashId = (agent, raw) => createHmac("sha256", SALT).update(`${agent}:${raw}`).digest("hex").slice(0, 32);
const isStr = (v) => typeof v === "string" && v.length > 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

const ACTIVITY = {
  Bash: "shell", run_shell_command: "shell", bash: "shell", shell: "shell",
  Edit: "edit", Write: "edit", MultiEdit: "edit", NotebookEdit: "edit", apply_patch: "edit", write_file: "edit", replace: "edit",
  Read: "read", Grep: "read", Glob: "read", LS: "read", read_file: "read",
  WebFetch: "web", WebSearch: "web", google_web_search: "web",
  Task: "delegate", Agent: "delegate",
};
const activityOf = (toolName) => (typeof toolName === "string" && Object.hasOwn(ACTIVITY, toolName) ? ACTIVITY[toolName] : "other");

const NOTIFICATIONS = new Set([
  "permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input", "elicitation_response",
  "elicitation_complete", "idle_prompt", "quota_auto_resume_fired", "quota_auto_resume_stale", "quota_auto_resume_disabled",
]);
const END_REASONS = { clear: "clear", resume: "resume", logout: "logout", prompt_input_exit: "exit" };
const ERROR_CLASSES = {
  overloaded: "overloaded", server_error: "server_error", authentication_failed: "auth", oauth_org_not_allowed: "auth",
  billing_error: "billing", account_on_hold: "billing", invalid_request: "invalid_request", model_not_found: "model_not_found",
  max_output_tokens: "max_output_tokens",
};
const HOSTS = { cli: "cli", "claude-desktop": "desktop", "sdk-ts": "sdk", "claude-vscode": "vscode" };
const statusClass = (s) => (s === 529 ? "overloaded" : s === 401 || s === 403 ? "auth" : isNum(s) && s >= 500 ? "server_error" : "unknown");

function mapClaudeHook(b) {
  const evName = b.hook_event_name;
  const child = isStr(b.agent_id);
  const raw = child ? b.agent_id : b.session_id;
  const parentRaw = child ? b.session_id : null;
  const ev = (kind, detail) => ({ raw, parentRaw, kind, source: "hook", confidence: "exact", host: "other", detail });
  switch (evName) {
    case "SessionStart": return ev("session_start");
    case "SubagentStart": return { ...ev("session_start"), raw: b.agent_id, parentRaw: b.session_id };
    case "SessionEnd": return ev("session_end", { end_reason: END_REASONS[b.reason] ?? "other" });
    case "SubagentStop": return { ...ev("session_end", { end_reason: "other" }), raw: b.agent_id, parentRaw: b.session_id };
    case "UserPromptSubmit": return ev("turn_start");
    case "PreToolUse": return b.tool_name === "AskUserQuestion" ? ev("needs_answer") : null;
    case "PostToolUse":
    case "PostToolUseFailure": return ev("tool_end", { activity: activityOf(b.tool_name) });
    case "PermissionRequest": return ev("needs_permission");
    case "PermissionDenied": return ev("answered");
    case "Notification": {
      const n = NOTIFICATIONS.has(b.notification_type) ? b.notification_type : "other";
      const detail = { notification: n };
      if (n === "permission_prompt") return ev("needs_permission", detail);
      if (["elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"].includes(n)) return ev("needs_answer", detail);
      if (n === "elicitation_response" || n === "elicitation_complete") return ev("answered", detail);
      return ev("heartbeat", detail);
    }
    case "Stop": return ev("turn_end", { stop_reason: "end_turn" });
    case "StopFailure":
      if (b.error === "rate_limit") return { ...ev("limit_hit"), limit: { provider: "claude", window: "unknown", resets_at: null } };
      return ev("error", { error_class: ERROR_CLASSES[b.error] ?? "unknown" });
    case "PreCompact":
    case "PostCompact": return ev("heartbeat");
    default: return null;
  }
}

function mapClaudeStatusline(b) {
  const rl = b.rate_limits;
  if (!rl || typeof rl !== "object" || !isStr(b.session_id)) return null;
  for (const [key, window] of [["five_hour", "5h"], ["seven_day", "weekly"]]) {
    const w = rl[key];
    if (w && isNum(w.used_percentage) && isNum(w.resets_at)) {
      return {
        raw: b.session_id, parentRaw: null, kind: "usage_sample", source: "hook", confidence: "exact", host: "other",
        usage: { provider: "claude", window, used_pct: w.used_percentage, resets_at: Math.round(w.resets_at * 1000) },
      };
    }
  }
  return null;
}

function mapClaudeRegistry(b) {
  if (!isStr(b.sessionId)) return null;
  const base = { raw: b.sessionId, parentRaw: null, source: "registry", host: HOSTS[b.entrypoint] ?? "other" };
  if (b.status === "busy") return { ...base, kind: "turn_start", confidence: "exact" };
  if (b.status === "waiting") return { ...base, kind: "needs_permission", confidence: "inferred" };
  if (b.status === "idle") return { ...base, kind: "heartbeat", confidence: "inferred" };
  return null;
}

function mapClaudeTranscript(r) {
  if (!isStr(r.sessionId)) return null;
  const base = { raw: r.sessionId, parentRaw: null, source: "log", confidence: "exact", host: HOSTS[r.entrypoint] ?? "other" };
  if (r.type === "assistant" && r.quotaLimits && r.quotaLimits.status === "rejected") {
    const resetsAt = isNum(r.quotaLimits.resetsAt) ? Math.round(r.quotaLimits.resetsAt * 1000) : null;
    return { ...base, kind: "limit_hit", limit: { provider: "claude", window: r.quotaLimits.rateLimitType === "five_hour" ? "5h" : "unknown", resets_at: resetsAt } };
  }
  if (r.type === "assistant" && r.isApiErrorMessage === true) return { ...base, kind: "error", detail: { error_class: statusClass(r.apiErrorStatus) } };
  if (r.type === "system" && r.subtype === "api_error") {
    if (isNum(r.retryAttempt) && isNum(r.maxRetries) && r.retryAttempt >= r.maxRetries) {
      return { ...base, kind: "error", detail: { error_class: statusClass(r.error && r.error.status) } };
    }
    return null;
  }
  if (r.type === "assistant" && r.message && Array.isArray(r.message.content)) {
    if (r.message.stop_reason === "end_turn") return { ...base, kind: "turn_end", detail: { stop_reason: "end_turn" } };
    const tool = r.message.content.find((c) => c && c.type === "tool_use");
    if (tool) return { ...base, kind: "heartbeat", detail: { activity: activityOf(tool.name) } };
  }
  if (r.type === "user" && r.toolUseResult !== undefined) return { ...base, kind: "tool_end", detail: { activity: "other" } };
  if (r.type === "user" && r.origin && r.origin.kind === "human") return { ...base, kind: "turn_start" };
  return null;
}

function mapCodexHook(b) {
  const child = isStr(b.agent_id);
  const raw = child ? b.agent_id : b.session_id;
  const parentRaw = child ? b.session_id : null;
  const ev = (kind, detail) => ({ raw, parentRaw, kind, source: "hook", confidence: "exact", host: "other", detail });
  switch (b.hook_event_name) {
    case "SessionStart":
    case "SubagentStart": return ev("session_start");
    case "SessionEnd": return ev("session_end", { end_reason: END_REASONS[b.reason] ?? "other" });
    case "SubagentStop": return ev("session_end", { end_reason: "other" });
    case "UserPromptSubmit": return ev("turn_start");
    case "PermissionRequest": return ev("needs_permission");
    case "PostToolUse": return ev("tool_end", { activity: activityOf(b.tool_name) });
    case "PreCompact":
    case "PostCompact": return ev("heartbeat");
    case "Stop": return ev("turn_end", { stop_reason: "end_turn" });
    case "Interrupt": return ev("turn_interrupted", { stop_reason: "interrupted" });
    default: return null;
  }
}

function mapCodexRollout(r, state) {
  const p = r.payload;
  if (!p || typeof p !== "object") return null;
  if (r.type === "session_meta") {
    if (isStr(p.id)) state.id = p.id;
    return isStr(p.id) ? { raw: p.id, parentRaw: null, kind: "session_start", source: "log", confidence: "exact", host: "other" } : null;
  }
  if (!state.id || r.type !== "event_msg") return null;
  const base = { raw: state.id, parentRaw: null, source: "log", confidence: "exact", host: "other" };
  switch (p.type) {
    case "task_started": return { ...base, kind: "turn_start" };
    case "task_complete": return { ...base, kind: "turn_end", detail: { stop_reason: "end_turn" } };
    case "turn_aborted": return { ...base, kind: "turn_interrupted", detail: { stop_reason: "interrupted" } };
    case "token_count": {
      const pr = p.rate_limits && p.rate_limits.primary;
      if (!pr || !isNum(pr.used_percent) || !isNum(pr.resets_at)) return null;
      return { ...base, kind: "usage_sample", usage: { provider: "codex", window: "5h", used_pct: pr.used_percent, resets_at: Math.round(pr.resets_at * 1000) } };
    }
    case "item_completed": {
      const t = p.item && p.item.type;
      const activity = t === "CommandExecution" ? "shell" : t === "FileChange" ? "edit" : t === "SubAgentActivity" ? "delegate" : t === "McpToolCall" ? "other" : null;
      return activity ? { ...base, kind: "tool_end", detail: { activity } } : null;
    }
    default: return null;
  }
}

function mapCodexNotify(b) {
  if (b.type !== "agent-turn-complete" || !isStr(b["thread-id"])) return null;
  return { raw: b["thread-id"], parentRaw: null, kind: "turn_end", source: "hook", confidence: "exact", host: "other", detail: { stop_reason: "end_turn" } };
}

function mapOpenCode(b) {
  const props = b.properties ?? {};
  const info = props.info ?? {};
  const raw = props.sessionID ?? info.id ?? (props.part && props.part.sessionID) ?? (b.input && b.input.sessionID);
  if (!isStr(raw)) return null;
  const base = { raw, parentRaw: isStr(info.parentID) ? info.parentID : null, source: "plugin", confidence: "exact", host: "other" };
  switch (b.type) {
    case "session.created": return { ...base, kind: "session_start" };
    case "session.status": return { ...base, kind: props.status && props.status.type === "busy" ? "turn_start" : "heartbeat" };
    case "session.idle": return { ...base, kind: "turn_end", detail: { stop_reason: "end_turn" } };
    case "session.error": return { ...base, kind: "error", detail: { error_class: "unknown" } };
    case "session.updated": return { ...base, kind: "heartbeat" };
    case "permission.asked": return { ...base, kind: "needs_permission" };
    case "permission.replied": return { ...base, kind: "answered" };
    case "tool.execute.after": return { ...base, kind: "tool_end", detail: { activity: activityOf(b.input && b.input.tool) } };
    default: return null;
  }
}

const GLOG_REQUEST = /^I\d{4} \d\d:\d\d:\d\d\.\d+ (\d+) http_helpers\.go:\d+\] URL: /;
function mapAntigravityLine(line) {
  const hit = GLOG_REQUEST.exec(line);
  if (!hit) return null;
  return { raw: `pid:${hit[1]}`, parentRaw: null, kind: "heartbeat", source: "log", confidence: "inferred", host: "cli" };
}

function mapGemini(b) {
  if (!isStr(b.session_id)) return null;
  const base = { raw: b.session_id, parentRaw: null, source: "hook", confidence: "exact", host: "cli" };
  switch (b.hook_event_name) {
    case "BeforeAgent": return { ...base, kind: "turn_start" };
    case "AfterAgent": return { ...base, kind: "turn_end", detail: { stop_reason: "end_turn" } };
    case "AfterTool": return { ...base, kind: "tool_end", detail: { activity: activityOf(b.tool_name) } };
    case "Notification": return b.notification_type === "ToolPermission" ? { ...base, kind: "needs_permission", confidence: "inferred" } : null;
    default: return null;
  }
}

function mapCursor(b) {
  if (!isStr(b.conversation_id)) return null;
  const base = { raw: b.conversation_id, parentRaw: null, source: "hook", confidence: "exact", host: "ide" };
  switch (b.hook_event_name) {
    case "beforeSubmitPrompt": return { ...base, kind: "turn_start" };
    case "afterShellExecution": return { ...base, kind: "tool_end", detail: { activity: "shell" } };
    case "stop":
      if (b.status === "completed") return { ...base, kind: "turn_end", detail: { stop_reason: "end_turn" } };
      if (b.status === "aborted") return { ...base, kind: "turn_interrupted", detail: { stop_reason: "interrupted" } };
      return { ...base, kind: "error", detail: { error_class: "unknown" } };
    default: return null;
  }
}

/** Maps one record to a draft { agent, raw, parentRaw, kind, ... } or null. */
function mapRecord(agent, source, rec, state) {
  const b = rec.parsed;
  if (agent === "antigravity") return source === "log" ? mapAntigravityLine(rec.raw) : null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  switch (`${agent}/${source}`) {
    case "claude/hooks": return mapClaudeHook(b);
    case "claude/statusline": return mapClaudeStatusline(b);
    case "claude/registry": return mapClaudeRegistry(b);
    case "claude/transcript": return mapClaudeTranscript(b);
    case "codex/hooks": return mapCodexHook(b);
    case "codex/rollout": return mapCodexRollout(b, state);
    case "codex/notify": return mapCodexNotify(b);
    case "opencode/plugin": return mapOpenCode(b);
    case "gemini/hooks": return mapGemini(b);
    case "cursor/hooks": return mapCursor(b);
    default: return null;
  }
}

function buildEvent(agent, draft, t) {
  const event = {
    v: 1,
    agent,
    instance: hashId(agent, draft.raw),
    parent: draft.parentRaw ? hashId(agent, draft.parentRaw) : null,
    // Identity (contracts r1). The stub knows one data root per agent and never
    // derives accounts, turns or requests; a real adapter fills what its source gives.
    root_id: hashId(agent, "root:default"),
    account_id: null,
    session_id: hashId(agent, draft.parentRaw ?? draft.raw),
    turn_id: null,
    request_id: null,
    host: draft.host,
    kind: draft.kind,
    source: draft.source,
    confidence: draft.confidence,
    t,
  };
  if (draft.detail && Object.keys(draft.detail).length > 0) event.detail = draft.detail;
  if (draft.usage) event.usage = { ...draft.usage, observed_at: t };
  if (draft.limit) event.limit = draft.limit;
  const result = validate("agentEvent", event);
  if (!result.ok) {
    const first = result.issues[0];
    throw new Error(`stub-adapter: event failed AgentEvent v1 validation at "${first.path}": ${first.message}`);
  }
  return event;
}

// ----------------------------------------------------------------- entry points
/** Runs the stub. Returns { files, events }: input files processed and events written. */
export function run(mode, inputDir, outDir) {
  if (mode !== "leaky" && mode !== "clean") throw new Error(`stub-adapter: mode must be leaky or clean, got ${mode}`);
  const files = listInputs(inputDir);
  mkdirSync(outDir, { recursive: true });
  rmSync(join(outDir, "leaky.log"), { force: true });
  rmSync(join(outDir, "events.jsonl"), { force: true });

  if (mode === "leaky") {
    const lines = [];
    for (const file of files) {
      for (const rec of records(file)) {
        lines.push(rec.parsed !== undefined && file.rel.endsWith(".json") ? JSON.stringify(rec.parsed) : rec.raw);
      }
    }
    writeFileSync(join(outDir, "leaky.log"), lines.join("\n") + "\n");
    return { files: files.length, events: 0 };
  }

  const events = [];
  let index = 0;
  for (const file of files) {
    const [agent, source] = file.rel.split("/");
    const state = {};
    for (const rec of records(file)) {
      const t = CLOCK_START + index++;
      const draft = mapRecord(agent, source, rec, state);
      if (draft) events.push(buildEvent(agent, draft, t));
    }
  }
  writeFileSync(join(outDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
  return { files: files.length, events: events.length };
}

function main(argv) {
  const args = argv.slice(2);
  let mode = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode") mode = args[++i];
    else rest.push(args[i]);
  }
  if (!mode || rest.length !== 2) {
    console.error("usage: node tools/privacy/stub-adapter.mjs --mode leaky|clean <inputDir> <outDir>");
    process.exit(2);
  }
  const result = run(mode, rest[0], rest[1]);
  console.log(`stub-adapter (${mode}): ${result.files} input files, ${result.events} events`);
}

if (isMain(import.meta.url)) main(process.argv);
