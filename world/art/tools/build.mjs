// Bundles the gallery and the browser test page as classic IIFE scripts so both
// open straight from disk (file://), where ES module scripts are blocked.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const t0 = performance.now();
await build({
  entryPoints: {
    gallery: join(root, 'src/gallery-main.ts'),
    tests: join(root, 'src/tests-main.ts'),
    bench: join(root, 'src/bench-main.ts'),
  },
  outdir: join(root, 'build'),
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  legalComments: 'none',
  logLevel: 'warning',
});
console.log(`build: gallery.js + tests.js + bench.js in ${(performance.now() - t0).toFixed(0)} ms`);
