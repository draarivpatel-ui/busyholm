// Bundles the renderer pages into world/dist (gitignored): strip.html, ambient.html (WP-02 page
// contract), capture.html (scripted 20 s sequence for captures) and bench.html (real-time tests).
// esbuild is the art kit's pinned copy (world/art, exactly 0.28.2), so this package adds no dependency.
import { build } from '../../art/node_modules/esbuild/lib/main.js';
import { mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(root, '..', 'dist');
mkdirSync(dist, { recursive: true });
const pages = ['strip', 'ambient', 'capture', 'bench'].filter((p) => existsSync(join(root, 'src', 'pages', `${p}-main.ts`)));
const t0 = Date.now();
await build({
  entryPoints: Object.fromEntries(pages.map((p) => [p, join(root, 'src', 'pages', `${p}-main.ts`)])),
  bundle: true,
  format: 'iife',
  target: 'es2022',
  outdir: dist,
  minify: process.argv.includes('--minify'),
  sourcemap: process.argv.includes('--sourcemap') ? 'inline' : false,
  logLevel: 'warning',
  legalComments: 'none',
});
for (const f of readdirSync(join(root, 'pages'))) if (f.endsWith('.html') || f.endsWith('.css')) copyFileSync(join(root, 'pages', f), join(dist, f));
console.log(`built ${pages.length} pages into ${dist} in ${Date.now() - t0} ms`);
