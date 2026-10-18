// Moment v1 fixtures (contracts/schemas/moment.v1.schema.json).
import { T0, MS_MIN, MS_MAX, hid, edit, fx, DELETE } from "../lib.mjs";

const AGENT = hid("moment-agent-a");
const OTHER = hid("moment-agent-b");
const RAW_UUID = "6f1c0a2e-1b2c-4d3e-8f9a-0b1c2d3e4f5a";
const REQ = hid("moment-request-a");

const slug = (s) => String(s).replace(/[_.]/g, "-");

const TOOLS = ["claude", "codex", "opencode", "antigravity", "gemini", "cursor", "aider", "other"];
const STRUCTURES = [
  "campfire", "tent", "bell_post", "noticeboard", "workshop_1", "well", "cottage_1", "garden_plots",
  "crossing", "watermill", "workshop_2", "cottage_2", "bell_tower", "bakery", "market_hall", "founders_stone",
];
const MILESTONES = ["first_turn", "first_answer", "first_subagent", "two_tools_day", "turns_100", "streak_7", "turns_1000"];

/** A Moment with only the fields its kind requires (agent and tool travel together). */
const KIND_SHAPE = {
  turn_end: { agent: AGENT, tool: "claude" },
  needs_you: { agent: AGENT, tool: "codex", reason: "question" },
  answered: { agent: AGENT, tool: "claude" },
  error: { agent: AGENT, tool: "gemini" },
  recovered: { agent: AGENT, tool: "claude" },
  limit_hit: { provider: "claude" },
  limit_reset: { provider: "codex" },
  weekly_reset: { provider: "claude" },
};

const turnOf = (over = {}) => ({ schema_version: 1, kind: "turn_end", t: T0, agent: AGENT, tool: "claude", ...over });

export function valid() {
  return [
    ...Object.keys(KIND_SHAPE).map((k) =>
      fx(`kind-${slug(k)}`, `A ${slug(k)} moment with only the fields that kind requires.`, { schema_version: 1, kind: k, t: T0, ...KIND_SHAPE[k] }),
    ),
    fx("turn-end-with-turn-ms", "turn_end carries turn_ms so the long-turn notification can fire.", turnOf({ turn_ms: 180000 })),
    fx("turn-ms-zero", "turn_ms at the 0 minimum.", turnOf({ turn_ms: 0 })),
    fx("turn-ms-week-max", "turn_ms at the 604800000 maximum (one week).", turnOf({ turn_ms: 604800000 })),
    fx("turn-ms-just-over-two-minutes", "turn_ms just past the two minute long-turn threshold.", turnOf({ turn_ms: 120001 })),
    fx("needs-you-permission", "needs_you with reason permission from claude.", { schema_version: 1, kind: "needs_you", t: T0, agent: AGENT, tool: "claude", reason: "permission" }),
    ...TOOLS.map((t) =>
      fx(`tool-${t}-turn-end`, `A turn_end from the ${t} tool with its own agent id.`, turnOf({ tool: t, agent: hid(`moment-tool-${t}`) })),
    ),
    fx("limit-hit-codex", "limit_hit for provider codex with no agent or tool.", { schema_version: 1, kind: "limit_hit", t: T0, provider: "codex" }),
    fx("limit-hit-with-agent", "limit_hit may name its agent and tool when the source knows them.", { schema_version: 1, kind: "limit_hit", t: T0, provider: "codex", agent: OTHER, tool: "codex" }),
    fx("limit-reset-claude", "limit_reset for provider claude.", { schema_version: 1, kind: "limit_reset", t: T0, provider: "claude" }),
    fx("weekly-reset-codex", "weekly_reset for provider codex.", { schema_version: 1, kind: "weekly_reset", t: T0, provider: "codex" }),
    ...STRUCTURES.map((s, i) =>
      fx(`structure-${slug(s)}`, `build_complete for ${slug(s)} at stage ${(i % 3) + 1}.`, { schema_version: 1, kind: "build_complete", t: T0, structure: s, stage: (i % 3) + 1 }),
    ),
    ...MILESTONES.map((m) =>
      fx(`milestone-${slug(m)}`, `The ${slug(m)} milestone as an island moment with no agent.`, { schema_version: 1, kind: "milestone", t: T0, milestone: m }),
    ),
    fx("turn-end-at-min-time", "turn_end at the minimum legal timestamp.", turnOf({ t: MS_MIN })),
    fx("turn-end-at-max-time", "turn_end at the maximum legal timestamp.", turnOf({ t: MS_MAX })),
    fx("build-complete-finished-stage-three", "build_complete at stage 3, meaning the structure is finished.", { schema_version: 1, kind: "build_complete", t: T0, structure: "founders_stone", stage: 3 }),
    fx("milestone-at-min-time", "A milestone at the minimum legal timestamp.", { schema_version: 1, kind: "milestone", t: MS_MIN, milestone: "first_turn" }),
    fx("needs-you-with-request", "needs_you keyed by its request id, so it notifies once per request.", { schema_version: 1, kind: "needs_you", t: T0, agent: AGENT, tool: "claude", reason: "permission", request_id: REQ }),
    fx("question-with-request", "A question alert keyed by its request id.", { schema_version: 1, kind: "needs_you", t: T0 + 1, agent: OTHER, tool: "codex", reason: "question", request_id: REQ }),
    fx("answered-with-request", "answered names the request it closes, so its notification is withdrawn.", { schema_version: 1, kind: "answered", t: T0 + 2, agent: AGENT, tool: "claude", request_id: REQ }),
  ];
}

