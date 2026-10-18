/**
 * Demo capture page (WP-13, WP-B1).
 * Supports: strip1440 | strip2560 | ambient | desktop | timelapse | trailer | endcard
 * Step mode only: window.__demo.stepTo(frame) advances the seeded demo and the renderer in exact
 * 1000/30 ms steps from frame 0, so a frame is a pure function of (seed, view, frame number).
 */
import { createRenderer, type Renderer } from '../../renderer/src/browser.ts';
import { mountNeedsYouCard } from '../../renderer/src/pages/card.ts';
import { createDemoSession, demoDate, DEMO_SEED } from './session.ts';
import {
  createVideoScenarioSession,
  drawOnScreenCaption,
  drawScenarioEndCard,
  getShotAt,
  VIDEO_SCENARIO_SEED,
  type VideoScenarioSession,
} from './scenario.ts';
import { drawDesktopBackground, drawStripContainerFrame, getDesktopStripRect } from './desktop.ts';
import { drawTimelapseStamp, generateThreeWeekTimelapseDays, getTimelapseDayAt, type TimelapseDay } from './timelapse.ts';
import { drawEndCard } from './end-card.ts';
import { FPS, frameMs } from './clips.ts';

const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'ambient';
const clip = q.get('clip') ?? '';

const SIZES: Record<string, [number, number]> = {
  strip1440: [1440, 120],
  strip2560: [2560, 160],
  ambient: [1920, 1080],
  desktop: [1920, 1080],
  timelapse: [1920, 1080],
  trailer: [1920, 1080],
  endcard: [1920, 1080],
};

const size = SIZES[view];
if (!size) throw new Error(`unknown view ${view}`);
const [W, H] = size;
const canvas = document.getElementById('world') as HTMLCanvasElement;
const rect = () => {
  const b = canvas.getBoundingClientRect();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
};

declare global {
  interface Window {
    __demo: unknown;
  }
}

canvas.width = W;
canvas.height = H;
const mainCtx = canvas.getContext('2d')!;

const isScenario = view === 'trailer' || clip === 'trailer' || view === 'desktop' || view === 'timelapse' || clip.startsWith('beat');

