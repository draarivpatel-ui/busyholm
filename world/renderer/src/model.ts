/**
 * The world model: everything that moves, as a pure function of the inputs and the clock.
 *
 * Inputs (Snapshot v2, Moment v1, World v1) are applied synchronously, so the very next tick
 * shows them (WP-10 test 1). Each tick, step(t) advances residents, alerts, effects, sky and the
 * ambient camera, and returns a display list the view draws. Nothing here touches a canvas.
 *
 * Motion rules (SPEC 3.5 and 4.3):
 * - characters change pose and position on 12 fps steps (stop-motion cutout); particles, the sky
 *   and the camera move smoothly;
 * - a needs_you Moment raises the flag and rings the bell on the next frame; the resident then
 *   freezes and turns to camera for 150 ms, runs to the bell post (about 600 ms), rings for about
 *   1.2 s and waits with one gentle bob every 8 s;
 * - a finished turn is a 1.2 s hop and cheer with confetti while a plank arcs to the build site;
 *   a stage completing gives a dust puff, and a finished mill starts turning;
 * - reduced motion: no walking, loops, particles or camera; residents hold their state pose in
 *   place and the flag still goes up.
 */
import type { AgentState, Moment, NeedsYouReason, Snapshot, SnapshotAgent, StructureId, Tool, World } from '../../../contracts/ts/src/types.ts';
import type { Species } from '../../art/src/residents.ts';
import { SPECIES_DEFS } from '../../art/src/residents.ts';
import { SPECIES_BY_TOOL } from '../../art/src/worldmap.ts';
import type { Weather } from '../../art/src/sky.ts';
import type { Season } from '../../art/src/terrain.ts';
import { sampleSky } from '../../art/src/sky.ts';
import { hash } from '../../art/src/rng.ts';
import { STRUCTURES, type Stage } from '../../art/src/structures.ts';
import type { Anim, FlagIcon, Intent, LiveSettings, Surface } from './api.ts';
import { buildLayout, campSpot, nearestTree, CANON_W, type Layout, type Placed } from './layout.ts';
import { LOOPS, WORK, STEP, quantize, poseAt, onceAt, loopLength, runSpeed, WALK_SPEED, ease, type Loop } from './motion.ts';
import { skyPhase, weatherFor, seasonFor, lerpPhase } from './environment.ts';

export const MAX_PER_TOOL = 4;
const JOG_SPEED = 85;
const MAX_HELPERS = 2;
/** ambient camera: units of clear space kept left and right of the bell post while an alert is raised */
const BELL_MARGIN_L = 30;
const BELL_MARGIN_R = 50;
/** a resident is drawn about this far either side of its x; an edge inside it slices the resident */
const SLICE_HALF = 12;
/** units per second an edge crosses a resident during the ambient pan */
const CROSS_SPEED = 100;

/** Only placed scenery affects static planes. Ledger counts and within-stage progress do not. */
function sceneryKey(l: Layout): string {
  return JSON.stringify([
    l.seed,
    l.structures.map((s) => [s.id, s.kind, s.stage, s.sprite, s.x, s.status, s.tool]),
    l.bell, l.trees, l.decorations,
  ]);
}

export interface ModelOptions {
  surface: Surface;
  seed: number;
  reducedMotion: boolean;
  species: Partial<Record<Tool, Species | string>>;
  hemisphere: 'north' | 'south';
  skyMode: 'usage_and_clock' | 'clock_only';
  /** wall clock for the sky, season and night routine */
  date: () => Date;
  /** ambient camera: visible width in canonical units, pan speed in units per second */
  ambientView?: { visibleW: number; panSpeed: number; startX?: number };
  /** device pixels per unit (cloud drift is stepped one device pixel at a time) */
  pxPerUnit: number;
}

export interface ResDraw {
  id: string;
  tool: Tool;
  species: Species;
  pose: string;
  scarf: number;
  x: number;
  dy: number;
  facing: 1 | -1;
  helper: boolean;
  faded: boolean;
  glow: boolean;
  intent: Intent;
  anim: Anim;
  variant?: string;
  alpha: number;
}

export interface Particle {
  x: number;
  y: number;
  rot: number;
  color: number;
  alpha: number;
  w: number;
  h: number;
}

export interface DisplayList {
  /** renderer time, seconds */
  t: number;
  sky: { phase: number; weather: Weather; season: Season; lamps: number };
  layout: Layout;
  /** layout version: bumps when structures, stages or dark windows change (static planes rebuild) */
  layoutKey: string;
  /** structure ids whose windows are dark */
  dark: Set<StructureId>;
  residents: ResDraw[];
  flag: { raised: boolean; icon: FlagIcon; ringing: boolean; swing: -1 | 0 | 1; wave: number; rise: number };
  bellVisible: boolean;
  /** rotating parts: structure id to angle (radians) */
  parts: Map<StructureId, number>;
  /** chimneys smoking: structure ids */
  smoke: StructureId[];
  planks: { x: number; y: number; rot: number }[];
  dust: { x: number; scale: number; alpha: number; dy: number }[];
  confetti: Particle[];
  showers: [number, number][];
  /** "+N" signs over workshops */
  extras: { x: number; y: number; n: number }[];
  /** ambient camera left edge in canonical units */
  camX: number;
  cameraMoving: boolean;
  fx: string[];
  /** cloud drift in units, stepped one device pixel at a time */
  clouds: number;
  /** weather particle step (rain, snow, leaves, fireflies); -1 when there are none */
  particleStep: number;
  fireflies: boolean;
  /** something steps on its own and will change again */
  animating: boolean;
}

interface AlertRec {
  agent: string;
  tool: Tool;
  reason: NeedsYouReason;
  /** collector time the agent started waiting (Snapshot agent since, or the Moment's t) */
  since: number;
  /** collector time of the moment or snapshot that raised it */
  t: number;
  /** renderer time it was raised */
  at: number;
}

interface Res {
  id: string;
  tool: Tool;
  species: Species;
  scarf: number;
  ordinal: number;
  parent: string | null;
  helper: boolean;
  state: AgentState;
  activity?: string;
  reason?: NeedsYouReason;
  x: number;
  facing: 1 | -1;
  overlay: { kind: 'turn' | 'cheer' | 'stretch'; at: number; dur: number } | null;
  move: { mode: 'walk' | 'run'; speed: number; traveled: number; at: number } | null;
  loopKey: string;
  loopAt: number;
  arrivedAt: number | null;
  u: number;
  tempo: number;
  leaving: boolean;
  gone: boolean;
  removeAt: number | null;
  /** collector time of the last answered/error moment for this agent */
  answeredT: number;
  errorT: number;
  /** shown on the strip (at most 4 per tool) */
  visible: boolean;
  lastIntent: Intent | null;
  lastAnim: Anim;
  lastPose: string;
  lastX: number;
}

