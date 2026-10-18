/**
 * Public surface of the Busyholm world renderer (WP-10).
 *
 * One renderer instance draws one surface (the strip or the ambient view) from the same inputs:
 * Snapshot v2 (coalesced state), Moment v1 (immediate events) and World v1 (what is built).
 * Everything time-based reads an injectable Clock and is driven by an injectable Scheduler, so
 * tests and captures can step the renderer frame by frame in virtual time.
 *
 * Without a canvas the renderer runs headless: the model, governor, debug log and HitRects
 * publisher all run, only the pixels are skipped. The acceptance tests use that mode in Node.
 */
import type { HitRects, Moment, Snapshot, Tool, World, RectKind, Species as ContractSpecies } from '../../../contracts/ts/src/types.ts';
import type { Species } from '../../art/src/residents.ts';

export type { HitRects, Moment, Snapshot, Tool, World, RectKind, Species };

export type Surface = 'strip' | 'ambient';

/** B2 art direction exploration variants (opt-in only). */
export type ArtVariant = 'default' | 'deeper_papercut' | 'seasonal_richness' | 'evening_warmth' | 'A' | 'B' | 'C';
export type CanonicalArtVariant = 'default' | 'deeper_papercut' | 'seasonal_richness' | 'evening_warmth';

/** Monotonic milliseconds. */
export interface Clock {
  now(): number;
}

/** A setTimeout abstraction. Handles are opaque. */
export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** Ambient composition parameters (all optional; defaults chosen by eye, see RENDERER-NOTES.md). */
export interface AmbientParams {
  /** device-independent pixels per strip unit at a 1080-px-tall view */
  worldScale: number;
  /** where the ground line sits, as a fraction of the view height from the top */
  groundFrac: number;
  /** parallax depth layers while the camera pans */
  parallax: boolean;
  /** camera pan speed in strip units per second */
  panSpeed: number;
  /** render resolution relative to CSS pixels (the spike's half-resolution rule); capped by dpr */
  resScale: number;
  /** camera start (canonical units, left edge); default: the bell post in view */
  startX?: number;
}

/** The settings the renderer applies while it runs. */
export interface LiveSettings {
  hemisphere?: 'north' | 'south';
  skyMode?: 'usage_and_clock' | 'clock_only';
  species?: Partial<Record<Tool, Species | string>>;
}

export interface RendererOptions {
  surface: Surface;
  /** CSS pixel size of the drawing surface */
  width: number;
  height: number;
  /** devicePixelRatio of the display (capped by maxDpr) */
  dpr: number;
  /** canvas to draw into; omit for a headless renderer */
  canvas?: HTMLCanvasElement | null;
  clock?: Clock;
  /** 'manual' means nothing runs until advance() is called */
  scheduler?: Scheduler | 'manual';
  /** wall-clock date for the season and the clock-driven sky (injectable for captures) */
  date?: () => Date;
  /** seed for scenery placement when no World has been set */
  seed?: number;
  reducedMotion?: boolean;
  hemisphere?: 'north' | 'south';
  skyMode?: 'usage_and_clock' | 'clock_only';
  /** per-tool species overrides (Settings v1 agents.species; mole and heron are drawn as the hedgehog until v0.3) */
  species?: Partial<Record<Tool, ContractSpecies>>;
  /** device pixel ratio cap (default 2 for the strip, 1 for ambient) */
  maxDpr?: number;
  ambient?: Partial<AmbientParams>;
  /** called with every new HitRects set (strip only); never called with an unchanged set */
  onHitRects?: (msg: HitRects) => void;
  /** keep a per-frame debug log (ring buffer) */
  debug?: boolean;
  /** extra interactive rectangles (CSS px) published with the residents, e.g. WP-02's fixed test rect */
  extraHitBoxes?: () => { x: number; y: number; w: number; h: number; kind: RectKind }[];
  /** measurement only: a fixed tick rate and drawing every tick (CPU at 30 fps) */
  measure?: { calmFps?: number; alwaysDraw?: boolean };
  /** B2 art exploration variant: 'default' | 'deeper_papercut' (A) | 'seasonal_richness' (B) | 'evening_warmth' (C) */
  variant?: ArtVariant;
}