if (view === 'endcard' && !isScenario) {
  const n = (k: string) => Number(q.get(k));
  drawEndCard(mainCtx, { activeDays: n('activeDays'), turns: n('turns'), buildings: n('buildings'), tools: n('tools') }, W, H);
  window.__demo = { ready: true, canvasRect: rect };
} else if (isScenario) {
  // ------------------------------------------------------------------ Video Scenario Pipeline (WP-B1)
  const seed = q.has('seed') ? Number(q.get('seed')) : VIDEO_SCENARIO_SEED;
  const scenarioSession: VideoScenarioSession = createVideoScenarioSession({ seed });

  // Offscreen strip renderer (1440x120 at 2x dpr -> 2880x240 backing store for crisp zooms)
  const stripCanvas = document.createElement('canvas');
  stripCanvas.width = 2880;
  stripCanvas.height = 240;
  const stripRenderer: Renderer = createRenderer({
    surface: 'strip',
    width: 1440,
    height: 120,
    dpr: 2,
    canvas: stripCanvas,
    scheduler: 'manual',
    date: () => demoDate(scenarioSession.elapsedMs),
    seed: scenarioSession.seed,
    debug: false,
    measure: { alwaysDraw: true },
  });

  // Offscreen ambient renderer (1920x1080, worldScale 2.38 frames x=215..1022 so bell post, sawmill, stoneyard, and watermill all read clearly)
  const ambientCanvas = document.createElement('canvas');
  ambientCanvas.width = W;
  ambientCanvas.height = H;
  const ambientRenderer: Renderer = createRenderer({
    surface: 'ambient',
    width: W,
    height: H,
    dpr: 1,
    canvas: ambientCanvas,
    scheduler: 'manual',
    date: () => demoDate(scenarioSession.elapsedMs),
    seed: scenarioSession.seed,
    debug: false,
    ambient: { resScale: 1, worldScale: 2.38, startX: 215, panSpeed: 1.2 },
    measure: { alwaysDraw: true },
  });

  // Dedicated full-island timelapse renderer (1920x1080, worldScale 1.48 frames x=36..1333 across the whole island)
  const timelapseCanvas = document.createElement('canvas');
  timelapseCanvas.width = W;
  timelapseCanvas.height = H;
  const timelapseRenderer: Renderer = createRenderer({
    surface: 'ambient',
    width: W,
    height: H,
    dpr: 1,
    canvas: timelapseCanvas,
    scheduler: 'manual',
    date: () => demoDate(12_000),
    seed: scenarioSession.seed,
    debug: false,
    ambient: { resScale: 1, worldScale: 1.48, startX: 36, panSpeed: 0 },
    measure: { alwaysDraw: true },
  });

  // Offscreen desktop composition canvas (so camera zoom/pan never scales the on-screen caption pill)
  const desktopCanvas = document.createElement('canvas');
  desktopCanvas.width = W;
  desktopCanvas.height = H;
  const desktopCtx = desktopCanvas.getContext('2d')!;

  let timelapseInitialized = false;
  scenarioSession.connect({
    setSnapshot(s) {
      stripRenderer.setSnapshot(s);
      // Keep ambientRenderer camera from yanking to x=0 during desktop Shot 3
      const ambientSnap = {
        ...s,
        agents: s.agents.map((a) => (a.state === 'needs_you' ? { ...a, state: 'working' as const, activity: 'edit' as const } : a)),
        attention: { needs_you: 0, oldest_since: null },
      };
      ambientRenderer.setSnapshot(ambientSnap);
      if (!timelapseInitialized) {
        timelapseInitialized = true;
        timelapseRenderer.setSnapshot(ambientSnap);
      }
    },
    pushMoment(m) {
      stripRenderer.pushMoment(m);
      if (m.kind !== 'needs_you' && m.kind !== 'answered') {
        ambientRenderer.pushMoment(m);
      }
    },
    setWorld(w) {
      stripRenderer.setWorld(w);
      ambientRenderer.setWorld(w);
    },
  });

  stripRenderer.advance(0);
  ambientRenderer.advance(0);
  timelapseRenderer.advance(0);

  const timelapseDays = generateThreeWeekTimelapseDays(seed);
  let lastTimelapseDay = -1;

  const smoothstep = (u: number): number => {
    const c = Math.max(0, Math.min(1, u));
    return c * c * (3 - 2 * c);
  };

  function drawCameraCrop(
    src: HTMLCanvasElement,
    cx: number,
    cy: number,
    scale: number
  ): void {
    const cropW = W / scale;
    const cropH = H / scale;
    const sx = Math.max(0, Math.min(W - cropW, cx - cropW / 2));
    const sy = Math.max(0, Math.min(H - cropH, cy - cropH / 2));
    mainCtx.drawImage(src, sx, sy, cropW, cropH, 0, 0, W, H);
  }

  function renderCurrentScenarioFrame(ms: number) {
    const shot = getShotAt(ms);
    const effectiveView = view === 'trailer' ? shot.view : view;
    const shotU = Math.max(0, Math.min(1, (ms - shot.startMs) / Math.max(1, shot.durationMs)));

    mainCtx.clearRect(0, 0, W, H);

    if (effectiveView === 'desktop') {
      let terminalText: string[] | undefined;
      const showAlert = shot.id === 'needs_you' && ms >= 14_600;
      const showPopover = shot.id === 'needs_you' && ms >= 18_200;

      if (shot.id === 'working') {
        terminalText = [
          'user@busyholm ~ % claude',
          '  > Editing world/src/island.ts (sawmill active)',
          '  [====================>      ] 74% complete',
          '',
          'user@busyholm ~ % codex',
          '  > Second session connected (stone yard active)',
          '  > Running: npm test -- contracts/ts ... 14 passed',
        ];
      } else if (shot.id === 'needs_you') {
        terminalText = [
          'user@busyholm ~ % codex',
          '> Permission request: Run \'git push origin main\'? [y/n]',
          '  Waiting for user confirmation...',
          '',
          'user@busyholm ~ % claude',
          '  > Editing world/src/watermill.ts ... working',
        ];
      } else if (shot.id === 'answer_build') {
        terminalText = [
          'user@busyholm ~ % codex',
          '  User confirmed: y',
          '  Permission granted! Executing git push...',
          '  [Done] Turn completed (1 plank earned)',
        ];
      } else if (shot.id === 'limit_rain') {
        terminalText = [
          'user@busyholm ~ % claude',
          '[Usage Limit] Claude 5-hour quota reached (100%).',
          'Rolling window resets in 42m.',
          'Resident paused: resting at willow tree.',
        ];
      }

      desktopCtx.clearRect(0, 0, W, H);
      drawDesktopBackground(desktopCtx, W, H, {
        showAlertBanner: showAlert,
        showTrayPopover: showPopover,
        terminalText,
        activeBeat: shot.id,
      });

      const stripPlacement = getDesktopStripRect(W, H);
      drawStripContainerFrame(desktopCtx, stripPlacement);
      desktopCtx.drawImage(
        stripCanvas,
        0,
        0,
        stripCanvas.width,
        stripCanvas.height,
        stripPlacement.x,
        stripPlacement.y,
        stripPlacement.w,
        stripPlacement.h
      );

      // Storyboard camera choreography per desktop shot
      if (shot.id === 'desktop') {
        // Shot 1: Slow, smooth push-in from wide desktop overview toward the lower strip
        const e = smoothstep(shotU);
        const scale = 1.0 + 0.24 * e;
        const cx = 960;
        const cy = 540 + 210 * e;
        drawCameraCrop(desktopCanvas, cx, cy, scale);
      } else if (shot.id === 'working') {
        // Shot 2: Strip Medium — closer framing tracking laterally from west (sawmill) to east (stone yard)
        const e = smoothstep(shotU);
        const scale = 1.68;
        const cx = 680 + 420 * e;
        const cy = 790;
        drawCameraCrop(desktopCanvas, cx, cy, scale);
      } else if (shot.id === 'needs_you') {
        // Shot 3: Bell Post Focus (14.0-18.2s) then smooth pull-back to full desktop for Tray Popover + strip (18.2-22.0s)
        if (ms < 18_200) {
          const u1 = smoothstep((ms - 14_000) / 4_200);
          const scale = 1.55 + 0.22 * u1;
          const cx = 740 - 120 * u1;
          const cy = 815;
          drawCameraCrop(desktopCanvas, cx, cy, scale);
        } else {
          const u2 = smoothstep((ms - 18_200) / 1_400);
          const scale = 1.77 - 0.77 * u2;
          const cx = 620 + 340 * u2;
          const cy = 815 - 275 * u2;
          drawCameraCrop(desktopCanvas, cx, cy, scale);
        }
      } else {
        mainCtx.drawImage(desktopCanvas, 0, 0, W, H);
      }

      drawOnScreenCaption(mainCtx, shot.caption, W, H, 888);
    } else if (effectiveView === 'timelapse') {
      const timelapseShot = shot.id === 'timelapse' ? shot : { startMs: 0, durationMs: 6000, caption: 'Grows from weeks of work' };
      const elapsedInShot = Math.max(0, ms - timelapseShot.startMs);
      const currentDay = getTimelapseDayAt(timelapseDays, elapsedInShot, timelapseShot.durationMs);

      if (currentDay.n !== lastTimelapseDay) {
        lastTimelapseDay = currentDay.n;
        timelapseRenderer.setWorld(currentDay.world);
        timelapseRenderer.advance(100);
      } else {
        timelapseRenderer.advance(33.33);
      }

      // Subtle outward scale adjustment as the settlement expands from camp to village
      const e = smoothstep(elapsedInShot / Math.max(1, timelapseShot.durationMs));
      const scale = 1.06 - 0.06 * e;
      const cx = 900 + 60 * e;
      const cy = 560;
      drawCameraCrop(timelapseCanvas, cx, cy, scale);

      drawTimelapseStamp(mainCtx, currentDay, W, H);
      drawOnScreenCaption(mainCtx, shot.caption, W, H);
    } else if (effectiveView === 'endcard') {
      drawScenarioEndCard(mainCtx, W, H);
    } else {
      // Ambient diorama (Shots 4, 5, 6, 7)
      mainCtx.drawImage(ambientCanvas, 0, 0, W, H);
      drawOnScreenCaption(mainCtx, shot.caption, W, H);
    }
  }

  // Render initial frame
  renderCurrentScenarioFrame(0);

  let frame = 0;
  window.__demo = {
    ready: true,
    fps: FPS,
    canvasRect: rect,
    frame: () => frame,
    errors: () => [...stripRenderer.errors(), ...ambientRenderer.errors(), ...timelapseRenderer.errors()],
    stepTo(target: number) {
      if (!Number.isInteger(target) || target < frame || frameMs(target) > scenarioSession.durationMs) {
        throw new RangeError(`bad frame ${target}`);
      }
      while (frame < target) {
        frame++;
        const currentMs = frameMs(frame);
        const dt = currentMs - frameMs(frame - 1);
        scenarioSession.advanceTo(currentMs);
        stripRenderer.advance(dt);
        ambientRenderer.advance(dt);
      }
      renderCurrentScenarioFrame(frameMs(frame));
    },
  };
} else {
  // ------------------------------------------------------------------ Classic Demo Pipeline (WP-13)
  const seed = q.has('seed') ? Number(q.get('seed')) : DEMO_SEED;
  const edition = (q.get('edition') ?? 'full') as 'full' | 'demo';
  const demo = createDemoSession({ seed, edition });
  const r: Renderer = createRenderer({
    surface: view.startsWith('strip') ? 'strip' : 'ambient',
    width: W,
    height: H,
    dpr: devicePixelRatio,
    canvas,
    scheduler: 'manual',
    date: () => demoDate(demo.elapsedMs),
    seed: demo.seed,
    debug: false,
    ambient: { resScale: view === 'ambient' ? 1 : undefined },
  });
  demo.connect({
    setSnapshot: (s) => r.setSnapshot(s),
    pushMoment: (m) => r.pushMoment(m),
    setWorld: (w) => r.setWorld(w),
  });
  r.advance(0);
  const card =
    view === 'ambient'
      ? (mountNeedsYouCard(r, () => demoDate(demo.elapsedMs).getTime(), true),
        (window as unknown as { __bhCard: () => void }).__bhCard)
      : null;
  let frame = 0;
  window.__demo = {
    ready: true,
    fps: FPS,
    canvasRect: rect,
    frame: () => frame,
    errors: () => r.errors(),
    stepTo(target: number) {
      if (!Number.isInteger(target) || target < frame || frameMs(target) > demo.durationMs) {
        throw new RangeError(`bad frame ${target}`);
      }
      while (frame < target) {
        frame++;
        demo.advanceTo(frameMs(frame));
        r.advance(frameMs(frame) - frameMs(frame - 1));
      }
      card?.();
    },
  };
}
