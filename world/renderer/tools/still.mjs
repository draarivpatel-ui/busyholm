// Renders single frames of the capture page at chosen times, for tuning by eye.
//   node tools/still.mjs --view ambient --at 2000,6000 --qs "five=75" --out /tmp/stills
import { loadPlaywright } from '../../../tools/lib/playwright.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Needs Playwright: set PLAYWRIGHT_PATH to a playwright-core package directory if it is not installed in the repo.
const { chromium } = await loadPlaywright().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : a), []));
const view = args.view ?? 'ambient';
const ats = (args.at ?? '2000').split(',').map(Number).sort((a, b) => a - b);
const out = args.out ?? join(tmpdir(), 'stills');
const tag = args.tag ?? '';
mkdirSync(out, { recursive: true });
const here = dirname(fileURLToPath(import.meta.url));
const page0 = join(here, '..', '..', 'dist', 'capture.html');
const size = { strip1440: [1440, 120, 2], strip2560: [2560, 160, 2], ambient: [1920, 1080, 1] }[view];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: size[2] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`${pathToFileURL(page0)}?view=${view}&mode=step&${args.qs ?? ''}`);
  await page.waitForFunction(() => !!window.__bh, null, { timeout: 20000 });
  let t = 0;
  for (const at of ats) {
    const t0 = Date.now();
    await page.evaluate((ms) => window.__bh.advance(ms), at - t);
    t = at;
    const path = join(out, `${view}${tag}-${String(at).padStart(5, '0')}.png`);
    await page.screenshot({ path, clip: { x: 0, y: 0, width: size[0], height: size[1] } });
    console.log(path, `${Date.now() - t0} ms`, JSON.stringify(await page.evaluate(() => window.__bh.info())).slice(0, 300));
  }
} finally {
  await browser.close();
}
