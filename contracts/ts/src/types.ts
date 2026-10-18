// Hand-written TypeScript types for the Busyholm JSON contracts in contracts/schemas/*.schema.json.
// Erasable syntax only (no enum, namespace or parameter properties) so Node runs this file by type stripping.
//
// Every type accepts everything its schema accepts. Where a JSON Schema rule cannot be written in TypeScript
// (numeric ranges, string patterns, if/then conditions, array size and uniqueness, property counts), the type
// is looser and the rule is recorded in a doc comment. Exact exceptions: the Moment kind groups, the limit_hit
// agent/tool pairing, the Choices log entry union, and the Settings strip.display union.

// ---------------------------------------------------------------------------
// Scalar aliases (patterned strings and ranged numbers)
// ---------------------------------------------------------------------------

export type Ms = number; // integer ms epoch, 2000-01-01 to 2100-01-01 (UTC)
export type InstanceId = string; // a salted hash (session, turn, request, account or root id): 32 lowercase hex characters
export type Day = string; // local calendar day, YYYY-MM-DD
export type Sha256Hex = string; // 64 lowercase hex characters
export type Pct = number; // percentage, 0 to 100
export type Count = number; // integer counter, 0 or more
export type Amount = number; // resource amount, 0 or more, may be fractional
export type Seed = number; // unsigned 32-bit integer
export type Coord = number; // CSS pixels, 0 to 16384
export type Extent = number; // CSS pixels, above 0 up to 16384
export type Scale = number; // devicePixelRatio, 0.5 to 8
export type Ordinal = number; // integer, 1 to 999, stable per tool within a session
export type Slot = number; // integer, 0 to 255
export type Progress = number; // fraction, 0 to 1
export type Hhmm = string; // local time of day, HH:MM (24 h)
export type DecorationId = string; // lowercase id, ^[a-z][a-z0-9_]{1,31}$
export type OwnerTag = string; // per-install ownership tag, ^[a-z0-9]{16,32}$
export type HookEventName = string; // ^[A-Za-z][A-Za-z0-9_.]{0,63}$
export type SemVer = string; // Busyholm version, e.g. 1.2.3 or 1.2.3-beta.1
export type AbsPath = string; // absolute path: POSIX (/...) or Windows drive (C:\...)
export type JsonPointer = string; // RFC 6901 JSON Pointer
export type InstallEntryId = string; // ^[a-z][a-z0-9_-]{1,47}$
export type Accelerator = string; // global shortcut, e.g. CommandOrControl+Shift+B
export type DisplayName = string; // OS display name, 1 to 128 characters, no control characters
export type ProjectLabel = string; // last folder segment only, 1 to 128 characters, no slashes

// ---------------------------------------------------------------------------
// Enums: each has a const array (schema order) and a type derived from it
// ---------------------------------------------------------------------------

/** Agent tools (AgentEvent, Snapshot, Moment, Ledger, World, Settings). */
export const TOOLS = ["claude", "codex", "opencode", "antigravity", "gemini", "cursor", "aider", "other"] as const;
export type Tool = (typeof TOOLS)[number];

/** Host the agent runs in. */
export const HOSTS = ["cli", "desktop", "vscode", "sdk", "ide", "other"] as const;
export type Host = (typeof HOSTS)[number];

