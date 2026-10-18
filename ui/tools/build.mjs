// Builds ui/dist (gitignored): the pages at the root (WP-02 page contract: popover.html,
// settings.html, details.html) plus onboarding.html, and every asset under dist/ui/ so nothing
// collides with the world/ pages or the WP-02 placeholders that share app/dist.
// esbuild is the art kit's pinned copy (world/art, exactly 0.28.2), so ui adds no dependency.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = join(root, 'src');
const dist = join(root, 'dist');
const esbuildPath = join(root, '..', 'world', 'art', 'node_modules', 'esbuild', 'lib', 'main.js');

const t0 = Date.now();
if (dirname(dist) !== root) throw new Error('refusing to clean ' + dist);
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'ui', 'fonts'), { recursive: true });

for (const f of readdirSync(src)) if (f.endsWith('.html')) cpSync(join(src, f), join(dist, f));
for (const f of readdirSync(join(src, 'ui'))) if (/\.(js|css|svg)$/.test(f)) cpSync(join(src, 'ui', f), join(dist, 'ui', f));
for (const f of readdirSync(join(src, 'fonts'))) if (/\.(woff2|txt)$/.test(f)) cpSync(join(src, 'fonts', f), join(dist, 'ui', 'fonts', f));

if (!existsSync(esbuildPath)) throw new Error('esbuild not found at ' + esbuildPath + ' (run npm ci in world/art)');
const { build } = await import(esbuildPath);
await build({
  entryPoints: { art: join(src, 'bundle', 'art.ts'), grow: join(src, 'bundle', 'grow.ts') },
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outdir: join(dist, 'ui'),
  minify: !process.argv.includes('--debug'),
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('ui: built into ' + dist + ' in ' + (Date.now() - t0) + ' ms');
