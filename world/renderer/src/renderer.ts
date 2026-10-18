/**
 * createRenderer: wires the world model, the frame governor, a view (canvas) or none (headless),
 * the HitRects publisher and the debug log.
 *
 * Each governor tick: model.step(now) gives a display list; its signature (everything that would
 * change a pixel) is compared with the last drawn one, and the frame is drawn only if it differs.
 * That is how a calm world stays under its CPU budget: ticks are cheap, drawing is skipped unless
 * something visibly stepped.
 */
import type { ArtVariant, CanonicalArtVariant, Clock, DebugFrame, LiveSettings, DebugResident, FrameStats, HitRects, Moment, Renderer, RendererOptions, Scheduler, Snapshot, World } from './api.ts';
import { realClock, realScheduler, VirtualTime } from './clock.ts';
import { Governor } from './governor.ts';
import { HitRectsPublisher, type HitBox } from './hitrects.ts';
import { WorldModel, type DisplayList } from './model.ts';
import { makeXf, toCss, GROUND_Y, type ViewXf } from './viewxf.ts';
import { SPECIES_DEFS } from '../../art/src/residents.ts';
import { STRUCTURES } from '../../art/src/structures.ts';

/** What a drawing backend must provide (the canvas view; tests run without one). */
export interface View {
  draw(dl: DisplayList, xf: ViewXf): void;
  /** pending work (a plane rebuild or a crossfade) that needs more ticks */
  busy(): boolean;
  /** changes whenever the view would draw differently for the same display list */
  key(): string;
  setFade(on: boolean): void;
  memory(): Record<string, number>;
  resize(xf: ViewXf): void;
  setVisible(v: boolean): void;
  destroy(): void;
}

export type ViewFactory = (canvas: HTMLCanvasElement, xf: ViewXf, opts: RendererOptions) => View;

let viewFactory: ViewFactory | null = null;
/** The browser entry registers the canvas view; Node tests never load canvas code. */
export function registerViewFactory(f: ViewFactory): void {
  viewFactory = f;
}

export function normalizeVariant(v?: ArtVariant): CanonicalArtVariant {
  if (!v || v === 'default') return 'default';
  if (v === 'A' || v === 'deeper_papercut') return 'deeper_papercut';
  if (v === 'B' || v === 'seasonal_richness') return 'seasonal_richness';
  if (v === 'C' || v === 'evening_warmth') return 'evening_warmth';
  return 'default';
}

const LOG_CAP = 4000;

