/**
 * Scene description and full-scene rendering (strip and ambient), used by the gallery and goldens.
 * This is the reference look for the WP-10 PixiJS renderer: same layers, same order, same light.
 */
import { SIZES, SCARVES } from './tokens.ts';
import { tok, css, mix } from './color.ts';
import type { Weather } from './sky.ts';
import { Paper, ellipse, type Ctx2D } from './paper.ts';
import { rng, range, hash } from './rng.ts';
import type { Season } from './terrain.ts';
import { LAND } from './terrain.ts';
import { STRUCTURES, type StructureKind, type Stage } from './structures.ts';
import { SPECIES_DEFS, type Species } from './residents.ts';
import { structureBounds } from './sprites.ts';
import { drawFrame, type Atlas } from './atlas.ts';
import { firefly, rainbow, rainStroke, snowflake, leaf } from './props.ts';
import type { AlertIcon } from './alert.ts';
import {
  makeFrame,
  drawSky,
  drawSunMoonStars,
  drawClouds,
  drawTerrainBack,
  drawFog,
  drawSunBloom,
  drawBankLayer,
  drawReedsLayer,
  layer,
  emissive,
  paperFor,
  horizonY,
  type View,
  type Frame,
} from './compose.ts';

export interface PlacedStructure {
  kind: StructureKind;
  stage: Stage;
  /** canonical x (units, in a 1440-unit-wide layout) */
  x: number;
  variant?: number;
  /** rotation of the moving part in radians */
  partAngle?: number;
  /** chimney smoking */
  smoke?: boolean;
  /** dust puff (stage just completed) */
  dust?: boolean;
  /** windows dark (residents asleep) */
  dark?: boolean;
}

export interface PlacedResident {
  species: Species;
  /** pose key, e.g. 'work-0', 'ring-0' (see residents.ts posesFor) */
  pose: string;
  /** scarf index 0..5 (instance colour) */
  scarf: number;
  /** canonical x */
  x: number;
  facing?: 1 | -1;
  helper?: boolean;
  /** stale ('unknown') residents are drawn faded */
  faded?: boolean;
  /** lantern glow (your_turn) */
  glow?: boolean;
  /** vertical offset (units, negative = up) */
  dy?: number;
}

export interface SceneSpec {
  id: string;
  title: string;
  /** what this golden demonstrates, in light of the SPEC 4.3 state table */
  note: string;
  phase: number;
  weather: Weather;
  season: Season;
  seed: number;
  structures: PlacedStructure[];
  residents: PlacedResident[];
  trees: { x: number; id: string; behind?: boolean }[];
  decorations?: { x: number; id: string }[];
  alert?: { post: 'bellpost' | 'belltower'; icon: AlertIcon; raised: boolean; ringing: boolean; wave?: number };
  /** a flying plank from (x0) to the build site (x1), t in 0..1 */
  plank?: { x0: number; x1: number; t: number };
  confetti?: number;
  /** limit-hit shower over a canonical x range */
  shower?: [number, number];
  fireflies?: number;
  /** ambient camera left edge (canonical units) */
  cameraX?: number;
  /** animation time in seconds (drifting clouds, smoke) */
  t?: number;
}

/** Canonical layout width the scenes are authored at. */
export const CANON_W = 1440;

/** Map canonical x to view x: compress a little on narrow views, centre with extra meadow on wide ones. */
export function mapX(F: Frame, x: number): number {
  const W = F.view.kind === 'strip' ? F.W : CANON_W;
  if (W >= CANON_W) return x + (W - CANON_W) / 2;
  return x * (W / CANON_W);
}

function contactShadow(P: Paper, F: Frame, x: number, w: number, alpha = 1): void {
  const sp = F.shadow;
  const a = Math.min(0.5, sp.alpha * 2.2) * alpha;
  if (a < 0.01) return;
  const stretch = 1 + sp.length * 0.25;
  P.piece(ellipse(x + sp.side * w * 0.22 * sp.length * 0.4, SIZES.groundY - 0.4, (w / 2) * stretch, 1.6 + w * 0.025, 24), 'ink', {
    shadow: 0,
    wobble: 0,
    alpha: a,
  });
}

