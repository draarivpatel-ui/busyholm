/**
 * Acceptance test: alert-flag double-outline contrast.
 * SPEC: "flag double-outline contrast >= 3:1 at every 1% step of sky and weather".
 *
 *   node tools/lint-contrast.ts     exit 0 = pass, exit 1 = fail
 *
 * Contains no colour literals: every colour is a token name resolved through src/.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { contrast, multiply, over, tok, type RGB } from '../src/color.ts';
import { FLAG_STYLE, MIN_OUTLINE_CONTRAST, type FlagStyle } from '../src/alert.ts';
import { WEATHERS, sampleSky, skyAt, type Weather } from '../src/sky.ts';
import type { Token } from '../src/tokens.ts';

/** Every 1% step 0..100, plus 0.995 for the pre-dawn wrap. */
const PHASES: number[] = [...Array.from({ length: 101 }, (_, i) => i / 100), 0.995];
/** Sky gradient samples: t = 0, 0.05, ..., 1.0. */
const T_STEPS: number[] = Array.from({ length: 21 }, (_, i) => i / 20);
/** Land and building tokens checked after a time-of-day multiply tint. */
const LAND_AND_BUILDING: readonly Token[] = [
  'farHills',
  'midHills',
  'meadow',
  'bank',
  'river',
  'wall',
  'roof',
  'wood',
  'stone',
  'roofSlate',
  'conifer',
];

interface Reading {
  kind: 'sky' | 'tint';
  weather: Weather;
  phase: number;
  /** gradient position; null for tint checks */
  t: number | null;
  /** 'gradient', 'rain', 'snow', 'fog', 'cloud', or 'tint:<token>' */
  label: string;
  /** outline token that scored best, or 'fill only' when the style has no outlines */
  winner: string;
  ratio: number;
  bg: RGB;
}

export interface LintResult {
  ok: boolean;
  /** contrast checks: every background plus the flag-vs-inner-outline assert */
  checks: number;
  backgrounds: number;
  worst: number;
  failTotal: number;
}

/** Best (highest) contrast of any outline against a background; fill alone if there are no outlines. */
function bestOutline(style: FlagStyle, bg: RGB): { ratio: number; winner: string } {
  if (style.outlines.length === 0) return { ratio: contrast(tok(style.fill), bg), winner: 'fill only' };
  let best = { ratio: -Infinity, winner: '' };
  for (const o of style.outlines) {
    const ratio = contrast(tok(o), bg);
    if (ratio > best.ratio) best = { ratio, winner: o };
  }
  return best;
}

const triplet = (c: RGB) => `${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)}`;
const ratioStr = (r: number) => `${r.toFixed(2)}:1`;

function fmtReading(r: Reading): string {
  const where = r.t === null ? `phase=${r.phase.toFixed(3)}` : `phase=${r.phase.toFixed(3)} t=${r.t.toFixed(2)}`;
  return `  ${r.weather} ${where} ${r.label} outline=${r.winner} ${ratioStr(r.ratio)} bg=${triplet(r.bg)}`;
}

function minOf(rs: Reading[]): Reading {
  return rs.reduce((a, b) => (b.ratio < a.ratio ? b : a));
}

