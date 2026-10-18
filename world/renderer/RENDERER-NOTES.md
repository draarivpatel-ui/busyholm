# World renderer: notes 

Written 2026-10-12. The renderer draws the strip and the ambient view from Snapshot v2, Moment v1 and World v1, animates the residents (SPEC 4.3), runs the frame governor (SPEC 6.6) and publishes HitRects v1.

Performance note (updated 2026-10-17): the renderer-only measurements below are historical. Measured with all processes counted on a busy machine, the integrated app was over its idle and active budgets (`strip-idle` 1.39% CPU, 219 MiB, 78 wakeups/s; `strip-active` 3.95% CPU, 266 MiB, 252 wakeups/s); see "Performance" below.

## How to run it

| Command (from `world/renderer`) | What it does |
|---|---|
| `node --test "test/*.test.ts"` | acceptance tests 1 to 5 plus governor, HitRects and limits tests, headless in virtual time |
| `node tools/build.mjs` | bundles `strip.html`, `ambient.html` (WP-02 page contract), `capture.html` and `bench.html` into `world/dist` (gitignored) |
| `node tools/browser-tests.mjs` | tests 2, 3 and 5 again in real Chrome with real timers |
| `node tools/capture.mjs [--views strip1440,strip2560,ambient]` | the scripted 20 s sequence as PNG frames, an mp4 and key frames in `captures/` |
| `node tools/still.mjs --view ambient --at 2500,6000` | single frames for tuning by eye |
| `node tools/measure-cpu.mjs ...` | CPU, memory and wakeups of a page in real Chrome (the `tools/measure.py` method) |

The browser tools need Playwright: set `PLAYWRIGHT_PATH` to a `playwright-core` package directory or install `playwright-core` (see `tools/lib/playwright.mjs`). They launch Google Chrome (`channel: 'chrome'`).

## How it is built

