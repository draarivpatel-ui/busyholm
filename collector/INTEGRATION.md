# Collector integration (WP-03, finished by the integration pass)

Who this is for: the app core (`app/src-tauri`, WP-02), the hook shim (`shim/`, WP-07) and the installer. It says how the
service is started, what the shim may rely on, and what is still missing.

## 1. The pieces

| Piece | Where | What it is |
|---|---|---|
| `collector` library | `collector/` (package `busyholm-collector`) | receiver, event bus, state machine, usage store, ledger, `run_service`. It cannot depend on the adapters (they depend on it). |
| Adapters | `collector-claude/` (WP-04), `collector-codex/` (WP-05, own Cargo workspace, listed under `exclude` in the root `Cargo.toml`, still a path dependency) | `impl collector::Adapter`. |
| `sidecar` library and `busyholm-sidecar` binary | `sidecar/` | The ONLY place that assembles an `AdapterRouter` with the real adapters and runs the service on it. |
| Plain `collector` binary | `collector/src/main.rs` | Stdin normalised-event driver with no adapters. Used by the resource and persistence tests. Do not ship it as the sidecar: it rejects every shim POST. |

## 2. How the app core starts the service

Today `app/src-tauri/src/collector_link.rs` (feature `collector`) builds a `NormalizedMapper` and calls
`collector::run_service`. A `NormalizedMapper` expects a normalised AgentEvent, but the shim posts the allowlisted hook
BODY, so with that wiring every real hook is answered 400 and (by the shim's design) nothing shows. WP-02 owns that file;
the change is small:

```rust
// Cargo.toml of app/src-tauri: replace the optional `busyholm-collector` dependency by
//   busyholm-sidecar = { path = "../../sidecar", optional = true }   (feature `collector` = ["dep:busyholm-sidecar"])
// and keep `collector` for the types; or re-export what is needed from `sidecar`.
let clock: Arc<dyn collector::Clock> = Arc::new(collector::SystemClock);
let bus = collector::EventBus::bounded(4096);
let sender = bus.sender();                       // use it for the stop flag (shutdown), for hooks status, for tests
let roots = sidecar::Roots::from_environment();  // CLAUDE_CONFIG_DIR or ~/.claude; CODEX_HOME or ~/.codex, plus /sessions
sidecar::run(self.data_dir.clone(), self.seed, &roots, clock, bus, |output| { /* forward as today */ })
```

`sidecar::run` does, in order: create the data folder (0700), load or create the per-install salt, build the router from
that salt (so ids from hooks, logs and the registry hash the same), start the receiver with the router as its mapper,
load the ledger and the pending alerts, `rebuild` every adapter once (observations only, never earned history), then loop:
ingest events, `poll` the router once a second, persist, emit.
An adapter with file notices (Codex's rollout watch) gets a `Waker` through `Adapter::set_waker`; a notice wakes the
loop, which then polls at once (woken polls at least 25 ms apart), so a new rollout reaches a snapshot within the
200 ms first-prompt budget without a faster idle period (review r1 M5; `sidecar/tests/fix_a_m5.rs` measured 131 to
146 ms worst case on this Mac, mostly the file notice's own latency).

If you build your own router instead (for tests), use `collector::adapter_context(&data_dir, clock)` so the salt is the
same, put the SAME `Arc<AdapterRouter>` in `ServiceConfig.router` and as the `mapper` argument of `run_service`.

`router.registered()` lists the tools that have an adapter. A tool whose folder could not be opened is not registered
and its hooks get 400. Known cause: both adapters refuse any symlink in the path (SPEC 5.6, no symlink following), so a
`~/.codex` that is a symlink (dotfile managers do this) leaves Codex without an adapter. The app should show that tool
as `unsupported`: the service now does this by itself (`Collector::set_adapters(router.registered())`).

Outputs (`CollectorOutput`): `Snapshot` (at most 4 per second), `Moment`, and `Ledger`. The ledger is now emitted at
start and after every write, not only on quit (WP-02's proposal); the shell no longer has to wait for its 30 s poll of
`ledger.json`, though it may keep it as a fallback.

Stopping: send `Shutdown` through the bus (`sender.shutdown()`); the service writes both files, emits the final ledger,
removes `runtime.json` and returns. The stop travels outside the bounded data queue, so it is never refused with `Full`
(review r1 H2: a stop lost to a full queue hung Quit): events queued before it are still processed, sends after it get
`Closed`, and `shutdown()` itself only fails with `Closed` once the service has already ended. A panic or a kill is covered in section 4.

## 3. The runtime-file contract (what the shim reads)

Path: `<app data folder>/runtime.json`. The folder is SPEC 6.8: `~/Library/Application Support/Busyholm`,
`%APPDATA%\Busyholm`, `$XDG_DATA_HOME/busyholm` (else `~/.local/share/busyholm`); `BUSYHOLM_DATA_DIR` or
`--data-dir` overrides it for tests. The installer passes the absolute path to the shim with `--runtime`.

```json
{"v":1,"port":53211,"secret":"<64 lowercase hex>","token":"<64 lowercase hex>"}
```

* Mode 0600 in a 0700 folder, never a symlink. The shim already enforces owner and mode.
* Written atomically (temp file, fsync, rename) AFTER the listener is bound, so a reader never sees a half file or a
  port nobody listens on. Removed on a clean exit. After a SIGKILL or crash it is left behind with a dead port: the
  shim then simply cannot connect and exits 0. The secret and token are per install (`receiver-keys.json`, 0600) and
  stay the same across restarts; only the port changes.
* Request the shim must send: `POST /e/<secret>` to `127.0.0.1:<port>`, `Host: 127.0.0.1:<port>` exactly,
  `Content-Type: application/json` exactly (no charset parameter), `X-Busyholm-Token: <token>`, no `Origin` header, body at most
  256 KiB, and exactly ONE `X-Busyholm-Agent: claude|codex|gemini|...` header. The body is the allowlisted hook JSON
  (`collector-claude/SHIM_ALLOWLIST.md`, plus `turn_id`, `timestamp`, `host` for Codex).
* Replies: 204 accepted; 400 unsupported agent, unmapped body, repeated agent header or adapter failure; 403 Origin, wrong
  Host or wrong token; 404 wrong path; 405 not POST; 413 too large; 415 wrong content type; 503 queue full. The shim ignores the
  status and never retries.

## 4. Persistence

`ledger.json` (Ledger v1), `pending-alerts.json`, `coverage.json` (verified connectors, INT-1: DECISIONS.md), `salt`, `receiver-keys.json`, `runtime.json`: all 0600 in a 0700
folder, written only by the collector (one writer per file), via temp file, fsync, rename, directory fsync.

* A pending alert is written BEFORE its `needs_you` Moment is announced, and a counted turn BEFORE the ledger output, so
  anything a window was shown is already on disk. Pure time accrual (working seconds) is flushed every 30 s, so a kill
  can lose at most the last 30 s of accrued seconds and nothing that was announced.
* A file that cannot be read or validated (torn disk, hand edit, old schema) is renamed to `<name>.corrupt` (one copy
  kept) and the service starts with a fresh one. It never refuses to start over a stored file.
* Ledger backups (SPEC 6.8, review r1 H7): `backups/ledger-YYYY-MM-DD.json` (0600 in a 0700 folder), one copy per local
  day, written with the first valid ledger of that day (at start or at the first flush after midnight), the newest 14
  kept. A corrupt `ledger.json` is replaced by the newest backup that reads and validates, written back to `ledger.json`
  at once, and the service prints the fixed line `stored_file_restored_from_backup`; with no valid backup it starts a
  fresh ledger as before. The collector backs up only the file it writes: `choices.json` and `settings.json` are written
  by the app core, so their rolling copies belong there. The tray line "restored from yesterday's backup" needs a signal
  the contracts do not carry yet (the app can compare the emitted ledger with `ledger.json.corrupt`, or a field can be
  proposed). WP-14's "Delete everything" must remove `backups/` too.
* Temp files left by a killed write (`.busyholm-*.tmp`, older than a minute) are removed at start.
* After a restart a pending alert comes back as `needs_you` with confidence `inferred`; it earns nothing and clears on
  a matching answer. The startup rebuild closes it only with evidence newer than the alert: an older transcript or
  registry observation, or a tool result for another request, leaves it raised (review r1 H3). A wall clock that was set back is clamped, not fatal.
* Tests: `collector/tests/persistence.rs` kills the real binary with SIGKILL (including 16 kill points in a row).

## 5. Privacy review of `collector/src` (SPEC 5.7)

Checked by reading all of it and by tests (`receiver_privacy.rs`, `receiver_hardening.rs`, `shim/tests/e2e_service.rs`):

* Events: the normalised wire type lists its fields; every unknown field, nested or not, is consumed and dropped by serde
  and never held as a generic value. The hook path goes through the adapters' allowlist mappers; the router additionally
  validates every event it returns.
* Logs and errors: the only text the library prints is five fixed literals (`invalid_input`, `oversized_input`,
  `stored_file_quarantined`, `stored_file_restored_from_backup`, `adapter_panic`). `AdapterError`, `CoreError` and `SendError` are closed enums with no payload.
* Panics: an adapter panic used to print its message (a parser error can quote a value from the body). Fixed: while
  adapter code runs for the receiver, `poll` or `rebuild`, the panic hook prints a fixed line instead (test first,
  `a_panic_message_with_content_never_reaches_stderr`). Panics elsewhere keep the host's hook.
* Files: only counts (Ledger), ids and reasons (pending alerts), the salt and the receiver credentials are written.
  `shim/tests/e2e_service.rs` runs the real shim with canaries in every content field and scans every output and every file
  under the temp tree.

## 6. Still missing or open

1. **App wiring** (WP-02): `collector_link.rs` still uses `NormalizedMapper` (section 2). Until it calls `sidecar::run`
   no real hook is accepted by the app.
2. **Process scanner** (review r1 H5, wired for Claude Code on macOS): `sidecar::claude_adapter` wraps the Claude adapter
   with `collector-wp06`'s scanner. Before the adapter reads its registry it gets a fresh snapshot, taken every 5 s and
   whenever the registry folder's listing changed (so a session that registered after the last snapshot is never taken
   for a crash leftover), filtered to the pids this root's registry names. A registered session whose process is gone
   ends (`session_end`, reason `process_gone`), which also closes its pending alert. A failed snapshot is no evidence.
   The registry's `procStart` must byte-equal our `ps -o lstart` formatting (`sidecar::lstart`, checked against `ps`
   on macOS); on Linux and Windows that format is unverified and a mismatch would end every live session, so there no
   snapshot is supplied and processes count as alive, as before. Still open: Codex has no session to process link (a
   killed Codex keeps its alert until answered or ended by the user); a session killed while Busyholm was not running
   is a startup "crash leftover" in collector-claude's registry tracker, which emits nothing for it, so its restored
   alert stays (collector-claude should end it); the scanner costs about 0.15% of one core when it runs every 5 s (section 7); it is skipped while no Claude
   session is registered.
3. **OpenCode and Antigravity adapters** are not registered in `sidecar::build_router` (v0.1 slice is Claude and Codex).
4. **Hooks status and coverage** (INT-1, done in the collector): coverage is derived inside the service, so nothing has to call
   `set_coverage` any more. A hook event that arrives through the shim, receiver and router verifies its connector (and it
   survives a restart); log or registry activity alone is `degraded`; a tool without an adapter is `unsupported`. What the app
   should still do: call `sender.hooks(tool, status)` from the installer manifest at start (`Installed` or `PendingReview`;
   it never ends a verification) and `sender.hooks(tool, Missing)` after a Disconnect (ends it at once). Rules and decay:
   DECISIONS.md "INT-1". A tool whose folder is missing from the router is shown `unsupported` (was: silently absent).
5. **Symlinked agent folders** disable that adapter silently (section 2).
6. **Stale `runtime.json` after a crash** points at a dead port; a different local process of the same user that took the
   port would receive the path secret and token if a hook fired. Same-user loopback only, accepted for v0.1; the fix is to
   delete the file on crash recovery, which only the app core can do (it knows the collector died).
7. **Receiver body timeouts**: tiny_http gives no read timeout. A test with 24 stalled authenticated clients shows other
   requests are still served, so an external review lead about slow-body starvation was not reproduced; a hard per-request
   deadline would need a different server.
8. Idle CPU and memory: see `collector/evidence/idle-*.json` and section 7.

## 7. Idle CPU against SPEC 6.7 (collector alone, idle: at most 0.3% CPU, 30 MB, 10 wakeups a second)

Method: `collector/tests/resource_acceptance.py --mode idle` starts the release binary on a temp data folder, leaves it
alone for 600 s, then reads the child's user plus system CPU time from `wait4` (the process only, not the machine) and
its peak resident size, and fails above 0.3% or 30 MB. The routed run uses empty agent folders (a world with no agents)
so no real transcript of the user is read.

Measured 2026-10-12 on this Mac (release builds, 600 s each, evidence in `collector/evidence/`):

| Run | CPU over 600 s | Share of one core | Peak memory | Budget |
|---|---|---|---|---|
| Plain `collector` (no adapters), `idle-plain.json` | 0.022 s | 0.0037% | 6.0 MB | 0.3% / 30 MB: pass |
| `busyholm-sidecar` with the Claude and Codex adapters polled every second, empty folders, `idle-sidecar-routed.json` (before the last review fixes) | 0.062 s | 0.0103% | 6.8 MB | pass |
| Same, final code, `idle-sidecar-routed-final.json` | 0.058 s | 0.0097% | 6.8 MB | pass |
| Same, with the Claude process scanner wired (FIX-A H5) and a snapshot every 5 s (measured before the empty-registry skip, so it is the cost while a session is registered), `idle-sidecar-routed-fixa-scanner.json` | 0.980 s | 0.163% | 8.5 MB | pass |

Receiver latency after the integration changes (`latency-after-integration.json`): 5000 requests at 500 per second, all 204,
p99 0.428 ms, p50 0.21 ms, max 4.8 ms (budget: p99 at most 5 ms).

Not measured: macOS wakeups per second (budget 10). By design there is one router poll per second, two receiver threads
waking once a second to check their stop flag, and the state machine sleeping until its next deadline, so a handful a second.
The numbers are for an idle world; polling real transcripts and the process scanner (section 6, item 2) must be measured when wired.
