// Choices v1 fixtures (contracts/schemas/choices.v1.schema.json).
import { T0, DAY_MS, MIN, MS_MIN, MS_MAX, day, edit, fx, DELETE } from "../lib.mjs";

const PROGRESSION = [
  "noticeboard", "workshop_1", "well", "cottage_1", "garden_plots", "crossing", "watermill",
  "workshop_2", "cottage_2", "bell_tower", "bakery", "market_hall",
];

/** A timestamp and its local day, placed offset days from the reference day (day 0 is 2026-10-12). */
function when(offset, minutes = 0) {
  return { t: T0 + offset * DAY_MS + minutes * MIN, day: day(offset) };
}

const order = (list, offset = -2, minutes = 0) => ({ ...when(offset, minutes), kind: "build_order", order: list });
const deco = (id, on, offset = -1, minutes = 0) => ({ ...when(offset, minutes), kind: "decoration", decoration: id, on });
const choices = (log) => ({ schema_version: 1, privacy: { containsText: false }, log });

export function valid() {
  const full = [...PROGRESSION];
  return [
    fx("empty-log", "An empty log means the default build order and no decorations toggled.", choices([])),
    ...PROGRESSION.map((s) =>
      fx(`order-only-${s.replace(/_/g, "-")}`, `A build order that lists only ${s}, the rest keeping their default order.`, choices([order([s])])),
    ),
    fx("build-order-all-twelve", "A build order that lists all 12 progression structures.", choices([order(full)])),
    fx("build-order-reversed", "All 12 progression structures in the reverse of the default order.", choices([order([...full].reverse())])),
    fx("build-order-eleven", "A build order of 11 structures, with one left to its default place.", choices([order(full.slice(0, 11))])),
    fx("build-order-two", "A build order of two structures.", choices([order(["bakery", "well"])])),
    fx("order-partial-keeps-default", "Three listed structures, with the rest keeping their default order after them.", choices([order(["bakery", "well", "market_hall"])])),
    fx("full-order-with-decoration", "A complete build order followed by a decoration placed the same day.", choices([order(full), deco("lamp", true)])),
    fx("decoration-on", "A decoration placed on the ground.", choices([deco("lamp", true)])),
    fx("decoration-put-away", "A decoration put away.", choices([deco("lamp", false)])),
    fx("decoration-bench-on", "A bench decoration placed four days before the reference day.", choices([deco("bench", true, -4)])),
    fx("decoration-tree-off", "A tree decoration put away six days before the reference day.", choices([deco("tree", false, -6)])),
    fx("decoration-id-min-length", "A two-character decoration id, the shortest legal.", choices([deco("ab", true)])),
    fx("decoration-id-max-length", "A 32-character decoration id, the longest legal.", choices([deco("a" + "b".repeat(31), true)])),
    fx("decoration-id-digits-underscores", "A decoration id with a digit and an underscore.", choices([deco("lamp_2", true)])),
    fx("decoration-id-trailing-underscore", "A decoration id ending in an underscore is still a valid slug.", choices([deco("bench_", false)])),
    fx("decoration-toggle-on-then-off", "The same decoration placed and then put away.", choices([deco("bench", true, -3), deco("bench", false, -2)])),
    fx("decoration-put-away-then-placed", "A decoration placed, put away, then placed again.", choices([deco("lamp", true, -3), deco("lamp", false, -2), deco("lamp", true, -1)])),
    fx("mixed-log", "A build order, a decoration placed, a decoration put away and a second build order.", choices([
      order(["well", "noticeboard"], -5),
      deco("flower_box", true, -4),
      deco("flower_box", false, -3),
      order(["market_hall"], -1),
    ])),
    fx("order-and-decoration-same-day", "A build order and a decoration made on the same day.", choices([order(["cottage_1"], -1, 5), deco("lamp", true, -1, 10)])),
    fx("two-build-orders", "Two build orders in sequence, where the later one is the one in force.", choices([order(["bakery"], -6), order(["bell_tower", "bakery"], -2)])),
    fx("same-time-two-entries", "Two entries with the same t and day, kept in log order.", choices([deco("lamp", true, -1, 30), deco("bench", true, -1, 30)])),
    fx("entry-time-at-min", "A build order whose t is the legal minimum timestamp.", choices([{ t: MS_MIN, day: day(-2), kind: "build_order", order: ["well"] }])),
    fx("entry-time-at-max", "A decoration whose t is the legal maximum timestamp.", choices([{ t: MS_MAX, day: day(-1), kind: "decoration", decoration: "lamp", on: true }])),
    fx("day-year-boundaries", "Entries made on 2026-01-01 and 2026-12-31.", choices([
      { t: T0 - 284 * DAY_MS, day: "2026-01-01", kind: "build_order", order: ["noticeboard"] },
      { t: T0 + 80 * DAY_MS, day: "2026-12-31", kind: "decoration", decoration: "lamp", on: false },
    ])),
    fx("long-log-of-fifty", "Fifty entries alternating decorations and build orders.", choices(
      Array.from({ length: 50 }, (_, i) =>
        i % 2 === 0 ? deco(`lamp_${i}`, i % 4 === 0, -(i % 5) - 1, i) : order(["noticeboard", "well"], -2, i),
      ),
    )),
  ];
}

