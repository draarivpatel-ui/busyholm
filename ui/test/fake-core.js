// A test double of the Tauri core for the WP-11 pages, installed with page.addInitScript before
// any page script runs, so pages take exactly the code path they take in the app (window.__TAURI__
// and window.__BUSYHOLM_BOOT__). window.__fake records every command and can emit core events.
(function () {
  const init = window.__FAKE_INIT__ || {};
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const state = {
    snapshot: init.snapshot ?? null,
    settings: init.settings,
    worldInputs: init.worldInputs ?? null,
    connect: init.connect,
    onboarded: init.onboarded ?? true,
    rejectNext: null,
    token: 0,
    pending: null,
  };
  const listeners = new Map();
  const calls = [];
  function emit(name, payload) {
    for (const cb of listeners.get(name) || []) cb({ event: name, payload: clone(payload) });
  }
  function preview(parts, disconnect) {
    state.token += 1;
    state.pending = { token: state.token, parts: parts.slice(), disconnect };
    // init.realPreview: a preview built by the real installer (ui/test/fixtures/real-plan.json), served as it is.
    if (init.realPreview && !disconnect) return Object.assign(clone(init.realPreview), { token: state.token });
    const chosen = state.connect.parts.filter((p) => (parts.length ? parts.includes(p.part) : p.connected));
    const files = [];
    for (const p of chosen) if (!files.some((f) => f.path === p.path)) files.push({ path: p.path, diff: (disconnect ? '-' : '+') + '  "Stop": [ busyholm entry ]\n', note: null, creates: false, deletes: false });
    return { token: state.token, files, notes: [], noop: files.length === 0 };
  }
  async function invoke(cmd, args) {
    calls.push({ cmd, args: clone(args) });
    switch (cmd) {
      case 'bh_get_snapshot': return clone(state.snapshot);
      case 'bh_get_settings': return clone(state.settings);
      case 'bh_set_settings': {
        if (state.rejectNext) { const e = state.rejectNext; state.rejectNext = null; throw e; }
        state.settings = clone(args.settings);
        setTimeout(() => emit('bh:settings', state.settings), 0);
        return clone(state.settings);
      }
      case 'bh_get_world_inputs': return clone(state.worldInputs);
      case 'bh_open': case 'bh_close': case 'bh_page_event': return null;
      case 'bh_connect_status': return clone(state.connect);
      case 'bh_connect_preview': return preview(args.parts || [], false);
      case 'bh_disconnect_preview': return preview(args.parts || [], true);
      case 'bh_connect_apply': {
        if (!state.pending || state.pending.token !== args.token) throw 'That preview is out of date. Preview again.';
        for (const p of state.connect.parts) {
          if (state.pending.parts.length === 0 || state.pending.parts.includes(p.part)) {
            p.connected = !state.pending.disconnect;
            p.pending_review = p.connected && p.part === 'codex_hooks';
          }
        }
        state.connect.any_connected = state.connect.parts.some((p) => p.connected);
        state.pending = null;
        setTimeout(() => emit('bh:connect-status', state.connect), 0);
        return clone(state.connect);
      }
      case 'bh_delete_everything': {
        if (state.rejectNext) { const e = state.rejectNext; state.rejectNext = null; throw e; }
        for (const p of state.connect.parts) {
          p.connected = false;
          p.pending_review = false;
        }
        state.connect.any_connected = false;
        state.pending = null;
        setTimeout(() => emit('bh:connect-status', state.connect), 0);
        return clone(state.connect);
      }
      case 'bh_onboarding':
        if (args.action === 'done') state.onboarded = true;
        return { done: state.onboarded };
      case 'bh_third_party_notices':
        return init.notices ?? 'Busyholm Third-Party Notices\n\ncargo: serde 1.0 (MIT OR Apache-2.0)\nnpm: esbuild 0.28.2 (MIT)\nSIL OPEN FONT LICENSE Version 1.1\n';
      default: throw 'unknown command ' + cmd;
    }
  }
  window.__TAURI__ = {
    core: { invoke },
    event: {
      listen(name, cb) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(cb);
        return Promise.resolve(() => listeners.get(name).delete(cb));
      },
    },
  };
  window.__BUSYHOLM_BOOT__ = Object.assign(
    { surface: init.surface || 'popover', os: init.os || 'macos', settings: clone(state.settings), strip: { supported: true, layer: 'on_top', w: 1512, h: 112, scale: 2 }, test: { freeze: true, fixed_rect: false }, world_inputs: clone(state.worldInputs) },
    init.boot || {},
  );
  window.__fake = { calls, emit, state, reject(msg) { state.rejectNext = msg; } };
})();
