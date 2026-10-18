import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Typescript will resolve when created.
import {
  VIDEO_SCENARIO,
  VIDEO_SCENARIO_DURATION_MS,
  createVideoScenarioSession,
  drawScenarioEndCard,
  generateThreeWeekTimelapseDays,
  scenarioEndCardLines,
} from '../src/scenario.ts';
// @ts-expect-error Node capture tools are plain ESM.
import { captureClip } from '../tools/capture-lib.mjs';

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('(1) video scenario has duration between 45s and 75s and covers every required beat', () => {
  assert.ok(
    VIDEO_SCENARIO_DURATION_MS >= 45_000 && VIDEO_SCENARIO_DURATION_MS <= 75_000,
    `duration ${VIDEO_SCENARIO_DURATION_MS} ms must be between 45s and 75s`
  );

  const beatIds = VIDEO_SCENARIO.shots.map((s: { id: string }) => s.id);
  const requiredBeats = [
    'desktop',
    'working',
    'needs_you',
    'answer_build',
    'sky',
    'limit_rain',
    'ambient',
    'timelapse',
    'title',
  ];
  for (const beat of requiredBeats) {
    assert.ok(beatIds.includes(beat), `missing required beat: ${beat}`);
  }

  // Check on-screen text length (under 7 words) and no em/en dashes
  for (const shot of VIDEO_SCENARIO.shots) {
    if (shot.caption) {
      const words = shot.caption.trim().split(/\s+/);
      assert.ok(
        words.length > 0 && words.length < 7,
        `caption "${shot.caption}" has ${words.length} words; must be under 7 words`
      );
      assert.doesNotMatch(shot.caption, /[\u2013\u2014]/, `caption "${shot.caption}" contains em or en dash`);
    }
  }

  // P1-3: ambient caption must not promise an automatic idle trigger ("when away")
  const ambientShot = VIDEO_SCENARIO.shots.find((s: { id: string }) => s.id === 'ambient');
  assert.ok(ambientShot && ambientShot.caption, 'ambient shot has a caption');
  assert.doesNotMatch(ambientShot.caption, /when away|idle|auto/i, 'ambient caption must not promise an automatic trigger');
  assert.equal(ambientShot.caption, 'Fullscreen ambient view from the tray');

  // Check STORYBOARD.md exists and contains zero em or en dashes and no "when away" caption
  const storyboardPath = join(ROOT, 'STORYBOARD.md');
  assert.ok(existsSync(storyboardPath), 'STORYBOARD.md must exist in world/demo');
  const storyboardText = readFileSync(storyboardPath, 'utf8');
  assert.doesNotMatch(storyboardText, /[\u2013\u2014]/, 'STORYBOARD.md contains em or en dash');
  assert.doesNotMatch(storyboardText, /Fullscreen ambient view when away/i, 'STORYBOARD.md must not promise automatic trigger');
});

test('(2) three-week timelapse advances from founding camp to village using grow() states', () => {
  const days = generateThreeWeekTimelapseDays(42);
  assert.ok(days.length >= 20 && days.length <= 25, `expected ~3 weeks (20-25 days), got ${days.length}`);

  // Day 1: founding camp
  const first = days[0]!;
  assert.equal(first.n, 1);
  assert.equal(first.world.tier, 'camp');
  assert.ok(first.world.structures.length > 0);

  // Hamlet reached by week 1 (day 4 to 7)
  const hamletDay = days.find((d: { world: { tier: string } }) => d.world.tier === 'hamlet');
  assert.ok(hamletDay !== undefined && hamletDay.n <= 7, `hamlet reached on day ${hamletDay?.n}`);

  // Village reached by ~3 weeks (day 18 to 25)
  const last = days[days.length - 1]!;
  assert.equal(last.world.tier, 'village');
  const progressionComplete = last.world.structures.filter(
    (s: { status: string; id: string }) => s.status === 'complete' && s.id !== 'campfire' && s.id !== 'tent' && s.id !== 'bell_post'
  ).length;
  assert.equal(progressionComplete, 12);
});

test('(3) scenario session visits all required cues and states', () => {
  const session = createVideoScenarioSession({ seed: 42 });
  assert.equal(session.durationMs, VIDEO_SCENARIO_DURATION_MS);

  const kinds = new Set<string>();
  session.connect({
    setSnapshot() {},
    pushMoment(m: { kind: string }) {
      kinds.add(m.kind);
    },
    setWorld() {},
  });

  for (let ms = 0; ms <= VIDEO_SCENARIO_DURATION_MS; ms += 100) {
    session.advanceTo(ms);
  }

  // Required moments: needs_you, answered, build_complete, limit_hit
  for (const expectedKind of ['needs_you', 'answered', 'build_complete', 'limit_hit']) {
    assert.ok(kinds.has(expectedKind), `missing moment kind: ${expectedKind}`);
  }
});

test('(4) scenario frames at 4 chosen times have identical SHA-256 hashes across two runs', { timeout: 180_000 }, async () => {
  const sampleTimesMs = [5_000, 18_000, 26_000, 40_000];
  const out = join(ROOT, 'captures', 'verification-scenario');

  const runA = await captureClip({
    clip: 'trailer',
    view: 'trailer',
    outDir: join(out, 'run-a'),
    sampleTimesMs,
  });
  const runB = await captureClip({
    clip: 'trailer',
    view: 'trailer',
    outDir: join(out, 'run-b'),
    sampleTimesMs,
  });

  assert.equal(runA.frames.length, 4);
  assert.equal(runB.frames.length, 4);

  const hashes = new Set<string>();
  for (let i = 0; i < sampleTimesMs.length; i++) {
    assert.equal(runA.frames[i].timeMs, sampleTimesMs[i]);
    assert.equal(runB.frames[i].timeMs, sampleTimesMs[i]);

    const bytesA = readFileSync(runA.frames[i].path);
    const bytesB = readFileSync(runB.frames[i].path);

    // Valid PNG signature
    assert.equal(bytesA.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.deepEqual(bytesA, bytesB, `frames differ at ${sampleTimesMs[i]} ms`);
    assert.equal(runA.frames[i].sha256, sha(bytesA));
    assert.equal(runB.frames[i].sha256, sha(bytesB));
    hashes.add(sha(bytesA));
  }

  assert.equal(hashes.size, 4, 'the 4 chosen frames must be distinct scenes');
});

test('(5) B1 scenario end card shows the name, one line, macOS, about $5, and Sample data', () => {
  const lines = scenarioEndCardLines();
  assert.deepEqual(lines, [
    'Busyholm',
    'A papercut island that raises a flag when your agent needs you',
    'macOS',
    'about $5',
    'Sample data',
  ]);
  const drawn: string[] = [];
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get(_target, key) {
      if (key === 'fillText') return (text: string) => drawn.push(text);
      return () => undefined;
    },
    set() {
      return true;
    },
  });
  drawScenarioEndCard(ctx, 1920, 1080);
  assert.deepEqual(drawn, lines);
  for (const line of drawn) {
    assert.doesNotMatch(line, /[\u2013\u2014]/, 'end card line must not contain em or en dash');
    assert.doesNotMatch(line, /second|instant|ms\b/i, 'end card line must not promise specific latency');
  }
});

