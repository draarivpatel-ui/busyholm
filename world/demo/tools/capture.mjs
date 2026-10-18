// node tools/capture.mjs [--clip trailer|beats|loop|beat1_desktop|...] [--view ambient,desktop,timelapse,trailer,strip1440]
//   [--seed 42] [--edition full|demo] [--out DIR] [--at 2000,4000,... only these clip-relative ms]
// Needs PLAYWRIGHT_PATH (a playwright-core directory) or installed playwright-core; mp4 needs ffmpeg.
import { parseArgs } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureClip, CLIPS } from './capture-lib.mjs';

try {
  const { values: v } = parseArgs({
    options: {
      clip: { type: 'string', default: 'trailer' },
      view: { type: 'string' },
      seed: { type: 'string', default: '42' },
      edition: { type: 'string', default: 'full' },
      out: { type: 'string' },
      at: { type: 'string' },
    },
  });

  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'captures');
  const clipList =
    v.clip === 'beats'
      ? Object.keys(CLIPS).filter((c) => c.startsWith('beat'))
      : v.clip === 'all'
      ? Object.keys(CLIPS)
      : [v.clip];

  for (const clipName of clipList) {
    const spec = CLIPS[clipName];
    if (!spec) throw new Error(`unknown clip "${clipName}"`);
    const views = v.view ? v.view.split(',') : [spec.defaultView || 'ambient'];

    for (const view of views) {
      const outDir = v.out
        ? join(v.out, clipName, view)
        : join(root, `${clipName}-${view}`);
      const r = await captureClip({
        clip: clipName,
        view,
        seed: Number(v.seed),
        edition: v.edition,
        outDir,
        sampleTimesMs: v.at ? v.at.split(',').map(Number) : undefined,
      });
      console.log(
        `${r.clip} ${view}: ${r.frames.length} frames at ${r.fps} fps from scenario ${r.startMs} ms${
          r.mp4 ? ` -> ${r.mp4}` : ''
        }`
      );
    }
  }
} catch (error) {
  process.stderr.write(`capture: ${error.message}\n`);
  process.exitCode = 1;
}
