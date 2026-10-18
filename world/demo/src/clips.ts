/** Capture clips: windows into the scenario/demo on the 30 fps frame grid (frame n is at n * 1000 / 30 ms). */
export const FPS = 30;

export interface ClipSpec {
  startMs: number;
  durationMs: number;
}

export const CLIPS: Record<string, ClipSpec> = {
  // Classic 10 s store loop
  loop: { startMs: 10_000, durationMs: 10_000 },
  // Full 60 s trailer scenario
  trailer: { startMs: 0, durationMs: 60_000 },
  // Individual beats
  beat1_desktop: { startMs: 0, durationMs: 7_000 },
  beat2_working: { startMs: 7_000, durationMs: 7_000 },
  beat3_needs_you: { startMs: 14_000, durationMs: 8_000 },
  beat4_answer_build: { startMs: 22_000, durationMs: 8_000 },
  beat5_sky: { startMs: 30_000, durationMs: 7_000 },
  beat6_limit_rain: { startMs: 37_000, durationMs: 8_000 },
  beat7_ambient: { startMs: 45_000, durationMs: 7_000 },
  beat8_timelapse: { startMs: 52_000, durationMs: 6_000 },
  beat9_title: { startMs: 58_000, durationMs: 2_000 },
};

export const frameMs = (frame: number): number => (frame * 1000) / FPS;
