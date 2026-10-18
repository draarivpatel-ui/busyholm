// SPEC 9.1 WP-11 test 3: axe-core reports 0 serious (or critical) issues, and keyboard paths
// complete in the details window and settings (plus the popover and onboarding).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { start, axe, DEFAULT_SETTINGS, CONNECT, REPO, rendered } from '../harness.mjs';

let h;
before(async () => (h = await start()));
after(async () => h && h.close());

const snap = (n) => JSON.parse(readFileSync(join(REPO, 'fixtures', 'contracts', 'snapshot.v2', 'valid', n), 'utf8'));
// A busy scene: the six-agent demo scenario from the UI itself (needs-you, error, limited, idle).
async function busy() {
  const { SCENARIOS } = await import('../../src/ui/scenarios.js');
  return { ...SCENARIOS.attention, demo: false };
}
const connected = () => ({ ...CONNECT, parts: CONNECT.parts.map((p) => ({ ...p, connected: p.available, pending_review: p.part === 'codex_hooks' })), any_connected: true });

const SURFACES = [
  ['popover', { width: 360, height: 480 }],
  ['details', { width: 440, height: 560 }],
  ['settings', { width: 560, height: 640 }],
  ['onboarding', { width: 560, height: 640 }],
];

for (const [surface, viewport] of SURFACES) {
  for (const colorScheme of ['light', 'dark']) {
    test(`axe: ${surface} (${colorScheme}) has no serious or critical violations`, async () => {
      const s = await busy();
      const p = await h.page({ snapshot: s, settings: DEFAULT_SETTINGS, connect: connected(), onboarded: surface !== 'onboarding', surface }, { viewport, colorScheme });
      await p.goto(h.base + surface + '.html');
      await p.waitForTimeout(400);
      const v = await axe(p);
      assert.deepEqual(v, [], JSON.stringify(v, null, 1));
      assert.deepEqual(p.errors, []);
      await p.ctx.close();
    });
  }
}

for (const colorScheme of ['light', 'dark']) {
  test(`axe: popover empty states (${colorScheme}): nothing running, and hooks not connected`, async () => {
    const { SCENARIOS } = await import('../../src/ui/scenarios.js');
    for (const k of ['quiet', 'none']) {
      const p = await h.page({ snapshot: { ...SCENARIOS[k], demo: false }, settings: DEFAULT_SETTINGS, connect: CONNECT }, { colorScheme });
      await p.goto(h.base + 'popover.html');
      await p.waitForTimeout(300);
      assert.deepEqual(await axe(p), [], k);
      await p.ctx.close();
    }
  });
}

test('axe: onboarding preview step and settings dialogs have no serious violations', async () => {
  const p = await h.page({ snapshot: await busy(), settings: DEFAULT_SETTINGS, connect: CONNECT, onboarded: false, surface: 'settings' }, { viewport: { width: 560, height: 640 } });
  await p.goto(h.base + 'onboarding.html');
  for (let i = 0; i < 6 && !(await p.$('[data-step="preview"]:not([hidden])')); i++) await p.click('#ob-next');
  assert.ok(await p.$('[data-step="preview"]:not([hidden])'), 'reached the preview step');
  assert.deepEqual(await axe(p), []);
  await p.ctx.close();
  const q = await h.page({ snapshot: await busy(), settings: DEFAULT_SETTINGS, connect: connected(), surface: 'settings' }, { viewport: { width: 560, height: 640 } });
  await q.goto(h.base + 'settings.html');
  await q.waitForSelector('#disconnect-all:not([disabled])');
  await q.click('#disconnect-all');
  await q.waitForSelector('dialog[open]');
  await q.waitForTimeout(400); // let the open animation finish so contrast is measured on final colours
  assert.deepEqual(await axe(q), []);
  await q.ctx.close();
});

/** Tab through the page; returns the sequence of focused element keys (stops when it cycles). */
async function tabWalk(p, max = 80) {
  const seen = [];
  for (let i = 0; i < max; i++) {
    await p.keyboard.press('Tab');
    const k = await p.evaluate(() => {
      const e = document.activeElement;
      if (!e || e === document.body) return 'body';
      return e.tagName + '#' + (e.id || '') + '[' + (e.dataset.path || e.dataset.part || e.dataset.agent || e.getAttribute('aria-label') || e.textContent.trim().slice(0, 24)) + ']';
    });
    if (seen.length && k === seen[0]) break;
    seen.push(k);
  }
  return seen;
}

