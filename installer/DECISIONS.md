# WP-07 decisions (installer and busyholm-hook shim)

Written 2026-10-12. Contract-level points are in `contracts/CHANGES.md` under "From WP-07".

## Shim (`shim/`, binary `busyholm-hook`)
- `busyholm-hook hook --agent claude|codex|gemini --runtime <abs runtime.json> [--owner <tag>]` and
  `busyholm-hook statusline --runtime <abs> [--prev-file <abs>] [--owner <tag>]`. Paths are absolute and baked in by the
  installer (SPEC 5.6: never via PATH). `--owner` is a marker only.
- The wire body is built fresh from validated fields (never "delete from the original"). Closed vocabularies
  (`reason`, `notification_type`, `error`, `source`, `host`) go through fixed lists; unknown values become `other` /
  `unknown` or are dropped, so free text sent under an allowed name cannot pass. `reason` only on SessionEnd/SubagentStop,
  `error` only on StopFailure, `is_interrupt` only on PostToolUseFailure.
- Time: network budget 0.9 s from process start, hard exit 1.0 s (contract 1.2 s, leaving 0.2 s for process start on a loaded machine). Stdin is read on a worker thread so a
  parent that never closes it cannot hold the process. Measured: down/500/hang all end near 0.9 s at worst.
- Trusted files (runtime file and the saved previous status line): opened first with `O_NOFOLLOW | O_NONBLOCK` and judged by `fstat` on the handle (regular file, owned by the current user, no group/other bits, size capped), so a swap or a FIFO cannot redirect or block it. Runtime file: under 64 KiB, `v == 1`,
  port 1024..65535, credentials `[A-Za-z0-9_-]{8,256}`; anything else means "receiver absent" (silent exit 0).
- Ids (`session_id` etc.) pass a fixed character set (`[A-Za-z0-9._:+/=@-]`), never prose. Non-UTF-8 arguments are read lossily; a panic anywhere still exits 0 in hook mode.
- Status line mode: forwards only complete `rate_limits` windows (a missing window is never 0%), runs the prior command with
  the same stdin bytes through `sh -c`, copies its stdout through unchanged and returns its exit code. A prior command killed by a signal gives 128 + signal. The POST runs on a side
  thread; after the prior command ends the wrapper waits at most 250 ms for it, so a hung receiver cannot slow a redraw. `cmd /C` on Windows is untested.

## Installer (`installer/`)
- JSON span editor: strict `serde_json` validation first (comments, trailing commas, truncation refuse), then an offset scanner;
  edits are byte-range replacements of the original text. BOM, CRLF, indentation and key order stay. Duplicate top-level keys:
  the last one is edited (what `JSON.parse` keeps).
