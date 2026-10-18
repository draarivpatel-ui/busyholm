/** Browser acceptance tests 3 (silhouettes) and 4 (atlas time). Results go to window.__results. */
import { buildStripAtlas } from './atlas.ts';
import { SPECIES, STATE_POSES, drawPose } from './residents.ts';
import { PAL } from './tokens.ts';

declare global {
  interface Window { __results: unknown; __done: boolean }
}

function silhouette(species: (typeof SPECIES)[number], pose: string, W: number, H: number): Uint8Array {
  // 1-bit silhouette at 2x (the strip's device scale on a Retina screen), feet-anchored, flat fill
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext('2d')!;
  g.setTransform(2, 0, 0, 2, W / 2, H - 8);
  drawPose(g, species, pose, 2, PAL.ink);
  const d = g.getImageData(0, 0, W, H).data;
  const m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  return m;
}

function runSilhouettes() {
  const out: Record<string, unknown> = {};
  for (const sp of SPECIES) {
    const masks = STATE_POSES.map((p) => silhouette(sp, p, 104, 112));
    const pairs: { a: string; b: string; diff: number }[] = [];
    let minDiff = 1;
    for (let i = 0; i < masks.length; i++)
      for (let j = i + 1; j < masks.length; j++) {
        let x = 0;
        let u = 0;
        for (let k = 0; k < masks[i].length; k++) {
          x += masks[i][k] ^ masks[j][k];
          u += masks[i][k] | masks[j][k];
        }
        const diff = u ? x / u : 0;
        pairs.push({ a: STATE_POSES[i], b: STATE_POSES[j], diff });
        minDiff = Math.min(minDiff, diff);
      }
    out[sp] = { poses: [...STATE_POSES], pairs, minDiff };
  }
  return out;
}

function runAtlas() {
  try {
    const runs: number[] = [];
    // Canvas 2D on the GPU records draw calls and rasterises lazily, so each timed run ends with a
    // 1-pixel readback per page: that forces every queued draw to actually rasterise.
    const settle = (r: ReturnType<typeof buildStripAtlas>) => {
      for (const p of r.atlas.pages) (p.getContext('2d') as OffscreenCanvasRenderingContext2D).getImageData(0, 0, 1, 1);
    };
    let last = buildStripAtlas(2);
    settle(last);
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      last = buildStripAtlas(2);
      settle(last);
      runs.push(performance.now() - t0);
    }
    const sorted = [...runs].sort((a, b) => a - b);
    return { scale: 2, runsMs: runs, medianMs: sorted[Math.floor(sorted.length / 2)], sprites: last.sprites, width: last.width, height: last.height };
  } catch (e) {
    return { error: String(e) };
  }
}

window.__results = { atlas: runAtlas(), silhouettes: runSilhouettes() };
window.__done = true;
