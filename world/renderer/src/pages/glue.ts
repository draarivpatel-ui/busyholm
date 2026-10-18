/**
 * Page glue for the WP-02 Tauri shell (app/README.md page contract): boot data, bh:* events and
 * bh_* commands. Without a core (a plain browser) every command is a no-op and the page runs the
 * scripted demo in a loop, so the strip and ambient pages also open straight from disk.
 */
import { createRenderer, type Renderer, type RendererOptions } from '../browser.ts';
import type { Choices, Ledger, Moment, Settings, Snapshot, World } from '../../../../contracts/ts/src/types.ts';
import { grow } from '../../../grow/src/index.ts';
import { demoTimeline, BASE_DATE } from './demo.ts';
import { connectSnapshots } from './snapshot-bootstrap.ts';

/** WP-02 world inputs: the page derives the World itself (the core is Rust and cannot run grow()). */
interface WorldInputs {
  seed: number;
  ledger: Ledger;
  choices: Choices;
}

function worldFrom(inp: unknown): World | null {
  const w = inp as WorldInputs | null;
  if (!w || typeof w.seed !== 'number' || !w.ledger || !w.choices) return null;
  try {
    return grow(w.seed, w.ledger, w.choices);
  } catch (e) {
    console.warn('busyholm: grow() rejected the world inputs; keeping the last world', e);
    return null;
  }
}

interface Boot {
  surface: 'strip' | 'ambient';
  os: string;
  settings: Settings;
  strip: { supported: boolean; layer: string; w: number; h: number; scale: number } | null;
  test: { freeze: boolean; fixed_rect: boolean; report?: boolean };
}
interface TauriGlobal {
  core: { invoke(cmd: string, args?: unknown): Promise<unknown> };
  event: { listen(name: string, fn: (e: { payload: unknown }) => void): Promise<() => void> };
}
declare global {
  interface Window {
    __BUSYHOLM_BOOT__?: Boot;
    __TAURI__?: TauriGlobal;
    __bhRenderer?: Renderer;
  }
}

