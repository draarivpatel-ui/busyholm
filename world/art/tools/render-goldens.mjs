// Renders golden PNGs from gallery.html into <artRoot>/goldens/<id>-<view>.png.
//
// Usage: node tools/render-goldens.mjs [ID-PREFIX ...] [--views=name1,name2]
//   node tools/render-goldens.mjs G02                    only ids starting with G02
//   node tools/render-goldens.mjs --views=strip1440,ambient
// Env:   GALLERY_PAGE  (page to load instead of gallery.html; absolute, or relative to the art root)
// Exit:  0 if every requested render succeeded, 1 otherwise.
// Needs Playwright: PLAYWRIGHT_PATH to a playwright-core package directory if it is not installed in the repo.

import { loadPlaywright } from '../../../tools/lib/playwright.mjs';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const artRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const goldensDir = join(artRoot, 'goldens');
const galleryPath = resolvePath(process.env.GALLERY_PAGE ?? 'gallery.html');
const READY_TIMEOUT_MS = 60_000;

function resolvePath(p) {
  return isAbsolute(p) ? p : join(artRoot, p);
}

function parseArgs(argv) {
  const prefixes = [];
  let viewNames = null;
  for (const arg of argv) {
    if (arg.startsWith('--views=')) {
      viewNames = arg
        .slice('--views='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (viewNames.length === 0) throw new Error('--views= needs at least one view name');
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      prefixes.push(arg);
    }
  }
  return { prefixes, viewNames };
}

function galleryUrl(params) {
  const url = pathToFileURL(galleryPath);
  url.search = new URLSearchParams(params).toString();
  return url.href;
}

// Reads width and height from the IHDR chunk, which sits at a fixed offset in every PNG.
function pngSize(buf) {
  if (buf.subarray(1, 4).toString('latin1') !== 'PNG') throw new Error('output is not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Returns null on success, or a short reason string on failure.
async function renderOne(browser, golden, view, outPath) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: view.dpr,
  });
  try {
    const page = await context.newPage();
    const label = `${golden.id}-${view.name}`;
    const errors = [];
    let onError;
    const firstError = new Promise((resolveErr) => {
      onError = resolveErr;
    });
    page.on('pageerror', (err) => {
      errors.push(err.message);
      console.log(`[page] pageerror ${label}: ${err.message}`);
      onError(err.message);
    });

    await page.goto(galleryUrl({ golden: golden.id, view: view.name }));
    const ready = page
      .waitForFunction(() => window.__goldenReady === true, null, { timeout: READY_TIMEOUT_MS })
      .then(
        () => null,
        () => `timed out waiting for window.__goldenReady after ${READY_TIMEOUT_MS / 1000} s`,
      );
    const early = await Promise.race([ready, firstError.then((msg) => `page error: ${msg}`)]);
    if (early) return early;
    if (errors.length) return `page error: ${errors[0]}`;

    await page.screenshot({ path: outPath, fullPage: false });
    return null;
  } catch (err) {
    return err.message.split('\n')[0];
  } finally {
    await context.close();
  }
}

async function main() {
  const { prefixes, viewNames } = parseArgs(process.argv.slice(2));
  if (!existsSync(galleryPath)) {
    console.log(`FAIL gallery: not found: ${galleryPath}`);
    return 1;
  }
  let pw;
  try {
    pw = await loadPlaywright();
  } catch (err) {
    console.log(`FAIL playwright: ${err.message}`);
    return 1;
  }
  const { chromium } = pw;
  await mkdir(goldensDir, { recursive: true });

  let browser;
  let rendered = 0;
  let failed = 0;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });

    const listContext = await browser.newContext();
    const listPage = await listContext.newPage();
    listPage.on('pageerror', (err) => console.log(`[page] pageerror (list): ${err.message}`));
    await listPage.goto(galleryUrl({ list: '1' }));
    try {
      await listPage.waitForFunction(() => Array.isArray(window.__goldenList), null, {
        timeout: READY_TIMEOUT_MS,
      });
    } catch {
      console.log(`FAIL gallery list: window.__goldenList never appeared`);
      return 1;
    }
    const list = await listPage.evaluate(() => window.__goldenList);
    await listContext.close();

    const goldens = list.filter(
      (g) => prefixes.length === 0 || prefixes.some((p) => g.id.startsWith(p)),
    );
    if (goldens.length === 0) {
      console.log(`FAIL no goldens match: ${prefixes.join(', ')}`);
      return 1;
    }

    const jobs = [];
    for (const golden of goldens) {
      for (const view of golden.views) {
        if (!viewNames || viewNames.includes(view.name)) jobs.push({ golden, view });
      }
    }
    if (jobs.length === 0) {
      console.log(`FAIL no views match --views=${viewNames.join(',')}`);
      return 1;
    }

    for (const { golden, view } of jobs) {
      const label = `${golden.id}-${view.name}`;
      const outPath = join(goldensDir, `${label}.png`);
      const started = performance.now();
      const reason = await renderOne(browser, golden, view, outPath);
      const ms = performance.now() - started;
      if (reason) {
        failed++;
        console.log(`FAIL ${label}: ${reason} (${ms.toFixed(0)} ms)`);
        continue;
      }
      rendered++;
      const buf = await readFile(outPath);
      const { width, height } = pngSize(buf);
      console.log(
        `${outPath}  ${width}x${height} px  ${(buf.length / 1024).toFixed(1)} KB  ${ms.toFixed(0)} ms`,
      );
    }
    console.log(`${rendered} rendered, ${failed} failed`);
  } finally {
    await browser?.close();
  }
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.log(`FAIL render-goldens crashed: ${err.stack ?? err}`);
    process.exitCode = 1;
  });