test('keyboard: details window reaches every control and moves through agents with the arrow keys', async () => {
  const s = await busy();
  const p = await h.page({ snapshot: s, settings: DEFAULT_SETTINGS, connect: connected(), surface: 'details' }, { viewport: { width: 440, height: 560 } });
  await p.goto(h.base + 'details.html');
  await rendered(p, s.t);
  const walk = await tabWalk(p);
  const focusable = await p.evaluate(() => [...document.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex="0"]')].filter((e) => e.offsetParent !== null).length);
  assert.ok(walk.length >= focusable, `tab reaches all ${focusable} stops (got ${walk.length}: ${walk.join(', ')})`);
  // Roving focus inside the agent list
  await p.focus('.agent-row[tabindex="0"]');
  const ids = [];
  for (let i = 0; i < s.agents.length + 1; i++) {
    ids.push(await p.evaluate(() => document.activeElement.dataset.agent));
    await p.keyboard.press('ArrowDown');
  }
  const main = s.agents.filter((a) => !a.parent).length;
  assert.equal(new Set(ids.filter(Boolean)).size, main, 'ArrowDown visits every agent row');
  await p.keyboard.press('Home');
  assert.equal(await p.evaluate(() => document.activeElement.dataset.state), 'needs_you', 'Home goes to the first row (needs you first)');
  assert.deepEqual(p.errors, []);
  await p.ctx.close();
});

test('keyboard: settings changes a switch, opens Disconnect all, traps focus, Escape returns focus', async () => {
  const p = await h.page({ snapshot: await busy(), settings: DEFAULT_SETTINGS, connect: connected(), surface: 'settings' }, { viewport: { width: 560, height: 640 } });
  await p.goto(h.base + 'settings.html');
  await p.waitForSelector('#disconnect-all:not([disabled])');
  const walk = await tabWalk(p, 160);
  assert.ok(walk.some((k) => k.includes('notifications.renotify')), 'tab reaches the re-notify switch');
  assert.ok(walk.some((k) => k.includes('disconnect-all')), 'tab reaches Disconnect all');
  // Toggle a switch with Space
  await p.focus('[data-path="notifications.renotify"]');
  await p.keyboard.press('Space');
  await p.waitForFunction(() => window.__bhSettings && window.__bhSettings.saved.notifications.renotify === false);
  // Open the dialog with Enter
  await p.focus('#disconnect-all');
  await p.keyboard.press('Enter');
  await p.waitForSelector('dialog[open]');
  for (let i = 0; i < 8; i++) {
    await p.keyboard.press('Tab');
    assert.ok(await p.evaluate(() => !!document.activeElement.closest('dialog[open]')), 'focus stays inside the open dialog');
  }
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => !document.querySelector('dialog[open]'));
  assert.equal(await p.evaluate(() => document.activeElement.id), 'disconnect-all', 'focus returns to the button that opened the dialog');
  // Confirm path by keyboard: Enter on Disconnect all, then on the confirm button
  await p.keyboard.press('Enter');
  await p.waitForSelector('dialog[open] #confirm-ok');
  await p.focus('#confirm-ok');
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === 'bh_connect_apply'));
  assert.deepEqual(p.errors, []);
  await p.ctx.close();
});

test('keyboard: onboarding completes with the keyboard alone', async () => {
  const p = await h.page({ snapshot: await busy(), settings: DEFAULT_SETTINGS, connect: CONNECT, onboarded: false, surface: 'settings' }, { viewport: { width: 560, height: 640 } });
  await p.goto(h.base + 'onboarding.html');
  for (let i = 0; i < 20; i++) {
    if (await p.evaluate(() => window.__fake.calls.some((c) => c.cmd === 'bh_onboarding' && c.args.action === 'done'))) break;
    await p.focus('#ob-next');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(60);
  }
  const calls = await p.evaluate(() => window.__fake.calls.map((c) => c.cmd + (c.args && c.args.action ? ':' + c.args.action : '')));
  assert.ok(calls.includes('bh_connect_preview'), 'onboarding previewed the hook changes');
  assert.ok(calls.includes('bh_connect_apply'), 'onboarding applied the previewed plan');
  assert.ok(calls.includes('bh_onboarding:done'), 'onboarding finished');
  assert.deepEqual(p.errors, []);
  await p.ctx.close();
});

test('keyboard: popover reaches its actions and Escape closes it', async () => {
  const s = await busy();
  const p = await h.page({ snapshot: s, settings: DEFAULT_SETTINGS, connect: connected() }, {});
  await p.goto(h.base + 'popover.html');
  await rendered(p, s.t);
  const walk = await tabWalk(p);
  for (const label of ['Settings', 'Details', 'Ambient', 'Strip']) assert.ok(walk.some((k) => k.includes(label)), `tab reaches ${label}: ${walk.join(', ')}`);
  await p.keyboard.press('Escape');
  assert.ok(await p.evaluate(() => window.__fake.calls.some((c) => c.cmd === 'bh_close')));
  await p.ctx.close();
});
