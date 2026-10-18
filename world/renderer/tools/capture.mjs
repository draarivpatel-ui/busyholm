// Deterministic frame capture for the Busyholm world renderer.
//
// For each view, opens world/dist/capture.html in headless Chrome, steps the
// renderer's virtual clock by exactly 1000/fps ms per frame, screenshots the
// canvas, encodes the frames to <out>/<view>.mp4 with ffmpeg, and copies key
// frames (every 2 s) to <out>/key/.
//
// Needs Playwright (PLAYWRIGHT_PATH, see tools/lib/playwright.mjs) and ffmpeg (FFMPEG env var,
// or ffmpeg on PATH).
//
// Usage:
//   node world/renderer/tools/capture.mjs [options]
//
// Options:
//   --views a,b,c      views to capture (default strip1440,strip2560,ambient)
//   --fps N            frames per second (default 30)
//   --seconds N        capture length (default: __bh.duration / 1000)
//   --out DIR          output root (default world/renderer/captures)
//   --qs "a=1&b=2"     extra query string appended to the page URL
//   --page PATH        page to load (default world/dist/capture.html)
//   --keep-frames      keep per-frame PNGs (default)
//   --no-frames        delete per-frame PNGs after encoding; keeps the mp4,
//                      key frames and info.jsonl

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadPlaywright, ffmpegPath } from '../../../tools/lib/playwright.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEFAULT_PAGE = path.join(REPO_ROOT, 'world', 'dist', 'capture.html');
const DEFAULT_OUT = path.join(REPO_ROOT, 'world', 'renderer', 'captures');

const VIEWS = {
  strip1440: { width: 1440, height: 120, scale: 2 },
  strip2560: { width: 2560, height: 160, scale: 2 },
  ambient: { width: 1920, height: 1080, scale: 1 },
};
const DEFAULT_VIEWS = Object.keys(VIEWS);
const WAIT_BH_MS = 20000;
const WAIT_READY_MS = 20000;
const PROGRESS_EVERY = 30;
const KEY_EVERY_SECONDS = 2;

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function firstLine(err) {
  return String(err && err.message ? err.message : err).split('\n')[0];
}

function frameName(n) {
  return `frame-${String(n).padStart(5, '0')}.png`;
}

function usage() {
  return [
    'Usage: node world/renderer/tools/capture.mjs [options]',
    '  --views strip1440,strip2560,ambient   (default: all three)',
    '  --fps N                               (default: 30)',
    '  --seconds N                           (default: __bh.duration / 1000)',
    '  --out DIR                             (default: world/renderer/captures)',
    '  --qs "a=1&b=2"                        extra page query string',
    '  --page PATH                           (default: world/dist/capture.html)',
    '  --keep-frames                         keep per-frame PNGs (default)',
    '  --no-frames                           delete per-frame PNGs after encoding',
  ].join('\n');
}

