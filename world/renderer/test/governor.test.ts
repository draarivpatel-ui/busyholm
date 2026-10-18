import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualTime } from '../src/clock.ts';
import { Governor } from '../src/governor.ts';
import type { GovernorOptions, TickResult } from '../src/governor.ts';
import type { GovMode, Surface } from '../src/api.ts';

interface Rig {
  vt: VirtualTime;
  gov: Governor;
  times: number[];
  modes: GovMode[];
  /** the result every tick returns; mutate fields to change the scene */
  scene: TickResult;
}

function rig(surface: Surface, scene: Partial<TickResult> = {}, extra: Partial<GovernorOptions> = {}): Rig {
  const vt = new VirtualTime(0);
  const times: number[] = [];
  const modes: GovMode[] = [];
  const full: TickResult = { animating: false, drawn: true, ...scene };
  const gov = new Governor({
    surface,
    clock: vt,
    scheduler: vt,
    onTick: (now, mode) => {
      times.push(now);
      modes.push(mode);
      return full;
    },
    ...extra,
  });
  return { vt, gov, times, modes, scene: full };
}

/** the most ticks inside any window of `span` ms (windows start at a tick) */
function maxInWindow(times: number[], span: number): number {
  let best = 0;
  for (let i = 0; i < times.length; i++) {
    let n = 0;
    for (let j = i; j < times.length && times[j]! - times[i]! < span - 1e-6; j++) n++;
    best = Math.max(best, n);
  }
  return best;
}

function onGrid(t: number, fps: number): boolean {
  const k = (t * fps) / 1000;
  return Math.abs(k - Math.round(k)) < 1e-6;
}

test('calm animating strip: at most 12 ticks per second, on the 1/12 s grid', () => {
  const r = rig('strip', { animating: true });
  r.gov.start();
  r.vt.advance(10_000);
  assert.ok(r.times.length >= 119 && r.times.length <= 121, `ticks ${r.times.length}`);
  assert.ok(maxInWindow(r.times, 1000) <= 12);
  for (const t of r.times) assert.ok(onGrid(t, 12), `tick at ${t} is off the grid`);
  assert.ok(r.modes.every((m) => m === 'calm'));
  assert.equal(r.vt.pending(), 1);
  assert.deepEqual(r.gov.stats(), { ticks: r.times.length, drawn: r.times.length, burstStartedAt: null, burstUntil: null });
});

test('drawn counts only ticks that report drawn', () => {
  const r = rig('strip', { animating: true });
  let n = 0;
  const g = new Governor({
    surface: 'strip',
    clock: r.vt,
    scheduler: r.vt,
    onTick: () => ({ animating: true, drawn: n++ % 2 === 0 }),
  });
  g.start();
  r.vt.advance(1000);
  const s = g.stats();
  assert.equal(s.drawn, Math.ceil(s.ticks / 2));
});

test('static scene: no ticks after the first until poke', () => {
  const r = rig('strip', { animating: false });
  r.gov.start();
  r.vt.advance(0);
  assert.equal(r.times.length, 1);
  assert.equal(r.vt.pending(), 0);
  r.vt.advance(60_000);
  assert.equal(r.times.length, 1);
  r.gov.poke();
  r.vt.advance(0);
  assert.equal(r.times.length, 2);
  r.vt.advance(60_000);
  assert.equal(r.times.length, 2);
});

test('nextChangeAt schedules exactly one tick at that time', () => {
  const r = rig('strip', { animating: false, nextChangeAt: 2500 });
  r.gov.start();
  r.vt.advance(2499);
  assert.deepEqual(r.times, [0]);
  r.scene.nextChangeAt = null;
  r.vt.advance(1);
  assert.deepEqual(r.times, [0, 2500]);
  r.vt.advance(60_000);
  assert.deepEqual(r.times, [0, 2500]);
  assert.deepEqual(r.vt.delays, [0, 2500]);
});

test('nextChangeAt in the past clamps to a 0 ms timer', () => {
  const vt = new VirtualTime(0);
  const times: number[] = [];
  const g = new Governor({
    surface: 'strip',
    clock: vt,
    scheduler: vt,
    onTick: (now) => {
      times.push(now);
      return { animating: false, drawn: false, nextChangeAt: times.length === 1 ? now - 50 : null };
    },
  });
  g.start();
  vt.advance(1000);
  assert.deepEqual(times, [0, 0]);
  assert.deepEqual(vt.delays, [0, 0]);
});

