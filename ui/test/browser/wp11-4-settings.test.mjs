// SPEC 9.1 WP-11 test 4: settings round-trip atomically. The form shows exactly what the core
// holds; every change sends ONE complete, schema-valid Settings v1 that differs from the last
// accepted one in exactly the changed field; a rejected save changes nothing and the form goes
// back to the last accepted values; a reload shows what was saved.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, DEFAULT_SETTINGS, CONNECT } from '../harness.mjs';
import { validate } from '../../../contracts/ts/src/validate.ts';

let h;
before(async () => (h = await start()));
after(async () => h && h.close());

const START = {
  ...DEFAULT_SETTINGS,
  strip: { ...DEFAULT_SETTINGS.strip, height: 120, layer_mode: 'behind_windows' },
  sound: { ...DEFAULT_SETTINGS.sound, volume: 0.45, quiet_hours: { start: '22:30', end: '06:45' } },
  agents: { species: { codex: 'hare' } },
  ambient: { idle_minutes: 20, shortcut: null },
  other: { ...DEFAULT_SETTINGS.other, reduced_motion: 'always' },
};

function get(o, path) {
  return path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
}
/** Dot paths whose values differ (deep, leaves only). */
function diff(a, b, base = '') {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const p = base ? base + '.' + k : k;
    const x = a ? a[k] : undefined;
    const y = b ? b[k] : undefined;
    if (x && y && typeof x === 'object' && typeof y === 'object') out.push(...diff(x, y, p));
    else if (JSON.stringify(x) !== JSON.stringify(y)) out.push(p);
  }
  return out;
}

async function open(settings) {
  const p = await h.page({ settings, connect: CONNECT, surface: 'settings' }, { viewport: { width: 560, height: 640 } });
  await p.goto(h.base + 'settings.html');
  await p.waitForFunction(() => window.__bhSettings && window.__bhSettings.saved);
  return p;
}
const saves = (p) => p.evaluate(() => window.__fake.calls.filter((c) => c.cmd === 'bh_set_settings').map((c) => c.args.settings));

test('the form shows every stored value', async () => {
  const p = await open(START);
  const shown = await p.evaluate(() =>
    [...document.querySelectorAll('[data-path]')].map((e) => ({ path: e.dataset.path, type: e.type || e.tagName, value: e.type === 'checkbox' ? e.checked : e.type === 'radio' ? (e.checked ? e.value : null) : e.value })),
  );
  const paths = new Set(shown.map((s) => s.path));
  for (const must of ['strip.enabled', 'strip.height', 'strip.layer_mode', 'strip.hover_fade', 'strip.show_over_fullscreen', 'sky.mode', 'sky.hemisphere', 'sound.bell', 'sound.volume', 'sound.quiet_hours', 'notifications.needs_you', 'notifications.renotify', 'notifications.long_turn', 'notifications.errors', 'ambient.idle_minutes', 'other.launch_at_login', 'other.reduced_motion', 'agents.species.codex']) {
    assert.ok(paths.has(must), 'a control for ' + must);
  }
  assert.ok(!paths.has('privacy.project_names'), 'P2-6: Show project names row removed');
  assert.ok(!paths.has('updates.check'), 'P2-6: Check for updates row removed');
  for (const s of shown) {
    const v = get(START, s.path);
    if (s.type === 'checkbox' && s.path === 'sound.quiet_hours') assert.equal(s.value, v !== null);
    else if (s.type === 'checkbox') assert.equal(s.value, v, s.path);
    else if (s.type === 'radio') { if (s.value !== null) assert.equal(s.value, String(v), s.path); }
    else if (s.path === 'agents.species.codex') assert.equal(s.value, 'hare');
    else if (s.path === 'ambient.idle_minutes') assert.equal(s.value, v === null ? '' : String(v));
    else if (s.path === 'sound.volume' || s.path === 'strip.height') assert.equal(Number(s.value), v, s.path);
    else if (s.path === 'sound.quiet_hours.start' || s.path === 'sound.quiet_hours.end') assert.equal(s.value, v, s.path);
  }
  const bodyText = await p.textContent('body');
  assert.match(bodyText, /reads .*activity logs and transcripts to count events/i);
  assert.match(bodyText, /never keeps, shows or sends their text/i);
  assert.match(bodyText, /no outbound network connections; loopback only/i);
  assert.doesNotMatch(bodyText, /Check for updates/);
  assert.doesNotMatch(bodyText, /Show project names/);
  assert.deepEqual(p.errors, []);
  await p.ctx.close();
});

