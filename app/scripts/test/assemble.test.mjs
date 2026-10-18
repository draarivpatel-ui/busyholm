// H1: the frontend assembly must fail loudly when a real page is missing (in release mode) and must
// not ship the renderer's bench and capture pages. Runs against temp trees, never the real dist.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemble, REQUIRED_PAGES } from "../assemble-frontend.mjs";

function tree() {
  const repo = mkdtempSync(join(tmpdir(), "bh-asm-"));
  const app = join(repo, "app");
  mkdirSync(join(app, "pages"), { recursive: true });
  for (const p of REQUIRED_PAGES) writeFileSync(join(app, "pages", p), "<!doctype html>placeholder " + p);
  return { repo, app };
}
function put(file, text = "x") {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}
function fullWorld(repo) {
  put(join(repo, "world/dist/strip.html"), '<script src="strip.js"></script>');
  put(join(repo, "world/dist/strip.js"));
  put(join(repo, "world/dist/ambient.html"), '<script src="ambient.js"></script>');
  put(join(repo, "world/dist/ambient.js"));
  put(join(repo, "world/dist/bench.html"));
  put(join(repo, "world/dist/capture.js"));
}
function fullUi(repo) {
  for (const n of ["popover", "settings", "details"]) {
    put(join(repo, `ui/dist/${n}.html`), `<link href="ui/base.css"><script src="ui/${n}.js"></script>`);
    put(join(repo, `ui/dist/ui/${n}.js`));
  }
  put(join(repo, "ui/dist/ui/base.css"));
}
const quiet = () => {};

test("dev mode: missing world and ui builds fall back to placeholders", () => {
  const { repo, app } = tree();
  const r = assemble({ appRoot: app, repoRoot: repo, requireReal: false, log: quiet });
  assert.ok(r.missing.length > 0, "reports what is missing");
  assert.ok(existsSync(join(app, "dist/strip.html")));
});

test("release mode: a missing world build fails and names the file", () => {
  const { repo, app } = tree();
  fullUi(repo);
  assert.throws(() => assemble({ appRoot: app, repoRoot: repo, requireReal: true, log: quiet }), /strip\.html/);
});

test("release mode: a missing ui build fails and names the file", () => {
  const { repo, app } = tree();
  fullWorld(repo);
  assert.throws(() => assemble({ appRoot: app, repoRoot: repo, requireReal: true, log: quiet }), /popover\.html/);
});

test("release mode: a page whose script is missing fails", () => {
  const { repo, app } = tree();
  fullWorld(repo);
  fullUi(repo);
  put(join(repo, "ui/dist/settings.html"), '<script src="ui/gone.js"></script>');
  assert.throws(() => assemble({ appRoot: app, repoRoot: repo, requireReal: true, log: quiet }), /ui\/gone\.js/);
});

test("release mode: complete builds pass, real pages replace the placeholders, bench and capture are not shipped", () => {
  const { repo, app } = tree();
  fullWorld(repo);
  fullUi(repo);
  const r = assemble({ appRoot: app, repoRoot: repo, requireReal: true, log: quiet });
  assert.deepEqual(r.missing, []);
  assert.match(readFileSync(join(app, "dist/strip.html"), "utf8"), /strip\.js/);
  assert.ok(existsSync(join(app, "dist/placeholder/strip.html")), "placeholders stay for the acceptance tests");
  assert.ok(!existsSync(join(app, "dist/bench.html")));
  assert.ok(!existsSync(join(app, "dist/capture.js")));
});

test("release mode: a placeholder-only page set is rejected even if the files exist", () => {
  // world/dist/strip.html identical to the placeholder means the real build did not run.
  const { repo, app } = tree();
  fullUi(repo);
  put(join(repo, "world/dist/strip.html"), "<!doctype html>placeholder strip.html");
  put(join(repo, "world/dist/ambient.html"), '<script src="ambient.js"></script>');
  put(join(repo, "world/dist/ambient.js"));
  assert.throws(() => assemble({ appRoot: app, repoRoot: repo, requireReal: true, log: quiet }), /placeholder/);
});
