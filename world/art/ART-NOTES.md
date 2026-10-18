# Papercut Holm: art notes (WP-09)

Written 2026-10-12. Everything here is drawn in code from `src/tokens.ts`; there is no third-party art. Open `gallery.html` straight from disk to see every structure stage, every species pose, the sky at 8 times of day, every weather and the 10 golden scenes. PNG renders of the goldens are in `goldens/`.

## How to run it

| Command | What it does |
|---|---|
| `npm run build` | bundles `build/gallery.js`, `build/tests.js`, `build/bench.js` (classic IIFE, so the pages open from `file://`; the bundles are committed) |
| `npm test` | palette lint, contrast lint, dash lint, World v1 mapping test, then the browser tests (silhouettes and atlas timing in headless Chrome) |
| `npm run goldens` | rebuilds and renders all golden PNGs into `goldens/` |
| `npm run typecheck` | `tsc --noEmit` over `src/` |
| `bench.html` | atlas build cost by sprite group and effect (console output) |

## Acceptance tests (SPEC 9.1 WP-09)

1. **Palette lint** (`tools/lint-palette.ts`): fails on any hex, `rgb()`/`hsl()` with numbers, 6-digit `0x` literal or quoted named colour anywhere in `src/`, `tools/` or the pages, except `src/tokens.ts`. It has a `--self-test`. Result: OK, 31 files.
2. **Flag contrast lint** (`tools/lint-contrast.ts`): for every weather (9) at every 1% step of the day (plus the pre-dawn wrap), 21 samples down the sky gradient, each also with that weather's overlay behind the flag (rain stroke, snowflake, mist, cloud), and every land and building token under that step's light tint: the better of the two outlines (ink inside, cream outside) must reach 3:1. Result: OK, 57,223 checks, worst 3.51:1. Why it always passes: ink against cream is about 12:1, and contrast ratios multiply across a luminance range, so against any background one of the two outlines reaches at least the square root of 12, about 3.5:1. The flag colour against its own ink outline is 7.74:1.
3. **Silhouettes** (`src/tests-main.ts`, run by `tools/browser-tests.mjs`): each species is drawn in 8 state poses (working, needs_you, your_turn, error, limited, idle, celebrating, asleep) as a flat 1-bit mask at 2x, anchored at the feet. The metric is XOR pixels over union pixels for every pair. Closest pairs: beaver 22.5% (working vs idle), otter 29.9%, frog 26.0%, hare 19.8%, hedgehog 15.5% (working vs idle). The bar is 12%.
4. **Atlas time**: the strip atlas (558 sprites: every structure stage, lit windows, sails and wheel, 34 poses per species with scarf overlays, helpers, trees, decorations, flag and bell, effects, particles, clouds, signboard glyphs) built at 2x, median of 5 runs, **70 to 74 ms on this Apple M5**. Every timed run ends with a 1-pixel readback per page, because Chrome's GPU canvas records draw calls and rasterises lazily: without the readback the same build "took" 29 ms. The budget used on this machine is 150 ms, half of the SPEC's 300 ms for an M1, because an M5 is faster and I could not measure on an M1. That M1 number is still unmeasured.
5. **Golden approval**: mine is below; the main session and the user still need to look.
6. **Human legibility test** (SPEC 3.7): not run. It needs people.

`tools/test-worldmap.ts` also maps all 75 valid World v1 fixtures from WP-01 through `src/worldmap.ts` and checks every drawn structure resolves to a sprite the atlas builds.

## Why Canvas 2D, not PixiJS, inside the art kit

The kit rasterises; it does not render frames. Canvas 2D gives seeded scissor-cut paths, gradients, pattern grain and blur in a few lines, runs in a worker through `OffscreenCanvas`, and its output (a canvas page plus pixel frames) loads straight into PixiJS v8 with `Texture.from(page)` and one `Texture` per frame. So the kit has no renderer dependency and the gallery has no dependencies at all. PixiJS stays WP-10's renderer. The only npm dependency is esbuild, pinned at exactly 0.28.2, to bundle the pages.