export function createRenderer(opts: RendererOptions): Renderer {
  const variant = normalizeVariant(opts.variant);
  const manual = opts.scheduler === 'manual';
  const vt = manual ? new VirtualTime(1000) : null;
  const clock: Clock = vt ?? opts.clock ?? realClock;
  const scheduler: Scheduler = vt ?? (opts.scheduler && opts.scheduler !== 'manual' ? opts.scheduler : realScheduler);
  const date = opts.date ?? (() => new Date());
  let xf = makeXf(opts.surface, opts.width, opts.height, opts.dpr, opts.maxDpr, opts.ambient, variant);

  const model = new WorldModel({
    surface: opts.surface,
    seed: opts.seed ?? 11,
    reducedMotion: !!opts.reducedMotion,
    species: opts.species ?? {},
    hemisphere: opts.hemisphere ?? 'north',
    skyMode: opts.skyMode ?? 'usage_and_clock',
    date,
    ambientView: opts.surface === 'ambient' ? { visibleW: xf.W, panSpeed: xf.ambient!.panSpeed, startX: xf.ambient!.startX } : undefined,
    pxPerUnit: xf.s * xf.res,
  });

  const view: View | null = opts.canvas && viewFactory ? viewFactory(opts.canvas, xf, opts) : null;
  const publisher =
    opts.surface === 'strip'
      ? new HitRectsPublisher({ wallNow: () => date().getTime(), send: (m) => opts.onHitRects?.(m) })
      : null;

  const log: DebugFrame[] = [];
  let lastSig = '';
  let frameNo = 0;
  let lastDrawAt = 0;
  let destroyed = false;

  function boxesOf(dl: DisplayList): { boxes: HitBox[]; byId: Map<string, DebugResident['box']> } {
    const boxes: HitBox[] = [];
    const byId = new Map<string, DebugResident['box']>();
    for (const r of dl.residents) {
      const h = SPECIES_DEFS[r.species].h * (r.helper ? 0.55 : 1);
      const half = r.helper ? 6 : 10;
      const [x0, y0] = toCss(xf, r.x, GROUND_Y + r.dy - h - 4, dl.camX);
      const box = { x: x0 - half * xf.s, y: y0, w: half * 2 * xf.s, h: (h + 6) * xf.s };
      byId.set(r.id, box);
      boxes.push({ ...box, kind: 'resident', agent: r.id, priority: r.intent === 'alert' ? 1 : 2 });
    }
    if (dl.flag.raised && dl.bellVisible) {
      const b = dl.layout.bell;
      const pts = STRUCTURES[b.kind]!.points(b.stage);
      const fx = b.x + (pts.flag?.[0] ?? 1);
      const [x0, y0] = toCss(xf, fx - 6, 80 + (pts.flag?.[1] ?? -64) - 5, dl.camX);
      const [x1, y1] = toCss(xf, fx + 18, 80 + (pts.bell?.[1] ?? -50) + 16, dl.camX);
      boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, kind: 'bell', priority: 0 });
    }
    for (const e of opts.extraHitBoxes?.() ?? []) boxes.push({ ...e, priority: 0 });
    return { boxes, byId };
  }

  // The page can change its own clickable areas (extraHitBoxes) without any pixel changing; those
  // are published on the tick that notices, drawn frame or not.
  let lastExtraKey = '';
  const extraKey = (): string => {
    const e = opts.extraHitBoxes?.();
    return e && e.length ? JSON.stringify(e) : '';
  };

  function signature(dl: DisplayList): string {
    const k = xf.s * xf.res;
    const q = (v: number) => Math.round(v * k);
    const parts: string[] = [dl.layoutKey, dl.sky.phase.toFixed(4), dl.sky.weather, dl.sky.season, String(q(dl.camX * 4)), String(q(dl.clouds)), String(dl.particleStep)];
    for (const r of dl.residents) parts.push(`${r.id.slice(0, 6)}${r.pose}${q(r.x)}${q(r.dy)}${r.facing}${r.alpha}${r.glow ? 1 : 0}`);
    const f = dl.flag;
    parts.push(`F${f.raised ? 1 : 0}${f.icon}${f.ringing ? f.swing : 'x'}${f.wave}${f.rise}${dl.bellVisible ? 1 : 0}`);
    for (const [id, a] of dl.parts) parts.push(id + Math.round(a * 24));
    if (dl.smoke.length) parts.push('S' + dl.smoke.join(',') + Math.floor(dl.t * 4));
    for (const p of dl.planks) parts.push(`P${q(p.x)},${q(p.y)},${Math.round(p.rot * 10)}`);
    for (const d of dl.dust) parts.push(`D${q(d.x)},${Math.round(d.scale * 40)},${Math.round(d.alpha * 20)}`);
    if (dl.confetti.length) parts.push(`C${dl.confetti.length},${q(dl.confetti[0].x)},${q(dl.confetti[0].y)}`);
    for (const s of dl.showers) parts.push(`R${q(s[0])}`);
    for (const e of dl.extras) parts.push(`E${e.n}`);
    if (view) parts.push(view.key());
    return parts.join('|');
  }

  // sliding one-second frame cap (SPEC 6.6): at most 30 drawn frames in any second during a burst
  // or while the ambient camera moves, at most 12 calm frames otherwise. A capped frame is not lost:
  // the scene still differs, so the next tick draws it.
  const recent: { t: number; fast: boolean }[] = [];
  function capped(now: number, mode: string): boolean {
    while (recent.length && recent[0].t <= now - 1000) recent.shift();
    if (mode === 'reduced' || opts.measure) return false;
    const fast = mode === 'burst' || mode === 'ambient-moving';
    const n = fast ? recent.length : recent.filter((f) => !f.fast).length;
    return n >= (fast ? 30 : 12);
  }

  // a throw inside a tick must never stop the loop (the governor only reschedules after a tick returns)
  const errors: string[] = [];
  function onTick(now: number, mode: string): { animating: boolean; drawn: boolean; cameraMoving: boolean; nextChangeAt: number | null } {
    try {
      return tick(now, mode);
    } catch (e) {
      const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
      if (errors.length < 20) errors.push(msg);
      if (errors.length <= 3 && typeof console !== 'undefined') console.error('busyholm renderer tick failed', e);
      lastSig = '';
      return { animating: true, drawn: false, cameraMoving: false, nextChangeAt: null };
    }
  }

  function tick(now: number, mode: string): { animating: boolean; drawn: boolean; cameraMoving: boolean; nextChangeAt: number | null } {
    if (destroyed) return { animating: false, drawn: false, cameraMoving: false, nextChangeAt: null };
    const t = now / 1000;
    const dl = model.step(t, mode === 'calm' || mode === 'ambient-still', view?.busy() ? 6 : undefined);
    const sig = signature(dl);
    let drawn = false;
    const changed = sig !== lastSig || !!opts.measure?.alwaysDraw;
    if (changed && capped(now, mode)) {
      return { animating: true, drawn: false, cameraMoving: dl.cameraMoving, nextChangeAt: null };
    }
    if (changed) {
      recent.push({ t: now, fast: mode === 'burst' || mode === 'ambient-moving' });
      lastSig = sig;
      const d0 = clock.now();
      view?.draw(dl, xf);
      const drawMs = clock.now() - d0;
      drawn = true;
      frameNo++;
      lastDrawAt = now;
      const { boxes, byId } = boxesOf(dl);
      if (publisher) {
        lastExtraKey = extraKey();
        publisher.publish(boxes, { w: xf.width, h: xf.height }, xf.dpr);
      }
      if (opts.debug) {
        const residents: DebugResident[] = dl.residents.map((r) => ({
          id: r.id,
          tool: r.tool,
          species: r.species,
          intent: r.intent,
          anim: r.anim,
          variant: r.variant,
          pose: r.pose,
          x: r.x,
          box: byId.get(r.id) ?? null,
          faded: r.faded,
          helper: r.helper,
        }));
        log.push({
          t: now,
          frame: frameNo,
          mode: gov.mode(),
          residents,
          flag: { raised: dl.flag.raised, icon: dl.flag.icon, ringing: dl.flag.ringing },
          sky: { phase: dl.sky.phase, weather: dl.sky.weather, season: dl.sky.season },
          fx: dl.fx,
          sinceInput: Math.max(0, now - model.lastInputAt * 1000),
          drawMs,
        });
        if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
      }
    }
    if (!drawn && publisher) {
      const k = extraKey();
      if (k !== lastExtraKey) {
        lastExtraKey = k;
        publisher.publish(boxesOf(dl).boxes, { w: xf.width, h: xf.height }, xf.dpr);
      }
    }
    const busy = view?.busy() ?? false;
    const animating = dl.animating || busy || !!opts.measure?.calmFps;
    if (opts.surface === 'strip' && mode === 'calm' && animating && !opts.measure) {
      // Sleep until the next visual step instead of polling the same scene at 12 Hz. Plane
      // crossfades retain the six-fps cadence even when there are no residents.
      const interval = 1000 / (busy ? 6 : model.calmFps(t));
      const nextChangeAt = (Math.floor((now + 0.5) / interval) + 1) * interval;
      return { animating: false, drawn, cameraMoving: false, nextChangeAt };
    }
    return { animating, drawn, cameraMoving: dl.cameraMoving, nextChangeAt: null };
  }

  const gov = new Governor({ surface: opts.surface, clock, scheduler, onTick, calmFps: opts.measure?.calmFps, ambientStillFps: opts.measure?.calmFps });
  gov.setReduced(!!opts.reducedMotion);
  gov.start();

  const nowS = () => clock.now() / 1000;
  const BURST = 3000;

  return {
    surface: opts.surface,
    variant,
    waiting() {
      return model.waiting();
    },
    setSnapshot(s: Snapshot) {
      model.setSnapshot(s, nowS());
      gov.poke();
    },
    pushMoment(m: Moment) {
      model.pushMoment(m, nowS());
      if (m.kind === 'needs_you' || m.kind === 'turn_end' || m.kind === 'build_complete' || m.kind === 'limit_reset' || m.kind === 'milestone') gov.requestBurst(BURST);
      gov.poke();
    },
    updateSettings(s: LiveSettings) {
      model.setSettings(s);
      gov.poke();
    },
    refreshHitRects() {
      gov.poke();
    },
    setWorld(w: World) {
      model.setWorld(w, nowS());
      gov.poke();
    },
    setReducedMotion(on: boolean) {
      model.setReduced(on);
      gov.setReduced(on);
      gov.poke();
    },
    setVisible(v: boolean) {
      view?.setVisible(v);
      gov.setHidden(!v);
    },
    setFade(on: boolean) {
      view?.setFade(on);
    },
    resize(width: number, height: number, dpr: number) {
      xf = makeXf(opts.surface, width, height, dpr, opts.maxDpr, opts.ambient, variant);
      view?.resize(xf);
      publisher?.reset();
      lastSig = '';
      gov.poke();
    },
    advance(ms: number) {
      if (vt) vt.advance(ms);
    },
    stats(): FrameStats {
      const s = gov.stats();
      return { ticks: s.ticks, drawn: s.drawn, lastDrawAt, mode: gov.mode() };
    },
    debugLog() {
      return log;
    },
    errors() {
      return errors;
    },
    debugMemory() {
      return view?.memory() ?? {};
    },
    lastHitRects(): HitRects | null {
      return publisher?.last() ?? null;
    },
    destroy() {
      destroyed = true;
      gov.stop();
      view?.destroy();
    },
  };
}
