/**
 * Gallery page (world/art/gallery.html): every structure stage, every species pose, the sky at 8 times
 * of day, each weather, the 10 golden scenes (strip 1440 x 120, strip 2560 x 160, ambient), plus
 * render hooks for tools/render-goldens.mjs (?list=1 and ?golden=<id>&view=<name>).
 */
import { PAL, SIZES, SCARVES, type Token } from './tokens.ts';
import { css, tok } from './color.ts';
import { buildAtlas, type Atlas } from './atlas.ts';
import { stripSprites } from './sprites.ts';
import { renderScene, type SceneSpec } from './scene.ts';
import { GOLDENS, GOLDEN_VIEWS } from './goldens.ts';
import { STRUCTURES, type Stage } from './structures.ts';
import { SPECIES, STATE_POSES, STATE_POSE_KEY, posesFor, drawResident, type Species } from './residents.ts';
import { TIMES_OF_DAY, WEATHERS, type Weather } from './sky.ts';
import { Paper } from './paper.ts';
import type { View } from './compose.ts';
import type { Season } from './terrain.ts';

declare global {
  interface Window {
    __goldenList: unknown;
    __goldenReady: boolean;
    __renderMs: Record<string, number>;
  }
}

const q = new URLSearchParams(location.search);
const atlasCache = new Map<string, Atlas>();

function atlasFor(scale: number, season: Season): Atlas {
  const key = `${scale.toFixed(4)}:${season}`;
  let a = atlasCache.get(key);
  if (!a) {
    a = buildAtlas(stripSprites(season), scale);
    atlasCache.set(key, a);
  }
  return a;
}

function viewScale(view: View): number {
  return view.kind === 'strip' ? (view.height / SIZES.stripHeight) * view.dpr : SIZES.ambientWorldScale * (view.height / 1080) * view.dpr;
}

function sceneCanvas(scene: SceneSpec, view: View): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const t0 = performance.now();
  renderScene(c, scene, view, atlasFor(viewScale(view), scene.season));
  (window.__renderMs ??= {})[`${scene.id}:${view.kind}:${view.width}`] = performance.now() - t0;
  return c;
}

/** Views rendered for each golden: the three required, plus the needs-you strip at 1x device scale. */
function viewsFor(id: string) {
  const v = GOLDEN_VIEWS.map((x) => ({ ...x }));
  if (id === 'G02' || id === 'G09') v.push({ name: 'strip1440-1x', width: 1440, height: 120, dpr: 1 });
  return v;
}

function styleRoot(): void {
  const r = document.documentElement.style;
  r.setProperty('--page', PAL.uiPage);
  r.setProperty('--panel', PAL.uiPanel);
  r.setProperty('--text', PAL.uiText);
  r.setProperty('--muted', PAL.uiMuted);
  r.setProperty('--desk-top', PAL.desktopTop);
  r.setProperty('--desk-bottom', PAL.desktopBottom);
}

// ---------------------------------------------------------------- golden render hooks

if (q.get('list') === '1') {
  window.__goldenList = GOLDENS.map((g) => ({ id: g.id, title: g.title, views: viewsFor(g.id) }));
  window.__goldenReady = true;
} else if (q.get('golden')) {
  styleRoot();
  document.body.className = 'bare';
  const g = GOLDENS.find((x) => x.id === q.get('golden'));
  const vdef = g && viewsFor(g.id).find((v) => v.name === q.get('view'));
  if (!g || !vdef) throw new Error(`unknown golden/view ${q.get('golden')} ${q.get('view')}`);
  const view: View = { kind: vdef.name.startsWith('ambient') ? 'ambient' : 'strip', width: vdef.width, height: vdef.height, dpr: devicePixelRatio };
  const c = sceneCanvas(g, view);
  c.style.width = `${vdef.width}px`;
  c.style.height = `${vdef.height}px`;
  c.style.display = 'block';
  document.body.appendChild(c);
  window.__goldenReady = true;
} else {
  styleRoot();
  buildGallery();
  window.__goldenReady = true;
}

