// Synthetic agent-side input fixtures with privacy canaries (SPEC 5.3 to 5.7).
//
// Every payload here is invented from the documented shapes in
// research/agent-data-layer.md. Nothing is read from a real agent folder. Every
// content-bearing field holds a canary from tools/privacy/canary.mjs, so any
// adapter that copies one byte of content into its output is caught by
// tools/privacy/check.mjs. Output is fully deterministic: no clock, no
// randomness, markers numbered in a fixed call order.
//
// Use: writeAgentInputs(outDir) -> number of input files written (index.json excluded).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { canaryId, marker, resetMarkers } from "../privacy/canary.mjs";

/** 2026-10-12T12:00:00Z in ms, the reference "now" of every fixture. */
const T0 = 1791806400000;
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();
/** Epoch seconds used for rate limit resets (in 3 hours and in 3 days). */
const RESET_5H_S = T0 / 1000 + 3 * 3600;
const RESET_7D_S = T0 / 1000 + 3 * 86400;

export function writeAgentInputs(outDir) {
  const root = resolve(outDir);
  if (root.split("/").filter(Boolean).length < 2 || root === homedir() || root.includes("/Desktop")) {
    throw new Error(`writeAgentInputs: refusing to wipe ${root}`);
  }
  resetMarkers();
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const index = [];
  let idCounter = 0;
  /** A fresh raw-id canary with a distinct n. */
  const nid = () => canaryId(++idCounter);
  const m = (agent, field) => marker(agent, field);
  const cwdOf = (agent) => `/Users/someone/code/${m(agent, "cwd")}`;
  const fileOf = (agent) => `/Users/someone/code/${m(agent, "file_path")}/index.ts`;

  function emit(relPath, agent, source, format, about, text) {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    index.push({ path: relPath, agent, source, format, about });
  }
  const json = (agent, source, name, about, obj) =>
    emit(`${agent}/${source}/${name}.json`, agent, source, "json", about, JSON.stringify(obj, null, 2) + "\n");
  const jsonl = (agent, source, name, about, records) =>
    emit(`${agent}/${source}/${name}.jsonl`, agent, source, "jsonl", about, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const rawJsonl = (agent, source, name, about, text) =>
    emit(`${agent}/${source}/${name}.jsonl`, agent, source, "jsonl", about, text);

  // ---------------------------------------------------------------- claude/hooks
  const claudeSid = nid();
  const claudeSubId = nid();
  const cc = (event, extra = {}, sid = claudeSid) => ({
    session_id: sid,
    prompt_id: nid(),
    transcript_path: `/Users/someone/.claude/projects/${m("claude", "transcript_path")}/${sid}.jsonl`,
    cwd: cwdOf("claude"),
    permission_mode: "default",
    hook_event_name: event,
    effort: { level: "high" },
    ...extra,
  });
  const ch = (name, about, obj) => json("claude", "hooks", name, about, obj);

  for (const source of ["startup", "resume"]) {
    ch(`session-start-${source}`, `Claude SessionStart hook body, source ${source}.`, cc("SessionStart", { source, model: "claude-sonnet-5-5" }));
  }
  for (const reason of ["clear", "logout", "prompt_input_exit", "other"]) {
    ch(`session-end-${reason.replace(/_/g, "-")}`, `Claude SessionEnd hook body, reason ${reason}.`, cc("SessionEnd", { reason }));
  }
  ch("user-prompt-submit", "Claude UserPromptSubmit hook body carrying the prompt text.", cc("UserPromptSubmit", { prompt: m("claude", "prompt") }));
  ch("pre-tool-use-bash", "Claude PreToolUse for Bash with a command in tool_input.", cc("PreToolUse", {
    tool_name: "Bash",
    tool_input: { command: `run ${m("claude", "command")} now`, description: m("claude", "description") },
    tool_use_id: nid(),
  }));
  ch("pre-tool-use-edit", "Claude PreToolUse for Edit with file_path and edit strings in tool_input.", cc("PreToolUse", {
    tool_name: "Edit",
    tool_input: { file_path: fileOf("claude"), old_string: m("claude", "old_string"), new_string: m("claude", "new_string") },
    tool_use_id: nid(),
  }));
  ch("pre-tool-use-ask-user-question", "Claude PreToolUse for AskUserQuestion, the needs-an-answer signal.", cc("PreToolUse", {
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: [{
        question: m("claude", "question"),
        header: m("claude", "header"),
        options: [{ label: m("claude", "label"), description: m("claude", "description") }],
        multiSelect: false,
      }],
    },
    tool_use_id: nid(),
  }));
  ch("post-tool-use-bash", "Claude PostToolUse for Bash with tool_response output.", cc("PostToolUse", {
    tool_name: "Bash",
    tool_input: { command: m("claude", "command") },
    tool_response: { stdout: m("claude", "tool_response"), stderr: "", interrupted: false },
    tool_use_id: nid(),
  }));
  ch("post-tool-use-edit", "Claude PostToolUse for Edit with the changed file path and strings.", cc("PostToolUse", {
    tool_name: "Edit",
    tool_input: { file_path: fileOf("claude"), old_string: m("claude", "old_string"), new_string: m("claude", "new_string") },
    tool_response: { filePath: fileOf("claude"), oldString: m("claude", "tool_response"), newString: m("claude", "tool_response"), userModified: false },
    tool_use_id: nid(),
  }));
  ch("post-tool-use-webfetch", "Claude PostToolUse for WebFetch with the fetched result text.", cc("PostToolUse", {
    tool_name: "WebFetch",
    tool_input: { url: `https://example.invalid/${m("claude", "url")}`, prompt: m("claude", "prompt") },
    tool_response: { result: m("claude", "tool_response"), code: 200, codeText: "OK", durationMs: 412 },
    tool_use_id: nid(),
  }));
  ch("post-tool-use-task", "Claude PostToolUse for the Task (subagent launch) tool.", cc("PostToolUse", {
    tool_name: "Task",
    tool_input: { description: m("claude", "description"), prompt: m("claude", "prompt"), subagent_type: "general-purpose" },
    tool_response: { content: [{ type: "text", text: m("claude", "text") }], totalDurationMs: 9100 },
    tool_use_id: nid(),
  }));
  ch("post-tool-use-failure", "Claude PostToolUseFailure with an error string.", cc("PostToolUseFailure", {
    tool_name: "Bash",
    tool_input: { command: m("claude", "command") },
    tool_use_id: nid(),
    error: m("claude", "error"),
    is_interrupt: false,
  }));
  const perm = (tool, input) => ({
    tool_name: tool,
    tool_input: input,
    permission_suggestions: [{
      type: "addRules",
      rules: [{ toolName: tool, ruleContent: m("claude", "permission_suggestions") }],
      behavior: "allow",
      destination: "localSettings",
    }],
  });
  ch("permission-request-bash", "Claude PermissionRequest for Bash with permission_suggestions.", cc("PermissionRequest", perm("Bash", { command: m("claude", "command"), description: m("claude", "description") })));
  ch("permission-request-edit", "Claude PermissionRequest for Edit with permission_suggestions.", cc("PermissionRequest", perm("Edit", { file_path: fileOf("claude"), old_string: m("claude", "old_string"), new_string: m("claude", "new_string") })));
  ch("permission-denied", "Claude PermissionDenied with the tool input and a reason.", cc("PermissionDenied", {
    tool_name: "Bash",
    tool_input: { command: m("claude", "command") },
    tool_use_id: nid(),
    reason: m("claude", "reason"),
  }));
  for (const type of ["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input", "elicitation_response", "elicitation_complete", "idle_prompt", "quota_auto_resume_fired"]) {
    ch(`notification-${type.replace(/_/g, "-")}`, `Claude Notification hook body, notification_type ${type}, with message and title text.`, cc("Notification", {
      notification_type: type,
      message: m("claude", "message"),
      title: m("claude", "title"),
    }));
  }
  ch("stop", "Claude Stop hook body with last_assistant_message.", cc("Stop", {
    stop_hook_active: false,
    last_assistant_message: m("claude", "last_assistant_message"),
    background_tasks: [],
    session_crons: [],
  }));
  for (const error of ["rate_limit", "overloaded", "server_error", "authentication_failed"]) {
    ch(`stop-failure-${error.replace(/_/g, "-")}`, `Claude StopFailure hook body, error ${error}.`, cc("StopFailure", {
      error,
      error_details: m("claude", "error_details"),
      last_assistant_message: m("claude", "last_assistant_message"),
    }));
  }
  ch("subagent-start", "Claude SubagentStart: agent_id is the child, session_id is the parent session.", cc("SubagentStart", {
    agent_id: claudeSubId,
    agent_type: "general-purpose",
  }));
  ch("subagent-stop", "Claude SubagentStop with the child transcript path and its last message.", cc("SubagentStop", {
    agent_id: claudeSubId,
    agent_type: "general-purpose",
    agent_transcript_path: `/Users/someone/.claude/projects/${m("claude", "transcript_path")}/${claudeSid}/subagents/agent-${claudeSubId}.jsonl`,
    stop_hook_active: false,
    last_assistant_message: m("claude", "last_assistant_message"),
  }));
  ch("post-tool-use-in-subagent", "Claude PostToolUse fired inside a subagent: agent_id and agent_type are set, so it is a child.", cc("PostToolUse", {
    tool_name: "Grep",
    tool_input: { pattern: m("claude", "pattern"), path: cwdOf("claude") },
    tool_response: { mode: "content", content: m("claude", "tool_response"), numLines: 3 },
    tool_use_id: nid(),
    agent_id: claudeSubId,
    agent_type: "general-purpose",
  }));
  ch("pre-compact", "Claude PreCompact with custom instructions text.", cc("PreCompact", { trigger: "auto", custom_instructions: m("claude", "custom_instructions") }));
  ch("post-compact", "Claude PostCompact with the compaction summary text.", cc("PostCompact", { trigger: "auto", compact_summary: m("claude", "summary") }));
  ch("task-created", "Claude TaskCreated with a task field and subject text.", cc("TaskCreated", {
    task_id: nid(),
    task: m("claude", "task"),
    task_subject: m("claude", "task_subject"),
    task_description: m("claude", "task_description"),
  }));
  ch("task-completed", "Claude TaskCompleted with a task field and subject text.", cc("TaskCompleted", {
    task_id: nid(),
    task: m("claude", "task"),
    task_subject: m("claude", "task_subject"),
    task_description: m("claude", "task_description"),
  }));

  // ---------------------------------------------------------------- claude/statusline
  const statusBase = () => ({
    session_id: nid(),
    transcript_path: `/Users/someone/.claude/projects/${m("claude", "transcript_path")}/status.jsonl`,
    cwd: cwdOf("claude"),
    model: { id: "claude-sonnet-5-5", display_name: "Sonnet 5.5" },
    workspace: { current_dir: cwdOf("claude"), project_dir: cwdOf("claude") },
    version: "2.1.296",
    cost: { total_cost_usd: 0.42, total_duration_ms: 540000, total_api_duration_ms: 61000, total_lines_added: 120, total_lines_removed: 14 },
    context_window: { total_input_tokens: 48000, total_output_tokens: 6200, context_window_size: 200000, used_percentage: 27, remaining_percentage: 73 },
  });
  json("claude", "statusline", "statusline-both-windows", "Claude status line stdin JSON with five_hour and seven_day rate_limits.", {
    ...statusBase(),
    rate_limits: {
      five_hour: { used_percentage: 37.5, resets_at: RESET_5H_S },
      seven_day: { used_percentage: 12, resets_at: RESET_7D_S },
    },
  });
  json("claude", "statusline", "statusline-five-hour-only", "Claude status line stdin JSON with only the five_hour window present.", {
    ...statusBase(),
    rate_limits: { five_hour: { used_percentage: 64, resets_at: RESET_5H_S } },
  });
  json("claude", "statusline", "statusline-no-rate-limits", "Claude status line stdin JSON with no rate_limits key (before the first API response).", statusBase());

  // ---------------------------------------------------------------- claude/registry
  const reg = (pid, status, entrypoint, extra = {}) => ({
    pid,
    sessionId: nid(),
    cwd: cwdOf("claude"),
    startedAt: T0 - 600000,
    procStart: "Mon Oct 12 11:50:00 2026",
    version: "2.1.296",
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    entrypoint,
    pidDomain: "local",
    messagingSocketPath: `/tmp/${m("claude", "socket")}/claude-${pid}.sock`,
    name: m("claude", "name"),
    nameSource: "ai",
    nameSince: T0 - 540000,
    status,
    statusUpdatedAt: T0 - 30000,
    updatedAt: T0 - 30000,
    ownerAccountUuid: m("claude", "ownerAccountUuid"),
    ownerOrganizationUuid: m("claude", "ownerOrganizationUuid"),
    ...extra,
  });
  json("claude", "registry", "registry-busy", "Claude sessions/<pid>.json for a busy terminal session.", reg(41001, "busy", "cli"));
  json("claude", "registry", "registry-idle", "Claude sessions/<pid>.json for an idle terminal session.", reg(41002, "idle", "cli"));
  json("claude", "registry", "registry-waiting", "Claude sessions/<pid>.json with status waiting (a Binary-only value, waitingFor is Unverified).", reg(41003, "waiting", "cli", { waitingFor: "permission" }));
  json("claude", "registry", "registry-desktop", "Claude sessions/<pid>.json for a Desktop-hosted idle session with host ids.", reg(41004, "idle", "claude-desktop", {
    hostSessionId: nid(),
    bridgeSessionId: nid(),
  }));

  // ---------------------------------------------------------------- claude/transcript
  /** Builds a chain of transcript records that share session, cwd and branch. */
  function transcriptWriter(sid) {
    const cwd = cwdOf("claude");
    const branch = m("claude", "gitBranch");
    let prev = null;
    let i = 0;
    const common = () => {
      const uuid = nid();
      const rec = { uuid, parentUuid: prev, isSidechain: false, sessionId: sid, cwd, version: "2.1.296", gitBranch: branch, entrypoint: "cli", timestamp: iso(++i) };
      prev = uuid;
      return rec;
    };
    const usage = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    return {
      human: (text) => ({ type: "user", ...common(), promptId: nid(), origin: { kind: "human" }, permissionMode: "default", message: { role: "user", content: text } }),
      toolUse: (name, input) => {
        const rec = { type: "assistant", ...common(), requestId: "req_fixture", message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: nid(), name, input }], stop_reason: "tool_use", stop_sequence: null, usage } };
        return rec;
      },
      toolResult: (toolUseId, result) => ({ type: "user", ...common(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: m("claude", "tool_result") }] }, toolUseResult: result }),
      endTurn: (text) => ({ type: "assistant", ...common(), requestId: "req_fixture", message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage } }),
      system: (subtype, extra) => ({ type: "system", subtype, ...common(), ...extra }),
      raw: (rec) => ({ ...rec, ...common() }),
      sid,
    };
  }

  {
    const sid = nid();
    const w = transcriptWriter(sid);
    const user = w.human(m("claude", "message_content"));
    const tool = w.toolUse("Bash", { command: `run ${m("claude", "command")} now`, description: m("claude", "description") });
    const toolId = tool.message.content[0].id;
    const result = w.toolResult(toolId, { stdout: m("claude", "toolUseResult"), stderr: "", interrupted: false, isImage: false });
    const end = w.endTurn(m("claude", "text"));
    const dur = w.system("turn_duration", { durationMs: 5400 });
    jsonl("claude", "transcript", "transcript-main", "Claude transcript: human prompt, tool_use, tool_result with toolUseResult, end_turn, titles, summary and cost-state.", [
      user, tool, result, end, dur,
      { type: "ai-title", sessionId: sid, aiTitle: m("claude", "aiTitle") },
      { type: "custom-title", sessionId: sid, customTitle: m("claude", "customTitle") },
      { type: "summary", summary: m("claude", "summary"), leafUuid: nid() },
      {
        type: "cost-state", sessionId: sid, totalCostUSD: 0.42, totalAPIDuration: 61000, totalDuration: 540000, totalLinesAdded: 120, totalLinesRemoved: 14,
        modelUsage: { "claude-sonnet-5-5": { inputTokens: 48000, outputTokens: 6200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.42 } },
      },
    ]);
  }
  {
    const sid = nid();
    const w = transcriptWriter(sid);
    jsonl("claude", "transcript", "transcript-api-errors", "Claude transcript: system api_error records (early retry and retries exhausted) and a synthetic isApiErrorMessage assistant record.", [
      w.human(m("claude", "message_content")),
      w.system("api_error", { level: "error", retryAttempt: 3, maxRetries: 10, retryInMs: 4000, error: { status: 529, type: "overloaded_error", message: m("claude", "message") } }),
      w.system("api_error", { level: "error", retryAttempt: 10, maxRetries: 10, retryInMs: 0, error: { status: 529, type: "overloaded_error", message: m("claude", "message") } }),
      w.raw({ type: "assistant", isApiErrorMessage: true, apiErrorStatus: 529, error: "overloaded", message: { id: "msg_synthetic", type: "message", role: "assistant", model: "<synthetic>", content: [{ type: "text", text: m("claude", "text") }], stop_reason: "stop_sequence", stop_sequence: "", usage: { input_tokens: 0, output_tokens: 0 } } }),
    ]);
  }
  {
    const sid = nid();
    const w = transcriptWriter(sid);
    jsonl("claude", "transcript", "transcript-quota-limit", "Claude transcript: an assistant record with quotaLimits status rejected for the five_hour window.", [
      w.human(m("claude", "message_content")),
      w.raw({
        type: "assistant", isApiErrorMessage: true, apiErrorStatus: 429, error: "rate_limit",
        quotaLimits: {
          status: "rejected", rateLimitType: "five_hour", resetsAt: RESET_5H_S, overageStatus: "rejected",
          overageDisabledReason: "org_level_disabled", isUsingOverage: false, unifiedRateLimitFallbackAvailable: false,
        },
        message: { id: "msg_synthetic", type: "message", role: "assistant", model: "<synthetic>", content: [{ type: "text", text: m("claude", "text") }], stop_reason: "stop_sequence", stop_sequence: "", usage: { input_tokens: 0, output_tokens: 0 } },
      }),
    ]);
  }
  {
    const sid = nid();
    const w = transcriptWriter(sid);
    const first = m("claude", "message_content");
    const second = m("claude", "message_content");
    const lines = [
      w.human(`${first} ${second}`),
      w.endTurn(m("claude", "text")),
    ].map((r) => JSON.stringify(r));
    rawJsonl("claude", "transcript", "transcript-u2028", "Claude transcript whose first line holds a raw U+2028 inside a JSON string: split on byte 0x0A only.", lines.join("\n") + "\n");
  }
  {
    const sid = nid();
    const w = transcriptWriter(sid);
    const full = [w.human(m("claude", "message_content")), w.endTurn(m("claude", "text"))].map((r) => JSON.stringify(r));
    const cut = JSON.stringify(w.human(m("claude", "message_content")));
    const truncated = cut.slice(0, cut.indexOf(`"message"`) + 60);
    rawJsonl("claude", "transcript", "transcript-truncated-tail", "Claude transcript whose last line is cut mid-record with no trailing newline (a partial write).", full.join("\n") + "\n" + truncated);
  }

  // ---------------------------------------------------------------- codex/hooks
  const codexSid = nid();
  const codexSubId = nid();
  const xc = (event, extra = {}) => ({
    session_id: codexSid,
    transcript_path: `/Users/someone/.codex/sessions/${m("codex", "transcript_path")}/rollout-2026-10-12T12-00-00-${codexSid}.jsonl`,
    cwd: cwdOf("codex"),
    hook_event_name: event,
    model: "gpt-6.1",
    turn_id: nid(),
    ...extra,
  });
  const xh = (name, about, obj) => json("codex", "hooks", name, about, obj);
  xh("session-start", "Codex SessionStart hook body.", xc("SessionStart", { source: "startup" }));
  xh("session-end", "Codex SessionEnd hook body.", xc("SessionEnd", { reason: "other" }));
  xh("user-prompt-submit", "Codex UserPromptSubmit hook body carrying the prompt.", xc("UserPromptSubmit", { prompt: m("codex", "prompt") }));
  xh("pre-tool-use", "Codex PreToolUse for a shell command.", xc("PreToolUse", { tool_name: "Bash", tool_input: { command: m("codex", "command") }, tool_use_id: nid() }));
  xh("permission-request", "Codex PermissionRequest with tool_input.", xc("PermissionRequest", { tool_name: "Bash", tool_input: { command: m("codex", "command"), description: m("codex", "description") } }));
  xh("post-tool-use", "Codex PostToolUse for apply_patch with tool_response.", xc("PostToolUse", {
    tool_name: "apply_patch",
    tool_input: { command: m("codex", "tool_input") },
    tool_response: m("codex", "tool_response"),
    tool_use_id: nid(),
  }));
  xh("pre-compact", "Codex PreCompact hook body.", xc("PreCompact", { trigger: "auto" }));
  xh("post-compact", "Codex PostCompact hook body.", xc("PostCompact", { trigger: "auto" }));
  xh("subagent-start", "Codex SubagentStart (field names for the child are a guess): agent_id is the child, session_id the parent.", xc("SubagentStart", { agent_id: codexSubId, agent_type: "worker" }));
  xh("subagent-stop", "Codex SubagentStop (field names for the child are a guess) with the child's last message.", xc("SubagentStop", { agent_id: codexSubId, agent_type: "worker", last_assistant_message: m("codex", "last_assistant_message") }));
  xh("stop", "Codex Stop hook body with last_assistant_message.", xc("Stop", { stop_hook_active: false, last_assistant_message: m("codex", "last_assistant_message") }));
  xh("interrupt", "Codex Interrupt hook body (the user pressed Esc).", xc("Interrupt"));

  // ---------------------------------------------------------------- codex/rollout
  function rolloutWriter() {
    let i = 0;
    const env = (type, payload) => ({ timestamp: iso(++i), type, payload });
    return {
      env,
      meta: () => env("session_meta", {
        id: nid(),
        session_id: nid(),
        timestamp: iso(0),
        cwd: cwdOf("codex"),
        originator: "codex-tui",
        cli_version: "0.162.1",
        source: "cli",
        model_provider: "openai",
        git: { branch: m("codex", "branch"), commit_hash: "0123456789abcdef0123456789abcdef01234567" },
        creator_user_id: m("codex", "creator_user_id"),
        creator_account_id: m("codex", "creator_account_id"),
      }),
      context: (turn) => env("turn_context", {
        turn_id: turn,
        cwd: cwdOf("codex"),
        model: "gpt-6.1",
        effort: "high",
        approval_policy: "on-request",
        sandbox_policy: { type: "workspace-write" },
        collaboration_mode: { mode: "default" },
      }),
      started: (turn) => env("event_msg", { type: "task_started", turn_id: turn, started_at: T0 / 1000, model_context_window: 258400, collaboration_mode_kind: "default" }),
      item: (turn, item) => env("event_msg", { type: "item_completed", turn_id: turn, item }),
      tokenCount: (rateLimits) => env("event_msg", {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 1200, cached_input_tokens: 0, output_tokens: 340, reasoning_output_tokens: 100, total_tokens: 1640 },
          last_token_usage: { input_tokens: 1200, cached_input_tokens: 0, output_tokens: 340, reasoning_output_tokens: 100, total_tokens: 1640 },
          model_context_window: 258400,
        },
        rate_limits: rateLimits,
      }),
    };
  }
  {
    const w = rolloutWriter();
    const turn = nid();
    jsonl("codex", "rollout", "rollout-complete-turn", "Codex rollout: a full turn with every item type, a null-primary token_count followed by a good one, and task_complete.", [
      w.meta(),
      w.context(turn),
      w.started(turn),
      w.env("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: m("codex", "text") }] }),
      w.item(turn, { type: "UserMessage", id: nid(), content: [{ type: "text", text: m("codex", "content") }] }),
      w.item(turn, { type: "Reasoning", id: nid(), text: m("codex", "text") }),
      w.env("response_item", { type: "function_call", name: "shell", arguments: JSON.stringify({ command: [m("codex", "command")] }), call_id: nid() }),
      w.item(turn, { type: "CommandExecution", id: nid(), command: m("codex", "command"), cwd: cwdOf("codex"), output: m("codex", "output"), status: "completed", exit_code: 0 }),
      w.env("response_item", { type: "function_call_output", call_id: nid(), output: m("codex", "output") }),
      w.item(turn, { type: "FileChange", id: nid(), path: fileOf("codex"), diff: m("codex", "diff"), status: "completed" }),
      w.item(turn, { type: "McpToolCall", id: nid(), server: "fixture", tool: "search", arguments: { query: m("codex", "query") }, result: { content: [{ type: "text", text: m("codex", "text") }] }, status: "completed" }),
      w.item(turn, { type: "SubAgentActivity", id: nid(), thread_id: nid(), description: m("codex", "description"), status: "completed" }),
      w.item(turn, { type: "AgentMessage", id: nid(), text: m("codex", "text") }),
      w.env("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: m("codex", "text") }] }),
      w.tokenCount({ limit_id: "codex", limit_name: null, primary: null, secondary: null, credits: null, plan_type: null, rate_limit_reached_type: null }),
      w.tokenCount({
        limit_id: "codex",
        limit_name: null,
        primary: { used_percent: 41, window_minutes: 300, resets_at: RESET_5H_S },
        secondary: { used_percent: 12, window_minutes: 10080, resets_at: RESET_7D_S },
        credits: { has_credits: true, unlimited: false, balance: "12.34" },
        plan_type: "plus",
        rate_limit_reached_type: null,
      }),
      w.env("event_msg", { type: "task_complete", turn_id: turn, started_at: T0 / 1000, completed_at: T0 / 1000 + 14, duration_ms: 14000, time_to_first_token_ms: 900, last_agent_message: m("codex", "last_agent_message") }),
    ]);
  }
  {
    const w = rolloutWriter();
    const turn = nid();
    jsonl("codex", "rollout", "rollout-aborted-turn", "Codex rollout: a failed CommandExecution, turn_aborted (interrupted), and an unknown envelope type for drift testing.", [
      w.meta(),
      w.context(turn),
      w.started(turn),
      w.item(turn, { type: "UserMessage", id: nid(), content: [{ type: "text", text: m("codex", "content") }] }),
      w.item(turn, { type: "CommandExecution", id: nid(), command: m("codex", "command"), cwd: cwdOf("codex"), output: m("codex", "output"), status: "failed", exit_code: 1 }),
      w.env("future_envelope_type", { schema: 9, detail: m("codex", "detail"), blob: [m("codex", "text")] }),
      w.env("event_msg", { type: "turn_aborted", reason: "interrupted", turn_id: turn, started_at: T0 / 1000, completed_at: T0 / 1000 + 6, duration_ms: 6000 }),
    ]);
  }

  // ---------------------------------------------------------------- codex/notify
  json("codex", "notify", "notify-agent-turn-complete", "The JSON argument Codex passes to a notify program. Busyholm never installs notify; this documents the fields to drop.", {
    type: "agent-turn-complete",
    "thread-id": nid(),
    "turn-id": nid(),
    cwd: cwdOf("codex"),
    "input-messages": [m("codex", "input_messages")],
    "last-assistant-message": m("codex", "last_assistant_message"),
  });

  // ---------------------------------------------------------------- opencode/plugin
  const ocSid = nid();
  const ocChildSid = nid();
  const oh = (name, about, obj) => json("opencode", "plugin", name, about, obj);
  const ocInfo = (id, extra = {}) => ({
    id,
    projectID: nid(),
    directory: cwdOf("opencode"),
    title: m("opencode", "title"),
    version: "1.18.35",
    time: { created: T0, updated: T0 },
    ...extra,
  });
  oh("session-created", "OpenCode session.created event with a session info object.", { type: "session.created", properties: { info: ocInfo(ocSid) } });
  oh("session-created-subagent", "OpenCode session.created for a subagent session: info.parentID links to the main session id.", { type: "session.created", properties: { info: ocInfo(ocChildSid, { parentID: ocSid }) } });
  oh("session-status-busy", "OpenCode session.status event, status busy.", { type: "session.status", properties: { sessionID: ocSid, status: { type: "busy" } } });
  oh("session-idle", "OpenCode session.idle event.", { type: "session.idle", properties: { sessionID: ocSid } });
  oh("session-error", "OpenCode session.error event with an error message.", { type: "session.error", properties: { sessionID: ocSid, error: { name: "UnknownError", data: { message: m("opencode", "message") } } } });
  oh("session-updated", "OpenCode session.updated event with the session title (info.title and a session_title field).", {
    type: "session.updated",
    properties: { info: ocInfo(ocSid, { title: m("opencode", "title") }), session_title: m("opencode", "session_title") },
  });
  oh("tool-execute-before", "OpenCode tool.execute.before with the tool args.", {
    type: "tool.execute.before",
    input: { tool: "bash", sessionID: ocSid, callID: nid() },
    output: { args: { command: m("opencode", "command"), description: m("opencode", "description") } },
  });
  oh("tool-execute-after", "OpenCode tool.execute.after with args and the tool output.", {
    type: "tool.execute.after",
    input: { tool: "bash", sessionID: ocSid, callID: nid(), args: { command: m("opencode", "command") } },
    output: { title: m("opencode", "title"), output: m("opencode", "output"), metadata: { exit: 0, description: m("opencode", "description") } },
  });
  oh("permission-asked", "OpenCode permission.asked with title, metadata and pattern (payload shape undocumented, guessed from the older Permission type).", {
    type: "permission.asked",
    properties: {
      id: nid(),
      type: "bash",
      pattern: m("opencode", "pattern"),
      sessionID: ocSid,
      messageID: nid(),
      callID: nid(),
      title: m("opencode", "title"),
      metadata: { command: m("opencode", "command") },
      time: { created: T0 },
    },
  });
  oh("permission-replied", "OpenCode permission.replied event.", { type: "permission.replied", properties: { sessionID: ocSid, permissionID: nid(), response: "once" } });
  oh("message-part-updated", "OpenCode message.part.updated with a text part.", {
    type: "message.part.updated",
    properties: { part: { id: nid(), sessionID: ocSid, messageID: nid(), type: "text", text: m("opencode", "text") } },
  });
  oh("file-edited", "OpenCode file.edited event with a file path.", { type: "file.edited", properties: { file: fileOf("opencode") } });

  // ---------------------------------------------------------------- antigravity/log
  {
    const pid = 4242;
    const lines = [];
    const glog = (sec, micro, file, text) => {
      const s = String(sec % 60).padStart(2, "0");
      const mm = String(Math.floor(sec / 60)).padStart(2, "0");
      return `I1012 12:${mm}:${s}.${String(micro).padStart(6, "0")} ${pid} ${file}] ${text}`;
    };
    lines.push(glog(0, 481120, "server.go:41", "language server ready"));
    for (let k = 1; k <= 10; k++) {
      lines.push(glog(k * 3, 123456 + k * 811, "http_helpers.go:88", "URL: https://example.invalid/v1/models:streamGenerate"));
      if (k === 4) lines.push(glog(k * 3 + 1, 250000, "cli.go:310", `submitted prompt ${m("antigravity", "prompt")} for ${cwdOf("antigravity")}`));
    }
    emit("antigravity/log/cli.log", "antigravity", "log", "log", "Antigravity cli.log in glog style: request lines about 3 s apart plus one line that carries a prompt marker.", lines.join("\n") + "\n");
  }

  // ---------------------------------------------------------------- gemini/hooks
  const gemSid = nid();
  const gc = (event, extra = {}) => ({
    session_id: gemSid,
    transcript_path: `/Users/someone/.gemini/tmp/${m("gemini", "transcript_path")}/chats/session.json`,
    cwd: cwdOf("gemini"),
    hook_event_name: event,
    timestamp: iso(5),
    ...extra,
  });
  json("gemini", "hooks", "before-agent", "Gemini CLI BeforeAgent hook body with the prompt.", gc("BeforeAgent", { prompt: m("gemini", "prompt") }));
  json("gemini", "hooks", "after-agent", "Gemini CLI AfterAgent hook body with prompt and prompt_response.", gc("AfterAgent", {
    prompt: m("gemini", "prompt"),
    prompt_response: m("gemini", "prompt_response"),
    stop_hook_active: false,
  }));
  json("gemini", "hooks", "notification", "Gemini CLI Notification hook body with a message.", gc("Notification", {
    notification_type: "ToolPermission",
    message: m("gemini", "message"),
    details: { type: "exec", title: m("gemini", "title") },
  }));
  json("gemini", "hooks", "after-tool", "Gemini CLI AfterTool hook body; tool_output is a synthetic field the research doc lists as possible.", gc("AfterTool", {
    tool_name: "run_shell_command",
    tool_input: { command: m("gemini", "command") },
    tool_response: { llmContent: m("gemini", "tool_response") },
    tool_output: m("gemini", "tool_output"),
  }));

  // ---------------------------------------------------------------- cursor/hooks
  const curConv = nid();
  const cu = (event, extra = {}) => ({
    conversation_id: curConv,
    generation_id: nid(),
    model: "auto",
    hook_event_name: event,
    workspace_roots: [cwdOf("cursor")],
    user_email: m("cursor", "user_email"),
    transcript_path: `/Users/someone/.cursor/projects/${m("cursor", "transcript_path")}/${curConv}.jsonl`,
    ...extra,
  });
  json("cursor", "hooks", "before-submit-prompt", "Cursor beforeSubmitPrompt hook body with prompt and user_email.", cu("beforeSubmitPrompt", { prompt: m("cursor", "prompt"), attachments: [] }));
  json("cursor", "hooks", "after-shell-execution", "Cursor afterShellExecution hook body with command and output.", cu("afterShellExecution", { command: m("cursor", "command"), output: m("cursor", "output"), duration: 1200 }));
  json("cursor", "hooks", "after-agent-response", "Cursor afterAgentResponse hook body with the reply text.", cu("afterAgentResponse", { text: m("cursor", "text") }));
  json("cursor", "hooks", "stop-completed", "Cursor stop hook body, status completed.", cu("stop", { status: "completed", loop_count: 0 }));
  json("cursor", "hooks", "stop-aborted", "Cursor stop hook body, status aborted.", cu("stop", { status: "aborted", loop_count: 0 }));

  // ---------------------------------------------------------------- never-open
  const nv = (relPath, agent, format, about, text) => emit(`never-open/${relPath}`, agent, "never-open", format, about, text);
  nv("claude/.credentials.json", "claude", "json", "Stand-in for Claude's credential file. An adapter must never open it.", JSON.stringify({
    claudeAiOauth: {
      accessToken: m("claude", "accessToken"),
      refreshToken: m("claude", "refreshToken"),
      expiresAt: T0 + 3600000,
      scopes: [m("claude", "scope")],
      subscriptionType: m("claude", "subscriptionType"),
    },
  }, null, 2) + "\n");
  nv("codex/auth.json", "codex", "json", "Stand-in for Codex auth.json. An adapter must never open it.", JSON.stringify({
    OPENAI_API_KEY: m("codex", "api_key"),
    tokens: { id_token: m("codex", "id_token"), access_token: m("codex", "access_token"), refresh_token: m("codex", "refresh_token"), account_id: m("codex", "account_id") },
    last_refresh: iso(0),
  }, null, 2) + "\n");
  nv("antigravity/antigravity-oauth-token", "antigravity", "text", "Stand-in for the Antigravity OAuth token file. An adapter must never open it.",
    `${m("antigravity", "oauth_access")}\n${m("antigravity", "oauth_refresh")}\n`);
  nv("keys/session.key", "claude", "text", "Stand-in for a Claude <pid>.<hash>.key registry sibling. Any *.key file must never be opened.",
    `${m("claude", "key_material")}\n`);
  nv("codex/history.jsonl", "codex", "jsonl", "Stand-in for Codex history.jsonl (prompt history). An adapter must never open it.", [
    { session_id: nid(), ts: T0 / 1000, text: m("codex", "history_text") },
    { session_id: nid(), ts: T0 / 1000 + 60, text: m("codex", "history_text") },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  nv("claude/tool-results/result-1.txt", "claude", "text", "Stand-in for a spilled Claude tool result. Anything under tool-results/ must never be opened.",
    `${m("claude", "tool_result_body")}\n${m("claude", "tool_result_body")}\n`);
  nv("opencode/credential.json", "opencode", "json", "Stand-in for the OpenCode credential table export. An adapter must never open it.", JSON.stringify({
    providers: [{ id: m("opencode", "provider_id"), key: m("opencode", "api_key"), accountEmail: m("opencode", "email") }],
  }, null, 2) + "\n");
  nv("codex/logs_2.sqlite.txt", "codex", "text", "Text stand-in for Codex logs_2.sqlite (tracing log bodies are content). An adapter must never open it.",
    `SQLite format 3 (stand-in)\n${m("codex", "log_body")}\n${m("codex", "log_body")}\n`);

  const count = index.length;
  writeFileSync(join(root, "index.json"), JSON.stringify(index, null, 2) + "\n");
  return count;
}
