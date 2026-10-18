/**
 * Water reflections and lantern glow for Variant C (Evening Warmth).
 * Draws warm, shimmering reflection trails on the river and near water
 * beneath lit buildings, campfire, and lanterns, plus extra decorative village lanterns.
 */
import { tok, mix, css } from '../../../art/src/color.ts';
import { Paper, ellipse, rect, type Ctx2D } from '../../../art/src/paper.ts';
import { rng, hash } from '../../../art/src/rng.ts';
import type { Layout } from '../layout.ts';

/**
 * Draws water reflections on the river and near water beneath village light sources.
 * Sources include: lit structures, campfire, footbridge, and path lanterns.
 */
export function drawWaterReflections(
  g: Ctx2D,
  layout: Layout,
  k: number,
  y0: number,
  surface: 'strip' | 'ambient',
  W: number,
  yWaterTop: number,
  yWaterBot: number,
  intensity: number,
  timeSec: number,
  mapXFn: (x: number) => number,
  camX = 0,
): void {
  if (intensity <= 0.02) return;

  const r = rng(hash(layout.seed, 9411));
  const shimmer = Math.floor(timeSec * 5);
  const warmColor = mix(tok('lampGlow'), tok('flame'), 0.28);
  const colorStr = css(warmColor);

  // Collect light source x positions
  const lightXs: { x: number; width: number; strength: number }[] = [];
  for (const s of layout.structures) {
    if (s.kind === 'campfire') {
      lightXs.push({ x: s.x, width: 14, strength: 1.0 });
    } else if (s.stage >= 1) {
      // Lit window reflection under cottages/workshops
      lightXs.push({ x: s.x, width: s.def.w * 0.7, strength: 0.75 });
    }
  }

  // Also include decorative bridge/path lanterns
  lightXs.push({ x: 260, width: 8, strength: 0.6 });
  lightXs.push({ x: 620, width: 8, strength: 0.6 });
  lightXs.push({ x: 920, width: 8, strength: 0.6 });

  g.save();
  g.setTransform(k, 0, 0, k, -camX * k, -y0 * k);

  for (const src of lightXs) {
    const cx = mapXFn(src.x);
    if (cx < -40 || cx > W + 40) continue;

    const hWater = yWaterBot - yWaterTop;
    const linesCount = surface === 'strip' ? 14 : 26;

    for (let i = 0; i < linesCount; i++) {
      const prog = (i + 0.5) / linesCount;
      const y = yWaterTop + prog * hWater;
      const spread = (src.width * 0.4) + prog * (src.width * 0.85);
      const xOff = (r() - 0.5) * spread * 2;
      const x = cx + xOff;
      const len = (4 + r() * 10) * (1 - prog * 0.3);
      const hBar = 0.5 + prog * 0.35;

      // Ripple shimmer flicker
      const flick = (hash(i, shimmer, Math.round(src.x)) % 100) / 100;
      if (flick < 0.2) continue;

      const alpha = intensity * src.strength * (1 - prog * 0.4) * (0.25 + flick * 0.45) * (1 - Math.abs(xOff) / (spread * 1.3));
      if (alpha <= 0.01) continue;

      g.globalAlpha = Math.min(0.85, alpha);
      g.fillStyle = colorStr;
      g.fillRect(x - len / 2, y, len, hBar);
    }
  }

  g.restore();
}

/**
 * Draws extra decorative village lanterns along the path and footbridge.
 */
export function drawDecorativeLanterns(
  P: Paper,
  layout: Layout,
  mapXFn: (x: number) => number,
  groundY: number,
  litAlpha: number,
): void {
  // Pre-determined scenic positions for lanterns (near footbridge, noticeboard, well, path)
  const lanternPositions = [
    { x: 180, h: 22 }, // near noticeboard
    { x: 440, h: 20 }, // near well
    { x: 740, h: 21 }, // near footbridge west
    { x: 860, h: 21 }, // near footbridge east
    { x: 1100, h: 22 }, // orchard path
  ];

  for (const pos of lanternPositions) {
    const x = mapXFn(pos.x);
    const y = groundY;
    const postH = pos.h;

    // Wooden post
    P.piece(rect(x - 0.8, y - postH, 1.6, postH), tok('woodDark'), { shadow: 0.5, wobble: 0.2 });
    // Crossbar arm
    P.piece(rect(x - 0.6, y - postH, 5.0, 1.2), tok('woodDark'), { shadow: 0.3 });
    // Lantern hanger wire
    P.line([[x + 3.8, y - postH + 1.2], [x + 3.8, y - postH + 3.2]], 0.4, tok('ink'), { shadow: 0 });

    // Lantern housing
    const lx = x + 3.8;
    const ly = y - postH + 5.5;
    P.piece(rect(lx - 1.8, ly - 2.2, 3.6, 4.4), tok('ink'), { shadow: 0.4, wobble: 0.1 });

    // Glass core
    if (litAlpha > 0.05) {
      P.piece(rect(lx - 1.2, ly - 1.6, 2.4, 3.2), tok('lampGlow'), { shadow: 0, alpha: litAlpha });
      // Radial glow bloom
      P.glow(lx, ly, 10, tok('lampGlow'), 0.55 * litAlpha);
      P.glow(lx, ly, 4, mix(tok('cream'), tok('lampGlow'), 0.5), 0.75 * litAlpha);
    } else {
      P.piece(rect(lx - 1.2, ly - 1.6, 2.4, 3.2), tok('windowDark'), { shadow: 0 });
    }
  }
}