const SCARF_COUNT = 6;

function u01(seed: number, salt: number): number {
  return (hash(seed, salt) % 100000) / 100000;
}

function idSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

export class WorldModel {
  readonly opts: ModelOptions;
  private layout: Layout;
  private world: World | null = null;
  private snap: Snapshot | null = null;
  private res = new Map<string, Res>();
  private alerts = new Map<string, AlertRec>();
  private flagRaisedAt: number | null = null;
  private ringStart = -99;
  private stageOverride = new Map<StructureId, Stage>();
  private holds = new Map<StructureId, Stage>();
  private pendingBuild: { structure: StructureId; stage: Stage; at: number }[] = [];
  private planks: { x0: number; x1: number; at: number; dur: number; to: StructureId | null; landed: boolean }[] = [];
  private dusts: { x: number; at: number; dur: number; big: boolean }[] = [];
  private confettiBursts: { x: number; at: number; seed: number }[] = [];
  private spin = new Map<StructureId, { at: number }>();
  private showerUntil = new Map<Tool, number>();
  private rainbowUntil = -1;
  private sky: { from: number; to: number; at: number; dur: number; weather: Weather } | null = null;
  private sunriseUntil = -1;
  private cam = { x: 0, dir: 1, vx: 0 };
  private lastT = 0;
  private lastTRaw = 0;
  private initialized = false;
  private layoutVersion = 0;
  lastInputAt = 0;
  private reduced: boolean;

  constructor(opts: ModelOptions) {
    this.opts = opts;
    this.reduced = opts.reducedMotion;
    this.layout = buildLayout(null, opts.seed);
    if (opts.ambientView) this.cam.x = opts.ambientView.startX ?? -1;
  }

  setReduced(on: boolean): void {
    this.reduced = on;
  }

  /** Settings that can change while the page runs. The sky follows through targetSky(); residents change species now. */
  setSettings(s: LiveSettings): void {
    if (s.hemisphere) this.opts.hemisphere = s.hemisphere;
    if (s.skyMode) this.opts.skyMode = s.skyMode;
    if (s.species) {
      this.opts.species = s.species;
      for (const r of this.res.values()) r.species = this.speciesFor(r.tool);
    }
  }

  // ------------------------------------------------------------------ inputs

  setWorld(w: World, t: number): void {
    // a structure a plank is still flying to keeps its old stage until the plank lands
    for (const p of this.planks) {
      if (p.landed || !p.to) continue;
      const shown = this.layout.byId.get(p.to)?.stage ?? 0;
      const next = w.structures.find((s) => s.id === p.to);
      if (next && next.stage > shown && !this.holds.has(p.to)) this.holds.set(p.to, shown as Stage);
    }
    this.world = w;
    for (const s of w.structures) {
      const o = this.stageOverride.get(s.id);
      if (o !== undefined && s.stage >= o) this.stageOverride.delete(s.id);
    }
    if (this.rebuildLayout()) this.lastInputAt = t;
  }

  private rebuildLayout(): boolean {
    const base = buildLayout(this.world, this.opts.seed);
    // stage overrides from build_complete moments that arrived before the World caught up
    if (this.stageOverride.size) {
      for (const p of base.structures) {
        const o = this.stageOverride.get(p.id);
        if (o !== undefined && o > p.stage) {
          p.stage = o;
          p.pts = p.def.points(o);
          p.sprite = p.kind === 'cottage' && p.id === 'cottage_2' && o === 3 ? 'st/cottage/3/v1' : `st/${p.kind}/${o}`;
          if (o === 3) p.status = 'complete';
        }
      }
      if (base.site && base.site.status === 'complete') base.site = base.structures.find((s) => s.status === 'building') ?? null;
    }
    for (const p of base.structures) {
      const h = this.holds.get(p.id);
      if (h !== undefined && h < p.stage) {
        p.stage = h;
        p.pts = p.def.points(h);
        p.sprite = `st/${p.kind}/${h}`;
        p.status = 'building';
        if (!base.site) base.site = p;
      }
    }
    const changed = sceneryKey(base) !== sceneryKey(this.layout);
    this.layout = base;
    if (changed) this.layoutVersion++;
    return changed;
  }

  setSnapshot(s: Snapshot, t: number): void {
    this.snap = s;
    this.lastInputAt = t;
    const seen = new Set<string>();
    for (const a of s.agents) {
      seen.add(a.id);
      let r = this.res.get(a.id);
      if (!r) {
        r = this.spawn(a.id, a.tool, a.parent, a.ordinal, t);
        this.res.set(a.id, r);
        if (this.initialized && !this.reduced && a.state !== 'needs_you') {
          // a new session steps out of its workshop door
          r.x = this.doorX(r);
        }
      }
      r.leaving = false;
      r.removeAt = null;
      r.parent = a.parent;
      r.helper = a.parent !== null;
      this.applyAgentState(r, a, s.t, t);
    }
    // collector truth first: drop alerts this (newer) snapshot shows answered, ended or gone, so that a
    // waiting resident who vanished is planned as leaving below instead of standing at the bell for good
    for (const [id, al] of this.alerts) {
      const a = s.agents.find((x) => x.id === id);
      if (s.t >= al.t && (!a || a.state !== 'needs_you')) {
        this.alerts.delete(id);
        const r = this.res.get(id);
        if (r && !a && r.state === 'needs_you') r.state = 'idle';
      }
    }
    for (const r of this.res.values()) {
      if (!seen.has(r.id) && !r.leaving && !this.alerts.has(r.id)) {
        r.leaving = true;
        r.removeAt = t + 14;
      }
    }
    // alerts from the snapshot: add waiting agents the snapshot shows as waiting after their last answer
    for (const a of s.agents) {
      const r = this.res.get(a.id)!;
      if (a.state === 'needs_you' && s.t > r.answeredT) {
        if (!this.alerts.has(a.id)) this.raise({ agent: a.id, tool: a.tool, reason: a.reason ?? 'permission', since: a.since, t: s.t, at: t });
      }
    }
    // limited residents bring a shower over their provider's workshops
    for (const a of s.agents) if (a.state === 'limited') this.showerUntil.set(a.tool, Math.max(this.showerUntil.get(a.tool) ?? 0, t + 1));
    this.assignSlots();
    if (!this.initialized) {
      this.initialized = true;
      for (const r of this.res.values()) this.placeAtSpot(r, t);
    }
  }

