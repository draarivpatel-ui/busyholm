/**
 * Unit tests for HitRectsPublisher (src/hitrects.ts). Every message sent is also checked against the
 * HitRects v1 schema through the project validator.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HitRectsPublisher } from '../src/hitrects.ts';
import type { HitBox } from '../src/hitrects.ts';
import type { HitRects } from '../src/api.ts';
import { RECT_KINDS } from '../../../contracts/ts/src/types.ts';
import { validate } from '../../../contracts/ts/src/validate.ts';

const T0 = 1_800_000_000_000;
const AGENT_A = 'a'.repeat(32);
const AGENT_B = '0123456789abcdef0123456789abcdef';
const VP = { w: 100, h: 100 };

function box(x: number, y: number, w: number, h: number, extra: Partial<HitBox> = {}): HitBox {
  return { x, y, w, h, kind: 'resident', priority: 1, ...extra };
}

function harness(max?: number) {
  const sent: HitRects[] = [];
  let now = T0;
  const pub = new HitRectsPublisher({
    wallNow: () => now,
    send: (m) => {
      sent.push(m);
    },
    max,
  });
  return {
    pub,
    sent,
    setNow: (v: number) => {
      now = v;
    },
  };
}

function expectValid(msg: HitRects): void {
  const r = validate('hitRects', msg);
  if (!r.ok) assert.fail(JSON.stringify(r.issues));
}

describe('clipping and snapping', () => {
  test('a box partly outside the top-left is clipped to the viewport', () => {
    const { pub } = harness();
    const msg = pub.publish([box(-10, -5, 30, 20, { kind: 'ui' })], VP, 1);
    assert.ok(msg);
    assert.deepEqual(msg.rects, [{ x: 0, y: 0, w: 20, h: 15, kind: 'ui' }]);
    expectValid(msg);
  });

  test('fractional edges snap outward: floor for x and y, ceil for right and bottom', () => {
    const { pub } = harness();
    // x 10.2 to 15.7 becomes 10 to 16; y 20.7 to 23.8 becomes 20 to 24
    const msg = pub.publish([box(10.2, 20.7, 5.5, 3.1)], VP, 1);
    assert.ok(msg);
    assert.deepEqual(msg.rects, [{ x: 10, y: 20, w: 6, h: 4, kind: 'resident' }]);
    expectValid(msg);
  });

  test('snapped right and bottom edges are clamped to the viewport', () => {
    const { pub } = harness();
    // viewport 100 x 50; the box runs off the right and bottom edges
    const msg = pub.publish([box(90.5, 40.5, 20, 20)], { w: 100, h: 50 }, 1);
    assert.ok(msg);
    assert.deepEqual(msg.rects, [{ x: 90, y: 40, w: 10, h: 10, kind: 'resident' }]);
    expectValid(msg);
  });

  test('a box fully outside the viewport is dropped', () => {
    const { pub } = harness();
    const msg = pub.publish(
      [
        box(200, 10, 10, 10), // right of the viewport
        box(-50, 10, 50, 10), // touches the left edge with zero width
        box(10, -30, 10, 30), // touches the top edge with zero height
        box(10, 100, 10, 10), // starts on the bottom edge
      ],
      VP,
      1,
    );
    assert.ok(msg);
    assert.deepEqual(msg.rects, []);
    expectValid(msg);
  });

  test('a box under 1 px after clipping is dropped; exactly 1 px is kept', () => {
    const { pub } = harness();
    const msg = pub.publish(
      [
        box(10, 10, 0.5, 10), // too narrow
        box(10, 10, 10, 0.99), // too short
        box(-0.5, 10, 1.2, 5), // raw width 1.2, but only 0.7 is inside the viewport
        box(10, 10, 1, 1), // exactly 1 px: kept
      ],
      VP,
      1,
    );
    assert.ok(msg);
    assert.deepEqual(msg.rects, [{ x: 10, y: 10, w: 1, h: 1, kind: 'resident' }]);
    expectValid(msg);
  });

  test('clipping happens before the 1 px test, and snapping can widen a 1 px box', () => {
    const { pub } = harness();
    // x 10.5 to 11.5: 1 px wide before snapping, becomes 10 to 12 after
    const msg = pub.publish([box(10.5, 10, 1, 1)], VP, 1);
    assert.ok(msg);
    assert.deepEqual(msg.rects, [{ x: 10, y: 10, w: 2, h: 1, kind: 'resident' }]);
  });

  test('non-finite geometry is dropped instead of producing an invalid message', () => {
    const { pub } = harness();
    const msg = pub.publish(
      [box(NaN, 0, 10, 10), box(0, 0, Infinity, 10), box(0, 0, 10, NaN), box(5, 5, 10, 10)],
      VP,
      1,
    );
    assert.ok(msg);
    assert.deepEqual(msg.rects, [{ x: 5, y: 5, w: 10, h: 10, kind: 'resident' }]);
    expectValid(msg);
  });
});

describe('duplicates, kind and agent', () => {
  test('exact duplicates are removed', () => {
    const { pub } = harness();
    const same = box(10, 10, 20, 20, { kind: 'resident', agent: AGENT_A });
    const msg = pub.publish([same, { ...same }], VP, 1);
    assert.ok(msg);
    assert.equal(msg.rects.length, 1);
  });

  test('boxes that snap to the same whole-pixel rect are duplicates', () => {
    const { pub } = harness();
    // both snap to x 10 to 16, y 10 to 15
    const msg = pub.publish([box(10.1, 10, 5, 5), box(10.9, 10, 5, 5)], VP, 1);
    assert.ok(msg);
    assert.deepEqual(msg.rects, [{ x: 10, y: 10, w: 6, h: 5, kind: 'resident' }]);
  });

  test('same geometry with a different kind is not a duplicate', () => {
    const { pub } = harness();
    const msg = pub.publish(
      [box(10, 10, 20, 20, { kind: 'bell' }), box(10, 10, 20, 20, { kind: 'card' })],
      VP,
      1,
    );
    assert.ok(msg);
    assert.equal(msg.rects.length, 2);
  });

  test('same geometry with a different agent is not a duplicate', () => {
    const { pub } = harness();
    const msg = pub.publish(
      [box(10, 10, 20, 20, { agent: AGENT_A }), box(10, 10, 20, 20, { agent: AGENT_B })],
      VP,
      1,
    );
    assert.ok(msg);
    assert.equal(msg.rects.length, 2);
    expectValid(msg);
  });

  test('duplicates do not use up the 64 cap', () => {
    const { pub } = harness();
    const dup = box(0, 0, 10, 10, { priority: 0, kind: 'bell' });
    const boxes: HitBox[] = [];
    for (let i = 0; i < 100; i++) boxes.push({ ...dup });
    for (let i = 0; i < 70; i++) boxes.push(box(10 + i * 2, 50, 1, 1, { priority: 1 }));
    const msg = pub.publish(boxes, { w: 400, h: 100 }, 1);
    assert.ok(msg);
    assert.equal(msg.rects.length, 64);
    assert.deepEqual(msg.rects[0], { x: 0, y: 0, w: 10, h: 10, kind: 'bell' });
    expectValid(msg);
  });

  test('an invalid agent string drops the agent field and keeps the rect', () => {
    const invalid: unknown[] = [
      'A'.repeat(32), // uppercase
      'a'.repeat(31), // too short
      'a'.repeat(33), // too long
      'g'.repeat(32), // not hex
      '0123456789abcdef-123456789abcdef', // dash
      '550e8400-e29b-41d4-a716-446655440000', // raw UUID
      42, // not a string
      '', // empty
    ];
    for (const agent of invalid) {
      const { pub } = harness();
      const msg = pub.publish([box(10, 10, 20, 20, { agent: agent as string })], VP, 1);
      assert.ok(msg, `agent ${JSON.stringify(agent)} should still send the rect`);
      assert.equal(msg.rects.length, 1);
      assert.equal('agent' in msg.rects[0]!, false, `agent ${JSON.stringify(agent)} should be dropped`);
      expectValid(msg);
    }
  });

  test('a valid agent string is kept', () => {
    const { pub } = harness();
    const msg = pub.publish([box(10, 10, 20, 20, { agent: AGENT_B, kind: 'resident' })], VP, 1);
    assert.ok(msg);
    assert.deepEqual(msg.rects, [{ x: 10, y: 10, w: 20, h: 20, kind: 'resident', agent: AGENT_B }]);
  });

  test('kind is omitted when not given', () => {
    const { pub } = harness();
    const msg = pub.publish([{ x: 10, y: 10, w: 5, h: 5, priority: 0 } as HitBox], VP, 1);
    assert.ok(msg);
    assert.equal('kind' in msg.rects[0]!, false);
    assert.equal('agent' in msg.rects[0]!, false);
  });
});

describe('ordering and the 64 cap', () => {
  test('sorted by priority (lower first), then x, then y', () => {
    const { pub } = harness();
    const msg = pub.publish(
      [
        box(50, 0, 5, 5, { priority: 2, kind: 'ui' }),
        box(0, 0, 5, 5, { priority: 1, kind: 'card' }),
        box(80, 0, 5, 5, { priority: 0, kind: 'bell' }),
        box(10, 0, 5, 5, { priority: 1, kind: 'building' }),
        box(10, 20, 5, 5, { priority: 1, kind: 'other' }),
      ],
      VP,
      1,
    );
    assert.ok(msg);
    assert.deepEqual(
      msg.rects.map((r) => r.kind),
      ['bell', 'card', 'building', 'other', 'ui'],
    );
  });

  test('200 boxes are capped at 64, keeping the highest-priority and left-most', () => {
    const { pub } = harness();
    // box i sits at x = 4 * i and has priority i % 4, so priority 0 holds i = 0, 4, ..., 196
    const boxes: HitBox[] = [];
    for (let i = 0; i < 200; i++) boxes.push(box(4 * i, 0, 2, 2, { priority: i % 4 }));
    const msg = pub.publish(boxes, { w: 1000, h: 100 }, 1);
    assert.ok(msg);
    assert.equal(msg.rects.length, 64);
    // all 50 priority-0 boxes, then the 14 left-most priority-1 boxes (i = 1, 5, ..., 53)
    assert.deepEqual(
      msg.rects.slice(0, 50).map((r) => r.x),
      Array.from({ length: 50 }, (_, k) => 16 * k),
    );
    assert.deepEqual(
      msg.rects.slice(50).map((r) => r.x),
      Array.from({ length: 14 }, (_, k) => 4 + 16 * k),
    );
    expectValid(msg);
  });

  test('the max option lowers the cap', () => {
    const { pub } = harness(10);
    const boxes: HitBox[] = [];
    for (let i = 0; i < 30; i++) boxes.push(box(i * 3, 0, 2, 2));
    const msg = pub.publish(boxes, { w: 200, h: 100 }, 1);
    assert.ok(msg);
    assert.equal(msg.rects.length, 10);
  });

  test('the max option cannot raise the cap above the schema limit of 64', () => {
    const { pub } = harness(500);
    const boxes: HitBox[] = [];
    for (let i = 0; i < 100; i++) boxes.push(box(i * 3, 0, 2, 2));
    const msg = pub.publish(boxes, { w: 400, h: 100 }, 1);
    assert.ok(msg);
    assert.equal(msg.rects.length, 64);
    expectValid(msg);
  });
});

describe('message fields', () => {
  test('fills schema_version, t, surface, viewport and scale', () => {
    const { pub } = harness();
    const msg = pub.publish([box(1, 1, 5, 5)], { w: 320, h: 112 }, 2);
    assert.ok(msg);
    assert.equal(msg.schema_version, 1);
    assert.equal(msg.surface, 'strip');
    assert.deepEqual(msg.viewport, { w: 320, h: 112 });
    assert.equal(msg.scale, 2);
    expectValid(msg);
  });

  test('t is wallNow() rounded to an integer ms epoch', () => {
    const { pub, setNow } = harness();
    setNow(1_800_000_000_123.6);
    const msg = pub.publish([], VP, 1);
    assert.ok(msg);
    assert.equal(msg.t, 1_800_000_000_124);
    assert.equal(Number.isInteger(msg.t), true);
  });

  test('scale is clamped to 0.5 to 8', () => {
    const cases: Array<[number, number]> = [
      [0.1, 0.5],
      [20, 8],
      [2, 2],
      [NaN, 1],
    ];
    for (const [input, want] of cases) {
      const { pub } = harness();
      const msg = pub.publish([], VP, input);
      assert.ok(msg);
      assert.equal(msg.scale, want, `scale ${input}`);
      expectValid(msg);
    }
  });

  test('viewport is clamped into the schema extent range (above 0, up to 16384)', () => {
    const { pub } = harness();
    const msg = pub.publish([], { w: 0, h: 1e9 }, 1);
    assert.ok(msg);
    assert.deepEqual(msg.viewport, { w: 1, h: 16384 });
    expectValid(msg);
  });
});

describe('change detection', () => {
  test('an unchanged set is not sent again', () => {
    const { pub, sent } = harness();
    const boxes = [box(10, 10, 20, 20, { agent: AGENT_A }), box(40, 10, 5, 5, { priority: 0 })];
    assert.ok(pub.publish(boxes, VP, 1));
    assert.equal(pub.publish(boxes, VP, 1), null);
    assert.equal(sent.length, 1);
  });

  test('the same set in a different input order is not sent again', () => {
    const { pub, sent } = harness();
    const a = box(10, 10, 20, 20);
    const b = box(40, 10, 5, 5, { priority: 0 });
    assert.ok(pub.publish([a, b], VP, 1));
    assert.equal(pub.publish([b, a], VP, 1), null);
    assert.equal(sent.length, 1);
  });

  test('a sub-pixel move that snaps to the same pixels is not sent again', () => {
    const { pub, sent } = harness();
    assert.ok(pub.publish([box(10.2, 10, 5, 5)], VP, 1));
    assert.equal(pub.publish([box(10.4, 10, 5, 5)], VP, 1), null);
    assert.equal(sent.length, 1);
  });

  test('a change of wall clock alone is not sent again', () => {
    const { pub, sent, setNow } = harness();
    assert.ok(pub.publish([box(10, 10, 5, 5)], VP, 1));
    setNow(T0 + 1000);
    assert.equal(pub.publish([box(10, 10, 5, 5)], VP, 1), null);
    assert.equal(sent.length, 1);
  });

  test('a 1 px move is sent again', () => {
    const { pub, sent } = harness();
    assert.ok(pub.publish([box(10, 10, 20, 20)], VP, 1));
    const msg = pub.publish([box(11, 10, 20, 20)], VP, 1);
    assert.ok(msg);
    assert.equal(msg.rects[0]!.x, 11);
    assert.equal(sent.length, 2);
  });

  test('a change of kind or agent is sent again', () => {
    const { pub, sent } = harness();
    assert.ok(pub.publish([box(10, 10, 20, 20, { kind: 'resident' })], VP, 1));
    assert.ok(pub.publish([box(10, 10, 20, 20, { kind: 'card' })], VP, 1));
    assert.ok(pub.publish([box(10, 10, 20, 20, { kind: 'card', agent: AGENT_A })], VP, 1));
    assert.equal(sent.length, 3);
  });

  test('a change of viewport or scale is sent again', () => {
    const { pub, sent } = harness();
    assert.ok(pub.publish([box(10, 10, 5, 5)], VP, 1));
    assert.ok(pub.publish([box(10, 10, 5, 5)], { w: 120, h: 100 }, 1));
    assert.ok(pub.publish([box(10, 10, 5, 5)], { w: 120, h: 100 }, 2));
    assert.equal(sent.length, 3);
  });

  test('an empty list is sent once, then not again while it stays empty', () => {
    const { pub, sent } = harness();
    const first = pub.publish([], VP, 1);
    assert.ok(first);
    assert.deepEqual(first.rects, []);
    expectValid(first);
    assert.equal(pub.publish([], VP, 1), null);
    assert.equal(sent.length, 1);
    const next = pub.publish([box(10, 10, 5, 5)], VP, 1);
    assert.ok(next);
    assert.equal(sent.length, 2);
  });

  test('an empty list that follows a non-empty set is sent', () => {
    const { pub, sent } = harness();
    assert.ok(pub.publish([box(10, 10, 5, 5)], VP, 1));
    const msg = pub.publish([box(-50, 0, 10, 10)], VP, 1); // fully outside, so the list is now empty
    assert.ok(msg);
    assert.deepEqual(msg.rects, []);
    assert.equal(sent.length, 2);
  });

  test('last() returns the last message sent, or null', () => {
    const { pub } = harness();
    assert.equal(pub.last(), null);
    const msg = pub.publish([box(10, 10, 5, 5)], VP, 1);
    assert.ok(msg);
    assert.equal(pub.last(), msg);
    assert.equal(pub.publish([box(10, 10, 5, 5)], VP, 1), null);
    assert.equal(pub.last(), msg);
  });

  test('reset() forces the next publish to send, even for an unchanged set', () => {
    const { pub, sent } = harness();
    const boxes = [box(10, 10, 5, 5)];
    assert.ok(pub.publish(boxes, VP, 1));
    assert.equal(pub.publish(boxes, VP, 1), null);
    pub.reset();
    assert.equal(pub.last(), null);
    const again = pub.publish(boxes, VP, 1);
    assert.ok(again);
    assert.equal(sent.length, 2);
    expectValid(again);
  });
});

// Deterministic PRNG (mulberry32), so the property test sees the same inputs on every run.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('property: every message validates', () => {
  test('300 random inputs, every sent message validates against HitRects v1', () => {
    const rnd = mulberry32(0x5eed1);
    const real = (lo: number, hi: number) => lo + rnd() * (hi - lo);
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const AGENTS: Array<string | undefined> = [
      AGENT_A,
      AGENT_B,
      'A'.repeat(32),
      'xyz',
      '550e8400-e29b-41d4-a716-446655440000',
      undefined,
    ];

    const coord = () => (rnd() < 0.25 ? real(-20000, 20000) : real(-50, 6000));
    const extent = () => (rnd() < 0.15 ? real(-100, 0.9) : rnd() < 0.25 ? real(0, 3) : real(0, 20000));
    const randomBox = (): HitBox => {
      const b: HitBox = {
        x: coord(),
        y: coord(),
        w: extent(),
        h: extent(),
        kind: pick(RECT_KINDS),
        priority: int(0, 3),
      };
      const agent = pick(AGENTS);
      if (agent !== undefined) b.agent = agent;
      return b;
    };

    const { pub, sent } = harness();
    let prevBoxes: HitBox[] = [];
    let prevVp = { w: 0, h: 0 };
    let prevScale = 0;
    let checked = 0;
    for (let iter = 0; iter < 300; iter++) {
      const repeat = iter > 0 && rnd() < 0.2;
      const vp = repeat ? prevVp : { w: int(1, 5120), h: int(1, 400) };
      const scale = repeat ? prevScale : real(0.4, 9);
      const boxes = repeat ? prevBoxes : Array.from({ length: int(0, 90) }, randomBox);

      const msg = pub.publish(boxes, vp, scale);
      if (repeat) {
        assert.equal(msg, null, `iteration ${iter}: identical inputs must not send`);
      }
      if (msg) {
        expectValid(msg);
        assert.ok(msg.rects.length <= 64);
        for (const r of msg.rects) {
          assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y), `iteration ${iter}: whole-pixel origin`);
          assert.ok(r.w >= 1 && r.h >= 1, `iteration ${iter}: extent at least 1 px`);
          assert.ok(r.x + r.w <= msg.viewport.w && r.y + r.h <= msg.viewport.h, `iteration ${iter}: inside viewport`);
        }
        checked++;
      }
      prevBoxes = boxes;
      prevVp = vp;
      prevScale = scale;
    }
    assert.equal(sent.length, checked);
    assert.ok(checked > 100, `expected many sends, got ${checked}`);
    for (const msg of sent) expectValid(msg);
  });
});
