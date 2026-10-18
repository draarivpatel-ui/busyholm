/**
 * bench.html: WP-10 acceptance tests (2) and (3) in a real browser with real timers.
 * tools/browser-tests.mjs calls window.__bhBench.latency() and .governor().
 */
import { createRenderer, type Renderer, type DebugFrame } from '../browser.ts';
import { demoTimeline, BASE_DATE, IDS } from './demo.ts';
import type { Snapshot } from '../../../../contracts/ts/src/types.ts';

const canvas = document.getElementById('world') as HTMLCanvasElement;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tl = demoTimeline();
const first = tl.steps.find((s) => s.kind === 'snapshot')!;
const baseSnap = (first as { snapshot: Snapshot }).snapshot;

function make(reduced = false): Renderer {
  const r = createRenderer({ surface: 'strip', width: 1440, height: 120, dpr: devicePixelRatio, canvas, debug: true, reducedMotion: reduced, date: () => new Date(BASE_DATE + performance.now()) });
  r.setWorld(tl.worlds.before);
  r.setSnapshot(baseSnap);
  return r;
}

function framesIn(log: DebugFrame[], a: number, b: number): number {
  return log.filter((f) => f.t >= a && f.t < b).length;
}

let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) % 10000) / 10000;

declare global {
  interface Window {
    __bhBench: { latency(n?: number): Promise<unknown>; governor(): Promise<unknown> };
  }
}

window.__bhBench = {
  async latency(n = 40) {
    const r = make();
    await sleep(3000);
    const samples: number[] = [];
    for (let i = 0; i < n; i++) {
      await sleep(900 + rand() * 1800);
      const tool = i % 2 ? 'claude' : 'codex';
      const agent = i % 2 ? IDS.beaver2 : IDS.otter;
      const t0 = performance.now();
      r.pushMoment({ schema_version: 1, kind: 'needs_you', t: BASE_DATE + Math.round(t0), agent, tool, reason: 'permission' });
      await sleep(400);
      const f = r.debugLog().find((x) => x.t >= t0 && x.flag.raised);
      samples.push(f ? f.t + f.drawMs - t0 : Infinity);
      r.pushMoment({ schema_version: 1, kind: 'answered', t: BASE_DATE + Math.round(performance.now()), agent, tool });
    }
    r.destroy();
    const s = [...samples].sort((a, b) => a - b);
    const p = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
    return { n, p50: p(0.5), p95: p(0.95), max: s[s.length - 1], samples };
  },
  async governor() {
    const r = make();
    await sleep(4000);
    const c0 = performance.now();
    await sleep(10000);
    const log = r.debugLog();
    const calm: number[] = [];
    for (let i = 0; i < 10; i++) calm.push(framesIn(log, c0 + i * 1000, c0 + (i + 1) * 1000));
    let calmSliding = 0;
    for (let a = c0; a < c0 + 9000; a += 20) calmSliding = Math.max(calmSliding, framesIn(log, a, a + 1000));
    // celebration
    const b0 = performance.now();
    r.pushMoment({ schema_version: 1, kind: 'turn_end', t: BASE_DATE + Math.round(b0), agent: IDS.beaver2, tool: 'claude', turn_ms: 1000 });
    await sleep(7000);
    const log2 = r.debugLog();
    const burst: number[] = [];
    for (let i = 0; i < 7; i++) burst.push(framesIn(log2, b0 + i * 1000, b0 + (i + 1) * 1000));
    let burstSliding = 0;
    for (let a = b0 - 1000; a < b0 + 6000; a += 20) burstSliding = Math.max(burstSliding, framesIn(log2, a, a + 1000));
    let afterSliding = 0;
    for (let a = b0 + 3050; a < b0 + 6000; a += 20) afterSliding = Math.max(afterSliding, framesIn(log2, a, a + 1000));
    const fast = log2.filter((f) => f.t >= b0 && f.mode === 'burst');
    const burstSeconds = fast.length ? (fast[fast.length - 1].t - b0) / 1000 : 0;
    // hidden: no frames, even with moments arriving
    r.setVisible(false);
    const h0 = r.stats();
    r.pushMoment({ schema_version: 1, kind: 'needs_you', t: BASE_DATE + Math.round(performance.now()), agent: IDS.otter, tool: 'codex', reason: 'question' });
    await sleep(5000);
    const h1 = r.stats();
    r.setVisible(true);
    await sleep(300);
    const shown = r.debugLog()[r.debugLog().length - 1];
    r.destroy();
    // reduced motion: alert still shows, almost no frames
    const rr = make(true);
    await sleep(1500);
    const d0 = rr.stats().drawn;
    await sleep(5000);
    const idleFrames = rr.stats().drawn - d0;
    rr.pushMoment({ schema_version: 1, kind: 'needs_you', t: BASE_DATE + Math.round(performance.now()), agent: IDS.otter, tool: 'codex', reason: 'question' });
    await sleep(300);
    const rf = rr.debugLog()[rr.debugLog().length - 1];
    rr.destroy();
    return {
      calmPerSecond: calm,
      calmMax: Math.max(...calm, calmSliding),
      calmSliding,
      burstSliding,
      afterSliding,
      burstPerSecond: burst,
      burstMax: Math.max(...burst, burstSliding),
      burstSeconds,
      hiddenFrames: h1.drawn - h0.drawn,
      hiddenTicks: h1.ticks - h0.ticks,
      flagAfterShow: shown?.flag.raised ?? false,
      reducedIdleFrames5s: idleFrames,
      reducedFlag: rf?.flag ?? null,
    };
  },
};
