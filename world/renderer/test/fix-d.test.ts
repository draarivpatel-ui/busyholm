/**
 * FIX-D: findings of code review r1 that concern the renderer (M10, M11, M16, L1)
 * and the demo-mode requests: bell post in frame during an alert, no resident
 * sliced by a moving camera, a needs-you card that reads at thumbnail size.
 * Headless, in virtual time; the model is driven directly where a display list is needed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../src/index.ts';
import type { DebugFrame, Renderer, RendererOptions } from '../src/api.ts';
import { WorldModel, type DisplayList, type ModelOptions } from '../src/model.ts';
import { buildLayout } from '../src/layout.ts';
import { cardMetrics } from '../src/pages/card.ts';
import { agent, hamlet, moment, snapshot, tools, hexId, T0 } from './helpers.ts';

const A = hexId(1);
const B = hexId(2, 'b');
const AFTERNOON = () => new Date(2026, 9, 12, 16, 0, 0);

function model(o: Partial<ModelOptions> = {}): WorldModel {
  const m = new WorldModel({
    surface: 'strip',
    seed: 11,
    reducedMotion: false,
    species: {},
    hemisphere: 'north',
    skyMode: 'usage_and_clock',
    date: AFTERNOON,
    pxPerUnit: 2,
    ...o,
  });
  m.setWorld(hamlet(), 0);
  return m;
}

const VISIBLE_W = 1920 / 4.6;
function ambient(startX?: number, o: Partial<ModelOptions> = {}): WorldModel {
  return model({ surface: 'ambient', ambientView: { visibleW: VISIBLE_W, panSpeed: 7, startX }, pxPerUnit: 2.3, ...o });
}

/** Steps a model at fps from t0 to t1 (seconds), calling each(dl, t) per frame. */
function run(m: WorldModel, t0: number, t1: number, fps: number, each?: (dl: DisplayList, t: number) => void, calm = false): DisplayList {
  let dl!: DisplayList;
  const n = Math.round((t1 - t0) * fps);
  for (let i = 0; i <= n; i++) {
    const t = t0 + i / fps;
    dl = m.step(t, calm);
    each?.(dl, t);
  }
  return dl;
}

const find = (dl: DisplayList, id: string) => dl.residents.find((r) => r.id === id);

describe('M10: alert teardown', () => {
  test('a waiting resident that disappears from the snapshot stops being an alert and walks home', () => {
    const m = model();
    m.setSnapshot(snapshot([agent(1, { state: 'needs_you' })], { t: T0 }), 1);
    run(m, 1, 4, 30);
    assert.equal(find(run(m, 4, 4, 30), A)?.intent, 'alert');
    m.setSnapshot(snapshot([], { t: T0 + 5000, tools: tools([]) }), 4.1);
    const dl = run(m, 4.1, 4.2, 30);
    assert.equal(dl.flag.raised, false, 'the flag comes down');
    assert.notEqual(find(dl, A)?.intent, 'alert', 'the resident is no longer at the bell');
    const gone = run(m, 4.2, 40, 12);
    assert.equal(find(gone, A), undefined, 'removed after walking home');
  });

  test('a needs_you Moment newer than the snapshot is kept when the snapshot does not list the agent yet', () => {
    const m = model();
    m.setSnapshot(snapshot([agent(2, { id: B, state: 'working' })], { t: T0 }), 1);
    m.pushMoment(moment({ kind: 'needs_you', agent: A, tool: 'claude', reason: 'permission', t: T0 + 2000 }), 2);
    m.setSnapshot(snapshot([agent(2, { id: B, state: 'working' })], { t: T0 + 1000 }), 2.5);
    const dl = run(m, 2.5, 5, 30);
    assert.equal(dl.flag.raised, true);
    assert.equal(find(dl, A)?.intent, 'alert');
  });

  test('an error Moment ends the wait at once: flag down, resident worried', () => {
    const m = model();
    m.setSnapshot(snapshot([agent(1, { state: 'working' })], { t: T0 }), 1);
    m.pushMoment(moment({ kind: 'needs_you', agent: A, tool: 'claude', reason: 'permission', t: T0 + 1000 }), 2);
    run(m, 2, 5, 30);
    m.pushMoment(moment({ kind: 'error', agent: A, tool: 'claude', t: T0 + 4000 }), 5);
    const dl = run(m, 5, 5.1, 30);
    assert.equal(dl.flag.raised, false, 'the flag comes down without waiting for a snapshot');
    assert.deepEqual(m.waiting(), []);
    assert.equal(find(dl, A)?.intent, 'worried');
  });

  test('a turn_end Moment also ends the wait', () => {
    const m = model();
    m.setSnapshot(snapshot([agent(1, { state: 'working' })], { t: T0 }), 1);
    m.pushMoment(moment({ kind: 'needs_you', agent: A, tool: 'claude', reason: 'question', t: T0 + 1000 }), 2);
    run(m, 2, 5, 30);
    m.pushMoment(moment({ kind: 'turn_end', agent: A, tool: 'claude', turn_ms: 4000, t: T0 + 4000 }), 5);
    const dl = run(m, 5, 5.1, 30);
    assert.equal(dl.flag.raised, false);
    assert.notEqual(find(dl, A)?.intent, 'alert');
  });
});

