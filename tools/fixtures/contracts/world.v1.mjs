// World v1 fixtures (contracts/schemas/world.v1.schema.json).
import { day, edit, fx, DELETE } from "../lib.mjs";

const TOOLS = ["claude", "codex", "opencode", "antigravity", "gemini", "cursor", "aider", "other"];
const STRUCTURE_IDS = [
  "campfire", "tent", "bell_post", "noticeboard", "workshop_1", "well", "cottage_1", "garden_plots",
  "crossing", "watermill", "workshop_2", "cottage_2", "bell_tower", "bakery", "market_hall", "founders_stone",
];
const MILESTONES = ["first_turn", "first_answer", "first_subagent", "two_tools_day", "turns_100", "streak_7", "turns_1000"];

/** A complete, valid world. Structure indexes: 0 campfire, 1 tent, 2 noticeboard, 3 workshop_1, 4 well. */
function world(over = {}) {
  return {
    schema_version: 1,
    seed: 20261012,
    as_of_day: day(0),
    tier: "camp",
    resources: { planks: 4.5, stone: 0, seeds: 2 },
    earned: { planks: 12, stone: 1, seeds: 3 },
    structures: [
      { id: "campfire", status: "complete", stage: 3, progress: 1, completed_day: day(-9) },
      { id: "tent", status: "complete", stage: 3, progress: 1, completed_day: day(-9) },
      { id: "noticeboard", status: "complete", stage: 3, progress: 1, completed_day: day(-8) },
      { id: "workshop_1", variant: "claude", status: "building", stage: 2, progress: 0.5 },
      { id: "well", status: "planned", stage: 0, progress: 0 },
    ],
    decorations: [],
    milestones: [],
    stats: { lifetime_turns: 42, active_days: 5, streak_days: 3, tools_seen: ["claude"] },
    founders_stone: null,
    demo_capped: false,
    ...over,
  };
}

const only = (structure) => world({ structures: [structure] });
const planned = (id) => ({ id, status: "planned", stage: 0, progress: 0 });
const waitingWell = (waiting_for) => ({ id: "bell_tower", status: "waiting", stage: 0, progress: 0, waiting_for });
const decos = (n) => Array.from({ length: n }, (_, i) => ({ id: `deco_${i}`, slot: i, shown: i % 2 === 0 }));
const slug = (s) => s.replace(/_/g, "-");

