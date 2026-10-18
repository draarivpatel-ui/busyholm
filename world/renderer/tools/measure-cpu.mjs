#!/usr/bin/env node
// measure-cpu.mjs: CPU and memory measurement for a web page in real Google Chrome (macOS).
//
// Method: launches a fresh Chrome (own temp --user-data-dir, so the user's own Chrome is never
// touched), loads the page, waits for it to settle, then runs the repo's measure.py
// (tools/measure.py: proc_pid_rusage user+system CPU time over a window, CPU as % of one
// core, phys_footprint memory, wakeups/s) against the browser process plus every descendant
// of it. That makes the numbers comparable with the SPEC 6.7 budgets.
//
// Usage:
//   node world/renderer/tools/measure-cpu.mjs --url <url or file path> [--width 1440] [--height 120]
//        [--dpr 2] [--settle 15] [--seconds 45] [--label "strip calm"] [--headless]
//        [--json out.json] [--repeat 1]
//   node world/renderer/tools/measure-cpu.mjs --scenarios scenarios.json [--settle 15] [--seconds 45]
//        [--headless] [--json out.json] [--repeat 1]
//   scenarios.json: [{ "label": "...", "url": "...", "width": 1440, "height": 120, "dpr": 2 }, ...]
//   (per-scenario settle / seconds are optional overrides; CLI values are the defaults)
//
// If the page defines window.__bhStats (an object), it is read at the start and end of the
// window and included in the results next to the CPU numbers.
//
// Needs Playwright (PLAYWRIGHT_PATH, see tools/lib/playwright.mjs) and python3 on PATH.

import { parseArgs } from 'node:util';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPlaywright } from '../../../tools/lib/playwright.mjs';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const MEASURE_PY = resolve(HERE, '../../../tools/measure.py');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- process helpers ----------

async function psTable() {
  const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 64 * 1024 * 1024 });
  const rows = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], command: m[3] });
  }
  return rows;
}

