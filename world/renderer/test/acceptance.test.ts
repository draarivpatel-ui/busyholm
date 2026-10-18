/**
 * WP-10 acceptance tests (SPEC 9.1), run headless in Node with virtual time.
 * (1) scripted Snapshot and Moment sequences show the right animation on the next frame (debug log);
 * (2) a needs_you Moment shows the flag within 250 ms p95 inside the renderer;
 * (3) calm <= 12 fps, celebration <= 30 fps for <= 3 s, hidden 0 fps;
 * (4) hit rects update within 1 frame, at most 64;
 * (5) reduced motion still shows the alert.
 * tools/browser-tests.mjs repeats (2) and (3) in real Chrome with real timers.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../src/index.ts';
import type { DebugFrame, Renderer, RendererOptions } from '../src/api.ts';
import type { HitRects } from '../../../contracts/ts/src/types.ts';
import { validate } from '../../../contracts/ts/src/validate.ts';
import { agent, hamlet, moment, snapshot, tools, percentile, hexId, T0 } from './helpers.ts';

function setup(o: Partial<RendererOptions> = {}): { r: Renderer; sent: HitRects[] } {
  const sent: HitRects[] = [];
  const r = createRenderer({
    surface: 'strip',
    width: 1440,
    height: 120,
    dpr: 2,
    scheduler: 'manual',
    debug: true,
    date: () => new Date(2026, 9, 12, 16, 0, 0),
    onHitRects: (m) => sent.push(m),
    ...o,
  });
  r.setWorld(hamlet());
  return { r, sent };
}

function last(r: Renderer): DebugFrame {
  const log = r.debugLog();
  assert.ok(log.length > 0, 'no frame drawn');
  return log[log.length - 1];
}

function resident(f: DebugFrame, id: string) {
  return f.residents.find((x) => x.id === id);
}

const A = hexId(1);
const B = hexId(2, 'b');

describe('(1) scripted sequences show the right animation on the next frame', () => {
  const cases: [string, Parameters<typeof agent>[1], (f: DebugFrame) => void][] = [
    ['starting', { state: 'starting' }, (f) => assert.equal(resident(f, A)?.intent, 'starting')],
    ...(['shell', 'edit', 'read', 'web', 'delegate', 'other'] as const).map(
      (activity) =>
        [
          `working ${activity}`,
          { state: 'working', activity },
          (f: DebugFrame) => {
            assert.equal(resident(f, A)?.intent, 'work');
            assert.equal(resident(f, A)?.variant, activity);
          },
        ] as [string, Parameters<typeof agent>[1], (f: DebugFrame) => void],
    ),
    ['your_turn', { state: 'your_turn' }, (f) => assert.equal(resident(f, A)?.intent, 'your_turn')],
    ['error', { state: 'error' }, (f) => assert.equal(resident(f, A)?.intent, 'worried')],
    ['limited', { state: 'limited', limited_until: T0 + 3600000 }, (f) => assert.equal(resident(f, A)?.intent, 'limited')],
    ['idle', { state: 'idle' }, (f) => assert.ok(['idle', 'asleep'].includes(resident(f, A)?.intent ?? ''))],
    [
      'unknown is drawn as idle, faded',
      { state: 'unknown' },
      (f) => {
        assert.ok(['idle', 'asleep'].includes(resident(f, A)?.intent ?? ''));
        assert.equal(resident(f, A)?.faded, true);
      },
    ],
    [
      'needs_you from a snapshot alone raises the flag with the right icon',
      { state: 'needs_you', reason: 'question' },
      (f) => {
        assert.equal(resident(f, A)?.intent, 'alert');
        assert.equal(f.flag.raised, true);
        assert.equal(f.flag.icon, 'question');
      },
    ],
  ];
  for (const [name, opts, check] of cases) {
    test(name, () => {
      const { r } = setup();
      r.advance(500);
      const before = r.stats().drawn;
      r.setSnapshot(snapshot([agent(1, opts)]));
      r.advance(1);
      assert.ok(r.stats().drawn > before, 'the input drew a frame');
      check(last(r));
    });
  }

  test('a working resident reaches its work loop and steps through poses', () => {
    const { r } = setup();
    r.setSnapshot(snapshot([agent(1, { state: 'working', activity: 'edit' })]));
    r.advance(8000);
    const poses = new Set(r.debugLog().slice(-40).map((f) => resident(f, A)?.pose));
    assert.equal(resident(last(r), A)?.anim, 'work');
    assert.ok(poses.size >= 2, `work loop steps through poses, saw ${[...poses]}`);
  });

  test('needs_you Moment: flag on the next frame, then anticipation, run, ring', () => {
    const { r } = setup();
    r.setSnapshot(snapshot([agent(1, { state: 'working', activity: 'edit' })]));
    r.advance(6000);
    r.pushMoment(moment({ kind: 'needs_you', agent: A, tool: 'claude', reason: 'permission' }));
    r.advance(1);
    const f = last(r);
    assert.equal(f.flag.raised, true);
    assert.equal(f.flag.icon, 'permission');
    assert.equal(f.flag.ringing, true);
    assert.equal(resident(f, A)?.intent, 'alert');
    assert.equal(resident(f, A)?.anim, 'turn');
    r.advance(400);
    assert.equal(resident(last(r), A)?.anim, 'run');
    r.advance(3000);
    assert.ok(['ring', 'wait-bell'].includes(resident(last(r), A)?.anim ?? ''));
  });

  test('waiting() lists who waits and since when, oldest first, and nothing else', () => {
    const { r } = setup();
    r.setSnapshot(snapshot([agent(1, { state: 'working' }), agent(2, { id: B, tool: 'codex', state: 'working' })]));
    r.advance(500);
    r.pushMoment(moment({ kind: 'needs_you', agent: B, tool: 'codex', reason: 'question', t: T0 + 1000 }));
    r.pushMoment(moment({ kind: 'needs_you', agent: A, tool: 'claude', reason: 'permission', t: T0 + 4000 }));
    const w = r.waiting();
    assert.deepEqual(w.map((x) => [x.id, x.tool, x.reason, x.since]), [[B, 'codex', 'question', T0 + 1000], [A, 'claude', 'permission', T0 + 4000]]);
    for (const x of w) assert.deepEqual(Object.keys(x).sort(), ['id', 'ordinal', 'reason', 'scarf', 'since', 'species', 'tool']);
    r.pushMoment(moment({ kind: 'answered', agent: B, tool: 'codex', t: T0 + 5000 }));
    assert.deepEqual(r.waiting().map((x) => x.id), [A]);
  });

  test('a needs_you Moment for an agent no snapshot has shown yet still raises the flag', () => {
    const { r } = setup();
    r.advance(500);
    r.pushMoment(moment({ kind: 'needs_you', agent: B, tool: 'codex', reason: 'question' }));
    r.advance(1);
    assert.equal(last(r).flag.raised, true);
    assert.equal(last(r).flag.icon, 'question');
  });

  test('answered lowers the flag and the resident goes back to work', () => {
    const { r } = setup();
    r.setSnapshot(snapshot([agent(1, { state: 'needs_you' })]));
    r.advance(3000);
    r.pushMoment(moment({ kind: 'answered', agent: A, tool: 'claude' }));
    r.setSnapshot(snapshot([agent(1, { state: 'working', activity: 'shell' })]));
    r.advance(1);
    assert.equal(last(r).flag.raised, false);
    assert.equal(resident(last(r), A)?.intent, 'work');
  });

  test('turn_end Moment: cheer on the next frame and a plank flies to the build site', () => {
    const { r } = setup();
    r.setSnapshot(snapshot([agent(1, { state: 'working', activity: 'edit' })]));
    r.advance(6000);
    r.pushMoment(moment({ kind: 'turn_end', agent: A, tool: 'claude', turn_ms: 200000 }));
    r.advance(1);
    assert.equal(resident(last(r), A)?.intent, 'celebrate');
    assert.equal(resident(last(r), A)?.anim, 'cheer');
    r.advance(300);
    assert.ok(last(r).fx.includes('plank'), `fx: ${last(r).fx}`);
    r.setSnapshot(snapshot([agent(1, { state: 'your_turn' })]));
    r.advance(1500);
    assert.equal(resident(last(r), A)?.intent, 'your_turn');
  });

  test('build_complete Moment: a dust puff on the next frame', () => {
    const { r } = setup();
    r.advance(500);
    r.pushMoment(moment({ kind: 'build_complete', structure: 'watermill', stage: 3 }));
    r.advance(1);
    assert.ok(last(r).fx.includes('dust'), `fx: ${last(r).fx}`);
  });

  test('a subagent is drawn as a helper', () => {
    const { r } = setup();
    r.setSnapshot(snapshot([agent(1, { state: 'working' }), agent(2, { id: B, state: 'working', parent: A, ordinal: 2 })]));
    r.advance(1);
    const h = resident(last(r), B);
    assert.equal(h?.helper, true);
    assert.equal(h?.intent, 'helper');
  });

  test('an agent that leaves the snapshot walks home, then is removed', () => {
    const { r } = setup();
    r.setSnapshot(snapshot([agent(1, { state: 'idle' })]));
    r.advance(2000);
    r.setSnapshot(snapshot([]));
    r.advance(1);
    assert.equal(resident(last(r), A)?.intent, 'leaving');
    r.advance(15000);
    assert.equal(resident(last(r), A), undefined);
  });

  test('an offline tool has no resident outside', () => {
    const { r } = setup();
    r.setSnapshot(snapshot([], { tools: tools([], ['claude', 'codex']) }));
    r.advance(1000);
    assert.equal(last(r).residents.length, 0);
  });
});

describe('(2) a needs_you Moment shows the flag within 250 ms p95', () => {
  test('latency from pushMoment to the first frame with the flag, 60 episodes in calm mode', () => {
    const { r } = setup();
    r.setSnapshot(snapshot([agent(1, { state: 'working' }), agent(2, { id: B, tool: 'codex', state: 'working' })]));
    r.advance(4000);
    const lat: number[] = [];
    let seed = 7;
    for (let i = 0; i < 60; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      r.advance(3000 + (seed % 997));
      const id = i % 2 ? A : B;
      const tool = i % 2 ? 'claude' : 'codex';
      const t0 = r.debugLog().length ? last(r).t : 0;
      r.pushMoment(moment({ kind: 'needs_you', agent: id, tool, reason: 'permission' }));
      const start = t0;
      let seen = -1;
      for (let k = 0; k < 50 && seen < 0; k++) {
        r.advance(5);
        const f = r.debugLog().find((x) => x.t >= start && x.flag.raised);
        if (f) seen = f.sinceInput;
      }
      assert.ok(seen >= 0, 'flag never shown');
      lat.push(seen);
      r.pushMoment(moment({ kind: 'answered', agent: id, tool }));
    }
    assert.ok(percentile(lat, 95) <= 250, `p95 ${percentile(lat, 95)} ms`);
  });
});

describe('(3) frame governor', () => {
  function framesIn(r: Renderer, from: number, to: number): number {
    return r.debugLog().filter((f) => f.t >= from && f.t < to).length;
  }

  test('calm: at most 12 drawn frames in any second', () => {
    const { r } = setup();
    r.setSnapshot(snapshot([agent(1, { state: 'working' }), agent(2, { id: B, tool: 'codex', state: 'idle' })]));
    r.advance(4000);
    const t0 = last(r).t;
    r.advance(10000);
    for (let a = t0; a < t0 + 9000; a += 25) assert.ok(framesIn(r, a, a + 1000) <= 12, `window at ${a - t0} ms: ${framesIn(r, a, a + 1000)}`);
    assert.equal(r.stats().mode, 'calm');
  });

  test('celebration: at most 30 fps, and back to calm within 3 s', () => {
    const { r } = setup();
    r.setSnapshot(snapshot([agent(1, { state: 'working' })]));
    r.advance(5000);
    const t0 = last(r).t;
    r.pushMoment(moment({ kind: 'turn_end', agent: A, tool: 'claude' }));
    r.advance(6000);
    for (let a = t0 - 1000; a < t0 + 6000; a += 25) assert.ok(framesIn(r, a, a + 1000) <= 30, `window at ${a - t0} ms: ${framesIn(r, a, a + 1000)}`);
    assert.ok(framesIn(r, t0, t0 + 1000) > 12, 'the celebration actually bursts above calm');
    // nothing above calm rate after 3 s
    for (let s = 3; s < 6; s++) assert.ok(framesIn(r, t0 + s * 1000 + 50, t0 + (s + 1) * 1000 + 50) <= 12, `second ${s} after the moment`);
  });

  test('hidden: 0 fps, even while moments arrive; resumes when shown', () => {
    const { r } = setup();
    r.setSnapshot(snapshot([agent(1, { state: 'working' })]));
    r.advance(2000);
    r.setVisible(false);
    const s0 = r.stats();
    r.pushMoment(moment({ kind: 'needs_you', agent: A, tool: 'claude', reason: 'permission' }));
    r.advance(5000);
    const s1 = r.stats();
    assert.equal(s1.drawn, s0.drawn);
    assert.equal(s1.ticks, s0.ticks);
    assert.equal(s1.mode, 'hidden');
    r.setVisible(true);
    r.advance(1);
    assert.ok(r.stats().drawn > s1.drawn);
    assert.equal(last(r).flag.raised, true);
  });
});

describe('(4) hit rects', () => {
  test('at most 64, valid against HitRects v1, even with 64 agents', () => {
    const { r, sent } = setup();
    const many = Array.from({ length: 64 }, (_, i) =>
      agent(i + 1, { id: hexId(i + 1, 'm'), tool: (['claude', 'codex', 'opencode', 'antigravity'] as const)[i % 4], ordinal: Math.floor(i / 4) + 1, state: i % 7 === 0 ? 'needs_you' : 'working' }),
    );
    r.setSnapshot(snapshot(many));
    r.advance(3000);
    assert.ok(sent.length > 0);
    for (const m of sent) {
      assert.ok(m.rects.length <= 64);
      const v = validate('hitRects', m);
      assert.ok(v.ok, JSON.stringify(!v.ok && v.issues.slice(0, 2)));
    }
  });

  test('every drawn frame publishes the boxes it drew (within one frame) while a resident runs', () => {
    const { r } = setup();
    r.setSnapshot(snapshot([agent(1, { state: 'working' })]));
    r.advance(3000);
    r.pushMoment(moment({ kind: 'needs_you', agent: A, tool: 'claude', reason: 'permission' }));
    let checked = 0;
    for (let k = 0; k < 60; k++) {
      r.advance(1000 / 30);
      const f = last(r);
      const b = resident(f, A)?.box;
      const hr = r.lastHitRects();
      assert.ok(b && hr);
      const rect = hr.rects.find((x) => x.agent === A);
      assert.ok(rect, 'resident rect published');
      assert.ok(rect.x <= b.x + 0.001 && rect.y <= b.y + 0.001, 'rect covers the box');
      assert.ok(rect.x + rect.w >= b.x + b.w - 0.001 && rect.y + rect.h >= b.y + b.h - 0.001, 'rect covers the box');
      assert.ok(rect.x > b.x - 1.001 && rect.y > b.y - 1.001, 'rect is the snapped box, not a stale one');
      checked++;
    }
    assert.ok(checked > 0);
  });
});

describe('(5) reduced motion', () => {
  test('the alert still shows; no puppet loops; render on change only', () => {
    const { r } = setup({ reducedMotion: true });
    r.setSnapshot(snapshot([agent(1, { state: 'working' })]));
    r.advance(2000);
    const d0 = r.stats().drawn;
    r.advance(5000);
    assert.ok(r.stats().drawn - d0 <= 1, 'static scene renders on change only');
    r.pushMoment(moment({ kind: 'needs_you', agent: A, tool: 'claude', reason: 'question' }));
    r.advance(1);
    const f = last(r);
    assert.equal(f.flag.raised, true);
    assert.equal(f.flag.icon, 'question');
    const pose = resident(f, A)?.pose;
    r.setSnapshot(snapshot([agent(1, { state: 'needs_you', reason: 'question' })]));
    r.advance(5000);
    assert.equal(last(r).flag.raised, true);
    const poses = new Set(r.debugLog().filter((x) => x.t > f.t).map((x) => resident(x, A)?.pose));
    assert.ok(poses.size <= 1, `static pose, saw ${[...poses]} after ${pose}`);
    assert.equal(r.stats().mode, 'reduced');
  });
});
