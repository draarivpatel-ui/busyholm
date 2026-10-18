/** PERF-1: the active strip must receive live state before the measured window starts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectSnapshots } from '../src/pages/snapshot-bootstrap.ts';
import { createRenderer } from '../src/index.ts';
import { agent, hamlet, snapshot, T0 } from './helpers.ts';
import type { Snapshot } from '../../../contracts/ts/src/types.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const working = () => [agent(1), agent(2, { ordinal: 2 }), agent(3, { ordinal: 3 })];

test('the initial query waits until live snapshot registration completes', async () => {
  const ready = deferred<void>();
  let queries = 0;
  const task = connectSnapshots(() => ready.promise, async () => { queries++; return null; }, () => {});
  const early = queries;
  ready.resolve();
  await task;
  assert.equal(early, 0, 'no gap between querying state and subscribing to updates');
  assert.equal(queries, 1);
});

for (const liveTime of [T0 + 1000, T0 - 1000]) {
  test(`a live snapshot survives a delayed initial reply (live time ${liveTime})`, async () => {
    const r = createRenderer({
      surface: 'strip', width: 1440, height: 120, dpr: 2, scheduler: 'manual', debug: true,
      date: () => new Date(2026, 9, 12, 16, 0, 0),
    });
    r.setWorld(hamlet());
    const initial = deferred<Snapshot | null>();
    let receive!: (s: Snapshot) => void;
    const task = connectSnapshots((fn) => { receive = fn; return Promise.resolve(); },
      () => initial.promise, (s) => r.setSnapshot(s));
    await Promise.resolve();
    receive(snapshot(working(), { t: liveTime }));
    initial.resolve(snapshot([], { t: T0 }));
    await task;
    r.advance(16_000);
    assert.equal(r.debugLog().at(-1)?.residents.length, 3, 'the delayed empty reply cannot remove live residents');
    r.destroy();
  });
}

test('the initial query populates a strip with no streamed update', async () => {
  const applied: Snapshot[] = [];
  await connectSnapshots(() => Promise.resolve(), async () => snapshot(working()), (s) => applied.push(s));
  assert.equal(applied.length, 1);
  assert.equal(applied[0].agents.length, 3);
});
