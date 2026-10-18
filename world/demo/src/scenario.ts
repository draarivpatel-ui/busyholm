/**
 * 60-second deterministic video scenario specification and session (WP-B1).
 * Seeded, fixed epoch, pure synthetic progression.
 */
import type {
  Activity,
  AgentState,
  Choices,
  Counts,
  Ledger,
  Moment,
  NeedsYouReason,
  Provider,
  Snapshot,
  SnapshotAgent,
  Tool,
  World,
} from '../../../contracts/ts/src/types.ts';
import { VirtualTime } from '../../renderer/src/index.ts';
import { grow } from '../../grow/src/index.ts';
import { createSandbox, DEMO_DAY, emptyCounts } from './sandbox.ts';
import { generateThreeWeekTimelapseDays, getTimelapseDayAt, type TimelapseDay } from './timelapse.ts';

export { generateThreeWeekTimelapseDays } from './timelapse.ts';

export const VIDEO_SCENARIO_DURATION_MS = 60_000;
export const VIDEO_SCENARIO_FPS = 30;
export const VIDEO_SCENARIO_SEED = 42;
export const DEMO_EPOCH = new Date(2026, 9, 12, 17, 20, 0).getTime();

export interface VideoShot {
  id: string;
  name: string;
  startMs: number;
  durationMs: number;
  view: 'desktop' | 'strip1440' | 'ambient' | 'timelapse' | 'endcard';
  caption: string;
  musicMood: string;
}

export const VIDEO_SCENARIO: {
  durationMs: number;
  fps: number;
  seed: number;
  shots: VideoShot[];
} = {
  durationMs: VIDEO_SCENARIO_DURATION_MS,
  fps: VIDEO_SCENARIO_FPS,
  seed: VIDEO_SCENARIO_SEED,
  shots: [
    {
      id: 'desktop',
      name: 'The Working Desktop',
      startMs: 0,
      durationMs: 7_000,
      view: 'desktop',
      caption: 'A papercut island on your desktop',
      musicMood: 'Warm acoustic guitar with quiet room tone and rhythmic sawing',
    },
    {
      id: 'working',
      name: 'Real Agent Activity',
      startMs: 7_000,
      durationMs: 7_000,
      view: 'desktop',
      caption: 'Residents work while agents work',
      musicMood: 'Upbeat fingerpicking with stone chipping clicks and wheel clicks',
    },
    {
      id: 'needs_you',
      name: 'The Alert (Needs You)',
      startMs: 14_000,
      durationMs: 8_000,
      view: 'desktop',
      caption: 'The bell rings when needed',
      musicMood: 'Track pulls back; resonant brass bell strike and alert tension',
    },
    {
      id: 'answer_build',
      name: 'Answering and Growth',
      startMs: 22_000,
      durationMs: 8_000,
      view: 'ambient',
      caption: 'Finished turns build the village',
      musicMood: 'Cheerful acoustic resolve, completion chime, and dust puff',
    },
    {
      id: 'sky',
      name: 'Sky and Usage Windows',
      startMs: 30_000,
      durationMs: 7_000,
      view: 'ambient',
      caption: 'Sky tracks your usage windows',
      musicMood: 'Breezy acoustic strings following the moving sun arc',
    },
    {
      id: 'limit_rain',
      name: 'Usage Limits and Rain',
      startMs: 37_000,
      durationMs: 8_000,
      view: 'ambient',
      caption: 'Rain falls when limits hit',
      musicMood: 'Mellow piano motif, soft paper rain patter, calm breathing',
    },
    {
      id: 'ambient',
      name: 'Fullscreen Ambient Mode',
      startMs: 45_000,
      durationMs: 7_000,
      view: 'ambient',
      caption: 'Fullscreen ambient view from the tray',
      musicMood: 'Cozy ambient cello, guitar harmonics, crickets, and river water',
    },
    {
      id: 'timelapse',
      name: 'Three-Week Time-Lapse',
      startMs: 52_000,
      durationMs: 6_000,
      view: 'timelapse',
      caption: 'Grows from weeks of work',
      musicMood: 'Playful acoustic arpeggio with crisp building pops and crescendo',
    },
    {
      id: 'title',
      name: 'Title Card and Call to Action',
      startMs: 58_000,
      durationMs: 2_000,
      view: 'endcard',
      caption: 'Busyholm on macOS',
      musicMood: 'Final warm acoustic resolve chord, soft river waters fading out',
    },
  ],
};