  pushMoment(m: Moment, t: number): void {
    this.lastInputAt = t;
    switch (m.kind) {
      case 'needs_you': {
        let r = this.res.get(m.agent);
        if (!r) {
          // the moment beat the snapshot: show the resident at its workshop and run from there
          r = this.spawn(m.agent, m.tool, null, 1, t);
          r.state = 'needs_you';
          this.res.set(m.agent, r);
          this.assignSlots();
          this.placeAtSpot(r, t, 'work');
        }
        r.answeredT = Math.min(r.answeredT, m.t - 1);
        r.reason = m.reason;
        r.state = 'needs_you';
        this.raise({ agent: m.agent, tool: m.tool, reason: m.reason, since: m.t, t: m.t, at: t });
        break;
      }
      case 'answered': {
        this.alerts.delete(m.agent);
        const r = this.res.get(m.agent);
        if (r) {
          r.answeredT = m.t;
          if (r.state === 'needs_you') r.state = 'working';
        }
        break;
      }
      case 'turn_end': {
        this.endWait(m.agent, m.t);
        const r = this.res.get(m.agent);
        if (r && !this.reduced) {
          r.overlay = { kind: 'cheer', at: quantize(t), dur: loopLength(LOOPS.cheer) };
          r.move = null;
          this.confettiBursts.push({ x: r.x, at: t + 0.05, seed: idSeed(m.agent) ^ Math.floor(t * 1000) });
        }
        const from = r ? r.x : this.workshopX(m.tool);
        const site = this.layout.site;
        const to = site ? site.x : this.workshopX(m.tool);
        const dist = Math.abs(to - from);
        this.planks.push({ x0: from, x1: to, at: t + (this.reduced ? 0 : 0.3), dur: this.reduced ? 0 : 0.85 + Math.min(0.6, dist / 900), to: site?.id ?? null, landed: false });
        if (r) r.state = 'your_turn';
        break;
      }
      case 'error': {
        this.endWait(m.agent, m.t);
        const r = this.res.get(m.agent);
        if (r) {
          r.errorT = m.t;
          r.state = 'error';
        }
        break;
      }
      case 'recovered':
        break;
      case 'limit_hit':
        this.showerUntil.set(m.provider, t + 600);
        break;
      case 'limit_reset':
        this.showerUntil.delete(m.provider);
        this.sunriseUntil = t + 4;
        if (!this.reduced) for (const r of this.res.values()) if (r.state !== 'needs_you' && !r.helper) r.overlay = { kind: 'stretch', at: t + 0.4 + r.u * 0.8, dur: loopLength(LOOPS.stretch) };
        break;
      case 'weekly_reset':
        this.rainbowUntil = t + 3600;
        break;
      case 'build_complete': {
        const inFlight = this.planks.find((p) => !p.landed && p.to === m.structure);
        if (inFlight) this.pendingBuild.push({ structure: m.structure, stage: m.stage as Stage, at: t });
        else this.completeStage(m.structure, m.stage as Stage, t);
        break;
      }
      case 'milestone': {
        const x = this.layout.byId.get('noticeboard')?.x ?? this.layout.bell.x;
        if (!this.reduced) this.confettiBursts.push({ x, at: t, seed: idSeed(m.milestone) });
        break;
      }
    }
  }

  /** Agents waiting on the user, oldest first (for the ambient card and tests). Ids, tools and times only. */
  waiting(): { id: string; tool: Tool; species: Species; scarf: number; ordinal: number; reason: NeedsYouReason; since: number }[] {
    return [...this.alerts.values()]
      .sort((a, b) => a.since - b.since || (a.agent < b.agent ? -1 : 1))
      .map((al) => {
        const r = this.res.get(al.agent);
        return { id: al.agent, tool: al.tool, species: r?.species ?? this.speciesFor(al.tool), scarf: r?.scarf ?? 0, ordinal: r?.ordinal ?? 1, reason: al.reason, since: al.since };
      });
  }

  /** A terminal moment (error, turn end) closes the wait now; an older one than the alert cannot. */
  private endWait(agent: string, t: number): void {
    const al = this.alerts.get(agent);
    if (al && t >= al.t) {
      this.alerts.delete(agent);
      // a snapshot older than this moment must not raise the alert again
      const r = this.res.get(agent);
      if (r) r.answeredT = Math.max(r.answeredT, t);
    }
  }

  private raise(al: AlertRec): void {
    const fresh = !this.alerts.has(al.agent);
    const prev = this.alerts.get(al.agent);
    if (prev) al.since = Math.min(prev.since, al.since);
    this.alerts.set(al.agent, al);
    if (fresh) {
      if (this.flagRaisedAt === null || this.alerts.size === 1) this.flagRaisedAt = al.at;
      this.ringStart = al.at;
      const r = this.res.get(al.agent);
      if (r && !this.reduced) {
        r.overlay = { kind: 'turn', at: quantize(al.at), dur: 0.15 };
        r.move = null;
        r.arrivedAt = null;
      }
    }
  }

  private completeStage(id: StructureId, stage: Stage, t: number): void {
    this.stageOverride.set(id, stage);
    this.rebuildLayout();
    const p = this.layout.byId.get(id);
    const x = p?.x ?? CANON_W / 2;
    this.dusts.push({ x, at: t, dur: 1.1, big: true });
    if (p && stage === 3 && p.def.part) this.spin.set(id, { at: t });
  }

  // ------------------------------------------------------------------ residents

  private speciesFor(tool: Tool): Species {
    const o = this.opts.species[tool];
    const s = (o ?? SPECIES_BY_TOOL[tool]) as string;
    return (s in SPECIES_DEFS ? s : 'hedgehog') as Species;
  }

  private spawn(id: string, tool: Tool, parent: string | null, ordinal: number, t: number): Res {
    const seed = idSeed(id);
    return {
      id,
      tool,
      species: this.speciesFor(tool),
      scarf: (ordinal - 1) % SCARF_COUNT,
      ordinal,
      parent,
      helper: parent !== null,
      state: 'idle',
      x: this.workshopX(tool),
      facing: u01(seed, 3) < 0.5 ? 1 : -1,
      overlay: null,
      move: null,
      loopKey: '',
      loopAt: t,
      arrivedAt: null,
      u: u01(seed, 1),
      tempo: 0.9 + 0.2 * u01(seed, 2),
      leaving: false,
      gone: false,
      removeAt: null,
      answeredT: -Infinity,
      errorT: -Infinity,
      visible: true,
      lastIntent: null,
      lastAnim: 'stand',
      lastPose: 'stand-0',
      lastX: 0,
    };
  }

  private applyAgentState(r: Res, a: SnapshotAgent, snapT: number, t: number): void {
    let state = a.state;
    if (state === 'needs_you' && snapT <= r.answeredT) state = 'working';
    if (state !== 'error' && r.state === 'error' && snapT <= r.errorT) state = 'error';
    const was = r.state;
    r.state = state;
    r.activity = a.activity;
    r.reason = a.reason;
    r.ordinal = a.ordinal;
    r.scarf = (a.ordinal - 1) % SCARF_COUNT;
    if (state === 'starting' && was !== 'starting' && this.initialized && !this.reduced) {
      r.x = this.doorX(r);
      r.overlay = { kind: 'stretch', at: quantize(t), dur: loopLength(LOOPS.stretch) };
    }
  }

