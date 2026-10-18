// Browser QA for the Busyholm art kit.
// Opens tests.html in Chrome, waits for window.__done, then checks:
//   1. atlas build median time against a budget
//   2. silhouette separation (minDiff per species) against a threshold
//
// Usage: node tools/browser-tests.mjs
// Env:   ATLAS_BUDGET_MS  (default 150)
//        SILHOUETTE_MIN   (default 0.12)
//        TESTS_PAGE       (page to load instead of tests.html; absolute, or relative to the art root)
// Exit:  0 if every assertion passes, 1 otherwise (including a page that never finishes).
// Needs Playwright: PLAYWRIGHT_PATH to a playwright-core package directory if it is not installed in the repo.

import { loadPlaywright } from '../../../tools/lib/playwright.mjs';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const artRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pagePath = resolvePath(process.env.TESTS_PAGE ?? 'tests.html');
const ATLAS_BUDGET_MS = Number(process.env.ATLAS_BUDGET_MS ?? 150);
const SILHOUETTE_MIN = Number(process.env.SILHOUETTE_MIN ?? 0.12);
const SPEC_BUDGET_MS = 300;
const DONE_TIMEOUT_MS = 120_000;

let failures = 0;

function resolvePath(p) {
  return isAbsolute(p) ? p : join(artRoot, p);
}

function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
}

function checkAtlas(atlas) {
  if (!atlas) {
    check('atlas', false, 'no atlas result on window.__results');
    return;
  }
  if (atlas.error) {
    check('atlas', false, `error: ${atlas.error}`);
    return;
  }
  const { scale, runsMs, medianMs, sprites, width, height } = atlas;
  if (!Number.isFinite(medianMs)) {
    check('atlas', false, `medianMs is not a number (${medianMs})`);
    return;
  }
  console.log(
    `atlas @${scale}x: median ${medianMs.toFixed(1)} ms over ${runsMs.length} runs ` +
      `(${sprites} sprites, ${width}x${height}); budget ${ATLAS_BUDGET_MS} ms on this machine ` +
      `(SPEC budget ${SPEC_BUDGET_MS} ms on M1)`,
  );
  check(
    'atlas median',
    medianMs <= ATLAS_BUDGET_MS,
    `${medianMs.toFixed(1)} ms <= budget ${ATLAS_BUDGET_MS} ms`,
  );
}

function checkSilhouettes(sil) {
  if (!sil) {
    check('silhouettes', false, 'no silhouette result on window.__results');
    return;
  }
  if (sil.error) {
    check('silhouettes', false, `error: ${sil.error}`);
    return;
  }
  const species = Object.keys(sil);
  check('silhouettes present', species.length >= 1, `${species.length} species`);

  for (const name of species) {
    const { poses, minDiff } = sil[name];
    const pairs = sil[name].pairs ?? [];
    const closest = pairs.length ? pairs.reduce((best, p) => (p.diff < best.diff ? p : best)) : null;
    const closestText = closest
      ? `closest pair (${closest.a}, ${closest.b}) diff ${closest.diff.toFixed(3)}`
      : 'no pairs';
    console.log(
      `silhouette ${name}: ${poses.length} poses, minDiff ${minDiff.toFixed(3)}, ${closestText}`,
    );
    const ok = minDiff >= SILHOUETTE_MIN;
    check(`silhouette ${name} minDiff`, ok, `${minDiff.toFixed(3)} >= ${SILHOUETTE_MIN}`);
    if (!ok) {
      for (const p of pairs) {
        if (p.diff < SILHOUETTE_MIN) {
          console.log(`  below threshold: (${p.a}, ${p.b}) diff ${p.diff.toFixed(3)}`);
        }
      }
    }
  }
}

async function main() {
  console.log(`machine: ${cpus()[0]?.model ?? 'unknown CPU'}`);
  if (!existsSync(pagePath)) {
    check('page', false, `not found: ${pagePath}`);
    return 1;
  }

  let pw;
  try {
    pw = await loadPlaywright();
  } catch (err) {
    check('playwright', false, err.message);
    return 1;
  }
  const { chromium } = pw;

  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.on('console', (msg) => console.log(`[page] ${msg.text()}`));
    page.on('pageerror', (err) => console.log(`[page] pageerror: ${err.message}`));

    await page.goto(pathToFileURL(pagePath).href);
    try {
      await page.waitForFunction(() => window.__done === true, null, { timeout: DONE_TIMEOUT_MS });
    } catch {
      check('page finished', false, `window.__done never became true within ${DONE_TIMEOUT_MS / 1000} s`);
      return 1;
    }

    const results = await page.evaluate(() => window.__results);
    checkAtlas(results?.atlas);
    checkSilhouettes(results?.silhouettes);
  } finally {
    await browser?.close();
  }
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.log(`FAIL browser-tests crashed: ${err.stack ?? err}`);
    process.exitCode = 1;
  });
