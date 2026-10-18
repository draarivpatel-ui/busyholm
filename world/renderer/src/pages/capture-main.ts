/**
 * Capture page: the scripted 20 s sequence on the strip or the ambient view.
 *
 * ?view=strip1440 | strip2560 | ambient     size (Playwright sets the device scale)
 * ?mode=step   virtual time, driven by window.__bh.advance(ms) (deterministic frames for captures)
 * ?mode=live   real timers, the sequence loops (CPU measurement); ?scenario=demo | idle | active
 * ?fps=30      measurement only: tick at 30 fps and draw every tick
 * ?reduced=1   reduced motion
 * Ambient composition: ?scale= ?ground= ?pan= ?res= ?startX=
 */
import { createRenderer, type Renderer, type RendererOptions } from '../browser.ts';
import { demoTimeline, BASE_DATE, IDS, type Step } from './demo.ts';
import { mountNeedsYouCard } from './card.ts';

// the spike's Tauri shell passes its parameters in window.__SPIKE_QS rather than the URL
const q = new URLSearchParams((window as unknown as { __SPIKE_QS?: string }).__SPIKE_QS || location.search);
const view = q.get('view') ?? 'strip1440';
const mode = q.get('mode') ?? 'step';
const scenario = q.get('scenario') ?? 'demo';
const SIZES: Record<string, [number, number]> = { strip1440: [1440, 120], strip2560: [2560, 160], ambient: [1920, 1080] };
const [W, H] = SIZES[view] ?? [innerWidth, innerHeight];
// measurement switch: ?canvas=element makes every helper canvas a <canvas> element instead of an OffscreenCanvas
if (new URLSearchParams((window as unknown as { __SPIKE_QS?: string }).__SPIKE_QS || location.search).get('canvas') === 'element') {
  (globalThis as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas = undefined;
}
const canvas = document.getElementById('world') as HTMLCanvasElement;
const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);

// ?debug=1: show page errors and renderer tick errors in an overlay (for WebKit hosts without a console)
if (q.get('debug') === '1') {
  const box = document.createElement('pre');
  Object.assign(box.style, { position: 'fixed', left: '0', top: '0', right: '0', margin: '0', font: '11px monospace', color: 'white', background: 'rgba(160,0,0,0.85)', whiteSpace: 'pre-wrap', zIndex: '9', display: 'none' });
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(box));
  const show = (m: string) => {
    box.style.display = 'block';
    box.textContent = (box.textContent + '\n' + m).slice(-1500);
    if (!box.isConnected) document.body.appendChild(box);
  };
  addEventListener('error', (e) => show(`error: ${e.message} @ ${e.filename}:${e.lineno}`));
  addEventListener('unhandledrejection', (e) => show(`rejection: ${String(e.reason)}`));
  setInterval(() => {
    const errs = (window as unknown as { __bh?: { renderer(): Renderer } }).__bh?.renderer().errors() ?? [];
    if (errs.length) show(`tick errors (${errs.length}): ${errs[errs.length - 1]}`);
    const st = (window as unknown as { __bh?: { renderer(): Renderer } }).__bh?.renderer().stats();
    if (st) document.title = `drawn ${st.drawn} ticks ${st.ticks} ${st.mode}`;
  }, 1000);
}

// inside the spike's Tauri shell (?report=1): log page health through its page_stats command
const tauriReport = (window as unknown as { __TAURI__?: { core: { invoke(c: string, a: unknown): Promise<unknown> } } }).__TAURI__;
if (tauriReport && q.get('report') === '1') {
  const send = (tag: string) => {
    const rr = (window as unknown as { __bh?: { renderer(): Renderer } }).__bh?.renderer();
    const st = rr?.stats();
    void tauriReport.core.invoke('page_stats', { s: JSON.stringify({ tag, t: Math.round(performance.now()), drawn: st?.drawn, ticks: st?.ticks, mode: st?.mode, errors: rr?.errors().slice(-1), mem: rr?.debugMemory(), vis: document.visibilityState, w: innerWidth, h: innerHeight }) }).catch(() => undefined);
  };
  setTimeout(() => send('t0.5'), 500);
  setInterval(() => send('tick'), 2000);
}

const tl = demoTimeline({ five: num('five'), weekly: num('weekly'), dusk: num('dusk'), weeklyEnd: num('weeklyEnd') });
let steps: Step[] = tl.steps;
if (scenario === 'idle') steps = tl.steps.filter((s) => s.kind === 'world' && s.at === 0).concat([{ at: 0, kind: 'snapshot', snapshot: { ...firstSnapshot(), agents: [], attention: { needs_you: 0, oldest_since: null } } }]);
if (scenario === 'active') steps = tl.steps.filter((s) => s.at <= 2600);

