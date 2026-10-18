// FIX-C M6: the core reports OpenCode as unavailable in this version (unavailable_reason); the pages
// must say so instead of "Not found on this computer", and must not let it be selected or connected.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, DEFAULT_SETTINGS, CONNECT } from '../harness.mjs';

const REASON = 'OpenCode is not supported in this version yet.';
const CONNECT_M6 = {
  ...CONNECT,
  parts: CONNECT.parts.map((p) => (p.part === 'opencode_plugin' ? { ...p, available: false, unavailable_reason: REASON } : p)),
};
let h;
before(async () => (h = await start()));
after(async () => h && h.close());

test('onboarding: OpenCode is disabled and the page gives the core\'s reason', async () => {
  const p = await h.page({ snapshot: null, settings: DEFAULT_SETTINGS, connect: CONNECT_M6, onboarded: false, surface: 'settings' }, { viewport: { width: 560, height: 640 } });
  await p.goto(h.base + 'onboarding.html');
  await p.click('#ob-next');
  await p.waitForSelector('#ob-parts [data-part="opencode_plugin"]');
  const row = await p.evaluate(() => {
    const l = document.querySelector('#ob-parts [data-part="opencode_plugin"]');
    return { disabled: l.querySelector('input').disabled, checked: l.querySelector('input').checked, text: l.textContent };
  });
  assert.equal(row.disabled, true);
  assert.equal(row.checked, false);
  assert.ok(row.text.includes(REASON), row.text);
  assert.ok(!row.text.includes('Not found on this computer'), row.text);
  assert.ok(!row.text.includes('Shows OpenCode sessions'), row.text);
  assert.deepEqual(p.errors, []);
  await p.ctx.close();
});

test('settings: the OpenCode row shows the reason and its Connect button is disabled', async () => {
  const p = await h.page({ settings: DEFAULT_SETTINGS, connect: CONNECT_M6, surface: 'settings' }, { viewport: { width: 560, height: 640 } });
  await p.goto(h.base + 'settings.html');
  await p.waitForSelector('[data-row-part="opencode_plugin"]');
  const row = await p.evaluate(() => {
    const r = document.querySelector('[data-row-part="opencode_plugin"]');
    return { status: r.querySelector('.status').textContent, desc: r.querySelector('.row-desc').textContent, disabled: r.querySelector('button').disabled };
  });
  assert.equal(row.status, REASON);
  assert.ok(!row.desc.includes('Shows OpenCode sessions'), row.desc);
  assert.equal(row.disabled, true);
  await p.ctx.close();
});