test('burst: 25 to 30 ticks in the first second, ends by 3 s', () => {
  const r = rig('strip', { animating: true });
  r.gov.start();
  r.vt.advance(1000);
  const t0 = r.vt.now();
  const before = r.times.length;
  r.gov.requestBurst(3000);
  assert.equal(r.gov.mode(), 'burst');
  assert.equal(r.gov.stats().burstStartedAt, t0);
  assert.equal(r.gov.stats().burstUntil, t0 + 3000);
  assert.equal(r.vt.pending(), 1, 'one pending timer after the reschedule');
  r.vt.advance(1000);
  const firstSecond = r.times.slice(before).filter((t) => t >= t0 && t < t0 + 1000);
  assert.ok(firstSecond.length >= 25 && firstSecond.length <= 30, `first second ${firstSecond.length}`);
  r.vt.advance(5000);
  const burstTicks = r.times.filter((_, i) => r.modes[i] === 'burst');
  assert.ok(burstTicks.length > 0);
  assert.ok(burstTicks.every((t) => t >= t0 && t < t0 + 3000));
  assert.ok(maxInWindow(burstTicks, 1000) <= 30);
  for (const t of burstTicks.slice(1)) assert.ok(onGrid(t, 30), `burst tick at ${t} off the 1/30 grid`);
  // back to calm after the burst
  const after = r.times.filter((t) => t >= t0 + 3000);
  assert.ok(maxInWindow(after, 1000) <= 12);
  assert.equal(r.gov.mode(), 'calm');
});

test('burst reschedules a slower pending timer and only lowers a timer', () => {
  const r = rig('strip', { animating: false, nextChangeAt: 10_000 });
  r.gov.start();
  r.vt.advance(0);
  assert.equal(r.times.length, 1);
  r.gov.requestBurst(1000); // pending timer at 10000 is later than the next burst boundary
  r.vt.advance(40);
  assert.equal(r.times.length, 2, 'a tick landed on the 1/30 boundary');
  assert.ok(Math.abs(r.times[1]! - 1000 / 30) < 1e-6);
});

test('cooldown blocks a new burst for 2.5 s after a full-length burst', () => {
  const r = rig('strip', { animating: true });
  r.gov.start();
  r.vt.advance(1000);
  r.gov.requestBurst(3000);
  const start = r.gov.stats().burstStartedAt!;
  const until = r.gov.stats().burstUntil!;
  assert.equal(until - start, 3000);
  r.vt.advance(3000); // now == until, burst over
  r.gov.requestBurst(3000);
  assert.equal(r.gov.stats().burstStartedAt, start, 'ignored during cooldown');
  assert.equal(r.gov.mode(), 'calm');
  r.vt.advance(2499 - 0); // now == until + 2499
  r.gov.requestBurst(1000);
  assert.equal(r.gov.stats().burstStartedAt, start, 'still cooling at 2499 ms');
  r.vt.advance(1); // now == until + 2500
  r.gov.requestBurst(1000);
  assert.equal(r.gov.stats().burstStartedAt, until + 2500);
  assert.equal(r.gov.mode(), 'burst');
});

test('continuous requests give peaks of at most 3 s with a cooldown gap', () => {
  const r = rig('strip', { animating: true });
  r.gov.start();
  const burstTimes: number[] = [];
  for (let i = 0; i < 200; i++) {
    r.gov.requestBurst(500);
    r.vt.advance(100);
  }
  for (let i = 0; i < r.times.length; i++) if (r.modes[i] === 'burst') burstTimes.push(r.times[i]!);
  // split into runs separated by gaps larger than a burst interval
  const runs: number[][] = [];
  for (const t of burstTimes) {
    const last = runs[runs.length - 1];
    if (last && t - last[last.length - 1]! < 200) last.push(t);
    else runs.push([t]);
  }
  assert.ok(runs.length >= 2, 'more than one peak over 20 s');
  for (const run of runs) assert.ok(run[run.length - 1]! - run[0]! < 3000);
  for (let i = 1; i < runs.length; i++) {
    const gap = runs[i]![0]! - runs[i - 1]![runs[i - 1]!.length - 1]!;
    assert.ok(gap >= 2500, `gap ${gap}`);
  }
});

