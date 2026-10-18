// Resident portraits for the popover and details window, drawn with the WP-09 art kit, so a row
// shows the same papercut animal (and scarf colour) the strip shows. Bundled to dist/ui/art.js.
import { tok, css } from '../../../world/art/src/color.ts';
import { SCARVES } from '../../../world/art/src/tokens.ts';
import { Paper } from '../../../world/art/src/paper.ts';
import { drawResident, posesFor } from '../../../world/art/src/residents.ts';

type Species = Parameters<typeof posesFor>[0];

const cache = new Map<string, HTMLCanvasElement>();

/**
 * A portrait canvas `size` CSS px square. `pose` is a posesFor() key; unknown keys fall back
 * to stand-0. Cached per species, scarf, pose, size and device scale.
 */
export function portrait(species: Species, scarf: number, pose: string, size = 40, dprIn = 0): HTMLCanvasElement {
  const dpr = Math.min(3, Math.max(1, dprIn || globalThis.devicePixelRatio || 1));
  const key = `${species}|${scarf}|${pose}|${size}|${dpr}`;
  const hit = cache.get(key);
  if (hit) return copy(hit);
  const poses = posesFor(species);
  const p = poses[pose] ?? poses['stand-0'];
  const c = document.createElement('canvas');
  c.width = Math.round(size * dpr);
  c.height = Math.round(size * dpr);
  c.style.width = c.style.height = `${size}px`;
  const g = c.getContext('2d')!;
  // residents are about 30 units tall with their feet at y = 0; props and extras reach higher
  const k = (size / 34) * dpr;
  const ox = c.width / 2;
  const oy = c.height - 2.5 * dpr;
  g.setTransform(k, 0, 0, k, ox, oy);
  drawResident(new Paper(g, k, 101), species, p, 'base');
  const s = document.createElement('canvas');
  s.width = c.width;
  s.height = c.height;
  const sg = s.getContext('2d')!;
  sg.setTransform(k, 0, 0, k, ox, oy);
  drawResident(new Paper(sg, k, 101), species, p, 'scarf');
  sg.setTransform(1, 0, 0, 1, 0, 0);
  sg.globalCompositeOperation = 'source-in';
  sg.fillStyle = css(tok(SCARVES[((scarf % 6) + 6) % 6]));
  sg.fillRect(0, 0, s.width, s.height);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(s, 0, 0);
  cache.set(key, c);
  return copy(c);
}

function copy(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.style.width = src.style.width;
  c.style.height = src.style.height;
  c.getContext('2d')!.drawImage(src, 0, 0);
  return c;
}
