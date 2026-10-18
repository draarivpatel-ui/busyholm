/**
 * Usage limits to environment (SPEC 4.4). Pure functions.
 *
 * skyPhase(limits, nowEpochMs, localHours, mode):
 * - mode 'clock_only' -> phaseFromClock(localHours), source 'clock'.
 * - Limits of different accounts are never merged; the sky uses the highest value among fresh
 *   samples. A 5h sample is fresh when !stale and now - observed_at <= 30 min.
 *   A sample whose resets_at has passed describes a closed window: its used_pct counts as 0.
 * - Any fresh 5h sample: phase = phaseFromUsage(max used_pct), source 'usage'.
 * - Else, any 5h sample observed within the last 5 h: keep the newest one's value (0 if its
 *   resets_at passed) and drift toward the clock: weight w = clamp((age - 30 min) / 4.5 h, 0, 1),
 *   phase = lerpPhase(usagePhase, clockPhase, w), source 'blend'.
 * - Else phaseFromClock(localHours), source 'clock'.
 *
 * weatherFor(limits, nowEpochMs): the highest weekly used_pct among weekly samples observed in
 * the last 5 h (stale ones included, closed windows count as 0): under 50 'clear', 50 to under 75
 * 'scattered', 75 to under 90 'overcast', 90 and over 'drizzle'; no sample -> 'clear'.
 *
 * seasonFor(date, hemisphere): v0.1 ships autumn and winter only. North: Dec, Jan, Feb -> winter,
 * every other month -> autumn. South: Jun, Jul, Aug -> winter, every other month -> autumn.
 *
 * lerpPhase(a, b, t): interpolate two phases in [0, 1) along the shorter way round the circle,
 * result wrapped into [0, 1).
 */
import type { SnapshotLimit } from '../../../contracts/ts/src/types.ts';
import type { Weather } from '../../art/src/sky.ts';
import type { Season } from '../../art/src/terrain.ts';
import { phaseFromClock, phaseFromUsage, wrap01 } from '../../art/src/sky.ts';

export interface SkyChoice {
  phase: number;
  source: 'usage' | 'clock' | 'blend';
  /** the used_pct that drove the phase, if any */
  usedPct: number | null;
  /** age in ms of the sample used, if any */
  ageMs: number | null;
}

const FRESH_MS = 30 * 60 * 1000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const BLEND_SPAN_MS = 4.5 * 60 * 60 * 1000;

/** A closed window (resets_at has passed) counts as 0%. */
function effectivePct(limit: SnapshotLimit, nowEpochMs: number): number {
  return nowEpochMs >= limit.resets_at ? 0 : limit.used_pct;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function skyPhase(limits: SnapshotLimit[], nowEpochMs: number, localHours: number, mode: 'usage_and_clock' | 'clock_only'): SkyChoice {
  const clockPhase = phaseFromClock(localHours);
  if (mode === 'clock_only') {
    return { phase: clockPhase, source: 'clock', usedPct: null, ageMs: null };
  }

  const fiveHour = limits.filter((l) => l.window === '5h');

  // Fresh samples: the highest effective value wins, and its age is reported.
  let best: SnapshotLimit | null = null;
  let bestPct = -Infinity;
  for (const l of fiveHour) {
    if (l.stale || nowEpochMs - l.observed_at > FRESH_MS) continue;
    const pct = effectivePct(l, nowEpochMs);
    if (pct > bestPct) {
      bestPct = pct;
      best = l;
    }
  }
  if (best !== null) {
    return {
      phase: phaseFromUsage(bestPct),
      source: 'usage',
      usedPct: bestPct,
      ageMs: nowEpochMs - best.observed_at,
    };
  }

  // No fresh sample: blend from the newest 5h sample observed within the last 5 hours.
  let newest: SnapshotLimit | null = null;
  for (const l of fiveHour) {
    if (nowEpochMs - l.observed_at > FIVE_HOURS_MS) continue;
    if (newest === null || l.observed_at > newest.observed_at) newest = l;
  }
  if (newest !== null) {
    const pct = effectivePct(newest, nowEpochMs);
    const ageMs = nowEpochMs - newest.observed_at;
    const w = clamp01((ageMs - FRESH_MS) / BLEND_SPAN_MS);
    return {
      phase: lerpPhase(phaseFromUsage(pct), clockPhase, w),
      source: 'blend',
      usedPct: pct,
      ageMs,
    };
  }

  return { phase: clockPhase, source: 'clock', usedPct: null, ageMs: null };
}

export function weatherFor(limits: SnapshotLimit[], nowEpochMs: number): Weather {
  let max: number | null = null;
  for (const l of limits) {
    if (l.window !== 'weekly') continue;
    if (nowEpochMs - l.observed_at > FIVE_HOURS_MS) continue;
    const pct = effectivePct(l, nowEpochMs);
    if (max === null || pct > max) max = pct;
  }
  if (max === null) return 'clear';
  if (max < 50) return 'clear';
  if (max < 75) return 'scattered';
  if (max < 90) return 'overcast';
  return 'drizzle';
}

export function seasonFor(date: Date, hemisphere: 'north' | 'south'): Season {
  const m = date.getMonth(); // 0 = January
  if (hemisphere === 'north') {
    return m === 11 || m === 0 || m === 1 ? 'winter' : 'autumn';
  }
  return m === 5 || m === 6 || m === 7 ? 'winter' : 'autumn';
}

export function lerpPhase(a: number, b: number, t: number): number {
  // Signed shortest difference, wrapped into [-0.5, 0.5).
  const d = (((b - a + 0.5) % 1) + 1) % 1 - 0.5;
  return wrap01(a + d * t);
}
