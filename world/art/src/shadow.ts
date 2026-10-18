/**
 * Soft directional shadow system (SPEC 3.1, 3.5): every paper layer drops a soft ink shadow
 * onto the layer behind it; the offset and length follow the sun (long at dawn and dusk,
 * short at noon), and fade under cloud and at night (faint moon shadows).
 *
 * Units: strip units per unit of depth gap. A layer that floats `gap` units in front of the
 * layer behind it casts a shadow offset by (dx, dy) * gap with blur * gap.
 */
import { SHADOW_ALPHA } from './tokens.ts';
import type { SkySample } from './sky.ts';

export interface ShadowParams {
  /** horizontal offset per depth unit (negative = toward the left) */
  dx: number;
  /** vertical offset per depth unit (positive = downward) */
  dy: number;
  /** blur radius per depth unit */
  blur: number;
  /** ink alpha (before per-layer multipliers) */
  alpha: number;
  /** shadow length factor (1 / tan elevation, clamped) for contact shadows */
  length: number;
  /** -1, 0 or +1 with easing: which way shadows fall horizontally */
  side: number;
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export function shadowFor(sky: SkySample): ShadowParams {
  const sunUp = sky.sun.elevation > -3;
  const src = sunUp ? sky.sun : sky.moon;
  const e = Math.max(7, src.elevation);
  const length = clamp(1 / Math.tan((e * Math.PI) / 180), 0.35, 3.4);
  const off = 0.5 - src.x;
  const side = Math.sign(off) * smoothstep(0.02, 0.2, Math.abs(off));
  const sinE = Math.sin((Math.max(0, src.elevation) * Math.PI) / 180);
  const twilight = sunUp ? smoothstep(-3, 4, sky.sun.elevation) : 0.45 * sky.moon.alpha;
  return {
    dx: side * length * 0.95,
    dy: 0.4 + 0.75 * sinE,
    blur: 0.55 + 0.42 * length,
    alpha: SHADOW_ALPHA * sky.spec.shadow * twilight,
    length,
    side,
  };
}

/** Per-layer depth gaps (how far each paper layer floats in front of the one behind it). */
export const LAYER_GAP = {
  farHills: 1.2,
  midHills: 1.0,
  river: 0.5,
  bank: 1.4,
  village: 2.2,
  reeds: 1.6,
} as const;
