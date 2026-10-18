// Ledger v1 fixtures (contracts/schemas/ledger.v1.schema.json).
import { T0, DAY_MS, MS_MAX, MS_MIN, day, edit, fx, DELETE } from "../lib.mjs";

const TOOLS = ["claude", "codex", "opencode", "antigravity", "gemini", "cursor", "aider", "other"];

function counts(over = {}) {
  return {
    turns: 12,
    interrupted_turns: 1,
    sessions: 2,
    working_seconds: 3600,
    needs_you: 2,
    errors: 0,
    recovered: 0,
    limit_hits: 0,
    subagent_turns: 0,
    ...over,
  };
}

const ZERO = Object.fromEntries(Object.keys(counts()).map((k) => [k, 0]));
const MAX = Object.fromEntries(Object.keys(counts()).map((k) => [k, k === "working_seconds" ? 90000 : 1000000]));

function ledger(over = {}) {
  return {
    schema_version: 1,
    privacy: { containsText: false },
    seed: 20261012,
    founded_day: day(-5),
    hooks_first_connected_day: day(-4),
    days: { [day(-4)]: { claude: counts() } },
    backfill: null,
    ...over,
  };
}

/** Backfill days n of them, all placed before the live history (day(-40) up to day(-9) at most). */
function backfillDays(n, over = {}) {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [day(-40 + i), { claude: counts(over) }]));
}

const backfill = (over = {}) => ({ imported_at: T0 - 30 * DAY_MS, days: backfillDays(1), ...over });

export function valid() {
  const allTools = Object.fromEntries(TOOLS.map((t) => [t, counts()]));
  return [
    fx("empty-days", "No day has been counted yet, so days is an empty object and hooks are not connected.", ledger({ days: {}, hooks_first_connected_day: null })),
    fx("one-claude-day", "One live day with one tool and the hooks connected a day after the founding crate.", ledger()),
    fx("hooks-not-yet-connected", "hooks_first_connected_day is null, so the bell post has not arrived yet.", ledger({ hooks_first_connected_day: null })),
    fx("hooks-on-founding-day", "The hooks connected on the same local day the founding crate arrived.", ledger({ hooks_first_connected_day: day(-5) })),
    ...TOOLS.map((tool) =>
      fx(`tool-${tool}`, `A single live day with counts recorded for the ${tool} tool.`, ledger({ days: { [day(-1)]: { [tool]: counts() } } })),
    ),
    fx("all-tools-one-day", "All eight tool keys present on one day.", ledger({ days: { [day(-1)]: allTools } })),
    fx("two-tools-same-day", "Two tools counted on the same day.", ledger({ days: { [day(-1)]: { claude: counts(), codex: counts({ turns: 3 }) } } })),
    fx("zero-counters", "Every counter at zero on a day that still exists.", ledger({ days: { [day(-1)]: { claude: counts(ZERO) } } })),
    fx("counters-at-max", "Every counter at its 1000000 maximum, and working_seconds at its 90000 cap.", ledger({ days: { [day(-1)]: { claude: counts(MAX) } } })),
    fx("working-seconds-max", "working_seconds at exactly 90000, the wall-clock cap that allows a 25-hour daylight-saving day.", ledger({ days: { [day(-1)]: { claude: counts({ working_seconds: 90000 }) } } })),
    fx("working-seconds-one-day", "working_seconds at 86400, one full 24-hour day of wall-clock time.", ledger({ days: { [day(-1)]: { claude: counts({ working_seconds: 86400 }) } } })),
    fx("working-seconds-zero", "working_seconds at zero with no sessions or turns started.", ledger({ days: { [day(-1)]: { claude: counts({ working_seconds: 0, sessions: 0, turns: 0 }) } } })),
    fx("error-counters-nonzero", "Error, recovery and limit counters all non-zero on one day.", ledger({ days: { [day(-1)]: { claude: counts({ errors: 4, recovered: 2, limit_hits: 3 }) } } })),
    fx("mixed-tools-many-days", "Several days with different tool sets, including a day with only zero-valued counts for gemini.", ledger({
      days: {
        [day(-3)]: { claude: counts() },
        [day(-2)]: { codex: counts(), gemini: counts({ turns: 0, sessions: 0, working_seconds: 0 }) },
        [day(-1)]: { other: counts({ turns: 1 }) },
      },
    })),
    fx("many-days", "Thirty consecutive live days of Claude activity.", ledger({
      days: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [day(i - 29), { claude: counts({ turns: i + 1 }) }])),
    })),
    fx("month-boundary-days", "Days on either side of the month boundary, 2026-09-30 and 2026-10-01.", ledger({
      days: { [day(-12)]: { claude: counts() }, [day(-11)]: { claude: counts() } },
    })),
    fx("leap-day-key", "A day key on 2028-02-29, which the day pattern accepts.", ledger({ days: { "2028-02-29": { claude: counts() } } })),
    fx("founded-day-year-start", "founded_day on 2026-01-01.", ledger({ founded_day: "2026-01-01" })),
    fx("founded-day-year-end", "founded_day on 2026-12-31.", ledger({ founded_day: "2026-12-31" })),
    fx("seed-zero", "The lowest legal seed, 0.", ledger({ seed: 0 })),
    fx("seed-max", "The largest legal seed, 4294967295.", ledger({ seed: 4294967295 })),
    fx("backfill-one-day", "A backfill holding a single imported day.", ledger({ backfill: backfill() })),
    fx("backfill-31-days", "A backfill with exactly 31 days, the maximum.", ledger({ backfill: backfill({ days: backfillDays(31) }) })),
    fx("backfill-empty-days", "A backfill that was imported but holds no days.", ledger({ backfill: { imported_at: T0, days: {} } })),
    fx("backfill-imported-at-min", "imported_at at the legal minimum, 2000-01-01 UTC.", ledger({ backfill: backfill({ imported_at: MS_MIN }) })),
    fx("backfill-imported-at-max", "imported_at at the legal maximum, 2100-01-01 UTC.", ledger({ backfill: backfill({ imported_at: MS_MAX }) })),
    fx("backfill-and-live-days", "A backfill alongside two live days on different tools.", ledger({
      backfill: backfill(),
      days: { [day(-4)]: { claude: counts() }, [day(-2)]: { codex: counts({ turns: 9 }) } },
    })),
    fx("subagent-turns-only", "A day whose only activity is subagent turns with no main-session turns.", ledger({ days: { [day(-1)]: { claude: counts({ turns: 0, subagent_turns: 5 }) } } })),
    fx("interrupted-turns-at-max", "interrupted_turns at its 1000000 maximum with everything else ordinary.", ledger({ days: { [day(-1)]: { codex: counts({ interrupted_turns: 1000000 }) } } })),
    fx("backfill-imported-at-mid-range", "A backfill imported at an ordinary mid-range timestamp, 400 days before the reference day.", ledger({ backfill: backfill({ imported_at: T0 - 400 * DAY_MS }) })),
  ];
}

