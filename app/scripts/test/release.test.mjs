// H1: the release build entry points. Pure helpers; nothing here compiles or packages anything.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  tauriBuildArgs,
  shimSidecarName,
  requiredBundleFiles,
  verifyBundle,
  releaseRemapFlags,
  releaseCargoEnv,
} from "../release-lib.mjs";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("the tauri build always enables the collector and merges the release config", () => {
  const a = tauriBuildArgs({ target: "aarch64-apple-darwin", bundles: "app" });
  assert.ok(a.join(" ").includes("--features collector"));
  assert.ok(a.some((x) => x.endsWith("tauri.release.conf.json")));
  assert.ok(a.includes("--target") && a.includes("aarch64-apple-darwin"));
  assert.ok(a.includes("--bundles") && a.includes("app"));
});

test("windows targets use the cargo-xwin runner only when cross building", () => {
  const a = tauriBuildArgs({ target: "x86_64-pc-windows-msvc", crossWindows: true });
  assert.ok(a.includes("--runner") && a.includes("cargo-xwin"));
  assert.ok(!tauriBuildArgs({ target: "aarch64-apple-darwin" }).includes("--runner"));
});

test("macOS builds default to the .app bundle only; the DMG comes from packaging/build.py (hdiutil)", () => {
  const a = tauriBuildArgs({ target: "aarch64-apple-darwin" });
  const i = a.indexOf("--bundles");
  assert.ok(i >= 0 && a[i + 1] === "app");
  const b = tauriBuildArgs({ target: "aarch64-apple-darwin", bundles: "app,dmg" });
  assert.equal(b[b.indexOf("--bundles") + 1], "app,dmg");
  assert.ok(!tauriBuildArgs({ target: "x86_64-pc-windows-msvc" }).includes("--bundles"));
});

test("sidecar file names follow the tauri externalBin convention", () => {
  assert.equal(shimSidecarName("aarch64-apple-darwin"), "busyholm-hook-aarch64-apple-darwin");
  assert.equal(shimSidecarName("x86_64-pc-windows-msvc"), "busyholm-hook-x86_64-pc-windows-msvc.exe");
});

test("the release config bundles the shim and third-party notices, and nothing is in the base config that would break cargo test", () => {
  const rel = JSON.parse(readFileSync(join(appRoot, "src-tauri/tauri.release.conf.json"), "utf8"));
  assert.deepEqual(rel.bundle.externalBin, ["binaries/busyholm-hook"]);
  assert.equal(rel.bundle.resources?.["../../packaging/out/notices/THIRD-PARTY-NOTICES.txt"], "THIRD-PARTY-NOTICES.txt");
  assert.equal(rel.bundle.resources?.["../../packaging/out/notices/OFL.txt"], "OFL.txt");
  const base = JSON.parse(readFileSync(join(appRoot, "src-tauri/tauri.conf.json"), "utf8"));
  assert.equal(base.bundle.externalBin, undefined, "tauri-build checks externalBin at every cargo build");
  assert.match(base.build.beforeBuildCommand, /--build-real/);
});

test("package.json build scripts go through the release entry point", () => {
  const pkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
  for (const k of ["build", "build:app", "build:win-x64", "build:win-arm64"]) {
    assert.match(pkg.scripts[k], /build-release\.mjs/, k);
  }
});

test("required bundle files per OS", () => {
  const mac = requiredBundleFiles({ os: "macos" });
  assert.ok(mac.includes("bundle/macos/Busyholm.app/Contents/MacOS/busyholm-hook"));
  assert.ok(mac.includes("bundle/macos/Busyholm.app/Contents/Resources/THIRD-PARTY-NOTICES.txt"));
  assert.ok(mac.includes("bundle/macos/Busyholm.app/Contents/Resources/OFL.txt"));
  assert.ok(requiredBundleFiles({ os: "windows" }).includes("busyholm-hook.exe"));
  assert.ok(requiredBundleFiles({ os: "linux" }).includes("busyholm-hook"));
});

test("verifyBundle fails loudly when the shim is missing and passes when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "bh-bundle-"));
  const f = (p) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), "x"); };
  f("busyholm");
  assert.throws(() => verifyBundle(dir, { os: "linux" }), /busyholm-hook/);
  f("busyholm-hook");
  assert.doesNotThrow(() => verifyBundle(dir, { os: "linux" }));
});

test("releaseCargoEnv remaps home to ~ and repoRoot to busyholm in CARGO_ENCODED_RUSTFLAGS", () => {
  const flags = releaseRemapFlags({ homeDir: "/Users/alice", repoRoot: "/Users/alice/work/busyholm" });
  const homeIdx = flags.indexOf("--remap-path-prefix=/Users/alice=~");
  const repoIdx = flags.indexOf("--remap-path-prefix=/Users/alice/work/busyholm=busyholm");
  assert.ok(homeIdx >= 0, "home remap flag present");
  assert.ok(repoIdx > homeIdx, "repo remap flag follows home so repo paths take precedence in rustc");
  const env = releaseCargoEnv({
    env: { RUSTFLAGS: "-C debuginfo=0" },
    homeDir: "/Users/alice",
    repoRoot: "/Users/alice/work/busyholm",
  });
  assert.equal(env.RUSTFLAGS, undefined);
  const encoded = env.CARGO_ENCODED_RUSTFLAGS.split("\x1f");
  assert.ok(encoded.includes("--remap-path-prefix=/Users/alice=~"));
  assert.ok(encoded.includes("--remap-path-prefix=/Users/alice/work/busyholm=busyholm"));
});
