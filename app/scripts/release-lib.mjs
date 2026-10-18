// Pure helpers for the release entry point (scripts/build-release.mjs). Node built-ins only.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(here, "../..");
export const releaseConfig = join(here, "..", "src-tauri", "tauri.release.conf.json");

/** Rustc path-remap flags so release binaries never embed the developer's home or workspace path. */
export function releaseRemapFlags({ repoRoot = defaultRepoRoot, homeDir = homedir() } = {}) {
  const flags = [];
  const pushPair = (from, to) => {
    if (!from) return;
    const f = `--remap-path-prefix=${from}=${to}`;
    if (!flags.includes(f)) flags.push(f);
    try {
      const real = realpathSync(from);
      const rf = `--remap-path-prefix=${real}=${to}`;
      if (!flags.includes(rf)) flags.push(rf);
    } catch {}
  };
  pushPair(homeDir, "~");
  pushPair(repoRoot, "busyholm");
  return flags;
}

/** Environment for release cargo/tauri invocations with CARGO_ENCODED_RUSTFLAGS set. */
export function releaseCargoEnv({ env = process.env, repoRoot = defaultRepoRoot, homeDir = homedir() } = {}) {
  const out = { ...env };
  const existing = out.CARGO_ENCODED_RUSTFLAGS
    ? out.CARGO_ENCODED_RUSTFLAGS.split("\x1f").filter(Boolean)
    : out.RUSTFLAGS
      ? out.RUSTFLAGS.trim().split(/\s+/).filter(Boolean)
      : [];
  const merged = [...existing];
  for (const flag of releaseRemapFlags({ repoRoot, homeDir })) {
    if (!merged.includes(flag)) merged.push(flag);
  }
  out.CARGO_ENCODED_RUSTFLAGS = merged.join("\x1f");
  delete out.RUSTFLAGS;
  return out;
}

/** Arguments for `tauri build`: collector always linked, shim bundled by the release config. */
export function tauriBuildArgs({ target, bundles, crossWindows = false } = {}) {
  const a = ["build", "--features", "collector", "--config", releaseConfig, "--ci"];
  if (target) a.push("--target", target);
  // macOS: the .app only by default. Tauri's bundle_dmg.sh styles a Finder window and fails without a GUI
  // session; the DMG is made by packaging/build.py with hdiutil instead. Pass --bundles to override.
  const chosen = bundles || (target && target.includes("apple-darwin") ? "app" : undefined);
  if (chosen) a.push("--bundles", chosen);
  if (crossWindows) a.push("--runner", "cargo-xwin");
  return a;
}

/** Tauri's externalBin convention: `<name>-<target triple>` plus `.exe` on Windows. */
export function shimSidecarName(triple) {
  return `busyholm-hook-${triple}${triple.includes("windows") ? ".exe" : ""}`;
}

/** Files (relative to the cargo `release` folder of the build) that must exist after a bundle build. */
export function requiredBundleFiles({ os }) {
  if (os === "macos") {
    return [
      "busyholm",
      "bundle/macos/Busyholm.app/Contents/MacOS/busyholm",
      "bundle/macos/Busyholm.app/Contents/MacOS/busyholm-hook",
      "bundle/macos/Busyholm.app/Contents/Resources/THIRD-PARTY-NOTICES.txt",
      "bundle/macos/Busyholm.app/Contents/Resources/OFL.txt",
    ];
  }
  if (os === "windows") return ["busyholm.exe", "busyholm-hook.exe"];
  return ["busyholm", "busyholm-hook"];
}

/** Throws, naming every missing file, when the build output lacks the app or the shim. */
export function verifyBundle(releaseDir, { os }) {
  const missing = requiredBundleFiles({ os }).filter((f) => !existsSync(join(releaseDir, f)));
  if (missing.length > 0) {
    throw new Error("release build is incomplete; missing in " + releaseDir + ":\n  - " + missing.join("\n  - "));
  }
}