export function getShotAt(elapsedMs: number): VideoShot {
  for (const shot of VIDEO_SCENARIO.shots) {
    if (elapsedMs >= shot.startMs && elapsedMs < shot.startMs + shot.durationMs) {
      return shot;
    }
  }
  return VIDEO_SCENARIO.shots[VIDEO_SCENARIO.shots.length - 1]!;
}

export interface ScenarioSink {
  setSnapshot(snapshot: Snapshot): void;
  pushMoment(moment: Moment): void;
  setWorld(world: World): void;
}

export interface VideoScenarioSession {
  readonly seed: number;
  readonly durationMs: number;
  readonly clock: VirtualTime;
  readonly elapsedMs: number;
  connect(sink: ScenarioSink): () => void;
  advanceTo(ms: number): void;
  currentShot(): VideoShot;
  currentTimelapseDay(): TimelapseDay | null;
  state(): {
    elapsedMs: number;
    snapshot: Snapshot;
    ledger: Ledger;
    choices: Choices;
    world: World;
  };
}

const TOOLS = ['claude', 'codex', 'opencode', 'antigravity'] as const;
type MainTool = typeof TOOLS[number];
type AgentPatch = { activity?: Activity; reason?: NeedsYouReason };

export function createVideoScenarioSession(options: { seed?: number } = {}): VideoScenarioSession {
  const seed = options.seed ?? VIDEO_SCENARIO_SEED;
  const clock = new VirtualTime(1000);
  const elapsed = () => clock.now() - 1000;
  const epoch = () => DEMO_EPOCH + Math.round(elapsed());
  const { ledger, choices } = createSandbox(seed, 'full');
  const sinks = new Set<ScenarioSink>();
  const agents = new Map<string, SnapshotAgent>();
  const present = new Set<Tool>();
  const workMs = new Map<Tool, number>();
  const clone = <T>(value: T): T => structuredClone(value);

  const timelapseDays = generateThreeWeekTimelapseDays(seed);

  let random = seed || 0x6d2b79f5;
  const id = () =>
    Array.from({ length: 4 }, () => {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      return (random >>> 0).toString(16).padStart(8, '0');
    }).join('');

  const roots = Object.fromEntries(TOOLS.map((tool) => [tool, id()])) as Record<MainTool, string>;
  const accounts = { claude: id(), codex: id() };
  const ids = Object.fromEntries(TOOLS.map((tool) => [tool, id()])) as Record<MainTool, string>;

  let five = { claude: 55, codex: 45 };
  let weekly = 48;
  let snapshot: Snapshot;
  let world = grow(seed, ledger, choices, { edition: 'full' });

  const counts = (tool: Tool): Counts => (ledger.days[DEMO_DAY]![tool] ??= emptyCounts());
  const emitMoment = (m: Moment) => {
    for (const s of sinks) s.pushMoment(clone(m));
  };

  function setAgent(tool: MainTool, state: AgentState, patch: AgentPatch = {}): void {
    const agentId = ids[tool];
    const old = agents.get(agentId);
    const changed = !old || old.state !== state || old.reason !== patch.reason;
    const a: SnapshotAgent = {
      id: agentId,
      tool,
      host: 'cli',
      ordinal: 1,
      parent: null,
      root_id: roots[tool],
      account_id: tool === 'claude' || tool === 'codex' ? accounts[tool] : null,
      session_id: agentId,
      turn_id: old?.turn_id ?? id(),
      request_id: null,
      state,
      confidence: state === 'unknown' ? 'inferred' : 'exact',
      since: changed ? epoch() : old!.since,
      started_at: old?.started_at ?? epoch(),
    };
    if (state === 'working') a.activity = patch.activity ?? 'other';
    if (state === 'needs_you') {
      a.reason = patch.reason ?? 'permission';
      a.request_id = changed ? id() : old!.request_id;
    }
    if (state === 'limited') a.limited_until = DEMO_EPOCH + 42 * 60_000;
    agents.set(agentId, a);
    present.add(tool);
    if (!old) counts(tool).sessions++;
  }

  function emitSnapshot(): void {
    const list = [...agents.values()].map(clone);
    const waiting = list.filter((a) => a.state === 'needs_you');
    snapshot = {
      schema_version: 2,
      t: epoch(),
      demo: true,
      agents: list,
      tools: TOOLS.map((tool) => ({
        tool,
        root_id: roots[tool],
        presence: present.has(tool) ? 'present' : 'offline',
        hooks: tool === 'claude' || tool === 'codex' ? 'installed' : 'unsupported',
        coverage: tool === 'claude' || tool === 'codex' ? 'verified' : 'unsupported',
        coverage_reason: tool === 'claude' || tool === 'codex' ? null : 'experimental_adapter',
      })),
      limits: (['claude', 'codex'] as Provider[]).flatMap((provider) => [
        {
          provider,
          window: '5h' as const,
          account_id: accounts[provider],
          root_id: roots[provider],
          used_pct: five[provider],
          resets_at: DEMO_EPOCH + (provider === 'claude' ? 42 * 60_000 : 3_600_000),
          observed_at: epoch(),
          stale: false,
        },
        {
          provider,
          window: 'weekly' as const,
          account_id: accounts[provider],
          root_id: roots[provider],
          used_pct: weekly,
          resets_at: DEMO_EPOCH + 7 * 86_400_000,
          observed_at: epoch(),
          stale: false,
        },
      ]),
      attention: {
        needs_you: waiting.length,
        oldest_since: waiting.length ? Math.min(...waiting.map((a) => a.since)) : null,
      },
    };
    for (const s of sinks) s.setSnapshot(clone(snapshot));
  }

  function updateWorld(): void {
    const next = grow(seed, ledger, choices, { edition: 'full' });
    if (JSON.stringify(next) === JSON.stringify(world)) return;
    const prior = world;
    world = next;
    for (const s of sinks) s.setWorld(clone(world));
    for (const b of world.structures) {
      const before = prior.structures.find((p) => p.id === b.id);
      if (b.stage > (before?.stage ?? 0) && b.stage > 0) {
        emitMoment({
          schema_version: 1,
          kind: 'build_complete',
          t: epoch(),
          structure: b.id,
          stage: b.stage as 1 | 2 | 3,
        });
      }
    }
  }

  function advanceClock(to: number): void {
    const delta = to - elapsed();
    const working = new Set([...agents.values()].filter((a) => a.state === 'working').map((a) => a.tool));
    for (const tool of working) {
      workMs.set(tool, (workMs.get(tool) ?? 0) + delta);
      counts(tool).working_seconds = Math.floor(workMs.get(tool)! / 1000);
    }
    clock.advance(delta);
  }

  const notice = (kind: 'error' | 'recovered' | 'turn_end', tool: MainTool) => {
    emitMoment(
      kind === 'turn_end'
        ? { schema_version: 1, kind, t: epoch(), agent: ids[tool], tool, turn_ms: 16_000 }
        : { schema_version: 1, kind, t: epoch(), agent: ids[tool], tool }
    );
  };

  const needs = (tool: MainTool, reason: NeedsYouReason) => {
    setAgent(tool, 'needs_you', { reason });
    counts(tool).needs_you++;
    emitMoment({
      schema_version: 1,
      kind: 'needs_you',
      t: epoch(),
      agent: ids[tool],
      tool,
      reason,
      request_id: agents.get(ids[tool])!.request_id!,
    });
  };

  const answer = (tool: MainTool) => {
    emitMoment({
      schema_version: 1,
      kind: 'answered',
      t: epoch(),
      agent: ids[tool],
      tool,
      request_id: agents.get(ids[tool])!.request_id!,
    });
    setAgent(tool, 'working', { activity: 'edit' });
  };

  // Start with active residents on the island from frame 0
  setAgent('claude', 'working', { activity: 'edit' });
  setAgent('codex', 'working', { activity: 'shell' });
  setAgent('opencode', 'working', { activity: 'read' });
  setAgent('antigravity', 'idle');

  const beats: { at: number; run(): void }[] = [
    {
      at: 1_000,
      run() {
        setAgent('claude', 'working', { activity: 'edit' });
        setAgent('codex', 'working', { activity: 'shell' });
        setAgent('opencode', 'working', { activity: 'read' });
      },
    },
    {
      at: 7_200,
      run() {
        setAgent('claude', 'working', { activity: 'edit' });
        setAgent('codex', 'working', { activity: 'edit' });
        setAgent('opencode', 'working', { activity: 'read' });
      },
    },
    // Shot 3 (Needs You): at 14.6s Codex triggers permission prompt so otter dashes to bell and raises flag
    {
      at: 14_600,
      run() {
        needs('codex', 'permission');
      },
    },
    // Shot 4 (Answer & Building Completion): at 22.5s prompt is answered, at 23.2s finished turn launches plank
    {
      at: 22_500,
      run() {
        answer('codex');
      },
    },
    {
      at: 23_200,
      run() {
        notice('turn_end', 'claude');
        counts('claude').turns++;
        setAgent('claude', 'your_turn');
      },
    },
    {
      at: 25_200,
      run() {
        setAgent('claude', 'working', { activity: 'edit' });
      },
    },
    // Shot 5 (Sky & Usage Windows): limit sample progresses so sun sinks along its arc and clouds gather
    {
      at: 30_200,
      run() {
        five = { claude: 78, codex: 60 };
        weekly = 62;
      },
    },
    {
      at: 33_200,
      run() {
        five = { claude: 88, codex: 66 };
        weekly = 72;
      },
    },
    // Shot 6 (Usage Limits & Rain): at 37.2s Claude reaches limit hit -> localized rain shower over sawmill
    {
      at: 37_200,
      run() {
        counts('claude').limit_hits++;
        five = { claude: 100, codex: 65 };
        weekly = 75;
        emitMoment({
          schema_version: 1,
          kind: 'limit_hit',
          t: epoch(),
          provider: 'claude',
          agent: ids.claude,
          tool: 'claude',
        });
        setAgent('claude', 'limited');
      },
    },
    // Shot 7 (Fullscreen Ambient Mode): at 45s dusk/evening ambient mode with lanterns and fireflies
    {
      at: 45_000,
      run() {
        five = { claude: 92, codex: 50 };
        weekly = 48;
        emitMoment({
          schema_version: 1,
          kind: 'limit_reset',
          t: epoch(),
          provider: 'claude',
          agent: ids.claude,
          tool: 'claude',
        });
        setAgent('claude', 'working', { activity: 'edit' });
        setAgent('codex', 'idle');
      },
    },
  ];

  let nextBeat = 0;
  emitSnapshot();

  return {
    seed,
    durationMs: VIDEO_SCENARIO_DURATION_MS,
    clock,
    get elapsedMs() {
      return elapsed();
    },
    connect(sink) {
      sinks.add(sink);
      sink.setWorld(clone(world));
      sink.setSnapshot(clone(snapshot));
      return () => {
        sinks.delete(sink);
      };
    },
    advanceTo(ms) {
      if (!Number.isFinite(ms) || ms < elapsed() || ms > VIDEO_SCENARIO_DURATION_MS) {
        throw new RangeError(`scenario time must move forward between 0 and ${VIDEO_SCENARIO_DURATION_MS} ms`);
      }
      while (nextBeat < beats.length && beats[nextBeat]!.at <= ms) {
        const beat = beats[nextBeat++]!;
        advanceClock(beat.at);
        beat.run();
        updateWorld();
        emitSnapshot();
        clock.advance(0);
      }
      advanceClock(ms);
      updateWorld();
      clock.advance(0);
    },
    currentShot() {
      return getShotAt(elapsed());
    },
    currentTimelapseDay() {
      const shot = getShotAt(elapsed());
      if (shot.id !== 'timelapse') return null;
      return getTimelapseDayAt(timelapseDays, elapsed() - shot.startMs, shot.durationMs);
    },
    state() {
      return clone({ elapsedMs: elapsed(), snapshot, ledger, choices, world });
    },
  };
}

