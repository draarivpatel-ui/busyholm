/**
 * Frame governor (SPEC 6.6), timer-driven (the spike measured a setTimeout loop 0.5 to 1 point
 * cheaper than rAF frame-skipping in WebKit).
 *
 * Contract:
 * - The governor never draws. Each tick it calls onTick(now, mode); the renderer advances its
 *   model, draws only if the display list changed, and reports back with a TickResult.
 * - Scheduling after a tick:
 *   - hidden: no timer at all (0 fps). poke() and requestBurst() while hidden do not tick.
 *   - reduced motion: no periodic timer; only poke() ticks (render on state change only).
 *   - burst active (strip or ambient): next tick at the next 1/burstFps boundary of the clock.
 *   - strip, otherwise: animating -> next 1/calmFps boundary; not animating with nextChangeAt ->
 *     a timer at nextChangeAt; not animating and no nextChangeAt -> no timer (wait for poke).
 *   - ambient, otherwise: cameraMoving -> 1/ambientFps boundary; animating -> 1/ambientStillFps
 *     boundary; else as the strip.
 *   "Boundary" means the next multiple of the frame interval strictly after now (plus 0.5 ms), so
 *   ticks land on the same grid the renderer quantises poses to.
 * - Bursts: requestBurst(ms) starts or extends a burst to min(now + ms, burstStart + burstMaxMs).
 *   A burst that ran its full burstMaxMs starts a cooldown of cooldownMs during which
 *   requestBurst is ignored, so continuous activity gives peaks of at most 3 s.
 * - poke(): run a tick as soon as possible (a 0 ms timer replacing any pending one). Several
 *   pokes before the tick runs coalesce into one tick.
 */
import type { Clock, GovMode, Scheduler, Surface } from './api.ts';

export interface TickResult {
  /** something on screen steps on its own and will change again (puppet loops, smoke, clouds) */
  animating: boolean;
  /** this tick drew a frame (the display list changed) */
  drawn: boolean;
  /** ambient only: the camera is moving */
  cameraMoving?: boolean;
  /** when not animating: clock time at which the scene next changes on its own, else null */
  nextChangeAt?: number | null;
}

export interface GovernorOptions {
  surface: Surface;
  clock: Clock;
  scheduler: Scheduler;
  onTick: (now: number, mode: GovMode) => TickResult;
  /** default 12 */
  calmFps?: number;
  /** default 30 */
  burstFps?: number;
  /** default 3000 */
  burstMaxMs?: number;
  /** default 2500 */
  cooldownMs?: number;
  /** default 30 */
  ambientFps?: number;
  /** default 12 */
  ambientStillFps?: number;
}

export interface GovernorStats {
  ticks: number;
  drawn: number;
  burstStartedAt: number | null;
  burstUntil: number | null;
}

export class Governor {
  private readonly surface: Surface;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly onTick: (now: number, mode: GovMode) => TickResult;
  private readonly calmFps: number;
  private readonly burstFps: number;
  private readonly burstMaxMs: number;
  private readonly cooldownMs: number;
  private readonly ambientFps: number;
  private readonly ambientStillFps: number;

  private running = false;
  private hidden = false;
  private reduced = false;
  private cameraMoving = false;

  /** the one pending timer: its handle and the clock time it fires at (null when none) */
  private handle: unknown = null;
  private timerAt: number | null = null;
  /** the pending timer is a 0 ms poke timer */
  private poked = false;

  private nTicks = 0;
  private nDrawn = 0;
  private burstStart: number | null = null;
  private burstEnd: number | null = null;

  constructor(opts: GovernorOptions) {
    this.surface = opts.surface;
    this.clock = opts.clock;
    this.scheduler = opts.scheduler;
    this.onTick = opts.onTick;
    this.calmFps = opts.calmFps ?? 12;
    this.burstFps = opts.burstFps ?? 30;
    this.burstMaxMs = opts.burstMaxMs ?? 3000;
    this.cooldownMs = opts.cooldownMs ?? 2500;
    this.ambientFps = opts.ambientFps ?? 30;
    this.ambientStillFps = opts.ambientStillFps ?? 12;
  }

  /** Begin ticking: the first tick runs on a 0 ms timer (held back while hidden). */
  start(): void {
    this.running = true;
    if (!this.hidden) this.arm(0, true);
  }

