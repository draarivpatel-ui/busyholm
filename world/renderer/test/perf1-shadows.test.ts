/** PERF-1: spinning wheels reuse rasterized, sun-directed shadows between calm frames. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LitSprites } from '../src/draw/sprites.ts';
import { sampleSky } from '../../art/src/sky.ts';
import { shadowFor } from '../../art/src/shadow.ts';
import type { Atlas } from '../../art/src/atlas.ts';

test('repeated wheel orientations reuse their shadow; a light change invalidates it', () => {
  let blurs = 0;
  class FakeCanvas {
    width: number;
    height: number;
    context = {
      shadowBlur: 0,
      setTransform() {}, clearRect() {}, fillRect() {}, translate() {}, scale() {}, rotate() {},
      drawImage() { if (this.shadowBlur > 0) blurs++; },
    };
    constructor(w: number, h: number) { this.width = w; this.height = h; }
    getContext() { return this.context; }
  }
  const previous = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = FakeCanvas as unknown as typeof OffscreenCanvas;
  try {
    const atlas = {
      scale: 1, pages: [new FakeCanvas(128, 128)],
      frames: new Map([['st/watermill/part', { page: 0, sx: 0, sy: 0, sw: 64, sh: 32, x0: -16, y0: -8 }]]),
    } as unknown as Atlas;
    const cache = new LitSprites(atlas);
    const sky = sampleSky(0.3, 'clear');
    cache.setLight({ sky, shadow: shadowFor(sky) });
    const first = cache.getRotated('st/watermill/part', Math.PI / 4, 2.2);
    assert.ok(first);
    assert.equal(blurs, 1);
    for (let i = 0; i < 120; i++) {
      assert.equal(cache.getRotated('st/watermill/part', Math.PI / 4 + Math.PI * 2, 2.2), first);
    }
    assert.equal(blurs, 1, 'no live blur for a cached orientation');
    cache.setLight({ sky: { ...sky, light: { ...sky.light } }, shadow: { ...shadowFor(sky) } });
    assert.equal(cache.getRotated('st/watermill/part', Math.PI / 4, 2.2), first,
      'a world rebuild with the same light preserves the warm cache');
    assert.equal(blurs, 1);
    // Rotating the original 68 x 36 lit sprite cannot clip any corner.
    const theta = Math.PI / 4;
    for (const [x, y] of [[-18, -10], [50, -10], [-18, 26], [50, 26]]) {
      const rx = x * Math.cos(theta) - y * Math.sin(theta);
      const ry = x * Math.sin(theta) + y * Math.cos(theta);
      assert.ok(rx >= first.ax && rx <= first.ax + first.c.width);
      assert.ok(ry >= first.ay && ry <= first.ay + first.c.height);
    }
    const dusk = sampleSky(0.6, 'clear');
    cache.setLight({ sky: dusk, shadow: shadowFor(dusk) });
    assert.notEqual(cache.getRotated('st/watermill/part', Math.PI / 4, 2.2), first);
    assert.equal(blurs, 2);
    cache.clear();
    assert.equal(cache.bytes().entries, 0);
  } finally {
    globalThis.OffscreenCanvas = previous;
  }
});
