# collector-wp06: OpenCode, Antigravity and the process scanner

WP-06 of Busyholm. A Rust library crate (`busyholm-collector-wp06`, lib name `collector_wp06`) plus one JavaScript file that runs inside OpenCode. Everything produces AgentEvent v1 and implements the WP-03 `collector::Adapter` trait.

| Piece | File | Registers as | Source | Confidence |
|---|---|---|---|---|
| OpenCode plugin | `plugin/busyholm.js` | (runs in OpenCode, POSTs to the receiver) | OpenCode bus events | exact |
| OpenCode wire mapper | `src/opencode_wire.rs` `OpenCodeAdapter::map_hook` | `Tool::Opencode` | plugin bodies | exact |
| OpenCode database poll | `src/opencode_poll.rs` (`OpenCodeAdapter::with_poller`) | `Tool::Opencode` `poll` / `rebuild` | `session` table only | inferred |
| agy log heartbeat | `src/agy.rs` `AgyAdapter` | `Tool::Antigravity` | `log/cli-*.log` timestamps | inferred |
| Process scanner | `src/procscan/` `ProcessScanner` | `Tool::Other` (spans all tools) | OS process list, names and start times | exact |

## Wiring (for WP-03 and WP-07)

```rust
let mut router = AdapterRouter::new(ctx);
router.register(Box::new(OpenCodeAdapter::with_poller(OpenCodePoller::new(PollConfig::new(db_path)))))?;
router.register(Box::new(AgyAdapter::new(AgyConfig::new(paths::agy_root(&home)))))?;
router.register(Box::new(ProcessScanner::new(system_source())))?;
// each tick, so one agy shows as one resident:
agy.set_live_processes(scanner.live(Tool::Antigravity));
```

`ProcessScanner::run_loop` is a ready-made blocking loop for a thread. Paths: `paths::opencode_db_candidates` (honours `OPENCODE_DB`, `XDG_DATA_HOME`) and `paths::agy_root`.

Installing the OpenCode plugin is one file copy: `plugin/busyholm.js` to `~/.config/opencode/plugins/busyholm.js` (OpenCode scans `{plugin,plugins}/*.{ts,js}`), with the line `const RUNTIME_FILE_OVERRIDE = null; // BUSYHOLM-INSTALL: runtime file path` replaced by the real runtime file path as a string. Uninstall is deleting that file. See `contracts/CHANGES.md` (WP-06 entry) for the open questions this raises.

## Wire format (plugin to receiver)

`POST http://127.0.0.1:<port>/e/<secret>`, headers `Content-Type: application/json`, `X-Busyholm-Token`, `X-Busyholm-Agent: opencode`. Body, at most 4 KiB, closed key set:

`v` (1), `agent` ("opencode"), `type`, `sid`, `psid?`, `rid?`, `activity?`, `error?`, `tok?`, `et`

`type` is one of `session.created`, `session.deleted`, `session.busy`, `session.idle`, `session.error`, `permission.asked`, `permission.replied`, `question.asked`, `question.replied`, `tool.after`, `tokens`. `sid`, `psid`, `rid` are SHA-256 hex of the session, parent session and request ids: the raw ids never leave OpenCode. `activity` and `error` are classes derived from a tool or error NAME. `tok` is a count. `et` is the machine clock in ms. The mapper refuses any other key, a raw id, a body over 4 KiB, or a key that does not belong to the type.

What the plugin never reads into the posted object: prompts, replies, tool arguments or output, file paths, titles, commands, error messages, the project directory, permission patterns. Subagent sessions carry `psid` on every later event once their parent was seen (`session.created` or `session.updated`).

## How the OpenCode poll stays out of the big tables

`SESSION_QUERY` selects ten id, clock and counter columns from `session` and nothing else. Its query plan is `SCAN session` plus a temp b-tree for the ORDER BY (no index covers `time_updated`; about 1 ms on 3,600 rows in a fixture, 35 ms on this Mac's real 5.4 GB database for the first look, 0.6 ms after). On top of that the connection is read-only, `query_only`, has no busy wait, and carries a SQLite authorizer that refuses to read any other table or column; `columns_read()` reports what it saw. A closed, clean database (no `-wal` or `-shm` next to it) is opened `immutable` so SQLite does not create those files in OpenCode's folder.

## Decisions and limits

- **Poll events are `inferred`.** `time_updated` moving means "something happened"; the first move after quiet is `turn_start`, later moves are `heartbeat` (with `tokens_delta`), 90 s of no change is `turn_end`. A title edit also moves it, so a poll-only user can see a short false "working".
- **agy `working` means a request line in the last 90 s.** Measured on this Mac the lines come about every 3 s, gaps of 1 to 10 s are normal and up to a minute happens, so the 15 s window the research first suggested would flicker. 90 s matches SPEC 5.5.
- **The scanner reports processes, not sessions.** OpenCode runs many sessions per process; see the WP-06 entry in `contracts/CHANGES.md` for how presence and sessions should be combined.
- **Windows and Linux are compiled, not run.** `cargo check --target x86_64-pc-windows-msvc --no-default-features` and `--target x86_64-unknown-linux-gnu --no-default-features` pass; the Linux `/proc/<pid>/stat` parser and the Windows FILETIME conversion have unit tests that run everywhere. The real OS calls have only been exercised on macOS.
- **Unverified data paths.** macOS is measured. Linux paths are the same relative paths (docs). Windows: OpenCode `%USERPROFILE%\.local\share\opencode` (docs and source) with `%APPDATA%\opencode` as a fallback candidate because one release note says otherwise; agy `%USERPROFILE%\.gemini\antigravity-cli` is from a free-model lead and is unverified.
- **The agy log format is read from observation** (glog prefix, `http_helpers.go` `URL:` lines). If a future agy build changes it, the reader sees no request lines and reports only presence.

## Tests

- `cargo test -p busyholm-collector-wp06` (Rust, includes a real-process timing test that takes about 10 s and a Node end-to-end test through the real receiver; skips Node tests if `node` is missing).
- `npm run test:wp06` (plugin simulated run, 13 tests; also passes under `bun test`, OpenCode's runtime).
- Optional smoke runs against real data, printing only counts and timings: `BUSYHOLM_REAL_OPENCODE_DB=... cargo test -p busyholm-collector-wp06 -- --ignored real_database`, `BUSYHOLM_REAL_AGY_ROOT=... ... real_agy`.
