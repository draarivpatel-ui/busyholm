import { buildAtlas } from './atlas.ts';
import { stripSprites } from './sprites.ts';
import { PAPER_DEBUG } from './paper.ts';
const settle = (pages: any[]) => { for (const p of pages) p.getContext('2d').getImageData(0, 0, 1, 1); };
function bench(label: string, filter: (id: string) => boolean = () => true) {
  const defs = stripSprites('autumn').filter((d) => filter(d.id));
  settle(buildAtlas(defs, 2).pages);
  const runs: number[] = [];
  for (let i = 0; i < 3; i++) { const t0 = performance.now(); const a = buildAtlas(defs, 2); settle(a.pages); runs.push(performance.now() - t0); }
  runs.sort((a, b) => a - b);
  console.log(label.padEnd(28), String(defs.length).padStart(4), 'sprites', runs[1].toFixed(1), 'ms');
}
bench('all');
bench('structures', (id) => id.startsWith('st/'));
bench('residents base', (id) => id.startsWith('res/') && !id.endsWith('/scarf'));
bench('residents scarf', (id) => id.startsWith('res/') && id.endsWith('/scarf'));
bench('helpers', (id) => id.startsWith('hlp/'));
bench('other', (id) => !id.startsWith('st/') && !id.startsWith('res/') && !id.startsWith('hlp/'));
PAPER_DEBUG.noShadow = true; bench('all, no shadow'); PAPER_DEBUG.noShadow = false;
PAPER_DEBUG.noGrain = true; bench('all, no grain'); PAPER_DEBUG.noGrain = false;
PAPER_DEBUG.noRim = true; bench('all, no rim'); PAPER_DEBUG.noRim = false;
(window as any).__goldenReady = true;