## What I tried, what I kept, and why

**Paper.** Every piece is a polygon whose outline wobbles with seeded noise (0.32 units), with a soft inner shadow straight down, an optional light "cut core" rim on the top edge (the white core of coloured paper catching light, the single strongest papercut cue), and procedural grain (mottling, speckle and short fibres) laid on with source-atop. Kept all four. Inner shadows use a real canvas blur only at 3.5 device pixels per unit and above (the ambient view). Below that (the strip) they are two stacked offset fills. With the blur everywhere the atlas took 410 ms. With stepped fills it takes 70 ms and looks the same at 2x. Offsets are computed in device space, so rotated puppet arms still shadow downward.

**Light.** One sky sample drives everything: two-stop sky gradient, a multiply light tint for lit paper, a haze colour distant layers mix toward, sun and moon, lamps (windows and lanterns from golden hour on), stars and daylight. Each paper layer is drawn untinted, multiplied by the light, hazed by depth, then laid over the layers behind with an ink shadow whose offset and blur follow the sun (long at dawn and golden hour, short at noon, faint under cloud and by moonlight). Things that must never dim (lit windows, fire, lanterns, the flag and the ringing bell) are drawn after this in an emissive pass.
- Tried: haze toward the warm horizon colour. Rejected: at golden hour the hills dissolved into the sky.
- Kept: haze toward a cool dusty violet (real golden-hour aerial perspective). It is what separates the far hills, mid hills and mountains.

**The holm.** The first bank was meadow over a thick red-brown soil stripe over cold blue water, which read as three flat bands. The palette names the bank colour `bank` (dark green), so the front face is now green with a thin earth lip, tufts hanging over it and a few stones. The near water and the back river are their own layers, hazed toward the sky so they reflect golden light instead of staying blue. Creeks (footbridge, mill race) are cut through the bank with sloped earth sides.

**Residents.** Paper puppets: rigid parts (body, head, ears, tail, two arms, two feet, scarf) rotated at pivots. Poses are joint-angle data, 34 per species, all generated from one rig. Identity is carried by silhouette, not colour: beaver paddle tail, otter long tail and cream front, frog eye bumps and squat body, hare ears, hedgehog spike mantle.
- First version: arms the same colour as the head vanished when raised. Fixed with light paws and a slightly darker arm.
- Raised arms covered faces. Fixed with front-facing poses (alert, cheer, worry, stretch) that put the shoulders either side and mirror the back arm.
- Every state has its own prop: rope and bell for needs_you, lantern and check sign for your_turn, worry cloud for error, teacup and zzz for limited, broom for idle, confetti for celebrating, lying down for asleep.
- The scarf is the instance colour: a white overlay sprite per pose, tinted per instance (multiply, then destination-in).

**The alert.** The flag and the ringing bell carry the double outline and a soft halo, and the bell gets comic ringing marks so a still frame still says "ringing". The resting bell is plain brass paper, tinted like the world. That way the alert is the only loud thing on the strip (the "alert by exception" idea).

**The sky in the ambient view.** The first ambient frame was huge grey triangle mountains and a flat orange field. Kept now:
- two irregular faceted ranges, kept low, with warm sun-facing slopes;
- a far-bank forest band;
- tissue-paper bands across the lower sky that pick up sunset colour when the sun is low;
- a derived deeper zenith, used only where the sky is tall;
- a papercut sun made of stacked translucent discs with a bloom over the ridges;
- paper birds and torn-paper clouds with warm tops and mauve undersides;
- a warm multiply vignette (clear centre, warm-dark edges), added last; it gives a modest gain in depth and focus without hurting the dusk frame.

## Deviations from SPEC, each with the reason

