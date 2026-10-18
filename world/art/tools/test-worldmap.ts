// Maps every valid World v1 fixture (fixtures/contracts/world.v1/valid) through worldmap.ts and checks
// that each drawn structure resolves to a structure kind and stage the atlas actually builds.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artFor } from '../src/worldmap.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '../../../fixtures/contracts/world.v1/valid');
// Expected sprite ids: built from the structure registry would need a DOM; list the known kinds instead.
const KINDS = new Set(['cottage', 'sawmill', 'campfire', 'tent', 'bellpost', 'founders', 'plot', 'noticeboard', 'stoneyard', 'printshop', 'windmill', 'well', 'garden', 'footbridge', 'jetty', 'watermill', 'guesthouse', 'belltower', 'bakery', 'markethall']);
let files = 0;
let drawn = 0;
const fails: string[] = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const w = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  files++;
  for (const s of w.structures ?? []) {
    const a = artFor(s);
    if (!a) continue;
    drawn++;
    if (!KINDS.has(a.kind)) fails.push(`${f}: ${s.id} -> unknown kind ${a.kind}`);
    if (!/^st\/[a-z]+\/[123](\/v1)?$/.test(a.sprite)) fails.push(`${f}: ${s.id} -> bad sprite ${a.sprite}`);
    if (!(a.x > 0 && a.x < 1440)) fails.push(`${f}: ${s.id} -> slot ${a.x}`);
  }
}
if (fails.length) {
  console.log(fails.slice(0, 20).join('\n'));
  console.log(`test:worldmap FAIL (${fails.length})`);
  process.exit(1);
}
console.log(`test:worldmap OK (${files} World v1 fixtures, ${drawn} drawn structures mapped)`);