/** Render a scene into a canvas sized for the view (device pixels = CSS size x dpr). */
export function renderScene(canvas: HTMLCanvasElement | OffscreenCanvas, scene: SceneSpec, view: View, atlas: Atlas): void {
  canvas.width = Math.round(view.width * view.dpr);
  canvas.height = Math.round(view.height * view.dpr);
  const ctx = canvas.getContext('2d') as Ctx2D;
  // ambient camera stays inside the authored map so no layer edge is ever visible
  const visW = view.width / (SIZES.ambientWorldScale * (view.height / 1080));
  const camX = view.kind === 'ambient' ? Math.max(0, Math.min(CANON_W - visW, scene.cameraX ?? 0)) : 0;
  const v: View = { ...view, cameraX: camX };
  const F = makeFrame(ctx, v, scene.phase, scene.weather, scene.season, scene.seed);
  const t = scene.t ?? 0;
  const X = (x: number) => mapX(F, x);
  const groundY = SIZES.structureBaseY;

  // ---- sky
  drawSky(F);
  drawSunMoonStars(F);
  drawClouds(F, t);
  if (F.view.kind === 'ambient' && F.sky.daylight > 0.05) {
    emissive(F, (P) => {
      const r = rng(hash(scene.seed, 4242));
      const cx = F.camX + F.W * range(r, 0.55, 0.8);
      const cy = horizonY(F) - range(r, 60, 110);
      for (let i = 0; i < 5; i++) {
        const x = cx + i * 7 + range(r, -3, 3);
        const y = cy + Math.abs(i - 2) * 3.5 + range(r, -1.5, 1.5);
        const s = range(r, 1.4, 2);
        P.line([[x - s * 1.6, y - s * 0.4], [x - s * 0.5, y - s * 0.6], [x, y + s * 0.2], [x + s * 0.5, y - s * 0.6], [x + s * 1.6, y - s * 0.4]], 0.55, 'ink', { shadow: 0, wobble: 0, alpha: 0.6 });
      }
    });
  }
  if (F.sky.spec.rainbow > 0) {
    layer(F, { gap: 0.6, haze: 0.2, shadowGain: 0.3 }, (P) => {
      const cx = F.camX + F.W * 0.62;
      rainbow(P, F.view.kind === 'strip' ? 70 : 220, 0.75 * F.sky.spec.rainbow);
      void cx;
    });
  }

  // ---- terrain
  drawTerrainBack(F);
  drawSunBloom(F);
  drawFog(F, t);
  const creeks: [number, number][] = [];
  for (const s of scene.structures) {
    const def = STRUCTURES[s.kind];
    if (def?.creek && s.stage >= 1) creeks.push([X(s.x) + def.creek.x0, X(s.x) + def.creek.x1]);
  }
  drawBankLayer(
    F,
    (P) => {
      for (const s of scene.structures) {
        const def = STRUCTURES[s.kind];
        if (!def || def.creek) continue;
        contactShadow(P, F, X(s.x), def.w * (s.stage === 1 ? 0.8 : 0.95));
      }
      for (const tr of scene.trees) contactShadow(P, F, X(tr.x), 14, 0.7);
      for (const r of scene.residents) if (!r.dy) contactShadow(P, F, X(r.x), r.helper ? 5 : 10, 0.9);
    },
    creeks,
  );

  // ---- village: trees behind (plus seeded edge groves on strips wider than the authored map),
  // structures, then residents and props in front
  const margin = F.view.kind === 'strip' ? (F.W - CANON_W) / 2 : 0;
  const edge: { x: number; id: string }[] = [];
  if (margin > 30) {
    const er = rng(hash(scene.seed, 909));
    const ids = ['tree/broad/0', 'tree/conifer/0', 'tree/broad/1', 'bush/1', 'tree/conifer/1', 'bush/0', 'tree/broad/2', 'bush/2'];
    for (const side of [-1, 1]) {
      let d = range(er, 14, 30);
      while (d < margin - 8) {
        edge.push({ x: side < 0 ? -d : CANON_W + d, id: ids[Math.floor(er() * ids.length)] });
        d += range(er, 22, 60);
      }
    }
  }
  layer(F, { gap: 2.0, haze: 0.03 }, (P) => {
    for (const tr of [...scene.trees.filter((tr) => tr.behind), ...edge]) drawFrame(P.ctx, atlas, tr.id, X(tr.x), groundY - 1.5);
  });
  layer(F, { gap: 2.2, haze: 0 }, (P) => {
    for (const s of scene.structures) {
      const id = s.kind === 'cottage' && s.stage === 3 && s.variant === 1 ? 'st/cottage/3/v1' : `st/${s.kind}/${s.stage}`;
      drawFrame(P.ctx, atlas, id, X(s.x), groundY);
      const def = STRUCTURES[s.kind];
      if (def?.part && s.stage === 3) {
        const pv = def.points(3).pivot;
        if (pv) drawFrame(P.ctx, atlas, `st/${s.kind}/part`, X(s.x) + pv[0], groundY + pv[1], { rot: s.partAngle ?? 0.3 });
      }
    }
    for (const tr of scene.trees.filter((tr) => !tr.behind)) drawFrame(P.ctx, atlas, tr.id, X(tr.x), groundY + 0.5);
    const post = scene.structures.find((s) => s.kind === 'bellpost' || s.kind === 'belltower');
    const bell = post && STRUCTURES[post.kind]?.points(post.stage).bell;
    if (post && bell && !scene.alert?.ringing) drawFrame(P.ctx, atlas, 'alert/bell-rest', X(post.x) + bell[0], groundY + bell[1]);
  });
  // smoke from chimneys (paper puffs, lit like paper)
  const smokeFrom = scene.structures.filter((s) => s.smoke && STRUCTURES[s.kind]?.points(s.stage).chimney);
  if (smokeFrom.length) {
    layer(F, { gap: 0.8, haze: 0.05, shadowGain: 0.5 }, (P) => {
      for (const s of smokeFrom) {
        const c = STRUCTURES[s.kind]!.points(s.stage).chimney!;
        const r = rng(hash(scene.seed, s.x | 0));
        const lean = 1.2 + F.sky.spec.wind * 3;
        for (let i = 0; i < 4; i++) {
          const ph = (i + ((t * 0.35 + r()) % 1)) / 4;
          const x = X(s.x) + c[0] + ph * lean * 6 + Math.sin(ph * 6 + i) * 0.8;
          const y = groundY + c[1] - 2 - ph * 16;
          drawFrame(P.ctx, atlas, `fx/smoke/${Math.min(2, Math.floor(ph * 3))}`, x, y, { alpha: 0.85 * (1 - ph * 0.85) });
        }
      }
    });
  }
  layer(F, { gap: 0.9, haze: 0 }, (P) => {
    for (const d of scene.decorations ?? []) drawFrame(P.ctx, atlas, d.id, X(d.x), SIZES.groundY + 0.5);
    // residents (scarf overlays tinted per instance)
    for (const r of scene.residents) drawResidentSprite(P.ctx, atlas, r, X(r.x), SIZES.groundY + (r.dy ?? 0));
    if (scene.plank) {
      const { x0, x1, t: pt } = scene.plank;
      const x = X(x0) + (X(x1) - X(x0)) * pt;
      const y = SIZES.groundY - 18 - Math.sin(pt * Math.PI) * 26;
      drawFrame(P.ctx, atlas, 'fx/plank', x, y, { rot: pt * 2.4 - 0.4 });
    }
    for (const s of scene.structures) if (s.dust) drawFrame(P.ctx, atlas, 'fx/dust', X(s.x), groundY + 1);
    if (scene.confetti !== undefined) drawFrame(P.ctx, atlas, 'fx/confetti', X(scene.confetti), SIZES.groundY - 20);
  });

  // ---- emissive pass: never dimmed by night
  const lamps = F.sky.lamps;
  if (lamps > 0.02) {
    emissive(F, (P) => {
      for (const s of scene.structures) {
        const id = s.kind === 'campfire' ? `st/campfire/1/lit/${Math.floor(t * 8) % 4}` : `st/${s.kind}/${s.stage}/lit`;
        if (s.kind === 'campfire' || s.dark) continue;
        drawFrame(P.ctx, atlas, id, X(s.x), groundY, { alpha: lamps });
      }
    });
  }
  emissive(F, (P) => {
    // campfire always burns (if present)
    for (const s of scene.structures) if (s.kind === 'campfire') drawFrame(P.ctx, atlas, `st/campfire/1/lit/${Math.floor(t * 8) % 4}`, X(s.x), groundY);
    // lanterns of residents waiting for their turn
    for (const r of scene.residents) {
      if (!r.glow) continue;
      const x = X(r.x) + (r.facing === -1 ? -1 : 1) * 6;
      drawFrame(P.ctx, atlas, 'fx/glow', x, SIZES.groundY - 8, { alpha: 0.35 + 0.5 * Math.max(lamps, 0.3), scale: 0.9 });
    }
    if (scene.fireflies) {
      const r = rng(hash(scene.seed, 555));
      for (let i = 0; i < scene.fireflies; i++) firefly(P, F.camX + range(r, 0, F.W), range(r, SIZES.groundY - 30, SIZES.groundY + 4), range(r, 0.4, 1) * Math.max(lamps, 0.2));
    }
  }, 'source-over');

  // ---- the alert: flag and bell, double outlined, drawn last among the world so nothing covers them.
  // The bell and the furled flag are always there once the bell post exists.
  drawAlert(F, atlas, scene);

  // ---- weather particles and local shower
  drawWeather(F, atlas, scene);

  // ---- foreground reeds
  drawReedsLayer(F);

  // ---- ambient only: a warm diorama vignette (clear centre, warm-dark edges) for depth and focus
  if (F.view.kind === 'ambient') {
    const g = F.ctx;
    const w = g.canvas.width;
    const h = g.canvas.height;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'multiply';
    const edge = mix(mix(tok('ink'), F.sky.light, 0.55), tok('flame'), 0.12 * F.sky.daylight);
    const rad = g.createRadialGradient(w * 0.5, h * 0.58, Math.min(w, h) * 0.3, w * 0.5, h * 0.58, Math.max(w, h) * 0.75);
    rad.addColorStop(0, css(tok('maskWhite'), 0));
    rad.addColorStop(1, css(edge, 0.42));
    g.fillStyle = rad;
    g.fillRect(0, 0, w, h);
    g.restore();
  }
}