- **Structures are at most 76 units tall, not 88** (SPEC 3.4). With the ground 30 px above the bottom of a 112 px strip, an 88 px building leaves the strip. Within 40 units of the bell post, roofs stay below y = 30 so the flag flies against sky.
- **Derived keyframes.** Morning is a blend of dawn and day (no new colour). The ambient sky adds a deeper zenith stop pulled toward the next keyframe; the strip keeps the SPEC's two stops.
- **Strip sun placement** is its own mapping (low suns sit just above the hills) because a literal elevation mapping hid the golden-hour sun behind the far hills.
- **Resting bell without the double outline**; the outline appears only while it rings. The flag always has it when raised.
- **Holm bank face is `bank` green with a thin soil lip**, not a soil stripe (see above).
- **Cursor, Aider and "other"** have no v0.1 workshop or species art (SPEC 4.2 lists mole and heron for v0.3). They map to the guest house shape and the hedgehog in `src/worldmap.ts`.
- **Fraunces is not bundled.** It is not installed here, and adding the font file was out of scope. Signboard glyph sprites use the stack `"Fraunces", "Iowan Old Style", Georgia, serif`, so they will regenerate in Fraunces when the OFL font file is added and loaded before the atlas build.
- **Added tokens.** Shades of the SPEC colours (`wallShade`, `roofDeep`, thatch and slate roofs, `woodDark`/`woodLight`, `stoneDark`/`stoneLight`, `windowDark`, soil, conifer, reed, `riverDeep`, mountain, flame, ember, highlight), six light-tint tokens (one per sky keyframe), a technical `maskWhite` for scarf overlays, and gallery page chrome. All are in `src/tokens.ts`, labelled WP-09.

## Inspirations

Two principles guided the look:
- **alerting by exception**: everything calm and muted except the one thing that needs you;
- **slow world, fast alert**.

The rest of the direction comes from: cut-paper picture books, shadow-box dioramas, and the layered paper look of games like Tearaway and Lumino City. Those were named from memory, not researched or checked for this note.

## For WP-10 (PixiJS): how to consume the kit

- `buildStripAtlas(scale, season)` or `buildAtlas(stripSprites(season), scale)` returns pages plus frames `{page, sx, sy, sw, sh, x0, y0}`. A frame's local origin is the sprite's anchor: bottom-centre on the ground for structures, trees and residents; the pivot for `st/<kind>/part`. Place a sprite with its frame's top-left at `(x + x0, y + y0)` in units.
- Rebuild the atlas when the strip height, `devicePixelRatio` or season changes. Scale = strip height / 112 x devicePixelRatio. The ambient view needs its own atlas at `3 x height/1080 x dpr`, where real blurred inner shadows switch on.
- Per layer, back to front:
  1. sky gradient, sun, moon and stars;
  2. clouds;
  3. mountains and far bank (ambient only);
  4. far hills, mid hills, river;
  5. sun bloom, mist;
  6. near water, then the bank;
  7. trees behind;
  8. structures (with rotating parts and the resting bell);
  9. smoke;
  10. decorations, residents, plank, dust and confetti;
  11. the emissive pass;
  12. the flag and ringing bell;
  13. weather particles;
  14. reeds;
  15. the ambient vignette (ambient only).

  `src/scene.ts` is the reference.
- Each paper layer is a container: tint it with `sky.light` (multiply), mix toward `sky.haze` by the layer's haze amount, and give it one drop shadow of ink at `shadowFor(sky).alpha`, offset `(dx, dy) x gap` and blur `blur x gap` in units. Haze and gap values are `HAZE` and the `layer()` calls in `src/compose.ts`.
- `st/<kind>/<stage>/lit` sprites go in the emissive pass at alpha `sky.lamps`. The flag, the ringing bell, fire, lanterns and fireflies are never tinted by the sky light. One exception: in the ambient view the vignette is multiplied over the whole frame last, so it can darken the alert by a few percent near the frame edges (the camera clamp keeps the bell post away from the corners; the strip has no vignette). If that matters, draw the vignette before the alert.
- Residents: draw `res/<species>/<pose>`, then `res/<species>/<pose>/scarf` tinted with the instance's scarf token (`SCARVES[i]`). Flip horizontally to face left. Helpers use `hlp/...` at 0.55 scale.
- World v1 to art: `artFor(worldStructure)` gives sprite, stage and canonical slot x; `mapX` in `src/scene.ts` compresses or centres the 1440-unit layout for the view width, and wide strips get seeded edge groves.

