# app: the Tauri v2 shell

The core process of Busyholm: the strip, ambient, popover, settings and details windows, the tray, layer modes, display follow, hide over fullscreen apps, autostart, and the IPC hub that relays Snapshot v2 and Moment v1 from a collector to every window. The stack is Tauri 2.12.x, plain HTML pages and a little per-OS Rust.

## Layout

| Path | What |
|---|---|
| `src-tauri/` | The Rust crate `busyholm-app` (its own cargo workspace, so the root workspace never needs WebKit). |
| `src-tauri/src/geometry.rs` | Pure strip placement: which display, where the strip goes (SPEC 6.3, 6.5). |
| `src-tauri/src/clickthrough.rs` | Pure click-through and hover-fade state machine driven by the cursor poll and HitRects. |
| `src-tauri/src/hub.rs` | Collector trait, supervision with backoff, Snapshot coalescing (at most 4 per second), Moment relay. |
| `src-tauri/src/mock.rs` | Mock collector that replays the contract fixtures until WP-03 is wired in. |
| `src-tauri/src/settings.rs` | Settings v1 store in the app data folder (atomic writes; the core is the only writer). |
| `src-tauri/src/platform/` | Per-OS code: macOS (objc2), Windows (windows-rs), Linux (gtk). |
| `pages/` | Placeholder pages that exercise the IPC and HitRects contracts until `world/` and `ui/` ship theirs. |
| `scripts/assemble-frontend.mjs` | Builds `dist/` (the Tauri frontend): placeholders first, then `world/` and `ui/` builds on top when they exist. |
| `tests/` | Acceptance tests (SPEC 9.1 WP-02 tests 1 to 5) per OS. |

## Page contract (for WP-10 world renderer, WP-11 ui, WP-12 ambient)

Pages are plain HTML loaded from `dist/`. `withGlobalTauri` is on, so a page needs no npm package: use `window.__TAURI__.core.invoke` and `window.__TAURI__.event.listen`. `pages/bridge.js` wraps all of this (copy it or import it as `./bridge.js`). The CSP allows only local scripts (`script-src 'self'`): no inline scripts, no remote anything.

### File names in `dist/`

| Window label | Page | Who ships it | Notes |
|---|---|---|---|
| `strip` | `strip.html` | WP-10 (`world/`) | Transparent background. Non-activating: it never receives keyboard focus. |
| `ambient` | `ambient.html` | WP-10 / WP-12 | Fullscreen on the strip's display, created on demand and destroyed on exit. Manual by default (SPEC Revision 1 item 5). |
| `popover` | `popover.html` | WP-11 (`ui/`) | Attached to the tray icon; closes when it loses focus. |
| `settings` | `settings.html` | WP-11 | Ordinary window. |
| `details` | `details.html` | WP-11 | Ordinary focusable window for keyboard users (SPEC Revision 1 item 8), also the fallback surface where the strip is unsupported (Linux Wayland without a tested compositor). |

`scripts/assemble-frontend.mjs` copies `world/dist/{strip,ambient}.html` and `ui/dist/{popover,settings,details}.html` (with their assets) over the placeholders when those folders exist. The placeholders stay available under `dist/placeholder/` for the acceptance tests.

### Boot data

Before any page script runs, the core sets `window.__BUSYHOLM_BOOT__`:

```
{ surface: "strip" | "ambient" | "popover" | "settings" | "details",
  os: "macos" | "windows" | "linux",
  settings: Settings v1,
  strip: { supported: bool, layer: "on_top" | "behind_windows" | "reserve_space", w, h, scale } | null,
  test: { freeze: bool, fixed_rect: bool },
  world_inputs: { seed, ledger: Ledger v1, choices: Choices v1 } | null }
```

`world_inputs` is what the page needs to run `grow(seed, ledger, choices)` itself (the core cannot run TypeScript). It is `null` until a ledger exists (a fresh install before anything was counted); `seed` is the ledger's seed; `choices` is the empty log when no `choices.json` exists. The core reads both files from the data folder, validates them and never writes them (the collector owns `ledger.json`).

