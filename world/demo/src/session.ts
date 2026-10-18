import type { Activity, AgentState, Choices, Counts, Ledger, Moment, NeedsYouReason,
  Provider, Snapshot, SnapshotAgent, Tool, World } from '../../../contracts/ts/src/types.ts';
import { VirtualTime } from '../../renderer/src/index.ts';
import { grow } from '../../grow/src/index.ts';
import { createSandbox, DEMO_DAY, emptyCounts } from './sandbox.ts';

export const DEMO_DURATION_MS = 120_000;
export const DEMO_SEED = 42;
/** 17:20 on 12 October 2026 on the viewer's own clock (not UTC), so the renderer's season and sky, and the "waiting" times on the card, do not depend on the time zone. */
export const DEMO_EPOCH = new Date(2026, 9, 12, 17, 20, 0).getTime();
export const demoDate = (elapsedMs: number): Date => new Date(DEMO_EPOCH + elapsedMs);

export interface DemoSink {
  setSnapshot(snapshot: Snapshot): void;
  pushMoment(moment: Moment): void;
  setWorld(world: World): void;
}

export interface DemoState {
  elapsedMs: number;
  snapshot: Snapshot;
  ledger: Ledger;
  choices: Choices;
  world: World;
}

export interface DemoSession {
  readonly seed: number;
  readonly durationMs: number;
  readonly clock: VirtualTime;
  readonly elapsedMs: number;
  connect(sink: DemoSink): () => void;
  advanceTo(ms: number): void;
  state(): DemoState;
}

const TOOLS = ['claude', 'codex', 'opencode', 'antigravity'] as const;
type MainTool = typeof TOOLS[number];
type AgentPatch = { activity?: Activity; reason?: NeedsYouReason };