describe('M11: ambient camera uses the unquantized time step', () => {
  test('a panning camera moves on every 30 fps frame, not on every second or third', () => {
    const m = ambient();
    m.setSnapshot(snapshot([agent(1, { state: 'working' })], { t: T0 }), 0.5);
    const xs: number[] = [];
    run(m, 1, 12, 30, (dl, t) => {
      if (t >= 8 && t < 9) xs.push(dl.camX);
    });
    assert.ok(xs.length >= 29);
    let changed = 0;
    for (let i = 1; i < xs.length; i++) if (xs[i] !== xs[i - 1]) changed++;
    assert.ok(changed >= xs.length - 2, `camera changed on ${changed} of ${xs.length - 1} frames`);
  });

  test('the same camera path at 30 and at 120 fps (frame rate independent)', () => {
    const at = (fps: number) => {
      const m = ambient();
      m.setSnapshot(snapshot([agent(1, { state: 'working' })], { t: T0 }), 0.5);
      return run(m, 1, 20, fps).camX;
    };
    assert.ok(Math.abs(at(30) - at(120)) < 0.5, `${at(30)} vs ${at(120)}`);
  });

  test('easing toward a waiting resident moves on every frame too', () => {
    const m = ambient(0);
    m.setSnapshot(snapshot([agent(1, { state: 'working' })], { t: T0 }), 0.5);
    run(m, 1, 3, 30);
    m.pushMoment(moment({ kind: 'needs_you', agent: A, tool: 'claude', reason: 'permission', t: T0 + 1000 }), 3);
    const xs: number[] = [];
    run(m, 3, 3.5, 30, (dl) => xs.push(dl.camX));
    let changed = 0;
    for (let i = 1; i < xs.length; i++) if (xs[i] !== xs[i - 1]) changed++;
    assert.ok(changed >= xs.length - 2, `camera changed on ${changed} of ${xs.length - 1} frames`);
  });
});

function setup(o: Partial<RendererOptions> = {}): { r: Renderer; sent: unknown[] } {
  const sent: unknown[] = [];
  const r = createRenderer({
    surface: 'strip',
    width: 1440,
    height: 120,
    dpr: 2,
    scheduler: 'manual',
    debug: true,
    date: () => new Date(2026, 0, 15, 16, 0, 0),
    onHitRects: (msg) => sent.push(msg),
    ...o,
  });
  r.setWorld(hamlet());
  return { r, sent };
}
const lastFrame = (r: Renderer): DebugFrame => {
  const log = r.debugLog();
  assert.ok(log.length > 0, 'no frame drawn');
  return log[log.length - 1];
};

