/**
 * Clocks and schedulers. The real pair wraps performance.now() and setTimeout; the virtual pair
 * runs in fake time so tests and captures step the renderer deterministically.
 */
import type { Clock, Scheduler } from './api.ts';

export const realClock: Clock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
};

export const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, Math.max(0, ms)),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/**
 * Virtual time: a clock plus a scheduler whose timers fire only inside advance().
 * Timers due at the same instant fire in the order they were set.
 */
export class VirtualTime implements Clock, Scheduler {
  private t: number;
  private timers: Timer[] = [];
  private nextId = 1;
  /** every delay passed to set(), for tests */
  readonly delays: number[] = [];

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  set(fn: () => void, ms: number): unknown {
    const d = Math.max(0, ms);
    this.delays.push(d);
    const timer = { id: this.nextId++, at: this.t + d, fn };
    this.timers.push(timer);
    return timer.id;
  }

  clear(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }

  /** number of timers waiting */
  pending(): number {
    return this.timers.length;
  }

  /** Advance by ms, firing every timer that falls due (including ones set while advancing). */
  advance(ms: number): void {
    const end = this.t + Math.max(0, ms);
    for (;;) {
      let next: Timer | null = null;
      for (const x of this.timers) if (x.at <= end && (!next || x.at < next.at || (x.at === next.at && x.id < next.id))) next = x;
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = end;
  }
}
