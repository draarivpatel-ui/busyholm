/**
 * Alert flag and bell style (SPEC 3.3): the flag colour alone fails against light skies,
 * so the flag always carries a double outline, ink inside and cream outside.
 * Drawn in the emissive pass, after time-of-day tinting, so the lint's numbers are what is on screen.
 */
import type { Token } from './tokens.ts';
import { Paper, type Pt, rect, ellipse } from './paper.ts';
import { tok, mix } from './color.ts';
import { PAL } from './tokens.ts';

export interface FlagStyle {
  fill: Token;
  /** outlines from inside to outside */
  outlines: Token[];
  /** outline widths in strip units, same order */
  widths: number[];
}

/**
 * Ink inside, cream outside. Ink vs cream is about 12:1, so against ANY background colour B one of
 * the two outlines reaches at least sqrt(12) = 3.5:1 (contrast ratios multiply across a luminance
 * range: C(cream, B) * C(B, ink) = C(cream, ink)). The lint still checks every sky step.
 */
export const FLAG_STYLE: FlagStyle = {
  fill: 'alertFlag',
  outlines: ['ink', 'cream'],
  widths: [0.9, 1.0],
};

/** Minimum WCAG non-text contrast (SPEC 3.3, WCAG 1.4.11). */
export const MIN_OUTLINE_CONTRAST = 3;

// ---------------------------------------------------------------- drawing


/** Stroke a closed polygon with the double outline then fill it (clean edges: this is UI-grade). */
function outlined(P: Paper, pts: Pt[], fill: Token | ReturnType<typeof tok>): void {
  const ctx = P.ctx;
  const path = new Path2D();
  path.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
  path.closePath();
  ctx.save();
  ctx.lineJoin = 'round';
  const [wIn, wOut] = FLAG_STYLE.widths;
  const outer = FLAG_STYLE.outlines[1];
  const inner = FLAG_STYLE.outlines[0];
  if (P.flat) {
    ctx.fillStyle = P.flat;
    ctx.strokeStyle = P.flat;
    ctx.lineWidth = 2 * (wIn + wOut);
    ctx.stroke(path);
    ctx.fill(path);
    ctx.restore();
    return;
  }
  ctx.strokeStyle = PALCSS(outer);
  ctx.lineWidth = 2 * (wIn + wOut);
  ctx.stroke(path);
  ctx.strokeStyle = PALCSS(inner);
  ctx.lineWidth = 2 * wIn;
  ctx.stroke(path);
  ctx.restore();
  P.piece(pts, fill, { wobble: 0, shadow: 0 });
}

const PALCSS = (t: Token) => PAL[t];

export type AlertIcon = 'question' | 'permission' | 'none';

/**
 * The alert flag, 14 x 10 units, hoisted with its top-left at the pole top (0, 0) and flying to the
 * right. `wave` 0..2 gives three cut shapes for the flutter loop. Icon: "!" for a question, a key
 * for permission (SPEC 4.3), in ink on the flag.
 */
export function drawFlag(P: Paper, icon: AlertIcon, wave = 0): void {
  const W = 14;
  const H = 10;
  const d = [0, 0.9, -0.7][wave % 3];
  const pts: Pt[] = [
    [0, 0],
    [W * 0.5, d * 0.6],
    [W, -d * 0.2],
    [W - 2.6, H / 2],
    [W, H - d * 0.2],
    [W * 0.5, H + d * 0.6],
    [0, H],
  ];
  outlined(P, pts, FLAG_STYLE.fill);
  const ink = 'ink' as const;
  if (icon === 'question') {
    // "!" glyph
    P.piece(rect(5.3, 1.7, 1.9, 4.5), ink, { wobble: 0, shadow: 0 });
    P.piece(rect(5.3, 7.1, 1.9, 1.7), ink, { wobble: 0, shadow: 0 });
  } else if (icon === 'permission') {
    // key: ring plus shaft and two teeth
    const ctx = P.ctx;
    ctx.save();
    ctx.strokeStyle = P.flat ?? PAL.ink;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(3.6, 5, 1.75, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    P.piece(rect(5.2, 4.35, 5.6, 1.3), ink, { wobble: 0, shadow: 0 });
    P.piece(rect(8.6, 5.4, 1.2, 1.8), ink, { wobble: 0, shadow: 0 });
    P.piece(rect(10.2, 5.4, 0.9, 1.4), ink, { wobble: 0, shadow: 0 });
  }
}

/** Furled flag at the bottom of the halyard (not alerting): a small rolled bundle. */
export function drawFlagFurled(P: Paper): void {
  P.piece(rect(0, 0, 2.4, 6), mix(tok('alertFlag'), tok('wood'), 0.35), { shadow: 0.8, rim: 0.6 });
  P.piece(rect(-0.2, 1.8, 2.8, 0.7), 'woodDark', { shadow: 0, wobble: 0 });
}

/** The resting bell (not alerting): plain brass paper, lit like the rest of the world. */
export function drawBellRest(P: Paper): void {
  const brass = mix(tok('alertFlag'), tok('wood'), 0.45);
  P.piece([[-1.2, 0.6], [1.2, 0.6], [2.4, 2.2], [2.9, 5.8], [4.4, 8.2], [-4.4, 8.2], [-2.9, 5.8], [-2.4, 2.2]], brass, { shadow: 1, rim: 0.8, wobble: 0.2 });
  P.piece(rect(-3.2, 6.2, 6.4, 0.8), mix(tok('alertFlag'), tok('woodDark'), 0.6), { wobble: 0, shadow: 0 });
  P.piece(ellipse(0, 9.2, 1, 1, 10), 'woodDark', { wobble: 0, shadow: 0.4 });
  P.line([[0, 9.6], [0.4, 26]], 0.7, mix(tok('reedTip'), tok('cream'), 0.3), { shadow: 0.4, wobble: 0 });
}

/** The ringing bell, 10 units tall, hanging from (0, 0). swing in -1..1 tilts it. Double outlined. */
export function drawBell(P: Paper, swing = 0): void {
  const ctx = P.ctx;
  ctx.save();
  ctx.rotate(swing * 0.42);
  const pts: Pt[] = [
    [-1.2, 0.6],
    [1.2, 0.6],
    [2.4, 2.2],
    [2.9, 5.8],
    [4.4, 8.2],
    [-4.4, 8.2],
    [-2.9, 5.8],
    [-2.4, 2.2],
  ];
  outlined(P, pts, mix(tok('alertFlag'), tok('wood'), 0.25));
  P.piece(rect(-3.2, 6.2, 6.4, 0.8), mix(tok('alertFlag'), tok('woodDark'), 0.55), { wobble: 0, shadow: 0 });
  P.piece(ellipse(swing * -1.4, 9.4, 1.1, 1.1, 10), 'ink', { wobble: 0, shadow: 0 });
  ctx.restore();
}
