// node tools/end-card.mjs [--out FILE]  Renders the end card from the counts of a finished seeded demo.
// The only text on the card is the fixed template in src/end-card.ts.
import { parseArgs } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoSession } from '../src/session.ts';
import { captureEndCard } from './capture-lib.mjs';

try {
  const { values: v } = parseArgs({ options: { out: { type: 'string' }, seed: { type: 'string', default: '42' } } });
  const demo = createDemoSession({ seed: Number(v.seed) });
  demo.advanceTo(demo.durationMs);
  const { world } = demo.state();
  const counts = { activeDays: world.stats.active_days, turns: world.stats.lifetime_turns,
    buildings: world.structures.filter((s) => s.status === 'complete').length, tools: world.stats.tools_seen.length };
  const outPath = v.out ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'captures', 'end-card.png');
  const r = await captureEndCard({ counts, outPath });
  console.log(`${JSON.stringify(counts)} -> ${r.path} ${r.sha256}`);
} catch (error) {
  process.stderr.write(`end-card: ${error.message}\n`);
  process.exitCode = 1;
}
