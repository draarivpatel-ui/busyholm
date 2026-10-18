// Deterministic capture of the demo and trailer scenario (WP-13, WP-B1).
// Needs Playwright (PLAYWRIGHT_PATH or installed playwright-core), Google Chrome, and ffmpeg (FFMPEG or PATH).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPlaywright, ffmpegPath } from '../../../tools/lib/playwright.mjs';
import { build } from '../../art/node_modules/esbuild/lib/main.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FPS = 30;

export const CLIPS = {
  loop: { startMs: 10000, durationMs: 10000, defaultView: 'ambient' },
  trailer: { startMs: 0, durationMs: 60000, defaultView: 'trailer' },
  // Individual beats (each 1080p, 30 fps)
  beat1_desktop: { startMs: 0, durationMs: 7000, defaultView: 'desktop' },
  beat2_working: { startMs: 7000, durationMs: 7000, defaultView: 'desktop' },
  beat3_needs_you: { startMs: 14000, durationMs: 8000, defaultView: 'desktop' },
  beat4_answer_build: { startMs: 22000, durationMs: 8000, defaultView: 'ambient' },
  beat5_sky: { startMs: 30000, durationMs: 7000, defaultView: 'ambient' },
  beat6_limit_rain: { startMs: 37000, durationMs: 8000, defaultView: 'ambient' },
  beat7_ambient: { startMs: 45000, durationMs: 7000, defaultView: 'ambient' },
  beat8_timelapse: { startMs: 52000, durationMs: 6000, defaultView: 'timelapse' },
  beat9_title: { startMs: 58000, durationMs: 2000, defaultView: 'endcard' },
};

export const VIEWS = {
  strip1440: { width: 1440, height: 120, scale: 2 },
  strip2560: { width: 2560, height: 160, scale: 2 },
  ambient: { width: 1920, height: 1080, scale: 1 },
  desktop: { width: 1920, height: 1080, scale: 1 },
  timelapse: { width: 1920, height: 1080, scale: 1 },
  trailer: { width: 1920, height: 1080, scale: 1 },
  endcard: { width: 1920, height: 1080, scale: 1 },
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const frameMs = (frame) => (frame * 1000) / FPS;

/** Bundle the capture page (fast, always fresh) and return its path. */
export async function buildPage() {
  const dist = join(ROOT, 'dist');
  mkdirSync(dist, { recursive: true });
  await build({
    entryPoints: { capture: join(ROOT, 'src', 'capture-main.ts') },
    bundle: true,
    format: 'iife',
    target: 'es2022',
    outdir: dist,
    logLevel: 'warning',
    legalComments: 'none',
  });
  writeFileSync(join(dist, 'capture.html'), readFileSync(join(ROOT, 'pages', 'capture.html')));
  return join(dist, 'capture.html');
}

async function openPage(browser, view, params) {
  const spec = VIEWS[view];
  const context = await browser.newContext({ viewport: { width: spec.width, height: spec.height }, deviceScaleFactor: spec.scale });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(String(e.message).split('\n')[0]));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  const url = new URL(pathToFileURL(await buildPage()).href);
  url.searchParams.set('view', view);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  await page.goto(url.href, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__demo && window.__demo.ready, null, { timeout: 30000 });
  const r = await page.evaluate(() => window.__demo.canvasRect());
  return { context, page, problems, clip: { x: r.x, y: r.y, width: r.w, height: r.h } };
}

/**
 * Capture a clip of the seeded demo/scenario as PNG frames at 30 fps.
 * options: clip ('loop', 'trailer', 'beat1_desktop', etc.), view, outDir, seed, edition,
 * sampleTimesMs (clip-relative; capture only those frames, else every frame and an mp4), startMs (override).
 * Frames are exact: scenario time = startMs + n * 1000 / 30, stepped from time 0.
 */
