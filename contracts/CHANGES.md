# Contract changes and decisions (WP-01)

The JSON Schemas in `contracts/schemas/` are the source of truth. The TypeScript types (`contracts/ts/`) and Rust types (`contracts/rust/`) follow them, and the fixtures in `fixtures/contracts/` are the shared oracle: every valid fixture must be accepted and every invalid one rejected by both the TypeScript validator and the Rust types. After this file, no package changes a contract without an Opus review (SPEC 9).

This file lists every place where the contracts fill a gap in SPEC.md or depart from it. Section numbers refer to SPEC.md. The sections per contract below always describe the CURRENT shape; the revision log says what changed when.

## Versioning rule

- **Before v0.1 ships, contracts are revised in place**: the version numbers (`v`, `schema_version`) stay, the change is listed in the revision log below with its commit, and the fixtures, TypeScript types, Rust types and both validators change in the same commit so `npm test` and `cargo test` stay green. Nothing has shipped and no user's machine holds a persisted file yet, so a version bump would only add churn.
- **From the first public build on**, any change that makes a previously valid document invalid, or changes a field's meaning, bumps that contract's version; readers of persisted files (ledger, choices, settings, install manifest, pending alerts) keep accepting the previous version and migrate it. Purely additive optional fields still bump, because every object is closed (`additionalProperties: false`).

## Revision log

### r1 (SPEC Revision 1, 2026-10-12, commit "WP-01 contracts r1")

