/**
 * HitRects v1 publisher (SPEC 6.2, 6.3; contracts/schemas/hit-rects.v1.schema.json).
 *
 * The renderer calls publish() once per drawn frame, right after drawing, with every interactive
 * box of that frame in logical (CSS) pixels. The publisher:
 * - clips each box to the viewport [0, w] x [0, h] and drops boxes whose clipped width or height
 *   is under 1 px;
 * - snaps outward to whole pixels (x and y floored, right and bottom edges ceiled), then clamps to
 *   the viewport again;
 * - drops exact duplicates; keeps `agent` only if it is 32 lowercase hex characters;
 * - sorts by priority (lower first), then x, and keeps at most `max` (64);
 * - sends a HitRects v1 message only when the set differs from the last one sent (rect geometry,
 *   kind, agent, viewport or scale); otherwise sends nothing and returns null;
 * - fills `t` from wallNow() as an integer ms epoch, `surface: 'strip'`, the viewport, and `scale`
 *   clamped to 0.5..8.
 * Every message it sends must validate against the HitRects v1 schema.
 */
import { RECT_KINDS } from '../../../contracts/ts/src/types.ts';
import type { HitRects, RectKind } from './api.ts';

type HitRect = HitRects['rects'][number];

export interface HitBox {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: RectKind;
  agent?: string;
  /** lower sorts first when capping to 64 (alert 0, waiting residents 1, residents 2, buildings 3) */
  priority: number;
}

export interface HitRectsPublisherOptions {
  /** wall-clock ms epoch for the message `t` */
  wallNow: () => number;
  send: (msg: HitRects) => void;
  /** default 64 */
  max?: number;
}

/** The schema's hard limits (hit-rects.v1.schema.json). */
const SCHEMA_MAX_RECTS = 64;
const SCHEMA_MAX_VIEWPORT = 16384;
const SCALE_MIN = 0.5;
const SCALE_MAX = 8;
const AGENT_PATTERN = /^[0-9a-f]{32}$/;

/** A box after clipping and snapping, with the fields the output keeps. */
interface Snapped {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: RectKind | undefined;
  agent: string | undefined;
  priority: number;
}

/** Clamps v into [lo, hi]; NaN becomes the fallback. Infinities clamp to the bound. */
function clamp(v: number, lo: number, hi: number, fallback: number): number {
  if (Number.isNaN(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

function isRectKind(v: unknown): v is RectKind {
  return typeof v === 'string' && (RECT_KINDS as readonly string[]).includes(v);
}

function compareValues(a: number | string, b: number | string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Clips a box to the viewport, drops it if it is under 1 px in either direction, and snaps it to
 * whole pixels. Returns null for a dropped box.
 */
function snap(box: HitBox, vw: number, vh: number): Snapped | null {
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y) || !Number.isFinite(box.w) || !Number.isFinite(box.h)) {
    return null;
  }
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(vw, box.x + box.w);
  const y1 = Math.min(vh, box.y + box.h);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;

  const x = Math.floor(x0);
  const y = Math.floor(y0);
  const right = Math.min(vw, Math.ceil(x1));
  const bottom = Math.min(vh, Math.ceil(y1));

  const agent = typeof box.agent === 'string' && AGENT_PATTERN.test(box.agent) ? box.agent : undefined;
  const kind = isRectKind(box.kind) ? box.kind : undefined;
  const priority = Number.isNaN(box.priority) ? Infinity : box.priority;

  return { x, y, w: right - x, h: bottom - y, kind, agent, priority };
}

/** Sort order: priority, then x, then y; then w, h, kind and agent so equal positions order the same way every time. */
function compareSnapped(a: Snapped, b: Snapped): number {
  return (
    compareValues(a.priority, b.priority) ||
    compareValues(a.x, b.x) ||
    compareValues(a.y, b.y) ||
    compareValues(a.w, b.w) ||
    compareValues(a.h, b.h) ||
    compareValues(a.kind ?? '', b.kind ?? '') ||
    compareValues(a.agent ?? '', b.agent ?? '')
  );
}

function toRect(s: Snapped): HitRect {
  const rect: HitRect = { x: s.x, y: s.y, w: s.w, h: s.h };
  if (s.kind !== undefined) rect.kind = s.kind;
  if (s.agent !== undefined) rect.agent = s.agent;
  return rect;
}

/** True when the rect list matches the last message's list in geometry, kind, agent and order. */
function sameRects(a: HitRect[], b: HitRect[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (p.x !== q.x || p.y !== q.y || p.w !== q.w || p.h !== q.h) return false;
    if (p.kind !== q.kind || p.agent !== q.agent) return false;
  }
  return true;
}

export class HitRectsPublisher {
  private readonly wallNow: () => number;
  private readonly send: (msg: HitRects) => void;
  private readonly max: number;
  private lastMsg: HitRects | null = null;

  constructor(opts: HitRectsPublisherOptions) {
    this.wallNow = opts.wallNow;
    this.send = opts.send;
    this.max = clamp(Math.floor(opts.max ?? SCHEMA_MAX_RECTS), 0, SCHEMA_MAX_RECTS, SCHEMA_MAX_RECTS);
  }

  publish(boxes: HitBox[], viewport: { w: number; h: number }, scale: number): HitRects | null {
    const vw = clamp(viewport.w, 1, SCHEMA_MAX_VIEWPORT, 1);
    const vh = clamp(viewport.h, 1, SCHEMA_MAX_VIEWPORT, 1);
    const s = clamp(scale, SCALE_MIN, SCALE_MAX, 1);

    const snapped: Snapped[] = [];
    for (const box of boxes) {
      const r = snap(box, vw, vh);
      if (r) snapped.push(r);
    }
    // Sort before de-duplicating so that a duplicate keeps its most urgent priority.
    snapped.sort(compareSnapped);

    const rects: HitRect[] = [];
    const seen = new Set<string>();
    for (const r of snapped) {
      if (rects.length >= this.max) break;
      const key = `${r.x} ${r.y} ${r.w} ${r.h} ${r.kind ?? ''} ${r.agent ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rects.push(toRect(r));
    }

    const prev = this.lastMsg;
    if (prev && prev.viewport.w === vw && prev.viewport.h === vh && prev.scale === s && sameRects(prev.rects, rects)) {
      return null;
    }

    const msg: HitRects = {
      schema_version: 1,
      t: Math.round(this.wallNow()),
      surface: 'strip',
      viewport: { w: vw, h: vh },
      scale: s,
      rects,
    };
    this.send(msg);
    this.lastMsg = msg;
    return msg;
  }

  last(): HitRects | null {
    return this.lastMsg;
  }

  /** forget the last set so the next publish always sends (after a resize or a page reload) */
  reset(): void {
    this.lastMsg = null;
  }
}
