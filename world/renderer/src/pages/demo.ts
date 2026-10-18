/**
 * The scripted 20-second sequence for captures (SPEC 3.7 storyboard, WP-10 brief):
 * golden hour on a working hamlet; a beaver starts work; the otter needs you (bell, flag, run);
 * you answer; another beaver finishes a turn, a plank arcs onto the half-built watermill, which
 * completes with a dust puff and starts turning; Codex hits its limit as the 5-hour window nears
 * its end: dusk falls, clouds come over, a shower over the stone yard, lamps light.
 *
 * Worlds come from WP-08's grow() over a synthetic, counts-only ledger, so the capture shows a
 * village the real economy would build.
 */
import { grow } from '../../../grow/src/index.ts';
import type { Ledger, Choices, World, Snapshot, SnapshotAgent, SnapshotLimit, Moment, Tool } from '../../../../contracts/ts/src/types.ts';

export const DEMO_SEED = 20261012;
/** 2026-10-12 17:20 local: the clock and every snapshot time derive from this plus virtual time. */
export const BASE_DATE = new Date(2026, 9, 12, 17, 20, 0).getTime();

function day(i: number): string {
  const d = new Date(Date.UTC(2026, 9, 1 + i));
  return d.toISOString().slice(0, 10);
}

const counts = (turns: number, secs: number) => ({ turns, interrupted_turns: 0, sessions: 2, working_seconds: secs, needs_you: 3, errors: 0, recovered: 0, limit_hits: 0, subagent_turns: 1 });

/** A counts-only ledger of n active days, Claude and Codex. */
function ledger(n: number): Ledger {
  const days: Ledger['days'] = {};
  for (let i = 0; i < n; i++) days[day(i)] = { claude: counts(18, 6600), codex: counts(9, 3600) };
  return { schema_version: 1, privacy: { containsText: false }, seed: DEMO_SEED, founded_day: day(0), hooks_first_connected_day: day(0), days, backfill: null };
}

const CHOICES: Choices = {
  schema_version: 1,
  privacy: { containsText: false },
  log: [
    {
      t: BASE_DATE - 86400000 * 10,
      day: day(0),
      kind: 'build_order',
      order: ['noticeboard', 'workshop_1', 'well', 'cottage_1', 'crossing', 'workshop_2', 'garden_plots', 'cottage_2', 'watermill', 'bell_tower', 'bakery', 'market_hall'],
    },
  ],
};

/** The hamlet before and after the finishing turn: the watermill at stage 2, then (next day) complete. */
export function demoWorlds(): { before: World; after: World } {
  for (let n = 3; n < 30; n++) {
    const before = grow(DEMO_SEED, ledger(n), CHOICES);
    const mill = before.structures.find((s) => s.id === 'watermill');
    if (!mill || mill.status !== 'building' || mill.stage !== 2) continue;
    const after = grow(DEMO_SEED, ledger(n + 1), CHOICES);
    if (after.structures.find((s) => s.id === 'watermill')?.status === 'complete') return { before, after };
  }
  throw new Error('demo: no ledger gives a half-built watermill');
}

const ROOT: Partial<Record<Tool, string>> = {
  claude: '5c96dbc2661405adf9ab0e86e0eef50b',
  codex: '5e1805de3c344b54fb9b24e1e1b20045',
  opencode: '6a1805de3c344b54fb9b24e1e1b20046',
};
const ACCOUNT = '2f7339c66415277e5b58670b67b979a9';
export const IDS = {
  beaver1: 'a1c0ffee000000000000000000000001',
  otter: 'b2c0ffee000000000000000000000002',
  beaver2: 'c3c0ffee000000000000000000000003',
  helper: 'd4c0ffee000000000000000000000004',
  frog: 'e5c0ffee000000000000000000000005',
};

type St = SnapshotAgent['state'];
interface AgentSpec {
  id: string;
  tool: Tool;
  ordinal: number;
  state: St;
  parent?: string;
  activity?: SnapshotAgent['activity'];
  reason?: SnapshotAgent['reason'];
  limited_until?: number;
}

function snap(t: number, agents: AgentSpec[], five: { claude: number; codex: number }, weekly: number): Snapshot {
  const as: SnapshotAgent[] = agents.map((a) => {
    const o: SnapshotAgent = {
      id: a.id,
      tool: a.tool,
      host: 'cli',
      ordinal: a.ordinal,
      parent: a.parent ?? null,
      root_id: ROOT[a.tool]!,
      account_id: a.tool === 'claude' || a.tool === 'codex' ? ACCOUNT : null,
      session_id: null,
      turn_id: null,
      request_id: null,
      state: a.state,
      confidence: 'exact',
      since: t - 1000,
      started_at: t - 3600000,
    };
    if (a.state === 'needs_you') o.reason = a.reason ?? 'permission';
    if (a.state === 'working' && a.activity) o.activity = a.activity;
    if (a.state === 'limited' && a.limited_until) o.limited_until = a.limited_until;
    return o;
  });
  const lim = (provider: 'claude' | 'codex', window: '5h' | 'weekly', used: number): SnapshotLimit => ({
    provider,
    window,
    account_id: ACCOUNT,
    root_id: ROOT[provider]!,
    used_pct: used,
    resets_at: t + 2 * 3600000,
    observed_at: t - 500,
    stale: false,
  });
  const waiting = as.filter((a) => a.state === 'needs_you');
  const tools = (['claude', 'codex', 'opencode'] as Tool[]).map((tool) => ({ tool, root_id: ROOT[tool]!, presence: 'present' as const, hooks: 'installed' as const, coverage: 'verified' as const, coverage_reason: null }));
  return {
    schema_version: 2,
    t,
    demo: true,
    agents: as,
    tools,
    limits: [lim('claude', '5h', five.claude), lim('codex', '5h', five.codex), lim('claude', 'weekly', weekly), lim('codex', 'weekly', weekly - 6)],
    attention: { needs_you: waiting.length, oldest_since: waiting.length ? Math.min(...waiting.map((a) => a.since)) : null },
  };
}