  private assignSlots(): void {
    const byTool = new Map<Tool, Res[]>();
    for (const r of this.res.values()) {
      if (r.helper) continue;
      const list = byTool.get(r.tool) ?? [];
      list.push(r);
      byTool.set(r.tool, list);
    }
    for (const list of byTool.values()) {
      list.sort((a, b) => Number(b.state === 'needs_you') - Number(a.state === 'needs_you') || a.ordinal - b.ordinal || (a.id < b.id ? -1 : 1));
      list.forEach((r, i) => (r.visible = i < MAX_PER_TOOL));
    }
    const helpers = new Map<string, number>();
    for (const r of this.res.values()) {
      if (!r.helper) continue;
      const parent = r.parent ? this.res.get(r.parent) : undefined;
      const k = helpers.get(r.parent ?? '') ?? 0;
      helpers.set(r.parent ?? '', k + 1);
      r.visible = !!parent && parent.visible && k < MAX_HELPERS;
    }
  }

  private slotIndex(r: Res): number {
    let k = 0;
    for (const o of this.res.values()) if (o !== r && !o.helper && o.tool === r.tool && o.visible && (o.ordinal < r.ordinal || (o.ordinal === r.ordinal && o.id < r.id))) k++;
    return k;
  }

  private workshopX(tool: Tool): number {
    const ws = this.layout.workshop.get(tool);
    return ws ? ws.x + (ws.pts.work?.[0] ?? 0) : campSpot(this.layout);
  }

  private doorX(r: Res): number {
    const ws = this.layout.workshop.get(r.tool);
    if (ws?.pts.door) return ws.x + ws.pts.door[0];
    const tent = this.layout.byId.get('tent');
    return tent ? tent.x : campSpot(this.layout);
  }

  private localHours(): number {
    const d = this.opts.date();
    return d.getHours() + d.getMinutes() / 60;
  }

  /** Where the resident wants to be and what it does there. */
  private plan(r: Res, t: number): { intent: Intent; x: number; dy: number; facing: 1 | -1; loop: Loop; key: string; anim: Anim; variant?: string; run: boolean; glow: boolean } {
    const L = this.layout;
    const k = this.slotIndex(r);
    const ws = L.workshop.get(r.tool);
    const spread = [0, 16, -15, 31][k] ?? k * 14;
    const home = ws ? ws.x + (ws.pts.work?.[0] ?? 0) : campSpot(L) + k * 14;
    const faceWs = (x: number): 1 | -1 => (ws ? (ws.x >= x ? 1 : -1) : 1);
    const workX = home + (ws && (ws.pts.work?.[0] ?? 0) < 0 ? -spread : spread);

    if (r.helper) {
      const p = r.parent ? this.res.get(r.parent) : undefined;
      const hk = [...this.res.values()].filter((o) => o.helper && o.parent === r.parent && o.id < r.id).length;
      const px = p ? p.x : workX;
      const pf = p ? p.facing : 1;
      const parentWorks = !!p && p.state === 'working';
      return { intent: 'helper', x: px - pf * (11 + hk * 8), dy: 0, facing: pf, loop: parentWorks ? LOOPS.helperWork : LOOPS.helperIdle, key: parentWorks ? 'hw' : 'hi', anim: parentWorks ? 'work' : 'follow', run: p?.move?.mode === 'run', glow: false };
    }

    if (r.leaving) {
      return { intent: 'leaving', x: this.doorX(r), dy: 0, facing: 1, loop: LOOPS.stand, key: 'leave', anim: 'stand', run: false, glow: false };
    }

    if (this.alerts.has(r.id) || r.state === 'needs_you') {
      const waiting = [...this.alerts.values()].sort((a, b) => a.at - b.at || (a.agent < b.agent ? -1 : 1));
      const q = Math.max(0, waiting.findIndex((a) => a.agent === r.id));
      const spot = L.bell.rope - q * 13;
      const arrived = r.arrivedAt;
      const ringing = arrived !== null && t - arrived < 1.25;
      return { intent: 'alert', x: spot, dy: 0, facing: 1, loop: ringing ? LOOPS.ring : LOOPS.waitBell, key: ringing ? 'ring' : 'wait', anim: ringing ? 'ring' : 'wait-bell', run: true, glow: false };
    }

    switch (r.state) {
      case 'starting':
        return { intent: 'starting', x: this.doorX(r), dy: 0, facing: faceWs(this.doorX(r)) === 1 ? -1 : 1, loop: LOOPS.stand, key: 'start', anim: 'stand', run: false, glow: false };
      case 'working': {
        const v = r.activity ?? 'other';
        let x = workX;
        let dy = 0;
        let facing = faceWs(workX);
        if (v === 'read') {
          const nb = L.byId.get('noticeboard');
          if (nb) {
            x = nb.x + (nb.pts.work?.[0] ?? -14) - k * 9;
            facing = 1;
          }
        } else if (v === 'web') {
          const cr = L.byId.get('crossing');
          if (cr && cr.stage >= 2) {
            x = cr.x + (cr.pts.work?.[0] ?? 0) + k * 7;
            dy = cr.pts.work?.[1] ?? 0;
            facing = r.u < 0.5 ? 1 : -1;
          }
        }
        const loop = WORK[v] ?? WORK.other;
        return { intent: 'work', x, dy, facing, loop, key: 'work:' + v, anim: 'work', variant: v, run: false, glow: false };
      }
      case 'your_turn': {
        const door = this.doorX(r) + (k - 1.5) * 9 + 8;
        return { intent: 'your_turn', x: door, dy: 0, facing: door < CANON_W / 2 ? 1 : -1, loop: LOOPS.yourTurn, key: 'yt', anim: 'sit-lantern', run: false, glow: true };
      }
      case 'error':
        return { intent: 'worried', x: workX, dy: 0, facing: faceWs(workX), loop: LOOPS.worried, key: 'err', anim: 'worried', run: false, glow: false };
      case 'limited': {
        const tree = nearestTree(L, home);
        const x = tree && Math.abs(tree.x - home) < 160 ? tree.x + 9 + k * 9 : workX;
        return { intent: 'limited', x, dy: 0, facing: -1, loop: LOOPS.tea, key: 'tea', anim: 'tea', run: false, glow: false };
      }
      default: {
        // idle, unknown: a gentle routine by the local clock (SPEC 4.8)
        const h = this.localHours();
        if (h >= 22 || h < 6) {
          return { intent: 'asleep', x: this.doorX(r) + 10 + k * 12, dy: 0, facing: 1, loop: LOOPS.sleep, key: 'sleep', anim: 'sleep', run: false, glow: false };
        }
        const fire = L.byId.get('campfire');
        if (h >= 18 && fire) {
          const side = (k + Math.floor(r.u * 2)) % 2 ? 1 : -1;
          const x = fire.x + side * (13 + Math.floor(k / 2) * 11);
          return { intent: 'idle', x, dy: 0, facing: side > 0 ? -1 : 1, loop: LOOPS.sit, key: 'sit', anim: 'sit', run: false, glow: false };
        }
        const garden = L.byId.get('garden_plots');
        // potter between seeded spots near home, a new spot every 9 to 14 s
        const period = 9 + 5 * r.u;
        const n = Math.floor((t + r.u * period) / period);
        const jitter = ((hash(idSeed(r.id), n) % 1000) / 1000 - 0.5) * 70;
        if (h >= 11 && h < 15 && garden && garden.stage >= 2) {
          const x = garden.x - 14 + k * 12 + jitter * 0.3;
          return { intent: 'idle', x, dy: 0, facing: n % 2 ? 1 : -1, loop: LOOPS.garden, key: 'garden', anim: 'garden', run: false, glow: false };
        }
        const x = Math.max(30, Math.min(CANON_W - 30, home + jitter));
        const loop = n % 3 === 2 ? LOOPS.stand : LOOPS.sweep;
        return { intent: 'idle', x, dy: 0, facing: (hash(n, 7) & 1) === 1 ? 1 : -1, loop, key: n % 3 === 2 ? 'stand' : 'sweep', anim: n % 3 === 2 ? 'stand' : 'sweep', run: false, glow: false };
      }
    }
  }

