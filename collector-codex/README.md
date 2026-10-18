# WP-05 Codex adapter

Standalone Rust crate `collector-codex`. Implements the published
`collector::Adapter` trait against the current AgentEvent v1 contracts, including
the Revision 1 identity fields. It owns no shared workspace or collector files.
The integration owner can add this package to the root workspace later.

```rust,ignore
use collector::{Adapter, AdapterContext, AdapterRouter};
use collector_codex::CodexAdapter;

// sessions_root is an explicitly configured Codex sessions directory.
let adapter = CodexAdapter::watch(sessions_root)?;
let mut router = AdapterRouter::new(context);
router.register(Box::new(adapter))?;
```

Poll the router at least every 25 ms to meet the 200 ms first-prompt registration
budget. `Adapter::poll` does not block waiting for filesystem events. It drains
bounded notification, discovery and read budgets. Native file notifications are
the primary trigger; a monotonic two-second rescan is the backstop. New date
directories are discovered without waiting for that backstop.

`CodexAdapter::watch_or_wait(root)` is `watch` for a sessions folder that may not exist yet
(Codex creates it on its first run). It maps hooks at once and attaches the watcher from a later
`poll`, checking at most once a second. The root identity is the path `canonicalize` will return
once the folder exists, so the connector id is the same before and after; a path that turns out
different (for example a symlink planted meanwhile) is never attached and counts one `io_errors`.

`CodexAdapter::for_root(root)` provides a hook-only mapper with the same canonical
root identity. `new()` is a filesystem-free mapper for synthetic tests; it uses
an unconfigured synthetic root identity. Use a configured root in the app.
`decode_record` takes a separate `RolloutStream` per file. Checkpoints retain
only offsets, file identity, salted ids, enums and numbers. The caller owns any
checkpoint persistence in the app data directory.

## Mapping and privacy

- `PermissionRequest` emits `needs_permission`; the collector changes this to
  `needs_you`. `Interrupt` and `turn_aborted` emit `turn_interrupted`, without a
  successful turn completion.
- Session, turn, request, account and root ids use the collector's per-install
  HMAC identity. Account ids never leave this adapter in raw form. Unknown
  account ids remain null. Metadata user ids, money, content and paths are
  discarded. Hook observations can reuse account/host metadata from the rollout.
- A null primary skips both usage samples for that record. Known windows are
  300 and 10,080 minutes, regardless of slot order. Each good window becomes one
  `usage_sample`. Epoch reset seconds become milliseconds at the edge. Older
  samples do not overwrite newer good values. Caches are per rollout stream.
- Non-null `rate_limit_reached_type` emits `limit_hit` with an unknown window and
  null reset. Its non-null vocabulary has not been verified, so it is not guessed.
- Unknown envelope, event, item and hook names produce integer drift counters.
  Malformed records are skipped. Errors never include raw data, paths or parser
  diagnostics. Serde skips content fields without building a generic JSON value.
- Tool failures are activity observations, not proof of a failed turn. Content
  in `response_item`, instructions, messages and compacted records is ignored.
- Subagent hook `agent_id` and parent fields are supported when present. Their
  fixture shapes are provisional in the research; real delivery is not verified.

## Files and processes

Only `rollout-*.jsonl` is opened, read-only. The tailer splits on byte LF, retains
incomplete lines by their offset, skips lines over 1 MiB, and resets on device or
file identity changes or size shrinkage. Unix opens use `openat` with
`O_NOFOLLOW` for every component. Windows rejects reparse points and opens with
shared read/write/delete access, using volume and file index for identity.
The watcher ignores symlinks and descends only through the date layout.
Startup reconstruction reads the bounded header and last 64 KiB of recent
rollouts. Send these observations through `EventSender::rebuild`, not live
ingestion, so no historical ledger counts are earned.

The process matcher consumes name, executable path, pid and process start time
from the shared scanner. It reads no argv and opens no process files. Helpers
are excluded by exact executable names. Supply the known app-server daemon pid
to exclude it: executable metadata cannot identify a subcommand. Process events
use pid plus start time, are inferred, and have no known session id.

There are no credential reads, config edits, hook installations, outbound network
calls, or changes to `notify` or `config.toml` in this package. Real agent files
were not inspected during implementation. Tests use repository-local synthetic
scratch directories and the shared canary fixtures.

## Verification

```sh
source tools/env.sh
CARGO_HOME="$PWD/target/wp05-cargo-home" \
CARGO_TARGET_DIR="$PWD/target/wp05-build" \
cargo test --manifest-path collector-codex/Cargo.toml --locked
```

The red commit is `2865763`: 11 tests compiled and all 11 failed against a stub.
The first complete implementation passed all 11, with native first-prompt
registration measured at 28,500 microseconds on this Mac. This is an adapter
fixture result, not an end-to-end hook or renderer latency certification.

## Open review leads (unverified premises, deliberately not changed)

- Hooks carrying `agent_id` outside `SubagentStart` and `SubagentStop`: the claim that Codex
  sets it on every hook inside a subagent is only documented for Claude Code. Not assumed.
- Windows process names with other letter case (`Codex.exe`): the real executable name is
  unverified and a desktop app of that name would become a false positive. Backslash paths
  and `codex.exe` already match.
- Epoch-second timestamps: Codex rollouts use RFC 3339 text. An unreadable time falls back
  to the local clock, so nothing is lost.
- A rollout older than ten minutes that is appended to later is tailed from byte 0 by its
  file notice (the notice path is not "recent"). Not part of the review leads; worth a decision.