export async function captureClip(options) {
  const { clip = 'loop', seed = 42, edition = 'full', sampleTimesMs } = options;
  if (!options.outDir) throw new Error('captureClip: outDir is required');
  const spec = CLIPS[clip];
  if (!spec) throw new Error(`unknown clip "${clip}" (known: ${Object.keys(CLIPS).join(', ')})`);
  const view = options.view ?? spec.defaultView ?? 'ambient';
  if (!VIEWS[view] || (view === 'endcard' && clip !== 'beat9_title')) throw new Error(`unknown view "${view}"`);

  const startMs = options.startMs ?? spec.startMs;
  const startFrame = Math.round((startMs * FPS) / 1000);
  const total = Math.round((spec.durationMs * FPS) / 1000);
  const outDir = resolve(options.outDir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const wanted = sampleTimesMs
    ? sampleTimesMs.map((t) => {
        const n = Math.round((t * FPS) / 1000);
        if (frameMs(n) !== t && Math.abs(frameMs(n) - t) > 1e-6) throw new Error(`sample ${t} ms is not on the 30 fps grid`);
        return n;
      })
    : Array.from({ length: total }, (_, n) => n);

  if (wanted.some((n, i) => n < 0 || n >= total || (i > 0 && n <= wanted[i - 1]))) {
    throw new Error('sample times must be increasing and inside the clip');
  }

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const frames = [];

  try {
    const { context, page, problems, clip: box } = await openPage(browser, view, { seed, edition, clip });
    try {
      for (const n of wanted) {
        await page.evaluate((f) => window.__demo.stepTo(f), startFrame + n);
        const file = join(
          outDir,
          sampleTimesMs
            ? `sample-${String(Math.round(frameMs(n))).padStart(6, '0')}ms.png`
            : `frame-${String(n + 1).padStart(5, '0')}.png`
        );
        const bytes = await page.screenshot({ clip: box, path: file, animations: 'disabled', scale: 'device' });
        frames.push({ timeMs: frameMs(n), path: file, sha256: sha256(bytes) });
      }
      const errs = await page.evaluate(() => window.__demo.errors());
      if (errs.length || problems.length) throw new Error(`renderer or page errors: ${JSON.stringify([...errs, ...problems].slice(0, 3))}`);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }

  let mp4 = null;
  if (!sampleTimesMs) {
    mp4 = join(outDir, `${clip}-${view}.mp4`);
    const enc = spawnSync(
      ffmpegPath(),
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-y',
        '-framerate',
        String(FPS),
        '-i',
        join(outDir, 'frame-%05d.png'),
        '-vf',
        'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '18',
        '-movflags',
        '+faststart',
        mp4,
      ],
      { encoding: 'utf8' }
    );
    if (enc.error) throw new Error(`could not run ffmpeg (${ffmpegPath()}; set FFMPEG): ${enc.error.message}`);
    if (enc.status !== 0) throw new Error(`ffmpeg exited ${enc.status}: ${enc.stderr.trim()}`);
  }

  writeFileSync(
    join(outDir, 'hashes.json'),
    JSON.stringify(
      {
        clip,
        view,
        seed,
        edition,
        startMs,
        fps: FPS,
        frames: frames.map((f) => ({ timeMs: f.timeMs, sha256: f.sha256 })),
      },
      null,
      1
    ) + '\n'
  );

  return { clip, view, seed, fps: FPS, startMs, durationMs: spec.durationMs, frames, mp4 };
}

/** The end card PNG for a counts template. Text comes only from end-card.ts. */
export async function captureEndCard(options) {
  const { counts, outPath } = options;
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { context, page, problems, clip } = await openPage(browser, 'endcard', counts);
    try {
      mkdirSync(dirname(resolve(outPath)), { recursive: true });
      const bytes = await page.screenshot({ clip, path: resolve(outPath), scale: 'device' });
      if (problems.length) throw new Error(`page errors: ${problems[0]}`);
      return { path: resolve(outPath), sha256: sha256(bytes) };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