  /** Clear the pending timer; no further ticks until start(). */
  stop(): void {
    this.running = false;
    this.disarm();
  }

  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (hidden) this.disarm();
    else if (this.running) this.arm(0, true);
  }

  setReduced(on: boolean): void {
    if (on === this.reduced) return;
    this.reduced = on;
    if (!on && this.running && !this.hidden) this.arm(0, true);
  }

  requestBurst(ms: number): void {
    if (this.hidden || this.reduced || !(ms > 0)) return;
    const now = this.clock.now();
    if (this.burstStart !== null && this.burstEnd !== null) {
      if (now < this.burstEnd) {
        this.burstEnd = Math.min(Math.max(this.burstEnd, now + ms), this.burstStart + this.burstMaxMs);
      } else if (this.burstEnd - this.burstStart >= this.burstMaxMs && now < this.burstEnd + this.cooldownMs) {
        return; // cooling down after a burst that ran its full length
      } else {
        this.burstStart = now;
        this.burstEnd = now + Math.min(ms, this.burstMaxMs);
      }
    } else {
      this.burstStart = now;
      this.burstEnd = now + Math.min(ms, this.burstMaxMs);
    }
    // a slower timer (calm cadence or a far nextChangeAt) must not hold back the burst
    if (this.timerAt !== null) {
      const delay = this.boundaryDelay(now, 1000 / this.burstFps);
      if (this.timerAt > now + delay) this.arm(delay, false);
    }
  }

  /** Tick as soon as possible; several pokes before it runs give one tick. */
  poke(): void {
    if (this.hidden || !this.running) return;
    if (this.poked) return;
    this.arm(0, true);
  }

  mode(): GovMode {
    return this.modeAt(this.clock.now());
  }

  stats(): GovernorStats {
    return { ticks: this.nTicks, drawn: this.nDrawn, burstStartedAt: this.burstStart, burstUntil: this.burstEnd };
  }

  private burstActive(now: number): boolean {
    return this.burstEnd !== null && now < this.burstEnd;
  }

  private modeAt(now: number): GovMode {
    if (this.hidden) return 'hidden';
    if (this.reduced) return 'reduced';
    if (this.burstActive(now)) return 'burst';
    if (this.surface === 'ambient') return this.cameraMoving ? 'ambient-moving' : 'ambient-still';
    return 'calm';
  }

  /** Delay to the smallest multiple of interval strictly greater than now + 0.5. */
  private boundaryDelay(now: number, interval: number): number {
    const k = Math.floor((now + 0.5) / interval) + 1;
    return Math.max(0, k * interval - now);
  }

  private arm(delay: number, poke: boolean): void {
    this.disarm();
    const d = Math.max(0, delay);
    this.timerAt = this.clock.now() + d;
    this.poked = poke;
    this.handle = this.scheduler.set(() => this.fire(), d);
  }

  private disarm(): void {
    if (this.timerAt !== null) this.scheduler.clear(this.handle);
    this.handle = null;
    this.timerAt = null;
    this.poked = false;
  }

  private fire(): void {
    this.handle = null;
    this.timerAt = null;
    this.poked = false;
    if (!this.running || this.hidden) return;
    const now = this.clock.now();
    const res = this.onTick(now, this.modeAt(now));
    this.nTicks++;
    if (res.drawn) this.nDrawn++;
    this.cameraMoving = this.surface === 'ambient' && res.cameraMoving === true;
    // onTick may have stopped, hidden, or poked us; a timer it armed stands
    if (!this.running || this.hidden || this.timerAt !== null) return;
    this.scheduleNext(this.clock.now(), res);
  }

  private scheduleNext(now: number, res: TickResult): void {
    if (this.reduced) return; // render on state change only: poke() ticks
    if (this.burstActive(now)) {
      this.arm(this.boundaryDelay(now, 1000 / this.burstFps), false);
      return;
    }
    if (this.surface === 'ambient') {
      if (res.cameraMoving === true) {
        this.arm(this.boundaryDelay(now, 1000 / this.ambientFps), false);
        return;
      }
      if (res.animating) {
        this.arm(this.boundaryDelay(now, 1000 / this.ambientStillFps), false);
        return;
      }
    } else if (res.animating) {
      this.arm(this.boundaryDelay(now, 1000 / this.calmFps), false);
      return;
    }
    const at = res.nextChangeAt;
    if (typeof at === 'number') this.arm(Math.max(0, at - now), false);
  }
}
