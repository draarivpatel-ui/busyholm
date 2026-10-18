// HitRects v1 fixtures (contracts/schemas/hit-rects.v1.schema.json).
import { T0, MS_MIN, MS_MAX, hid, edit, fx, DELETE } from "../lib.mjs";

const AGENT = hid("hit-rects-agent-a");
const RAW_UUID = "6f1c0a2e-1b2c-4d3e-8f9a-0b1c2d3e4f5a";
const KINDS = ["resident", "building", "bell", "card", "ui", "other"];

const slug = (s) => String(s).replace(/[_.]/g, "-");

/** A geometry-only rect inside the default 1280 x 160 viewport. */
const rect = (over = {}) => ({ x: 24, y: 40, w: 96, h: 96, ...over });

/** A message with the default viewport, scale 2 and the given rects. */
const frame = (over = {}) => ({
  schema_version: 1,
  t: T0,
  surface: "strip",
  viewport: { w: 1280, h: 160 },
  scale: 2,
  rects: [],
  ...over,
});

/** n rects laid out in a grid that stays inside a 1280 x 400 viewport. */
function grid(n) {
  return Array.from({ length: n }, (_, i) =>
    rect({ x: (i % 12) * 100, y: 8 + Math.floor(i / 12) * 40, w: 80, h: 32, kind: KINDS[i % KINDS.length] }),
  );
}
const big = (rects) => ({ viewport: { w: 1280, h: 400 }, rects });

export function valid() {
  return [
    fx("empty-rects", "An empty rects list makes the whole strip click-through.", frame()),
    ...KINDS.map((k) =>
      fx(`kind-${k}`, `One ${k} rect with no agent.`, frame({ rects: [rect({ kind: k })] })),
    ),
    ...KINDS.map((k) =>
      fx(`kind-${k}-with-agent`, `One ${k} rect carrying a salted agent id.`, frame({ rects: [rect({ kind: k, agent: AGENT })] })),
    ),
    fx("agent-without-kind", "A rect with an agent id but no kind.", frame({ rects: [rect({ agent: AGENT })] })),
    fx("geometry-only", "A rect with geometry only and no diagnostics.", frame({ rects: [rect()] })),
    ...[1, 2, 8, 32, 63, 64].map((n) =>
      fx(`count-${n}`, `${n} rect${n === 1 ? "" : "s"} in one message.`, frame(big(grid(n)))),
    ),
    fx("viewport-min-extent", "A viewport extent just above zero with an empty rects list.", frame({ viewport: { w: 0.001, h: 0.001 } })),
    fx("viewport-max-extent", "A viewport at the 16384 pixel maximum with a rect in its far corner.", frame({ viewport: { w: 16384, h: 16384 }, rects: [rect({ x: 16000, y: 16000, w: 384, h: 384 })] })),
    fx("viewport-fractional", "A viewport with fractional logical pixel sizes.", frame({ viewport: { w: 800.5, h: 120.25 } })),
    fx("rect-origin", "A rect at the origin of the content area.", frame({ rects: [rect({ x: 0, y: 0 })] })),
    fx("rect-full-viewport", "A rect covering the whole viewport.", frame({ rects: [rect({ x: 0, y: 0, w: 1280, h: 160 })] })),
    fx("rect-tiny-extent", "A rect with a width just above zero.", frame({ rects: [rect({ w: 0.001, h: 0.5 })] })),
    fx("rect-max-extent", "A rect whose width is the 16384 maximum, in a viewport of the same width.", frame({ viewport: { w: 16384, h: 160 }, rects: [rect({ x: 0, w: 16384 })] })),
    fx("rect-coord-max", "x at the 16384 coordinate maximum; the rect sits past the viewport edge, which only the producer invariant forbids.", frame({ viewport: { w: 16384, h: 160 }, rects: [rect({ x: 16384, w: 1 })] })),
    fx("rect-fractional-geometry", "Fractional logical pixel geometry is allowed.", frame({ rects: [rect({ x: 10.5, y: 3.25, w: 100.75, h: 20.125 })] })),
    fx("scale-half", "devicePixelRatio at the 0.5 minimum.", frame({ scale: 0.5 })),
    fx("scale-eight", "devicePixelRatio at the 8 maximum.", frame({ scale: 8 })),
    ...[1, 1.25, 1.5, 3].map((s) =>
      fx(`scale-${String(s).replace(".", "-")}`, `devicePixelRatio of ${s}.`, frame({ scale: s })),
    ),
    fx("t-at-min", "t at the minimum legal timestamp.", frame({ t: MS_MIN })),
    fx("t-at-max", "t at the maximum legal timestamp.", frame({ t: MS_MAX })),
    fx("mixed-kinds-and-agents", "Several rects of different kinds, some with agents, in one message.", frame({ rects: [
      rect({ kind: "resident", agent: AGENT }),
      rect({ x: 140, kind: "card", agent: AGENT }),
      rect({ x: 260, kind: "bell" }),
      rect({ x: 380, kind: "ui" }),
    ] })),
  ];
}