`test.freeze` asks the page to stop all motion (scripted tests need residents that stay put). `test.fixed_rect` asks the strip page to show one static interactive object at the horizontal centre and publish it as a HitRect. Real pages may ignore both, but then the acceptance tests must run against `dist/placeholder/strip.html`.

### Core to page (events)

| Event | Payload | When |
|---|---|---|
| `bh:snapshot` | Snapshot v2 | Coalesced to at most 4 per second; the newest always arrives. |
| `bh:moment` | Moment v1 | Immediately, never coalesced. |
| `bh:settings` | Settings v1 | After any settings change. |
| `bh:world-inputs` | `{ seed, ledger: Ledger v1, choices: Choices v1 }` | When the collector hands over a ledger (its output, or its periodic rewrite of `ledger.json`, checked every 30 s) or `choices.json` changes. Coalesced (bursts within 250 ms become one event) and never repeated when nothing changed. |
| `bh:strip-fade` | `{ on: bool }` | Strip only. Hover-fade (SPEC 6.3): `on` means fade the scenery to 20%; the core keeps the strip click-through until `on: false`. |
| `bh:visibility` | `{ visible: bool, reason: "shown" \| "hidden" \| "fullscreen" \| "ambient" \| "occluded" }` | Strip. Render at 0 fps while `visible` is false (SPEC 6.6). |
| `bh:strip-geometry` | `{ w, h, scale }` | Strip only, after a display, Dock, taskbar or scale change. Re-rasterise the atlas when `scale` changes (SPEC 6.5). |

### Page to core (commands)

| Command | Arguments | Returns | Notes |
|---|---|---|---|
| `bh_get_snapshot` | none | Snapshot v2 or `null` | Call once at start; later snapshots come as events. |
| `bh_get_world_inputs` | none | `{ seed, ledger, choices }` or `null` | Same object as `bh:world-inputs` and the boot data. |
| `bh_hit_rects` | `{ msg: HitRects v1 }` | nothing, or an error string | Strip only. Send a full replacement set whenever interactive objects move or appear (at most 64, logical CSS px, origin at the top-left of the page). An empty list makes the whole strip click-through. The core validates it against the contract and rejects anything invalid. |
| `bh_visibility_ack` | `{ visible: bool }` | nothing | Optional: tells the core the page reached 0 fps or resumed. |
| `bh_ambient_exit` | none | nothing | Ambient page: call on any key, click or mouse move over 8 px (SPEC 6.4). |
| `bh_get_settings` | none | Settings v1 | |
| `bh_set_settings` | `{ settings: Settings v1 }` | Settings v1 or an error string | The core validates, writes atomically and broadcasts `bh:settings`. |
| `bh_open` | `{ surface: "details" \| "settings" \| "popover" \| "ambient" }` | nothing | |
| `bh_close` | none | nothing | Closes the calling window (popover, settings, details, ambient). |
| `bh_page_event` | `{ name }` | nothing | Diagnostics for the acceptance tests: one of `resident_click`, `card_open`, `card_close`, `ambient_input`. The core writes it to the test log (when one is set) and ignores other names. |

