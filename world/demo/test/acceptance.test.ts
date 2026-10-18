import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_STATES } from '../../../contracts/ts/src/types.ts';
import { assertValid } from '../../../contracts/ts/src/validate.ts';
import { grow } from '../../grow/src/index.ts';
import { createRenderer } from '../../renderer/src/index.ts';
import { createDemoSession, DEMO_DURATION_MS, DEMO_EPOCH } from '../src/session.ts';
import { drawEndCard, endCardLines } from '../src/end-card.ts';
// @ts-expect-error Node capture tools are plain ESM.
import { captureClip } from '../tools/capture-lib.mjs';

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('(1) the 120 s demo visits every state and visibly renders the required cues', () => {
  const demo = createDemoSession({ seed: 42 });
  assert.equal(demo.durationMs, DEMO_DURATION_MS);
  const r = createRenderer({
    surface: 'strip', width: 1440, height: 120, dpr: 1, debug: true,
    seed: demo.seed, clock: demo.clock, scheduler: demo.clock,
    date: () => new Date(DEMO_EPOCH + demo.elapsedMs),
  });
  const states = new Set<string>();
  const tools = new Set<string>();
  const kinds = new Set<string>();
  demo.connect({
    setSnapshot(s) {
      assertValid('snapshot', s);
      assert.equal(s.demo, true);
      for (const a of s.agents) { states.add(a.state); tools.add(a.tool); }
      for (const t of s.tools) if (t.presence === 'offline') states.add('offline');
      r.setSnapshot(s);
    },
    pushMoment(m) { assertValid('moment', m); kinds.add(m.kind); r.pushMoment(m); },
    setWorld(w) { assertValid('world', w); r.setWorld(w); },
  });
  try {
    for (let ms = 0; ms <= DEMO_DURATION_MS; ms += 50) demo.advanceTo(ms);
    for (const state of [...AGENT_STATES, 'offline']) assert.ok(states.has(state), `missing ${state}`);
    for (const tool of ['claude', 'codex', 'opencode', 'antigravity']) assert.ok(tools.has(tool), `missing ${tool}`);
    for (const kind of ['needs_you', 'answered', 'turn_end', 'error', 'recovered', 'limit_hit', 'limit_reset', 'build_complete', 'milestone']) {
      assert.ok(kinds.has(kind), `missing ${kind} Moment`);
    }
    const frames = r.debugLog();
    assert.ok(frames.some((f) => f.flag.raised && f.flag.ringing), 'flag and bell visible');
    for (const icon of ['permission', 'question']) assert.ok(frames.some((f) => f.flag.raised && f.flag.icon === icon), `${icon} flag`);
    for (const fx of ['plank', 'dust', 'confetti', 'shower', 'sunrise']) assert.ok(frames.some((f) => f.fx.includes(fx)), `missing ${fx}`);
    assert.ok(frames.some((f) => f.residents.some((a) => a.intent === 'celebrate' && a.anim === 'cheer')));
    assert.ok(frames.some((f) => f.residents.some((a) => a.helper)), 'subagent helper');
    assert.ok(frames.some((f) => f.residents.some((a) => a.faded)), 'unknown is faded');
    assert.deepEqual(r.errors(), []);
    const final = demo.state();
    assertValid('ledger', final.ledger);
    assertValid('choices', final.choices);
    assert.equal(final.ledger.backfill, null);
    assert.deepEqual(final.world, grow(demo.seed, final.ledger, final.choices));
    assert.throws(() => demo.advanceTo(-1));
    assert.throws(() => demo.advanceTo(DEMO_DURATION_MS + 1));
  } finally { r.destroy(); }
});