// ---------------------------------------------------------------- full gallery

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function section(title: string, blurb: string): HTMLElement {
  const s = el('section');
  s.appendChild(el('h2', '', title));
  if (blurb) s.appendChild(el('p', 'blurb', blurb));
  document.querySelector('main')!.appendChild(s);
  return s;
}

function fit(c: HTMLCanvasElement, cssW: number): HTMLCanvasElement {
  c.style.width = `${cssW}px`;
  c.style.height = `${(cssW * c.height) / c.width}px`;
  return c;
}

function figure(parent: HTMLElement, c: HTMLCanvasElement, caption: string): void {
  const f = el('figure');
  f.appendChild(c);
  f.appendChild(el('figcaption', '', caption));
  parent.appendChild(f);
}

function buildGallery(): void {
  const main = document.querySelector('main')!;
  void main;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const page = Math.min(1400, document.documentElement.clientWidth - 48);

  // goldens first: they are the point
  const gs = section('10 golden scenes', 'Each scene as the full strip at 1440 x 120 and 2560 x 160 (scaled to fit), and as the ambient full-screen view. Captions say which row of the SPEC 4.3 state table each one shows.');
  for (const g of GOLDENS) {
    const box = el('div', 'golden');
    box.appendChild(el('h3', '', `${g.id}  ${g.title}`));
    box.appendChild(el('p', 'blurb', g.note));
    figure(box, fit(sceneCanvas(g, { kind: 'strip', width: 1440, height: 120, dpr }), page), 'strip 1440 x 120');
    figure(box, fit(sceneCanvas(g, { kind: 'strip', width: 2560, height: 160, dpr }), page), 'strip 2560 x 160');
    figure(box, fit(sceneCanvas(g, { kind: 'ambient', width: 1920, height: 1080, dpr: 1 }), Math.min(page, 960)), 'ambient 1920 x 1080 (world scale 3)');
    gs.appendChild(box);
  }

  // sky at 8 times of day
  const ss = section('Sky at 8 times of day', 'The sky lookup table: 5 SPEC keyframes plus a derived morning, interpolated in OKLab. Light tint, haze, sun and moon, lamps and stars all come from the same sample.');
  const base = GOLDENS[3];
  for (const tday of TIMES_OF_DAY) {
    figure(ss, fit(sceneCanvas({ ...base, id: `sky-${tday.name}`, phase: tday.phase, weather: 'clear', residents: [], alert: undefined }, { kind: 'strip', width: 1440, height: 112, dpr }), page), `${tday.name} (phase ${tday.phase})`);
  }

  // weather
  const ws = section('Weather', 'Every weather state at mid-morning (snow in winter). Clouds track the weekly window; rain is short ink strokes; mist is a low paper band over the river.');
  for (const w of WEATHERS) {
    const season: Season = w === 'snow' ? 'winter' : 'autumn';
    figure(ws, fit(sceneCanvas({ ...base, id: `wx-${w}`, phase: 0.3, weather: w as Weather, season, residents: [], alert: undefined }, { kind: 'strip', width: 1440, height: 112, dpr }), page), w);
  }

  // structures
  const st = section('Structures: 3 growth stages', 'Stage 1 staked out, stage 2 framed, stage 3 finished. Autumn on the left half, winter with lit windows on the right half.');
  st.appendChild(structureTable(4));

  // residents
  const rs = section('Residents: every pose', 'Paper puppets. Rows are species (Claude Code beaver, Codex otter, OpenCode frog, Antigravity hare, other hedgehog); the scarf is the instance colour. The first 8 columns are the state poses the silhouette test compares.');
  rs.appendChild(residentTable(4));
}