test('every switch sends one whole, valid Settings v1 that changes only that field', async () => {
  const p = await open(START);
  const switches = await p.evaluate(() => [...document.querySelectorAll('input[type="checkbox"][data-path]:not([disabled])')].map((e) => e.dataset.path));
  assert.ok(switches.length >= 10, 'found ' + switches.length + ' switches');
  let prev = await p.evaluate(() => window.__bhSettings.saved);
  assert.deepEqual(prev, START);
  for (const path of switches) {
    const before = (await saves(p)).length;
    await p.click(`input[data-path="${path}"]`);
    await p.waitForFunction((n) => window.__fake.calls.filter((c) => c.cmd === 'bh_set_settings').length > n, before);
    const sent = (await saves(p)).at(-1);
    const v = validate('settings', sent);
    assert.ok(v.ok, path + ': sent settings must be valid Settings v1: ' + JSON.stringify(v.issues));
    const changed = diff(prev, sent);
    if (path === 'sound.quiet_hours') assert.ok(changed.every((c) => c.startsWith('sound.quiet_hours')) && changed.length >= 1, path + ' changed ' + changed);
    else assert.deepEqual(changed, [path], path + ' must change only itself');
    await p.waitForFunction((s) => JSON.stringify(window.__bhSettings.saved) === JSON.stringify(s), sent);
    prev = sent;
  }
  assert.deepEqual(p.errors, []);
  await p.ctx.close();
});

test('radios, ranges and selects save one field each', async () => {
  const p = await open(START);
  let prev = START;
  const step = async (action, expectPath) => {
    const before = (await saves(p)).length;
    await action();
    await p.waitForFunction((n) => window.__fake.calls.filter((c) => c.cmd === 'bh_set_settings').length > n, before);
    const sent = (await saves(p)).at(-1);
    assert.ok(validate('settings', sent).ok, expectPath + ' valid');
    assert.deepEqual(diff(prev, sent), [expectPath]);
    prev = sent;
    await p.waitForFunction((s) => JSON.stringify(window.__bhSettings.saved) === JSON.stringify(s), sent);
  };
  await step(() => p.check('input[data-path="strip.layer_mode"][value="on_top"]'), 'strip.layer_mode');
  await step(() => p.check('input[data-path="sky.hemisphere"][value="south"]'), 'sky.hemisphere');
  await step(() => p.evaluate(() => { const e = document.querySelector('input[data-path="strip.height"]'); e.value = '136'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }), 'strip.height');
  assert.equal(prev.strip.height, 136);
  assert.ok(Number.isInteger(prev.strip.height));
  await step(() => p.selectOption('select[data-path="ambient.idle_minutes"]', ''), 'ambient.idle_minutes');
  assert.equal(prev.ambient.idle_minutes, null);
  await step(() => p.selectOption('select[data-path="agents.species.claude"]', 'frog'), 'agents.species.claude');
  // Choosing the default species removes the override (a tool not listed uses the default).
  const before = (await saves(p)).length;
  await p.selectOption('select[data-path="agents.species.codex"]', 'otter');
  await p.waitForFunction((n) => window.__fake.calls.filter((c) => c.cmd === 'bh_set_settings').length > n, before);
  const sent = (await saves(p)).at(-1);
  assert.ok(!('codex' in sent.agents.species), 'default species is stored as no override');
  assert.ok(validate('settings', sent).ok);
  assert.deepEqual(p.errors, []);
  await p.ctx.close();
});