export function valid() {
  const base = world();
  const empty = { planks: 0, stone: 0, seeds: 0 };
  return [
    fx("empty-world", "A fresh install with no structures, decorations, milestones or backfill, and all balances at zero.", world({
      resources: empty,
      earned: empty,
      structures: [],
      stats: { lifetime_turns: 0, active_days: 0, streak_days: 0, tools_seen: [] },
    })),
    fx("mixed-statuses-camp", "Camp tier with complete, building and planned structures and a claude workshop.", base),
    fx("tier-hamlet", "The hamlet tier.", world({ tier: "hamlet" })),
    fx("tier-village", "The village tier.", world({ tier: "village" })),
    fx("waiting-bell-tower", "A waiting bell tower still needing five active days.", only({ id: "bell_tower", status: "waiting", stage: 1, progress: 0.25, waiting_for: { active_days: 5 } })),
    fx("waiting-active-days-min", "waiting_for at the minimum of one active day still to come.", only(waitingWell({ active_days: 1 }))),
    fx("waiting-active-days-max", "waiting_for at the 3650 maximum of active days.", only(waitingWell({ active_days: 3650 }))),
    fx("building-stage-zero", "Building at stage 0 with no progress yet.", only({ id: "cottage_1", status: "building", stage: 0, progress: 0 })),
    fx("building-stage-one", "Building at stage 1 with a quarter of the cost delivered.", only({ id: "cottage_1", status: "building", stage: 1, progress: 0.25 })),
    fx("building-stage-two-just-under-one", "Building at stage 2 with progress just under 1.", only({ id: "cottage_1", status: "building", stage: 2, progress: 0.9999999 })),
    fx("complete-stage-three", "Complete at stage 3 with progress 1 and a completed day.", only({ id: "cottage_1", status: "complete", stage: 3, progress: 1, completed_day: day(-1) })),
    fx("complete-completed-today", "Complete on the reference day itself.", only({ id: "cottage_1", status: "complete", stage: 3, progress: 1, completed_day: day(0) })),
    ...STRUCTURE_IDS.map((id) => fx(`structure-id-${slug(id)}`, `A planned ${id} slot, one of the legal structure ids.`, only(planned(id)))),
    ...TOOLS.map((tool) =>
      fx(`workshop-1-variant-${tool}`, `workshop_1 is the ${tool} workshop, so its variant is that tool.`, only({ id: "workshop_1", variant: tool, status: "building", stage: 1, progress: 0.3 })),
    ),
    fx("workshop-1-undecided", "workshop_1 with no variant yet, which is allowed while undecided.", only({ id: "workshop_1", status: "building", stage: 1, progress: 0.3 })),
    ...[...TOOLS, "guest_house"].map((v) =>
      fx(`workshop-2-variant-${slug(v)}`, `workshop_2 with variant ${v}, which is allowed for a second workshop.`, only({ id: "workshop_2", variant: v, status: "planned", stage: 0, progress: 0 })),
    ),
    fx("crossing-footbridge", "crossing is a footbridge.", only({ id: "crossing", variant: "footbridge", status: "planned", stage: 0, progress: 0 })),
    fx("crossing-jetty", "crossing is a jetty.", only({ id: "crossing", variant: "jetty", status: "planned", stage: 0, progress: 0 })),
    fx("milestones-all-seven", "All seven milestones reached, on distinct days.", world({ milestones: MILESTONES.map((id, i) => ({ id, day: day(i - 9) })) })),
    ...MILESTONES.map((id) =>
      fx(`milestone-${slug(id)}`, `The ${id} milestone reached on its own.`, world({ milestones: [{ id, day: day(-3) }] })),
    ),
    fx("decoration-shown", "One shown decoration in slot 0.", world({ decorations: [{ id: "lamp", slot: 0, shown: true }] })),
    fx("decoration-put-away", "One owned decoration that is put away.", world({ decorations: [{ id: "bench", slot: 1, shown: false }] })),
    fx("decoration-slot-max", "A decoration in the highest seeded slot, 255.", world({ decorations: [{ id: "flower_box", slot: 255, shown: true }] })),
    fx("decoration-id-min-length", "A two-character decoration id.", world({ decorations: [{ id: "ab", slot: 2, shown: true }] })),
    fx("decoration-id-max-length", "A 32-character decoration id.", world({ decorations: [{ id: "a" + "b".repeat(31), slot: 3, shown: true }] })),
    fx("decorations-shown-and-put-away", "Two decorations, one shown and one put away, in different slots.", world({
      decorations: [{ id: "lamp", slot: 4, shown: true }, { id: "bench", slot: 9, shown: false }],
    })),
    fx("decorations-sixty-four", "64 decorations, the maximum, with unique ids and slots.", world({ decorations: decos(64) })),
    fx("counts-at-max", "Lifetime counts at the 1000000000 maximum.", world({
      stats: { lifetime_turns: 1000000000, active_days: 1000000000, streak_days: 1000000000, tools_seen: ["claude"] },
    })),
    fx("tools-seen-all-eight", "All eight tools seen, the largest allowed list.", world({ stats: { ...base.stats, tools_seen: TOOLS } })),
    fx("resources-fractional", "Planks and stone may be fractional.", world({ resources: { planks: 0.5, stone: 0.25, seeds: 0 } })),
    fx("resources-at-max", "Balances at the 1000000000 maximum.", world({ resources: { planks: 1000000000, stone: 1000000000, seeds: 1000000000 } })),
    fx("founders-stone-one-day", "A founders stone from a backfill of one day with no counts.", world({
      founders_stone: { days: 1, turns: 0, sessions: 0, working_hours: 0 },
    })),
    fx("founders-stone-thirty-one-days", "A founders stone at the 31 day maximum with the largest counts.", world({
      founders_stone: { days: 31, turns: 1000000000, sessions: 1000000000, working_hours: 1000000 },
    })),
    fx("founders-stone-fractional-hours", "working_hours may be fractional.", world({
      founders_stone: { days: 12, turns: 340, sessions: 25, working_hours: 12.5 },
    })),
    fx("founders-stone-structure-complete", "The founders_stone structure is complete alongside the engraved counts.", world({
      structures: [{ id: "founders_stone", status: "complete", stage: 3, progress: 1, completed_day: day(-30) }],
      founders_stone: { days: 20, turns: 900, sessions: 40, working_hours: 75.5 },
    })),
    fx("demo-capped-true", "The demo cap stopped building, so demo_capped is true.", world({ demo_capped: true })),
    fx("seed-zero", "The lowest legal seed, 0.", world({ seed: 0 })),
    fx("seed-max", "The largest legal seed, 4294967295.", world({ seed: 4294967295 })),
    fx("as-of-day-year-end", "The last local day of 2026 as the fold day.", world({ as_of_day: "2026-12-31" })),
  ];
}