function structureTable(scale: number): HTMLCanvasElement {
  const kinds = Object.values(STRUCTURES).filter(Boolean);
  const cw = 92;
  const ch = 96;
  const c = document.createElement('canvas');
  c.width = cw * 6 * scale;
  c.height = ch * kinds.length * scale;
  const g = c.getContext('2d')!;
  g.fillStyle = css(tok('skyDayHorizon'));
  g.fillRect(0, 0, c.width / 2, c.height);
  g.fillStyle = css(tok('skyNightHorizon'));
  g.fillRect(c.width / 2, 0, c.width / 2, c.height);
  kinds.forEach((def, row) => {
    for (const season of ['autumn', 'winter'] as Season[]) {
      for (let st = 1; st <= 3; st++) {
        if (def!.stages === 1 && st > 1) continue;
        const col = (season === 'winter' ? 3 : 0) + st - 1;
        const ox = (col * cw + cw / 2) * scale;
        const oy = (row * ch + ch - 22) * scale;
        g.setTransform(scale, 0, 0, scale, ox, oy);
        // ground line
        g.fillStyle = css(tok(season === 'winter' ? 'snow' : 'meadow'));
        g.fillRect(-cw / 2, 0, cw, 3);
        // draw the cell on a transparent scratch so paper grain stays on the paper
        const cell = document.createElement('canvas');
        cell.width = cw * scale;
        cell.height = ch * scale;
        const cg = cell.getContext('2d')!;
        cg.setTransform(scale, 0, 0, scale, (cw / 2) * scale, (ch - 22) * scale);
        const P = new Paper(cg, scale, 55 + row);
        def!.draw(P, st as Stage, { season, seed: 9 + row });
        if (def!.part && st === 3) {
          const pv = def!.points(3).pivot;
          if (pv) P.at(pv[0], pv[1], 0.3, () => def!.part!.draw(P, { season, seed: 3 }));
        }
        if (season === 'winter' && def!.lit) def!.lit(P, st as Stage, { season, seed: 9 + row, frame: 0 });
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.drawImage(cell, ox - (cw / 2) * scale, oy - (ch - 22) * scale);
      }
    }
  });
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = PAL.ink;
  g.font = `${8 * scale}px ${'-apple-system, system-ui, sans-serif'}`;
  kinds.forEach((def, row) => g.fillText(def!.name, 6 * scale, (row * ch + 14) * scale));
  return fit(c, Math.min(1400, document.documentElement.clientWidth - 48));
}

function residentTable(scale: number): HTMLCanvasElement {
  const keys = [...STATE_POSES.map((p) => STATE_POSE_KEY[p]), ...Object.keys(posesFor('beaver')).filter((k) => !Object.values(STATE_POSE_KEY).includes(k))];
  const cw = 46;
  const ch = 54;
  const c = document.createElement('canvas');
  c.width = cw * keys.length * scale;
  c.height = (ch * SPECIES.length + 12) * scale;
  const g = c.getContext('2d')!;
  g.fillStyle = css(tok('meadowLight'));
  g.fillRect(0, 0, c.width, c.height);
  SPECIES.forEach((sp: Species, row) => {
    keys.forEach((k, col) => {
      const pose = posesFor(sp)[k];
      // draw on a transparent cell, tint the scarf overlay in a per-row instance colour, then composite
      const cell = document.createElement('canvas');
      cell.width = cw * scale;
      cell.height = ch * scale;
      const cg = cell.getContext('2d')!;
      cg.setTransform(scale, 0, 0, scale, (cw / 2) * scale, (ch - 6) * scale);
      drawResident(new Paper(cg, scale, 101), sp, pose, 'base');
      const ov = document.createElement('canvas');
      ov.width = cell.width;
      ov.height = cell.height;
      const og = ov.getContext('2d')!;
      og.setTransform(scale, 0, 0, scale, (cw / 2) * scale, (ch - 6) * scale);
      drawResident(new Paper(og, scale, 101), sp, pose, 'scarf');
      og.setTransform(1, 0, 0, 1, 0, 0);
      og.globalCompositeOperation = 'source-in';
      og.fillStyle = PAL[SCARVES[row % SCARVES.length]];
      og.fillRect(0, 0, ov.width, ov.height);
      cg.setTransform(1, 0, 0, 1, 0, 0);
      cg.globalCompositeOperation = 'multiply';
      cg.drawImage(ov, 0, 0);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(cell, col * cw * scale, (12 + row * ch) * scale);
    });
  });
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = PAL.ink;
  g.font = `${7 * scale}px -apple-system, system-ui, sans-serif`;
  keys.forEach((k, col) => g.fillText(col < 8 ? `${STATE_POSES[col]}` : k, (col * cw + 2) * scale, 8 * scale));
  return fit(c, Math.min(1400, document.documentElement.clientWidth - 48) * 2.2);
}

export type { Token };
