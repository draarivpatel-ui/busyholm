// True when the module with this import.meta.url is the script node was started with.
// Compares real, resolved paths (case-insensitively on Windows), so a drive-letter or
// symlink difference can never make a script silently skip its main().
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function norm(p) {
  let r = resolve(p);
  try {
    r = realpathSync.native(r);
  } catch {
    // keep the resolved path
  }
  return process.platform === "win32" ? r.toLowerCase() : r;
}

export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && norm(process.argv[1]) === norm(fileURLToPath(metaUrl));
}