function drawResidentSprite(g: Ctx2D, atlas: Atlas, r: PlacedResident, x: number, y: number): void {
  const pre = r.helper ? 'hlp' : 'res';
  const id = `${pre}/${r.species}/${r.pose}`;
  const flip = r.facing === -1;
  const alpha = r.faded ? 0.55 : 1;
  drawFrame(g, atlas, id, x, y, { flip, alpha });
  // tinted scarf overlay: copy the white overlay to a scratch at atlas resolution, multiply by the scarf colour
  const f = atlas.frames.get(`${id}/scarf`);
  if (!f) return;
  const sc = scarfScratch(f.sw + 2, f.sh + 2);
  const sg = sc.getContext('2d') as Ctx2D;
  const page = atlas.pages[f.page] as CanvasImageSource;
  sg.setTransform(1, 0, 0, 1, 0, 0);
  sg.globalCompositeOperation = 'source-over';
  sg.clearRect(0, 0, sc.width, sc.height);
  sg.drawImage(page, f.sx, f.sy, f.sw, f.sh, 0, 0, f.sw, f.sh);
  sg.globalCompositeOperation = 'multiply';
  sg.fillStyle = css(tok(SCARVES[r.scarf % SCARVES.length]));
  sg.fillRect(0, 0, f.sw, f.sh);
  sg.globalCompositeOperation = 'destination-in';
  sg.drawImage(page, f.sx, f.sy, f.sw, f.sh, 0, 0, f.sw, f.sh);
  sg.globalCompositeOperation = 'source-over';
  drawFrame(g, atlas, `${id}/scarf`, x, y, { flip, alpha, source: sc as CanvasImageSource, sourceAt: [0, 0] });
}

let scarfCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
function scarfScratch(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (!scarfCanvas || scarfCanvas.width < w || scarfCanvas.height < h) {
    scarfCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(Math.max(w, 64), Math.max(h, 64)) : document.createElement('canvas');
    if (!(typeof OffscreenCanvas !== 'undefined')) {
      (scarfCanvas as HTMLCanvasElement).width = Math.max(w, 64);
      (scarfCanvas as HTMLCanvasElement).height = Math.max(h, 64);
    }
  }
  return scarfCanvas;
}

function drawAlert(F: Frame, atlas: Atlas, scene: SceneSpec): void {
  const post = scene.structures.find((s) => s.kind === 'bellpost' || s.kind === 'belltower');
  if (!post) return;
  const a = scene.alert ?? { post: post.kind as 'bellpost' | 'belltower', icon: 'none' as AlertIcon, raised: false, ringing: false };
  if (!post) return;
  const def = STRUCTURES[post.kind];
  if (!def) return;
  const pts = def.points(post.stage);
  const x = mapX(F, post.x);
  const base = SIZES.structureBaseY;
  emissive(F, (P) => {
    const g = P.ctx;
    if (pts.flag) {
      const fx = x + pts.flag[0];
      const fy = base + pts.flag[1];
      if (a.raised) {
        // a soft halo so the flag pops even in a still frame, then the double-outlined flag
        P.glow(fx + 7, fy + 5, 16, mix(tok('alertFlag'), tok('cream'), 0.4), 0.42);
        drawFrame(g, atlas, `alert/flag/${a.icon}/${a.wave ?? 0}`, fx, fy);
      } else drawFrame(g, atlas, 'alert/flag-furled', fx - 1.2, base - 20);
    }
    if (pts.bell && a.ringing) {
      const bx = x + pts.bell[0];
      const by = base + pts.bell[1];
      const swing = a.ringing ? 1 : 0;
      drawFrame(g, atlas, `alert/bell/${swing}`, bx, by);
      if (a.ringing) {
        // comic "ringing" marks either side of the bell, ink with a cream edge
        const rp = P;
        for (const side of [-1, 1]) {
          for (let i = 0; i < 3; i++) {
            const ang = (-0.5 + i * 0.5) * 0.9;
            const r0 = 7.5;
            const r1 = 10.5;
            const cx = bx + side * 0.5;
            const cy = by + 5;
            const p0: [number, number] = [cx + side * Math.cos(ang) * r0, cy + Math.sin(ang) * r0];
            const p1: [number, number] = [cx + side * Math.cos(ang) * r1, cy + Math.sin(ang) * r1];
            rp.line([p0, p1], 1.5, 'cream', { shadow: 0, wobble: 0 });
            rp.line([p0, p1], 0.7, 'ink', { shadow: 0, wobble: 0 });
          }
        }
      }
    }
  });
}

