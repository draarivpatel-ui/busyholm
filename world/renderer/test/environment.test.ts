/**
 * Unit tests for the usage-to-environment functions (SPEC 4.4): skyPhase, weatherFor, seasonFor, lerpPhase.
 * Pure functions, so every test passes explicit times and samples.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skyPhase, weatherFor, seasonFor, lerpPhase } from '../src/environment.ts';
import { phaseFromClock, phaseFromUsage } from '../../art/src/sky.ts';
import type { SnapshotLimit } from '../../../contracts/ts/src/types.ts';

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** A 5h sample by default: fresh, 1 minute old, window open for 3 more hours. */
function limit(over: Partial<SnapshotLimit> = {}): SnapshotLimit {
  return {
    provider: 'claude',
    window: '5h',
    account_id: 'acct-a',
    root_id: 'root-a',
    used_pct: 0,
    resets_at: NOW + 3 * HOUR,
    observed_at: NOW - MIN,
    stale: false,
    ...over,
  };
}

/** Distance between two phases on the circle [0, 1). */
function circDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d);
}

describe('skyPhase', () => {
  test('clock_only ignores limits entirely', () => {
    const limits = [limit({ used_pct: 50 })];
    const c = skyPhase(limits, NOW, 9, 'clock_only');
    assert.equal(c.phase, phaseFromClock(9));
    assert.equal(c.phase, 0.25);
    assert.equal(c.source, 'clock');
    assert.equal(c.usedPct, null);
    assert.equal(c.ageMs, null);
  });

  test('a fresh sample drives the phase: 50% gives phaseFromUsage(50) = noon', () => {
    const c = skyPhase([limit({ used_pct: 50, observed_at: NOW - 5 * MIN })], NOW, 22, 'usage_and_clock');
    assert.equal(c.phase, phaseFromUsage(50));
    assert.equal(c.phase, 0.5);
    assert.equal(c.source, 'usage');
    assert.equal(c.usedPct, 50);
    assert.equal(c.ageMs, 5 * MIN);
  });

  test('exactly 30 minutes old is still fresh', () => {
    const c = skyPhase([limit({ used_pct: 50, observed_at: NOW - 30 * MIN })], NOW, 9, 'usage_and_clock');
    assert.equal(c.source, 'usage');
    assert.equal(c.phase, 0.5);
    assert.equal(c.ageMs, 30 * MIN);
  });

  test('two accounts: the highest fresh value wins, and its own age is reported', () => {
    const limits = [
      limit({ account_id: 'acct-a', used_pct: 30, observed_at: NOW - MIN }),
      limit({ account_id: 'acct-b', used_pct: 70, observed_at: NOW - 5 * MIN }),
    ];
    const c = skyPhase(limits, NOW, 9, 'usage_and_clock');
    assert.equal(c.source, 'usage');
    assert.equal(c.usedPct, 70);
    assert.equal(c.phase, phaseFromUsage(70));
    assert.equal(c.ageMs, 5 * MIN);
  });

  test('a stale sample is never fresh, even with a recent observed_at', () => {
    const limits = [
      limit({ account_id: 'acct-a', used_pct: 95, stale: true, observed_at: NOW - MIN }),
      limit({ account_id: 'acct-b', used_pct: 40, observed_at: NOW - MIN }),
    ];
    const c = skyPhase(limits, NOW, 9, 'usage_and_clock');
    assert.equal(c.source, 'usage');
    assert.equal(c.usedPct, 40);
  });

  test('a stale sample that is only 10 minutes old blends (weight 0, so the usage phase)', () => {
    const c = skyPhase([limit({ used_pct: 60, stale: true, observed_at: NOW - 10 * MIN })], NOW, 9, 'usage_and_clock');
    assert.equal(c.source, 'blend');
    assert.equal(c.usedPct, 60);
    assert.equal(c.ageMs, 10 * MIN);
    assert.ok(circDist(c.phase, phaseFromUsage(60)) < 1e-9);
  });

  test('a 31-minute-old sample is not fresh and blends with weight 1/270', () => {
    const c = skyPhase([limit({ used_pct: 50, observed_at: NOW - 31 * MIN })], NOW, 9, 'usage_and_clock');
    assert.equal(c.source, 'blend');
    assert.equal(c.usedPct, 50);
    assert.equal(c.ageMs, 31 * MIN);
    // w = (31 min - 30 min) / 4.5 h = 1/270; usage phase 0.5, clock phase 0.25 (09:00)
    const expected = 0.5 + (0.25 - 0.5) * (1 / 270);
    assert.ok(circDist(c.phase, expected) < 1e-9, `phase ${c.phase} vs ${expected}`);
  });

  test('a 2-hour-old sample blends with weight 1/3', () => {
    const c = skyPhase([limit({ used_pct: 50, observed_at: NOW - 2 * HOUR })], NOW, 9, 'usage_and_clock');
    assert.equal(c.source, 'blend');
    assert.equal(c.usedPct, 50);
    assert.equal(c.ageMs, 2 * HOUR);
    // w = (2 h - 0.5 h) / 4.5 h = 1/3
    const expected = 0.5 + (0.25 - 0.5) / 3;
    assert.ok(circDist(c.phase, expected) < 1e-9, `phase ${c.phase} vs ${expected}`);
  });

  test('blend uses the newest 5h sample, not the highest one', () => {
    const limits = [
      limit({ account_id: 'acct-a', used_pct: 90, observed_at: NOW - 2 * HOUR }),
      limit({ account_id: 'acct-b', used_pct: 10, observed_at: NOW - 1 * HOUR }),
    ];
    const c = skyPhase(limits, NOW, 9, 'usage_and_clock');
    assert.equal(c.source, 'blend');
    assert.equal(c.usedPct, 10);
    assert.equal(c.ageMs, 1 * HOUR);
  });

  test('a 6-hour-old sample is out of range and falls back to the clock', () => {
    const c = skyPhase([limit({ used_pct: 80, observed_at: NOW - 6 * HOUR })], NOW, 9, 'usage_and_clock');
    assert.equal(c.phase, phaseFromClock(9));
    assert.equal(c.source, 'clock');
    assert.equal(c.usedPct, null);
    assert.equal(c.ageMs, null);
  });

  test('no limits at all falls back to the clock', () => {
    const c = skyPhase([], NOW, 13, 'usage_and_clock');
    assert.equal(c.phase, 0.5);
    assert.equal(c.source, 'clock');
  });

  test('weekly samples do not drive the sky', () => {
    const c = skyPhase([limit({ window: 'weekly', used_pct: 95 })], NOW, 9, 'usage_and_clock');
    assert.equal(c.source, 'clock');
    assert.equal(c.phase, 0.25);
  });

  test('resets_at passed counts as 0%: a fresh 80% sample in a closed window is dawn', () => {
    const c = skyPhase([limit({ used_pct: 80, resets_at: NOW - MIN })], NOW, 22, 'usage_and_clock');
    assert.equal(c.source, 'usage');
    assert.equal(c.usedPct, 0);
    assert.equal(c.phase, 0);
  });

  test('resets_at exactly now counts as closed (0%)', () => {
    const c = skyPhase([limit({ used_pct: 80, resets_at: NOW })], NOW, 22, 'usage_and_clock');
    assert.equal(c.usedPct, 0);
    assert.equal(c.phase, 0);
  });

  test('a closed window also reads as 0% in the blend branch', () => {
    const c = skyPhase([limit({ used_pct: 80, resets_at: NOW - MIN, observed_at: NOW - 2 * HOUR })], NOW, 9, 'usage_and_clock');
    assert.equal(c.source, 'blend');
    assert.equal(c.usedPct, 0);
    // usage phase 0 blended toward 09:00 (0.25) with weight 1/3
    assert.ok(circDist(c.phase, 0 + (0.25 - 0) / 3) < 1e-9);
  });

  test('a closed window in one account does not hide an open fresh sample from another', () => {
    const limits = [
      limit({ account_id: 'acct-a', used_pct: 95, resets_at: NOW - MIN }),
      limit({ account_id: 'acct-b', used_pct: 25 }),
    ];
    const c = skyPhase(limits, NOW, 9, 'usage_and_clock');
    assert.equal(c.usedPct, 25);
    assert.equal(c.phase, phaseFromUsage(25));
  });
});