- **Model** (`src/model.ts`, pure, runs in Node): residents, alerts, moments, effects, sky and the ambient camera. Inputs apply synchronously, so the next tick shows them. Bursting characters use a 12 fps pose grid. Calm strips share four paper steps per second, dropping to one every two seconds without residents or transient effects. Ambient characters retain their six-fps grid, with smooth particles, sky and camera movement.
- **Governor** (`src/governor.ts`): `setTimeout` ticks only (the spike found it cheaper than `requestAnimationFrame` in WebKit). Calm strips sleep until their next visual step; plane builds and crossfades retain six fps. Bursts run at up to 30 fps for at most 3 s with a cooldown; hidden means no timer at all; reduced motion ticks only on input. The renderer draws a tick only when the display list changed, and the sliding one-second cap still enforces the SPEC maxima.
- **View** (`src/draw/`): Canvas 2D. Everything that only changes with the light, season or World is rendered once into transparent "planes" with the art kit's own lighting (multiply by the sky light, haze by depth, sun-driven blurred drop shadow), then reused every frame. Moving things come from a lit-sprite cache (light, scarf tint and drop shadow baked per sprite and facing). A light change rebuilds the planes in the background and crossfades whole composed stacks.
- **Ambient composition**: world scale 4.6 at 1080 px, ground at 70% of the height, seven parallax bands (sky fixed, clouds, two mountain ranges, far hills, mid hills, far bank and river, village), reeds and a near-shore foreground at parallax 1.3, a screen-fixed sun glitter on the water, a warm vignette drawn before the alert. Low suns add a backlight and a rim light on near layers. Rendered at half resolution (the spike's rule).

## Decisions and deviations

- **Canvas 2D, not PixiJS** (SPEC 3.2 and 9.1 name PixiJS v8). The approved goldens are the art kit's Canvas 2D compositing; reproducing it in WebGL means custom filters and look drift, while per frame this view only blits cached images. Measured cost: see "Performance" below. WP-14: no PixiJS licence notice is needed while this holds.
- **World from inputs**: the core sends `{ seed, ledger, choices }` (`bh_get_world_inputs`, `bh:world-inputs`, WP-02) and the page calls WP-08's `grow()`. Until the core sends them the pages show the demo hamlet.
- **Visibility in Tauri**: WebKit reported the visible, non-activating strip window as `document.visibilityState === 'hidden'` in the spike shell, so inside Tauri the pages trust only the core's `bh:visibility`.
- **The bell tower** shares the bell post's slot; it is drawn only once complete, and then replaces the post.
- **Decorations** without art yet (stepping stones, fishing jetty, rowboat) are not drawn; others use the nearest kit sprite (listed in `src/layout.ts`).
- **Seasons**: v0.1 has autumn and winter art only; months outside winter use autumn.

## Fix wave r1 (FIX-D, 2026-10-12)

Tests: `test/fix-d.test.ts`. Review items M10, M11, M16, L1 (renderer part) and the demo-mode requests.

- **Alerts end cleanly (M10).** A snapshot that no longer lists a waiting resident drops its alert before residents are planned, so the resident walks home instead of standing at the bell. `error` and `turn_end` Moments close the wait at once; a snapshot older than that Moment cannot raise it again.
- **Ambient camera (M11 and NEEDS 1, 2).** The camera integrates the real frame time (`dtRaw`), so a pan moves on every 30 fps frame. While an alert is raised the camera target is kept inside the range that holds the bell post (30 units clear on the left, 50 on the right for the flag); from a camera that has lost the post it pulls back at 6 per second instead of 1.6. During the ping-pong pan an edge that comes within 20 units of a resident crosses at 100 units/s instead of resting on it, and the turnaround points move to where no edge slices a resident.
- **Live settings (M16).** `Renderer.updateSettings({ hemisphere, skyMode, species })`; the page forwards `bh:settings`. The debug log's `sky.season` shows the season.
- **Hit boxes (L1).** `opts.extraHitBoxes` is read every tick; a change is republished even when no pixel changed. `Renderer.refreshHitRects()` pokes a tick for a static reduced-motion page. (Stale rectangles after a strip geometry change are the shell's part of L1.)
- **Needs-you card (NEEDS 3).** `cardMetrics(viewW)` scales the card with the window so that the title is at least 9.5 px, the second line 8 px and the "more" line 7 px when the frame is shown 460 px wide: 1.0x up to a 920 px window, about 2.1x at 1920 px (title 40 px), at most 3x. The card stays under 42% of the width.

## Performance (this Mac, Apple M5)

**2026-10-17 integrated app measurement (all processes counted on a busy machine)**:
- `strip-idle`: **1.39% CPU, 219 MiB memory, 78 wakeups/s** (SPEC 6.7 budget: `1.0% CPU, 150 MiB, 60 wakeups/s`)
- `strip-active`: **3.95% CPU, 266 MiB memory, 252 wakeups/s** (SPEC 6.7 budget: `3.0% CPU, 150 MiB, 150 wakeups/s`)

Historical WP-10 spike-harness measurements (2026-10-12, `capture.html` in a copy of the spike's Tauri shell in `/tmp`, 30 to 40 s window):

| Scenario (SPEC 6.7, 2026-10-12 spike harness) | CPU, % of one core | Budget | Footprint (sum) | Budget |
|---|---:|---:|---:|---:|
| Strip idle: no agents, calm world (about 3.8 drawn frames a second) | 1.30 | 1.0 | 121 MB | 150 MB |
| Strip active: 3 agents working, helper, frog waiting (about 7 frames a second) | 2.59 | 3.0 | 167 MB | 150 MB |
| Strip hidden | 0.12 | 0.3 | 114 MB | |
| Strip forced to 30 fps (comparison) | 5.69 | | 194 MB | |
| Ambient steady, half render scale, 1512 x 982 at 2x | 3.7 to 6.7 | 8 | 272 MB | about 230 MB |
| Floor: one fullscreen 2D canvas, one moving rectangle, 30 fps | 4.3 | | 148 to 153 MB | |
| Floor: blank fullscreen page | 0.0 | | 72 MB | |

Chrome (informational; Chrome's footprint is the whole browser): strip idle 2.46%, active 3.87%, forced 30 fps 9.37%, ambient steady 4.81%.

What moved the numbers in the 2026-10-12 spike harness:
- First Tauri round: idle 2.71%, active 5.05%, ambient (sky transitions looping) 29.5% and 729 MB. Cause: in WebKit every committed frame has a fixed cost (WP-02's placeholder page costs 2.38% at 12 fps), so calm frame count matters more than frame content. Calm characters now step on a 4 fps grid on the strip (6 fps in ambient) and smoke at 4 fps.
- Ambient memory: 588 MB (WP-12, full render scale) to 294 MB at half render scale, to 272 MB with CPU-backed build scratch (`willReadFrequently`; WebKit keeps freed accelerated surfaces pooled in its GPU process), far layers at half plane scale and a smaller sprite cache. The canvases the view itself holds are about 24 MB at half scale (atlas 11, planes 10). A hidden ambient view releases every cache.
- `<canvas>` elements instead of OffscreenCanvas cost more in WebKit (strip idle 1.61% against 1.30%), so OffscreenCanvas stays.

## Known gaps

- Measured on 2026-10-17 with all processes counted on a busy machine, both `strip-idle` (`1.39% CPU, 219 MiB, 78 wakeups/s`) and `strip-active` (`3.95% CPU, 266 MiB, 252 wakeups/s`) exceed SPEC 6.7 budgets (`1.0% / 150 MiB / 60/s` idle; `3.0% / 150 MiB / 150/s` active); see [`reviews/2026-10-17-perf-attr-argon.md`](../../reviews/2026-10-17-perf-attr-argon.md).
- Ambient footprint is about 272 MB against about 230 MB.
- Half render scale makes the ambient view soft on Retina screens. It is the default for live use; the capture view renders at full scale.
- "Lanterns light one by one" happens through plane rebuilds during a sky transition, so it needs a transition (a sudden jump lights them all at once).
- The human legibility test (SPEC 3.7) has not been run.
- Mole and heron have no art; they fall back to the hedgehog.