- An empty or whitespace-only file counts as `{}` (nothing of the user's is in it); a missing file is created. A top level that
  is not an object, `hooks` that is not an object, or an event that is not an array are refused with the file untouched.
- Ownership: every handler carries `--owner <tag>` (args pair in exec form, word pair in shell form); entries are found by
  the tag, not by position or by a "busyholm-hook" lookalike. `owned[].sha256` is the canonical-text hash.
- Disconnect: removes our handlers, the matcher groups they leave empty, and event arrays / `hooks` only when the install
  created them (judged from the kept `before` backup). Where a container becomes empty again and was empty before, its original
  inside text is put back, so an untouched file returns byte for byte (checked on 35 fixtures plus 500 generated documents).
  It never restores a whole file over later edits. A file created by us is deleted only if it still equals `after`.
- Preview: `plan_*` writes nothing and returns the exact edits and a unified diff; `apply` re-reads every file and the manifest
  and refuses if anything changed since the plan. Install plans save the manifest before each file edit, disconnect plans after,
  so a crash can leave a record without an edit but never an edit without a record.
- Status line wrap is a separate consent (`claude-statusline`). Only a `type: "command"` status line is wrapped; its other keys
  (`padding`, `refreshInterval`) are kept. Anything else is refused rather than replaced.
- Claude entries: one matcher group per mapped event (13), no `matcher`, `async: true`, `timeout: 2`. Codex: 10 events,
  `async: true`, `timeout` 3 for `SessionEnd`/`Interrupt` (Codex's maximum) and 5 otherwise; `PreCompact`/`PostCompact` are not hooked.
- Symlinked config files are refused (SPEC 5.6 style "no symlink following"); the message says to point at the real file.
  Easy to flip if dotfile-manager users complain.
- The OpenCode plugin is copied from WP-06's `busyholm.js` with only the `RUNTIME_FILE_OVERRIDE` line replaced. A file already at
  that path that Busyholm did not write is never overwritten; an edited copy is left in place on disconnect.
- The shim binary is copied to `<data>/bin/busyholm-hook` (0755) and removed with the last consent.
- Known limits: Windows quoting and `commandWindows` are not done; reinstalling after the manifest was lost would add a second
  set under a new tag (nothing detects entries of an unknown tag); the library does not read the real environment except via
  `Layout::from_env_with(get)`.
- `busyholm-installer` (a small CLI) is for previews and manual checks; with no folder flags it targets the real homes, and it
  writes only with `--yes`.

## Fixed (after the adversarial pass and a Gemini review)

Each fix has a test that failed first (`wp07_claude.rs`, `wp07_disconnect.rs`, fixtures `bad-lone-surrogate-value`,
`bad-number-overflow`, `bad-deep-nesting-200`).

1. **Files `JSON.parse` accepts but `serde_json` cannot read back** (lone surrogate in a value, `1e999`, nesting over 128).
   Install now validates with the same parser the removal checks use and refuses such a file with it untouched; the old
   "compare two unreadable documents, both Null" hole in the post-install check is closed (an unreadable result is a failure).
2. **Duplicate keys at the levels we edit** (`hooks`, `statusLine`, or one of our event names inside `hooks`). Install refuses
   with a clear message and the file untouched. Disconnect refuses the same way in either order (duplicate before or after
   ours): the file is untouched, the plan says why, and the manifest keeps the entry so disconnect can finish once the user
   removes the extra key.
3. **Staged component installs.** All entries on one file now share the file as the user first had it (`before` and `action`
   of the earliest entry), so the last disconnect restores the original bytes, a missing file, or an empty or whitespace-only
   file, whichever order the components were installed and removed in.
4. **Gemini lead: a status line edited by a third party** (for example `refreshInterval` changed) lost the edit on disconnect.
   Confirmed. If the value is still exactly what we wrote, the old one goes back byte for byte; if it changed, only the `command`
   goes back and their edit stays.
5. **Gemini lead: a lost saved status line blocked every other disconnect.** Confirmed. The status line entry is now kept (and the
   plan says so) while hooks and the rest disconnect normally. Gemini's fix (drop the wrapper without restoring) was rejected: it
   would delete the user's own command.

Gemini leads rejected: Windows `cmd.exe` quoting (already a documented limitation, not testable here); the `apply` window between the
pre-write check and the rename (milliseconds, and agents write by rename too; no cross-tool lock exists to take); `write_atomic` without
`O_EXCL` (the temp name carries 48 random bits, so it cannot be pre-planted; the file is now created with `O_EXCL` and its final mode anyway, as a defensive change without a failing test); manifest saved before the file write (deliberate: a record without an edit is harmless, an edit without a record is
not); a matcher group with extra keys removed when our handler was its only one (only happens if someone put our tagged handler into
their own group); diff context off by one at newline boundaries (cosmetic, the written bytes are exact).

Minor: a created file that was reformatted so it holds only our entries is deleted at disconnect. The rule is "created by us and nothing
else is left in it", not "unchanged since", and the Disconnect bullet above should be read that way.

Re-run of the adversarial harnesses after these fixes (`fuzz.py` seeds 1 to 3 with 600 random documents each, 2,049 cases per seed, and `seq.py` with 2,070 staged sequences): no "internal check failed", no failed disconnect, no preview that wrote, no "not restored". What the harnesses still flag is by design: valid-for-`JSON.parse` files that are now refused up front (lone surrogates, `1e999`, deep nesting, duplicate keys), 48 sequence steps where a later component is refused (wrong shape, duplicate key, a status line that cannot be wrapped) after an earlier one succeeded, and 6 cases per seed where a third party reformatted a file that was empty before Busyholm: once nothing but our entries is left, the empty original bytes are put back, which the harness counts as "not strict JSON".
