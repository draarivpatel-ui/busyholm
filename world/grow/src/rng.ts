// Seeded pseudo-random numbers with 32-bit integer maths only (Math.imul and shifts), so every
// JavaScript engine produces the same sequence. Used for decoration slots and by the simulation
// and the random-ledger test generator. Never used for anything that must be secret.

/** mulberry32: returns a function that yields uint32 values. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Mixes a seed with a small integer salt into a new uint32 seed (so independent streams do not overlap). */
export function mixSeed(seed: number, salt: number): number {
  let h = (seed ^ Math.imul(salt + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Uniform integer in [0, n) from a uint32 source (n at most 2^32). Modulo bias is irrelevant here. */
export function nextInt(next: () => number, n: number): number {
  return next() % n;
}

/** Fisher-Yates shuffle of a copy, driven by the given source. */
export function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}
