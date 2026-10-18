/** PERF-1: collector accounting updates must not repaint unchanged static scenery. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorldModel } from '../src/model.ts';
import { createRenderer } from '../src/index.ts';
import { hamlet, snapshot } from './helpers.ts';
import { validate } from '../../../contracts/ts/src/validate.ts';
import type { World } from '../../../contracts/ts/src/types.ts';

function valid(w: World): World {
  const result = validate('world', w);
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.issues));
  return w;
}

function model() {
  return new WorldModel({
    surface: 'strip', seed: 11, reducedMotion: false, species: {},
    hemisphere: 'north', skyMode: 'usage_and_clock', pxPerUnit: 2,
    date: () => new Date(2026, 9, 12, 16, 0, 0),
  });
}

test('accounting and within-stage progress preserve the scenery revision; visible changes invalidate it', () => {
  const m = model();
  const w = hamlet();
  m.setWorld(w, 1);
  const before = m.step(16, true).layoutKey;
  const update = structuredClone(w);
  update.stats.lifetime_turns++;
  update.resources.planks++;
  const unfinished = update.structures.find((s) => s.status === 'building')!;
  assert.ok(unfinished);
  unfinished.progress += 0.001;
  m.setWorld(valid(update), 30);
  assert.equal(m.step(30, true).layoutKey, before, 'no plane rebuild for updated counts and progress');

  const advanced = structuredClone(update);
  const building = advanced.structures.find((s) => s.id === unfinished.id)!;
  building.stage++;
  if (building.stage === 3) {
    building.status = 'complete';
    building.progress = 1;
    building.completed_day = advanced.as_of_day;
  }
  m.setWorld(valid(advanced), 31);
  const stageKey = m.step(31, true).layoutKey;
  assert.notEqual(stageKey, before, 'a visible building stage must repaint');
  const decorated = structuredClone(advanced);
  decorated.decorations.push({ id: 'bench', slot: 4, shown: true });
  m.setWorld(valid(decorated), 32);
  const decoKey = m.step(32, true).layoutKey;
  assert.notEqual(decoKey, stageKey, 'a visible decoration must repaint');
  decorated.decorations.at(-1)!.shown = false;
  m.setWorld(valid(decorated), 33);
  const hiddenKey = m.step(33, true).layoutKey;
  assert.notEqual(hiddenKey, decoKey, 'putting a decoration away must repaint');
  const seeded = structuredClone(decorated);
  seeded.seed++;
  m.setWorld(valid(seeded), 34);
  assert.notEqual(m.step(34, true).layoutKey, hiddenKey, 'a new scenery seed must repaint');
});

test('routine world accounting does not wake an empty strip at the transient six-fps rate', () => {
  const r = createRenderer({
    surface: 'strip', width: 1440, height: 120, dpr: 2, scheduler: 'manual',
    date: () => new Date(2026, 9, 12, 16, 0, 0),
  });
  const w = hamlet();
  r.setWorld(w);
  r.setSnapshot(snapshot([]));
  r.advance(15_000);
  const before = r.stats();
  const update = structuredClone(w);
  update.resources.planks++;
  r.setWorld(update);
  r.advance(15_000);
  assert.ok(r.stats().drawn - before.drawn <= 10, 'the island stays on its slow decorative clock');
  assert.ok(r.stats().ticks - before.ticks <= 10, 'unchanged scenery creates no transient timer sequence');
  r.destroy();
});
