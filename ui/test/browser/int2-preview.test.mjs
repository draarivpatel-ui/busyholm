// INT-2 task 2: the onboarding preview tells the truth. The fixture is the REAL installer plan for synthetic
// agent config files in a temp home (built by app/src-tauri/tests/int2_preview_fixture.rs, which also reads the
// events back from the files an install really writes). The real onboarding page renders it; every event the
// installer adds must be visible on the page without scrolling a diff box, and no diff line may be dropped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { start, DEFAULT_SETTINGS, CONNECT, UI } from '../harness.mjs';

const FIXTURE = JSON.parse(readFileSync(join(UI, 'test', 'fixtures', 'real-plan.json'), 'utf8'));
let h;
before(async () => {
  h = await start();
});
after(async () => h && h.close());

async function previewPage() {
  const p = await h.page({ snapshot: null, settings: DEFAULT_SETTINGS, connect: CONNECT, onboarded: false, surface: 'settings', realPreview: FIXTURE.preview }, { viewport: { width: 560, height: 640 } });
  await p.goto(h.base + 'onboarding.html');
  for (let i = 0; i < 6 && !(await p.$('[data-step="preview"]:not([hidden])')); i++) await p.click('#ob-next');
  assert.ok(await p.$('[data-step="preview"]:not([hidden])'), 'reached the preview step');
  return p;
}

test('the preview lists every file of the real plan, with every diff line in the page', async () => {
  const p = await previewPage();
  const shown = await p.evaluate(() =>
    [...document.querySelectorAll('.ob-file')].map((f) => ({
      path: f.querySelector('.ob-file-head code').textContent,
      lines: [...f.querySelectorAll('pre.diff .dl')].map((l) => l.textContent.replace(/\n$/, '')),
    })),
  );
  assert.deepEqual(shown.map((s) => s.path), FIXTURE.preview.files.map((f) => f.path), 'one entry per planned file, in order');
  FIXTURE.preview.files.forEach((f, i) => {
    assert.deepEqual(shown[i].lines, f.diff.replace(/\n$/, '').split('\n'), `${f.path}: every diff line is in the page`);
  });
  assert.deepEqual(p.errors, []);
  await p.ctx.close();
});

test('every hook event the installer adds is named on the page outside the scrolling diff', async () => {
  const p = await previewPage();
  const truth = FIXTURE.ground_truth_events;
  for (const [path, events] of Object.entries(truth)) {
    const text = await p.evaluate((path) => {
      const f = [...document.querySelectorAll('.ob-file')].find((x) => x.querySelector('.ob-file-head code').textContent === path);
      if (!f) return null;
      // everything in the entry except the scrolling diff box
      return [...f.children].filter((c) => !c.querySelector('pre.diff') && c.tagName !== 'PRE').map((c) => c.textContent).join('\n');
    }, path);
    assert.notEqual(text, null, `${path}: has an entry`);
    assert.ok(events.length >= 10, `${path}: ground truth has the events`);
    for (const e of events) {
      assert.ok(new RegExp(`\\b${e}\\b`).test(text), `${path}: "${e}" is added by the installer but is not named in the preview outside the diff box`);
    }
  }
  // Nothing hidden by layout: the entries are not clipped by a fixed height, only the diff box scrolls.
  const clipped = await p.evaluate(() => [...document.querySelectorAll('.ob-file')].filter((f) => f.scrollHeight > f.clientHeight + 1).length);
  assert.equal(clipped, 0, 'no preview entry is clipped');
  await p.ctx.close();
});

test('P1-1: onboarding connect screens state plainly what is kept and where, and that Disconnect removes it', async () => {
  const p = await h.page({ snapshot: null, settings: DEFAULT_SETTINGS, connect: CONNECT, onboarded: false, surface: 'settings', realPreview: FIXTURE.preview }, { viewport: { width: 560, height: 640 } });
  await p.goto(h.base + 'onboarding.html');
  await p.click('#ob-next');
  assert.ok(await p.$('[data-step="choose"]:not([hidden])'), 'reached choose step');
  const chooseText = await p.textContent('[data-step="choose"]');
  assert.match(chooseText, /install-manifest\.json/);
  assert.match(chooseText, /backups\/install/);
  assert.match(chooseText, /0600/);
  assert.match(chooseText, /Disconnect/i);
  await p.click('#ob-next');
  assert.ok(await p.$('[data-step="preview"]:not([hidden])'), 'reached preview step');
  const previewText = await p.textContent('[data-step="preview"]');
  assert.match(previewText, /install-manifest\.json/);
  assert.match(previewText, /backups\/install/);
  assert.match(previewText, /0600/);
  await p.ctx.close();
});

test('P1-2, P2-7: onboarding states that Busyholm reads activity logs and transcripts to count events, never keeps/shows/sends text, and is loopback only', async () => {
  const p = await h.page({ snapshot: null, settings: DEFAULT_SETTINGS, connect: CONNECT, onboarded: false, surface: 'settings', realPreview: FIXTURE.preview }, { viewport: { width: 560, height: 640 } });
  await p.goto(h.base + 'onboarding.html');
  const welcomeText = await p.textContent('[data-step="welcome"]');
  assert.match(welcomeText, /reads .*activity logs and transcripts to count events/i);
  assert.match(welcomeText, /never keeps, shows or sends their text/i);
  assert.match(welcomeText, /no outbound network connections; loopback only/i);
  await p.ctx.close();
});


