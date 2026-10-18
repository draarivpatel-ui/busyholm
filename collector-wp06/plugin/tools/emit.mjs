// Runs the plugin over every OpenCode fixture and prints each posted body, one per line.
// Used by the Rust end-to-end test (collector-wp06/tests/wire_e2e.rs).
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "..", "..", "fixtures");
const mod = await import("../busyholm.js");
const dir = mkdtempSync(join(tmpdir(), "bh-emit-"));
const runtimeFile = join(dir, "runtime.json");
writeFileSync(runtimeFile, JSON.stringify({ v: 1, port: 48123, secret: "s3cretpath_0123456789", token: "t0ken_value_0123456789" }), { mode: 0o600 });
const out = [];
const hooks = await mod.default.server({}, { runtimeFile, transport: async (_u, init) => { out.push(init.body); return { ok: true }; } });
for (const d of ["agent-inputs/opencode/plugin", "wp06/opencode/plugin-v2"]) {
  for (const f of readdirSync(join(fixtures, d)).filter((x) => x.endsWith(".json")).sort()) {
    const ev = JSON.parse(readFileSync(join(fixtures, d, f), "utf8"));
    if (ev.input && ev.type?.startsWith("tool.execute")) await hooks[ev.type]?.(ev.input, ev.output);
    else await hooks.event?.({ event: ev });
  }
}
await new Promise((r) => setImmediate(r));
process.stdout.write(out.join("\n") + "\n");