function parsePositive(name, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--${name} must be a positive number, got "${raw}"`);
  }
  return n;
}

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      views: { type: 'string' },
      fps: { type: 'string' },
      seconds: { type: 'string' },
      out: { type: 'string' },
      qs: { type: 'string' },
      page: { type: 'string' },
      'keep-frames': { type: 'boolean' },
      'no-frames': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return { help: true };
  if (values['keep-frames'] && values['no-frames']) {
    throw new Error('use either --keep-frames or --no-frames, not both');
  }

  const views = values.views === undefined
    ? DEFAULT_VIEWS
    : values.views.split(',').map((v) => v.trim()).filter(Boolean);
  if (views.length === 0) throw new Error('--views is empty');
  for (const v of views) {
    if (!VIEWS[v]) throw new Error(`unknown view "${v}" (known: ${DEFAULT_VIEWS.join(', ')})`);
  }

  return {
    help: false,
    views,
    fps: values.fps === undefined ? 30 : parsePositive('fps', values.fps),
    seconds: values.seconds === undefined ? null : parsePositive('seconds', values.seconds),
    pagePath: path.resolve(values.page ?? DEFAULT_PAGE),
    outDir: path.resolve(values.out ?? DEFAULT_OUT),
    extraQs: (values.qs ?? '').replace(/^[?&]+/, ''),
    keepFrames: !values['no-frames'],
  };
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function captureView(browser, view, opts) {
  const spec = VIEWS[view];
  const viewDir = path.join(opts.outDir, view);
  const mp4Path = path.join(opts.outDir, `${view}.mp4`);
  const keyDir = path.join(opts.outDir, 'key');
  const started = Date.now();

  // Start clean: stale frames from an older, longer run would otherwise be
  // picked up by ffmpeg's sequential %05d read, and info.jsonl would append.
  await fs.rm(viewDir, { recursive: true, force: true });
  await fs.mkdir(viewDir, { recursive: true });
  await fs.mkdir(keyDir, { recursive: true });
  for (const f of await fs.readdir(keyDir)) {
    if (f.startsWith(`${view}-t`) && f.endsWith('.png')) await fs.rm(path.join(keyDir, f));
  }
  await fs.rm(mp4Path, { force: true });

  const context = await browser.newContext({
    viewport: { width: spec.width, height: spec.height },
    deviceScaleFactor: spec.scale,
  });
  try {
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') process.stderr.write(`[${view}] console error: ${msg.text()}\n`);
    });
    page.on('pageerror', (err) => {
      process.stderr.write(`[${view}] page error: ${firstLine(err)}\n`);
    });

    const url = new URL(pathToFileURL(opts.pagePath).href);
    url.searchParams.set('view', view);
    url.searchParams.set('mode', 'step');
    for (const [k, v] of new URLSearchParams(opts.extraQs)) url.searchParams.append(k, v);
    await page.goto(url.href, { waitUntil: 'load' });

    try {
      await page.waitForFunction(() => !!window.__bh, null, { timeout: WAIT_BH_MS });
    } catch (err) {
      if (err.name === 'TimeoutError') {
        throw new Error(`[${view}] window.__bh did not appear within ${WAIT_BH_MS / 1000} s (page: ${opts.pagePath})`);
      }
      throw new Error(`[${view}] waiting for window.__bh failed: ${firstLine(err)}`);
    }

    try {
      await withTimeout(
        page.evaluate(() => window.__bh.ready),
        WAIT_READY_MS,
        `__bh.ready did not resolve within ${WAIT_READY_MS / 1000} s`,
      );
    } catch (err) {
      throw new Error(`[${view}] ready rejected: ${firstLine(err)}`);
    }

    const duration = await page.evaluate(() => window.__bh.duration);
    const seconds = opts.seconds ?? duration / 1000;
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`[${view}] no usable length (__bh.duration=${duration}); pass --seconds`);
    }
    const frames = Math.round(seconds * opts.fps);
    if (frames < 1) throw new Error(`[${view}] ${seconds} s at ${opts.fps} fps is zero frames`);

    // Read the canvas rect once so every frame has the same pixel size.
    const r = await page.evaluate(() => window.__bh.canvasRect());
    const clip = { x: r.x, y: r.y, width: r.w, height: r.h };
    if (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) || clip.width <= 0 || clip.height <= 0) {
      throw new Error(`[${view}] canvasRect() returned an unusable rect: ${JSON.stringify(r)}`);
    }

    log(`[${view}] ${frames} frames (${seconds} s at ${opts.fps} fps), clip ${JSON.stringify(clip)}`);
    const stepMs = 1000 / opts.fps;
    const infoPath = path.join(viewDir, 'info.jsonl');
    for (let i = 0; i < frames; i++) {
      // Advance and read info in one round trip; frame 1 is the first draw.
      const info = await page.evaluate(([ms, advance]) => {
        if (advance) window.__bh.advance(ms);
        return window.__bh.info();
      }, [stepMs, i > 0]);
      await fs.appendFile(infoPath, `${JSON.stringify(info ?? null)}\n`);
      await page.screenshot({
        clip,
        path: path.join(viewDir, frameName(i + 1)),
        animations: 'disabled',
        scale: 'device',
      });
      if ((i + 1) % PROGRESS_EVERY === 0) log(`[${view}] frame ${i + 1}/${frames}`);
    }

    const enc = spawnSync(ffmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-framerate', String(opts.fps),
      '-start_number', '1',
      '-i', path.join(viewDir, 'frame-%05d.png'),
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
      '-movflags', '+faststart',
      mp4Path,
    ], { encoding: 'utf8' });
    if (enc.error) throw new Error(`[${view}] could not run ffmpeg (${ffmpegPath()}): ${enc.error.message}`);
    if (enc.status !== 0) throw new Error(`[${view}] ffmpeg exited ${enc.status}: ${enc.stderr.trim()}`);

    // Key frames are copied before any frame deletion below.
    let keyCount = 0;
    for (let t = 0; t <= seconds; t += KEY_EVERY_SECONDS) {
      const index = Math.min(Math.max(Math.round(t * opts.fps) + 1, 1), frames);
      const name = `${view}-t${String(t).padStart(2, '0')}.png`;
      await fs.copyFile(path.join(viewDir, frameName(index)), path.join(keyDir, name));
      keyCount += 1;
    }

    if (!opts.keepFrames) {
      for (const f of await fs.readdir(viewDir)) {
        if (/^frame-\d{5}\.png$/.test(f)) await fs.rm(path.join(viewDir, f));
      }
    }

    const elapsed = (Date.now() - started) / 1000;
    log(`[${view}] done: ${frames} frames in ${elapsed.toFixed(1)} s -> ${mp4Path}`);
    return { view, frames, elapsed, mp4Path, keyCount };
  } finally {
    await context.close();
  }
}

async function main() {
  const opts = parseOptions(process.argv.slice(2));
  if (opts.help) {
    log(usage());
    return;
  }

  try {
    await fs.access(opts.pagePath);
  } catch {
    throw new Error(`page not found: ${opts.pagePath} (build the renderer first, or pass --page)`);
  }

  const { chromium } = await loadPlaywright();
  await fs.mkdir(opts.outDir, { recursive: true });

  const started = Date.now();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const results = [];
  try {
    for (const view of opts.views) results.push(await captureView(browser, view, opts));
  } finally {
    await browser.close();
  }

  const totalFrames = results.reduce((n, r) => n + r.frames, 0);
  const totalKeys = results.reduce((n, r) => n + r.keyCount, 0);
  log(`capture: ${totalFrames} frames, ${results.length} view(s), ${((Date.now() - started) / 1000).toFixed(1)} s total`);
  for (const r of results) {
    log(`  ${r.view}: ${r.frames} frames, ${r.elapsed.toFixed(1)} s -> ${r.mp4Path}`);
  }
  log(`  key frames: ${totalKeys} in ${path.join(opts.outDir, 'key')}`);
  log(`  out: ${opts.outDir}`);
}

main().catch((err) => {
  process.stderr.write(`capture: FAILED: ${err.message}\n`);
  process.exitCode = 1;
});
