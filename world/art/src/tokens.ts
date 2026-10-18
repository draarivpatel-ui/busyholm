/**
 * Busyholm design tokens (WP-09).
 *
 * THIS IS THE ONLY FILE IN world/art WHERE A RAW COLOUR LITERAL MAY APPEAR.
 * `npm run lint:palette` fails on any hex, rgb(), hsl() or 0xRRGGBB literal elsewhere.
 * Shape code refers to colours by token name only (PAL.meadow, PAL.ink, ...).
 *
 * Groups marked SPEC come verbatim from SPEC.md section 3.3.
 * Groups marked WP-09 are additions the spec left open (shades, light tints, soil, fire);
 * each is derived from or tuned against the SPEC colours and is listed in ART-NOTES.md.
 */

export const PAL = {
  // SPEC: paper and ink
  ink: '#2B2A33',
  cream: '#F7EEDC',

  // SPEC: land
  farHills: '#A7B5A0',
  midHills: '#7E9C76',
  meadow: '#5F8758',
  bank: '#3E6646',
  river: '#6FA6B6',
  riverLight: '#CFE5E6',

  // SPEC: buildings
  wall: '#F1E4CC',
  roof: '#C2654A',
  wood: '#94673F',
  stone: '#B5AEA2',
  lampGlow: '#FFC86B',

  // SPEC: state accents
  alertFlag: '#FFB000',
  errorCoral: '#D9534A',
  worrySlate: '#5B6478',
  yourTurnSage: '#8FBFA6',

  // SPEC: species
  beaver: '#8B5A3C',
  otter: '#5E4B3E',
  otterFace: '#E9D6B6',
  hare: '#CDB89A',
  frog: '#6FA04F',
  mole: '#4A4453',
  heron: '#9AA9B8',
  hedgehog: '#7A6650',

  // SPEC: instance scarves
  scarf0: '#E07A5F',
  scarf1: '#3D84A8',
  scarf2: '#F2CC8F',
  scarf3: '#81B29A',
  scarf4: '#B56576',
  scarf5: '#6D597A',

  // SPEC: seasons
  leafAmber: '#D98C3F',
  leafRust: '#B5523B',
  snow: '#F4F7FA',

  // SPEC: sky keyframes (top / horizon)
  skyDawnTop: '#F2C4A6',
  skyDawnHorizon: '#FBE6C8',
  skyDayTop: '#8EC3E0',
  skyDayHorizon: '#E2F0EA',
  skyGoldenTop: '#EFAE78',
  skyGoldenHorizon: '#FCE0A8',
  skyDuskTop: '#5F4E86',
  skyDuskHorizon: '#E39275',
  skyNightTop: '#1B2140',
  skyNightHorizon: '#363C63',
  skyRainTop: '#8C97A6',
  skyRainHorizon: '#C9CFD4',

  // WP-09: shades of the SPEC building and land colours (paper of the same family, one step darker or lighter)
  wallShade: '#E0CDAE',
  roofDeep: '#9E4E3B',
  roofThatch: '#C9A15E',
  roofThatchDeep: '#A98345',
  roofSlate: '#6F7C8A',
  roofSlateDeep: '#56616D',
  woodDark: '#6B4A2F',
  woodLight: '#B88B5C',
  stoneDark: '#8E877C',
  stoneLight: '#D3CDC2',
  windowDark: '#3A4157',
  soil: '#7A5A44',
  soilDeep: '#56402F',
  conifer: '#2F5640',
  coniferLight: '#41704F',
  reed: '#4E6E42',
  reedTip: '#A9824F',
  meadowLight: '#76A06A',
  riverDeep: '#4E8496',
  mountain: '#8E9DB0',
  mountainSnow: '#E9EEF2',
  flame: '#F08A3C',
  ember: '#C8462E',
  speciesHighlight: '#FFF8EA',

  // WP-09: multiply light per sky keyframe (how lit paper is tinted at that time of day)
  lightDawn: '#F7DCCB',
  lightDay: '#FFFCF4',
  lightGolden: '#FFD6A3',
  lightDusk: '#B7A2C4',
  lightNight: '#53608F',
  lightRain: '#C3C9D1',

  // WP-09: technical white for tint masks (scarf overlays are painted white, then tinted per instance)
  maskWhite: '#FFFFFF',

  // WP-09: gallery page chrome only (never used in the world)
  uiPage: '#17181D',
  uiPanel: '#22242B',
  uiText: '#ECE6DA',
  uiMuted: '#9C978E',
  desktopTop: '#3B4A63',
  desktopBottom: '#1C2230',
} as const;

export type Token = keyof typeof PAL;

/** Layer shadow = ink at 18% alpha (SPEC 3.3). */
export const SHADOW_ALPHA = 0.18;

/** The six instance scarf tokens, in a stable order (instance index modulo 6). */
export const SCARVES: readonly Token[] = ['scarf0', 'scarf1', 'scarf2', 'scarf3', 'scarf4', 'scarf5'];

/** Font stacks (SPEC 3.6). Fraunces is preferred for signboards; serif fallback if it is not loaded. */
export const FONTS = {
  display: '"Fraunces", "Iowan Old Style", "Palatino Linotype", Georgia, serif',
  ui: '-apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", "Noto Sans", system-ui, sans-serif',
} as const;

/**
 * Sizes in strip units. One unit = one logical pixel at the default strip height of 112 (SPEC 3.4).
 * A strip of height H renders at scale H / 112; ambient renders the same units at 3x.
 * y is measured downward from the strip top.
 */
export const SIZES = {
  stripHeight: 112,
  stripMinHeight: 72,
  stripMaxHeight: 160,
  /** residents stand here: 30 px above the strip bottom */
  groundY: 82,
  /** structures stand slightly behind the path, so residents overlap their footings */
  structureBaseY: 80,
  /**
   * WP-09 deviation from SPEC 3.4 (40 to 88 px tall): with the ground at 82, an 88 px building
   * would leave the strip. Structures are 28 to 76 units tall (roof top never above y = 4).
   */
  structureMaxHeight: 76,
  /** pole top 96 px above the strip bottom */
  poleTopY: 16,
  flagW: 14,
  flagH: 10,
  bell: 10,
  /** within this horizontal distance of the bell post, roofs stay below this y so the flag reads against sky */
  flagClearRadius: 40,
  flagClearRoofY: 30,
  resident: { beaver: 24, otter: 24, hare: 28, frog: 18, hedgehog: 20 },
  helperScale: 0.55,
  sign: 18,
  ambientWorldScale: 3,
  /** ambient: sky takes the top 60% of the screen */
  ambientSkyFraction: 0.6,
} as const;

/** Cut-edge wobble and paper grain, in strip units. */
export const PAPER = {
  wobbleAmp: 0.32,
  wobbleStep: 2.6,
  grainAlpha: 0.1,
  innerShadowOffset: 0.55,
  innerShadowBlur: 0.9,
  innerShadowAlpha: 0.28,
  rimAlpha: 0.55,
} as const;
