// WP-11 browser test harness: builds ui/dist, serves it on 127.0.0.1, drives headless Chrome
// with the fake core (test/fake-core.js) installed before page scripts run.
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadPlaywright, axeSource } from '../tools/deps.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const UI = join(here, '..');
export const REPO = join(UI, '..');
const DIST = join(UI, 'dist');
const FAKE = readFileSync(join(here, 'fake-core.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain' };

let built = false;
export function build() {
  if (built) return;
  execFileSync(process.execPath, [join(UI, 'tools', 'build.mjs')], { stdio: 'pipe' });
  built = true;
}

export async function start() {
  build();
  const server = createServer(async (req, res) => {
    try {
      const p = join(DIST, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!p.startsWith(DIST)) throw new Error('outside');
      const body = await readFile(p);
      res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const base = `http://127.0.0.1:${server.address().port}/`;
  return {
    base,
    browser,
    /** A fresh page with the fake core. init: { snapshot, settings, worldInputs, connect, onboarded, os, boot }. */
    async page(init, opts = {}) {
      const ctx = await browser.newContext({ viewport: opts.viewport || { width: 360, height: 480 }, deviceScaleFactor: opts.dpr || 1, colorScheme: opts.colorScheme || 'light', reducedMotion: opts.reducedMotion || 'no-preference' });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
      if (init) await page.addInitScript(`window.__FAKE_INIT__ = ${JSON.stringify(init)};\n${FAKE}`);
      page.errors = errors;
      page.ctx = ctx;
      return page;
    },
    async close() {
      await browser.close();
      server.close();
    },
  };
}

/** Run axe-core in the page; returns violations with impact serious or critical. */
export async function axe(page) {
  // Injected through DevTools evaluation: the pages keep their real CSP (no inline scripts).
  if (!(await page.evaluate(() => !!window.axe))) await page.evaluate(axeSource());
  const r = await page.evaluate(async () => window.axe.run(document, { resultTypes: ['violations'] }));
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n').slice(0, 2).join(' ')) }));
}

export async function fixtures(contract) {
  const dir = join(REPO, 'fixtures', 'contracts', contract, 'valid');
  const names = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  return names.map((n) => ({ name: n, data: JSON.parse(readFileSync(join(dir, n), 'utf8')) }));
}

export const DEFAULT_SETTINGS = JSON.parse(readFileSync(join(REPO, 'fixtures', 'contracts', 'settings.v1', 'valid', '001-defaults-full.json'), 'utf8'));

export const CONNECT = {
  parts: [
    { part: 'claude_hooks', connected: false, pending_review: false, available: true, path: '~/.claude/settings.json' },
    { part: 'claude_statusline', connected: false, pending_review: false, available: true, path: '~/.claude/settings.json' },
    { part: 'codex_hooks', connected: false, pending_review: false, available: true, path: '~/.codex/hooks.json' },
    { part: 'opencode_plugin', connected: false, pending_review: false, available: false, path: '~/.config/opencode/plugins/busyholm.js' },
  ],
  any_connected: false,
  shim_available: true,
};

/** Wait until a page rendered the snapshot with time t (pages set html[data-snapshot-t]). */
export async function rendered(page, t) {
  await page.waitForFunction((tt) => document.documentElement.dataset.snapshotT === String(tt), t, { timeout: 5000 });
}
