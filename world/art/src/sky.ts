/**
 * Sky lookup table across a full day and every weather state (SPEC 3.3, 3.5, 4.4).
 *
 * Phase p in [0, 1):
 *   0.00 dawn, 0.25 morning, 0.50 noon, 0.70 golden hour, 0.85 dusk, 0.95 night.
 *   0.95..0.97 stays night; 0.97..1.00 is pre-dawn, wrapping smoothly back to dawn at 1 == 0.
 * Usage mode: phaseFromUsage(pct) (0% dawn ... 95%+ night, never enters the pre-dawn wrap).
 * Clock mode: phaseFromClock(hours) (cyclic, so an idle night is a real night).
 *
 * Every colour comes from tokens.ts; keyframe interpolation happens in OKLab.
 */
import { tok, mix, toOklab, fromOklab, type RGB } from './color.ts';
import type { Token } from './tokens.ts';

export type Weather =
  | 'clear'
  | 'scattered'
  | 'overcast'
  | 'drizzle'
  | 'rain'
  | 'snow'
  | 'mist'
  | 'wind'
  | 'rainbow';

export const WEATHERS: readonly Weather[] = [
  'clear',
  'scattered',
  'overcast',
  'drizzle',
  'rain',
  'snow',
  'mist',
  'wind',
  'rainbow',
];

export interface WeatherSpec {
  /** paper cloud coverage 0..1 */
  cloudCover: number;
  /** how far the sky moves toward the rain keyframe */
  skyMix: number;
  /** how far the light moves toward the rain light */
  lightMix: number;
  /** multiplier on sun shadow alpha */
  shadow: number;
  /** extra atmospheric haze toward the horizon colour */
  haze: number;
  particles: 'none' | 'rain-light' | 'rain' | 'snow' | 'leaves';
  /** low mist band over the river */
  fogBand: number;
  /** tree and smoke sway 0..1 */
  wind: number;
  rainbow: number;
}

export const WEATHER: Record<Weather, WeatherSpec> = {
  clear: { cloudCover: 0.08, skyMix: 0, lightMix: 0, shadow: 1, haze: 0, particles: 'none', fogBand: 0, wind: 0.15, rainbow: 0 },
  scattered: { cloudCover: 0.4, skyMix: 0.06, lightMix: 0.05, shadow: 0.9, haze: 0.02, particles: 'none', fogBand: 0, wind: 0.25, rainbow: 0 },
  overcast: { cloudCover: 0.9, skyMix: 0.6, lightMix: 0.55, shadow: 0.35, haze: 0.08, particles: 'none', fogBand: 0, wind: 0.3, rainbow: 0 },
  drizzle: { cloudCover: 0.95, skyMix: 0.72, lightMix: 0.65, shadow: 0.25, haze: 0.12, particles: 'rain-light', fogBand: 0.15, wind: 0.35, rainbow: 0 },
  rain: { cloudCover: 1, skyMix: 0.9, lightMix: 0.8, shadow: 0.12, haze: 0.16, particles: 'rain', fogBand: 0.2, wind: 0.5, rainbow: 0 },
  snow: { cloudCover: 0.8, skyMix: 0.55, lightMix: 0.4, shadow: 0.3, haze: 0.14, particles: 'snow', fogBand: 0.1, wind: 0.2, rainbow: 0 },
  mist: { cloudCover: 0.2, skyMix: 0.22, lightMix: 0.15, shadow: 0.55, haze: 0.3, particles: 'none', fogBand: 1, wind: 0.05, rainbow: 0 },
  wind: { cloudCover: 0.45, skyMix: 0.05, lightMix: 0.04, shadow: 0.85, haze: 0.02, particles: 'leaves', fogBand: 0, wind: 1, rainbow: 0 },
  rainbow: { cloudCover: 0.3, skyMix: 0.04, lightMix: 0.02, shadow: 0.85, haze: 0.04, particles: 'none', fogBand: 0, wind: 0.2, rainbow: 1 },
};

interface Key {
  p: number;
  top: RGB;
  horizon: RGB;
  light: RGB;
}

function key(p: number, top: Token, horizon: Token, light: Token): Key {
  return { p, top: tok(top), horizon: tok(horizon), light: tok(light) };
}

function mixKey(p: number, a: Key, b: Key, t: number): Key {
  return { p, top: mix(a.top, b.top, t), horizon: mix(a.horizon, b.horizon, t), light: mix(a.light, b.light, t) };
}

let KEYS: Key[] | null = null;