/** All inputs are synthetic. This module and its sandbox have no filesystem or bridge API. */
export function createDemoSession(options: { seed?: number; edition?: 'full' | 'demo' } = {}): DemoSession {
  const seed = options.seed ?? DEMO_SEED;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new RangeError('seed must be a uint32');
  const edition = options.edition ?? 'full';
  if (edition !== 'full' && edition !== 'demo') throw new RangeError('edition must be full or demo');
  const clock = new VirtualTime(1000);
  const elapsed = () => clock.now() - 1000;
  const epoch = () => DEMO_EPOCH + Math.round(elapsed());
  const { ledger, choices } = createSandbox(seed, edition);
  const sinks = new Set<DemoSink>();
  const agents = new Map<string, SnapshotAgent>();
  const present = new Set<Tool>();
  const workMs = new Map<Tool, number>();
  const clone = <T>(value: T): T => structuredClone(value);
  // Seeded IDs also seed the renderer's scarf, pose phase and incidental motion.
  let random = seed || 0x6d2b79f5;
  const id = () => Array.from({ length: 4 }, () => {
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
    return (random >>> 0).toString(16).padStart(8, '0');
  }).join('');
  const roots = Object.fromEntries(TOOLS.map((tool) => [tool, id()])) as Record<MainTool, string>;
  const accounts = { claude: id(), codex: id() };
  const ids = Object.fromEntries(TOOLS.map((tool) => [tool, id()])) as Record<MainTool, string>;
  const helperId = id();
  let five = { claude: 72, codex: 52 };
  let weekly = 56;
  let snapshot: Snapshot;
  let world = grow(seed, ledger, choices, { edition });

  const counts = (tool: Tool): Counts => ledger.days[DEMO_DAY]![tool] ??= emptyCounts();
  const emitMoment = (m: Moment) => { for (const s of sinks) s.pushMoment(clone(m)); };

  function setAgent(tool: MainTool, state: AgentState, patch: AgentPatch = {}, helper = false): void {
    const agentId = helper ? helperId : ids[tool];
    const old = agents.get(agentId);
    const changed = !old || old.state !== state || old.reason !== patch.reason;
    const a: SnapshotAgent = {
      id: agentId, tool, host: 'cli', ordinal: helper ? 2 : 1, parent: helper ? ids.claude : null,
      root_id: roots[tool], account_id: tool === 'claude' || tool === 'codex' ? accounts[tool] : null,
      session_id: agentId, turn_id: old?.turn_id ?? id(), request_id: null,
      state, confidence: state === 'unknown' ? 'inferred' : 'exact',
      since: changed ? epoch() : old!.since, started_at: old?.started_at ?? epoch(),
    };
    if (state === 'working') a.activity = patch.activity ?? 'other';
    if (state === 'needs_you') {
      a.reason = patch.reason ?? 'permission';
      a.request_id = changed ? id() : old!.request_id;
    }
    if (state === 'limited') a.limited_until = DEMO_EPOCH + 46_000;
    agents.set(agentId, a);
    present.add(tool);
    if (!helper && !old) counts(tool).sessions++;
  }

  function emitSnapshot(): void {
    const list = [...agents.values()].map(clone);
    const waiting = list.filter((a) => a.state === 'needs_you');
    snapshot = {
      schema_version: 2, t: epoch(), demo: true, agents: list,
      tools: TOOLS.map((tool) => ({
        tool, root_id: roots[tool], presence: present.has(tool) ? 'present' : 'offline',
        hooks: tool === 'claude' || tool === 'codex' ? 'installed' : 'unsupported',
        coverage: tool === 'claude' || tool === 'codex' ? 'verified' : 'unsupported',
        coverage_reason: tool === 'claude' || tool === 'codex' ? null : 'experimental_adapter',
      })),
      limits: (['claude', 'codex'] as Provider[]).flatMap((provider) => [
        { provider, window: '5h' as const, account_id: accounts[provider], root_id: roots[provider],
          used_pct: five[provider], resets_at: DEMO_EPOCH + (provider === 'claude' ? 46_000 : 3_600_000),
          observed_at: epoch(), stale: false },
        { provider, window: 'weekly' as const, account_id: accounts[provider], root_id: roots[provider],
          used_pct: weekly, resets_at: DEMO_EPOCH + 7 * 86_400_000, observed_at: epoch(), stale: false },
      ]),
      attention: { needs_you: waiting.length, oldest_since: waiting.length ? Math.min(...waiting.map((a) => a.since)) : null },
    };
    for (const s of sinks) s.setSnapshot(clone(snapshot));
  }

  function updateWorld(): void {
    const next = grow(seed, ledger, choices, { edition });
    if (JSON.stringify(next) === JSON.stringify(world)) return;
    const prior = world;
    world = next;
    for (const s of sinks) s.setWorld(clone(world));
    for (const b of world.structures) {
      const before = prior.structures.find((p) => p.id === b.id);
      if (b.stage > (before?.stage ?? 0) && b.stage > 0) emitMoment({
        schema_version: 1, kind: 'build_complete', t: epoch(), structure: b.id, stage: b.stage as 1 | 2 | 3,
      });
    }
  }

  function advanceClock(to: number): void {
    const delta = to - elapsed();
    // Per-tool wall time: any number of helpers or concurrent sessions never multiply it.
    const working = new Set([...agents.values()].filter((a) => !a.parent && a.state === 'working').map((a) => a.tool));
    for (const tool of working) {
      workMs.set(tool, (workMs.get(tool) ?? 0) + delta);
      counts(tool).working_seconds = Math.floor(workMs.get(tool)! / 1000);
    }
    clock.advance(delta);
  }

  const notice = (kind: 'error' | 'recovered' | 'turn_end', tool: MainTool) => {
    emitMoment(kind === 'turn_end'
      ? { schema_version: 1, kind, t: epoch(), agent: ids[tool], tool, turn_ms: 16_000 }
      : { schema_version: 1, kind, t: epoch(), agent: ids[tool], tool });
  };
  const needs = (tool: MainTool, reason: NeedsYouReason) => {
    setAgent(tool, 'needs_you', { reason });
    counts(tool).needs_you++;
    emitMoment({ schema_version: 1, kind: 'needs_you', t: epoch(), agent: ids[tool], tool,
      reason, request_id: agents.get(ids[tool])!.request_id! });
  };
  const answer = (tool: MainTool) => {
    emitMoment({ schema_version: 1, kind: 'answered', t: epoch(), agent: ids[tool], tool,
      request_id: agents.get(ids[tool])!.request_id! });
    setAgent(tool, 'working', { activity: 'edit' });
  };
  const beats: { at: number; run(): void }[] = [
    { at: 1000, run() { for (const tool of TOOLS) setAgent(tool, 'starting'); } },
    { at: 4000, run() {
      setAgent('claude', 'working', { activity: 'edit' }); setAgent('codex', 'working', { activity: 'shell' });
      setAgent('opencode', 'working', { activity: 'read' }); setAgent('antigravity', 'working', { activity: 'web' });
    } },
    // The store loop is the window 10 s to 20 s. It opens as the frog (who lives beside the bell post, so
    // the ambient camera keeps the post in frame) raises the flag; a finished turn then completes a building.
    { at: 10_000, run() { needs('opencode', 'question'); } },
    { at: 14_000, run() { answer('opencode'); } },
    { at: 15_000, run() { notice('turn_end', 'claude'); counts('claude').turns++; setAgent('claude', 'your_turn'); } },
    { at: 21_000, run() { setAgent('claude', 'working', { activity: 'read' }); } },
    { at: 30_000, run() { counts('codex').errors++; notice('error', 'codex'); setAgent('codex', 'error'); } },
    { at: 34_000, run() { counts('codex').recovered++; notice('recovered', 'codex'); setAgent('codex', 'working', { activity: 'shell' }); } },
    { at: 38_000, run() {
      counts('claude').limit_hits++; five = { claude: 100, codex: 68 }; weekly = 82;
      emitMoment({ schema_version: 1, kind: 'limit_hit', t: epoch(), provider: 'claude', agent: ids.claude, tool: 'claude' });
      setAgent('claude', 'limited');
    } },
    { at: 46_000, run() {
      // A new good sample clears limited. Passing a reset time by itself never clears it.
      five = { claude: 3, codex: 16 }; weekly = 36;
      emitMoment({ schema_version: 1, kind: 'limit_reset', t: epoch(), provider: 'claude' });
      setAgent('claude', 'working', { activity: 'shell' });
    } },
    { at: 52_000, run() { needs('codex', 'permission'); } },
    { at: 58_000, run() { answer('codex'); } },
    { at: 62_000, run() {
      setAgent('claude', 'working', { activity: 'delegate' }); setAgent('claude', 'working', { activity: 'edit' }, true);
      emitMoment({ schema_version: 1, kind: 'milestone', t: epoch(), milestone: 'first_subagent' });
    } },
    { at: 68_000, run() { counts('claude').subagent_turns++; agents.delete(helperId); } },
    { at: 72_000, run() { notice('turn_end', 'codex'); counts('codex').turns++; setAgent('codex', 'your_turn'); } },
    { at: 76_000, run() { for (const tool of TOOLS) setAgent(tool, 'idle'); five = { claude: 70, codex: 64 }; } },
    { at: 86_000, run() { setAgent('codex', 'unknown'); } },
    { at: 94_000, run() { agents.delete(ids.antigravity); present.delete('antigravity'); } },
    { at: 100_000, run() { agents.clear(); present.clear(); } },
    { at: 110_000, run() {
      // No live sessions: known tools potter by the fixed evening clock, without usage data.
      for (const tool of TOOLS) present.add(tool);
    } },
  ];
  let nextBeat = 0;
  emitSnapshot();

  return {
    seed, durationMs: DEMO_DURATION_MS, clock,
    get elapsedMs() { return elapsed(); },
    connect(sink) {
      sinks.add(sink); sink.setWorld(clone(world)); sink.setSnapshot(clone(snapshot));
      return () => { sinks.delete(sink); };
    },
    advanceTo(ms) {
      if (!Number.isFinite(ms) || ms < elapsed() || ms > DEMO_DURATION_MS) {
        throw new RangeError('demo time must move forward between 0 and 120000 ms');
      }
      while (nextBeat < beats.length && beats[nextBeat]!.at <= ms) {
        const beat = beats[nextBeat++]!;
        advanceClock(beat.at); beat.run(); updateWorld(); emitSnapshot(); clock.advance(0);
      }
      advanceClock(ms); updateWorld(); clock.advance(0);
    },
    state() { return clone({ elapsedMs: elapsed(), snapshot, ledger, choices, world }); },
  };
}