  private placeAtSpot(r: Res, t: number, mode?: 'work'): void {
    const p = this.plan(r, t);
    r.x = mode === 'work' ? this.workshopX(r.tool) : p.x;
    if (!mode) r.facing = p.facing;
    r.arrivedAt = mode ? null : t - 10;
  }

  // ------------------------------------------------------------------ tick

  /**
   * Calm strips share one visual clock. With no residents or short-lived effects, decorative
   * life only needs one step every two seconds. Inputs still poke a frame immediately and moments burst.
   */
  calmFps(t: number): number {
    const transient = this.res.size > 0 || this.alerts.size > 0 || t - this.lastInputAt < 2.5 ||
      this.pendingBuild.length > 0 || this.planks.some((p) => !p.landed) ||
      this.dusts.some((d) => t - d.at < d.dur) ||
      this.confettiBursts.some((c) => t - c.at < 1.7) ||
      !!(this.sky && t < this.sky.at + this.sky.dur);
    return transient ? 4 : 0.5;
  }

  /**
   * @param calm strip characters and scenery share four paper steps per second (empty strips use
   * one every two seconds); ambient characters retain their six-fps grid. WebKit commits have a
   * fixed wakeup cost, so calm strips must draw well under 12 fps to meet SPEC 6.7.
   */
  step(tRaw: number, calm = false, stripCalmFps?: number): DisplayList {
    if (calm && this.opts.surface === 'strip' && !this.reduced) {
      const fps = stripCalmFps ?? this.calmFps(tRaw);
      // Clouds, particles, rotating parts and poses must not create separate commits between
      // calm steps. Keep time monotonic when the strip changes to one step every two seconds.
      tRaw = Math.max(this.lastTRaw, Math.floor(tRaw * fps + 1e-6) / fps);
    }
    const t = calm && !this.reduced
      ? this.opts.surface === 'strip' ? tRaw : Math.floor(tRaw * 6 + 1e-6) / 6
      : quantize(tRaw);
    const dt = Math.max(0, Math.min(0.5, t - this.lastT));
    const dtRaw = Math.max(0, Math.min(0.5, tRaw - this.lastTRaw));
    this.lastT = t;
    this.lastTRaw = tRaw;
    const reduced = this.reduced;
    let animating = false;
    const fx: string[] = [];

    // planks landing release deferred build completions
    for (const p of this.planks) {
      if (!p.landed && tRaw >= p.at + p.dur) {
        p.landed = true;
        this.dusts.push({ x: p.x1, at: tRaw, dur: 0.5, big: false });
        const pend = this.pendingBuild.filter((b) => b.structure === p.to);
        const held = p.to !== null && this.holds.delete(p.to);
        for (const b of pend) this.completeStage(b.structure, b.stage, tRaw);
        this.pendingBuild = this.pendingBuild.filter((b) => b.structure !== p.to);
        if (held && !pend.length && p.to) {
          this.rebuildLayout();
          const s = this.layout.byId.get(p.to);
          this.dusts.push({ x: s?.x ?? p.x1, at: tRaw, dur: 1.1, big: true });
          if (s && s.stage === 3 && s.def.part) this.spin.set(p.to, { at: tRaw });
        }
      }
    }
    // a deferred build whose plank vanished (should not happen) completes after 3 s
    for (const b of [...this.pendingBuild]) if (tRaw - b.at > 3) {
      this.completeStage(b.structure, b.stage, tRaw);
      this.pendingBuild = this.pendingBuild.filter((x) => x !== b);
    }

    // residents
    const draws: ResDraw[] = [];
    for (const r of [...this.res.values()]) {
      if (r.removeAt !== null && t >= r.removeAt) {
        this.res.delete(r.id);
        continue;
      }
      const plan = this.plan(r, t);
      let anim: Anim = plan.anim;
      let pose: string;
      let intent: Intent = plan.intent;
      const ov = r.overlay;
      if (reduced) {
        r.overlay = null;
        r.move = null;
        r.x = plan.x;
        r.facing = plan.facing;
        pose = plan.loop[0][0];
        if (intent === 'alert') pose = 'ring-0';
        if (r.leaving) r.removeAt = t;
      } else if (ov && t >= ov.at && t < ov.at + ov.dur) {
        anim = ov.kind === 'cheer' ? 'cheer' : ov.kind === 'turn' ? 'turn' : 'stretch';
        if (ov.kind === 'cheer') intent = 'celebrate';
        pose = onceAt(ov.kind === 'cheer' ? LOOPS.cheer : ov.kind === 'turn' ? LOOPS.turn : LOOPS.stretch, t - ov.at).pose;
        animating = true;
      } else {
        if (ov && t >= ov.at + ov.dur) r.overlay = null;
        if (ov && t < ov.at) animating = true;
        const dx = plan.x - r.x;
        if (Math.abs(dx) > 0.75) {
          // short trips walk; long ones jog (run poses at an easy pace); the alert dashes
          const far = !plan.run && Math.abs(dx) > 90;
          const mode = plan.run || far || r.move?.speed === JOG_SPEED ? 'run' : 'walk';
          if (!r.move || r.move.mode !== mode) r.move = { mode, speed: plan.run ? runSpeed(Math.abs(dx)) : mode === 'run' ? JOG_SPEED : WALK_SPEED * (0.92 + 0.16 * r.u), traveled: 0, at: t };
          // a dash slides smoothly at the frame rate while its poses stay on 12 fps steps; walks step
          const stepLen = Math.min(Math.abs(dx), r.move.speed * (mode === 'run' ? dtRaw : dt));
          r.x += Math.sign(dx) * stepLen;
          r.move.traveled += stepLen;
          r.facing = dx > 0 ? 1 : -1;
          anim = mode;
          // stepped gait on the 12 fps grid: run cycles every step, walk every third step
          const steps = Math.round((t - r.move.at) / STEP);
          pose = mode === 'run' ? LOOPS.run[steps % 3][0] : LOOPS.walk[Math.floor(steps / 3) % 2][0];
          r.arrivedAt = null;
          animating = true;
        } else {
          if (r.move || r.arrivedAt === null) r.arrivedAt = t;
          r.move = null;
          r.x = plan.x;
          r.facing = plan.facing;
          if (r.leaving) {
            r.removeAt = t + STEP;
          }
          if (plan.key !== r.loopKey) {
            r.loopKey = plan.key;
            r.loopAt = plan.key === 'ring' ? t : t - r.u * loopLength(plan.loop);
          }
          pose = poseAt(plan.loop, t - r.loopAt, plan.key === 'ring' ? 1 : r.tempo);
          if (plan.loop.length > 1) animating = true;
          // re-plan once arrived at the bell so ringing starts on this frame
          if (intent === 'alert') {
            const p2 = this.plan(r, t);
            anim = p2.anim;
            if (p2.key !== r.loopKey) {
              r.loopKey = p2.key;
              r.loopAt = t;
            }
            pose = poseAt(p2.loop, t - r.loopAt);
          }
        }
      }
      if (intent === 'alert' && r.arrivedAt === null) animating = true;
      r.lastIntent = intent;
      r.lastAnim = anim;
      r.lastPose = pose;
      r.lastX = r.x;
      if (!r.visible) continue;
      const isAsleep = pose.startsWith('sleep');
      let dy = plan.dy;
      if (!reduced && plan.key === 'tea') {
        // a slow doze: a small bob every 4 s
        const ph = (t + r.u * 4) % 4;
        if (ph < 0.34) dy -= 0.6;
        animating = true;
      }
      draws.push({
        id: r.id,
        tool: r.tool,
        species: r.species,
        pose: r.helper && !HELPER_OK.has(pose) ? helperPose(pose) : pose,
        scarf: r.scarf,
        x: r.x,
        dy,
        facing: r.facing,
        helper: r.helper,
        faded: r.state === 'unknown',
        glow: plan.glow && !isAsleep,
        intent,
        anim,
        variant: intent === 'work' ? plan.variant : undefined,
        alpha: r.state === 'unknown' ? 0.55 : 1,
      });
    }
    draws.sort((a, b) => Number(a.helper) - Number(b.helper) || a.x - b.x);

    // flag and bell
    let raised = this.alerts.size > 0;
    if (!raised) this.flagRaisedAt = null;
    else if (this.flagRaisedAt === null) this.flagRaisedAt = t;
    const oldest = [...this.alerts.values()].sort((a, b) => a.t - b.t)[0];
    const icon: FlagIcon = oldest ? oldest.reason : 'none';
    let ringing = false;
    let swing: -1 | 0 | 1 = 0;
    let rise = 1;
    let wave = 0;
    if (raised) {
      const since = tRaw - (this.flagRaisedAt ?? tRaw);
      rise = reduced ? 1 : Math.min(1, Math.floor(since * 30 + 1e-6) / 2);
      const sinceRing = tRaw - this.ringStart;
      const anyRinging = draws.some((d) => d.anim === 'ring');
      const gentle = sinceRing > 1.5 && (sinceRing - 1.5) % 8 > 7.4;
      ringing = !reduced && (sinceRing < 1.5 || anyRinging || gentle);
      if (reduced) ringing = sinceRing < 0.001;
      if (ringing) {
        const f = Math.floor(tRaw * (gentle && !anyRinging && sinceRing >= 1.5 ? 6 : 12)) % 4;
        swing = ([-1, 0, 1, 0] as const)[f];
      }
      wave = reduced ? 0 : Math.floor(tRaw * 3) % 3;
      animating = true;
      fx.push('flag');
    }
    if (reduced && raised) ringing = true;

    // planks, dust, confetti
    const planks: DisplayList['planks'] = [];
    for (const p of this.planks) {
      if (p.landed || tRaw < p.at) {
        if (!p.landed) animating = true;
        continue;
      }
      const u = (tRaw - p.at) / Math.max(0.001, p.dur);
      const e = ease.inOutSine(u);
      const dist = Math.abs(p.x1 - p.x0);
      const arc = 12 + Math.min(24, dist * 0.07);
      planks.push({ x: p.x0 + (p.x1 - p.x0) * e, y: -14 - Math.sin(u * Math.PI) * arc, rot: u * 4.2 * Math.sign(p.x1 - p.x0 || 1) - 0.3 });
      animating = true;
    }
    this.planks = this.planks.filter((p) => !p.landed || tRaw - p.at < 5);
    if (planks.length) fx.push('plank');
    const dust: DisplayList['dust'] = [];
    for (const d of this.dusts) {
      const u = (tRaw - d.at) / d.dur;
      if (u < 0 || u > 1) continue;
      dust.push({ x: d.x, scale: (d.big ? 0.85 : 0.32) + ease.outCubic(u) * (d.big ? 0.75 : 0.25), alpha: u < 0.35 ? 1 : 1 - ease.inOutSine((u - 0.35) / 0.65), dy: -u * (d.big ? 6 : 2) });
      animating = true;
    }
    this.dusts = this.dusts.filter((d) => tRaw - d.at < d.dur + 0.1);
    if (dust.length) fx.push('dust');
    const confetti: Particle[] = [];
    for (const c of this.confettiBursts) {
      const age = tRaw - c.at;
      if (age < 0 || age > 1.6) continue;
      for (let i = 0; i < 26; i++) {
        const s = hash(c.seed, i);
        const a = (s % 1000) / 1000;
        const b = ((s >>> 10) % 1000) / 1000;
        const vx = (a - 0.5) * 70;
        const vy = -70 - b * 55;
        const g = 150;
        const drag = 1 - Math.min(0.6, age * 0.35);
        const x = c.x + vx * age * drag + Math.sin(age * 9 + i) * 2.2 * age;
        const y = -16 + vy * age + 0.5 * g * age * age;
        if (y > 2) continue;
        confetti.push({ x, y, rot: age * (6 + a * 10) + i, color: i % 6, alpha: Math.min(1, (1.6 - age) * 2.5), w: 1.6 + b * 0.8, h: 1 + a * 0.5 });
      }
      animating = true;
    }
    this.confettiBursts = this.confettiBursts.filter((c) => tRaw - c.at < 1.7);
    if (confetti.length) fx.push('confetti');

    // structures: rotating parts, smoke, dark windows
    const workingTools = new Set<Tool>();
    for (const r of this.res.values()) if (r.state === 'working' && !r.helper) workingTools.add(r.tool);
    const parts = new Map<StructureId, number>();
    const smoke: StructureId[] = [];
    const lampsNow = sampleSky(this.currentPhase(tRaw), 'clear').lamps;
    for (const p of this.layout.structures) {
      if (p.def.part && p.stage === 3) {
        const spin = this.spin.get(p.id);
        const toolBusy = p.tool ? workingTools.has(p.tool) : workingTools.size > 0;
        const base = p.kind === 'watermill' ? 0.35 + 0.25 * Math.min(4, workingTools.size) : toolBusy ? 1.1 : 0.22;
        if (!reduced) {
          // a newly finished mill spins up over 2.5 s: the angle integrates the eased speed, so it never jumps
          const D = 2.5;
          const tq = quantize(tRaw);
          let angle = tq * base + p.x * 0.01;
          if (spin) {
            const uu = Math.max(0, (tq - spin.at) / D);
            const uc = Math.min(1, uu);
            angle = base * D * (uu - (1 - Math.pow(1 - uc, 4)) / 4);
          }
          parts.set(p.id, angle);
          animating = true;
        } else parts.set(p.id, p.x * 0.01);
      }
      if (p.pts.chimney && !reduced) {
        const busy = p.tool ? workingTools.has(p.tool) : false;
        const homely = (p.kind === 'cottage' || p.kind === 'bakery' || p.kind === 'guesthouse') && lampsNow > 0.25;
        if (busy || homely || (p.kind === 'watermill' && workingTools.size > 0)) {
          smoke.push(p.id);
          animating = true;
        }
      }
    }
    const dark = new Set<StructureId>();
    if (this.snap) {
      for (const ts of this.snap.tools) if (ts.presence === 'offline') {
        const ws = this.layout.workshop.get(ts.tool);
        if (ws) dark.add(ws.id);
      }
    }
    const hrs = this.localHours();
    if (hrs >= 23 || hrs < 5) {
      // windows go dark one by one after 23:00
      const into = ((hrs + 1) % 24) * 60;
      for (const p of this.layout.structures) if (hash(this.layout.seed, p.x | 0) % 120 < into) dark.add(p.id);
    }

    // showers over workshops of limited providers
    const showers: [number, number][] = [];
    for (const [tool, until] of this.showerUntil) {
      const limitedHere = [...this.res.values()].some((r) => r.tool === tool && r.state === 'limited');
      if (tRaw > until && !limitedHere) {
        this.showerUntil.delete(tool);
        continue;
      }
      const cx = this.workshopX(tool);
      showers.push([cx - 46, cx + 46]);
    }
    if (showers.length) {
      fx.push('shower');
      if (!reduced) animating = true;
    }

    // extras "+N" over workshops
    const extras: DisplayList['extras'] = [];
    const counts = new Map<Tool, number>();
    for (const r of this.res.values()) if (!r.helper && !r.leaving) counts.set(r.tool, (counts.get(r.tool) ?? 0) + 1);
    for (const [tool, n] of counts) {
      if (n <= MAX_PER_TOOL) continue;
      const ws = this.layout.workshop.get(tool);
      const x = ws ? ws.x : campSpot(this.layout);
      extras.push({ x, y: 80 - (ws ? Math.min(ws.def.h, 60) : 20) - 8, n: n - MAX_PER_TOOL });
    }

    // sky
    const phase = this.currentPhase(tRaw);
    if (this.sky && tRaw < this.sky.at + this.sky.dur) animating = true;
    const weather = this.currentWeather(tRaw);
    if (tRaw < this.sunriseUntil) fx.push('sunrise');
    if (weather === 'rainbow') fx.push('rainbow');
    const season = seasonFor(this.opts.date(), this.opts.hemisphere);
    const lamps = sampleSky(phase, weather).lamps;

    // ambient camera: smooth, so it integrates the real frame time, not the 12 fps puppet step
    let camX = 0;
    let cameraMoving = false;
    if (this.opts.surface === 'ambient' && this.opts.ambientView) {
      const { visibleW, panSpeed } = this.opts.ambientView;
      const lo = 0;
      const hi = Math.max(lo, CANON_W - visibleW);
      // The bell post stays in the window while an alert is raised (WP-13 request 1): the flag, the bell
      // and the queue of waiting residents all read in the first moment, wherever the runner starts.
      const bell = this.layout.bell.x;
      const bLo = Math.max(lo, bell + BELL_MARGIN_R - visibleW);
      const bHi = Math.min(hi, bell - BELL_MARGIN_L);
      const bellRange = bLo <= bHi ? ([bLo, bHi] as const) : null;
      // a still or holding camera never slices a resident at the frame edge; the result stays inside [rlo, rhi]
      const unclipped = (target: number, keep: number | null, rlo = lo, rhi = hi): number => {
        let x = Math.max(rlo, Math.min(rhi, target));
        for (let pass = 0; pass < 3; pass++) {
          for (const d of draws) {
            if (d.helper) continue;
            const half = SLICE_HALF;
            if (d.x + half > x && d.x - half < x) x = keep !== null && d.x - half - 2 < keep - visibleW + 20 ? d.x + half + 2 : d.x - half - 2;
            else if (d.x - half < x + visibleW && d.x + half > x + visibleW) x = keep !== null && d.x + half + 2 - visibleW > keep - 20 ? d.x - half - 2 - visibleW : d.x + half + 2 - visibleW;
            x = Math.max(rlo, Math.min(rhi, x));
          }
        }
        return x;
      };
      if (this.cam.x < 0) this.cam.x = unclipped(Math.max(lo, Math.min(hi, this.layout.bell.x - visibleW * 0.4)), null);
      const waiting = draws.filter((d) => d.intent === 'alert');
      if (reduced) {
        let target = waiting.length ? waiting[0].x - visibleW / 2 : (lo + hi) / 2;
        if (waiting.length && bellRange) target = Math.max(bellRange[0], Math.min(bellRange[1], target));
        this.cam.x = Math.max(lo, Math.min(hi, target));
      } else if (waiting.length) {
        // pause on the resident who needs you: ease toward them, then hold, with the post always in frame
        // aim inside the range, not at its edge, so the post is really in frame when the camera arrives
        const pad = bellRange ? Math.min(40, (bellRange[1] - bellRange[0]) / 3) : 0;
        const [rlo, rhi] = bellRange ? [bellRange[0] + pad, bellRange[1] - pad] : [lo, hi];
        const target = unclipped(waiting[0].x - visibleW * 0.42, waiting[0].x, rlo, rhi);
        const d = target - this.cam.x;
        // a post that is out of frame (or about to be) pulls the camera back quickly
        const postIn = !bellRange || (this.cam.x >= bellRange[0] && this.cam.x <= bellRange[1]);
        const rate = postIn ? 1.6 : 6;
        const k = 1 - Math.exp(-dtRaw * rate);
        this.cam.x += d * k;
        this.cam.vx = d * rate;
        cameraMoving = Math.abs(d) > 0.4;
      } else {
        // slow ping-pong pan with soft turnarounds; an edge that reaches a resident crosses quickly
        // instead of resting on it (WP-13 request 2), and the turnaround points sit where no edge slices one
        let wLo = unclipped(lo, null);
        let wHi = unclipped(hi, null);
        if (wLo > wHi) [wLo, wHi] = [lo, hi];
        const edge = Math.min(this.cam.x - wLo, wHi - this.cam.x);
        const soft = 0.18 + 0.82 * ease.inOutSine(Math.min(1, Math.max(0, edge) / 90));
        let speed = panSpeed * soft;
        let near = false;
        for (const d of draws) {
          if (d.helper) continue;
          if (Math.abs(d.x - this.cam.x) < SLICE_HALF + 8 || Math.abs(d.x - (this.cam.x + visibleW)) < SLICE_HALF + 8) near = true;
        }
        if (near) speed = Math.max(speed, CROSS_SPEED);
        const want = this.cam.dir * speed;
        const fast = near || Math.abs(this.cam.vx) > panSpeed * 1.5;
        this.cam.vx += (want - this.cam.vx) * (1 - Math.exp(-dtRaw * (fast ? 6 : 0.8)));
        this.cam.x += this.cam.vx * dtRaw;
        if (this.cam.x >= wHi - 0.5 && this.cam.dir > 0) this.cam.dir = -1;
        if (this.cam.x <= wLo + 0.5 && this.cam.dir < 0) this.cam.dir = 1;
        this.cam.x = Math.max(lo, Math.min(hi, this.cam.x));
        cameraMoving = Math.abs(this.cam.vx) > 0.05;
      }
      camX = this.cam.x;
      if (cameraMoving) animating = true;
    }

    // ambient life: drifting clouds (one device pixel at a time), weather particles, fireflies
    const pxu = Math.max(0.5, this.opts.pxPerUnit);
    const drift = this.opts.surface === 'ambient' ? 2.4 : 0.9;
    const clouds = reduced ? 0 : Math.floor(tRaw * drift * pxu) / pxu;
    const spec = sampleSky(phase, weather).spec;
    const fireflies = lamps > 0.45 && season === 'autumn' && spec.particles !== 'rain' && spec.particles !== 'snow';
    const hasParticles = spec.particles !== 'none' || fireflies || showers.length > 0 || (season === 'autumn' && spec.wind > 0.2);
    const rate = spec.particles === 'rain' || spec.particles === 'rain-light' || showers.length ? 12 : 6;
    const particleStep = hasParticles && !reduced ? Math.floor(tRaw * rate) : -1;
    if (!reduced && (spec.cloudCover >= 0.05 || hasParticles)) animating = true;

    const bellVisible = this.layout.bell.present || raised;
    if (reduced) animating = false;
    raised = raised && rise >= 0;
    return {
      t,
      sky: { phase, weather, season, lamps },
      layout: this.layout,
      layoutKey: `${this.layoutVersion}|${[...dark].sort().join(',')}`,
      dark,
      residents: draws,
      flag: { raised, icon, ringing, swing, wave, rise },
      bellVisible,
      parts,
      smoke,
      planks,
      dust,
      confetti,
      showers,
      extras,
      camX,
      cameraMoving,
      fx,
      clouds,
      particleStep,
      fireflies,
      animating,
    };
  }