/** Keyframes (built lazily so tokens are parsed once). Morning is a derived blend, not a new colour. */
function keys(): Key[] {
  if (KEYS) return KEYS;
  const dawn = key(0, 'skyDawnTop', 'skyDawnHorizon', 'lightDawn');
  const day = key(0.5, 'skyDayTop', 'skyDayHorizon', 'lightDay');
  const morning = mixKey(0.25, dawn, day, 0.72);
  const golden = key(0.7, 'skyGoldenTop', 'skyGoldenHorizon', 'lightGolden');
  const dusk = key(0.85, 'skyDuskTop', 'skyDuskHorizon', 'lightDusk');
  const night = key(0.95, 'skyNightTop', 'skyNightHorizon', 'lightNight');
  const nightLate = { ...night, p: 0.97 };
  const dawnWrap = { ...dawn, p: 1 };
  KEYS = [dawn, morning, { ...day, p: 0.42 }, day, { ...day, p: 0.58 }, golden, dusk, night, nightLate, dawnWrap];
  return KEYS;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

export const wrap01 = (p: number) => ((p % 1) + 1) % 1;

/** Usage (0..100 percent of the 5-hour window) to phase. */
export function phaseFromUsage(pct: number): number {
  const u = Math.max(0, Math.min(100, pct)) / 100;
  return Math.min(0.965, u);
}

/**
 * Local clock (hours 0..24, fractional) to phase. Anchors: 06:00 dawn, 09:00 morning, 13:00 noon,
 * 17:30 golden, 19:15 dusk, 20:45 night, 05:00 pre-dawn begins.
 */
export function phaseFromClock(hours: number): number {
  const h = ((hours % 24) + 24) % 24;
  const anchors: [number, number][] = [
    [6, 0],
    [9, 0.25],
    [13, 0.5],
    [17.5, 0.7],
    [19.25, 0.85],
    [20.75, 0.95],
    [29, 0.97],
    [30, 1],
  ];
  const hh = h < 6 ? h + 24 : h;
  for (let i = 0; i < anchors.length - 1; i++) {
    const [h0, p0] = anchors[i];
    const [h1, p1] = anchors[i + 1];
    if (hh >= h0 && hh <= h1) return wrap01(p0 + ((hh - h0) / (h1 - h0)) * (p1 - p0));
  }
  return 0;
}

export interface Celestial {
  /** horizontal position as a fraction of the view width (0 left, 1 right) */
  x: number;
  /** height above the horizon in degrees (negative = below) */
  elevation: number;
  /** 0..1 visibility */
  alpha: number;
}

export interface SkySample {
  phase: number;
  weather: Weather;
  /** a deeper derived zenith for tall (ambient) skies: top pulled toward the next darker keyframe */
  zenith: RGB;
  top: RGB;
  horizon: RGB;
  /** multiply tint for lit paper */
  light: RGB;
  /** atmospheric haze colour that distant layers mix toward */
  haze: RGB;
  /** extra haze from weather, 0..1 */
  hazeBoost: number;
  sun: Celestial;
  moon: Celestial;
  /** 0..1 how lit windows and lanterns are */
  lamps: number;
  /** 0..1 star visibility */
  stars: number;
  /** 0..1 how much it is "day" (sun up and bright) */
  daylight: number;
  spec: WeatherSpec;
}

/** Raw clear-sky keyframe interpolation. */
export function clearSky(phase: number): { top: RGB; horizon: RGB; light: RGB } {
  const p = wrap01(phase);
  const k = keys();
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i];
    const b = k[i + 1];
    if (p >= a.p && p <= b.p) {
      const t = b.p === a.p ? 0 : smooth((p - a.p) / (b.p - a.p));
      return { top: mix(a.top, b.top, t), horizon: mix(a.horizon, b.horizon, t), light: mix(a.light, b.light, t) };
    }
  }
  return { top: k[0].top, horizon: k[0].horizon, light: k[0].light };
}

/**
 * Move a sky colour toward the rain keyframe without ever brightening a dark (night) sky
 * by more than a little: rain at night stays night.
 */
function toward(c: RGB, target: RGB, t: number): RGB {
  if (t <= 0) return c;
  const A = toOklab(c);
  const B = toOklab(target);
  const L = A.L + (Math.min(B.L, A.L + 0.06) - A.L) * t;
  return fromOklab({ L, a: A.a + (B.a - A.a) * t, b: A.b + (B.b - A.b) * t });
}

const bump = (p: number, a: number, b: number) => (p <= a || p >= b ? 0 : Math.sin(((p - a) / (b - a)) * Math.PI));
const ramp = (x: number, a: number, b: number) => Math.max(0, Math.min(1, (x - a) / (b - a)));

/** Piecewise curve through (phase, value) anchors, eased between anchors. */
function curve(p: number, pts: [number, number][]): number {
  if (p <= pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, v0] = pts[i];
    const [p1, v1] = pts[i + 1];
    if (p >= p0 && p <= p1) return v0 + (v1 - v0) * smooth((p - p0) / (p1 - p0));
  }
  return pts[pts.length - 1][1];
}