1. **Identity on AgentEvent v1 and Snapshot v2** (Revision 1 item 3). New `root_id` (required: the connector, one per agent data root, salted hash of agent plus canonical root path) and the required-but-nullable `account_id`, `session_id`, `turn_id`, `request_id` (salted hashes; `null` where the source cannot supply one, so adapters must decide explicitly). `instance` stays the identity of the thing animated (a subagent has its own `instance` and its parent session's `session_id`). `request_id` is non-null only on `needs_permission`, `needs_answer`, `answered` and `tool_end` (AgentEvent) and only in state `needs_you` (Snapshot). Moment v1 gains an optional `request_id` on `needs_you` and `answered`, so notifications are raised once per request and withdrawn when it is answered. The raw account ids that 5.7 rule 6 drops at the edge are now kept only as this salted hash.
2. **Per-account limits** (Revision 1 item 3). Snapshot limit entries carry `account_id` (null when unknown) and `root_id`; they are unique per provider, window, account and root (at most 16), and limits of different accounts are never merged. With an unknown account the entry is per root.
3. **Coverage per connector** (Revision 1 item 2). Snapshot `tools` entries are now per connector (`tool` plus `root_id`, at most 16) and carry `coverage` (`verified`, `degraded`, `unsupported`) and `coverage_reason` (null exactly when verified; codes: `hooks_missing`, `hooks_pending_review`, `round_trip_pending`, `round_trip_failed`, `receiver_unreachable`, `bare_session`, `no_permission_event`, `experimental_adapter`, `remote_session`, `os_unsupported`, `other`). Coverage is per connector, not per tool x host x OS as Revision 1 phrases it: the OS is fixed per snapshot, and host-level degradation (a `claude --bare` session) is reported as the `bare_session` reason. If the tray needs a per-host breakdown, raise it for review.
4. **New contract PendingAlerts v1** (`pending-alerts.json`, Revision 1 item 3): one record per waiting agent (agent, tool, host, root, account, session, request, reason, since, last_confirmed_at). On start the collector restores each as `needs_you` with `confidence: inferred` until a fresh signal confirms or clears it. It is a separate file because the ledger must stay counts-only and id-free.
5. **InstallManifest ownership** (Revision 1 and the review's point that whole-file restores can damage other tools' edits). `edits` is replaced by `owned`: one item per entry Busyholm inserted or replaced (`event`, `pointer` as a hint, `sha256` of the exact inserted text, `replaced_sha256` for the statusLine wrap), present for every config-file target (including a hook file the installer created, since the user may add entries later) and absent for whole files Busyholm owns (`opencode_plugin`, `shim_binary`). A per-install `owner_tag` is written into every owned entry, so entries are found by content, not position. Disconnect removes exactly the owned entries and puts back a replaced value; it never restores a whole-file backup over a changed file.
6. **Receiver removed from InstallManifest** (Revision 1 items 1 and 4): Claude now also uses the command shim, which reads the receiver's port and per-install token from a 0600 runtime file, so the manifest no longer holds a receiver or secret. The runtime file's shape is not a WP-01 contract yet; WP-03 and WP-07 propose it, Opus reviews.
7. **No quick-answer incentives** (Revision 1 item 6, not in the coordinator's list but encoded in these contracts). Ledger `quick_answers` is removed; World `waiting_for` now counts `active_days` instead of quick answers; World `stats.lifetime_quick_answers` is removed. The `needs_you` counter stays as information only.
8. **Wall time, not summed minutes** (Revision 1 item 6). Ledger `working_seconds` is wall-clock time with at least one main session of that tool working; concurrent sessions are not summed; the cap is 90000 s (a 25-hour daylight-saving day).
9. **Ambient is manual by default** (Revision 1 item 5): the documented default of Settings `ambient.idle_minutes` is now `null`. Shape unchanged.
10. Snapshot `limited_until` and `confidence` descriptions now say that `limited` clears only on a fresh good signal, never on the clock alone, and that an unconfirmed restored alert is `inferred`.

## Conventions that apply to every contract

1. **JSON Schema draft 2020-12**, one self-contained file per contract (no cross-file `$ref`), so any consumer can load a single file. Shared definitions (`ms`, `day`, `tool`, `host`, `instance` and others) are copied into each schema that needs them; a test holds the copies identical.
2. **`$id`s use the reserved `.invalid` domain** (`https://busyholm.invalid/contracts/...`) so nobody mistakes them for fetchable URLs. The product domain is not cleared yet (gate G7).
3. **Every timestamp is an integer of milliseconds since the Unix epoch**, limited to 2000-01-01 through 2100-01-01. The range is a guard: a value in seconds, the most likely unit mistake, fails validation. Producers must serialise integers as integers (`1760270400000`, never `1760270400000.0`); the Rust types reject the float form.
4. **Optional versus nullable.** A property marked `?` in the spec is omitted when it does not apply and is never `null`. A property written `x | null` in the spec is always present and may be `null`. The Rust types enforce both directions (a missing required-nullable field and an explicit `null` in an optional field are both errors).
5. **Closed objects everywhere** (`additionalProperties: false`), so an unexpected field, including a leaked content field, is a validation error rather than silently carried.
6. **Custom keyword `x-unique-by`.** Standard JSON Schema cannot say "these item keys are unique across the array". `x-unique-by: [["id"], ["tool", "ordinal"]]` means each listed key tuple is unique among the array's items. The TypeScript validator registers it with ajv and the Rust types implement the same rule. A validator that ignores unknown keywords will be more lenient on exactly these rules and no others.
7. **ajv strict mode** is on, except the `strictRequired` and `strictTypes` lints, which cannot see a parent's `properties` and `type` from inside `if`/`then` and would force redundant declarations in every conditional.
8. **Ids are salted hashes with a fixed shape**: 32 lowercase hex characters (`^[0-9a-f]{32}$`). A raw session id or UUID cannot match, so "never the raw id" (5.3, 5.7 rule 4) is enforced by the schema, not just by convention. Recommended derivation: the first 16 bytes of HMAC-SHA256(per-install salt, `agent + ":" + raw id`).
9. **Days are checked by shape only** (`YYYY-MM-DD` with month 01 to 12 and day 01 to 31), so an impossible date such as 2026-02-30 passes both validators alike. Producers derive days from a real calendar, so this never occurs in practice; the shape check exists to catch format mistakes.
10. **Producer invariants that are deliberately not in the schemas** (they compare values across fields, which JSON Schema cannot express; WP-03 tests them): `attention.needs_you` equals the number of agents in state `needs_you` and `oldest_since` is the smallest of their `since`; `since >= started_at`; a subagent's `parent` differs from its own id and is present in the same snapshot; `observed_at <= t`; a HitRects rect lies inside its viewport; quiet hours start differs from end; a PendingAlerts record has `last_confirmed_at >= since`; every agent in Snapshot state `needs_you` has a PendingAlerts record and vice versa; Snapshot limits with the same non-null `account_id` but different roots are merged into one entry; a World `founders_stone` structure exists exactly when the top-level `founders_stone` is set.

## AgentEvent v1 (5.3)

1. **`usage.resets_at` is in milliseconds, not seconds.** 5.3 lists `resets_at (s)` while 5.4 says all timestamps are ms. Mixed units in one pipeline invite exactly the bug the ms range guard catches, so adapters convert the sources' epoch seconds at the edge.
2. **New `limit` object for `limit_hit`** (`provider`, `window` of `5h`, `weekly` or `unknown`, `resets_at` in ms or `null`). The spec's `usage` object needs `used_pct`, which no limit-hit source provides (Claude `StopFailure` `rate_limit` gives neither window nor reset time; transcript `quotaLimits` gives a window and reset but no percentage). `usage` is present exactly on `usage_sample` and `limit` exactly on `limit_hit`.
3. **Only Claude and Codex may carry `usage` or `limit`, and the provider must equal the reporting agent.** v0.1 has no limit data for any other agent (5.2).
4. **`detail` is an object of optional closed enums**, not a single enum: `activity` (only on `tool_end` and `heartbeat`), `error_class` (only on `error`), `notification` (any kind), `stop_reason` (only on `turn_end` and `turn_interrupted`), and a new **`end_reason`** (only on `session_end`: `clear`, `resume`, `logout`, `exit`, `process_gone`, `other`) so Claude's `SessionEnd` reason and "process gone plus 60 s" stay distinguishable. Omit `detail` when it would be empty.
5. **Enum values chosen for the detail fields** (the spec names the categories only): `error_class` collapses Claude's `StopFailure` values into `overloaded`, `server_error`, `network`, `auth` (authentication_failed, oauth_org_not_allowed, account_on_hold, cloud_credential_error), `billing`, `invalid_request`, `model_not_found`, `max_output_tokens`, `unknown` (`rate_limit` is a `limit_hit`, not an error). `notification` lists Claude's documented notification types plus `other`. `stop_reason`: `end_turn`, `interrupted`, `max_tokens`, `refusal`, `other`.
6. **`et` is optional** (omitted when the source states no time), and **`tokens_delta`** is a non-negative integer.
7. **No `tool_start` kind**, as in the spec. Adapters that see a tool begin (Claude `PreToolUse`) and want the activity to show before the tool ends can emit `heartbeat` with `detail.activity`. If WP-04 finds that insufficient, raise it for review rather than adding a kind.

## Snapshot v2 (5.4)

1. **New required `demo` flag.** 4.6 requires a Demo sign in the tray and on the noticeboard while demo mode runs, and demo moments must not raise OS notifications; the surfaces can only know from the snapshot.
2. **`agents[].id` is the AgentEvent `instance`** (same 32-hex shape), so ids are opaque and never raw.
3. **Conditional fields**: `reason` present exactly when `state` is `needs_you`; `activity` only when `working`; `limited_until` only when `limited` and omitted when the reset time is unknown.
4. **`project_label`**: 1 to 128 characters, no `/`, no `\`, no control characters (a last folder segment can never be a path). It appears only when the user opted in (5.7 rule 5). The privacy canary suite runs with the opt-in off; with it on, the canary planted in a fixture's working folder name is expected to appear in snapshots, and only there.
5. **Uniqueness**: agent `id`, the pair (`tool`, `ordinal`), (`tool`, `root_id`) in `tools`, and (`provider`, `window`, `account_id`, `root_id`) in `limits` are each unique (`x-unique-by`; null account ids compare equal).
6. **Limits**: `provider` is `claude` or `codex` (Relay v1 also allowed gemini and opencode, which have no limit data in v0.1). `attention.oldest_since` is `null` exactly when `needs_you` is 0.
7. **Size caps**: at most 64 agents, 8 tools, 4 limits.
8. **States**: `ended` from the 5.5 state machine is not a snapshot state; an ended agent leaves the `agents` list and the renderer plays the walk home on its disappearance. `offline` is per tool (`tools[].presence`), as in the spec.

## Moment v1 (5.4)

1. **Added `schema_version: 1`** (the spec gives Moment no version field).
2. **Moments carry enough to act on alone.** 6.2 sends Moments immediately and Snapshots coalesced at 4 per second, so a `needs_you` Moment can arrive before any snapshot shows that agent waiting. The notification "Codex needs you: permission" must be renderable from the Moment, hence:
   - `agent` and `tool` always travel together; they are required for `turn_end`, `needs_you`, `answered`, `error` and `recovered`, optional for `limit_hit`, and absent for island moments;
   - `reason` is required exactly on `needs_you`;
   - `turn_ms` (optional, `turn_end` only) drives the "long turn finished" notification (over 2 min, 6.9);
   - `provider` is required exactly on `limit_hit`, `limit_reset` and `weekly_reset`;
   - `structure` and `stage` (1 to 3) are required exactly on `build_complete`;
   - `milestone` is required exactly on `milestone`.
3. **Structure ids** (shared with World and Choices): the 12 progression structures of 4.5 as slots (`noticeboard`, `workshop_1`, `well`, `cottage_1`, `garden_plots`, `crossing`, `watermill`, `workshop_2`, `cottage_2`, `bell_tower`, `bakery`, `market_hall`), plus `campfire` and `tent` (free on day 1), `bell_post` (arrives with the hooks) and `founders_stone` (backfill monument). `crossing` is the footbridge or jetty; `workshop_2` is the second workshop or the guest house.
4. **Milestone ids** for the seven milestones of 4.5: `first_turn`, `first_answer`, `first_subagent`, `two_tools_day`, `turns_100`, `streak_7`, `turns_1000`.

## Ledger v1 (6.8)

1. Field names for the nine per-day, per-tool counters: `turns`, `interrupted_turns`, `sessions`, `working_seconds` (wall time), `needs_you` (information only), `errors`, `recovered`, `limit_hits`, `subagent_turns` (r1 removed `quick_answers`). Shape: `days[YYYY-MM-DD][tool] = counts`; a listed day has at least one tool.
2. **Added `founded_day`**: the founding crate (4.5) needs a day to land on, and a user can install days before the first agent event.
3. **Added `hooks_first_connected_day`** (`null` until it happens): "the bell post arrives when the first agent's hooks are connected" (4.5) is not derivable from counts.
4. **Added `backfill`** (`null`, or `imported_at` plus at most 31 days of the same counters), kept apart from live days so `grow()` can enforce the backfill cap and engrave the Founders' Stone (4.5) without double counting.
5. **`seed` is an unsigned 32-bit integer**, so it survives JavaScript numbers exactly.
6. `privacy.containsText: false` is required, as 5.7 rule 7 says; the same file shape serves `demo-ledger.json`.
7. Caps: counters at most 1,000,000 per day per tool; `working_seconds` at most 90000 (wall time, so concurrent sessions never add up; 25 hours covers a daylight-saving day).
8. **Added optional `day_totals`** (2026-10-12, review r1 M2; no version bump, a ledger without it stays valid and grows exactly as before). A top-level object keyed by local day (same rule as the `days` keys); each value is `{ "working_seconds": <integer 0 to 90000> }` and nothing else: the wall seconds with at least one main session of ANY tool working, the union across tools, so tools running side by side are not summed. It is never `null` (leave it out) and has no cross-field rule against `days`, because rounding remainders make exact relations unsafe. Rust: `ledger::DayTotals { working_seconds: u32 }`, `ledger::LedgerDayTotals = BTreeMap<Day, DayTotals>`, `Ledger.day_totals: Option<LedgerDayTotals>`. TypeScript: `DayTotals`, `LedgerDayTotals`, `Ledger.day_totals?`.

## Choices v1 (new contract; 6.8)

The spec names `choices.json` ("timestamped build-order and decoration choices, so replay is exact") and makes it the third input of `grow(seed, ledger, choices)`, but gives no shape and does not list it among WP-01's contracts. WP-08 cannot type `grow()` without it, so it is added here as a ninth contract.

- An append-only `log`, oldest first; the state at any moment is the fold of the entries up to it, which makes the weekly replay exact.
- Two entry kinds: `build_order` (a priority list of 1 to 12 distinct progression structures; unlisted ones keep their default order after it) and `decoration` (`decoration` id and `on` true or false).
- Every entry carries both `t` (ms) and `day` (the local day it was made), so `grow()` never needs a time zone and stays pure.
- Decoration ids are slugs (`^[a-z][a-z0-9_]{1,31}$`) because the spec names only about 10 of the 24 decorations; WP-08 owns the catalogue.
- `privacy.containsText: false` is required, as for the ledger.

## World v1 (new shape; 4.5, WP-08)

The spec defines World only as `grow()`'s output. This contract fixes its shape and leaves every number (costs, curves, thresholds, decoration prices) to WP-08's economy config.

- `tier` (`camp`, `hamlet`, `village`), `resources` (balances now) and `earned` (lifetime, including the founding crate and the capped backfill). Resources are numbers, since planks can be fractional (0.5 per turn past 20).
- `structures`: in effective build order, each with `status` (`planned`, `waiting`, `building`, `complete`), `stage` 0 to 3 and `progress` 0 to 1. `complete` holds exactly when `stage` is 3 and `progress` is 1, and then `completed_day` is required. `waiting` (an extra condition, which since r1 can only be a number of active days) carries `waiting_for.active_days`.
- **Workshop variants are tools, not species**: `workshop_1` and `workshop_2` name the tool whose workshop they are, and the renderer maps tool to species to art. Species is a setting (4.2) and `grow()` does not read settings, so a species change can never alter the world. `workshop_2` may be `guest_house`; `crossing` is `footbridge` or `jetty`; no other structure has a variant.
- `planned` and `waiting` structures are not pinned to stage 0: if the user reorders the build queue mid-build, a partly delivered structure can drop back to `planned` with its progress kept.
- `decorations`: owned decorations with a seeded `slot` and `shown`; ids and slots unique.
- `milestones` (id and day), `stats` (lifetime turns, active days, current streak, tools seen), `founders_stone` (`null` without a backfill) and `demo_capped`.
- Not in World: season and time of day. The renderer takes them from the calendar, the hemisphere setting and the usage limits (4.4), which keeps `grow()` a function of its three inputs only.

## HitRects v1 (6.2, 6.3)

The spec gives only "at most 64 rectangles". Filled in:
- Units are logical (CSS) pixels with the origin at the top-left of the webview content area; `viewport` (`w`, `h`) and `scale` (devicePixelRatio) travel with each message so the core can detect a stale or mis-scaled set.
- Each message replaces the previous set; an empty list makes the whole strip click-through.
- `surface` is `strip` only in v0.1.
- The core needs geometry only; `kind` and `agent` are optional diagnostics.

## Settings v1 (6.9)

- Every group in 6.9 is present and required, so a settings file is always complete; defaults are documented in the schema descriptions and written on first run.
- **Added `strip.enabled`** (6.2 says the strip is present "while enabled").
- `strip.display` is `{ "mode": "auto" }` (the display with the Dock or taskbar, else the primary) or `{ "mode": "named", "name": ... }`.
- Notification durations are fixed by the spec (re-notify after 5 min, long turn over 2 min), so they are booleans, not numbers.
- `ambient.idle_minutes` is 5 to 60 or `null` for off; `ambient.shortcut` is an accelerator string or `null`.
- `agents.species` holds only the per-tool overrides of the 4.2 defaults.
- **Hook connection and the status line wrap are not settings**: they are actions whose result is recorded in InstallManifest v1, so there is a single source of truth for what is installed.
- **Muting an agent from its card is session-only** and not stored (sessions end; a stored per-session mute would be dead data).
- Defaults the spec does not state, chosen here: `sound.volume` 0.7 and `other.launch_at_login` false (onboarding offers to turn it on).
- **Added `updates.check`** (default `false`), the opt-in update check of the direct-download build (6.10).

## InstallManifest v1 (6.8, WP-07)

- **It holds absolute paths of the agent config files it touched** (for example `~/.claude/settings.json` expanded), which include the account's user name. 5.7 forbids paths in outputs; this file is the one exception because a byte-exact restore must know exactly where to write. It is local only, core-written, never exported, never shown in full, and holds no project path. The privacy canary suite does not treat it as an output.
- **No receiver or secret** (since r1): the shim reads the receiver's port and token from a 0600 runtime file.
- **`owner_tag`** (null only while `entries` is empty): a random per-install tag written into every owned hook entry.
- Per entry: `tool` (`null` exactly for the shared `shim_binary`), `target` (`claude_hooks` and `claude_statusline` are separate consents although both edit `settings.json`), `action` (`edit_span`: entries added to an existing file; `create_file`: a file the installer created), `state` (`pending_review` only for Codex hooks until the user trusts them with `/hooks`), `before` (whether the file existed, its sha256 and size), `after`, and `owned` for every config-file target: one item per owned entry (`event`, `pointer` hint, `sha256` of the exact inserted text, `replaced_sha256` when it replaced a value, as the statusLine wrap does).
- **Backups are named by content hash**: the original file is kept at `<app data>/backups/install/<before.sha256>.bak` and a replaced value at `<app data>/backups/install/<replaced_sha256>.bak`, for diagnostics, manual recovery and putting a replaced value back.
- Disconnect rule this shape supports (since r1): remove exactly the owned entries (found by `owner_tag` and hash) and put back any replaced value; delete a file the installer created only if it still equals `after.sha256`; never restore a whole-file backup over a file that changed after install, so later edits by the user or another tool survive.

## Open questions this work package could not settle

- Whether the renderer wants activity before a tool ends (see AgentEvent item 7).
- Whether milestones should include the hamlet and village tiers as celebrated moments; the spec lists seven milestones and the tiers are not among them.
- Linux and Windows paths in InstallManifest are only shape-checked (POSIX `/` or a drive letter); UNC paths are rejected on purpose.
- One Choices invalid fixture (`order-of-thirteen`) necessarily breaks two rules at once (more than 12 items, and therefore a repeat), because there are only 12 progression structures.

## Proposed (not yet accepted; needs maintainer review before any contract changes)

### From WP-05 (Codex adapter), 2026-10-12

The AgentEvent v1 schema description says each raw payload produces at most one
event. A Codex `token_count` record reports both the 300-minute and 10,080-minute
windows, but each `usage_sample` holds exactly one window. Clarify the description
to allow a bounded list of normalized events. Workaround: the published WP-03
adapter trait already returns `Vec<AgentEvent>`; WP-05 emits one validated event
per good window, plus a limit event when reported. No schema or type is changed.

### From WP-08 (grow), 2026-10-12

1. **ACCEPTED (2026-10-12, review r1 M2, approved by the maintainers): cross-tool wall time, now the optional `day_totals` field of Ledger v1** (see "Ledger v1" item 8; no version bump). Original problem: `working_seconds` is wall time per tool, so Claude Code and Codex working side by side for 3 h summed to 6 h of stone earnings, because the ledger had no day-level union and `grow()` could only add the per-tool values. Final shape: top-level optional `day_totals`, keyed by local day, each value `{ "working_seconds": <integer 0 to 90000> }` (no other properties), the wall seconds with at least one main session of any tool working. `grow()` uses it for a listed day when present (ignoring `day_totals` days that have no `days` record) and otherwise sums the per-tool values exactly as before; the 6 h working-time stone cap stays. Tested in `world/grow/test/fairness.test.ts`.
   - DECIDED by the maintainers (2026-10-12): a `day_totals` day with no `days` entry earns nothing (no completed turn means not an active day); grow() keeps that rule.
2. **Clarification for Choices v1 consumers (no shape change): a `build_order` entry takes effect from the day after its `day`.** The ledger holds daily totals only, so `grow()` cannot place a choice between two turns of the same day; applying it to its own day would re-deliver that whole day's earnings in the new order and could take back a structure the user already saw completed. The noticeboard (WP-11) should say the builders start on the new pick tomorrow; the replay (WP-13) needs nothing extra. `decoration` entries apply on their own day. Rationale and tests in `world/grow/src/grow.ts` and `world/grow/test/gaps.test.ts`.
3. **`waiting` is used for one condition only:** the market hall waits until 12 active days have finished (days before the one being built on, so a day's own activity never re-routes that day's deliveries). The first workshop, which needs a seen tool for its species, blocks the queue with status `planned` instead of being skipped, for the same reason. If the noticeboard needs to tell these apart, a `waiting_for.tool_seen` flag would be the smallest addition.

### From WP-06 (OpenCode, Antigravity, process scanner), 2026-10-12

No schema or type is changed. Four gaps to settle with WP-03 and WP-07:

1. **Where the plugin finds the receiver.** The receiver writes `RuntimeInfo` (`{v, port, secret, token}`, mode 0600) to a path the receiver's caller chooses; no default path exists yet. `collector-wp06/plugin/busyholm.js` reads it from, in order: a constant the installer substitutes (`RUNTIME_FILE_OVERRIDE`), the `BUSYHOLM_RUNTIME_FILE` environment variable, or a per-OS default (macOS `~/Library/Application Support/Busyholm/runtime.json`, Windows `%APPDATA%\Busyholm\runtime.json`, Linux `$XDG_RUNTIME_DIR/busyholm/runtime.json` falling back to `~/.local/share/busyholm/runtime.json`). WP-03 or WP-07 should fix the real path and have the installer write it into the plugin copy.
2. **One resident per agent process.** A process-scanner `process_up` and a session event describe the same running agent, but only agy can be tied together (the agy reader files a log's events under the process identity `process_raw(pid, start_ms)` when the log's creation time or the single live process makes it clear; otherwise under the log's own name). OpenCode cannot: one process hosts any number of sessions and the pid is not in the database. The state machine should treat `process_up` as tool presence, and create a resident only from a session-bearing event, or from `process_up` of a tool with no session-bearing source (agy before its log appears).
3. **`root_id` for the process scanner.** `ProcessTracker::set_root(tool, root)` lets the integrator give each tool the same connector key as its data-root adapter, so presence and sessions share one `tools[]` entry. Without it the key is `process-scan:<tool>`.
4. **Adapter router: one adapter per `Tool`.** `ProcessScanner` spans several tools and registers as `Tool::Other`. If the router ever needs per-tool process adapters, split it by `classify()`.

### From WP-02 (app shell), 2026-10-12

1. **A shortcut for the details window (SPEC Revision 1 item 8).** Keyboard users get a focusable details window "opened from the tray or a shortcut", but Settings v1 has only `ambient.shortcut`. Proposal: `other.details_shortcut`, an accelerator string or `null`, default `null` (a default global hotkey would collide with other apps), with the same pattern as `ambient.shortcut`. **Workaround until then:** the details window opens from the tray ("Open Busyholm") and from the popover; the shell registers only `ambient.shortcut`.
2. **World inputs replace the proposed `bh:world`.** The core cannot run `grow()` (TypeScript), so pages compute the world. The shell sends `{ seed, ledger: Ledger v1, choices: Choices v1 }` as the `bh:world-inputs` event, the `bh_get_world_inputs` command and `world_inputs` in the boot data (null until a ledger exists; `seed` is `ledger.seed`; an empty Choices log when `choices.json` is missing). No schema change: the object is a pair of existing contracts plus the seed they already contain. Documented in `app/README.md`.
3. **For WP-03: emit the ledger when it is flushed.** `run_service` writes `ledger.json` when counts change (and every 30 s for time accrual) but emits `CollectorOutput::Ledger` only on shutdown, so pages see a new world up to 30 s after the file changes (the shell watches the file's stamp every 30 s) and a fresh install has no world inputs until the first flush. Proposal: emit `CollectorOutput::Ledger` at start (the loaded or new ledger) and after each flush. **Workaround:** the shell reads `ledger.json` at start and checks its stamp every 30 s.
4. **Experimental layer modes.** Revision 1 item 5 defers "extra layer modes" but Settings v1 `strip.layer_mode` still offers `behind_windows` and `reserve_space` with no way to mark them experimental. No change proposed: the shell labels both "(experimental)" in the tray and settings UI, and falls back from `reserve_space` to `on_top` (logged with reason `unsupported`) on macOS and on Linux Wayland.

### From WP-07 (installer and `busyholm-hook` shim), 2026-10-12

No schema or type is changed. Seven points for maintainer review and for WP-03 / WP-11:

1. **`owned[].sha256` is the hash of the canonical text, not of the bytes in the file.** "The inserted value's exact text" depends on the indentation of whatever file it lands in, so the installer hashes the canonical form (compact JSON, object keys sorted by byte order, `installer::canonical_json`). The same group therefore hashes the same after a formatter re-indents the file. Proposed wording for the schema description: "SHA-256 of the canonical JSON text (sorted keys, no whitespace) of the inserted value".
2. **The manifest cannot say which containers the installer created.** Removing our handler from `hooks.Stop` should also remove `Stop` (and `hooks`) when the install created them, and must not when the user already had an empty one. `owned` carries only `event`, `pointer`, `sha256`, `replaced_sha256`. Workaround used: the installer reads the kept `before` backup (`backups/install/<before.sha256>.bak`) and treats a container as created when the original lacks it; with no backup it never removes a container. An optional `created_container: boolean` per owned item would make this independent of the backup. No change made.
3. **Receiver bodies are the shim's allowlisted hook bodies, not normalised AgentEvents.** The shim POSTs `/e/<secret>` with `Content-Type: application/json`, `Host: 127.0.0.1:<port>`, `X-Busyholm-Token`, and `X-Busyholm-Agent: claude | codex | gemini`; the body is the hook's own JSON reduced to the allowlist in `collector-claude/SHIM_ALLOWLIST.md` (plus `turn_id`, `timestamp`, `host` for Codex), or for the Claude status line `{session_id, rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}}`. WP-03's `NormalizedMapper` (sidecar default) expects a normalised AgentEvent, but its `AdapterRouter` routes by `X-Busyholm-Agent` to the adapter's `map_hook`. The sidecar binary must be started with an `AdapterRouter`, not the `NormalizedMapper`, or every shim POST is rejected and (by design) nothing surfaces. Checked end to end in `shim/tests/e2e_collector.rs` (installed entry -> shim -> real receiver -> Claude adapter -> NeedsPermission and two UsageSample events). The shim never retries and ignores the reply status.
4. **Runtime file path.** The installer and shim assume `<app data folder>/runtime.json` (what the collector tests use). The installer passes the absolute path in every entry (`--runtime`) and substitutes it into the OpenCode plugin's `RUNTIME_FILE_OVERRIDE` line, so the WP-06 plugin's per-OS default (Linux `$XDG_RUNTIME_DIR/busyholm`, which differs from SPEC 6.8's `$XDG_DATA_HOME/busyholm`) is never used on an installed copy. The default should still be aligned.
5. **Claude hook entries use exec form** (`command` + `args`, verified present in the installed Claude Code 2.1.296 binary) so a data folder with a space ("Application Support") needs no shell quoting; Codex has no `args`, so its entries are shell form with POSIX quoting. Windows quoting (`commandWindows`, PowerShell) is not done or tested in this package.
6. **Codex hook trust is by hash.** Any change to our Codex entries (a new shim path, for instance) makes Codex ask for review again in `/hooks`; the installer keeps the entry text deterministic and marks the manifest entry `pending_review` whenever it writes one.
7. **Fixtures need `-text`.** The repo-wide `* text=auto eol=lf` rule silently turned the CRLF fixtures into LF on commit; `installer/tests/fixtures/.gitattributes` sets `* -text` so CRLF, BOM and invalid UTF-8 survive.

### From WP-12 (ambient mode), 2026-10-12

1. **Ambient page: a short grace period before input counts.** `world/renderer/src/pages/ambient-main.ts` calls `bh_ambient_exit` on the first `keydown`, `mousedown` or 8 px `mousemove`. A scene started by the global shortcut can be closed at once by auto-repeat of the shortcut's held key (or by the key-up of a slow press that arrives as a `keydown` repeat), and a tray start by the cursor still travelling. The core's native guard already ignores the first 0.6 s (1.5 s for a hand-started scene); proposed: the page ignores keyboard and mouse input for its first 600 ms too, and ignores `keydown` events with `repeat: true` for the first 1.5 s. Not changed here (WP-10 owns the page).
2. **Ambient footprint is far above SPEC 6.7.** Measured 2026-10-12 with `tools/measure.py` over 120 s on this Mac, real `world/dist/ambient.html` (WP-10) with the shell at 30 fps: CPU 4.96% of one core summed over five processes (budget 8%, passes), but physical footprint 588 MB in total (`com.apple.WebKit.WebContent` 306 MB, `com.apple.WebKit.GPU` 154 MB, the shell 41 MB, the hidden strip's WebContent 82 MB). SPEC 6.7 allows "+ 80 MB" over the idle budget (150 MB). Probably the full-resolution canvas backing store at 2x; a half-resolution backing store (the spike's 5.1% against 7.3%) would cut both. For WP-10 and the WP-14 memory gate.
3. **Idle trigger on macOS and keep-awake apps.** The macOS "call or video" probe is "another process holds a display-sleep assertion". Keep-awake utilities and some Electron apps hold one all day (on this Mac: Amphetamine and an Electron editor), which keeps the idle trigger quiet. That is the safe direction (manual start still works); if it proves too strict, the alternative is to ignore assertions older than a few hours, or to name known keep-awake apps. Decision for the lead before `IDLE_TRIGGER_VERIFIED` is flipped.

### From WP-11 (tray, popover, notifications, settings, details window, onboarding), 2026-10-12

No schema or type is changed. Points for maintainer review and for WP-03 / WP-14:

1. **`coverage: verified` cannot be reached yet.** `collector/src/core.rs` `set_coverage()` is the only path to `Verified` and nothing calls it; `set_hooks()` maps an install to `round_trip_pending`, so every connected tool shows "Activity only: connected; waiting for the first hook event" for ever. The UI is built for the designed states (verified shows "Alerts on"), and onboarding's last screen says a tool reads "Alerts on" once Busyholm has confirmed its hooks deliver. Proposal for WP-03: mark a connector `verified` on the first sanitized hook event received from it (the round trip SPEC Revision 1 item 2 describes), `round_trip_failed` if none arrives within a bounded time after an install. No contract change needed.
2. **History backfill is not implemented** (`collector/src/ledger.rs` always writes `backfill: null`; Revision 1 item 5 defers it). The onboarding step exists behind `BACKFILL_AVAILABLE = false` in `ui/src/ui/onboarding.js` and the settings switch is disabled with "Not available in this version", so nothing promises an import that never happens.
3. **"Delete everything" (SPEC 6.9 Privacy) needs a core command** (stop the collector, remove the ledger, choices, pending alerts and settings, after Disconnect all). Not offered in the UI until one exists.
4. **Page contract additions (documented in `app/README.md`):** commands `bh_connect_status`, `bh_connect_preview { parts }`, `bh_disconnect_preview { parts }`, `bh_connect_apply { token }`, `bh_onboarding { action: "get" | "done" }`; event `bh:connect-status`; `window.__BH_GLASS__` set on the macOS popover (native popover material). Parts are `claude_hooks`, `claude_statusline`, `codex_hooks`, `opencode_plugin`. A preview's token applies exactly that plan once; the installer refuses if a file changed since.
5. **`onboarding.json`** (new file in the app data folder, `{ "schema_version": 1, "done_at": ms }`, written atomically by the core only). Small enough not to need a contract; listed here so WP-14's data-folder inventory and "Delete everything" include it.
6. **Notifications skip while the popover or details window is focused** (the user is already looking); the episode still counts as notified, so no reminder storm follows. Text carries tool, ordinal and reason only (SPEC 5.7 rule 9), never project names even with the opt-in on.