  // ------------------------------------------------------------------ sky

  private targetSky(): { phase: number; weather: Weather } {
    const d = this.opts.date();
    const hours = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
    const limits = this.snap?.limits ?? [];
    const now = d.getTime();
    const choice = skyPhase(limits, now, hours, this.opts.skyMode);
    let weather: Weather = weatherFor(limits, now);
    if (this.lastT < this.rainbowUntil && (weather === 'clear' || weather === 'scattered')) weather = 'rainbow';
    const season = seasonFor(d, this.opts.hemisphere);
    if (season === 'winter' && weather === 'drizzle') weather = 'snow';
    return { phase: choice.phase, weather };
  }

  private currentPhase(t: number): number {
    const target = this.targetSky();
    if (!this.sky) {
      this.sky = { from: target.phase, to: target.phase, at: t, dur: 0, weather: target.weather };
      return target.phase;
    }
    const s = this.sky;
    const u = s.dur > 0 ? Math.min(1, (t - s.at) / s.dur) : 1;
    const shown = lerpPhase(s.from, s.to, ease.inOutSine(u));
    if (phaseDist(target.phase, s.to) > 0.002) {
      const sunrise = t < this.sunriseUntil;
      this.sky = { from: shown, to: target.phase, at: t, dur: this.reduced ? 0 : sunrise ? 4 : 2.6 + Math.min(2.4, phaseDist(shown, target.phase) * 16), weather: target.weather };
      return shown;
    }
    s.weather = target.weather;
    return shown;
  }

  private currentWeather(_t: number): Weather {
    return this.sky?.weather ?? 'clear';
  }

  /** Model time of the newest input (seconds), for the debug log. */
  inputAge(t: number): number {
    return t - this.lastInputAt;
  }

  /** Species heights for hit boxes. */
  static heightOf(species: Species): number {
    return SPECIES_DEFS[species].h;
  }

  /** Points of a structure kind at a stage (bell and flag positions). */
  static points(kind: 'bellpost' | 'belltower', stage: Stage) {
    return STRUCTURES[kind]!.points(stage);
  }
}

function phaseDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d);
}

const HELPER_OK = new Set(['stand-0', 'walk-0', 'walk-1', 'carry-0', 'carry-1', 'work-0', 'work-1', 'cheer-0', 'sleep-0']);
function helperPose(pose: string): string {
  if (pose.startsWith('run')) return pose.endsWith('1') ? 'walk-1' : 'walk-0';
  if (pose.startsWith('cheer')) return 'cheer-0';
  if (pose.startsWith('sleep')) return 'sleep-0';
  return 'stand-0';
}
