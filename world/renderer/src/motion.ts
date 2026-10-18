/**
 * Motion vocabulary: stepped puppet loops (SPEC 3.5). Characters change pose on 12 fps steps, like
 * stop-motion cutout animation; every loop is a beat sheet of [pose, seconds] pairs. Each resident
 * plays its loops with a seeded phase offset and a +-10% tempo so no two residents move in sync
 * ("slow world, fast alert": idle loops run 6 to 12 s, work loops 2 to 5 s, the alert is the only
 * fast motion).
 */

export type Beat = [pose: string, seconds: number];
export type Loop = readonly Beat[];

/** Character time advances in 12 fps steps. */
export const STEP = 1 / 12;
export const quantize = (t: number) => Math.floor(t / STEP + 1e-6) * STEP;

const rep = (n: number, beats: Beat[]): Beat[] => Array.from({ length: n }, () => beats).flat();

/** Work loops by activity (SPEC 4.2: the variant comes from the tool name only). */
export const WORK: Record<string, Loop> = {
  // shell: hammering, two strikes and a look
  shell: [...rep(3, [['hammer-0', 0.36], ['hammer-1', 0.14]]), ['stand-0', 0.55], ...rep(2, [['hammer-0', 0.36], ['hammer-1', 0.14]]), ['stand-1', 0.17], ['stand-0', 0.7]],
  // edit, write, apply_patch: sawing planks
  edit: [...rep(4, [['saw-0', 0.26], ['saw-1', 0.26]]), ['stand-0', 0.6], ...rep(3, [['saw-0', 0.26], ['saw-1', 0.26]]), ['stand-1', 0.17], ['stand-0', 0.5]],
  // read, grep, search: reading a scroll at the noticeboard
  read: [['read-0', 2.4], ['stand-1', 0.17], ['read-0', 1.7], ['stand-0', 0.8]],
  // web: a spyglass toward the river
  web: [['spyglass-0', 2.8], ['stand-0', 0.7], ['spyglass-0', 1.9], ['stand-1', 0.17], ['stand-0', 0.5]],
  // launching a subagent: a whistle
  delegate: [['whistle-0', 0.9], ['stand-0', 1.6], ['whistle-0', 0.6], ['stand-0', 2.2]],
  // anything else: the species' signature loop (sawing, stone cracking, inking, hauling)
  other: [...rep(3, [['work-0', 0.32], ['work-1', 0.32]]), ['stand-0', 0.75], ...rep(2, [['work-0', 0.32], ['work-1', 0.32]]), ['stand-1', 0.17], ['stand-0', 0.45]],
};

export const LOOPS = {
  sweep: [...rep(4, [['sweep-0', 0.5], ['sweep-1', 0.5]]), ['stand-0', 1.8], ['stand-1', 0.17], ['stand-0', 1.3]] as Loop,
  garden: [['garden-0', 1.1], ['garden-1', 1.7], ['garden-0', 0.9], ['garden-1', 1.2], ['stand-0', 1.6], ['stand-1', 0.17], ['stand-0', 0.9]] as Loop,
  stand: [['stand-0', 3.2], ['stand-1', 0.17], ['stand-0', 2.6], ['stand-1', 0.17]] as Loop,
  sit: [['sit-0', 9]] as Loop,
  sleep: [['sleep-0', 12]] as Loop,
  yourTurn: [['sit-lantern-0', 12]] as Loop,
  worried: [['worried-0', 1.4], ['worried-1', 1.1], ['worried-0', 0.9], ['worried-1', 1.6]] as Loop,
  tea: [['tea-0', 12]] as Loop,
  /** waiting at the bell: arm on the rope, one gentle bob every 8 s (SPEC 3.5) */
  waitBell: [['ring-1', 7.6], ['ring-0', 0.2], ['ring-1', 0.2]] as Loop,
  ring: [['ring-0', 0.17], ['ring-1', 0.17]] as Loop,
  cheer: [['cheer-0', 0.25], ['cheer-1', 0.17], ['cheer-0', 0.25], ['cheer-1', 0.53]] as Loop,
  stretch: [['stretch-0', 1.25], ['stand-1', 0.17], ['stand-0', 0.6]] as Loop,
  turn: [['turn-0', 0.15]] as Loop,
  walk: [['walk-0', 0.2], ['walk-1', 0.2]] as Loop,
  run: [['run-0', STEP], ['run-1', STEP], ['run-2', STEP]] as Loop,
  helperWork: [['work-0', 0.34], ['work-1', 0.34], ['work-0', 0.34], ['work-1', 0.34], ['stand-0', 0.9]] as Loop,
  helperIdle: [['stand-0', 4]] as Loop,
};

export function loopLength(loop: Loop): number {
  let s = 0;
  for (const [, d] of loop) s += d;
  return s;
}

/** Pose of a loop at local time tau (seconds since the loop started), tempo-scaled. */
export function poseAt(loop: Loop, tau: number, tempo = 1): string {
  const len = loopLength(loop);
  let u = (((tau * tempo) % len) + len) % len;
  for (const [pose, d] of loop) {
    if (u < d) return pose;
    u -= d;
  }
  return loop[loop.length - 1][0];
}

/** Pose of a one-shot sequence (clamps to its last beat), and whether it has finished. */
export function onceAt(loop: Loop, tau: number): { pose: string; done: boolean } {
  let u = Math.max(0, tau);
  for (const [pose, d] of loop) {
    if (u < d) return { pose, done: false };
    u -= d;
  }
  return { pose: loop[loop.length - 1][0], done: true };
}

/** Walking pace in units per second (a 24-unit resident, two steps a second). */
export const WALK_SPEED = 15;

/** The 600 ms run of the alert (SPEC 3.5), kept between sensible speeds for very short or long dashes. */
export function runSpeed(distance: number): number {
  return Math.max(110, Math.min(260, distance / 0.6));
}

export const ease = {
  outCubic: (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3),
  inOutSine: (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, t))),
  outBack: (t: number) => {
    const c = 1.70158;
    const x = Math.max(0, Math.min(1, t)) - 1;
    return 1 + (c + 1) * x * x * x + c * x * x;
  },
};
