/**
 * Colour maths. No colour literals live here: every input is a token from tokens.ts
 * or a value computed from tokens.
 */
import { PAL, type Token } from './tokens.ts';

export interface RGB {
  r: number; // 0..255 (float)
  g: number;
  b: number;
}

const cache = new Map<string, RGB>();

/** Parse a #RRGGBB token string. */
export function hexToRgb(hex: string): RGB {
  const hit = cache.get(hex);
  if (hit) return hit;
  const h = hex.replace('#', '');
  if (h.length !== 6) throw new Error(`bad colour ${hex}`);
  const v = { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  cache.set(hex, v);
  return v;
}

/** RGB of a palette token. */
export function tok(name: Token): RGB {
  return hexToRgb(PAL[name]);
}

const clamp255 = (x: number) => Math.max(0, Math.min(255, x));

/** CSS colour string for canvas (built at runtime from computed channels). */
export function css(c: RGB, alpha = 1): string {
  const r = Math.round(clamp255(c.r));
  const g = Math.round(clamp255(c.g));
  const b = Math.round(clamp255(c.b));
  return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${Math.max(0, alpha).toFixed(3)})`;
}

/** CSS string of a token, optionally with alpha. */
export function tcss(name: Token, alpha = 1): string {
  return alpha >= 1 ? PAL[name] : css(tok(name), alpha);
}

// sRGB <-> linear
const toLin = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const fromLin = (l: number) => {
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(Math.max(0, l), 1 / 2.4) - 0.055;
  return s * 255;
};

/** WCAG 2.x relative luminance. */
export function luminance(c: RGB): number {
  return 0.2126 * toLin(c.r) + 0.7152 * toLin(c.g) + 0.0722 * toLin(c.b);
}

/** WCAG 2.x contrast ratio. */
export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** sRGB to OKLab (Bjorn Ottosson). */
export function toOklab(c: RGB): Lab {
  const r = toLin(c.r);
  const g = toLin(c.g);
  const b = toLin(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export function fromOklab(c: Lab): RGB {
  const l = Math.pow(c.L + 0.3963377774 * c.a + 0.2158037573 * c.b, 3);
  const m = Math.pow(c.L - 0.1055613458 * c.a - 0.0638541728 * c.b, 3);
  const s = Math.pow(c.L - 0.0894841775 * c.a - 1.291485548 * c.b, 3);
  return {
    r: clamp255(fromLin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: clamp255(fromLin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: clamp255(fromLin(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  };
}

/** Perceptual mix (OKLab), t in 0..1. */
export function mix(a: RGB, b: RGB, t: number): RGB {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const A = toOklab(a);
  const B = toOklab(b);
  return fromOklab({ L: A.L + (B.L - A.L) * t, a: A.a + (B.a - A.a) * t, b: A.b + (B.b - A.b) * t });
}

/** Plain sRGB lerp (what canvas alpha blending does). */
export function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

/** Multiply blend (what a light tint does to lit paper). */
export function multiply(a: RGB, b: RGB): RGB {
  return { r: (a.r * b.r) / 255, g: (a.g * b.g) / 255, b: (a.b * b.b) / 255 };
}

/** Source-over composite of colour `top` at `alpha` onto `under`. */
export function over(under: RGB, top: RGB, alpha: number): RGB {
  return lerpRgb(under, top, Math.max(0, Math.min(1, alpha)));
}

/** Lighten or darken in OKLab lightness. */
export function shade(c: RGB, dL: number): RGB {
  const o = toOklab(c);
  return fromOklab({ L: Math.max(0, Math.min(1, o.L + dL)), a: o.a, b: o.b });
}