export function runContrastLint(style: FlagStyle = FLAG_STYLE): LintResult {
  const readings: Reading[] = [];

  for (const weather of WEATHERS) {
    for (const phase of PHASES) {
      const s = sampleSky(phase, weather);

      for (const t of T_STEPS) {
        const base = skyAt(s, t);
        // each overlay is its own background the flag can sit on, composited over the gradient sample
        const bgs: [string, RGB][] = [['gradient', base]];
        if (s.spec.particles === 'rain' || s.spec.particles === 'rain-light') {
          bgs.push(['rain', over(base, tok('ink'), 0.35)]);
        }
        if (s.spec.particles === 'snow') bgs.push(['snow', over(base, tok('snow'), 0.85)]);
        if (s.spec.fogBand > 0) bgs.push(['fog', over(base, tok('cream'), 0.55 * s.spec.fogBand)]);
        if (s.spec.cloudCover > 0.3) bgs.push(['cloud', over(base, tok('cream'), 0.9)]);

        for (const [label, bg] of bgs) {
          const best = bestOutline(style, bg);
          readings.push({ kind: 'sky', weather, phase, t, label, winner: best.winner, ratio: best.ratio, bg });
        }
      }

      for (const T of LAND_AND_BUILDING) {
        const bg = multiply(tok(T), s.light);
        const best = bestOutline(style, bg);
        readings.push({
          kind: 'tint',
          weather,
          phase,
          t: null,
          label: `tint:${T}`,
          winner: best.winner,
          ratio: best.ratio,
          bg,
        });
      }
    }
  }

  // once: the flag colour against its own inner outline
  const inner = style.outlines[0];
  const selfRatio = inner === undefined ? null : contrast(tok(style.fill), tok(inner));
  const selfOk = selfRatio !== null && selfRatio >= MIN_OUTLINE_CONTRAST;
  const selfLine =
    inner === undefined
      ? `  self: no outlines defined (fill ${style.fill} alone) FAIL`
      : `  self: fill ${style.fill} vs inner outline ${inner} ${ratioStr(selfRatio ?? 0)} ${selfOk ? 'pass' : 'FAIL'}`;

  const failing = readings.filter((r) => r.ratio < MIN_OUTLINE_CONTRAST);
  const failTotal = failing.length + (selfOk ? 0 : 1);
  const failLines = [...(selfOk ? [] : [selfLine]), ...failing.map(fmtReading)].slice(0, 10);

  const worst = minOf(readings);
  const backgrounds = readings.length;
  const skyCount = readings.filter((r) => r.kind === 'sky').length;
  const tintCount = backgrounds - skyCount;

  console.log(`lint:contrast  min best-outline ratio per weather (need ${ratioStr(MIN_OUTLINE_CONTRAST)})`);
  console.log('weather    sky-min   phase  t     outline      bg r,g,b          tint-min (token @ phase)');
  for (const weather of WEATHERS) {
    const sky = minOf(readings.filter((r) => r.weather === weather && r.kind === 'sky'));
    const tint = minOf(readings.filter((r) => r.weather === weather && r.kind === 'tint'));
    console.log(
      [
        weather.padEnd(10),
        ratioStr(sky.ratio).padEnd(9),
        sky.phase.toFixed(3).padEnd(6),
        (sky.t ?? 0).toFixed(2).padEnd(5),
        sky.winner.padEnd(12),
        triplet(sky.bg).padEnd(17),
        `${tint.label.replace('tint:', '')} @${tint.phase.toFixed(3)} ${ratioStr(tint.ratio)}`,
      ].join(' '),
    );
  }
  console.log(selfLine);
  console.log(
    `overall worst: ${ratioStr(worst.ratio)} at ${worst.weather} phase=${worst.phase.toFixed(3)} ` +
      `t=${worst.t === null ? '-' : worst.t.toFixed(2)} ${worst.label} outline=${worst.winner} bg=${triplet(worst.bg)}`,
  );
  console.log(`backgrounds checked: ${backgrounds} (sky + overlays ${skyCount}, land/building tint ${tintCount})`);

  const checks = backgrounds + 1;
  if (failTotal === 0) {
    console.log(`lint:contrast OK (${checks} checks, worst ${ratioStr(worst.ratio)})`);
  } else {
    console.log(`lint:contrast FAIL (${failTotal} failing checks; first ${failLines.length} shown)`);
    for (const line of failLines) console.log(line);
  }

  return { ok: failTotal === 0, checks, backgrounds, worst: worst.ratio, failTotal };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = runContrastLint(FLAG_STYLE).ok ? 0 : 1;
}
