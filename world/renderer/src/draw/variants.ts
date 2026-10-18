/**
 * B2 art direction exploration variants.
 * Defines visual parameters for:
 * (A) deeper_papercut: darker silhouetted foreground layers, more paper layers with soft cast shadows, stronger backlight rim.
 * (B) seasonal_richness: more varied skylines (hills, distant mountains with snow, lighthouse, windmill), seasonal colour shifts, falling leaves or snow.
 * (C) evening_warmth: lantern light, glowing windows, fireflies and reflections on the water.
 */
import type { CanonicalArtVariant } from '../api.ts';

export interface VariantParams {
  id: CanonicalArtVariant;
  name: string;
  shadowScale: number;
  backlightBoost: number;
  rimBoost: number;
  extraPaperLayers: boolean;
  deepForeground: boolean;
  landmarks: boolean;
  snowyPeaks: boolean;
  seasonalColors: boolean;
  seasonalRichness: boolean;
  richParticles: boolean;
  warmLanterns: boolean;
  lanternLight: boolean;
  glowingWindows: boolean;
  waterReflections: boolean;
  extraFireflies: boolean;
  fireflies: boolean;
  vignetteWarmth: boolean;
}

export const VARIANT_CONFIGS: Record<CanonicalArtVariant, VariantParams> = {
  default: {
    id: 'default',
    name: 'Shipped Look',
    shadowScale: 1.0,
    backlightBoost: 1.0,
    rimBoost: 1.0,
    extraPaperLayers: false,
    deepForeground: false,
    landmarks: false,
    snowyPeaks: false,
    seasonalColors: false,
    seasonalRichness: false,
    richParticles: false,
    warmLanterns: false,
    lanternLight: false,
    glowingWindows: false,
    waterReflections: false,
    extraFireflies: false,
    fireflies: false,
    vignetteWarmth: false,
  },
  deeper_papercut: {
    id: 'deeper_papercut',
    name: 'Exploration A: Deeper Papercut',
    shadowScale: 1.7,
    backlightBoost: 2.0,
    rimBoost: 1.8,
    extraPaperLayers: true,
    deepForeground: true,
    landmarks: false,
    snowyPeaks: false,
    seasonalColors: false,
    seasonalRichness: false,
    richParticles: false,
    warmLanterns: false,
    lanternLight: false,
    glowingWindows: false,
    waterReflections: false,
    extraFireflies: false,
    fireflies: false,
    vignetteWarmth: false,
  },
  seasonal_richness: {
    id: 'seasonal_richness',
    name: 'Exploration B: Seasonal Richness',
    shadowScale: 1.1,
    backlightBoost: 1.2,
    rimBoost: 1.2,
    extraPaperLayers: false,
    deepForeground: false,
    landmarks: true,
    snowyPeaks: true,
    seasonalColors: true,
    seasonalRichness: true,
    richParticles: true,
    warmLanterns: false,
    lanternLight: false,
    glowingWindows: false,
    waterReflections: false,
    extraFireflies: false,
    fireflies: false,
    vignetteWarmth: false,
  },
  evening_warmth: {
    id: 'evening_warmth',
    name: 'Exploration C: Evening Warmth',
    shadowScale: 1.2,
    backlightBoost: 1.3,
    rimBoost: 1.3,
    extraPaperLayers: false,
    deepForeground: false,
    landmarks: false,
    snowyPeaks: false,
    seasonalColors: false,
    seasonalRichness: false,
    richParticles: false,
    warmLanterns: true,
    lanternLight: true,
    glowingWindows: true,
    waterReflections: true,
    extraFireflies: true,
    fireflies: true,
    vignetteWarmth: true,
  },
};

export function getVariantParams(variant?: CanonicalArtVariant): VariantParams {
  if (!variant || !VARIANT_CONFIGS[variant]) return VARIANT_CONFIGS.default;
  return VARIANT_CONFIGS[variant];
}