/** Usage providers. Only Claude and Codex report limits in v0.1. */
export const PROVIDERS = ["claude", "codex"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Usage windows that carry a sample. */
export const WINDOWS = ["5h", "weekly"] as const;
export type UsageWindow = (typeof WINDOWS)[number];

/** Limit windows; "unknown" when the source does not say which window was hit. */
export const LIMIT_WINDOWS = ["5h", "weekly", "unknown"] as const;
export type LimitWindow = (typeof LIMIT_WINDOWS)[number];

/** What a tool call was doing, from the tool name only. */
export const ACTIVITIES = ["shell", "edit", "read", "web", "delegate", "other"] as const;
export type Activity = (typeof ACTIVITIES)[number];

/** AgentEvent kinds. */
export const AGENT_EVENT_KINDS = [
  "session_start", "session_end", "turn_start", "tool_end", "needs_permission", "needs_answer",
  "answered", "turn_end", "turn_interrupted", "error", "limit_hit", "usage_sample",
  "process_up", "process_down", "heartbeat",
] as const;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

/** Where an AgentEvent came from. */
export const EVENT_SOURCES = ["hook", "registry", "log", "process", "plugin", "poll"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/** How sure the collector is about an agent's state. */
export const CONFIDENCES = ["exact", "inferred"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/** Closed set of error classes (AgentEvent detail.error_class). */
export const ERROR_CLASSES = [
  "overloaded", "server_error", "network", "auth", "billing", "invalid_request", "model_not_found",
  "max_output_tokens", "unknown",
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** Notification types that produced an event (AgentEvent detail.notification). */
export const NOTIFICATION_TYPES = [
  "permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input",
  "elicitation_response", "elicitation_complete", "idle_prompt",
  "quota_auto_resume_fired", "quota_auto_resume_stale", "quota_auto_resume_disabled", "other",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Why a turn stopped (AgentEvent detail.stop_reason). */
export const STOP_REASONS = ["end_turn", "interrupted", "max_tokens", "refusal", "other"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** Why a session ended (AgentEvent detail.end_reason). */
export const END_REASONS = ["clear", "resume", "logout", "exit", "process_gone", "other"] as const;
export type EndReason = (typeof END_REASONS)[number];

/** Snapshot agent states. */
export const AGENT_STATES = [
  "starting", "working", "needs_you", "your_turn", "error", "limited", "idle", "unknown",
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** Why an agent needs the user: a permission prompt or a question. */
export const NEEDS_YOU_REASONS = ["permission", "question"] as const;
export type NeedsYouReason = (typeof NEEDS_YOU_REASONS)[number];

/** Whether a tool is installed and reachable. */
export const PRESENCES = ["present", "offline"] as const;
export type Presence = (typeof PRESENCES)[number];

/** Hook connection state per tool (Snapshot tools). */
export const HOOK_STATES = ["installed", "missing", "pending_review", "unsupported"] as const;
export type HookState = (typeof HOOK_STATES)[number];

/** Alert coverage per connector (Snapshot tools, SPEC Revision 1 item 2). */
export const COVERAGE_STATES = ["verified", "degraded", "unsupported"] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

/** Why a connector's coverage is not verified. */
export const COVERAGE_REASONS = [
  "hooks_missing", "hooks_pending_review", "round_trip_pending", "round_trip_failed",
  "receiver_unreachable", "bare_session", "no_permission_event", "experimental_adapter",
  "remote_session", "os_unsupported", "other",
] as const;
export type CoverageReason = (typeof COVERAGE_REASONS)[number];

/** Moment kinds. */
export const MOMENT_KINDS = [
  "turn_end", "needs_you", "answered", "error", "recovered", "limit_hit", "limit_reset",
  "weekly_reset", "build_complete", "milestone",
] as const;
export type MomentKind = (typeof MOMENT_KINDS)[number];

/** Structure slots, all 16 (SPEC 4.5). */
export const STRUCTURE_IDS = [
  "campfire", "tent", "bell_post", "noticeboard", "workshop_1", "well", "cottage_1", "garden_plots",
  "crossing", "watermill", "workshop_2", "cottage_2", "bell_tower", "bakery", "market_hall", "founders_stone",
] as const;
export type StructureId = (typeof STRUCTURE_IDS)[number];

/** The 12 progression structures, in SPEC 4.5 table order. */
export const PROGRESSION_STRUCTURE_IDS = [
  "noticeboard", "workshop_1", "well", "cottage_1", "garden_plots", "crossing", "watermill",
  "workshop_2", "cottage_2", "bell_tower", "bakery", "market_hall",
] as const;
export type ProgressionStructureId = (typeof PROGRESSION_STRUCTURE_IDS)[number];

/** Milestone ids (SPEC 4.5). */
export const MILESTONE_IDS = [
  "first_turn", "first_answer", "first_subagent", "two_tools_day", "turns_100", "streak_7", "turns_1000",
] as const;
export type MilestoneId = (typeof MILESTONE_IDS)[number];

/** Build state of a structure. */
export const STRUCTURE_STATUSES = ["planned", "waiting", "building", "complete"] as const;
export type StructureStatus = (typeof STRUCTURE_STATUSES)[number];

/** Structure variants. Which ids may carry which variant is a rule the schema states (see WorldStructure). */
export const STRUCTURE_VARIANTS = [
  "claude", "codex", "opencode", "antigravity", "gemini", "cursor", "aider", "other",
  "guest_house", "footbridge", "jetty",
] as const;
export type StructureVariant = (typeof STRUCTURE_VARIANTS)[number];

/** Settlement size: camp under 6 progression structures, hamlet at 6, village at all 12. */
export const TIERS = ["camp", "hamlet", "village"] as const;
export type Tier = (typeof TIERS)[number];

/** Animal species used for an agent's character. */
export const SPECIES = ["beaver", "otter", "frog", "hare", "mole", "heron", "hedgehog"] as const;
export type Species = (typeof SPECIES)[number];

/** Strip layering behaviour. */
export const LAYER_MODES = ["on_top", "behind_windows", "reserve_space"] as const;
export type LayerMode = (typeof LAYER_MODES)[number];

/** Sky content: usage and clock, or clock only. */
export const SKY_MODES = ["usage_and_clock", "clock_only"] as const;
export type SkyMode = (typeof SKY_MODES)[number];

/** Hemisphere used for the sky and season. */
export const HEMISPHERES = ["north", "south"] as const;
export type Hemisphere = (typeof HEMISPHERES)[number];

/** Reduced-motion setting. */
export const REDUCED_MOTION_MODES = ["follow_os", "always"] as const;
export type ReducedMotionMode = (typeof REDUCED_MOTION_MODES)[number];

/** Kinds of interactive rectangle reported in HitRects (diagnostics only). */
export const RECT_KINDS = ["resident", "building", "bell", "card", "ui", "other"] as const;
export type RectKind = (typeof RECT_KINDS)[number];

/** Surfaces that report hit rectangles. Only the strip is partly click-through in v0.1. */
export const SURFACES = ["strip"] as const;
export type Surface = (typeof SURFACES)[number];

/** Agents the installer can edit (no "other"). */
export const INSTALL_TOOLS = ["claude", "codex", "opencode", "antigravity", "gemini", "cursor", "aider"] as const;
export type InstallTool = (typeof INSTALL_TOOLS)[number];

/** What an installer entry is for. */
export const INSTALL_TARGETS = [
  "claude_hooks", "claude_statusline", "codex_hooks", "opencode_plugin", "shim_binary",
  "gemini_hooks", "cursor_hooks",
] as const;
export type InstallTarget = (typeof INSTALL_TARGETS)[number];

/** How the installer changed a file: a targeted edit, or a file it created. */
export const INSTALL_ACTIONS = ["edit_span", "create_file"] as const;
export type InstallAction = (typeof INSTALL_ACTIONS)[number];

/** Install state: written, or written but waiting for review inside the agent. */
export const INSTALL_STATES = ["installed", "pending_review"] as const;
export type InstallState = (typeof INSTALL_STATES)[number];

/** Choice log entry kinds. */
export const CHOICE_KINDS = ["build_order", "decoration"] as const;
export type ChoiceKind = (typeof CHOICE_KINDS)[number];

// ---------------------------------------------------------------------------
// AgentEvent v1: the collector's internal, normalised event (SPEC 5.3). No free text at all.
// ---------------------------------------------------------------------------

/**
 * One normalised agent event.
 * Conditional rules (documented, not enforced by the type):
 * - usage is present exactly when kind is usage_sample; limit is present exactly when kind is limit_hit.
 * - usage and limit appear only for agent claude or codex, and their provider equals that agent.
 * - detail.activity appears only on tool_end and heartbeat.
 * - detail.error_class appears only on error.
 * - detail.stop_reason appears only on turn_end and turn_interrupted.
 * - detail.end_reason appears only on session_end.
 * - request_id is non-null only on needs_permission, needs_answer, answered and tool_end.
 */
export interface AgentEvent {
  v: 1;
  agent: Tool;
  /** Salted hash of the session id; never the raw id. */
  instance: InstanceId;
  /** Parent session's instance for a subagent, otherwise null. Required, never omitted. */
  parent: InstanceId | null;
  /** The connector (agent data root) that produced the event. */
  root_id: InstanceId;
  /** Salted account hash, or null when the source does not say. Limits are kept per account. */
  account_id: InstanceId | null;
  /** Salted session hash, or null when not known yet. A subagent carries its parent session's id. */
  session_id: InstanceId | null;
  /** Salted turn hash, or null. Used to deduplicate hook and log copies of a turn. */
  turn_id: InstanceId | null;
  /** Salted request hash; non-null only on needs_permission, needs_answer, answered and tool_end. */
  request_id: InstanceId | null;
  host: Host;
  kind: AgentEventKind;
  source: EventSource;
  confidence: Confidence;
  /** Collector clock when the event was observed. */
  t: Ms;
  /** Source time, only when the source states one. Never null. */
  et?: Ms;
  detail?: AgentEventDetail;
  usage?: AgentEventUsage;
  limit?: AgentEventLimit;
  /** Tokens since the previous sample for this instance (integer, 0 to 1000000000). */
  tokens_delta?: number;
}

/** Closed enums only. Omitted entirely when there is nothing to say (the schema requires at least one key). */
export interface AgentEventDetail {
  activity?: Activity;
  error_class?: ErrorClass;
  notification?: NotificationType;
  stop_reason?: StopReason;
  end_reason?: EndReason;
}

/** One usage-window sample. A source without a value for a window yields no sample (never 0%). */
export interface AgentEventUsage {
  provider: Provider;
  window: UsageWindow;
  used_pct: Pct;
  /** Milliseconds, converted at the edge from the source's epoch seconds. */
  resets_at: Ms;
  observed_at: Ms;
}

/** A limit was hit. The window and reset time are often unknown at the source. */
export interface AgentEventLimit {
  provider: Provider;
  window: LimitWindow;
  /** Null when the reset time is unknown. */
  resets_at: Ms | null;
}

// ---------------------------------------------------------------------------
// Snapshot v2: the full live state, coalesced to at most 4 per second (SPEC 5.4).
// Arrays: agents at most 64 (id unique, and tool+ordinal unique); tools at most 16 (tool+root_id
// unique); limits at most 16 (provider+window+account_id+root_id unique).
// ---------------------------------------------------------------------------

export interface Snapshot {
  schema_version: 2;
  t: Ms;
  /** True while demo mode drives the snapshot. Surfaces show the Demo sign and send no OS notifications. */
  demo: boolean;
  agents: SnapshotAgent[];
  tools: ToolStatus[];
  /** One entry per provider, window and account (per root when the account is unknown). Never infer 0%. */
  limits: SnapshotLimit[];
  attention: Attention;
}

/**
 * One agent in the snapshot.
 * Conditional rules (documented, not enforced by the type):
 * - reason is present exactly when state is needs_you.
 * - activity is present only when state is working.
 * - limited_until is present only when state is limited (omitted when the reset time is unknown).
 * - request_id is non-null only when state is needs_you.
 * - confidence is inferred for a needs_you restored from the pending-alert record after a restart.
 */
export interface SnapshotAgent {
  /** Equal to the AgentEvent instance. Opaque to consumers. */
  id: InstanceId;
  tool: Tool;
  host: Host;
  ordinal: Ordinal;
  /** Parent agent id for a subagent helper, otherwise null. */
  parent: InstanceId | null;
  root_id: InstanceId;
  account_id: InstanceId | null;
  session_id: InstanceId | null;
  turn_id: InstanceId | null;
  /** The pending request when state is needs_you (may still be null), otherwise null. */
  request_id: InstanceId | null;
  state: AgentState;
  reason?: NeedsYouReason;
  activity?: Activity;
  confidence: Confidence;
  /** When the current state began. */
  since: Ms;
  /** When the session began. */
  started_at: Ms;
  limited_until?: Ms;
  /** Only when the user opted in to project names: the last folder segment, never a path. Never written to the ledger. */
  project_label?: ProjectLabel;
}

/** One connector: a tool seen through one agent data root. coverage_reason is null exactly when coverage is verified. */
export interface ToolStatus {
  tool: Tool;
  root_id: InstanceId;
  presence: Presence;
  /** pending_review: installed but not yet trusted inside the agent (Codex /hooks). */
  hooks: HookState;
  coverage: CoverageState;
  coverage_reason: CoverageReason | null;
}

/** Last good usage sample for a provider and window. */
export interface SnapshotLimit {
  provider: Provider;
  window: UsageWindow;
  /** Null when the source does not identify the account; then the entry is per root. */
  account_id: InstanceId | null;
  /** The connector the newest sample came through. */
  root_id: InstanceId;
  used_pct: Pct;
  resets_at: Ms;
  observed_at: Ms;
  /** True when no fresh sample arrived for 30 minutes; the values are the last good ones. */
  stale: boolean;
}

/** Attention summary. oldest_since is null exactly when needs_you is 0. */
export interface Attention {
  /** Number of agents in state needs_you (0 to 64). */
  needs_you: number;
  /** The since value of the longest-waiting needs_you agent, or null. */
  oldest_since: Ms | null;
}

// ---------------------------------------------------------------------------
// Moment v1: a one-off happening, sent immediately to every window (SPEC 5.4).
// One interface per kind group; Moment is their union. The kind field is the discriminant.
// ---------------------------------------------------------------------------

/** turn_end: an agent finished a turn. turn_ms is optional and drives the long-turn notification. */
export interface MomentTurnEnd {
  schema_version: 1;
  kind: "turn_end";
  t: Ms;
  /** Snapshot agent id. Always paired with tool. */
  agent: InstanceId;
  tool: Tool;
  /** How long the turn ran, in ms (0 to 604800000). */
  turn_ms?: number;
}

/** needs_you: an agent needs the user. reason is required. */
export interface MomentNeedsYou {
  schema_version: 1;
  kind: "needs_you";
  t: Ms;
  agent: InstanceId;
  tool: Tool;
  reason: NeedsYouReason;
  /** The request this alert is keyed by, when known. */
  request_id?: InstanceId;
}

/** answered: the agent got its answer. request_id names the request when known. */
export interface MomentAnswered {
  schema_version: 1;
  kind: "answered";
  t: Ms;
  agent: InstanceId;
  tool: Tool;
  request_id?: InstanceId;
}

/** error, recovered: agent moments with no extra fields. */
export interface MomentAgentNotice {
  schema_version: 1;
  kind: "error" | "recovered";
  t: Ms;
  agent: InstanceId;
  tool: Tool;
}

/**
 * limit_hit: provider is required. agent and tool are optional, but only as a pair (both or neither),
 * so this is a union of the two cases.
 */
export type MomentLimitHit = {
  schema_version: 1;
  kind: "limit_hit";
  t: Ms;
  provider: Provider;
} & ({ agent: InstanceId; tool: Tool } | { agent?: never; tool?: never });

/** limit_reset and weekly_reset: provider is required, and there is no agent. */
export interface MomentLimitReset {
  schema_version: 1;
  kind: "limit_reset" | "weekly_reset";
  t: Ms;
  provider: Provider;
  agent?: never;
  tool?: never;
}

/** build_complete: a structure stage was just completed (3 means the structure is finished). */
export interface MomentBuildComplete {
  schema_version: 1;
  kind: "build_complete";
  t: Ms;
  structure: StructureId;
  stage: 1 | 2 | 3;
  agent?: never;
  tool?: never;
}

/** milestone: a milestone was reached. */
export interface MomentMilestone {
  schema_version: 1;
  kind: "milestone";
  t: Ms;
  milestone: MilestoneId;
  agent?: never;
  tool?: never;
}

export type Moment =
  | MomentTurnEnd
  | MomentNeedsYou
  | MomentAnswered
  | MomentAgentNotice
  | MomentLimitHit
  | MomentLimitReset
  | MomentBuildComplete
  | MomentMilestone;

// ---------------------------------------------------------------------------
// Ledger v1: counts only (SPEC 6.8). Never holds a project name, path, id or any text.
// ---------------------------------------------------------------------------

export interface Ledger {
  schema_version: 1;
  privacy: LedgerPrivacy;
  /** World seed. */
  seed: Seed;
  /** Local day of first launch. */
  founded_day: Day;
  /** Local day the first agent's hooks were connected; null until it happens. */
  hooks_first_connected_day: Day | null;
  /** Keyed by local day. A day appears only once something was counted on it. */
  days: Record<Day, DayTools>;
  /**
   * Optional. Per local day, the wall-clock seconds with at least one main session of ANY tool working (the union
   * across tools). When absent the ledger is exactly the older v1 shape. Never null; leave it out instead.
   */
  day_totals?: LedgerDayTotals;
  /** The opt-in history import, kept apart from live days. Null when never imported. */
  backfill: LedgerBackfill | null;
}

export interface LedgerPrivacy {
  containsText: false;
}

/** The history import. days holds at most 31 entries. */
export interface LedgerBackfill {
  imported_at: Ms;
  days: Record<Day, DayTools>;
}

/** Keyed by local day (same rule as the days keys). */
export type LedgerDayTotals = Record<Day, DayTotals>;

/** The day-level union across tools. The object is closed: working_seconds is the only property. */
export interface DayTotals {
  /** Wall-clock seconds with at least one main session of any tool working (0 to 90000). */
  working_seconds: number;
}

/** Counters per tool for one day. At least one tool per listed day (the schema requires it). */
export type DayTools = Partial<Record<Tool, Counts>>;

/** Raw counters for one tool on one day. Every field is required. */
export interface Counts {
  /** Completed main-session turns. */
  turns: Count;
  interrupted_turns: Count;
  /** Main sessions started. */
  sessions: Count;
  /** Wall-clock seconds with at least one main session working (0 to 90000); concurrent sessions are not summed. */
  working_seconds: number;
  /** needs_you episodes. Informational only: nothing may reward or gate on answering. */
  needs_you: Count;
  errors: Count;
  /** Turns started after an error. */
  recovered: Count;
  limit_hits: Count;
  subagent_turns: Count;
}

// ---------------------------------------------------------------------------
// Choices v1: the user's timestamped build-order and decoration choices (SPEC 6.8).
// An append-only log, oldest first, at most 10000 entries.
// ---------------------------------------------------------------------------

export interface Choices {
  schema_version: 1;
  privacy: ChoicesPrivacy;
  log: ChoiceEntry[];
}

export interface ChoicesPrivacy {
  containsText: false;
}

/** A build-order choice: the user's priority order (1 to 12 distinct structures). */
export interface ChoiceBuildOrder {
  /** Milliseconds since the epoch. */
  t: Ms;
  /** Local day when the choice was made. */
  day: Day;
  kind: "build_order";
  order: ProgressionStructureId[];
}

/** A decoration choice: on places it (buying it if not yet owned), false puts it away. */
export interface ChoiceDecoration {
  t: Ms;
  day: Day;
  kind: "decoration";
  decoration: DecorationId;
  on: boolean;
}

export type ChoiceEntry = ChoiceBuildOrder | ChoiceDecoration;

// ---------------------------------------------------------------------------
// World v1: the output of world = grow(seed, ledger, choices) (SPEC 4.5). Never saved.
// Arrays: structures at most 16 (id unique); decorations at most 64 (id and slot unique);
// milestones at most 7 (id unique); tools_seen at most 8 (unique).
// ---------------------------------------------------------------------------

export interface World {
  schema_version: 1;
  seed: Seed;
  /** The last local day the ledger and choices were folded through. */
  as_of_day: Day;
  tier: Tier;
  /** Balances available to spend now. */
  resources: WorldResources;
  /** Lifetime totals earned, including the founding crate and the capped backfill. */
  earned: WorldResources;
  /** In the effective build order. Structures not yet started are listed with status planned. */
  structures: WorldStructure[];
  /** Owned decorations, each with its seeded slot. shown false means put away. */
  decorations: WorldDecoration[];
  milestones: WorldMilestone[];
  stats: WorldStats;
  /** Engraved historical counts from the backfill; null when there was no backfill. */
  founders_stone: FoundersStone | null;
  /** True when the Steam demo cap stopped building; counts keep accruing in the ledger. */
  demo_capped: boolean;
}

export interface WorldResources {
  planks: Amount;
  stone: Amount;
  seeds: Amount;
}

/**
 * One structure slot.
 * Conditional rules (documented, not enforced by the type):
 * - status complete: completed_day is present, stage is 3 and progress is 1.
 * - status not complete: completed_day is absent, stage is 0 to 2 and progress is below 1.
 * - status waiting: waiting_for is present. Otherwise it is absent.
 * - variant: workshop_1 takes a tool; workshop_2 takes a tool or guest_house; crossing takes
 *   footbridge or jetty. No other id has a variant. Omitted while undecided.
 */
export interface WorldStructure {
  id: StructureId;
  variant?: StructureVariant;
  status: StructureStatus;
  /** Visible build stage, integer 0 to 3. */
  stage: number;
  /** Fraction of the cost delivered, 0 to 1. */
  progress: Progress;
  waiting_for?: WorldWaitingFor;
  completed_day?: Day;
}

/** Held by an extra condition: a number of active days (quick answers never gate anything). */
export interface WorldWaitingFor {
  /** Active days still needed (integer 1 to 3650). */
  active_days: Count;
}

export interface WorldDecoration {
  id: DecorationId;
  /** Seeded decoration slot within the decoration zones. */
  slot: Slot;
  shown: boolean;
}

export interface WorldMilestone {
  id: MilestoneId;
  day: Day;
}

export interface WorldStats {
  lifetime_turns: Count;
  active_days: Count;
  /** Current streak as of as_of_day (up to 2 rest days per calendar week do not break it). */
  streak_days: Count;
  tools_seen: Tool[];
}

/** Engraved historical counts from the backfill. */
export interface FoundersStone {
  /** Integer, 1 to 31. */
  days: number;
  turns: Count;
  sessions: Count;
  /** Hours, 0 to 1000000. */
  working_hours: number;
}

// ---------------------------------------------------------------------------
// HitRects v1: sent by the strip webview to the core when interactive objects move (SPEC 6.2, 6.3).
// Each message replaces the previous set entirely. An empty rects list makes the strip fully click-through.
// ---------------------------------------------------------------------------

export interface HitRects {
  schema_version: 1;
  t: Ms;
  surface: Surface;
  /** The webview's content size in logical (CSS) pixels when the rects were measured. */
  viewport: HitRectsViewport;
  /** devicePixelRatio, so the core can detect a scale mismatch with its window. */
  scale: Scale;
  /** At most 64. Each rect stays inside the viewport. */
  rects: HitRect[];
}

export interface HitRectsViewport {
  w: Extent;
  h: Extent;
}

/** A rectangle in logical (CSS) pixels, origin at the top-left of the webview content area. */
export interface HitRect {
  x: Coord;
  y: Coord;
  w: Extent;
  h: Extent;
  /** Diagnostic only. */
  kind?: RectKind;
  /** Snapshot agent id, when the rect is a resident or its card. */
  agent?: InstanceId;
}

// ---------------------------------------------------------------------------
// Settings v1: settings.json in the app data folder (SPEC 6.9). Every group is required.
// ---------------------------------------------------------------------------

export interface Settings {
  schema_version: 1;
  strip: SettingsStrip;
  sky: SettingsSky;
  sound: SettingsSound;
  notifications: SettingsNotifications;
  ambient: SettingsAmbient;
  agents: SettingsAgents;
  privacy: SettingsPrivacy;
  other: SettingsOther;
  updates: SettingsUpdates;
}

export interface SettingsStrip {
  /** Default true. */
  enabled: boolean;
  display: StripDisplay;
  /** Logical pixels, integer 72 to 160. Default 112. */
  height: number;
  /** Default on_top. */
  layer_mode: LayerMode;
  /** Default true. */
  hover_fade: boolean;
  /** Default false. */
  show_over_fullscreen: boolean;
}

/** auto: the display with the Dock or taskbar, else the primary (default). named: a display by its OS name. */
export type StripDisplay = { mode: "auto" } | { mode: "named"; name: DisplayName };

export interface SettingsSky {
  /** Default usage_and_clock. */
  mode: SkyMode;
  /** Default north. */
  hemisphere: Hemisphere;
}

export interface SettingsSound {
  /** Default true. */
  bell: boolean;
  /** 0 to 1. */
  volume: number;
  /** Null means off (default). The range may cross midnight. */
  quiet_hours: QuietHours | null;
}

export interface QuietHours {
  /** Local time, HH:MM. */
  start: Hhmm;
  /** Local time, HH:MM. */
  end: Hhmm;
}

/** All default true. Durations are fixed by SPEC 6.9: re-notify after 5 minutes, long turn means over 2 minutes. */
export interface SettingsNotifications {
  needs_you: boolean;
  renotify: boolean;
  long_turn: boolean;
  errors: boolean;
}

export interface SettingsAmbient {
  /** Minutes without input before ambient mode starts (integer 5 to 60). Null means off. Default 15. */
  idle_minutes: number | null;
  /** Global shortcut accelerator. Null means none. */
  shortcut: Accelerator | null;
}

export interface SettingsAgents {
  /** Species overrides per tool. A tool not listed uses the SPEC 4.2 default. */
  species: Partial<Record<Tool, Species>>;
}

export interface SettingsPrivacy {
  /** Default false. */
  project_names: boolean;
  /** Default false. */
  history_backfill: boolean;
}

export interface SettingsOther {
  launch_at_login: boolean;
  /** Default follow_os. */
  reduced_motion: ReducedMotionMode;
}

export interface SettingsUpdates {
  /** Direct-download builds only (SPEC 6.10). Default false. Steam builds ignore it. */
  check: boolean;
}

// ---------------------------------------------------------------------------
// InstallManifest v1: install-manifest.json in the app data folder (SPEC 6.8, WP-07).
// Local only and never exported: it holds absolute paths of agent config files.
// Arrays: entries at most 64 (id unique, and target+path unique).
// ---------------------------------------------------------------------------

export interface InstallManifest {
  schema_version: 1;
  /** Busyholm version that last wrote the manifest. */
  app_version: SemVer;
  /** Per-install tag written into every owned hook entry; null only while entries is empty. */
  owner_tag: OwnerTag | null;
  entries: InstallEntry[];
}

/**
 * One file the installer created or edited.
 * Conditional rules (documented, not enforced by the type):
 * - owned is present exactly for config files (every target except opencode_plugin and shim_binary).
 * - action edit_span means before.existed is true; create_file means it is false.
 * - before.existed true means before.sha256 and before.bytes are set; false means both are null.
 * - tool is null exactly for shim_binary; it is claude for claude_hooks and claude_statusline,
 *   codex for codex_hooks, opencode for opencode_plugin, gemini for gemini_hooks, cursor for cursor_hooks.
 * - state pending_review occurs only for codex_hooks.
 */
export interface InstallEntry {
  id: InstallEntryId;
  /** The agent this entry serves. Null exactly for shim_binary. */
  tool: InstallTool | null;
  target: InstallTarget;
  path: AbsPath;
  action: InstallAction;
  state: InstallState;
  installed_at: Ms;
  /** The file before the install. */
  before: InstallBefore;
  /** The file right after the install. */
  after: InstallAfter;
  /** The entries Busyholm owns inside a config file (1 to 64). Disconnect removes exactly these. */
  owned?: InstallOwned[];
}

export interface InstallBefore {
  existed: boolean;
  sha256: Sha256Hex | null;
  bytes: number | null;
}

export interface InstallAfter {
  sha256: Sha256Hex;
  bytes: number;
}

export interface InstallOwned {
  /** The hook event the entry is for; null for a non-hook value such as statusLine. */
  event: HookEventName | null;
  /** RFC 6901 JSON Pointer to the entry as of install time (a hint). */
  pointer: JsonPointer;
  /** Hash of the inserted value's exact text. */
  sha256: Sha256Hex;
  /** Hash of the value this entry replaced (statusLine wrap), kept in backups/install; otherwise null. */
  replaced_sha256: Sha256Hex | null;
}

// ---------------------------------------------------------------------------
// PendingAlerts v1: pending-alerts.json, so a needs_you alert survives a restart (SPEC Revision 1).
// alerts at most 64, agent unique.
// ---------------------------------------------------------------------------

export interface PendingAlerts {
  schema_version: 1;
  privacy: { containsText: false };
  saved_at: Ms;
  alerts: PendingAlert[];
}

export interface PendingAlert {
  /** Snapshot agent id. */
  agent: InstanceId;
  tool: Tool;
  host: Host;
  root_id: InstanceId;
  account_id: InstanceId | null;
  session_id: InstanceId | null;
  /** The request the alert is keyed by, or null (then the agent is the key). */
  request_id: InstanceId | null;
  reason: NeedsYouReason;
  /** When the agent started waiting. */
  since: Ms;
  /** The last time a fresh signal confirmed the wait. */
  last_confirmed_at: Ms;
}

// ---------------------------------------------------------------------------
// Contract registry
// ---------------------------------------------------------------------------

/** Contract key to the schema file it is defined by. */
export const CONTRACTS = {
  agentEvent: "agent-event.v1.schema.json",
  snapshot: "snapshot.v2.schema.json",
  moment: "moment.v1.schema.json",
  ledger: "ledger.v1.schema.json",
  choices: "choices.v1.schema.json",
  world: "world.v1.schema.json",
  hitRects: "hit-rects.v1.schema.json",
  settings: "settings.v1.schema.json",
  installManifest: "install-manifest.v1.schema.json",
  pendingAlerts: "pending-alerts.v1.schema.json",
} as const;

export type ContractKey = keyof typeof CONTRACTS;

/** The top-level type for each contract key. */
export interface ContractTypes {
  agentEvent: AgentEvent;
  snapshot: Snapshot;
  moment: Moment;
  ledger: Ledger;
  choices: Choices;
  world: World;
  hitRects: HitRects;
  settings: Settings;
  installManifest: InstallManifest;
  pendingAlerts: PendingAlerts;
}