## Honest assessment of the goldens

- **Strongest: G05 dusk** (strip and ambient). Graded purple-to-pink sky in tissue bands, warm windows, lanterns, fireflies, the setting sun and a crescent moon. The ambient G05 is the frame I would put on the store page today.
- **G02, the alert, works.** The amber flag with its key icon and the ringing bell are the first thing the eye finds on the strip, at 2x and at 1x. At 1x the cream rim survives anti-aliasing against both the golden and the snowy sky, and the key is still recognisably a key. This is the core promise and it holds.
- **G01, G03, G04, G07, G09 are charming and consistent.** Buildings, residents and props read at 1:1. The error cloud needed a fix at 1x (it sat in front of the hills and vanished in greyscale). It now sits in the sky band with a cream backing.
- **G10, the golden-hour ambient screenshot, is calm and pleasant but not yet the showstopper SPEC 3.7 asks for.** The golden keyframes are light pastels, so the frame has little value contrast; dusk beats it. Next things to try:
  - a darker, warmer near-ground value (a backlit village);
  - stronger sun-side rim light on structures;
  - testing ambient at world scale 4x so the village fills more of the screen (3x is the SPEC default).
- **G08, day one**, is sparse by design (a camp on wild meadow in dawn mist). It reads as calm, but a little unfinished.
- **Creek cuts** under the footbridge and the mill race are acceptable, not great: they read as a slot more than a stream.
- **The strip at 1440 x 120** is a long horizontal composition with a lot of sky above a single row. That is inherent to a 112-unit strip. The sky, light and shadows carry it, but on a busy wallpaper the opaque sky band may feel heavy. A feathered sky top is worth testing on a real desktop in WP-02 or WP-10.
- **The legibility of states at 1x is not proven.** The automated proxy passes with margin (closest pair 15.5% against a 12% bar), but SPEC 3.7's human test is the real gate.

## Files

- `src/tokens.ts` holds the palette (the only hex in the kit), shadow alpha, sizes and paper constants. `src/color.ts` does the OKLab colour maths and WCAG contrast. `src/sky.ts` holds the sky lookup table, weathers and sun/moon arcs. `src/shadow.ts` turns the sun into shadow params. `src/paper.ts` is the paper primitive and grain. `src/rng.ts` holds seeded noise.
- `src/terrain.ts` draws the biome layers. `src/kit.ts` holds the building vocabulary. `src/structures.ts`, `structures-a.ts` and `structures-b.ts` hold 20 structure kinds with stages, lit parts and rotating parts. `src/residents.ts` holds the puppet rig and poses. `src/props.ts` holds trees, decorations, effects and particles. `src/alert.ts` holds the flag and bell.
- `src/sprites.ts` is the sprite registry. `src/atlas.ts` is the atlas builder and `drawFrame`. `src/compose.ts` and `src/scene.ts` are the reference compositor. `src/goldens.ts` defines the 10 scenes. `src/worldmap.ts` maps World v1 to art.
- `gallery.html` with `src/gallery-main.ts`; `tests.html` with `src/tests-main.ts`; `bench.html` with `src/bench-main.ts`.
- `tools/` holds the lints, the World v1 mapping test, the Playwright runners (`browser-tests.mjs`, `render-goldens.mjs`) and `build.mjs`.
- `goldens/`: `G01` to `G10` x `strip1440` (2880 x 240), `strip2560` (5120 x 320) and `ambient` (1920 x 1080), plus `G02` and `G09` at 1x device scale (`strip1440-1x`). That is 32 PNGs, about 29 MB.
