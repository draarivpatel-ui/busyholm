// Loads playwright-core for the Node tools in this repo, so they run on any machine without
// hard-coded install paths.
//
// Order of lookup:
//   1. PLAYWRIGHT_PATH, if set: a playwright-core package directory, or its entry file.
//   2. The bare specifier 'playwright-core', resolved the normal Node way from this file
//      (the repo's node_modules, or a parent folder's node_modules).
// Nothing is installed here. If neither works, loadPlaywright() throws an Error that says what to do.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const NOT_FOUND =
  'Playwright not found. Install it (npm i -D playwright-core@<version>) or set PLAYWRIGHT_PATH to a playwright-core package directory, e.g. PLAYWRIGHT_PATH=/path/to/node_modules/playwright-core';

function firstLine(err) {
  return String(err && err.message ? err.message : err).split('\n')[0];
}

// An exports target is a string, or a conditions object whose import or default key holds one.
function pickTarget(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return pickTarget(value.import ?? value.default);
  return undefined;
}

// The ESM entry file of a playwright-core package directory.
function entryInDir(dir) {
  const candidates = [];
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const target = pickTarget(typeof pkg.exports === 'string' ? pkg.exports : pkg.exports?.['.']);
    if (target) candidates.push(join(dir, target));
  }
  candidates.push(join(dir, 'index.mjs'), join(dir, 'index.js'));
  const found = candidates.find((file) => existsSync(file));
  if (!found) throw new Error(`no ESM entry in ${dir} (checked package.json exports, index.mjs, index.js)`);
  return found;
}

// Imports a specifier or file URL and returns the module that has .chromium.
async function importPlaywright(specifier) {
  const mod = await import(specifier);
  // An ESM entry exposes chromium directly; a CommonJS entry may only have it under default.
  const pw = mod.chromium ? mod : mod.default;
  if (!pw || !pw.chromium) throw new Error('the module has no chromium export');
  return pw;
}

export function findChromiumExecutable() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  const home = process.env.HOME || homedir();
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(home, 'Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
    join(home, 'Library/Caches/ms-playwright/chromium-1223/chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

// Returns the playwright-core module object (the one with .chromium). Throws if it cannot be found.
export async function loadPlaywright() {
  const envPath = (process.env.PLAYWRIGHT_PATH ?? '').trim();
  const problems = [];
  let pw;
  if (envPath !== '') {
    try {
      const full = resolve(envPath);
      if (!existsSync(full)) throw new Error(`no such file or directory: ${full}`);
      const entry = statSync(full).isDirectory() ? entryInDir(full) : full;
      pw = await importPlaywright(pathToFileURL(entry).href);
    } catch (err) {
      problems.push(`PLAYWRIGHT_PATH=${envPath}: ${firstLine(err)}`);
    }
  }
  if (!pw) {
    try {
      pw = await importPlaywright('playwright-core');
    } catch (err) {
      problems.push(`import 'playwright-core': ${firstLine(err)}`);
    }
  }
  if (!pw) {
    throw new Error([NOT_FOUND, ...problems].join('\n'));
  }
  const origLaunch = pw.chromium.launch.bind(pw.chromium);
  pw.chromium.launch = (opts = {}) => {
    if (!opts.executablePath && !opts.channel) {
      const exec = findChromiumExecutable();
      if (exec) opts = { ...opts, executablePath: exec };
    }
    return origLaunch(opts);
  };
  const origPersistent = pw.chromium.launchPersistentContext.bind(pw.chromium);
  pw.chromium.launchPersistentContext = (dir, opts = {}) => {
    if (!opts.executablePath && !opts.channel) {
      const exec = findChromiumExecutable();
      if (exec) opts = { ...opts, executablePath: exec };
    }
    return origPersistent(dir, opts);
  };
  return pw;
}

// The ffmpeg binary: the FFMPEG env var if set, else 'ffmpeg' found on PATH.
export function ffmpegPath() {
  return (process.env.FFMPEG ?? '').trim() || 'ffmpeg';
}