function firstSnapshot() {
  const s = tl.steps.find((x) => x.kind === 'snapshot');
  if (!s || s.kind !== 'snapshot') throw new Error('no snapshot');
  return s.snapshot;
}

let virt = 0;
let next = 0;
let r: Renderer;

function opts(manual: boolean): RendererOptions {
  return {
    surface: view.startsWith('strip') ? 'strip' : 'ambient',
    width: W,
    height: H,
    dpr: devicePixelRatio,
    canvas,
    scheduler: manual ? 'manual' : undefined,
    date: () => new Date(BASE_DATE + virt),
    debug: true,
    reducedMotion: q.get('reduced') === '1',
    variant: (q.get('variant') ?? undefined) as RendererOptions['variant'],
    // the 1920 x 1080 capture view renders at full resolution (marketing frames); live views use the default
    ambient: { worldScale: num('scale'), groundFrac: num('ground'), panSpeed: num('pan'), resScale: num('res') ?? (view === 'ambient' ? 1 : undefined), startX: num('startX') },
    measure: q.get('fps') ? { calmFps: Number(q.get('fps')), alwaysDraw: true } : undefined,
  };
}

function apply(s: Step): void {
  if (s.kind === 'world') r.setWorld(s.world);
  else if (s.kind === 'snapshot') r.setSnapshot(s.snapshot);
  else r.pushMoment(s.moment);
}

function info() {
  const log = r.debugLog();
  const f = log[log.length - 1];
  return f
    ? { virt, frame: f.frame, mode: f.mode, flag: f.flag, sky: f.sky, fx: f.fx, residents: f.residents.map((x) => `${x.species}:${x.intent}/${x.anim}/${x.pose}@${x.x.toFixed(1)}`) }
    : { virt };
}

declare global {
  interface Window {
    __bh: { ready: Promise<void>; duration: number; advance(ms: number): void; canvasRect(): { x: number; y: number; w: number; h: number }; info(): unknown; renderer(): Renderer; ids: typeof IDS };
    __bhStats: { drawn: number; ticks: number; frames: number };
  }
}

if (mode === 'step') {
  r = createRenderer(opts(true));
  const runDue = () => {
    while (next < steps.length && steps[next].at <= virt) apply(steps[next++]);
  };
  runDue();
  r.advance(0);
  const card = view.startsWith('strip') ? null : (mountNeedsYouCard(r, () => BASE_DATE + virt, true), (window as unknown as { __bhCard: () => void }).__bhCard);
  window.__bh = {
    ready: Promise.resolve(),
    duration: tl.duration,
    advance(ms: number) {
      const end = virt + ms;
      while (next < steps.length && steps[next].at <= end) {
        const at = steps[next].at;
        r.advance(at - virt);
        virt = at;
        runDue();
      }
      r.advance(end - virt);
      virt = end;
      card?.();
    },
    canvasRect() {
      const b = canvas.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    },
    info,
    renderer: () => r,
    ids: IDS,
  };
} else {
  // live: real timers, loop the sequence every duration + 2 s
  const start = () => {
    r?.destroy();
    r = createRenderer(opts(false));
    virt = 0;
    next = 0;
    const t0 = performance.now();
    const pump = () => {
      virt = performance.now() - t0;
      while (next < steps.length && steps[next].at <= virt) apply(steps[next++]);
      if (next < steps.length) setTimeout(pump, Math.max(1, steps[next].at - virt));
    };
    pump();
  };
  start();
  if (scenario === 'demo') setInterval(start, tl.duration + 2000);
  if (!SIZES[view]) addEventListener('resize', () => r.resize(innerWidth, innerHeight, devicePixelRatio));
  document.addEventListener('visibilitychange', () => r.setVisible(document.visibilityState === 'visible'));
  if (!view.startsWith('strip')) mountNeedsYouCard({ waiting: () => r.waiting() } as Renderer, () => BASE_DATE + virt);
  window.__bhStats = { drawn: 0, ticks: 0, frames: 0 };
  setInterval(() => {
    const s = r.stats();
    window.__bhStats = { drawn: s.drawn, ticks: s.ticks, frames: s.drawn };
  }, 500);
  window.__bh = {
    ready: Promise.resolve(),
    duration: tl.duration,
    advance() {},
    canvasRect() {
      const b = canvas.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    },
    info,
    renderer: () => r,
    ids: IDS,
  };
}
