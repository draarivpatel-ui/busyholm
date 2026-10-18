// WP-08 acceptance test 1, webview half: grow() must produce byte-identical worlds in a real browser
// engine (Google Chrome) and in Node, over the determinism corpus (1,000 random ledgers by default).
//
// Usage (from world/grow):  node test/webview/run.ts [master] [count]
// Env:   GROW_ROOT  package root to test (default: world/grow, i.e. two levels above this file)
// Exit:  0 digests match, 1 mismatch or grow() error, 2 Chrome or playwright-core missing.
//
// How modules reach the browser: no bundler. A tiny http server on 127.0.0.1 (ephemeral port, closed at
// the end) serves the package's .ts files with the types stripped by node:module stripTypeScriptTypes
// (mode "strip"), as text/javascript, so Chrome's native module loader follows the ".ts" imports.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// tools/lib/playwright.mjs is plain JS with no type declarations, so TypeScript needs this directive.
// @ts-expect-error
import { loadPlaywright } from "../../../../tools/lib/playwright.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.GROW_ROOT ?? join(HERE, "..", ".."));
const ENTRY_URL = "/test/webview/entry.ts";
const ENTRY_FILE = join(HERE, "entry.ts"); // always this harness's own entry, imports resolve against ROOT by URL
const RUN_TIMEOUT_MS = 150_000;

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>grow() determinism</title>
<script type="module">
  const q = new URLSearchParams(location.search);
  window.__done = import(${JSON.stringify(ENTRY_URL)})
    .then((m) => { window.__entry = m; return m.run(Number(q.get("master")), Number(q.get("count"))); })
    .catch((e) => ({ userAgent: navigator.userAgent, error: { index: -1, message: "module load failed: " + (e && e.message ? e.message : String(e)) } }));