export function invalid() {
  const base = frame({ rects: [rect({ kind: "card", agent: AGENT })] });
  return [
    fx("root-array", "The root must be an object, not an array.", [base], ""),
    fx("root-null", "The root must be an object, not null.", null, ""),
    fx("root-string", "The root must be an object, not a string.", "strip", ""),
    fx("missing-schema-version", "schema_version is required.", edit(base, { schema_version: DELETE }), ""),
    fx("missing-t", "t is required.", edit(base, { t: DELETE }), ""),
    fx("missing-surface", "surface is required.", edit(base, { surface: DELETE }), ""),
    fx("missing-viewport", "viewport is required.", edit(base, { viewport: DELETE }), ""),
    fx("missing-scale", "scale is required.", edit(base, { scale: DELETE }), ""),
    fx("missing-rects", "rects is required, even when empty.", edit(base, { rects: DELETE }), ""),
    fx("schema-version-two", "schema_version must be the constant 1.", edit(base, { schema_version: 2 }), "/schema_version"),
    fx("t-in-seconds", "t in seconds is below the millisecond range.", edit(base, { t: T0 / 1000 }), "/t"),
    fx("t-below-min", "t is one millisecond before 2000-01-01.", edit(base, { t: MS_MIN - 1 }), "/t"),
    fx("t-above-max", "t is one millisecond after 2100-01-01.", edit(base, { t: MS_MAX + 1 }), "/t"),
    fx("t-string", "t must be an integer, not an ISO timestamp string.", edit(base, { t: "2026-10-12T12:00:00Z" }), "/t"),
    fx("extra-top-level-field", "An unknown top-level field is rejected by the closed object.", edit(base, { generated_by: "strip" }), ""),
    fx("surface-ambient", "Only the strip is partly click-through in v0.1, so ambient is rejected.", edit(base, { surface: "ambient" }), "/surface"),
    fx("surface-popover", "Only the strip is partly click-through in v0.1, so popover is rejected.", edit(base, { surface: "popover" }), "/surface"),
    fx("viewport-missing-w", "viewport requires both w and h.", edit(base, { "viewport.w": DELETE }), "/viewport"),
    fx("viewport-missing-h", "viewport requires both w and h.", edit(base, { "viewport.h": DELETE }), "/viewport"),
    fx("viewport-extra-dpi", "viewport is a closed object; device pixel ratio belongs in scale.", edit(base, { "viewport.dpi": 2 }), "/viewport"),
    fx("viewport-w-zero", "A viewport extent must be above zero.", edit(base, { "viewport.w": 0 }), "/viewport/w"),
    fx("viewport-h-negative", "A viewport extent must be above zero.", edit(base, { "viewport.h": -10 }), "/viewport/h"),
    fx("viewport-w-over-max", "A viewport extent is at most 16384.", edit(base, { "viewport.w": 16384.5 }), "/viewport/w"),
    fx("viewport-h-string", "A viewport extent must be a number, not a string.", edit(base, { "viewport.h": "160" }), "/viewport/h"),
    fx("viewport-w-null", "A viewport extent is required and cannot be null.", edit(base, { "viewport.w": null }), "/viewport/w"),
    fx("scale-below-min", "scale is at least 0.5.", edit(base, { scale: 0.49 }), "/scale"),
    fx("scale-above-max", "scale is at most 8.", edit(base, { scale: 8.01 }), "/scale"),
    fx("scale-string", "scale must be a number, not a string.", edit(base, { scale: "2" }), "/scale"),
    fx("rects-object", "rects must be an array.", edit(base, { rects: {} }), "/rects"),
    fx("rects-null", "rects is always present as an array, never null.", edit(base, { rects: null }), "/rects"),
    fx("rects-65", "At most 64 rects per message.", edit(base, { rects: grid(65) }), "/rects"),
    fx("rect-missing-h", "A rect requires x, y, w and h.", edit(base, { "rects.0.h": DELETE }), "/rects/0"),
    fx("rect-missing-x", "A rect requires x, y, w and h.", edit(base, { "rects.0.x": DELETE }), "/rects/0"),
    fx("rect-x-negative", "A rect x coordinate is at least 0.", edit(base, { "rects.0.x": -1 }), "/rects/0/x"),
    fx("rect-x-over-max", "A rect x coordinate is at most 16384.", edit(base, { "rects.0.x": 16384.5 }), "/rects/0/x"),
    fx("rect-y-string", "A rect y coordinate must be a number.", edit(base, { "rects.0.y": "40" }), "/rects/0/y"),
    fx("rect-w-zero", "A rect width must be above zero.", edit(base, { "rects.0.w": 0 }), "/rects/0/w"),
    fx("rect-h-negative", "A rect height must be above zero.", edit(base, { "rects.0.h": -4 }), "/rects/0/h"),
    fx("rect-kind-unknown", "rect kind must be one of the six kinds.", edit(base, { "rects.0.kind": "window" }), "/rects/0/kind"),
    fx("rect-kind-null", "rect kind is omitted when unknown, never null.", edit(base, { "rects.0.kind": null }), "/rects/0/kind"),
    fx("rect-agent-raw-uuid", "A rect agent is a salted id, never a raw UUID.", edit(base, { "rects.0.agent": RAW_UUID }), "/rects/0/agent"),
    fx("rect-agent-uppercase", "A rect agent id must be lowercase hex.", edit(base, { "rects.0.agent": AGENT.toUpperCase() }), "/rects/0/agent"),
    fx("rect-agent-null", "A rect agent is omitted when unknown, never null.", edit(base, { "rects.0.agent": null }), "/rects/0/agent"),
    fx("rect-unknown-field", "A rect carries geometry and two diagnostics only, so a label is rejected.", edit(base, { "rects.0.label": "Save" }), "/rects/0"),
    fx("rect-null-item", "Each rect must be an object, not null.", edit(base, { rects: [null] }), "/rects/0"),
    fx("third-rect-zero-width", "The third rect has a zero width, so the error points at index 2.", edit(base, { rects: [rect(), rect({ x: 200 }), rect({ x: 400, w: 0 })] }), "/rects/2/w"),
  ];
}