/** Draws on-screen caption pill in Fraunces/Georgia font (under 7 words). */
export function drawOnScreenCaption(
  ctx: CanvasRenderingContext2D,
  caption: string,
  width = 1920,
  height = 1080,
  customY?: number
): void {
  if (!caption) return;
  ctx.save();

  ctx.font = '500 24px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const textMetrics = ctx.measureText(caption);
  const textW = textMetrics.width;
  const pillW = textW + 56;
  const pillH = 44;
  const pillX = (width - pillW) / 2;
  const pillY = customY !== undefined ? customY : height - 64;

  // Soft drop shadow
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 4;

  // Background cream paper pill
  ctx.fillStyle = '#F7EEDC'; // cream paper token
  ctx.beginPath();
  ctx.roundRect(pillX, pillY, pillW, pillH, 23);
  ctx.fill();

  // Subtle ink border
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(43, 42, 51, 0.4)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(pillX, pillY, pillW, pillH, 23);
  ctx.stroke();

  // Text in deep ink token
  ctx.fillStyle = '#2B2A33';
  ctx.fillText(caption, width / 2, pillY + pillH / 2);

  ctx.restore();
}

export const SCENARIO_END_CARD_LINES = [
  'Busyholm',
  'A papercut island that raises a flag when your agent needs you',
  'macOS',
  'about $5',
  'Sample data',
] as const;