test('a rejected save changes nothing: the form returns to the last accepted values and says why', async () => {
  const p = await open(START);
  const saved0 = await p.evaluate(() => window.__bhSettings.saved);
  await p.evaluate(() => window.__fake.reject('settings: the core refused this value'));
  await p.click('input[data-path="notifications.errors"]');
  await p.waitForSelector('.field-error[role="alert"]');
  assert.match(await p.textContent('.field-error[role="alert"]'), /refused/);
  assert.equal(await p.isChecked('input[data-path="notifications.errors"]'), saved0.notifications.errors, 'switch is back to the saved value');
  assert.deepEqual(await p.evaluate(() => window.__bhSettings.saved), saved0, 'nothing changed');
  assert.deepEqual(await p.evaluate(() => window.__fake.state.settings), saved0, 'the core still holds the old settings');
  await p.ctx.close();
});

test('round trip: what was saved is what a reopened window shows', async () => {
  const p = await open(START);
  assert.ok(await p.evaluate(() => document.documentElement.classList.contains('reduce-motion')), 'reduced_motion "always" applies the reduce-motion class');
  await p.click('input[data-path="notifications.long_turn"]');
  await p.check('input[data-path="other.reduced_motion"][value="follow_os"]');
  await p.waitForFunction(() => window.__bhSettings.saved.other.reduced_motion === 'follow_os' && window.__bhSettings.saved.notifications.long_turn === false);
  const stored = await p.evaluate(() => window.__fake.state.settings);
  await p.ctx.close();
  const q = await open(stored);
  assert.deepEqual(await q.evaluate(() => window.__bhSettings.saved), stored);
  assert.equal(await q.isChecked('input[data-path="notifications.long_turn"]'), false);
  assert.equal(await q.isChecked('input[data-path="other.reduced_motion"][value="follow_os"]'), true);
  assert.ok(!(await q.evaluate(() => document.documentElement.classList.contains('reduce-motion'))), 'follow_os leaves motion to the OS setting');
  await q.ctx.close();
});

test('P1-1: Delete everything asks for confirmation, disconnects first and removes the data folder', async () => {
  const connected = { ...CONNECT, parts: CONNECT.parts.map((x) => ({ ...x, connected: x.available })), any_connected: true };
  const p = await h.page({ settings: START, connect: connected, surface: 'settings' }, { viewport: { width: 560, height: 640 } });
  await p.goto(h.base + 'settings.html');
  await p.waitForSelector('#delete-everything');
  await p.click('#delete-everything');
  await p.waitForSelector('dialog[open]');
  const dlgText = await p.textContent('dialog[open]');
  assert.match(dlgText, /disconnect/i);
  assert.match(dlgText, /ledger/);
  assert.match(dlgText, /backups/);
  assert.match(dlgText, /coverage\.json/);
  assert.match(dlgText, /logs/);
  assert.match(dlgText, /close when it is done/i);
  await p.click('dialog[open] #confirm-ok');
  await p.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === 'bh_delete_everything'));
  await p.waitForFunction(() => !document.querySelector('dialog[open]'));
  assert.equal(await p.isDisabled('#disconnect-all'), true, 'hooks are now disconnected');
  assert.deepEqual(p.errors, []);
  await p.ctx.close();
});

test('P2-3: Third-party notices opens from Settings and shows Rust, npm and Fraunces OFL notices', async () => {
  const p = await open(START);
  await p.waitForSelector('#notices-btn', { timeout: 1500 });
  await p.click('#notices-btn');
  await p.waitForSelector('dialog[open] #notices-text', { timeout: 1500 });
  const text = await p.textContent('dialog[open] #notices-text');
  assert.match(text, /cargo: serde /);
  assert.match(text, /npm: /);
  assert.match(text, /SIL OPEN FONT LICENSE/);
  assert.ok(await p.evaluate(() => window.__fake.calls.some((c) => c.cmd === 'bh_third_party_notices')));
  assert.deepEqual(p.errors, []);
  await p.ctx.close();
});

