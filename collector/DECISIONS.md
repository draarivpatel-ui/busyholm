# WP-03 implementation decisions

2026-10-12: the user confirmed current WP-01 contracts after r1 appeared during
implementation. SPEC Revision 1 overrides the original numbered sections.

- Quick answers within 60 seconds are counted in memory for acceptance coverage.
  They are not written to Ledger v1, sent to windows or used for rewards.
- Concurrent main sessions accrue wall time per tool, never summed time.
- `limited` never clears on a timer. A fresh good signal is required.
- The receiver returns 204 only after sanitized events enter the bounded bus.
- Protocol timestamps are milliseconds. Timeouts use a separate monotonic clock.
- The package keeps its skeleton name `busyholm-collector`. Both the Rust library
  and sidecar executable are named `collector`.

# Lessons

Contracts can change while build agents work in parallel. Read the current types
and schemas again after a shape failure and adapt only this package. Do not patch
the contract or commit another package's working changes.

# Integration pass (2026-10-12)

- The live service is assembled in the `sidecar` crate (the collector cannot depend on its adapters). `ServiceConfig.router`
  makes the service loop rebuild the router at start and poll it once a second.
- Stored files are never a reason to refuse to start: unreadable or invalid ones are moved to `<name>.corrupt`.
- Anything announced is persisted first (pending alerts and counted turns); time accrual is flushed every 30 s.
- The ledger is emitted at start and after every write (WP-02 proposal).

## Free-model review of the collector (Gemini, unverified leads), each tested before any change

| # | Lead | Result |
|---|---|---|
| 1 | slow-body clients starve the two workers | Rejected: not reproducible (`stalled_clients_cannot_starve_the_receiver_or_block_shutdown`, 24 stalled authenticated clients). Kept as a regression test. |
| 2 | Origin checked after the path (path oracle) | Fixed (`origin_is_refused_before_the_secret_path_is_looked_at`). |
| 3 | non-constant-time token and secret compare | Fixed as hardening only; a timing leak cannot be shown by a deterministic test, and the listener is loopback with 256-bit values. |
| 4 | content type compared case-sensitively, charset rejected | Rejected: Revision 1 item 4 says exact content type; the shim sends exactly that. |
| 5 | repeated `X-Busyholm-Agent` skips the tool check | Fixed (400). |
| 6 | chunked body bypasses early length rejection | Rejected: the read is bounded by `take(MAX_BODY+1)` and answers 413 either way. |
| 7 | macOS directory fsync fails with EOPNOTSUPP | Rejected: false. Every write test passes on macOS (APFS) with the directory fsync. |
| 8 | pending restore fails when the clock moved back | Fixed (`a_clock_set_back_across_a_restart_still_restores_the_pending_alert`). |
| 9 | a turn longer than 90 s loses its real end | Fixed (`a_long_silent_turn_still_counts_when_its_real_end_arrives_after_the_inferred_one`); a duplicate copy is not counted twice. |
| 10 | lower-ranked source cannot clear a fresh hook alert | Rejected: a late log copy of an earlier event would then clear a live alert (pinned by a test); the answering hook events are not suppressed. |
| 11 | a `needs_you` alert never expires without `process_down` | Rejected as a design choice: Revision 1 item 3 keeps alerts until answered or the process is gone. The real gap is that the process scanner is not wired (INTEGRATION.md section 6). |
| 12 | interrupted request can be raised again by a late copy | Fixed (`an_interrupted_request_cannot_be_raised_again_by_a_late_copy`). |
| 13 | limit without a reset time never clears | Fixed (`a_fresh_good_usage_sample_clears_a_limit_that_had_no_reset_time`). |
| 14 | quick-answer counter violates Revision 1 item 6 | Rejected: the counter is an in-memory acceptance hook, never persisted, sent or rewarded (see the first decisions above). |
| 15 | `usage_sample` without usage panics | Rejected: `validate` already rejects it (`a_usage_sample_without_usage_is_an_error_not_a_panic`). |
| 16 | `next_day` overflows on huge timestamps | Fixed (`huge_timestamps_cannot_panic_the_calendar`); the calendar also panicked on dates beyond year 9999, now clamped. |

Found by this pass, not by the review: a panicking adapter killed a receiver thread (two hostile bodies would stop all hooks),
a failing adapter starved the others in `AdapterRouter::poll`, and panic text could reach stderr.

# INT-1: coverage states (2026-10-12)

SPEC Revision 1 item 2. Before this, nothing called `set_coverage`, so no connector could reach "Alerts on". The
state is now derived inside the core from what it has observed, per connector (tool plus agent folder).

| State | When | `coverage_reason` |
|---|---|---|
| `unsupported` | the tool has no adapter in the router (`set_adapters`, called by the service from `router.registered()`), or the product cannot raise alerts for it (Antigravity, Gemini, Cursor, Aider, other), or the installer reported `unsupported` | `no_permission_event` for the second, `other` otherwise |
| `verified` | a hook event for the connector went through the receiver and the router (an event whose source is `hook` or `plugin`) | none |
| `degraded` | everything else: only log, registry or process activity, or hooks not proven yet | `hooks_missing` (installer never reported, or reported missing), `hooks_pending_review`, `round_trip_pending` (installer reported installed, nothing arrived yet), `round_trip_failed` (see decay) |