/** Governor modes (SPEC 6.6). */
export type GovMode = 'calm' | 'burst' | 'hidden' | 'reduced' | 'ambient-moving' | 'ambient-still';

export interface FrameStats {
  /** scheduler ticks run */
  ticks: number;
  /** frames actually drawn (ticks whose display list changed) */
  drawn: number;
  /** renderer clock time of the last drawn frame */
  lastDrawAt: number;
  mode: GovMode;
}

/**
 * The animation a resident shows. `intent` is what its state asks for (decided on the frame after
 * an input arrives); `anim` is the motion actually playing (a resident may first walk to where
 * its intent happens).
 */
export type Intent =
  | 'starting'
  | 'work'
  | 'alert'
  | 'celebrate'
  | 'your_turn'
  | 'worried'
  | 'limited'
  | 'idle'
  | 'asleep'
  | 'leaving'
  | 'helper';

export type Anim =
  | 'appear'
  | 'stretch'
  | 'walk'
  | 'run'
  | 'work'
  | 'turn'
  | 'ring'
  | 'wait-bell'
  | 'cheer'
  | 'sit-lantern'
  | 'worried'
  | 'tea'
  | 'sweep'
  | 'garden'
  | 'sit'
  | 'stand'
  | 'sleep'
  | 'follow';

export type FlagIcon = 'permission' | 'question' | 'none';

export interface DebugResident {
  id: string;
  tool: Tool;
  species: Species;
  intent: Intent;
  anim: Anim;
  /** activity variant while working (shell, edit, read, web, delegate, other) */
  variant?: string;
  /** atlas pose key, e.g. 'hammer-0' */
  pose: string;
  /** canonical x (units) and view-space box in CSS px */
  x: number;
  box: { x: number; y: number; w: number; h: number } | null;
  faded: boolean;
  helper: boolean;
}

export interface DebugFrame {
  /** renderer clock ms */
  t: number;
  /** drawn-frame counter */
  frame: number;
  mode: GovMode;
  residents: DebugResident[];
  flag: { raised: boolean; icon: FlagIcon; ringing: boolean };
  /** sky phase and weather used for this frame */
  sky: { phase: number; weather: string; season: string };
  /** effects visible this frame (plank, dust, confetti, shower, rainbow, sunrise) */
  fx: string[];
  /** time from the newest input (snapshot or moment) to this frame, ms */
  sinceInput: number;
  /** time spent drawing this frame, ms (0 when headless) */
  drawMs: number;
}

/** An agent waiting on the user: never any content, only who and since when. */
export interface WaitingAgent {
  id: string;
  tool: Tool;
  species: Species;
  /** instance scarf index 0..5 */
  scarf: number;
  ordinal: number;
  reason: 'permission' | 'question';
  /** ms epoch the wait began (collector clock) */
  since: number;
}

export interface Renderer {
  readonly surface: Surface;
  readonly variant: CanonicalArtVariant;
  /** agents waiting on the user, oldest first */
  waiting(): WaitingAgent[];
  setSnapshot(s: Snapshot): void;
  pushMoment(m: Moment): void;
  setWorld(w: World): void;
  setReducedMotion(on: boolean): void;
  /** live settings changes (hemisphere, sky mode, species per tool); omitted fields stay as they are */
  updateSettings(s: LiveSettings): void;
  /** re-read options.extraHitBoxes and republish if they changed (publication does not wait for a pixel change) */
  refreshHitRects(): void;
  /** false = hidden, occluded, locked or display asleep: 0 fps */
  setVisible(visible: boolean): void;
  /** strip hover-fade (SPEC 6.3): scenery at 20% */
  setFade(on: boolean): void;
  resize(width: number, height: number, dpr: number): void;
  /** manual scheduler: advance virtual time by ms, running every tick that falls due */
  advance(ms: number): void;
  stats(): FrameStats;
  /** per-frame debug log (newest last); empty unless options.debug */
  debugLog(): DebugFrame[];
  /** canvas memory held by the view, megabytes by category (empty when headless) */
  debugMemory(): Record<string, number>;
  /** exceptions caught inside ticks (the loop survives them), newest last, at most 20 */
  errors(): string[];
  /** the last HitRects set sent (strip only) */
  lastHitRects(): HitRects | null;
  destroy(): void;
}