test('a short burst starts no cooldown, and extending is capped at burstMaxMs', () => {
  const r = rig('strip', { animating: true });
  r.gov.start();
  r.gov.requestBurst(500);
  assert.equal(r.gov.stats().burstUntil, 500);
  r.vt.advance(600);
  r.gov.requestBurst(500); // not full length: allowed straight away
  assert.equal(r.gov.stats().burstStartedAt, 600);
  r.vt.advance(400);
  r.gov.requestBurst(10_000);
  assert.equal(r.gov.stats().burstUntil, 600 + 3000);
  r.vt.advance(1000);
  r.gov.requestBurst(100); // never shortens
  assert.equal(r.gov.stats().burstUntil, 600 + 3000);
});

test('hidden: zero ticks even with pokes and bursts, resumes on unhide', () => {
  const r = rig('strip', { animating: true });
  r.gov.start();
  r.vt.advance(500);
  r.gov.setHidden(true);
  const n = r.times.length;
  assert.equal(r.vt.pending(), 0);
  assert.equal(r.gov.mode(), 'hidden');
  r.gov.poke();
  r.gov.requestBurst(2000);
  r.gov.poke();
  r.vt.advance(10_000);
  assert.equal(r.times.length, n);
  assert.equal(r.gov.stats().burstStartedAt, null, 'burst ignored while hidden');
  r.gov.setHidden(false);
  r.vt.advance(0);
  assert.equal(r.times.length, n + 1, 'unhide ticks immediately');
  r.vt.advance(1000);
  assert.ok(r.times.length > n + 5);
  assert.equal(r.gov.mode(), 'calm');
});

test('hidden before start holds the first tick until unhide', () => {
  const r = rig('strip', { animating: true });
  r.gov.setHidden(true);
  r.gov.start();
  r.vt.advance(1000);
  assert.equal(r.times.length, 0);
  r.gov.setHidden(false);
  r.vt.advance(0);
  assert.equal(r.times.length, 1);
});

test('hiding during a tick leaves no timer', () => {
  const vt = new VirtualTime(0);
  let g: Governor;
  let n = 0;
  g = new Governor({
    surface: 'strip',
    clock: vt,
    scheduler: vt,
    onTick: () => {
      if (++n === 3) g.setHidden(true);
      return { animating: true, drawn: true };
    },
  });
  g.start();
  vt.advance(5000);
  assert.equal(n, 3);
  assert.equal(vt.pending(), 0);
});

test('reduced motion: ticks only on poke', () => {
  const r = rig('strip', { animating: true });
  r.gov.setReduced(true);
  r.gov.start();
  r.vt.advance(0);
  assert.equal(r.times.length, 1);
  assert.equal(r.modes[0], 'reduced');
  r.vt.advance(30_000);
  assert.equal(r.times.length, 1);
  r.gov.requestBurst(1000);
  r.vt.advance(5000);
  assert.equal(r.times.length, 1, 'bursts are ignored');
  assert.equal(r.gov.mode(), 'reduced');
  r.gov.poke();
  r.vt.advance(0);
  assert.equal(r.times.length, 2);
  r.vt.advance(30_000);
  assert.equal(r.times.length, 2);
});

test('turning reduced off ticks at once and resumes calm scheduling', () => {
  const r = rig('strip', { animating: true });
  r.gov.setReduced(true);
  r.gov.start();
  r.vt.advance(5000);
  assert.equal(r.times.length, 1);
  r.gov.setReduced(false);
  r.vt.advance(0);
  assert.equal(r.times.length, 2);
  r.vt.advance(1000);
  assert.ok(r.times.length >= 12);
  assert.equal(r.gov.mode(), 'calm');
});