function reducedFrom(settings: Settings | undefined): boolean {
  const mode = settings?.other?.reduced_motion ?? 'follow_os';
  return mode === 'always' || (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

export function startPage(surface: 'strip' | 'ambient'): { r: Renderer; now: () => number } {
  const boot = window.__BUSYHOLM_BOOT__;
  const tauri = window.__TAURI__;
  const canvas = document.getElementById('world') as HTMLCanvasElement;
  const invoke = (cmd: string, args?: unknown) => (tauri ? tauri.core.invoke(cmd, args).catch(() => undefined) : Promise.resolve(undefined));
  const settings = boot?.settings;
  const width = surface === 'strip' ? boot?.strip?.w ?? innerWidth : innerWidth;
  const height = surface === 'strip' ? boot?.strip?.h ?? innerHeight : innerHeight;
  const dpr = surface === 'strip' ? boot?.strip?.scale ?? devicePixelRatio : devicePixelRatio;
  const freeze = !!boot?.test?.freeze;
  const fixed = !!boot?.test?.fixed_rect;
  const demo = !tauri;
  let virt = 0;
  const q = new URLSearchParams(location.search);
  const variant = (q.get('variant') ?? undefined) as RendererOptions['variant'];
  const opts: RendererOptions = {
    surface,
    width,
    height,
    dpr,
    canvas,
    variant,
    reducedMotion: freeze || reducedFrom(settings),
    hemisphere: settings?.sky?.hemisphere ?? 'north',
    skyMode: settings?.sky?.mode ?? 'usage_and_clock',
    species: settings?.agents?.species ?? {},
    date: demo ? () => new Date(BASE_DATE + virt) : undefined,
    onHitRects: surface === 'strip' ? (msg) => void invoke('bh_hit_rects', { msg }) : undefined,
    extraHitBoxes: fixed ? () => [{ x: width / 2 - 20, y: height - 64, w: 40, h: 40, kind: 'other' }] : undefined,
  };
  const r = createRenderer(opts);
  window.__bhRenderer = r;
  let appliedCounts = { agents: 0, working: 0 };
  const applySnapshot = (s: Snapshot) => {
    r.setSnapshot(s);
    if (boot?.test?.report) appliedCounts = {
      agents: s.agents.length, working: s.agents.filter((a) => a.state === 'working').length,
    };
  };

  // Enabled only with the core's optional acceptance log. Normal product runs have no stats
  // timer or diagnostic IPC, and error text and agent payloads never enter the log.
  if (tauri && boot?.test?.report) {
    setInterval(() => {
      const s = r.stats();
      void invoke('bh_renderer_stats', { stats: {
        t: Math.round(performance.now()), drawn: s.drawn, ticks: s.ticks, mode: s.mode,
        errors: r.errors().length, visible: s.mode !== 'hidden', w: innerWidth, h: innerHeight,
        ...appliedCounts,
      } });
    }, 2000);
  }

  if (tauri) {
    const on = (name: string, fn: (p: unknown) => void) => tauri.event.listen(name, (e) => fn(e.payload));
    void connectSnapshots((receive) => on('bh:snapshot', (p) => receive(p as Snapshot)),
      async () => (await invoke('bh_get_snapshot') ?? null) as Snapshot | null, applySnapshot).catch(() => undefined);
    on('bh:moment', (p) => r.pushMoment(p as Moment));
    // World: grow(seed, ledger, choices) in the page (deterministic across V8 and JavaScriptCore, WP-08)
    let haveWorld = false;
    const applyInputs = (p: unknown) => {
      const w = worldFrom(p);
      if (w) {
        haveWorld = true;
        r.setWorld(w);
      }
    };
    on('bh:world-inputs', applyInputs);
    on('bh:settings', (p) => {
      const st = p as Settings;
      r.setReducedMotion(freeze || reducedFrom(st));
      // the rest of the settings take effect live too (M16)
      r.updateSettings({ hemisphere: st?.sky?.hemisphere, skyMode: st?.sky?.mode, species: st?.agents?.species });
    });
    on('bh:strip-fade', (p) => r.setFade(!!(p as { on: boolean }).on));
    on('bh:visibility', (p) => {
      const v = !!(p as { visible: boolean }).visible;
      r.setVisible(v);
      void invoke('bh_visibility_ack', { visible: v });
    });
    on('bh:strip-geometry', (p) => {
      const g = p as { w: number; h: number; scale: number };
      r.resize(g.w, g.h, g.scale);
    });
    // until bh_get_world_inputs lands in the core (WP-02), the demo hamlet stands in
    void invoke('bh_get_world_inputs').then((p) => {
      applyInputs(p);
      if (!haveWorld) r.setWorld(demoTimeline().worlds.after);
    });
  } else {
    // a plain browser: loop the scripted demo
    const tl = demoTimeline();
    const run = () => {
      const t0 = performance.now();
      let next = 0;
      const pump = () => {
        virt = performance.now() - t0;
        while (next < tl.steps.length && tl.steps[next].at <= virt) {
          const s = tl.steps[next++];
          if (s.kind === 'world') r.setWorld(s.world);
          else if (s.kind === 'snapshot') r.setSnapshot(s.snapshot);
          else r.pushMoment(s.moment);
        }
        if (next < tl.steps.length) setTimeout(pump, Math.max(1, tl.steps[next].at - virt));
        else setTimeout(run, tl.duration - virt + 2000);
      };
      pump();
    };
    run();
  }
  addEventListener('resize', () => {
    if (surface === 'ambient' || !boot?.strip) r.resize(innerWidth, innerHeight, devicePixelRatio);
  });
  // In Tauri the core's bh:visibility is the authority: WebKit reports a visible, non-activating strip
  // window as document.visibilityState 'hidden' (measured in the spike shell), so only a plain browser uses it.
  if (!tauri) document.addEventListener('visibilitychange', () => r.setVisible(document.visibilityState === 'visible'));
  return { r, now: () => (opts.date ? opts.date() : new Date()).getTime() };
}