describe('weatherFor', () => {
  function weekly(used_pct: number, over: Partial<SnapshotLimit> = {}): SnapshotLimit {
    return limit({ window: 'weekly', used_pct, observed_at: NOW - MIN, ...over });
  }

  test('no samples gives clear', () => {
    assert.equal(weatherFor([], NOW), 'clear');
  });

  test('5h samples are ignored', () => {
    assert.equal(weatherFor([limit({ used_pct: 99 })], NOW), 'clear');
  });

  test('weekly thresholds at 49.9, 50, 74.9, 75, 89.9, 90', () => {
    assert.equal(weatherFor([weekly(49.9)], NOW), 'clear');
    assert.equal(weatherFor([weekly(50)], NOW), 'scattered');
    assert.equal(weatherFor([weekly(74.9)], NOW), 'scattered');
    assert.equal(weatherFor([weekly(75)], NOW), 'overcast');
    assert.equal(weatherFor([weekly(89.9)], NOW), 'overcast');
    assert.equal(weatherFor([weekly(90)], NOW), 'drizzle');
  });

  test('0% and 100% map to clear and drizzle', () => {
    assert.equal(weatherFor([weekly(0)], NOW), 'clear');
    assert.equal(weatherFor([weekly(100)], NOW), 'drizzle');
  });

  test('the highest weekly value across accounts decides', () => {
    const limits = [weekly(40, { account_id: 'acct-a' }), weekly(80, { account_id: 'acct-b' })];
    assert.equal(weatherFor(limits, NOW), 'overcast');
  });

  test('a stale weekly sample still counts, within the last 5 hours', () => {
    assert.equal(weatherFor([weekly(95, { stale: true, observed_at: NOW - 4 * HOUR })], NOW), 'drizzle');
  });

  test('a weekly sample older than 5 hours is ignored', () => {
    assert.equal(weatherFor([weekly(95, { observed_at: NOW - 6 * HOUR })], NOW), 'clear');
  });

  test('a closed weekly window counts as 0%', () => {
    assert.equal(weatherFor([weekly(95, { resets_at: NOW - MIN })], NOW), 'clear');
  });
});

