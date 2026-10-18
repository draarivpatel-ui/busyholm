/** PERF-1: a calm strip must not commit fast decorative frames with no agents. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../src/index.ts';
import { agent, hamlet, hexId, moment, snapshot } from './helpers.ts';

function strip(active = false) {
  const r = createRenderer({
    surface: 'strip', width: 1440, height: 120, dpr: 2,
    scheduler: 'manual', debug: true,
    date: () => new Date(2026, 9, 12, 16, 0, 0),
  });
  r.setWorld(hamlet());
  r.setSnapshot(snapshot(active ? [agent(1), agent(2, { ordinal: 2 }), agent(3, { ordinal: 3 })] : []));
  r.advance(15_000);
  return r;
}

test('idle strip: decorative life continues with at most one draw and wake per second', () => {
  const r = strip();
  const before = r.stats();
  r.advance(120_000);
  const after = r.stats();
  assert.ok(after.drawn > before.drawn, 'clouds and scenery still move');
  assert.ok(after.drawn - before.drawn <= 121, `idle draws: ${after.drawn - before.drawn}`);
  assert.ok(after.ticks - before.ticks <= 121, `idle timer wakes: ${after.ticks - before.ticks}`);
  r.destroy();
});

test('active calm strip: one timer per four-fps paper step, without intermediate decorative commits', () => {
  const r = strip(true);
  const before = r.stats();
  r.advance(120_000);
  const after = r.stats();
  assert.ok(after.drawn - before.drawn > 120, 'working residents still animate');
  assert.ok(after.drawn - before.drawn <= 481, `active draws: ${after.drawn - before.drawn}`);
  assert.ok(after.ticks - before.ticks <= 481, `active timer wakes: ${after.ticks - before.ticks}`);
  r.destroy();
});

test('an alert interrupts the slow idle timer immediately, then hidden strips park their timers', () => {
  const r = strip();
  r.advance(43);
  const before = r.stats();
  r.pushMoment(moment({ kind: 'needs_you', agent: hexId(1), tool: 'claude', reason: 'permission' }));
  r.advance(1);
  assert.equal(r.debugLog().at(-1)?.flag.raised, true);
  assert.ok(r.stats().drawn > before.drawn);
  r.setVisible(false);
  const hidden = r.stats();
  r.advance(120_000);
  assert.equal(r.stats().ticks, hidden.ticks);
  assert.equal(r.stats().drawn, hidden.drawn);
  r.destroy();
});