</script>
`;

const trunc = (s: string): string => (s.length > 2000 ? s.slice(0, 2000) + `... [${s.length - 2000} more chars]` : s);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function serve(req: IncomingMessage, res: ServerResponse, stripped: Map<string, string>): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (code: number, type: string, body: string): void => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  if (url.pathname === "/favicon.ico") return send(204, "text/plain", "");
  if (url.pathname === "/" || url.pathname === "/index.html") return send(200, "text/html; charset=utf-8", PAGE);
  let file: string;
  if (url.pathname === ENTRY_URL) file = ENTRY_FILE;
  else {
    file = resolve(ROOT, "." + decodeURIComponent(url.pathname));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) return send(403, "text/plain", "outside package root");
  }
  if (extname(file) !== ".ts" || !existsSync(file) || !statSync(file).isFile()) return send(404, "text/plain", "not found: " + url.pathname);
  try {
    let js = stripped.get(file);
    if (js === undefined) {
      js = stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" });
      stripped.set(file, js);
    }
    send(200, "text/javascript; charset=utf-8", js);
  } catch (e) {
    send(500, "text/plain", `cannot strip types of ${url.pathname}: ${msg(e)}`);
  }
}

async function main(): Promise<number> {
  let chromium: { launch(o: object): Promise<any> };
  try {
    ({ chromium } = await loadPlaywright());
  } catch (e) {
    console.error(`SKIP/ERROR: ${msg(e)}`);
    return 2;
  }

  if (!existsSync(join(ROOT, "test", "cases.ts"))) {
    console.error(`ERROR: no test/cases.ts under GROW_ROOT ${ROOT}`);
    return 1;
  }
  const { DETERMINISM_COUNT, DETERMINISM_MASTER } = await import(pathToFileURL(join(ROOT, "test", "cases.ts")).href);
  const master = process.argv[2] === undefined ? DETERMINISM_MASTER : Number(process.argv[2]);
  const count = process.argv[3] === undefined ? DETERMINISM_COUNT : Number(process.argv[3]);
  if (!Number.isInteger(count) || count < 1 || !Number.isFinite(master)) {
    console.error(`ERROR: bad arguments (master=${process.argv[2]}, count=${process.argv[3]})`);
    return 1;
  }

  const stripped = new Map<string, string>();
  const server = createServer((req, res) => serve(req, res, stripped));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;

  let browser: any;
  try {
    try {
      browser = await chromium.launch({ channel: "chrome", headless: true });
    } catch (e) {
      console.error(`SKIP/ERROR: could not launch Google Chrome (${msg(e)})`);
      return 2;
    }
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (e: Error) => pageErrors.push(e.message));
    page.on("console", (m: any) => { if (m.type() === "error") pageErrors.push("console.error: " + m.text()); });
    await page.goto(`http://127.0.0.1:${port}/?master=${master}&count=${count}`);

    const t0 = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const b = await Promise.race([
      page.evaluate(() => (window as any).__done),
      new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`browser run exceeded ${RUN_TIMEOUT_MS} ms`)), RUN_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    const browserMs = performance.now() - t0;
    const version = browser.version();

    // Node side.
    const t1 = performance.now();
    let node: { digest: string; hashes: string[] } | undefined;
    let nodeError: { index: number; message: string } | undefined;
    try {
      const { hashWorlds } = await import(pathToFileURL(join(ROOT, "test", "hash-worlds.ts")).href);
      node = hashWorlds(master, count);
    } catch (e) {
      nodeError = { index: -1, message: msg(e) };
    }
    const nodeMs = performance.now() - t1;

    console.log(`master=${master} count=${count} root=${ROOT}`);
    console.log(`browser: Chrome ${version}, ${b.userAgent} (${browserMs.toFixed(0)} ms)`);
    console.log(`node:    ${process.version} (${nodeMs.toFixed(0)} ms)`);
    if (pageErrors.length > 0) console.log("page errors:\n  " + pageErrors.join("\n  "));

    if (b.error !== undefined) {
      console.log(`FAIL: grow() threw in the browser at case ${b.error.index}: ${b.error.message}`);
      if (nodeError !== undefined) console.log(`      (Node side also failed: ${nodeError.message})`);
      return 1;
    }
    if (nodeError !== undefined || node === undefined) {
      console.log(`FAIL: Node side failed: ${nodeError?.message}`);
      return 1;
    }
    console.log(`browser digest: ${b.digest}`);
    console.log(`node digest:    ${node.digest}`);
    if (b.digest === node.digest && b.hashes.length === node.hashes.length) {
      console.log(`PASS: ${count} worlds byte-identical in Chrome ${version} and Node ${process.version}`);
      return 0;
    }
    const n = Math.min(b.hashes.length, node.hashes.length);
    let first = 0;
    while (first < n && b.hashes[first] === node.hashes[first]) first++;
    console.log(`FAIL: digests differ; first differing case index: ${first} (browser has ${b.hashes.length} hashes, node ${node.hashes.length})`);
    if (first < n) {
      const { determinismInput } = await import(pathToFileURL(join(ROOT, "test", "cases.ts")).href);
      const { grow } = await import(pathToFileURL(join(ROOT, "src", "grow.ts")).href);
      const { canonicalJson } = await import(pathToFileURL(join(ROOT, "src", "canonical.ts")).href);
      const c = determinismInput(master, first);
      console.log(`browser hash ${b.hashes[first]}\nnode hash    ${node.hashes[first]}`);
      console.log("browser canonical JSON:\n" + trunc(await page.evaluate(([m, i]: number[]) => (window as any).__entry.canonicalFor(m, i), [master, first])));
      console.log("node canonical JSON:\n" + trunc(canonicalJson(grow(c.seed, c.ledger, c.choices, c.options))));
    }
    return 1;
  } catch (e) {
    console.error(`FAIL: harness error: ${msg(e)}`);
    return 1;
  } finally {
    await browser?.close().catch(() => {});
    await new Promise<void>((ok) => server.close(() => ok()));
  }
}

process.exitCode = await main();