describe('M16: settings changes take effect while the page runs', () => {
  test('hemisphere changes the season', () => {
    const { r } = setup();
    r.setSnapshot(snapshot([agent(1)]));
    r.advance(500);
    assert.equal(lastFrame(r).sky.season, 'winter', 'January, north');
    r.updateSettings({ hemisphere: 'south' });
    r.advance(500);
    assert.equal(lastFrame(r).sky.season, 'autumn', 'January, south');
  });

  test('sky mode: clock_only ignores a fresh usage sample', () => {
    const { r } = setup();
    const limits = [{ provider: 'claude' as const, window: '5h' as const, account_id: hexId(9), root_id: hexId(8), used_pct: 5, resets_at: T0 + 3600000, observed_at: T0 - 1000, stale: false }];
    // the date is 16:00 local; a fresh 5 % sample reads as early morning
    r.setSnapshot(snapshot([agent(1)], { limits }));
    r.advance(8000);
    const usage = lastFrame(r).sky.phase;
    r.updateSettings({ skyMode: 'clock_only' });
    r.advance(8000);
    const clock = lastFrame(r).sky.phase;
    assert.ok(Math.abs(clock - usage) > 0.05, `phase ${usage} should move to the clock phase, got ${clock}`);
  });

  test('species per tool: existing residents change species, the rest follow the default', () => {
    const { r } = setup();
    r.setSnapshot(snapshot([agent(1, { state: 'working' }), agent(2, { id: B, tool: 'codex', state: 'working' })]));
    r.advance(500);
    const before = lastFrame(r).residents.find((x) => x.id === A)!.species;
    const codex = lastFrame(r).residents.find((x) => x.id === B)!.species;
    const pick = (['beaver', 'frog', 'hare', 'hedgehog', 'otter'] as const).find((s) => s !== before && s !== codex)!;
    r.updateSettings({ species: { claude: pick } });
    r.advance(500);
    const f = lastFrame(r);
    assert.equal(f.residents.find((x) => x.id === A)!.species, pick);
    assert.equal(f.residents.find((x) => x.id === B)!.species, codex, 'codex keeps its own species');
    assert.equal(r.waiting().length, 0);
  });

  test('species applies to a resident waiting on you too (card portrait)', () => {
    const { r } = setup();
    r.setSnapshot(snapshot([agent(1, { state: 'needs_you' })]));
    r.advance(500);
    const before = r.waiting()[0].species;
    const pick = before === 'otter' ? 'hare' : 'otter';
    r.updateSettings({ species: { claude: pick } });
    assert.equal(r.waiting()[0].species, pick);
  });

  test('unknown species names fall back, and omitted fields change nothing', () => {
    const { r } = setup();
    r.setSnapshot(snapshot([agent(1, { state: 'working' })]));
    r.advance(500);
    const before = lastFrame(r);
    r.updateSettings({});
    r.advance(500);
    assert.equal(lastFrame(r).sky.season, before.sky.season);
    r.updateSettings({ species: { claude: 'no-such-animal' } });
    r.advance(500);
    assert.equal(lastFrame(r).residents.find((x) => x.id === A)!.species, 'hedgehog');
  });
});

describe('L1: extra hit boxes publish without a pixel change', () => {
  test('changing extraHitBoxes in a static reduced-motion scene republishes on the next tick', () => {
    let boxes: { x: number; y: number; w: number; h: number; kind: 'other' }[] = [{ x: 10, y: 10, w: 40, h: 40, kind: 'other' }];
    const { r, sent } = setup({ reducedMotion: true, extraHitBoxes: () => boxes });
    r.setSnapshot(snapshot([agent(1, { state: 'working' })]));
    r.advance(2000);
    const drawn = r.stats().drawn;
    const n0 = sent.length;
    assert.ok(r.lastHitRects()!.rects.some((x) => x.x === 10 && x.y === 10 && x.kind === 'other'));
    boxes = [{ x: 300, y: 20, w: 50, h: 30, kind: 'other' }];
    r.refreshHitRects();
    r.advance(100);
    assert.equal(r.stats().drawn, drawn, 'nothing was redrawn: the picture did not change');
    assert.ok(sent.length > n0, 'a new HitRects message went out');
    const rects = r.lastHitRects()!.rects;
    assert.ok(rects.some((x) => x.x === 300 && x.kind === 'other'));
    assert.ok(!rects.some((x) => x.x === 10 && x.kind === 'other'), 'the old clickable area is gone');
  });

  test('an ordinary tick with unchanged boxes sends nothing', () => {
    const { r, sent } = setup({ reducedMotion: true, extraHitBoxes: () => [{ x: 10, y: 10, w: 40, h: 40, kind: 'other' }] });
    r.setSnapshot(snapshot([agent(1, { state: 'working' })]));
    r.advance(2000);
    const n0 = sent.length;
    r.refreshHitRects();
    r.advance(100);
    assert.equal(sent.length, n0);
  });
});