export type Step =
  | { at: number; kind: 'snapshot'; snapshot: Snapshot }
  | { at: number; kind: 'moment'; moment: Moment }
  | { at: number; kind: 'world'; world: World };

/** The 20 s timeline. `at` is ms from the start of the sequence. */
export function demoTimeline(tune: { five?: number; weekly?: number; dusk?: number; weeklyEnd?: number } = {}): { duration: number; steps: Step[]; worlds: { before: World; after: World } } {
  const worlds = demoWorlds();
  const T = (ms: number) => BASE_DATE + ms;
  const A = IDS;
  const working: AgentSpec[] = [
    { id: A.otter, tool: 'codex', ordinal: 1, state: 'working' },
    { id: A.beaver2, tool: 'claude', ordinal: 2, state: 'working', activity: 'shell' },
    { id: A.helper, tool: 'claude', ordinal: 3, state: 'working', parent: A.beaver2 },
    { id: A.frog, tool: 'opencode', ordinal: 1, state: 'your_turn' },
  ];
  const golden = { claude: tune.five ?? 72, codex: 52 };
  const wk = tune.weekly ?? 56;
  const wkEnd = tune.weeklyEnd ?? 64;
  const dusk = tune.dusk ?? 86;
  const steps: Step[] = [
    { at: 0, kind: 'world', world: worlds.before },
    { at: 0, kind: 'snapshot', snapshot: snap(T(0), working, golden, wk) },
    // 1.0 s: a new Claude session steps out of the sawmill and stretches; 2.6 s: it starts sawing
    { at: 1000, kind: 'snapshot', snapshot: snap(T(1000), [{ id: A.beaver1, tool: 'claude', ordinal: 1, state: 'starting' }, ...working], golden, wk) },
    { at: 2600, kind: 'snapshot', snapshot: snap(T(2600), [{ id: A.beaver1, tool: 'claude', ordinal: 1, state: 'working', activity: 'edit' }, ...working], golden, wk) },
    // 4.0 s: Codex needs a permission: the Moment first, the coalesced snapshot 180 ms later
    { at: 4000, kind: 'moment', moment: { schema_version: 1, kind: 'needs_you', t: T(4000), agent: A.otter, tool: 'codex', reason: 'permission' } },
    {
      at: 4180,
      kind: 'snapshot',
      snapshot: snap(T(4180), [{ id: A.beaver1, tool: 'claude', ordinal: 1, state: 'working', activity: 'edit' }, { ...working[0], state: 'needs_you', reason: 'permission' }, ...working.slice(1)], golden, wk),
    },
    // 8.4 s: answered
    { at: 8400, kind: 'moment', moment: { schema_version: 1, kind: 'answered', t: T(8400), agent: A.otter, tool: 'codex' } },
    { at: 8450, kind: 'snapshot', snapshot: snap(T(8450), [{ id: A.beaver1, tool: 'claude', ordinal: 1, state: 'working', activity: 'edit' }, ...working], golden, wk) },
    // 9.8 s: the hammering beaver finishes its turn; the plank completes the watermill
    { at: 9800, kind: 'moment', moment: { schema_version: 1, kind: 'turn_end', t: T(9800), agent: A.beaver2, tool: 'claude', turn_ms: 184000 } },
    { at: 10500, kind: 'moment', moment: { schema_version: 1, kind: 'build_complete', t: T(10500), structure: 'watermill', stage: 3 } },
    { at: 10500, kind: 'world', world: worlds.after },
    {
      at: 11000,
      kind: 'snapshot',
      snapshot: snap(T(11000), [{ id: A.beaver1, tool: 'claude', ordinal: 1, state: 'working', activity: 'edit' }, working[0], { ...working[1], state: 'your_turn', activity: undefined }, { ...working[2], state: 'your_turn' }, working[3]], golden, wk),
    },
    // 13 s: Claude's 5-hour window nears its end: dusk falls, the weekly window brings clouds
    {
      at: 13000,
      kind: 'snapshot',
      snapshot: snap(T(13000), [{ id: A.beaver1, tool: 'claude', ordinal: 1, state: 'working', activity: 'edit' }, working[0], { ...working[1], state: 'your_turn', activity: undefined }, { ...working[2], state: 'your_turn' }, working[3]], { claude: dusk, codex: 64 }, wkEnd),
    },
    // 16 s: Codex hits its limit: a shower over the stone yard, the otter takes tea, night comes
    { at: 16000, kind: 'moment', moment: { schema_version: 1, kind: 'limit_hit', t: T(16000), provider: 'codex', agent: A.otter, tool: 'codex' } },
    {
      at: 16050,
      kind: 'snapshot',
      snapshot: snap(
        T(16050),
        [
          { id: A.beaver1, tool: 'claude', ordinal: 1, state: 'working', activity: 'edit' },
          { ...working[0], state: 'limited', limited_until: T(16050) + 3600000 },
          { ...working[1], state: 'your_turn', activity: undefined },
          { ...working[2], state: 'your_turn' },
          working[3],
        ],
        { claude: dusk, codex: 100 },
        wkEnd + 2,
      ),
    },
  ];
  return { duration: 20000, steps, worlds };
}