function drawWeather(F: Frame, atlas: Atlas, scene: SceneSpec): void {
  const spec = F.sky.spec;
  const t = scene.t ?? 0;
  const top = F.y0;
  const bottom = F.y1;
  const r = rng(hash(scene.seed, 777));
  const wind = spec.wind;
  if (spec.particles === 'rain' || spec.particles === 'rain-light') {
    emissive(F, (P) => {
      const n = Math.round((F.W * (bottom - top)) / (spec.particles === 'rain' ? 260 : 620));
      for (let i = 0; i < n; i++) {
        const x = F.camX + range(r, -10, F.W + 10);
        const y = range(r, top, bottom) + ((t * 120) % 20);
        rainStroke(P, x, y, range(r, 3.5, 6), 0.12 + wind * 0.25, range(r, 0.25, 0.5));
      }
    });
  }
  if (spec.particles === 'snow') {
    emissive(F, (P) => {
      const n = Math.round((F.W * (bottom - top)) / 140);
      for (let i = 0; i < n; i++) {
        const x = F.camX + range(r, -10, F.W + 10) + Math.sin(i + t) * 2;
        const y = range(r, top, bottom);
        const s = range(r, 0.45, 1.05) * (F.view.kind === 'strip' ? 1 : 0.8);
        snowflake(P, x, y, s, range(r, 0.6, 1));
      }
    });
  }
  if (spec.particles === 'leaves' || (scene.season === 'autumn' && wind > 0.2)) {
    const n = Math.round(F.W / (spec.particles === 'leaves' ? 18 : 90));
    emissive(F, (P) => {
      for (let i = 0; i < n; i++) {
        const x = F.camX + range(r, 0, F.W);
        const y = range(r, top + (bottom - top) * 0.25, SIZES.groundY);
        drawFrame(P.ctx, atlas, `wx/leaf/${i % 2}`, x, y, { rot: range(r, 0, 6.28) });
      }
    });
  }
  // a limit hit: a dark paper cloud and a shower over that provider's workshops
  if (scene.shower) {
    const [a, b] = scene.shower.map((x) => mapX(F, x));
    layer(F, { gap: 1.4, haze: 0, shadowGain: 1 }, (P) => {
      const cy = F.view.kind === 'strip' ? 12 : -16;
      const w = b - a;
      for (let i = 0; i < 4; i++) {
        const cx = a + w * (0.15 + i * 0.24);
        P.piece(ellipse(cx, cy + (i % 2) * 2.2, w * 0.2, 5.2, 24), mix(tok('worrySlate'), tok('stone'), 0.25 + (i % 2) * 0.15), { rim: 1, shadow: 1 });
      }
      P.piece(ellipse(a + w * 0.5, cy + 3.5, w * 0.48, 4.2, 30), 'worrySlate', { rim: 0.6, shadow: 1 });
    });
    emissive(F, (P) => {
      const r2 = rng(hash(scene.seed, 778));
      for (let i = 0; i < (b - a) * 0.9; i++) {
        const x = range(r2, a + 2, b - 2);
        const y = range(r2, F.view.kind === 'strip' ? 18 : -10, SIZES.groundY + 6);
        rainStroke(P, x, y, range(r2, 3.5, 5.5), 0.1, range(r2, 0.35, 0.6));
      }
    });
  }
}

export { LAND, SPECIES_DEFS, structureBounds, Paper };