export function scenarioEndCardLines(): string[] {
  return [...SCENARIO_END_CARD_LINES];
}

export function drawScenarioEndCard(
  ctx: CanvasRenderingContext2D,
  width = 1920,
  height = 1080
): void {
  const lines = scenarioEndCardLines();
  const s = Math.min(width / 1920, height / 1080);
  ctx.save();
  ctx.fillStyle = '#F2E5C9';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#8269420a';
  for (let n = 0; n < 600; n++) {
    ctx.fillRect(((n * 127) % 1920) * (width / 1920), ((n * 59) % 1080) * (height / 1080), s, s);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#312D2A';
  ctx.font = `${106 * s}px Georgia, serif`;
  ctx.fillText(lines[0]!, width / 2, height * 0.28);
  ctx.fillStyle = '#312D2A';
  ctx.font = `${34 * s}px Georgia, serif`;
  ctx.fillText(lines[1]!, width / 2, height * 0.41);
  ctx.fillStyle = '#78664F';
  ctx.fillRect(width * 0.35, height * 0.48, width * 0.3, s);
  ctx.fillStyle = '#312D2A';
  ctx.font = `${32 * s}px Georgia, serif`;
  ctx.fillText(lines[2]!, width / 2, height * 0.56);
  ctx.fillText(lines[3]!, width / 2, height * 0.64);
  ctx.fillStyle = '#A25D3D';
  ctx.font = `${24 * s}px Georgia, serif`;
  ctx.fillText(lines[4]!, width / 2, height * 0.74);
  ctx.restore();
}

