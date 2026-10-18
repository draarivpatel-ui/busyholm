/** Seeded randomness and smooth noise. Deterministic across runs, browsers and Node. */

/** 32-bit integer hash of any number of integers. */
export function hash(...xs: number[]): number {
  let h = 0x811c9dc5 | 0;
  for (const x of xs) {
    let k = Math.imul((x | 0) ^ ((x * 4096) | 0), 0x5bd1e995);
    k ^= k >>> 15;
    h = Math.imul(h ^ k, 0x01000193);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Hash a string to a seed. */
export function seedOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Mulberry32 PRNG, returns floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform float in [a, b) from a PRNG. */
export const range = (r: () => number, a: number, b: number) => a + (b - a) * r();

/** Hash-based value in [0, 1) for integer lattice point i under a seed. */
export const lattice = (seed: number, i: number) => hash(seed, i) / 4294967296;

/** Smooth 1D value noise in [-1, 1]. */
export function noise1(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = lattice(seed, i);
  const b = lattice(seed, i + 1);
  return (a + (b - a) * u) * 2 - 1;
}

/** Fractal 1D noise (2 or 3 octaves), roughly in [-1, 1]. */
export function fbm1(seed: number, x: number, octaves = 3): number {
  let v = 0;
  let amp = 0.6;
  let f = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    v += noise1(seed + o * 101, x * f) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return v / norm;
}