test('(2) a complete demo leaves the real ledger and choices byte-identical in a temp data folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'busyholm-wp13-data-'));
  const ledgerPath = join(dir, 'ledger.json');
  const choicesPath = join(dir, 'choices.json');
  // Synthetic canaries, deliberately not JSON: any accidental real-ledger load fails.
  writeFileSync(ledgerPath, 'SYNTHETIC_REAL_LEDGER_CANARY\n');
  writeFileSync(choicesPath, 'SYNTHETIC_REAL_CHOICES_CANARY\n');
  const before = [sha(readFileSync(ledgerPath)), sha(readFileSync(choicesPath))];
  try {
    const report = JSON.parse(execFileSync(process.execPath, [join(ROOT, 'tools/run-demo.mjs'), '--seed', '42'], {
      env: { ...process.env, BUSYHOLM_DATA_DIR: dir }, encoding: 'utf8', timeout: 30_000,
    }));
    assert.equal(report.elapsedMs, DEMO_DURATION_MS);
    assert.ok(report.world.stats.lifetime_turns > 0);
    assert.deepEqual([sha(readFileSync(ledgerPath)), sha(readFileSync(choicesPath))], before);
    assert.deepEqual(readdirSync(dir).sort(), ['choices.json', 'ledger.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('(3) PNG frames at 2, 4, 6 and 8 s have identical SHA-256 hashes in two independent captures', { timeout: 120_000 }, async () => {
  const sampleTimesMs = [2000, 4000, 6000, 8000];
  const out = join(ROOT, 'captures', 'verification');
  const a = await captureClip({ clip: 'loop', view: 'ambient', outDir: join(out, 'run-a'), sampleTimesMs });
  const b = await captureClip({ clip: 'loop', view: 'ambient', outDir: join(out, 'run-b'), sampleTimesMs });
  assert.equal(a.fps, 30);
  assert.equal(a.durationMs, 10_000);
  assert.equal(a.frames.length, 4);
  const hashes = new Set();
  for (let i = 0; i < sampleTimesMs.length; i++) {
    assert.equal(a.frames[i].timeMs, sampleTimesMs[i]);
    assert.equal(b.frames[i].timeMs, sampleTimesMs[i]);
    const bytesA = readFileSync(a.frames[i].path);
    const bytesB = readFileSync(b.frames[i].path);
    assert.equal(bytesA.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.deepEqual(bytesA, bytesB, `different PNG at ${sampleTimesMs[i]} ms`);
    assert.equal(a.frames[i].sha256, sha(bytesA));
    assert.equal(b.frames[i].sha256, sha(bytesB));
    hashes.add(sha(bytesA));
  }
  assert.equal(hashes.size, 4, 'key frames must show four different scenes');
});

test('(4) every end-card text draw comes from the fixed numeric counts template', () => {
  const counts = { activeDays: 7, turns: 123, buildings: 8, tools: 2 };
  const expected = ['Busyholm', 'Demo', '7 active days', '123 completed turns', '8 buildings', '2 tools'];
  assert.deepEqual(endCardLines(counts), expected);
  const drawn: string[] = [];
  // Strengthened: any other way to put text or an image on the card is recorded and rejected.
  const other: string[] = [];
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get(_target, key) {
      if (key === 'fillText') return (text: string) => drawn.push(text);
      if (key === 'strokeText' || key === 'drawImage' || key === 'putImageData' || key === 'createPattern' || key === 'createImageData') return () => { other.push(String(key)); };
      return () => undefined;
    },
    set() { return true; },
  });
  drawEndCard(ctx, counts);
  assert.deepEqual(drawn, expected);
  assert.deepEqual(other, [], 'the end card may only draw its template with fillText');
  // Counts change only the digits: the non-digit text is identical for any numbers.
  const other2 = endCardLines({ activeDays: 1, turns: 9999, buildings: 0, tools: 6 });
  assert.deepEqual(other2.map((l) => l.replace(/\d+/g, '#')), expected.map((l) => l.replace(/\d+/g, '#')));
  for (const invalid of [
    { ...counts, turns: 'FREE_TEXT_CANARY' }, { ...counts, turns: NaN },
    { ...counts, activeDays: -1 }, { ...counts, tools: 2.5 },
    { ...counts, title: 'FREE_TEXT_CANARY' }, { ...counts, buildings: 1_000_000_001 },
  ]) assert.throws(() => endCardLines(invalid as unknown as typeof counts));
});

test('(5) strengthened: demo modules have no file, network, process or data-folder access and no real-ledger names', () => {
  // Test 2 alone cannot fail for a run-demo that never looks at the data folder. This pins the stronger
  // property: the demo's own source cannot reach a real ledger, wherever the data folder is.
  const files = ['src/session.ts', 'src/sandbox.ts', 'src/end-card.ts', 'src/clips.ts', 'tools/run-demo.mjs']
    .map((f) => [f, readFileSync(join(ROOT, f), 'utf8')] as const);
  for (const [name, text] of files) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /from ['"]node:(fs|net|http|https|child_process|os|dgram|dns|tls|worker_threads)|require\(|fetch\(|XMLHttpRequest|WebSocket|homedir|process\.env|BUSYHOLM_DATA_DIR|ledger\.json|choices\.json|\/\.claude|\/\.codex|local\/share|bh_get_world_inputs/, `${name} must stay offline and sandboxed`);
  }
});

test('(6) the end-card PNG is 1920 x 1080, byte-identical across two renders, and made only from counts', { timeout: 120_000 }, async () => {
  // @ts-expect-error Node capture tools are plain ESM.
  const { captureEndCard } = await import('../tools/capture-lib.mjs');
  const counts = { activeDays: 5, turns: 110, buildings: 11, tools: 4 };
  const dir = mkdtempSync(join(tmpdir(), 'busyholm-wp13-card-'));
  try {
    const a = await captureEndCard({ counts, outPath: join(dir, 'a.png') });
    const b = await captureEndCard({ counts, outPath: join(dir, 'b.png') });
    const bytes = readFileSync(a.path);
    assert.deepEqual(bytes, readFileSync(b.path));
    assert.equal(bytes.readUInt32BE(16), 1920);
    assert.equal(bytes.readUInt32BE(20), 1080);
    await assert.rejects(captureEndCard({ counts: { ...counts, turns: 'x' }, outPath: join(dir, 'c.png') }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