export function invalid() {
  const base = choices([order(["noticeboard", "well"]), deco("lamp", true)]);
  return [
    fx("root-array", "The root must be an object, not an array.", [base], ""),
    fx("root-null", "The root must be an object, not null.", null, ""),
    fx("root-string", "The root must be an object, not a string.", "choices", ""),
    fx("missing-schema-version", "schema_version is required.", edit(base, { schema_version: DELETE }), ""),
    fx("missing-privacy", "privacy is required.", edit(base, { privacy: DELETE }), ""),
    fx("missing-log", "log is required, even when empty.", edit(base, { log: DELETE }), ""),
    fx("schema-version-2", "schema_version must be the constant 1.", edit(base, { schema_version: 2 }), "/schema_version"),
    fx("root-extra-field", "Unknown top-level fields are rejected.", edit(base, { app_version: "0.9.1" }), ""),
    fx("privacy-contains-text-true", "privacy.containsText must be false.", edit(base, { "privacy.containsText": true }), "/privacy/containsText"),
    fx("privacy-missing-contains-text", "privacy.containsText is required.", edit(base, { "privacy.containsText": DELETE }), "/privacy"),
    fx("privacy-extra-field", "privacy is closed, so a project field is rejected.", edit(base, { "privacy.project": "busyholm" }), "/privacy"),
    fx("log-not-array", "log must be an array of entries.", edit(base, { log: {} }), "/log"),
    fx("entry-not-object", "Each log entry must be an object.", edit(base, { log: ["order"] }), "/log/0"),
    fx("entry-wrong-kind", "kind must be build_order or decoration.", edit(base, { "log.0.kind": "order" }), "/log/0/kind"),
    fx("entry-kind-missing", "kind is required on every entry.", edit(base, { "log.0.kind": DELETE }), "/log/0"),
    fx("entry-missing-t", "t is required on every entry.", edit(base, { "log.0.t": DELETE }), "/log/0"),
    fx("entry-missing-day", "day is required on every entry.", edit(base, { "log.0.day": DELETE }), "/log/0"),
    fx("entry-t-in-seconds", "t in seconds is below the millisecond range.", edit(base, { "log.0.t": 1791806400 }), "/log/0/t"),
    fx("entry-t-fractional", "t must be a whole number of milliseconds.", edit(base, { "log.0.t": 1791806400000.5 }), "/log/0/t"),
    fx("entry-t-string", "t must be an integer, not an ISO string.", edit(base, { "log.0.t": "2026-10-10T12:00:00Z" }), "/log/0/t"),
    fx("entry-day-unpadded", "day must be YYYY-MM-DD, so 2026-1-5 is rejected.", edit(base, { "log.0.day": "2026-1-5" }), "/log/0/day"),
    fx("entry-day-today", "day must be a calendar date, not the word today.", edit(base, { "log.0.day": "today" }), "/log/0/day"),
    fx("entry-day-month-13", "day with month 13 breaks the day pattern.", edit(base, { "log.0.day": "2026-13-01" }), "/log/0/day"),
    fx("entry-extra-field", "Entries are closed, so an extra note field is rejected.", edit(base, { "log.0.note": "x" }), "/log/0"),
    fx("build-order-with-decoration-fields", "A build_order entry may not carry decoration fields.", edit(base, { "log.0.decoration": "lamp", "log.0.on": true }), "/log/0"),
    fx("decoration-with-order", "A decoration entry may not carry an order.", edit(base, { "log.1.order": ["well"] }), "/log/1"),
    fx("order-with-duplicates", "The order must not repeat a structure.", edit(base, { "log.0.order": ["noticeboard", "noticeboard"] }), "/log/0/order"),
    fx("order-with-campfire", "campfire is not a progression structure, so it cannot be ordered.", edit(base, { "log.0.order": ["noticeboard", "campfire"] }), "/log/0/order/1"),
    fx("order-with-founders-stone", "founders_stone comes from the backfill and cannot be ordered.", edit(base, { "log.0.order": ["founders_stone", "well"] }), "/log/0/order/0"),
    fx("order-of-thirteen", "An order of 13 exceeds the 12 maximum; the repeated entry also breaks uniqueness at the same path, because only 12 distinct structures exist.", edit(base, { "log.0.order": [...PROGRESSION, "well"] }), "/log/0/order"),
    fx("order-empty", "An order needs at least one structure.", edit(base, { "log.0.order": [] }), "/log/0/order"),
    fx("order-item-number", "Order items are structure ids, not numbers.", edit(base, { "log.0.order": [5] }), "/log/0/order/0"),
    fx("order-not-array", "order must be an array.", edit(base, { "log.0.order": "noticeboard" }), "/log/0/order"),
    fx("decoration-uppercase", "Decoration ids are lowercase slugs.", edit(base, { "log.1.decoration": "Lamp" }), "/log/1/decoration"),
    fx("decoration-too-short", "A decoration id needs at least two characters.", edit(base, { "log.1.decoration": "a" }), "/log/1/decoration"),
    fx("decoration-leading-digit", "A decoration id must start with a letter.", edit(base, { "log.1.decoration": "2lamp" }), "/log/1/decoration"),
    fx("decoration-too-long", "A decoration id may be at most 32 characters.", edit(base, { "log.1.decoration": "a" + "b".repeat(32) }), "/log/1/decoration"),
    fx("decoration-hyphen", "Decoration ids use underscores, not hyphens.", edit(base, { "log.1.decoration": "flower-box" }), "/log/1/decoration"),
    fx("decoration-on-not-boolean", "on must be a boolean.", edit(base, { "log.1.on": "yes" }), "/log/1/on"),
    fx("decoration-missing-on", "A decoration entry needs on.", edit(base, { "log.1.on": DELETE }), "/log/1"),
    fx("decoration-missing-id", "A decoration entry needs its decoration id.", edit(base, { "log.1.decoration": DELETE }), "/log/1"),
    fx("second-entry-t-in-seconds", "An error in the second entry is reported at its own index.", edit(base, { "log.1.t": 1791806400 }), "/log/1/t"),
  ];
}