test('ambient: camera moving runs 30 fps, still runs 12 fps', () => {
  const r = rig('ambient', { animating: true, cameraMoving: true });
  r.gov.start();
  r.vt.advance(5000);
  const moving = r.times.filter((t) => t > 0);
  assert.ok(moving.length >= 148 && moving.length <= 150, `moving ticks ${moving.length}`);
  assert.ok(maxInWindow(r.times, 1000) <= 30);
  assert.equal(r.gov.mode(), 'ambient-moving');
  for (const t of moving) assert.ok(onGrid(t, 30));
  r.scene.cameraMoving = false;
  r.vt.advance(100); // a few more ticks to pick up the change
  const mark = r.times.length;
  const t0 = r.vt.now();
  r.vt.advance(5000);
  const still = r.times.slice(mark);
  assert.ok(still.length >= 58 && still.length <= 61, `still ticks ${still.length}`);
  assert.ok(maxInWindow(still, 1000) <= 12);
  for (const t of still) assert.ok(onGrid(t, 12));
  assert.ok(still[0]! >= t0);
  assert.equal(r.gov.mode(), 'ambient-still');
  assert.ok(r.modes.includes('ambient-moving') && r.modes.includes('ambient-still'));
});

test('ambient with a still camera and nothing animating waits for poke or nextChangeAt', () => {
  const r = rig('ambient', { animating: false, cameraMoving: false, nextChangeAt: 700 });
  r.gov.start();
  r.vt.advance(699);
  assert.equal(r.times.length, 1);
  r.scene.nextChangeAt = null;
  r.vt.advance(5000);
  assert.deepEqual(r.times, [0, 700]);
});

test('burst on the ambient surface runs at burstFps', () => {
  const r = rig('ambient', { animating: true, cameraMoving: false });
  r.gov.start();
  r.vt.advance(1000);
  const t0 = r.vt.now();
  r.gov.requestBurst(2000);
  r.vt.advance(2000);
  const burst = r.times.filter((t, i) => r.modes[i] === 'burst' && t >= t0);
  assert.ok(burst.length >= 58 && burst.length <= 61, `burst ticks ${burst.length}`);
});

test('multiple pokes coalesce into one tick and one timer', () => {
  const r = rig('strip', { animating: false });
  r.gov.start();
  r.vt.advance(0);
  assert.equal(r.times.length, 1);
  for (let i = 0; i < 10; i++) r.gov.poke();
  assert.equal(r.vt.pending(), 1);
  r.vt.advance(0);
  assert.equal(r.times.length, 2);
  assert.equal(r.vt.pending(), 0);
});

test('poke replaces a pending calm timer with a 0 ms tick', () => {
  const r = rig('strip', { animating: true });
  r.gov.start();
  r.vt.advance(10); // first tick at 0, next at 83.3
  assert.equal(r.times.length, 1);
  r.gov.poke();
  assert.equal(r.vt.pending(), 1);
  r.vt.advance(0);
  assert.deepEqual(r.times, [0, 10]);
  r.vt.advance(100);
  assert.ok(r.times.every((t, i) => i < 2 || onGrid(t, 12)), 'back on the grid after a poke');
});

test('poke from inside onTick yields another tick', () => {
  const vt = new VirtualTime(0);
  let g: Governor;
  let n = 0;
  g = new Governor({
    surface: 'strip',
    clock: vt,
    scheduler: vt,
    onTick: () => {
      if (++n === 1) g.poke();
      return { animating: false, drawn: false };
    },
  });
  g.start();
  vt.advance(0);
  assert.equal(n, 2);
  assert.equal(vt.pending(), 0);
});

test('stop clears the timer; nothing ticks until start', () => {
  const r = rig('strip', { animating: true });
  r.gov.start();
  r.vt.advance(500);
  const n = r.times.length;
  r.gov.stop();
  assert.equal(r.vt.pending(), 0);
  r.gov.poke();
  r.gov.requestBurst(1000);
  r.gov.setHidden(true);
  r.gov.setHidden(false);
  r.vt.advance(5000);
  assert.equal(r.times.length, n);
  r.gov.start();
  r.vt.advance(0);
  assert.equal(r.times.length, n + 1);
});

test('only ever one pending timer', () => {
  const r = rig('strip', { animating: true });
  r.gov.start();
  for (let i = 0; i < 300; i++) {
    r.vt.advance(37);
    if (i % 7 === 0) r.gov.poke();
    if (i % 11 === 0) r.gov.requestBurst(400);
    assert.ok(r.vt.pending() <= 1, `pending ${r.vt.pending()} at step ${i}`);
  }
});

test('custom rates are honoured', () => {
  const r = rig('strip', { animating: true }, { calmFps: 4 });
  r.gov.start();
  r.vt.advance(2000);
  assert.ok(r.times.length >= 8 && r.times.length <= 9);
  for (const t of r.times) assert.ok(onGrid(t, 4));
});
