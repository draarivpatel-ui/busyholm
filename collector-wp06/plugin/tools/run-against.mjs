// Runs the real plugin (real fetch, no test transport) over every OpenCode fixture against a
// running receiver whose runtime file is given as argv[2]. Used by tests/collector_integration.rs.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "..", "..", "fixtures");
const mod = await import("../busyholm.js");
const hooks = await mod.default.server({}, { runtimeFile: process.argv[2] });
let sent = 0;
for (const d of ["agent-inputs/opencode/plugin", "wp06/opencode/plugin-v2"]) {
  for (const f of readdirSync(join(fixtures, d)).filter((x) => x.endsWith(".json")).sort()) {
    const ev = JSON.parse(readFileSync(join(fixtures, d, f), "utf8"));
    if (ev.input && ev.type?.startsWith("tool.execute")) await hooks[ev.type]?.(ev.input, ev.output);
    else await hooks.event?.({ event: ev });
    sent += 1;
    await new Promise((r) => setTimeout(r, 20)); // keep order: the plugin fires without waiting
  }
}
await new Promise((r) => setTimeout(r, 400));
console.log(`fed ${sent} fixtures`);
