// The shipping build for this OS (or a cross target). Everything the release needs, or it fails:
//   1. world/ and ui/ pages built and assembled into dist/ (beforeBuildCommand does this through
//      `assemble-frontend.mjs --build-real`, which fails if any real page or asset is missing)
//   2. the busyholm-hook shim built for the target and placed at src-tauri/binaries/busyholm-hook-<triple>
//   3. `tauri build --features collector` with src-tauri/tauri.release.conf.json (externalBin = the shim)
//   4. the output checked: the app binary and the shim beside it must exist
//
//   node scripts/build-release.mjs [--target <triple>] [--bundles app|nsis|deb|appimage|...] [--cross-windows]
//
// Packaging scripts (packaging/) may call this, or do the same steps with their own externalBin path.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseCargoEnv, shimSidecarName, tauriBuildArgs, verifyBundle } from "./release-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const repoRoot = resolve(appRoot, "..");
const tauriDir = join(appRoot, "src-tauri");

function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const run = (cmd, args, cwd, env = process.env) => {
  console.log("+ " + [cmd, ...args].join(" "));
  execFileSync(cmd, args, { cwd, stdio: "inherit", env });
};

const host = /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
const target = flag("--target") ?? host;
if (!target) throw new Error("build-release: cannot determine the target triple (rustc -vV)");
const os = target.includes("apple") ? "macos" : target.includes("windows") ? "windows" : "linux";
const cross = process.argv.includes("--cross-windows") || (os === "windows" && !host.includes("windows"));
const releaseEnv = releaseCargoEnv({ env: process.env, repoRoot });

try {
  // Generate third-party notices offline (Rust crates, npm packages, Fraunces OFL) so tauri.release.conf.json can bundle them.
  run("python3", ["tools/verify/run.py", "licenses"], repoRoot);

  // The shim and sidecar live in the root cargo workspace.
  run(
    "cargo",
    [cross ? "xwin" : "build", ...(cross ? ["build"] : []), "--release", "--target", target, "-p", "busyholm-shim", "-p", "busyholm-sidecar"],
    repoRoot,
    releaseEnv,
  );
  const ext = os === "windows" ? ".exe" : "";
  const built = join(repoRoot, "target", target, "release", "busyholm-hook" + ext);
  const builtSidecar = join(repoRoot, "target", target, "release", "busyholm-sidecar" + ext);
  mkdirSync(join(tauriDir, "binaries"), { recursive: true });
  copyFileSync(built, join(tauriDir, "binaries", shimSidecarName(target)));

  const tauri = join(appRoot, "node_modules", ".bin", "tauri");
  run(tauri, tauriBuildArgs({ target, bundles: flag("--bundles"), crossWindows: cross }), appRoot, releaseEnv);

  const targetReleaseDir = join(tauriDir, "target", target, "release");
  verifyBundle(targetReleaseDir, { os });
  if (target === host) {
    const rootHostRelease = join(repoRoot, "target", "release");
    mkdirSync(rootHostRelease, { recursive: true });
    copyFileSync(built, join(rootHostRelease, "busyholm-hook" + ext));
    if (existsSync(builtSidecar)) {
      copyFileSync(builtSidecar, join(rootHostRelease, "busyholm-sidecar" + ext));
    }
    const tauriHostRelease = join(tauriDir, "target", "release");
    mkdirSync(tauriHostRelease, { recursive: true });
    copyFileSync(join(targetReleaseDir, "busyholm" + ext), join(tauriHostRelease, "busyholm" + ext));
    const appBundleSrc = join(targetReleaseDir, "bundle", "macos", "Busyholm.app");
    if (os === "macos" && existsSync(appBundleSrc)) {
      const appBundleDst = join(tauriHostRelease, "bundle", "macos", "Busyholm.app");
      rmSync(appBundleDst, { recursive: true, force: true });
      mkdirSync(dirname(appBundleDst), { recursive: true });
      cpSync(appBundleSrc, appBundleDst, { recursive: true, verbatimSymlinks: true });
    }
  }
  console.log("build-release: ok (" + target + ")");
} catch (e) {
  console.error("build-release: FAILED: " + String(e && e.message ? e.message : e));
  process.exit(1);
}
