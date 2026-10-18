// Dev-only tools for the UI browser tests and screenshots: playwright-core 1.64.0 and
// axe-core 4.14.0. Nothing is installed by this repo (a root npm install would touch the shared
// lockfile). Lookup order: PLAYWRIGHT_PATH / AXE_PATH (a package directory), ui/node_modules,
// then the repo's node_modules. To run the browser tests, install both packages in ui/ with
// `npm install --no-save playwright-core@1.64.0 axe-core@4.14.0`, or point the env vars at them.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ui = join(here, '..');

function candidates(name, envKey) {
  return [process.env[envKey], join(ui, 'node_modules', name), join(ui, '..', 'node_modules', name)].filter(Boolean);
}

export async function loadPlaywright() {
  for (const dir of candidates('playwright-core', 'PLAYWRIGHT_PATH')) {
    const entry = join(dir, 'index.mjs');
    if (existsSync(entry)) return import(pathToFileURL(entry).href);
  }
  throw new Error('playwright-core not found: set PLAYWRIGHT_PATH to a playwright-core 1.64.0 package directory');
}

export function axeSource() {
  for (const dir of candidates('axe-core', 'AXE_PATH')) {
    const f = join(dir, 'axe.min.js');
    if (existsSync(f)) return readFileSync(f, 'utf8');
  }
  throw new Error('axe-core not found: set AXE_PATH to an axe-core 4.14.0 package directory');
}