describe('WP-13 NEEDS 1: the bell post stays in frame while an alert is raised', () => {
  const layout = buildLayout(hamlet(), 11);
  const bellX = layout.bell.x;
  const inFrame = (camX: number) => bellX >= camX + 30 && bellX <= camX + VISIBLE_W - 50;
  const farTool = (['claude', 'codex'] as const).reduce((a, b) => (Math.abs(layout.workshop.get(a)!.x - bellX) > Math.abs(layout.workshop.get(b)!.x - bellX) ? a : b));

  function episode(startX: number | undefined, tool: 'claude' | 'codex', graceS: number) {
    const m = ambient(startX);
    const id = tool === 'claude' ? A : B;
    m.setSnapshot(snapshot([agent(1, { id, tool, state: 'working' })], { t: T0 }), 0.5);
    run(m, 1, 6, 30);
    m.pushMoment(moment({ kind: 'needs_you', agent: id, tool, reason: 'permission', t: T0 + 6000 }), 6);
    const bad: number[] = [];
    run(m, 6, 14, 30, (dl, t) => {
      if (t - 6 >= graceS && !inFrame(dl.camX)) bad.push(Math.round((t - 6) * 100) / 100);
    });
    return bad;
  }

  test('the resident far from the post raises the alert from a camera that had the post in view', () => {
    const bad = episode(Math.max(0, bellX - VISIBLE_W * 0.4), farTool, 0);
    assert.deepEqual(bad, [], `post out of frame at ${bad.slice(0, 5)}... (${bad.length} frames)`);
  });

  test('from a camera far away the post is in frame within 0.6 s and stays', () => {
    for (const startX of [0, 1020]) {
      const bad = episode(startX, farTool, 0.6);
      assert.deepEqual(bad, [], `startX ${startX}: post out of frame at ${bad.slice(0, 5)}`);
    }
  });

  test('both tools, and in reduced motion too', () => {
    for (const tool of ['claude', 'codex'] as const) assert.deepEqual(episode(Math.max(0, bellX - VISIBLE_W * 0.4), tool, 0), []);
    const m = ambient(0, { reducedMotion: true });
    m.setSnapshot(snapshot([agent(1, { id: B, tool: 'codex', state: 'working' })], { t: T0 }), 0.5);
    m.pushMoment(moment({ kind: 'needs_you', agent: B, tool: 'codex', reason: 'permission', t: T0 + 1000 }), 1);
    const dl = run(m, 1, 3, 12);
    assert.ok(inFrame(dl.camX), `reduced camera at ${dl.camX}`);
  });
});

describe('WP-13 NEEDS 2: a moving camera does not hold a frame edge across a resident', () => {
  test('over a full pan, no resident stays sliced for more than 1 s', () => {
    const m = ambient(0);
    const list = [];
    for (let i = 0; i < 4; i++) list.push(agent(i + 1, { id: hexId(i + 1), tool: 'claude', ordinal: i + 1, state: 'idle' }));
    for (let i = 0; i < 3; i++) list.push(agent(i + 10, { id: hexId(i + 10, 'c'), tool: 'codex', ordinal: i + 1, state: 'idle' }));
    m.setSnapshot(snapshot(list, { t: T0 }), 0.5);
    let runLen = 0;
    let worst = 0;
    let at = 0;
    let moving = 0;
    const dt = 1 / 30;
    run(m, 1, 330, 30, (dl, t) => {
      const lo = dl.camX;
      const hi = dl.camX + VISIBLE_W;
      const sliced = dl.residents.some((r) => !r.helper && ((r.x - 12 < lo && r.x + 12 > lo) || (r.x - 12 < hi && r.x + 12 > hi)));
      if (sliced) {
        runLen += dt;
        if (runLen > worst) {
          worst = runLen;
          at = t;
        }
      } else runLen = 0;
      if (dl.cameraMoving) moving++;
    });
    assert.ok(moving > 5000, 'the camera really panned');
    assert.ok(worst <= 1, `a resident was sliced for ${worst.toFixed(2)} s (ending near t=${at.toFixed(1)})`);
  });
});

describe('WP-13 NEEDS 3: the needs-you card reads when the frame is scaled to 460 px wide', () => {
  for (const viewW of [1280, 1920, 2560]) {
    test(`${viewW} px view`, () => {
      const c = cardMetrics(viewW);
      const thumb = 460 / viewW;
      assert.ok(c.title * thumb >= 9.5, `title ${(c.title * thumb).toFixed(1)} px`);
      assert.ok(c.sub * thumb >= 8, `second line ${(c.sub * thumb).toFixed(1)} px`);
      assert.ok(c.more * thumb >= 7, `more line ${(c.more * thumb).toFixed(1)} px`);
      assert.ok(c.maxW <= viewW * 0.42, 'the card stays a corner card');
    });
  }
  test('a small window keeps the base size', () => {
    assert.deepEqual(cardMetrics(460), { k: 1, title: 19, sub: 14, more: 13, portrait: 46, minW: 260, maxW: 360 });
  });
});

describe('M10 follow-up: a stale snapshot does not undo a terminal moment', () => {
  test('an error Moment, then a snapshot from before it that still says needs_you: no alert', () => {
    const m = model();
    m.setSnapshot(snapshot([agent(1, { state: 'working' })], { t: T0 }), 1);
    m.pushMoment(moment({ kind: 'needs_you', agent: A, tool: 'claude', reason: 'permission', t: T0 + 1000 }), 2);
    m.pushMoment(moment({ kind: 'error', agent: A, tool: 'claude', t: T0 + 4000 }), 5);
    m.setSnapshot(snapshot([agent(1, { state: 'needs_you', since: T0 + 1000 })], { t: T0 + 3000 }), 5.2);
    const dl = run(m, 5.2, 6, 30);
    assert.equal(dl.flag.raised, false);
    assert.deepEqual(m.waiting(), []);
  });
});