export function invalid() {
  const base = world();
  const fs = (over) => ({ days: 3, turns: 1, sessions: 1, working_hours: 1, ...over });
  return [
    fx("root-array", "The root must be an object, not an array.", [base], ""),
    fx("root-null", "The root must be an object, not null.", null, ""),
    fx("root-string", "The root must be an object, not a string.", "world", ""),
    fx("missing-schema-version", "schema_version is required.", edit(base, { schema_version: DELETE }), ""),
    fx("missing-seed", "seed is required.", edit(base, { seed: DELETE }), ""),
    fx("missing-as-of-day", "as_of_day is required.", edit(base, { as_of_day: DELETE }), ""),
    fx("missing-tier", "tier is required.", edit(base, { tier: DELETE }), ""),
    fx("missing-resources", "resources is required.", edit(base, { resources: DELETE }), ""),
    fx("missing-earned", "earned is required.", edit(base, { earned: DELETE }), ""),
    fx("missing-structures", "structures is required, even when empty.", edit(base, { structures: DELETE }), ""),
    fx("missing-decorations", "decorations is required, even when empty.", edit(base, { decorations: DELETE }), ""),
    fx("missing-milestones", "milestones is required, even when empty.", edit(base, { milestones: DELETE }), ""),
    fx("missing-stats", "stats is required.", edit(base, { stats: DELETE }), ""),
    fx("missing-founders-stone", "founders_stone is required even though it may be null.", edit(base, { founders_stone: DELETE }), ""),
    fx("missing-demo-capped", "demo_capped is required.", edit(base, { demo_capped: DELETE }), ""),
    fx("schema-version-2", "schema_version must be the constant 1.", edit(base, { schema_version: 2 }), "/schema_version"),
    fx("root-extra-field", "Unknown top-level fields are rejected.", edit(base, { app_version: "0.9.1" }), ""),
    fx("seed-negative", "seed is an unsigned integer, so a negative value is rejected.", edit(base, { seed: -1 }), "/seed"),
    fx("seed-over-u32", "seed may not exceed 4294967295.", edit(base, { seed: 4294967296 }), "/seed"),
    fx("as-of-day-unpadded", "as_of_day must be YYYY-MM-DD.", edit(base, { as_of_day: "2026-1-5" }), "/as_of_day"),
    fx("tier-town", "tier must be camp, hamlet or village.", edit(base, { tier: "town" }), "/tier"),
    fx("resources-negative-planks", "A resource balance may not be negative.", edit(base, { "resources.planks": -1 }), "/resources/planks"),
    fx("resources-missing-stone", "resources needs all three balances.", edit(base, { "resources.stone": DELETE }), "/resources"),
    fx("resources-extra-field", "The resources object is closed, so a gold balance is rejected.", edit(base, { "resources.gold": 3 }), "/resources"),
    fx("earned-negative-seeds", "Lifetime earned may not be negative.", edit(base, { "earned.seeds": -0.5 }), "/earned/seeds"),
    fx("amount-over-max", "A balance may not exceed 1000000000.", edit(base, { "resources.stone": 1000000001 }), "/resources/stone"),
    fx("structures-not-array", "structures must be an array.", edit(base, { structures: {} }), "/structures"),
    fx("structure-missing-id", "A structure needs an id.", edit(base, { "structures.0.id": DELETE }), "/structures/0"),
    fx("structure-unknown-id", "A structure id must be one of the legal ids.", edit(base, { "structures.4.id": "shed" }), "/structures/4/id"),
    fx("structure-extra-field", "The structure object is closed, so a display name is rejected.", edit(base, { "structures.0.name": "Camp fire" }), "/structures/0"),
    fx("status-unknown", "status must be planned, waiting, building or complete.", edit(base, { "structures.4.status": "done" }), "/structures/4/status"),
    fx("stage-four", "stage may not exceed 3.", edit(base, { "structures.3.stage": 4 }), "/structures/3/stage"),
    fx("stage-negative", "stage may not be negative.", edit(base, { "structures.3.stage": -1 }), "/structures/3/stage"),
    fx("progress-over-one", "progress may not exceed 1.", edit(base, { "structures.3.progress": 1.5 }), "/structures/3/progress"),
    fx("complete-without-completed-day", "A complete structure needs its completed_day.", edit(base, { "structures.0.completed_day": DELETE }), "/structures/0"),
    fx("complete-stage-two", "A complete structure must be at stage 3.", edit(base, { "structures.0.stage": 2 }), "/structures/0/stage"),
    fx("complete-progress-below-one", "A complete structure must have progress 1.", edit(base, { "structures.0.progress": 0.9 }), "/structures/0/progress"),
    fx("complete-bad-completed-day", "completed_day must be a valid day.", edit(base, { "structures.0.completed_day": "2026-10-1" }), "/structures/0/completed_day"),
    fx("planned-with-completed-day", "completed_day is present only on a complete structure.", edit(base, { "structures.4.completed_day": day(-1) }), "/structures/4"),
    fx("building-stage-three", "A building structure may not be at stage 3, which is reserved for complete.", edit(base, { "structures.3.stage": 3 }), "/structures/3/stage"),
    fx("building-progress-one", "A building structure may not have progress 1, which is reserved for complete.", edit(base, { "structures.3.progress": 1 }), "/structures/3/progress"),
    fx("waiting-without-waiting-for", "A waiting structure needs waiting_for.", edit(base, { "structures.4.status": "waiting" }), "/structures/4"),
    fx("waiting-for-on-building", "waiting_for is present only while the status is waiting.", edit(base, { "structures.3.waiting_for": { active_days: 3 } }), "/structures/3"),
    fx("waiting-active-days-zero", "waiting_for.active_days must be at least 1, so 0 is rejected.", edit(base, { "structures.4": waitingWell({ active_days: 0 }) }), "/structures/4/waiting_for/active_days"),
    fx("waiting-active-days-over-max", "waiting_for.active_days may not exceed 3650, so 3651 is rejected.", edit(base, { "structures.4": waitingWell({ active_days: 3651 }) }), "/structures/4/waiting_for/active_days"),
    fx("waiting-active-days-fractional", "waiting_for.active_days is an integer, so 1.5 is rejected.", edit(base, { "structures.4": waitingWell({ active_days: 1.5 }) }), "/structures/4/waiting_for/active_days"),
    fx("waiting-for-missing-active-days", "waiting_for needs active_days.", edit(base, { "structures.4": waitingWell({}) }), "/structures/4/waiting_for"),
    fx("waiting-for-quick-answers-only", "waiting_for must be exactly { active_days }, so { quick_answers: 5 } fails both the missing active_days and the closed-object rule at the same pointer.", edit(base, { "structures.4": waitingWell({ quick_answers: 5 }) }), "/structures/4/waiting_for"),
    fx("waiting-for-active-days-and-quick-answers", "waiting_for carrying the removed quick_answers key next to a valid active_days breaks only the closed-object rule.", edit(base, { "structures.4": waitingWell({ active_days: 2, quick_answers: 5 }) }), "/structures/4/waiting_for"),
    fx("waiting-for-extra-field", "waiting_for is closed, so an extra hours field is rejected alongside a valid active_days.", edit(base, { "structures.4": waitingWell({ active_days: 2, hours: 1 }) }), "/structures/4/waiting_for"),
    fx("variant-on-well", "A well has no variant.", edit(base, { "structures.4.variant": "claude" }), "/structures/4"),
    fx("variant-on-campfire", "A campfire has no variant.", edit(base, { "structures.0.variant": "codex" }), "/structures/0"),
    fx("crossing-variant-on-workshop-1", "workshop_1 takes a tool variant, so footbridge is not allowed there.", edit(base, { "structures.3.variant": "footbridge" }), "/structures/3/variant"),
    fx("guest-house-on-workshop-1", "guest_house is only allowed on workshop_2.", edit(base, { "structures.3.variant": "guest_house" }), "/structures/3/variant"),
    fx("guest-house-on-crossing", "crossing takes footbridge or jetty, not guest_house.", edit(base, { "structures.4": { id: "crossing", status: "planned", stage: 0, progress: 0, variant: "guest_house" } }), "/structures/4/variant"),
    fx("footbridge-on-workshop-2", "workshop_2 takes a tool or guest_house, not footbridge.", edit(base, { "structures.4": { id: "workshop_2", status: "planned", stage: 0, progress: 0, variant: "footbridge" } }), "/structures/4/variant"),
    fx("variant-not-in-enum", "A variant must be one of the known variant values.", edit(base, { "structures.3.variant": "bogus" }), "/structures/3/variant"),
    fx("duplicate-structure-id", "Structure ids are unique across the structures array.", edit(base, { "structures.1.id": "campfire" }), "/structures/1"),
    fx("decoration-duplicate-id", "Decoration ids are unique.", world({ decorations: [{ id: "lamp", slot: 0, shown: true }, { id: "lamp", slot: 1, shown: false }] }), "/decorations/1"),
    fx("decoration-duplicate-slot", "Decoration slots are unique.", world({ decorations: [{ id: "lamp", slot: 4, shown: true }, { id: "bench", slot: 4, shown: true }] }), "/decorations/1"),
    fx("decoration-slot-256", "A decoration slot may not exceed 255.", world({ decorations: [{ id: "lamp", slot: 256, shown: true }] }), "/decorations/0/slot"),
    fx("decoration-slot-negative", "A decoration slot may not be negative.", world({ decorations: [{ id: "lamp", slot: -1, shown: true }] }), "/decorations/0/slot"),
    fx("decorations-sixty-five", "At most 64 decorations, so 65 is rejected.", world({ decorations: decos(65) }), "/decorations"),
    fx("decoration-extra-field", "The decoration object is closed, so a display name is rejected.", world({ decorations: [{ id: "lamp", slot: 0, shown: true, name: "Lamp" }] }), "/decorations/0"),
    fx("decoration-missing-shown", "A decoration needs its shown flag.", world({ decorations: [{ id: "lamp", slot: 0 }] }), "/decorations/0"),
    fx("decoration-id-uppercase", "Decoration ids are lowercase slugs.", world({ decorations: [{ id: "Lamp", slot: 0, shown: true }] }), "/decorations/0/id"),
    fx("milestone-duplicate", "Each milestone id appears at most once.", world({ milestones: [{ id: "first_turn", day: day(-3) }, { id: "first_turn", day: day(-2) }] }), "/milestones/1"),
    fx("milestone-unknown-id", "A milestone id must be one of the seven.", world({ milestones: [{ id: "first_hamlet", day: day(-3) }] }), "/milestones/0/id"),
    fx("milestone-day-unpadded", "A milestone day must be YYYY-MM-DD.", world({ milestones: [{ id: "first_turn", day: "2026-1-5" }] }), "/milestones/0/day"),
    fx("milestone-extra-field", "The milestone object is closed.", world({ milestones: [{ id: "first_turn", day: day(-3), note: "x" }] }), "/milestones/0"),
    fx("tools-seen-duplicate", "tools_seen lists each tool at most once.", edit(base, { "stats.tools_seen": ["claude", "claude"] }), "/stats/tools_seen"),
    fx("tools-seen-unknown-tool", "tools_seen items must be known tools.", edit(base, { "stats.tools_seen": ["claude", "gemini-cli"] }), "/stats/tools_seen/1"),
    fx("stats-missing-streak", "stats needs streak_days.", edit(base, { "stats.streak_days": DELETE }), "/stats"),
    fx("stats-negative-turns", "A lifetime count may not be negative.", edit(base, { "stats.lifetime_turns": -1 }), "/stats/lifetime_turns"),
    fx("stats-count-over-max", "A lifetime count may not exceed 1000000000.", edit(base, { "stats.active_days": 1000000001 }), "/stats/active_days"),
    fx("stats-extra-field", "The stats object is closed, so a level field is rejected.", edit(base, { "stats.level": 3 }), "/stats"),
    fx("stats-lifetime-quick-answers-present", "lifetime_quick_answers was removed by SPEC Revision 1, so the closed stats object rejects it.", edit(base, { "stats.lifetime_quick_answers": 7 }), "/stats"),
    fx("founders-stone-days-zero", "A founders stone needs at least one day.", world({ founders_stone: fs({ days: 0 }) }), "/founders_stone/days"),
    fx("founders-stone-days-32", "A founders stone may cover at most 31 days.", world({ founders_stone: fs({ days: 32 }) }), "/founders_stone/days"),
    fx("founders-stone-missing-working-hours", "A founders stone needs working_hours.", world({ founders_stone: { days: 3, turns: 1, sessions: 1 } }), "/founders_stone"),
    fx("founders-stone-turns-fractional", "A founders stone count is a whole number.", world({ founders_stone: fs({ turns: 1.5 }) }), "/founders_stone/turns"),
    fx("founders-stone-hours-over-max", "working_hours may not exceed 1000000.", world({ founders_stone: fs({ working_hours: 1000001 }) }), "/founders_stone/working_hours"),
    fx("demo-capped-string", "demo_capped must be a boolean.", edit(base, { demo_capped: "no" }), "/demo_capped"),
  ];
}