* The proof is the event, not the installer's word. A delivered hook event beats an inference from config files, so
  `set_hooks(Installed)` and `set_hooks(PendingReview)` never end a verification.
* Not proofs: a `usage_sample` (the statusline wrap proves the wrap, not the alert hooks, and it returns before the
  evidence step), events from `rebuild` (observations), `restore_pending` (synthetic) and log, registry or process events.
* Evidence is taken right after `ensure` and before any dedup rejection: a duplicate hook event still proves delivery.
* Tradeoff accepted: the provenance is the event's `source` field, which only the adapters' `map_hook` and the Claude
  statusline mapper set to `hook`. The stdin driver (`NormalizedMapper`) can also say `hook`; that path exists for tests.
* The first verification stamps the ledger's `hooks_first_connected_day` (same as `set_coverage` did).
* `set_coverage` stays as a manual override for a connector (it is then not derived). Nothing needs it any more.
* `set_hooks` is remembered per tool, also before the tool's first event (it used to reach only connectors that already
  existed, so an installer report sent at app start was lost).

## When verified ends (decay)

1. **The hooks are disconnected**: `set_hooks(tool, Missing | Unsupported)` ends it at once and forgets the evidence. While
   the installer says the entries are gone, hook events do NOT verify (they can only come from a session started before the
   disconnect, which still has its hooks loaded). `set_hooks(Installed)` after that starts a fresh round trip; the first hook
   event verifies again.
2. **Hooks stop arriving while logs continue**: a turn start seen through a log or the registry that no hook event of the
   connector matches within 30 s (before it, or after it) is a miss. Three misses in a row, with no hook event in between,
   end `verified` (reason `round_trip_failed`). Any hook event resets the count and verifies again at once, so a flip back and
   forth is honest, not a bug. Why three turns: one missed pairing happens (a session started before the hooks were installed,
   `claude --bare`); three in a row with no hook from any session of that folder means the session in use is not sending hooks.
3. **Time alone never decays it.** A week of silence, or an agent that is simply not used, proves nothing against the
   hooks. Only log or registry activity without hooks does.
4. The same miss count gives an installed-but-never-verified connector the reason `round_trip_failed` instead of
   `round_trip_pending` (the CHANGES.md proposal said "none arrives within a bounded time after an install"; the bound is
   three unmatched turns, because a user may not open the agent for days). Without an installer report the reason stays
   `hooks_missing`.
5. Verified is per folder. Host-level cases (a `--bare` session next to normal ones) are not told apart: while any session of
   the folder delivers hooks the connector stays verified, and the tray shows the connector, not each session.

## Persistence

`coverage.json` in the data folder (0600, folder 0700, same writer rules as `pending-alerts.json`): schema_version, OS
(`std::env::consts::OS`) and one entry per verified connector (tool, root_id, verified_at). It is written whenever the
verified set changes, before the snapshot that announces it, and at shutdown. After a restart the connector is verified
at once and shows as offline until the tool runs again. A record from another OS is ignored (a copied data folder proves
nothing there); an unreadable or invalid file is moved to `coverage.json.corrupt` like the other stored files. A restored
connector whose adapter is missing now is shown `unsupported` and its record is kept, so fixing the folder brings it back.
No contract changes: the file holds ids and times only, so it sits next to `pending-alerts.json`, not in the counts-only
ledger. WP-14's data folder inventory and "Delete everything" must include it.

# FIX-A: review round 1 (code review, round 1)

Each finding was reproduced by a failing test first (`collector/tests/fix_a_r1.rs`, `sidecar/tests/fix_a_*.rs`,
`collector-codex/tests/fix_a_*.rs`), then fixed.

- H2: the stop travels outside the bounded data queue (`stop_at` marker): data queued before it drains, later sends get
  `Closed`. `collector_link.rs` needed no change: its ignored result can now only be `Closed` (the service is gone).
- H3: a rebuild observation not newer than an alert's evidence (`alert_at`), or a tool result for another request,
  leaves the alert raised.
- H7: corrupt `ledger.json` is replaced by the newest valid `backups/ledger-YYYY-MM-DD.json` and written back at once;
  one copy per local day, newest 14 kept. Only the ledger: `choices.json` and `settings.json` belong to the app core.
- H5: process evidence for Claude Code on macOS only (see INTEGRATION.md section 6 item 2 for why not elsewhere). The
  snapshot is filtered to the pids the root's registry names, so foreign Claude processes never become residents.
- H6: an event that carries a parent reconciles a parentless instance before the authority gate. Only none to some;
  the provisional turn id is dropped and the main-session count taken back. Working seconds accrued while the child
  looked like a main session (until its rollout metadata arrives, normally about a second) are not taken back.
- M1: a turn start while limited is an attempt; the limit ends on tool activity, a question or permission request,
  a finished turn, or a fresh good usage sample. Golden timelines updated (`limit_resume_new_turn`, two new cases).
- M4: Codex is registered through `CodexAdapter::watch_or_wait`, same root_id before and after the folder appears.
- M5: `Waker` (bus flag, never refused) handed to adapters via `Adapter::set_waker`; woken polls at least 25 ms apart.
- M2: the collector writes Ledger v1's optional `day_totals` (wall time with any main session of any tool working).
  A day without an entry yet starts from its largest per-tool time (a ledger written before the field).
- H4c at the collector boundary (FIX-B follow-up): a `tool_end` answers a keyed alert only with the same request id.
