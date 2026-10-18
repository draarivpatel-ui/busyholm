// Assemble app/dist/ (the Tauri frontend) from the placeholder pages, then overlay the real
// world/ and ui/ builds. Node built-ins only.
//
//   node scripts/assemble-frontend.mjs               development: missing real builds fall back to placeholders
//   node scripts/assemble-frontend.mjs --require-real   release: fail if any real page or its assets is missing
//   node scripts/assemble-frontend.mjs --build-real     release: build world/ and ui/ first, then --require-real
//
//   dist/                 placeholders, then world/dist and ui/dist copied over them
//   dist/placeholder/     the untouched placeholders (used by the acceptance tests)
//
// The renderer's bench and capture pages are developer tools and are never copied into dist/.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The five window pages (README "Page contract"). */
export const REQUIRED_PAGES = ["strip.html", "ambient.html", "popover.html", "settings.html", "details.html"];
const WORLD_PAGES = ["strip.html", "ambient.html"];
const UI_PAGES = ["popover.html", "settings.html", "details.html"];
const NOT_SHIPPED = /^(bench|capture)\./;

/** Local script and stylesheet references of an HTML page (data: URLs and remote URLs are skipped). */
export function localRefs(html) {
  const refs = [];
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"#?]+)[^"]*"/gi)) {
    const ref = m[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) continue;
    refs.push(ref.replace(/^\.?\//, ""));
  }
  return refs;
}

function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return n;
}

/**
 * Build app/dist. Returns `{ missing }`: the real pages (or their assets) that are absent or are still
 * the placeholder. With `requireReal`, a non-empty list throws instead, naming every problem.
 */
export function assemble({ appRoot, repoRoot, requireReal = false, log = console.log }) {
  const pages = join(appRoot, "pages");
  const dist = join(appRoot, "dist");
  const placeholder = join(dist, "placeholder");

  if (!existsSync(join(pages, "strip.html"))) {
    throw new Error("assemble-frontend: " + join(pages, "strip.html") + " is missing; nothing to assemble.");
  }
  // Safety: only ever delete the folder we mean to.
  if (dirname(dist) !== appRoot) throw new Error("assemble-frontend: refusing to clean unexpected path " + dist);

  rmSync(dist, { recursive: true, force: true });
  mkdirSync(placeholder, { recursive: true });
  cpSync(pages, dist, { recursive: true });
  log("placeholders: app/pages -> app/dist");
  cpSync(pages, placeholder, { recursive: true });
  log("placeholders: app/pages -> app/dist/placeholder");

  const overlay = (name, sourceDir, markers) => {
    if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
      log(name + ": " + relative(repoRoot, sourceDir) + " not present, skipped");
      return;
    }
    const found = markers.filter((m) => existsSync(join(sourceDir, m)));
    if (found.length === 0) {
      log(name + ": " + relative(repoRoot, sourceDir) + " has none of " + markers.join(", ") + ", skipped");
      return;
    }
    const guard = (src) => {
      const rel = relative(sourceDir, src);
      if (rel === "placeholder" || rel.startsWith("placeholder" + sep)) return false;
      return !(rel !== "" && !rel.includes(sep) && NOT_SHIPPED.test(rel));
    };
    cpSync(sourceDir, dist, { recursive: true, force: true, filter: guard });
    log(name + ": " + relative(repoRoot, sourceDir) + " -> app/dist (" + countFiles(sourceDir) + " files; has " + found.join(", ") + ")");
  };
  overlay("world", join(repoRoot, "world", "dist"), WORLD_PAGES);
  overlay("ui", join(repoRoot, "ui", "dist"), UI_PAGES);

  const missing = [];
  for (const [owner, names] of [["world/dist", WORLD_PAGES], ["ui/dist", UI_PAGES]]) {
    for (const name of names) {
      const real = join(repoRoot, owner, name);
      if (!existsSync(real)) {
        missing.push(`${owner}/${name} (the real page was not built)`);
        continue;
      }
      const html = readFileSync(real, "utf8");
      if (existsSync(join(pages, name)) && html === readFileSync(join(pages, name), "utf8")) {
        missing.push(`${owner}/${name} (identical to the placeholder, so the real build did not run)`);
        continue;
      }
      for (const ref of localRefs(html)) {
        if (!existsSync(join(dist, ref))) missing.push(`${ref} (referenced by ${owner}/${name})`);
      }
    }
  }
  if (requireReal && missing.length > 0) {
    throw new Error(
      "assemble-frontend: the shipping build needs the real pages, but these are missing:\n  - " + missing.join("\n  - ") +
        "\nBuild them with: node world/renderer/tools/build.mjs && node ui/tools/build.mjs (or pass --build-real).",
    );
  }
  return { missing };
}

/** Build the real world and UI pages. */
export function buildReal(repoRoot, log = console.log) {
  for (const script of [join(repoRoot, "world", "renderer", "tools", "build.mjs"), join(repoRoot, "ui", "tools", "build.mjs")]) {
    log("building " + relative(repoRoot, script));
    execFileSync(process.execPath, [script], { stdio: "inherit" });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const appRoot = resolve(here, "..");
  const repoRoot = resolve(appRoot, "..");
  const args = process.argv.slice(2);
  const build = args.includes("--build-real");
  try {
    if (build) buildReal(repoRoot);
    assemble({ appRoot, repoRoot, requireReal: build || args.includes("--require-real") });
  } catch (e) {
    console.error(String(e && e.message ? e.message : e));
    process.exit(1);
  }
}
