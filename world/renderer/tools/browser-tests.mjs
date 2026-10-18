// WP-10 acceptance tests (2) and (3) in real Chrome with real timers (the Node suite runs them
// in virtual time). Usage: node tools/build.mjs && node tools/browser-tests.mjs [--headed]
import { loadPlaywright } from '../../../tools/lib/playwright.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Needs Playwright: set PLAYWRIGHT_PATH to a playwright-core package directory if it is not installed in the repo.
const { chromium } = await loadPlaywright().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

const here = dirname(fileURLToPath(import.meta.url));
const page0 = join(here, '..', '..', 'dist', 'bench.html');
const headed = process.argv.includes('--headed');
const browser = await chromium.launch({ channel: 'chrome', headless: !headed });
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failed++;
};
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 120 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(pathToFileURL(page0).href);
  await page.waitForFunction(() => !!window.__bhBench, null, { timeout: 20000 });
  const lat = await page.evaluate(() => window.__bhBench.latency(40));
  check('(2) needs_you Moment to drawn flag, p95 <= 250 ms (40 episodes)', lat.p95 <= 250, `p50 ${lat.p50.toFixed(1)} ms, p95 ${lat.p95.toFixed(1)} ms, max ${lat.max.toFixed(1)} ms`);
  const gov = await page.evaluate(() => window.__bhBench.governor());
  check('(3) calm <= 12 fps (any 1 s window)', gov.calmMax <= 12, `per second ${gov.calmPerSecond.join(' ')}, worst sliding window ${gov.calmSliding}`);
  check('(3) celebration <= 30 fps (any 1 s window)', gov.burstMax <= 30, `per second ${gov.burstPerSecond.join(' ')}, worst sliding window ${gov.burstSliding}`);
  check('(3) calm again after 3 s', gov.afterSliding <= 12, `worst sliding window from 3 s on: ${gov.afterSliding}`);
  check('(3) celebration burst <= 3 s', gov.burstSeconds <= 3.05, `${gov.burstSeconds.toFixed(2)} s at burst rate`);
  check('(3) hidden 0 fps', gov.hiddenFrames === 0 && gov.hiddenTicks === 0, `${gov.hiddenFrames} frames, ${gov.hiddenTicks} ticks in 5 s hidden`);
  check('(3) the alert shows on unhide', gov.flagAfterShow === true, String(gov.flagAfterShow));
  check('(5) reduced motion: render on change only', gov.reducedIdleFrames5s <= 1, `${gov.reducedIdleFrames5s} frames in 5 s idle`);
  check('(5) reduced motion: the alert still shows', gov.reducedFlag?.raised === true, JSON.stringify(gov.reducedFlag));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
