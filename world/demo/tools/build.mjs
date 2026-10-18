// Bundles the demo capture page into world/demo/dist (gitignored). esbuild is the art kit's pinned copy.
import { build } from '../../art/node_modules/esbuild/lib/main.js';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
await build({
  entryPoints: { capture: join(root, 'src', 'capture-main.ts') },
  bundle: true, format: 'iife', target: 'es2022', outdir: dist, logLevel: 'warning', legalComments: 'none',
});
copyFileSync(join(root, 'pages', 'capture.html'), join(dist, 'capture.html'));
console.log(`built demo capture page into ${dist}`);
