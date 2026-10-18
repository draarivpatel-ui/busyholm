// Unit tests for the pure view-model (ui/src/ui/model.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../src/ui/model.js';

const A = (o) => ({ id: 'a'.repeat(32), tool: 'claude', host: 'cli', ordinal: 1, parent: null, state: 'idle', confidence: 'exact', since: 0, started_at: 0, ...o });

test('needs-you sorts first, longest waiting first, then error, your turn, working', () => {
  const s = M.sortAgents([A({ id: '1', state: 'working' }), A({ id: '2', state: 'needs_you', since: 50, reason: 'question' }), A({ id: '3', state: 'error' }), A({ id: '4', state: 'needs_you', since: 10, reason: 'permission' }), A({ id: '5', state: 'your_turn' }), A({ id: '6', state: 'idle', parent: '1' })]);
  assert.deepEqual(s.map((a) => a.id), ['4', '2', '3', '5', '1']);
});

test('project names only with the opt-in', () => {
  const a = A({ project_label: 'secret-project', ordinal: 2 });
  const off = M.agentNames(a, { privacy: { project_names: false } }, { claude: 2 });
  assert.equal(off.primary, 'Claude Code 2');
  assert.ok(!JSON.stringify(off).includes('secret-project'));
  assert.ok(!JSON.stringify(M.agentNames(a, undefined, {})).includes('secret-project'));
  const on = M.agentNames(a, { privacy: { project_names: true } }, { claude: 2 });
  assert.equal(on.primary, 'secret-project');
  assert.equal(on.secondary, 'Claude Code 2');
});

test('state text is never colour alone: every state has a label and an icon', () => {
  for (const state of ['starting', 'working', 'needs_you', 'your_turn', 'error', 'limited', 'idle', 'unknown']) {
    const i = M.stateInfo(A({ state, reason: 'permission' }), 0);
    assert.ok(i.label && i.icon && i.tone, state);
  }
  assert.equal(M.stateInfo(A({ state: 'needs_you', reason: 'question' }), 0).label, 'Asked you a question');
  assert.match(M.stateInfo(A({ state: 'needs_you', reason: 'permission', confidence: 'inferred' }), 0).label, /May still/);
});

test('limits stay per account and warn at 80 and 95 percent', () => {
  const snap = { limits: [
    { provider: 'claude', window: '5h', account_id: 'b'.repeat(32), root_id: 'r'.repeat(32), used_pct: 96, resets_at: 3600000, observed_at: 0, stale: false },
    { provider: 'claude', window: '5h', account_id: 'c'.repeat(32), root_id: 'r'.repeat(32), used_pct: 81, resets_at: 3600000, observed_at: 0, stale: true },
    { provider: 'codex', window: 'weekly', account_id: null, root_id: 'r'.repeat(32), used_pct: 10, resets_at: 3600000, observed_at: 0, stale: false },
  ] };
  const items = M.limitItems(snap, 0);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.severity), ['critical', 'warning', 'normal']);
  assert.deepEqual(items.map((i) => i.provider), ['Claude 1', 'Claude 2', 'Codex']);
  assert.ok(items[1].staleText);
});

test('coverage names: verified, degraded with the reason, unsupported', () => {
  const items = M.coverageItems({ tools: [
    { tool: 'claude', root_id: 'x', presence: 'present', hooks: 'installed', coverage: 'verified', coverage_reason: null },
    { tool: 'codex', root_id: 'y', presence: 'present', hooks: 'pending_review', coverage: 'degraded', coverage_reason: 'hooks_pending_review' },
    { tool: 'antigravity', root_id: 'z', presence: 'offline', hooks: 'unsupported', coverage: 'unsupported', coverage_reason: 'no_permission_event' },
  ] });
  assert.deepEqual(items.map((i) => i.stateName), ['Alerts on', 'Activity only', 'Not supported here']);
  assert.match(items[1].detail, /\/hooks/);
  assert.match(items[2].detail, /^Not running/);
  assert.equal(M.coverageSummary(items).text, 'Alerts on for 1 of 3');
});

test('durations and countdowns', () => {
  assert.equal(M.shortDuration(30000), 'now');
  assert.equal(M.shortDuration(4 * 60000), '4m');
  assert.equal(M.shortDuration(72 * 60000), '1h 12m');
  assert.equal(M.longDuration(61 * 60000), '1 hour 1 minute');
  assert.equal(M.countdown(138 * 60000), '2h 18m');
  assert.equal(M.countdown(52 * 3600000), '2d 4h');
});

test('island progress: current build, tier, and what today added', () => {
  const world = { tier: 'hamlet', earned: { planks: 30, stone: 9, seeds: 2 }, structures: [{ id: 'well', status: 'complete', stage: 3, progress: 1 }, { id: 'workshop_1', variant: 'codex', status: 'building', stage: 1, progress: 0.4 }], demo_capped: false };
  const before = { ...world, earned: { planks: 24, stone: 9, seeds: 2 } };
  const p = M.progressInfo(world, before);
  assert.equal(p.building.name, 'Stone yard');
  assert.equal(p.building.detail, 'Stage 2 of 3');
  assert.equal(p.tier, 'Hamlet');
  assert.equal(M.todayText(p.today), 'Today +6 planks');
});