// The browser process of the Chrome we launched: its command line carries our unique
// --user-data-dir and has no --type= (helpers carry --type=).
async function findBrowserPid(userDataDir, timeoutMs = 15000) {
  const needle = `--user-data-dir=${userDataDir}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await psTable();
    const hit = rows.find((r) => r.command.includes(needle) && !r.command.includes(' --type='));
    if (hit) return hit.pid;
    await sleep(200);
  }
  throw new Error(`could not find the Chrome browser process for ${userDataDir}`);
}

// Every descendant (by parent pid) of rootPid. Only descendants of the browser we launched.
async function descendantsOf(rootPid) {
  const rows = await psTable();
  const kids = new Map();
  for (const r of rows) {
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r);
  }
  const out = [];
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    for (const c of kids.get(p) || []) {
      out.push(c);
      stack.push(c.pid);
    }
  }
  return out;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runMeasure({ pid, extraPids, seconds, label, jsonFile }) {
  return new Promise((resolveP, rejectP) => {
    const args = [MEASURE_PY, '--pid', String(pid), '--duration', String(seconds), '--label', label, '--json', jsonFile];
    if (extraPids.length) args.push('--extra-pids', extraPids.join(','));
    const child = spawn('python3', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', rejectP);
    child.on('exit', (code) => (code === 0 ? resolveP() : rejectP(new Error(`measure.py exited with ${code}`))));
  });
}

// ---------- one scenario run ----------

function toUrl(u) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || u.startsWith('about:') || u.startsWith('data:')) return u;
  const qIdx = u.indexOf('?');
  const filePath = qIdx >= 0 ? u.slice(0, qIdx) : u;
  const qs = qIdx >= 0 ? u.slice(qIdx) : '';
  const p = resolve(filePath);
  if (!existsSync(p)) throw new Error(`not a URL and no such file: ${u}`);
  return pathToFileURL(p).href + qs;
}

async function readStats(page) {
  try {
    return await page.evaluate(() => {
      const s = window.__bhStats;
      return s && typeof s === 'object' ? JSON.parse(JSON.stringify(s)) : null;
    });
  } catch {
    return null;
  }
}

function statsDelta(a, b, seconds) {
  if (!a || !b) return null;
  const d = {};
  for (const k of Object.keys(b)) {
    if (typeof b[k] === 'number' && typeof a[k] === 'number') {
      d[k] = +(b[k] - a[k]).toFixed(3);
      d[`${k}_per_s`] = +((b[k] - a[k]) / seconds).toFixed(2);
    }
  }
  return d;
}

async function runScenario(chromium, sc, opts, runIndex) {
  const url = toUrl(sc.url);
  const width = sc.width ?? opts.width;
  const height = sc.height ?? opts.height;
  const dpr = sc.dpr ?? opts.dpr;
  const settle = sc.settle ?? opts.settle;
  const seconds = sc.seconds ?? opts.seconds;
  const label = sc.label ?? opts.label ?? url;
  const runLabel = opts.repeat > 1 ? `${label} #${runIndex + 1}` : label;

  const userDataDir = mkdtempSync(join(tmpdir(), 'bh-measure-'));
  const jsonFile = join(userDataDir, 'measure-result.json');
  let context = null;
  let browserPid = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chrome',
      headless: opts.headless,
      viewport: { width, height },
      deviceScaleFactor: dpr,
      args: [
        `--window-position=0,600`,
        `--window-size=${width},${height + 120}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    browserPid = await findBrowserPid(userDataDir);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url, { waitUntil: 'load' });

    if (settle < 15) {
      console.warn(`WARNING [${runLabel}]: a fresh Chrome profile keeps its browser process busy (~10-15% of a core) for roughly the first 10-15 s; with --settle ${settle} the CPU number is inflated. Use --settle 15 or more for real numbers.`);
    }
    console.log(`[${runLabel}] loaded ${url} (${width}x${height} @${dpr}x, ${opts.headless ? 'headless' : 'headed'}), settling ${settle}s`);
    await sleep(settle * 1000);

    // Process set: browser + every descendant. Passed explicitly as a safety net on top of
    // measure.py's own descendant walk. Nothing outside this browser's tree is included.
    const kids = await descendantsOf(browserPid);
    const extraPids = kids.map((k) => k.pid);

    const statsStart = await readStats(page);
    await runMeasure({ pid: browserPid, extraPids, seconds, label: runLabel, jsonFile });
    const statsEnd = await readStats(page);

    const m = JSON.parse(readFileSync(jsonFile, 'utf8'));
    const procNames = m.processes.map((p) => p.name || '');
    return {
      label: runLabel,
      url,
      width,
      height,
      dpr,
      headless: opts.headless,
      settle_s: settle,
      window_s: m.duration_s,
      cpu_pct: m.total.cpu_pct,
      footprint_mb: m.total.footprint_mb,
      rss_mb: m.total.rss_mb,
      wakeups_per_s: m.total.wakeups_per_s,
      processes: m.total.processes,
      has_renderer: procNames.some((n) => /Renderer/.test(n)),
      has_gpu: procNames.some((n) => /GPU/.test(n)),
      bhStats: statsEnd,
      bhStatsStart: statsStart,
      bhStatsDelta: statsDelta(statsStart, statsEnd, m.duration_s),
      measure: m,
    };
  } finally {
    // Always close the browser we launched, even on errors.
    if (context) {
      try {
        await Promise.race([context.close(), sleep(8000)]);
      } catch {}
    }
    if (browserPid && isAlive(browserPid)) {
      try {
        process.kill(browserPid, 'SIGTERM');
        await sleep(1000);
        if (isAlive(browserPid)) process.kill(browserPid, 'SIGKILL');
      } catch {}
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  }
}

// ---------- main ----------

function table(results) {
  const lines = [
    '| label | CPU % (one core) | footprint MB (sum) | wakeups/s | processes |',
    '|---|---:|---:|---:|---:|',
  ];
  for (const r of results) {
    lines.push(`| ${r.label} | ${r.cpu_pct.toFixed(2)} | ${r.footprint_mb.toFixed(1)} | ${r.wakeups_per_s.toFixed(1)} | ${r.processes} |`);
  }
  return lines.join('\n');
}

async function main() {
  const { values: v } = parseArgs({
    options: {
      url: { type: 'string' },
      scenarios: { type: 'string' },
      width: { type: 'string', default: '1440' },
      height: { type: 'string', default: '120' },
      dpr: { type: 'string', default: '2' },
      settle: { type: 'string', default: '15' },
      seconds: { type: 'string', default: '45' },
      label: { type: 'string' },
      headless: { type: 'boolean', default: false },
      json: { type: 'string' },
      repeat: { type: 'string', default: '1' },
    },
  });
  if (!v.url && !v.scenarios) {
    console.error('usage: measure-cpu.mjs --url <url|file> [--width N --height N --dpr N --settle S --seconds S --label L --headless --json F --repeat N]\n       measure-cpu.mjs --scenarios <file.json> [...]');
    process.exit(2);
  }
  const opts = {
    width: +v.width,
    height: +v.height,
    dpr: +v.dpr,
    settle: +v.settle,
    seconds: +v.seconds,
    label: v.label,
    headless: v.headless,
    repeat: Math.max(1, parseInt(v.repeat, 10) || 1),
  };
  let scenarios;
  if (v.scenarios) {
    scenarios = JSON.parse(readFileSync(resolve(v.scenarios), 'utf8'));
    if (!Array.isArray(scenarios)) throw new Error('--scenarios file must contain a JSON array');
  } else {
    scenarios = [{ url: v.url, label: v.label ?? v.url }];
  }

  if (!existsSync(MEASURE_PY)) throw new Error(`measure.py not found at ${MEASURE_PY}`);
  const { chromium } = await loadPlaywright().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });

  const results = [];
  const failures = [];
  for (const sc of scenarios) {
    for (let i = 0; i < opts.repeat; i++) {
      try {
        results.push(await runScenario(chromium, sc, opts, i));
      } catch (e) {
        console.error(`scenario "${sc.label ?? sc.url}" failed: ${e.message}`);
        failures.push({ label: sc.label ?? sc.url, error: e.message });
      }
    }
  }

  if (results.length) {
    console.log('\n' + table(results));
    for (const r of results) {
      if (r.bhStats) {
        console.log(`\n__bhStats [${r.label}]: ${JSON.stringify(r.bhStats)}`);
        if (r.bhStatsDelta) console.log(`  over window: ${JSON.stringify(r.bhStatsDelta)}`);
      }
      if (!r.has_renderer || !r.has_gpu) {
        console.log(`\nWARNING [${r.label}]: process set is missing ${!r.has_renderer ? 'a renderer' : ''}${!r.has_renderer && !r.has_gpu ? ' and ' : ''}${!r.has_gpu ? 'a GPU helper' : ''} process`);
      }
    }
  }
  if (v.json) {
    writeFileSync(resolve(v.json), JSON.stringify({ results, failures }, null, 2));
    console.log(`\nwrote ${resolve(v.json)}`);
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