WP-11 commands (implemented in `src/shell/wp11_glue.rs` over `src/connect.rs`, `src/notify.rs`, `src/onboarding.rs`; each checks the calling window's label):

| Command | Arguments | Returns | Notes |
|---|---|---|---|
| `bh_connect_status` | none | `{ parts: [{ part, connected, pending_review, available, path }], any_connected, shim_available }` | Settings, popover, details. `path` shows the home folder as `~`. |
| `bh_connect_preview` | `{ parts }` | `{ token, files: [{ path, diff, note, creates, deletes }], notes, noop }` | Settings window only (onboarding runs there). Writes nothing. Parts: `claude_hooks`, `claude_statusline`, `codex_hooks`, `opencode_plugin`. |
| `bh_disconnect_preview` | `{ parts }` (empty = everything Busyholm installed) | same as above | Settings window only. |
| `bh_connect_apply` | `{ token }` | the new status, or an error string | Applies exactly the previewed plan, once; refuses if a file changed since the preview. Emits `bh:connect-status`. |
| `bh_onboarding` | `{ action: "get" \| "done" }` | `{ done }` | `done` writes `onboarding.json`. On first run (no `onboarding.json`, not a `--test-log` run, no `BUSYHOLM_NO_ONBOARDING`) the core opens the settings window, whose page shows onboarding. |

INT-2 (coverage): the core tells the collector what the install manifest says about each tool's hooks (`hooks(tool, Installed | PendingReview | Missing)`, collector/DECISIONS.md "INT-1"). `src/hooks_link.rs` maps the manifest to one report each for Claude (hooks part only; the statusline is not hooks), Codex (`PendingReview` until Codex trusts the hooks) and OpenCode (the plugin), and keeps the newest reports so a collector that starts or restarts gets them at once. They are sent at app start and after every applied plan (connect, disconnect, disconnect all), so a disconnect ends `verified` and a reconnect lets the next hook event verify again. An unreadable manifest reports nothing rather than guessing.

INT-2 (preview truth): `tests/int2_preview_fixture.rs` builds the real installer plan in a temp home with synthetic config files, applies it in a second temp home to read back which hook events really land (13 for Claude, 10 for Codex), and keeps the plan as `ui/test/fixtures/real-plan.json`; `ui/test/browser/int2-preview.test.mjs` renders it in the real onboarding page and checks every diff line is in the page and every event is named outside the scrolling diff box (in the entry's note). The single "Stop" line seen in the WP-11 screenshots came from the test double (`ui/test/fake-core.js` answers with one fixed line), not from the page.

The core also sends OS notifications itself (needs you, a reminder after 5 minutes, long turn, error; decided in `src/notify.rs`), shows the needs-you count on the tray (macOS title, tooltip, flag icon), and on macOS opens the popover with the native popover material and `window.__BH_GLASS__ = true`.

Errors: a command that fails rejects its promise with the error string (Tauri's behaviour), so wrap calls in `try`/`catch`; `pages/bridge.js` does this for you.

Click-through is decided by the core, not the page: the core polls the cursor (30 Hz within 48 px of the strip, 4 Hz otherwise, not at all while hidden) and makes the window clickable only while the cursor is inside one of the page's HitRects. While the window is clickable the page receives ordinary mouse events, so hover and click handling stay in the page.

## Running

```
source ../tools/env.sh          # Rust toolchain on PATH
npm ci                          # pinned @tauri-apps/cli
npm run dev                     # debug build with the mock collector
npm run build                   # release bundles for this OS (see "Release build" below)
npm run test:scripts            # tests of the build scripts (assembly, release helpers)
```

## Release build (the entry points packaging calls)

A shipping build must contain the live collector, the `busyholm-hook` shim and the real pages, and it fails loudly if any is missing (review r1 H1). The pieces:

| Step | Entry point | What it enforces |
|---|---|---|
| Real pages | `node world/renderer/tools/build.mjs` and `node ui/tools/build.mjs`, then `node app/scripts/assemble-frontend.mjs --build-real` (this is the Tauri `beforeBuildCommand`; `--require-real` assembles without rebuilding) | Exits 1 naming every missing real page, every missing script or stylesheet a page references, and any page still identical to its placeholder. Development use without a flag keeps the placeholder fallback. The renderer's `bench.*` and `capture.*` pages are never copied into `dist/`. |
| Collector | `--features collector` | `src-tauri/build.rs` (`build_guard.rs`) panics on any `release` profile build without the feature, so `cargo build --release` or `tauri build` without it cannot produce an app with a null collector. `BUSYHOLM_ALLOW_NO_COLLECTOR=1` opts out for a measurement-only build. |
| Shim | `src-tauri/tauri.release.conf.json` sets `bundle.externalBin = ["binaries/busyholm-hook"]`; the file `src-tauri/binaries/busyholm-hook-<target triple>[.exe]` must exist (built from `-p busyholm-shim` in the root workspace) | Kept out of the base `tauri.conf.json` because `tauri-build` checks `externalBin` on every cargo build, including `cargo test`. Tauri puts the shim beside the app executable (`Contents/MacOS/` on macOS), which is where `connect.rs` looks. |
| All of it | `node app/scripts/build-release.mjs [--target <triple>] [--bundles app\|nsis\|deb\|appimage] [--cross-windows]` (`npm run build`, `build:app`, `build:win-x64`, `build:win-arm64`) | Builds the shim, runs `tauri build --features collector --config src-tauri/tauri.release.conf.json`, then checks that the app binary and the shim exist in the output and exits 1 otherwise. |

`packaging/build.py` does the same steps with its own overlay config (an absolute `externalBin` path and resources) and passes `--features collector` itself; the `build_guard.rs` check applies to it too.

Verified 2026-10-12 on macOS: `node scripts/build-release.mjs --bundles app` produced `Busyholm.app` (7.57 MiB) with `Contents/MacOS/busyholm-hook` inside, and `cargo check --release` without the feature fails with the guard message.

Command-line flags (debug and test use; none is needed in normal use):

| Flag | Meaning |
|---|---|
| `--data-dir <dir>` | Use this app data folder instead of the SPEC 6.8 one (also `BUSYHOLM_DATA_DIR`). Tests always set it. |
| `--test-log <file>` | Append JSON lines describing windows, levels, geometry, click-through and visibility (also `BUSYHOLM_TEST_LOG`). Never contains snapshot content. |
| `--mock-collector [dir]` | Replay contract fixtures from `dir` (default: the repo's `fixtures/contracts`). |
| `--mock-static` | With the mock: send one snapshot and stop (stable scenes for tests). |
| `--strip-page <path>` | Load this page in the strip (for example `placeholder/strip.html`). |
| `--test-freeze`, `--test-fixed-rect` | Set `boot.test.freeze` and `boot.test.fixed_rect`. |
| `--layer <mode>` | Override the layer mode for this run without saving it. |
| `--open <surface>` | Open a window at start (repeatable). |
| `--oracle` | macOS: log which window the window server would give a click at the cursor (test 2). |
| `--exit-after <s>` | Quit after N seconds. |

## Behaviour per OS (what the shell does today)

| | macOS | Windows | Linux |
|---|---|---|---|
| Strip | Floating level 3, all Spaces, converted to a non-activating NSPanel (never becomes key; `BUSYHOLM_NO_PANEL=1` turns the conversion off), shown with `orderFrontRegardless` | Topmost, `WS_EX_NOACTIVATE` + `WS_EX_TOOLWINDOW` kept by a window subclass (tao rewrites ex-styles), shown with `SW_SHOWNOACTIVATE` | X11 only: dock type hint, keep above, sticky; withheld on window managers tested to fail click-through (Openbox, Fluxbox, Xfwm4, IceWM; `BUSYHOLM_STRIP_ANY_WM=1` overrides). Wayland: no strip. Where the strip is withheld the tray and the details window still work, and the details window opens at launch (SPEC Revision 1 item 5) |
| Click-through | Core polls the cursor (30 Hz near, 4 Hz far, parked while hidden) against the page's HitRects and toggles `set_ignore_cursor_events` | same | same (X11) |
| Layer modes | On top; Behind windows (level -1; raised on top while an agent needs you); Reserve space falls back to On top | On top; Behind (HWND_BOTTOM); Reserve space = AppBar | On top; Behind (keep below); Reserve space = `_NET_WM_STRUT_PARTIAL` |
| Hide over fullscreen | Another app's normal-layer window covering the strip's display (notch-aware); a window that merely equals the work area is ambiguous and counts only when the Dock's window has left the screen; checked on Space and app-activation notifications plus a 5 s backstop. Rules in `src/fullscreen.rs` | Any visible, uncloaked window of another process exactly covering the strip's monitor (foreground or not), or the shell's busy state while the foreground window is on that monitor; foreground hook plus backstop. Rules in `src/fullscreen.rs` | Active window with `_NET_WM_STATE_FULLSCREEN`; backstop |
| Display follow | `NSApplicationDidChangeScreenParametersNotification` plus the SPEC 6.5 5 s backstop | `WM_DISPLAYCHANGE`, `WM_DPICHANGED`, `WM_SETTINGCHANGE(SPI_SETWORKAREA)`, AppBar notifications | GDK `monitors-changed`, `size-changed` |
| Ambient | On demand (tray, global shortcut from `ambient.shortcut`), level 1000 on the strip's display, destroyed on exit, activation handed back to the previous app. The idle trigger (WP-12: `src/ambient/`, glue in `src/shell/ambient_glue.rs`) runs only when `ambient.idle_minutes` is set AND `IDLE_TRIGGER_VERIFIED` is true for the OS (false on every OS today, so it is off and says so in the test log). When on, it starts a scene after the idle threshold unless a skip rule holds: ambient already open, strip off, a fullscreen app on the strip's display (asked fresh; unknown counts as fullscreen), a call or video (macOS: another app holds a display-sleep assertion; Windows: `ES_DISPLAY_REQUIRED`; Linux: not exposed), battery saver (macOS Low Power Mode, Windows battery saver; Linux: not exposed). Idle clocks: macOS `CGEventSource`, Windows `GetLastInputInfo`, Linux X11 `XScreenSaverQueryInfo` (dlopen) and GNOME `Mutter.IdleMonitor` through `gdbus`; Wayland compositors with `ext-idle-notify-v1` are not implemented (ambient is manual there). A native exit guard polls the cursor and the idle clock every 40 ms and ends the scene on a move over 8 px or a key or click (ignoring the first 0.6 s, 1.5 s for a hand-started scene), even if the page hangs. Busyholm never holds a power assertion | same, topmost | same |
| Autostart | `tauri-plugin-autostart` (LaunchAgent), off by default, follows `other.launch_at_login` | Run key | `~/.config/autostart` |

## Collector

The hub runs any `Collector` (trait in `src/hub.rs`): it restarts a failed or panicked collector with exponential backoff, validates everything against the contracts, coalesces Snapshot v2 to at most 4 per second and relays Moment v1 at once. Implementations: the fixture mock (`--mock-collector`, the default in debug builds), and the real WP-03 crate through `collector::run_service` with `--features collector` (`src/collector_link.rs`). The collector writes `ledger.json` and `pending-alerts.json` itself; the shell writes only `settings.json`.

## Acceptance tests (SPEC 9.1 WP-02)

| Where | Command | Status on 2026-10-12 |
|---|---|---|
| Pure logic, any OS | `cd src-tauri && cargo test` | 153 of 153 pass on macOS on 2026-10-12 (155 with `--features collector`); includes the placement matrix for test 3, click-through and hover-fade, hub, mock, settings, data folder, idle-trigger gate, the per-display fullscreen rules (`tests/fullscreen.rs`), the hit-rectangle store (`tests/clickthrough.rs`) and the release guard |
| macOS, this Mac | `bash tests/macos/run-acceptance.sh` | 14 pass, 0 fail, 3 blocked, the same on three back-to-back runs. Blocked: real synthetic clicks (needs the Accessibility/PostEvent permission, so click routing is checked with the window server's own hit test instead) and the Dock-left, auto-hide and 150% cells of test 3 on real hardware (would change this Mac's settings; covered by the placement matrix). One startup stall (no strip window after the first snapshot) was seen once early on and not reproduced in four full runs since; the harness now keeps a stack sample if it happens |
| Windows | `tests/windows/acceptance.ps1 -Binary ...` | Written on macOS, not run yet; `cargo xwin check` is clean |
| Linux X11 | `tests/linux/acceptance.sh [out dir]` (starts Xvfb, openbox and a private D-Bus itself) | Ubuntu 24.04 aarch64 VM: 32 pass, 0 fail, 4 blocked, including the strip withheld under Openbox (details window instead) and the layout and click suites under Metacity; cargo test passes there too. Test 3 in six cells (no panel, bottom panel, top panel, scale 2, scale 2 with panel, panel appearing at runtime); test 4 hide and return in about 0.25 s; test 5 struts, DOCK type, work area shrinks, no upward creep. Click routing passes with no window manager and under metacity, and fails under Openbox, Fluxbox, Xfwm4 and IceWM (see Known limits) |

## Ambient mode acceptance tests (SPEC 9.1 WP-12)

Debug builds only: `BUSYHOLM_FAKE_IDLE_FILE=<file>` (idle seconds, re-read each call), `BUSYHOLM_IDLE_TRIGGER=on` (opens the per-OS gate), `BUSYHOLM_FAKE_MEDIA=on|off`, `BUSYHOLM_FAKE_FULLSCREEN=on|off`. All four compile out of release builds, where the gate stays a constant.

| Where | Command | Status on 2026-10-12 |
|---|---|---|
| Pure logic, any OS | `cd src-tauri && cargo test --test ambient` | 17 of 17 pass on macOS and in the Linux VM (trigger against a fake idle source and each skip condition, exit guard rules) |
| macOS, this Mac | `bash tests/macos/run-ambient.sh [1,2,3,4]` | 12 pass, 0 fail, 1 blocked (real posted keys and clicks need the PostEvent permission; replaced by the guard test with the cursor warped, the idle clock moved through the fake file, and a z-order check). Test 1: threshold, real fullscreen app (no scene during, one after), fake call/video, closed gate, opt-out. Test 2: a move over 8 px closes the window in 18 to 49 ms; 5 px does not. Test 3: `pmset -g assertions` sampled 10 times over 30 s, nothing owned by Busyholm or its new WebKit processes. Test 4 (old 2026-10-12 measurement of a placeholder page; see [`../reviews/2026-10-17-perf-attr-argon.md`](../reviews/2026-10-17-perf-attr-argon.md) for current integrated app measurements): 4.96% of one core summed over Busyholm and four WebKit processes, 2 minutes (budget 8%) |
| Windows | `tests/windows/ambient.ps1 -Binary ...` | Written on macOS, not run yet; `cargo xwin check` is clean. Covers the same three tests with real `SendInput` keys and clicks, a probe window beneath, `powercfg /requests` and `SystemExecutionState` |
| Linux X11 | `tests/linux/ambient.sh [out dir] [tests]` | Ubuntu 24.04 aarch64 VM: 8 of 8 pass in the last full run of tests 1 to 3 (real `XScreenSaverQueryInfo` idle clock; real `xdotool` move, key and click close the scene in 4 to 30 ms; the click does not reach a Tk probe window beneath; no `Inhibit` call on the session bus). Test 2 repeated 5 times: 20 of 20 |

Known limits of ambient mode: the exit input (a key or click) is consumed by the scene, but the matching key-up or mouse-up, and key auto-repeat after the scene is gone, reach the app beneath; the macOS display-assertion probe also counts keep-awake apps (Amphetamine and an Electron editor hold one on this Mac), so the idle trigger would never start here until they stop; Wayland compositors other than GNOME have no idle source; Windows is unrun.

## Builds and sizes (2026-10-12, unsigned)

| Build | How | Size |
|---|---|---|
| macOS `Busyholm.app` | `npm run build:app` (`node scripts/build-release.mjs --bundles app`, which passes `--features collector --config src-tauri/tauri.release.conf.json`) | 8.2 MiB bundle (`Contents/MacOS/busyholm` + `Contents/MacOS/busyholm-hook` + `Contents/Resources/`) |
| Windows x64 NSIS installer | `npm run build:win-x64` (`node scripts/build-release.mjs --cross-windows --target x86_64-pc-windows-msvc --bundles nsis`) from this Mac | 1,895,397 bytes (1.81 MiB); `busyholm.exe` 6.77 MiB |
| Windows arm64 NSIS installer | `npm run build:win-arm64` (`node scripts/build-release.mjs --cross-windows --target aarch64-pc-windows-msvc --bundles nsis`) | 1,710,068 bytes (1.63 MiB); `busyholm.exe` 5.97 MiB |

An earlier stack spike's installer was 1.21 MiB; the shell adds the global-shortcut and autostart plugins, the contract types and the hub. MSI needs WiX on Windows (skipped). Linux `.deb` and AppImage are built with `npm run build -- --bundles deb,appimage` on Linux.

Old WP-02 shell-only measurement of a placeholder page on this Mac (2026-10-12, release binary, strip visible, static placeholder page, cursor away from the strip, `tools/measure.py`, 45 s;): 0.03% CPU, 64.1 MB footprint, 9.8 wakeups/s across the app and its WebKit helpers (SPEC 6.7 idle budget: 1.0%, 150 MB, 60/s). With the placeholder page animating at 12 fps the total was 2.38%, 152.7 MB, 409 wakeups/s.

## Known limits and follow-ups

- **Click activation is structurally prevented, not yet observed.** The strip is a non-activating panel that cannot become key, and the frontmost app stays frontmost when the strip appears; a real click on a resident could not be posted on this Mac (no Accessibility permission for this session). Grant it to the terminal and rerun test 1 to close this.
- **Occlusion.** In Behind-windows mode a covered strip should render at 0 fps (SPEC 6.6); the shell does not yet report occlusion (pages can use `document.visibilityState` meanwhile).
- **Windows and Linux** behaviour is compile-checked here and tested only where stated above. The Windows acceptance script could not be run red or green on this Mac; it has not been run yet.
- **Fullscreen rule on macOS (review r1 M15).** Decided per display in `src/fullscreen.rs`. A window spanning the display and reaching its bottom edge is fullscreen when it extends beyond the display's work area (a zoomed window never does): verified for a native fullscreen Space on this Mac's notched display (`tests/macos/acceptance.py` test 4 passes, hide in 1.0 s). A window equal to the work area (a zoomed window with an auto-hidden Dock, or a secondary display with no menu bar or Dock when "Displays have separate Spaces" is off) is ambiguous by bounds alone, so it counts as fullscreen only when the Dock's layer-20 window has left the on-screen list. Measured on 2026-10-12: that window is present normally and absent during a native fullscreen Space. Not verified: that it also disappears when the Dock is auto-hidden, and what happens on a secondary display (the Dock window then lives on another display, so an ambiguous window there is never treated as fullscreen). The menu bar window cannot be used: it stays listed during fullscreen.
- **Windows fullscreen rule (review r1 M15).** Per monitor in `src/fullscreen.rs` (pure and unit tested on any host): any visible, uncloaked, non-shell window of another process that covers the monitor within 1 px counts, whether or not it is the foreground window; `SHQueryUserNotificationState` is global, so a busy state counts for a monitor only while the foreground window is on it (or the foreground monitor is unknown). `cargo xwin check` is clean; `tests/windows/acceptance.ps1` test 4 has two-monitor steps (a fullscreen window on the other monitor does not hide the strip; a fullscreen window on the strip's monitor stays detected after focus moves away) that are written but have not run on a real Windows machine.
- **Wired but not exercised by any test yet:** display-follow notifications (no display or Dock change was made on this Mac; the 5 s backstop is the same code path), popover close on losing focus (needs a real click elsewhere), the settings and details windows opening from the tray, and the idle trigger's enter and exit path (gated off).
- **X11 window managers that frame the strip.** Click-through is an X11 input shape on the strip window; Openbox, Fluxbox, Xfwm4 and IceWM wrap it in a frame window without one, so empty-strip clicks never reach the window beneath. The shell therefore withholds the strip on those four (it reads the window manager's name from `_NET_SUPPORTING_WM_CHECK` / `_NET_WM_NAME`), so users there get the tray and the details window instead of a band that swallows clicks; `BUSYHOLM_STRIP_ANY_WM=1` overrides for testing. Mutter and KWin on X11 are unverified.
- **Single instance** (`tauri-plugin-single-instance`): a second launch focuses the running app's details window and exits. Runs with a data-folder override (`--data-dir`, `BUSYHOLM_DATA_DIR`), which tests and parallel agents use, skip the guard unless `--single-instance` is given.
- Test runs of the unbundled binary leave WebKit storage in `~/Library/WebKit/busyholm`.
