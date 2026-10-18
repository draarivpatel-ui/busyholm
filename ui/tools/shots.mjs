// WP-11 screenshot matrix into ui/evidence/ (PNGs gitignored): every surface, light and dark,
// 1x and 2x, with 1, 3 and 6 agents and a needs-you alert. Pages run against the test fake core
// (the same code path as in the app), with live (non-demo) snapshots.
import { join } from 'node:path';
import { start, DEFAULT_SETTINGS, CONNECT } from '../test/harness.mjs';
import { SCENARIOS, DEMO_WORLD_INPUTS } from '../src/ui/scenarios.js';

const out = join(import.meta.dirname, '..', 'evidence');
const live = (k) => ({ ...SCENARIOS[k], demo: false });
const connected = { ...CONNECT, parts: CONNECT.parts.map((p) => ({ ...p, connected: p.available, pending_review: p.part === 'codex_hooks' })), any_connected: true };
const h = await start();
const shots = [];
async function shot(name, surface, init, opts, before) {
  const p = await h.page({ settings: DEFAULT_SETTINGS, worldInputs: DEMO_WORLD_INPUTS, connect: connected, surface, ...init }, opts);
  await p.goto(h.base + surface + '.html' + (opts.query || ''));
  await p.waitForTimeout(700);
  if (before) await before(p);
  const file = join(out, name + '.png');
  await p.screenshot({ path: file, fullPage: !!opts.full });
  if (p.errors.length) console.error(name, p.errors);
  shots.push(file);
  await p.ctx.close();
}
for (const theme of ['light', 'dark']) {
  for (const dpr of [1, 2]) {
    for (const k of ['one', 'three', 'six']) {
      await shot(`popover-${k}-${theme}-${dpr}x`, 'popover', { snapshot: live(k) }, { viewport: { width: 360, height: 480 }, dpr, colorScheme: theme });
      await shot(`details-${k}-${theme}-${dpr}x`, 'details', { snapshot: live(k) }, { viewport: { width: 440, height: 560 }, dpr, colorScheme: theme, full: true });
    }
    await shot(`settings-${theme}-${dpr}x`, 'settings', { snapshot: live('three') }, { viewport: { width: 560, height: 640 }, dpr, colorScheme: theme });
    await shot(`onboarding-welcome-${theme}-${dpr}x`, 'onboarding', { snapshot: live('none'), onboarded: false, connect: CONNECT }, { viewport: { width: 560, height: 640 }, dpr, colorScheme: theme });
  }
  await shot(`popover-empty-${theme}-2x`, 'popover', { snapshot: live('quiet') }, { viewport: { width: 360, height: 480 }, dpr: 2, colorScheme: theme });
  await shot(`popover-not-connected-${theme}-2x`, 'popover', { snapshot: live('none') }, { viewport: { width: 360, height: 480 }, dpr: 2, colorScheme: theme });
  await shot(`settings-disconnect-all-${theme}-2x`, 'settings', { snapshot: live('three') }, { viewport: { width: 560, height: 640 }, dpr: 2, colorScheme: theme }, async (p) => {
    await p.click('#disconnect-all');
    await p.waitForTimeout(500);
  });
  await shot(`popover-glass-${theme}-2x`, 'popover', { snapshot: live('three') }, { viewport: { width: 360, height: 480 }, dpr: 2, colorScheme: theme, query: '?wallpaper=1' });
}
for (const step of ['choose', 'preview', 'codex', 'strip', 'done']) {
  await shot(`onboarding-${step}-light-2x`, 'onboarding', { snapshot: live('three'), onboarded: false, connect: CONNECT }, { viewport: { width: 560, height: 640 }, dpr: 2, colorScheme: 'light' }, async (p) => {
    for (let i = 0; i < 8; i++) {
      if (await p.evaluate(() => document.documentElement.dataset.obStep) === step) break;
      await p.click('#ob-next');
      await p.waitForTimeout(250);
    }
    await p.waitForTimeout(300);
  });
}
await h.close();
console.log(shots.length + ' screenshots in ' + out);