describe('seasonFor', () => {
  // Mid-month local dates so the local getMonth() is unambiguous.
  const month = (m: number) => new Date(2026, m, 15, 12, 0, 0);

  test('north: Dec, Jan, Feb are winter; every other month is autumn', () => {
    const expected: Array<'winter' | 'autumn'> = [
      'winter', 'winter', 'autumn', 'autumn', 'autumn', 'autumn',
      'autumn', 'autumn', 'autumn', 'autumn', 'autumn', 'winter',
    ];
    for (let m = 0; m < 12; m++) {
      assert.equal(seasonFor(month(m), 'north'), expected[m], `north month index ${m}`);
    }
  });

  test('south: Jun, Jul, Aug are winter; every other month is autumn', () => {
    const expected: Array<'winter' | 'autumn'> = [
      'autumn', 'autumn', 'autumn', 'autumn', 'autumn', 'winter',
      'winter', 'winter', 'autumn', 'autumn', 'autumn', 'autumn',
    ];
    for (let m = 0; m < 12; m++) {
      assert.equal(seasonFor(month(m), 'south'), expected[m], `south month index ${m}`);
    }
  });

  test('the hemispheres are opposite in June and December', () => {
    assert.equal(seasonFor(month(5), 'north'), 'autumn');
    assert.equal(seasonFor(month(5), 'south'), 'winter');
    assert.equal(seasonFor(month(11), 'north'), 'winter');
    assert.equal(seasonFor(month(11), 'south'), 'autumn');
  });
});

describe('lerpPhase', () => {
  test('endpoints: t = 0 gives a, t = 1 gives b', () => {
    assert.ok(circDist(lerpPhase(0.2, 0.4, 0), 0.2) < 1e-9);
    assert.ok(circDist(lerpPhase(0.2, 0.4, 1), 0.4) < 1e-9);
  });

  test('midpoint without a wrap is the plain average', () => {
    assert.ok(circDist(lerpPhase(0.1, 0.3, 0.5), 0.2) < 1e-9);
  });

  test('0.95 to 0.05 at t 0.5 crosses the wrap and gives 0.0', () => {
    assert.ok(Math.abs(lerpPhase(0.95, 0.05, 0.5)) < 1e-9);
  });

  test('the reverse direction across the wrap also gives 0.0', () => {
    assert.ok(circDist(lerpPhase(0.05, 0.95, 0.5), 0) < 1e-9);
  });

  test('takes the shorter way round: 0.1 to 0.9 at t 0.5 is 0.0, not 0.5', () => {
    assert.ok(circDist(lerpPhase(0.1, 0.9, 0.5), 0) < 1e-9);
  });

  test('a half-turn apart is well defined and stays in [0, 1)', () => {
    const r = lerpPhase(0.2, 0.7, 0.5);
    assert.ok(r >= 0 && r < 1, `result ${r} out of range`);
  });

  test('results are always wrapped into [0, 1)', () => {
    for (const [a, b] of [[0.99, 0.01], [0.01, 0.99], [0.5, 0.5], [0.0, 0.9]]) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const r = lerpPhase(a, b, t);
        assert.ok(r >= 0 && r < 1, `lerpPhase(${a}, ${b}, ${t}) = ${r}`);
      }
    }
  });
});
