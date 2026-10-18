import type { Choices, Counts, Ledger } from '../../../contracts/ts/src/types.ts';

export const DEMO_DAY = '2026-10-12';

export function emptyCounts(): Counts {
  return { turns: 0, interrupted_turns: 0, sessions: 0, working_seconds: 0, needs_you: 0,
    errors: 0, recovered: 0, limit_hits: 0, subagent_turns: 0 };
}

/** Synthetic starting counts, constructed in memory. No imports or history-file access. */
export function createSandbox(seed: number, edition: 'full' | 'demo'): { ledger: Ledger; choices: Choices } {
  const ledger: Ledger = {
    schema_version: 1, privacy: { containsText: false }, seed,
    founded_day: edition === 'demo' ? DEMO_DAY : '2026-10-08',
    hooks_first_connected_day: edition === 'demo' ? DEMO_DAY : '2026-10-08',
    days: {}, backfill: null,
  };
  // Full-edition footage starts with a hamlet and a nearly finished watermill. The first
  // completed demo turn earns the ordinary daily delivery and finishes it through grow().
  if (edition === 'full') for (let day = 8; day <= 11; day++) {
    ledger.days[`2026-10-${String(day).padStart(2, '0')}`] = {
      claude: { ...emptyCounts(), turns: 22, sessions: 1, working_seconds: 280 * 60 },
      codex: { ...emptyCounts(), turns: 5, sessions: 1, working_seconds: 30 * 60 },
    };
  }
  ledger.days[DEMO_DAY] = { claude: emptyCounts(), codex: emptyCounts() };
  const choices: Choices = {
    schema_version: 1, privacy: { containsText: false }, log: [{
      t: Date.UTC(2026, 8, 30), day: '2026-09-30', kind: 'build_order',
      order: ['noticeboard', 'workshop_1', 'well', 'cottage_1', 'crossing', 'workshop_2',
        'garden_plots', 'watermill', 'cottage_2', 'bell_tower', 'bakery', 'market_hall'],
    }],
  };
  return { ledger, choices };
}
