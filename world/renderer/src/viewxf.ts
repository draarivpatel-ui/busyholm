/**
 * View transforms: canonical units (the art kit's 1440-unit layout, y down from the strip top)
 * to CSS pixels, for the strip and for the ambient view. Pure.
 */
import type { AmbientParams, CanonicalArtVariant, Surface } from './api.ts';
import { CANON_W } from './layout.ts';

export const STRIP_H = 112;
export const GROUND_Y = 82;
export const STRUCTURE_BASE_Y = 80;

export const AMBIENT_DEFAULTS: AmbientParams = {
  worldScale: 4.6,
  groundFrac: 0.7,
  parallax: true,
  panSpeed: 7,
  resScale: 0.5,
};

export interface ViewXf {
  surface: Surface;
  /** CSS size */
  width: number;
  height: number;
  /** device pixel ratio after the cap */
  dpr: number;
  /** render resolution: device pixels per CSS pixel actually used for the backing store */
  res: number;
  /** CSS px per unit */
  s: number;
  /** view width in units */
  W: number;
  /** unit y at the top and bottom edge of the view */
  y0: number;
  y1: number;
  /** ambient parameters (ambient only) */
  ambient: AmbientParams | null;
  /** B2 art exploration variant */
  variant: CanonicalArtVariant;
}

export function makeXf(surface: Surface, width: number, height: number, dprRaw: number, maxDpr: number | undefined, ambient: Partial<AmbientParams> = {}, variant: CanonicalArtVariant = 'default'): ViewXf {
  const cap = maxDpr ?? (surface === 'strip' ? 2 : 2);
  const dpr = Math.max(0.5, Math.min(cap, dprRaw || 1));
  if (surface === 'strip') {
    const s = height / STRIP_H;
    return { surface, width, height, dpr, res: dpr, s, W: width / s, y0: 0, y1: STRIP_H, ambient: null, variant };
  }
  const a: AmbientParams = { ...AMBIENT_DEFAULTS };
  for (const [key, v] of Object.entries(ambient)) if (v !== undefined && v !== null && !Number.isNaN(v)) (a as unknown as Record<string, unknown>)[key] = v;
  const s = a.worldScale * (height / 1080);
  const y0 = GROUND_Y - (a.groundFrac * height) / s;
  // the spike's half-resolution rule: render ambient at resScale x CSS pixels, never above the dpr
  const res = Math.max(0.5, Math.min(dpr, a.resScale));
  return { surface, width, height, dpr, res, s, W: width / s, y0, y1: y0 + height / s, ambient: a, variant };
}

/** Canonical x to view-unit x (strip: compress narrow views, centre wide ones). */
export function mapX(xf: ViewXf, x: number): number {
  if (xf.surface !== 'strip') return x;
  return xf.W >= CANON_W ? x + (xf.W - CANON_W) / 2 : x * (xf.W / CANON_W);
}

/** Canonical point to CSS px; camX is the ambient camera's left edge in units. */
export function toCss(xf: ViewXf, x: number, y: number, camX = 0): [number, number] {
  return [(mapX(xf, x) - camX) * xf.s, (y - xf.y0) * xf.s];
}

/** Visible width in canonical units (for the ambient camera). */
export function visibleUnits(xf: ViewXf): number {
  return xf.W;
}
