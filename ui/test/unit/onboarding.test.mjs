// Onboarding finish ordering (ui/src/ui/onboarding.js), run on a minimal stand-in DOM and a fake Tauri core: a strip
// change still saving when the user finishes must reach the core before onboarding is marked done and the window closes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function element() {
  const listeners = {};
  return {
    listeners,
    dataset: {},
    style: { setProperty() {} },
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeAttribute() {},
    setAttribute() {},
    querySelectorAll: () => [],
  };
}

test('finishing waits for a strip change that is still saving', async () => {
  const log = [];
  let releaseSave;
  const settings = { strip: { layer_mode: 'on_top', height: 112 }, other: { reduced_motion: 'follow_os' } };
  const invoke = (cmd, args) => {
    if (cmd === 'bh_set_settings') {
      log.push('save started');
      return new Promise((resolve) => { releaseSave = () => { log.push('save done'); resolve(args.settings); }; });
    }
    if (cmd === 'bh_onboarding' && args.action === 'get') return new Promise(() => {}); // keep the page from rendering
    log.push(cmd === 'bh_onboarding' ? 'onboarding ' + args.action : cmd);
    return Promise.resolve(null);
  };
  const elements = new Map();
  globalThis.window = {
    __TAURI__: { core: { invoke }, event: { listen: async () => () => {} } },
    __BUSYHOLM_BOOT__: { surface: 'settings', os: 'macos', settings, strip: { supported: true } },
    addEventListener() {},
    dispatchEvent() {},
  };
  globalThis.location = { search: '', pathname: '/onboarding.html', href: '', replace() {} };
  globalThis.document = Object.assign(element(), {
    documentElement: element(),
    body: element(),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
  });
  await import('../../src/ui/onboarding.js');

  for (const fn of document.listeners.change) fn({ target: { name: 'height', value: '136' } });
  const finished = elements.get('ob-skip').listeners.click[0]();
  for (let k = 0; k < 10; k++) await Promise.resolve();
  assert.deepEqual(log, ['save started'], 'nothing closes while the save is open');
  releaseSave();
  await finished;
  assert.deepEqual(log, ['save started', 'save done', 'onboarding done', 'bh_close']);
});
