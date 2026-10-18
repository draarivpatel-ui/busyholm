/**
 * Test builders for contract-valid Snapshot v2, Moment v1 and World v1 values.
 * Every builder validates its output with the WP-01 validator, so a test can never pass on a
 * shape the collector would never send.
 */
import { validate } from '../../../contracts/ts/src/validate.ts';
import type {
  Moment,
  Snapshot,
  SnapshotAgent,
  SnapshotLimit,
  Tool,
  ToolStatus,
  World,
  WorldStructure,
} from '../../../contracts/ts/src/types.ts';

export const T0 = 1791806400000; // 2026-10-12 local afternoon, within the contract's ms range

export const ROOT: Record<string, string> = {
  claude: '5c96dbc2661405adf9ab0e86e0eef50b',
  codex: '5e1805de3c344b54fb9b24e1e1b20045',
  opencode: '6a1805de3c344b54fb9b24e1e1b20046',
  antigravity: '7b1805de3c344b54fb9b24e1e1b20047',
};
export const ACCOUNT = '2f7339c66415277e5b58670b67b979a9';

/** A stable 32-hex id from a small number and a tag. */
export function hexId(n: number, tag = 'a'): string {
  const h = (n >>> 0).toString(16).padStart(8, '0');
  return (tag.charCodeAt(0).toString(16) + 'c0ffee' + h).padEnd(32, '0').slice(0, 32);
}

type AgentOpts = Partial<SnapshotAgent> & { tool?: Tool; state?: SnapshotAgent['state'] };

export function agent(n: number, o: AgentOpts = {}): SnapshotAgent {
  const tool = o.tool ?? 'claude';
  const state = o.state ?? 'working';
  const a: SnapshotAgent = {
    id: o.id ?? hexId(n),
    tool,
    host: o.host ?? 'cli',
    ordinal: o.ordinal ?? 1,
    parent: o.parent ?? null,
    root_id: ROOT[tool] ?? ROOT.claude,
    account_id: tool === 'claude' || tool === 'codex' ? ACCOUNT : null,
    session_id: null,
    turn_id: null,
    request_id: null,
    state,
    confidence: o.confidence ?? (state === 'unknown' ? 'inferred' : 'exact'),
    since: o.since ?? T0 - 60000,
    started_at: o.started_at ?? T0 - 3600000,
  };
  if (state === 'needs_you') a.reason = o.reason ?? 'permission';
  if (state === 'working' && o.activity) a.activity = o.activity;
  if (state === 'limited' && o.limited_until) a.limited_until = o.limited_until;
  return a;
}

export function tools(present: Tool[], offline: Tool[] = []): ToolStatus[] {
  const mk = (tool: Tool, presence: 'present' | 'offline'): ToolStatus => ({
    tool,
    root_id: ROOT[tool] ?? ROOT.claude,
    presence,
    hooks: 'installed',
    coverage: 'verified',
    coverage_reason: null,
  });
  return [...present.map((t) => mk(t, 'present')), ...offline.map((t) => mk(t, 'offline'))];
}

export function limit(provider: 'claude' | 'codex', window: '5h' | 'weekly', used: number, t = T0): SnapshotLimit {
  return {
    provider,
    window,
    account_id: ACCOUNT,
    root_id: ROOT[provider],
    used_pct: used,
    resets_at: t + 3600000,
    observed_at: t - 1000,
    stale: false,
  };
}

export function snapshot(agents: SnapshotAgent[], o: { t?: number; tools?: ToolStatus[]; limits?: SnapshotLimit[]; demo?: boolean } = {}): Snapshot {
  const waiting = agents.filter((a) => a.state === 'needs_you');
  const usedTools = [...new Set(agents.map((a) => a.tool))];
  const s: Snapshot = {
    schema_version: 2,
    t: o.t ?? T0,
    demo: o.demo ?? false,
    agents,
    tools: o.tools ?? tools(usedTools),
    limits: o.limits ?? [],
    attention: {
      needs_you: waiting.length,
      oldest_since: waiting.length ? Math.min(...waiting.map((a) => a.since)) : null,
    },
  };
  const v = validate('snapshot', s);
  if (!v.ok) throw new Error('test snapshot invalid: ' + JSON.stringify(v.issues.slice(0, 3)));
  return s;
}

export function moment(m: Record<string, unknown>): Moment {
  const full = { schema_version: 1, t: T0, ...m };
  const v = validate('moment', full);
  if (!v.ok) throw new Error('test moment invalid: ' + JSON.stringify(v.issues.slice(0, 3)));
  return full as unknown as Moment;
}

function st(id: WorldStructure['id'], stage: number, o: Partial<WorldStructure> = {}): WorldStructure {
  const complete = stage >= 3 && (o.status ?? 'complete') === 'complete';
  const s: WorldStructure = {
    id,
    status: o.status ?? (complete ? 'complete' : stage > 0 ? 'building' : 'planned'),
    stage,
    progress: o.progress ?? (complete ? 1 : stage / 3),
  };
  if (o.variant) s.variant = o.variant;
  if (s.status === 'complete') s.completed_day = '2026-10-10';
  return s;
}

/** A hamlet: claude sawmill, codex stone yard, footbridge, bell post, a watermill being built. */
export function hamlet(): World {
  const w: World = {
    schema_version: 1,
    seed: 20261012,
    as_of_day: '2026-10-12',
    tier: 'hamlet',
    resources: { planks: 12, stone: 4, seeds: 3 },
    earned: { planks: 140, stone: 60, seeds: 9 },
    structures: [
      st('campfire', 3),
      st('tent', 3),
      st('bell_post', 3),
      st('noticeboard', 3),
      st('workshop_1', 3, { variant: 'claude' }),
      st('well', 3),
      st('cottage_1', 3),
      st('garden_plots', 3),
      st('crossing', 3, { variant: 'footbridge' }),
      st('workshop_2', 3, { variant: 'codex' }),
      st('watermill', 2, { status: 'building', progress: 0.62 }),
      st('cottage_2', 0, { status: 'planned', progress: 0 }),
    ],
    decorations: [],
    milestones: [],
    stats: { lifetime_turns: 140, active_days: 6, streak_days: 4, tools_seen: ['claude', 'codex'] },
    founders_stone: null,
    demo_capped: false,
  };
  const v = validate('world', w);
  if (!v.ok) throw new Error('test world invalid: ' + JSON.stringify(v.issues.slice(0, 3)));
  return w;
}

export function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
