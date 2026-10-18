// No data-directory access. BUSYHOLM_DATA_DIR and real world inputs are deliberately unused.
import { parseArgs } from 'node:util';
import { createDemoSession } from '../src/session.ts';

try {
  const { values } = parseArgs({ options: { seed: { type: 'string', default: '42' }, edition: { type: 'string', default: 'full' } } });
  const demo = createDemoSession({ seed: Number(values.seed), edition: values.edition });
  demo.advanceTo(demo.durationMs);
  process.stdout.write(JSON.stringify(demo.state()) + '\n');
} catch (error) {
  process.stderr.write(`demo: ${error.message}\n`);
  process.exitCode = 1;
}