export function invalid() {
  const base = ledger();
  const D = day(-4);
  const wb = ledger({ backfill: backfill() });
  return [
    fx("root-array", "The root must be an object, not an array.", [base], ""),
    fx("root-null", "The root must be an object, not null.", null, ""),
    fx("root-string", "The root must be an object, not a string.", "ledger", ""),
    fx("missing-schema-version", "schema_version is required.", edit(base, { schema_version: DELETE }), ""),
    fx("missing-privacy", "privacy is required.", edit(base, { privacy: DELETE }), ""),
    fx("missing-seed", "seed is required.", edit(base, { seed: DELETE }), ""),
    fx("missing-founded-day", "founded_day is required.", edit(base, { founded_day: DELETE }), ""),
    fx("missing-hooks-first-connected-day", "hooks_first_connected_day is required even though it may be null.", edit(base, { hooks_first_connected_day: DELETE }), ""),
    fx("missing-days", "days is required, even when empty.", edit(base, { days: DELETE }), ""),
    fx("missing-backfill", "backfill is required even though it may be null.", edit(base, { backfill: DELETE }), ""),
    fx("schema-version-2", "schema_version must be the constant 1.", edit(base, { schema_version: 2 }), "/schema_version"),
    fx("root-extra-field", "Unknown top-level fields are rejected.", edit(base, { app_version: "0.9.1" }), ""),
    fx("privacy-contains-text-true", "privacy.containsText must be false.", edit(base, { "privacy.containsText": true }), "/privacy/containsText"),
    fx("privacy-missing-contains-text", "privacy.containsText is required.", edit(base, { "privacy.containsText": DELETE }), "/privacy"),
    fx("privacy-extra-field", "privacy is closed, so a project field is rejected.", edit(base, { "privacy.project": "busyholm" }), "/privacy"),
    fx("seed-negative", "seed is an unsigned integer, so a negative value is rejected.", edit(base, { seed: -1 }), "/seed"),
    fx("seed-over-u32", "seed may not exceed 4294967295.", edit(base, { seed: 4294967296 }), "/seed"),
    fx("seed-string", "seed must be a JSON integer, not a string.", edit(base, { seed: "20261012" }), "/seed"),
    fx("founded-day-month-13", "founded_day must be a valid YYYY-MM-DD day.", edit(base, { founded_day: "2026-13-01" }), "/founded_day"),
    fx("hooks-day-today", "hooks_first_connected_day must be a day or null, not a relative word.", edit(base, { hooks_first_connected_day: "today" }), "/hooks_first_connected_day"),
    fx("days-key-month-13", "A day key with month 13 breaks the day pattern.", edit(base, { days: { "2026-13-01": { claude: counts() } } }), "/days"),
    fx("days-key-unpadded", "A day key with an unpadded month and day breaks the day pattern.", edit(base, { days: { "2026-1-5": { claude: counts() } } }), "/days"),
    fx("days-key-today", "The word today is not a day key.", edit(base, { days: { today: { claude: counts() } } }), "/days"),
    fx("day-with-no-tools", "A listed day needs at least one tool.", edit(base, { [`days.${D}`]: {} }), `/days/${D}`),
    fx("unknown-tool-key", "Tool keys come from the closed list of eight tools.", edit(base, { [`days.${D}.vscode`]: counts() }), `/days/${D}`),
    fx("tool-key-uppercase", "Tool keys are lowercase.", edit(base, { [`days.${D}.Claude`]: counts() }), `/days/${D}`),
    fx("counter-negative", "A counter may not be negative.", edit(base, { [`days.${D}.claude.turns`]: -1 }), `/days/${D}/claude/turns`),
    fx("counter-fractional", "A counter is a whole number, so 1.5 is rejected.", edit(base, { [`days.${D}.claude.errors`]: 1.5 }), `/days/${D}/claude/errors`),
    fx("counter-string", "A counter is a JSON number, not a string.", edit(base, { [`days.${D}.claude.turns`]: "12" }), `/days/${D}/claude/turns`),
    fx("counter-over-max", "A counter may not exceed 1000000.", edit(base, { [`days.${D}.claude.sessions`]: 1000001 }), `/days/${D}/claude/sessions`),
    fx("working-seconds-over-max", "working_seconds may not exceed 90000, so 90001 is rejected.", edit(base, { [`days.${D}.claude.working_seconds`]: 90001 }), `/days/${D}/claude/working_seconds`),
    fx("working-seconds-old-max", "working_seconds at the pre-r1 value 5529600 is now above the 90000 maximum.", edit(base, { [`days.${D}.claude.working_seconds`]: 5529600 }), `/days/${D}/claude/working_seconds`),
    fx("counts-quick-answers-present", "quick_answers was removed by SPEC Revision 1, so the closed counts object rejects it as an unknown property.", edit(base, { [`days.${D}.claude.quick_answers`]: 1 }), `/days/${D}/claude`),
    fx("working-seconds-negative", "working_seconds may not be negative.", edit(base, { [`days.${D}.claude.working_seconds`]: -5 }), `/days/${D}/claude/working_seconds`),
    fx("counts-missing-field", "Every counter is required, and errors is missing here.", edit(base, { [`days.${D}.claude.errors`]: DELETE }), `/days/${D}/claude`),
    fx("counts-extra-field", "The counts object is closed, so a project field is rejected.", edit(base, { [`days.${D}.claude.project`]: "busyholm" }), `/days/${D}/claude`),
    fx("counts-not-object", "A tool's counts must be an object.", edit(base, { [`days.${D}.claude`]: 5 }), `/days/${D}/claude`),
    fx("day-value-not-object", "A day's value must be an object keyed by tool.", edit(base, { [`days.${D}`]: "claude" }), `/days/${D}`),
    fx("days-is-array", "days must be an object keyed by day, not an array.", edit(base, { days: [] }), "/days"),
    fx("backfill-32-days", "A backfill may hold at most 31 days.", edit(wb, { "backfill.days": backfillDays(32) }), "/backfill/days"),
    fx("backfill-missing-imported-at", "A backfill needs imported_at.", edit(wb, { "backfill.imported_at": DELETE }), "/backfill"),
    fx("backfill-missing-days", "A backfill needs its days object.", edit(wb, { "backfill.days": DELETE }), "/backfill"),
    fx("backfill-imported-at-seconds", "imported_at in seconds is below the millisecond range.", edit(wb, { "backfill.imported_at": 1791806400 }), "/backfill/imported_at"),
    fx("backfill-imported-at-fractional", "imported_at must be a whole number of milliseconds.", edit(wb, { "backfill.imported_at": 1791806400000.5 }), "/backfill/imported_at"),
    fx("backfill-imported-at-after-2100", "imported_at may not pass 2100-01-01 UTC.", edit(wb, { "backfill.imported_at": MS_MAX + 1 }), "/backfill/imported_at"),
    fx("backfill-extra-field", "The backfill object is closed, so a source field is rejected.", edit(wb, { "backfill.source": "history" }), "/backfill"),
    fx("backfill-bad-day-key", "Backfill day keys follow the same day pattern as live days.", edit(wb, { "backfill.days": { today: { claude: counts() } } }), "/backfill/days"),
    fx("backfill-counter-over-max", "Backfill counters obey the same 1000000 maximum.", edit(wb, { [`backfill.days.${day(-40)}.claude.turns`]: 1000001 }), `/backfill/days/${day(-40)}/claude/turns`),
    fx("backfill-not-object", "backfill is an object or null, not a string.", edit(base, { backfill: "none" }), "/backfill"),
  ];
}