/**
 * Sun arc: rises at the right (east) at dawn, high at noon, low and long-shadowed at golden hour,
 * sets at the left (west) at dusk. Elevation in degrees.
 */
export function sunAt(phase: number): Celestial {
  const p = wrap01(phase);
  const pp = p >= 0.96 ? p - 1 : p; // pre-dawn runs -0.04..0
  const elevation = curve(pp, [
    [-0.04, -9],
    [0, 1],
    [0.25, 30],
    [0.5, 60],
    [0.62, 36],
    [0.7, 13],
    [0.78, 5],
    [0.85, -1.5],
    [0.92, -14],
  ]);
  const x = curve(pp, [
    [-0.04, 0.95],
    [0, 0.9],
    [0.25, 0.72],
    [0.5, 0.52],
    [0.7, 0.27],
    [0.85, 0.1],
    [0.92, 0.04],
  ]);
  return { x, elevation, alpha: elevation > -5 ? 1 : 0 };
}

/** Moon: up through the night, from left to right so it never shares the frame with a low sun. */
export function moonAt(phase: number): Celestial {
  const p = wrap01(phase);
  // night runs 0.86 .. 1.0 (and a touch past dawn)
  const n = p >= 0.82 ? (p - 0.82) / 0.2 : p < 0.03 ? (p + 0.18) / 0.2 : -1;
  if (n < 0 || n > 1) return { x: 0.2, elevation: -10, alpha: 0 };
  const elevation = 48 * Math.sin(n * Math.PI);
  const alpha = ramp(p >= 0.82 ? p : p + 1, 0.84, 0.9) * (1 - ramp(p < 0.5 ? p + 1 : p, 0.995, 1.03));
  return { x: 0.18 + 0.6 * n, elevation, alpha };
}

/** Sample the sky at a phase and weather. */
export function sampleSky(phase: number, weather: Weather = 'clear'): SkySample {
  const p = wrap01(phase);
  const spec = WEATHER[weather];
  const base = clearSky(p);
  const rainTop = tok('skyRainTop');
  const rainHorizon = tok('skyRainHorizon');
  const rainLight = tok('lightRain');

  const top = toward(base.top, rainTop, spec.skyMix);
  const horizon = toward(base.horizon, rainHorizon, spec.skyMix);
  const light = toward(base.light, rainLight, spec.lightMix);
  // aerial perspective: distance cools toward a dusty blue-violet, more so in warm light
  const haze = mix(mix(horizon, top, 0.3), mix(tok('mountain'), tok('skyDuskTop'), 0.25), 0.5);

  const sun = sunAt(p);
  const moon = moonAt(p);
  const cloudDim = 1 - spec.cloudCover * 0.75;
  sun.alpha *= Math.max(0.15, cloudDim);
  moon.alpha *= Math.max(0.1, cloudDim);

  // lamps come on from golden hour, fully lit by dusk, fade after dawn
  const pp = p < 0.12 ? p + 1 : p;
  const lamps = Math.max(ramp(pp, 0.66, 0.84) * (1 - ramp(pp, 0.995, 1.07)), spec.skyMix > 0.7 ? 0.35 : 0);
  const stars = ramp(pp, 0.86, 0.93) * (1 - ramp(pp, 0.99, 1.02)) * (1 - spec.cloudCover * 0.85);
  const daylight = Math.max(0, Math.min(1, sun.elevation / 25)) * (1 - spec.skyMix * 0.5);

  // zenith: deeper than the top keyframe in daylight and twilight, never brighter at night
  const deeper = toward(base.top, tok('skyDuskTop'), 1);
  const zenith = mix(top, deeper, 0.3 * (1 - spec.skyMix * 0.6) * (sun.elevation > -8 ? 1 : 0.3));
  return {
    phase: p,
    weather,
    zenith,
    top,
    horizon,
    light,
    haze,
    hazeBoost: spec.haze,
    sun,
    moon,
    lamps,
    stars,
    daylight,
    spec,
  };
}

/** Sky colour at a vertical fraction t of the sky gradient (0 = top, 1 = horizon). */
export function skyAt(s: SkySample, t: number): RGB {
  const tt = Math.max(0, Math.min(1, t));
  return mix(s.top, s.horizon, tt * tt * (3 - 2 * tt) * 0.85 + tt * 0.15);
}

/** Named times of day used by the gallery (8 required by WP-09). */
export const TIMES_OF_DAY: { name: string; phase: number }[] = [
  { name: 'dawn', phase: 0.02 },
  { name: 'morning', phase: 0.25 },
  { name: 'noon', phase: 0.5 },
  { name: 'afternoon', phase: 0.62 },
  { name: 'golden hour', phase: 0.72 },
  { name: 'dusk', phase: 0.85 },
  { name: 'night', phase: 0.93 },
  { name: 'pre-dawn', phase: 0.985 },
];

export { bump };
