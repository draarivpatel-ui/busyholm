/**
 * Distant landmarks for Variant B (Seasonal Richness).
 * Provides code-drawn papercut silhouettes of:
 * 1. A distant hilltop windmill with angled sails.
 * 2. A distant coastal lighthouse with glowing lantern room.
 * 3. A hilltop watchtower/beacon.
 */
import { tok, mix } from '../../../art/src/color.ts';
import { Paper, type Pt, ellipse, rect } from '../../../art/src/paper.ts';

/**
 * Draws a distant papercut windmill on a hill crest.
 * x, y: anchor point on the hill ridge in strip units.
 * scale: sizing factor (0.4 to 1.0).
 */
export function drawWindmill(P: Paper, x: number, y: number, scale = 0.65, angle = 0.4): void {
  const w = 12 * scale;
  const h = 20 * scale;
  const body: Pt[] = [
    [x - w * 0.45, y],
    [x - w * 0.32, y - h * 0.85],
    [x + w * 0.32, y - h * 0.85],
    [x + w * 0.45, y],
  ];
  const cap: Pt[] = [
    [x - w * 0.38, y - h * 0.85],
    [x, y - h * 1.15],
    [x + w * 0.38, y - h * 0.85],
  ];
  // Tower body
  P.piece(body, mix(tok('stone'), tok('farHills'), 0.4), { shadow: 0.6, wobble: 0.3 });
  // Conical cap
  P.piece(cap, mix(tok('roofThatch'), tok('farHills'), 0.3), { shadow: 0.5, wobble: 0.2 });

  // Hub and 4 sails
  const hubX = x;
  const hubY = y - h * 0.82;
  const sailLen = 15 * scale;
  const sailW = 2.4 * scale;

  for (let i = 0; i < 4; i++) {
    const a = angle + (i * Math.PI) / 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const tipX = hubX + cos * sailLen;
    const tipY = hubY + sin * sailLen;
    // Spar
    P.line([[hubX, hubY], [tipX, tipY]], 0.6 * scale, mix(tok('woodDark'), tok('farHills'), 0.3), { shadow: 0.2 });
    // Sail cloth
    const sparMidX = hubX + cos * (sailLen * 0.6);
    const sparMidY = hubY + sin * (sailLen * 0.6);
    const perpX = -sin * sailW;
    const perpY = cos * sailW;
    const cloth: Pt[] = [
      [hubX + cos * (sailLen * 0.25), hubY + sin * (sailLen * 0.25)],
      [tipX, tipY],
      [tipX + perpX, tipY + perpY],
      [sparMidX + perpX * 0.8, sparMidY + perpY * 0.8],
    ];
    P.piece(cloth, mix(tok('cream'), tok('farHills'), 0.35), { shadow: 0.3, alpha: 0.9, wobble: 0.2 });
  }

  // Central hub cap
  P.piece(ellipse(hubX, hubY, 1.2 * scale, 1.2 * scale, 8), tok('woodDark'), { shadow: 0.2 });
}

/**
 * Draws a distant papercut lighthouse on a coastal headland or mountain bluff.
 * x, y: base anchor on the ridge.
 */
export function drawLighthouse(P: Paper, x: number, y: number, scale = 0.7, lanternOn = true): void {
  const w = 11 * scale;
  const h = 26 * scale;
  const tower: Pt[] = [
    [x - w * 0.5, y],
    [x - w * 0.3, y - h * 0.78],
    [x + w * 0.3, y - h * 0.78],
    [x + w * 0.5, y],
  ];
  // Tower body (white stone)
  P.piece(tower, mix(tok('wall'), tok('cream'), 0.5), { shadow: 0.7, rim: 0.6, wobble: 0.3 });
  // Red/terracotta stripe band around upper third
  const bandY = y - h * 0.52;
  const bandH = h * 0.2;
  const stripe: Pt[] = [
    [x - w * 0.42, bandY],
    [x - w * 0.36, bandY - bandH],
    [x + w * 0.36, bandY - bandH],
    [x + w * 0.42, bandY],
  ];
  P.piece(stripe, mix(tok('roof'), tok('mountain'), 0.2), { shadow: 0.3, wobble: 0.2 });

  // Gallery rail platform
  const galY = y - h * 0.78;
  P.piece(rect(x - w * 0.45, galY - 1.5 * scale, w * 0.9, 1.8 * scale), tok('ink'), { shadow: 0.4 });

  // Lantern room
  const roomY = galY - 1.5 * scale;
  const roomH = 5 * scale;
  const roomW = w * 0.55;
  P.piece(rect(x - roomW * 0.5, roomY - roomH, roomW, roomH), lanternOn ? tok('lampGlow') : tok('windowDark'), { shadow: 0.2 });

  // Conical dome cap
  const dome: Pt[] = [
    [x - roomW * 0.65, roomY - roomH],
    [x, roomY - roomH - 4 * scale],
    [x + roomW * 0.65, roomY - roomH],
  ];
  P.piece(dome, tok('roofSlateDeep'), { shadow: 0.5, wobble: 0.2 });

  // Soft guiding lantern beam if lit
  if (lanternOn) {
    const beamY = roomY - roomH * 0.5;
    P.glow(x, beamY, 8 * scale, tok('lampGlow'), 0.6);
    // Soft horizontal beam fan
    const beam: Pt[] = [
      [x, beamY],
      [x - 70 * scale, beamY - 14 * scale],
      [x - 70 * scale, beamY + 14 * scale],
    ];
    P.piece(beam, tok('lampGlow'), { shadow: 0, alpha: 0.25, wobble: 0 });
  }
}

/**
 * Draws a distant stone watchtower or beacon on a high ridge.
 */
export function drawWatchtower(P: Paper, x: number, y: number, scale = 0.6): void {
  const w = 10 * scale;
  const h = 18 * scale;
  const body: Pt[] = [
    [x - w * 0.5, y],
    [x - w * 0.42, y - h * 0.85],
    [x + w * 0.42, y - h * 0.85],
    [x + w * 0.5, y],
  ];
  P.piece(body, mix(tok('stoneDark'), tok('farHills'), 0.3), { shadow: 0.6, wobble: 0.3 });
  // Parapet battlements
  const py = y - h * 0.85;
  P.piece(rect(x - w * 0.55, py - 3 * scale, w * 1.1, 3 * scale), mix(tok('stone'), tok('farHills'), 0.2), { shadow: 0.4 });
  // Narrow slit window
  P.piece(rect(x - 0.7 * scale, y - h * 0.5, 1.4 * scale, 3.5 * scale), tok('ink'), { shadow: 0 });
}