export function invalid() {
  const turn = turnOf();
  const needs = { schema_version: 1, kind: "needs_you", t: T0, agent: AGENT, tool: "codex", reason: "permission" };
  const limit = { schema_version: 1, kind: "limit_hit", t: T0, provider: "claude" };
  const build = { schema_version: 1, kind: "build_complete", t: T0, structure: "well", stage: 2 };
  const mile = { schema_version: 1, kind: "milestone", t: T0, milestone: "first_turn" };

  return [
    fx("root-array", "The root must be an object, not an array.", [turn], ""),
    fx("root-null", "The root must be an object, not null.", null, ""),
    fx("root-string", "The root must be an object, not a string.", "turn_end", ""),
    fx("missing-schema-version", "schema_version is required.", edit(turn, { schema_version: DELETE }), ""),
    fx("missing-kind", "kind is required.", edit(turn, { kind: DELETE }), ""),
    fx("missing-t", "t is required.", edit(turn, { t: DELETE }), ""),
    fx("schema-version-two", "schema_version must be the constant 1.", edit(turn, { schema_version: 2 }), "/schema_version"),
    fx("schema-version-string", "schema_version must be the integer 1, not a string.", edit(turn, { schema_version: "1" }), "/schema_version"),
    fx("kind-finished", "finished is not a moment kind (it is a state transition elsewhere).", edit(turn, { kind: "finished" }), "/kind"),
    fx("kind-hyphenated", "Kinds use underscores, so turn-end is unknown.", edit(turn, { kind: "turn-end" }), "/kind"),
    fx("t-in-seconds", "t in seconds is below the millisecond range.", edit(turn, { t: T0 / 1000 }), "/t"),
    fx("t-below-min", "t is one millisecond before 2000-01-01.", edit(turn, { t: MS_MIN - 1 }), "/t"),
    fx("t-above-max", "t is one millisecond after 2100-01-01.", edit(turn, { t: MS_MAX + 1 }), "/t"),
    fx("unknown-text-field", "Moments carry no free text, so an unknown text field is rejected.", edit(turn, { text: "You have a notification" }), ""),
    fx("leaked-prompt", "A raw prompt field is an unknown property and is rejected.", edit(turn, { prompt: "fix the failing test" }), ""),
    fx("turn-end-missing-agent-and-tool", "turn_end must name its agent and tool.", edit(turn, { agent: DELETE, tool: DELETE }), ""),
    fx("limit-hit-tool-without-agent", "tool without agent is rejected by dependentRequired.", edit(limit, { tool: "claude" }), ""),
    fx("limit-hit-agent-without-tool", "agent without tool is rejected by dependentRequired.", edit(limit, { agent: AGENT }), ""),
    fx("agent-raw-uuid", "agent is a salted id, never a raw session UUID.", edit(turn, { agent: RAW_UUID }), "/agent"),
    fx("agent-uppercase-hex", "agent hex must be lowercase.", edit(turn, { agent: AGENT.toUpperCase() }), "/agent"),
    fx("agent-null", "agent is present as a string or absent, never null.", edit(turn, { agent: null }), "/agent"),
    fx("tool-unknown", "tool must be one of the known tools.", edit(turn, { tool: "gemini-cli" }), "/tool"),
    fx("tool-null", "tool is present as a string or absent, never null.", edit(turn, { tool: null }), "/tool"),
    fx("agent-on-milestone", "Island moments are not tied to an agent.", edit(mile, { agent: AGENT, tool: "claude" }), ""),
    fx("agent-on-build-complete", "build_complete is an island moment and names no agent.", edit(build, { agent: AGENT, tool: "claude" }), ""),
    fx("agent-on-limit-reset", "limit_reset is an island moment and names no agent.", { schema_version: 1, kind: "limit_reset", t: T0, provider: "claude", agent: AGENT, tool: "claude" }, ""),
    fx("agent-on-weekly-reset", "weekly_reset is an island moment and names no agent.", { schema_version: 1, kind: "weekly_reset", t: T0, provider: "codex", agent: OTHER, tool: "codex" }, ""),
    fx("needs-you-missing-reason", "needs_you requires a reason.", edit(needs, { reason: DELETE }), ""),
    fx("reason-unknown", "reason is permission or question.", edit(needs, { reason: "approval" }), "/reason"),
    fx("reason-null", "reason is omitted when it does not apply, never null.", edit(needs, { reason: null }), "/reason"),
    fx("reason-on-turn-end", "reason is only allowed on needs_you.", edit(turn, { reason: "question" }), ""),
    fx("turn-ms-on-needs-you", "turn_ms is only allowed on turn_end.", edit(needs, { turn_ms: 180000 }), ""),
    fx("turn-ms-negative", "turn_ms is at least 0.", edit(turn, { turn_ms: -1 }), "/turn_ms"),
    fx("turn-ms-over-week", "turn_ms is at most 604800000.", edit(turn, { turn_ms: 604800001 }), "/turn_ms"),
    fx("turn-ms-fraction", "turn_ms must be an integer, not 1.5.", edit(turn, { turn_ms: 1.5 }), "/turn_ms"),
    fx("turn-ms-null", "turn_ms is omitted when unknown, never null.", edit(turn, { turn_ms: null }), "/turn_ms"),
    fx("provider-missing-limit-hit", "limit_hit requires a provider.", edit(limit, { provider: DELETE }), ""),
    fx("provider-missing-weekly-reset", "weekly_reset requires a provider.", { schema_version: 1, kind: "weekly_reset", t: T0 }, ""),
    fx("provider-on-turn-end", "provider is only allowed on the limit kinds.", edit(turn, { provider: "claude" }), ""),
    fx("provider-unknown-limit-reset", "provider must be claude or codex.", { schema_version: 1, kind: "limit_reset", t: T0, provider: "gemini" }, "/provider"),
    fx("provider-null-limit-hit", "provider is required and cannot be null.", edit(limit, { provider: null }), "/provider"),
    fx("build-complete-missing-structure", "build_complete requires a structure.", edit(build, { structure: DELETE }), ""),
    fx("build-complete-missing-stage", "build_complete requires a stage.", edit(build, { stage: DELETE }), ""),
    fx("structure-unknown", "structure must be a known structure slot.", edit(build, { structure: "barn" }), "/structure"),
    fx("structure-null", "structure cannot be null on build_complete.", edit(build, { structure: null }), "/structure"),
    fx("structure-on-milestone", "structure is only allowed on build_complete.", edit(mile, { structure: "well" }), ""),
    fx("structure-on-turn-end", "structure is only allowed on build_complete.", edit(turn, { structure: "well" }), ""),
    fx("stage-zero", "stage is at least 1.", edit(build, { stage: 0 }), "/stage"),
    fx("stage-four", "stage is at most 3.", edit(build, { stage: 4 }), "/stage"),
    fx("stage-null", "stage cannot be null on build_complete.", edit(build, { stage: null }), "/stage"),
    fx("stage-string", "stage must be an integer, not a string.", edit(build, { stage: "2" }), "/stage"),
    fx("stage-on-turn-end", "stage is only allowed on build_complete.", edit(turn, { stage: 2 }), ""),
    fx("milestone-missing", "milestone kind requires a milestone id.", edit(mile, { milestone: DELETE }), ""),
    fx("milestone-unknown", "milestone must be one of the seven milestone ids.", edit(mile, { milestone: "turns_500" }), "/milestone"),
    fx("milestone-null", "milestone cannot be null on the milestone kind.", edit(mile, { milestone: null }), "/milestone"),
    fx("milestone-on-turn-end", "milestone is only allowed on the milestone kind.", edit(turn, { milestone: "first_turn" }), ""),
    fx("request-on-turn-end", "request_id is only allowed on needs_you and answered.", edit(turn, { request_id: REQ }), ""),
    fx("request-on-error", "request_id is only allowed on needs_you and answered.", { schema_version: 1, kind: "error", t: T0, agent: AGENT, tool: "claude", request_id: REQ }, ""),
    fx("request-on-limit-hit", "request_id is only allowed on needs_you and answered.", edit(limit, { request_id: REQ }), ""),
    fx("request-null", "request_id is omitted when unknown, never null.", edit(needs, { request_id: null }), "/request_id"),
    fx("request-raw-uuid", "request_id is a salted hash, never a raw id.", edit(needs, { request_id: RAW_UUID }), "/request_id"),
  ];
}
