// Usage profiles for the pacing simulation (SPEC 4.5 table, WP-08 test 2, Revision 1 item 6).
// Each profile turns into a synthetic Ledger v1: counts only, the same shape the collector writes.
// The per-day numbers are calibrated in calibration.md; the weekly patterns are ASSUMPTIONS stated there.
import type { Counts, DayTools, Ledger, Tool } from "@busyholm/contracts";
import { dayNumber, dayString } from "../src/days.ts";
import { mixSeed, mulberry32 } from "../src/rng.ts";

export interface ToolDay {
  readonly tool: Tool;
  readonly turns: number;
  /** Wall-clock minutes with at least one main session of this tool working (Ledger v1 r1: not summed across sessions). */
  readonly workingMinutes: number;
  readonly sessions: number;
  /** Permission or question prompts. Information only: they earn nothing and gate nothing. */
  readonly needsYou: number;
  readonly subagentTurns: number;
}

export interface Profile {
  readonly name: string;
  readonly summary: string;
  /** Active days by position in the week counted from the founding day (0 = founding day's weekday). */
  readonly activeWeekdays: readonly number[];
  /** What one active day looks like; `weekly` overrides apply on the given week positions. */
  readonly day: readonly ToolDay[];
  readonly weekly?: Readonly<Record<number, readonly ToolDay[]>>;
}

const claude = (turns: number, workingMinutes: number, sessions: number, needsYou: number, subagentTurns = 0): ToolDay => ({
  tool: "claude", turns, workingMinutes, sessions, needsYou, subagentTurns,
});
const codex = (turns: number, workingMinutes: number, sessions: number, needsYou: number, subagentTurns = 0): ToolDay => ({
  tool: "codex", turns, workingMinutes, sessions, needsYou, subagentTurns,
});

export const PROFILES: Readonly<Record<string, Profile>> = {
  light: {
    name: "light",
    summary: "6 turns and 1 h of agent work a day, 4 days a week, one tool (calibration p25 day)",
    activeWeekdays: [0, 1, 3, 5],
    day: [claude(6, 60, 1, 2)],
  },
  typical: {
    name: "typical",
    summary: "12 turns and 2.5 h of agent work a day, 5 days a week, mostly one tool (calibration median day)",
    activeWeekdays: [0, 1, 2, 3, 4],
    day: [claude(12, 150, 2, 5, 2)],
    weekly: { 2: [claude(8, 100, 1, 3, 2), codex(4, 50, 1, 2)] },
  },
  "no-prompts": {
    name: "no-prompts",
    summary: "typical, but the agent never asks for permission (auto-approve or a sandbox): zero needs-you episodes",
    activeWeekdays: [0, 1, 2, 3, 4],
    day: [claude(12, 150, 2, 0, 2)],
    weekly: { 2: [claude(8, 100, 1, 0, 2), codex(4, 50, 1, 0)] },
  },
  heavy: {
    name: "heavy",
    summary: "200 turns and 20 h of agent work across two tools run side by side, 6 days a week (SPEC 4.5 burner)",
    activeWeekdays: [0, 1, 2, 3, 4, 5],
    day: [claude(140, 720, 8, 30, 80), codex(60, 480, 4, 10, 10)],
  },
  max: {
    name: "max",
    summary: "stress case, not a pacing target: every day, every counter at the ledger cap, four tools",
    activeWeekdays: [0, 1, 2, 3, 4, 5, 6],
    day: (["claude", "codex", "opencode", "antigravity"] as const).map((tool) => ({
      tool, turns: 1_000_000, workingMinutes: 1_500, sessions: 1_000_000, needsYou: 1_000_000, subagentTurns: 1_000_000,
    })),
  },
};

export const PROFILE_NAMES = Object.keys(PROFILES);

export interface LedgerOptions {
  /** Founding day; default 2026-10-12 (a Monday, so profile weeks line up with calendar weeks). */
  readonly founded?: string;
  /** Seeded day-to-day variation: turns and minutes scaled by 0.6 to 1.4, and one day in ten flips between active and rest. */
  readonly jitterSeed?: number;
  readonly seed?: number;
}

export const DEFAULT_FOUNDED = "2026-10-12";

/** A synthetic Ledger v1 for `days` calendar days of the profile, starting on the founding day. */
export function profileLedger(profile: Profile, days: number, opts: LedgerOptions = {}): Ledger {
  const founded = dayNumber(opts.founded ?? DEFAULT_FOUNDED);
  const rand = opts.jitterSeed === undefined ? null : mulberry32(mixSeed(opts.jitterSeed, 0x51ed));
  const out: Record<string, DayTools> = {};
  for (let i = 0; i < days; i++) {
    const pos = i % 7;
    let active = profile.activeWeekdays.includes(pos);
    let scale = 1;
    if (rand !== null) {
      if (i > 0 && rand() % 10 === 0) active = !active; // the founding day stays as the profile says
      scale = 0.6 + (rand() % 801) / 1000;
    }
    if (!active) continue;
    const tools = profile.weekly?.[pos] ?? profile.day;
    const dt: DayTools = {};
    for (const t of tools) dt[t.tool] = toCounts(t, scale);
    out[dayString(founded + i)] = dt;
  }
  return {
    schema_version: 1,
    privacy: { containsText: false },
    seed: opts.seed ?? 20261012,
    founded_day: dayString(founded),
    hooks_first_connected_day: dayString(founded),
    days: out,
    backfill: null,
  };
}

function toCounts(t: ToolDay, scale: number): Counts {
  const s = (v: number, cap: number) => Math.min(cap, Math.round(v * scale));
  const turns = s(t.turns, 1_000_000);
  return {
    turns,
    interrupted_turns: turns > 0 ? Math.min(3, Math.floor(turns / 15)) : 0,
    sessions: t.sessions,
    working_seconds: s(t.workingMinutes * 60, 90_000),
    needs_you: s(t.needsYou, 1_000_000),
    errors: turns > 0 ? 1 : 0,
    recovered: turns > 0 ? 1 : 0,
    limit_hits: 0,
    subagent_turns: s(t.subagentTurns, 1_000_000),
  };
}
