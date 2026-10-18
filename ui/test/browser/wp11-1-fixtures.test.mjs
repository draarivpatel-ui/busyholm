// SPEC 9.1 WP-11 test 1: every fixture scenario renders, and no project name appears when the
// opt-in is off (DOM test, text AND attributes). With the opt-in on, the name is shown.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, fixtures, DEFAULT_SETTINGS, CONNECT, rendered } from '../harness.mjs';

let h;
let snaps;
before(async () => {
  h = await start();
  snaps = await fixtures('snapshot.v2');
});
after(async () => h && h.close());

const withNames = (on) => ({ ...DEFAULT_SETTINGS, privacy: { ...DEFAULT_SETTINGS.privacy, project_names: on } });

/** Everything a user or assistive tech can get at: text plus every attribute value in <body>. */
async function exposed(page) {
  return page.evaluate(() => {
    const out = [document.body.innerText, document.title];
    for (const el of document.body.querySelectorAll('*')) for (const a of el.attributes) out.push(a.value);
    return out.join('\n');
  });
}

async function check(surface, viewport) {
  let count = 0;
  for (const { name, data } of snaps) {
    for (const optIn of [false, true]) {
      const p = await h.page({ snapshot: data, settings: withNames(optIn), connect: CONNECT, surface }, { viewport });
      await p.goto(h.base + surface + '.html');
      await rendered(p, data.t);
      const main = data.agents.filter((a) => !a.parent);
      const info = await p.evaluate(() => ({
        rows: [...document.querySelectorAll('.agent-row')].map((r) => ({ state: r.dataset.state, agent: r.dataset.agent })),
        helpers: document.querySelectorAll('.helper-row').length,
        more: (document.querySelector('.more-btn') || { textContent: '' }).textContent,
      }));
      if (surface === 'details') {
        assert.equal(info.rows.length, main.length, `${name}: details lists every main agent`);
        assert.equal(info.helpers, data.agents.length - main.length, `${name}: details lists every helper`);
      } else {
        const more = Number((info.more.match(/^(\d+) more/) || [0, 0])[1]);
        assert.equal(info.rows.length + more, main.length, `${name}: popover rows plus "more" cover every agent`);
      }
      const waiting = main.filter((a) => a.state === 'needs_you').length;
      assert.ok(info.rows.slice(0, waiting).every((r) => r.state === 'needs_you'), `${name}: needs-you rows come first`);
      const labels = data.agents.map((a) => a.project_label).filter((l) => typeof l === 'string' && l.length);
      const text = await exposed(p);
      for (const l of labels) {
        if (optIn) {
          if (surface === 'details') assert.ok(text.includes(l), `${name}: opt-in on shows the project name in details`);
        } else {
          assert.ok(!text.includes(l), `${name}: project name "${l}" must not appear with the opt-in off (${surface})`);
        }
      }
      assert.deepEqual(p.errors, [], `${name}: no page errors (${surface})`);
      await p.ctx.close();
      count += 1;
    }
  }
  return count;
}

test('popover renders every Snapshot v2 fixture; project names only with the opt-in', async () => {
  const n = await check('popover', { width: 360, height: 480 });
  assert.equal(n, snaps.length * 2);
});

test('details window renders every Snapshot v2 fixture; project names only with the opt-in', async () => {
  const n = await check('details', { width: 440, height: 560 });
  assert.equal(n, snaps.length * 2);
});

test('a later snapshot event replaces the shown state; an older one is ignored', async () => {
  const [a, b] = [snaps.find((s) => s.name.startsWith('005')).data, snaps.find((s) => s.name.startsWith('002')).data];
  const p = await h.page({ snapshot: a, settings: withNames(false), connect: CONNECT }, {});
  await p.goto(h.base + 'popover.html');
  await rendered(p, a.t);
  const newer = { ...b, t: a.t + 1000 };
  await p.evaluate((s) => window.__fake.emit('bh:snapshot', s), newer);
  await rendered(p, newer.t);
  await p.evaluate((s) => window.__fake.emit('bh:snapshot', s), { ...a, t: a.t - 1000 });
  await p.waitForTimeout(50);
  assert.equal(await p.evaluate(() => document.documentElement.dataset.snapshotT), String(newer.t));
  await p.ctx.close();
});
