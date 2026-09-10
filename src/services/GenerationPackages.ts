import { AURA_ANIMATION_NAMES } from './FighterAssetPacks';
import { PLAYABLE_ANIMATION_NAMES } from './PlayableFighterAssets';
import type { QualityTier } from './QualityTiers';

export type GenerationPackage = 'aura' | 'complete';
export interface GenerationPackageOptions {
  creationPackage?: GenerationPackage;
  /** Add the missing target pack while retaining all existing versions. */
  expansion?: boolean;
  /** Read the server quote without reserving credits or opening a provider session. */
  quoteOnly?: boolean;
  /** Reject a changed server quote before any reservation. */
  expectedCredits?: number;
}

export function parseGenerationPackage(value: unknown): GenerationPackage | null {
  if (value === undefined || value === null || value === '' || value === 'complete') return 'complete';
  return value === 'aura' ? 'aura' : null;
}

export function generationPackageAnimationNames(pack: GenerationPackage): readonly string[] {
  return pack === 'aura' ? AURA_ANIMATION_NAMES : PLAYABLE_ANIMATION_NAMES;
}

/** Six unique poses per performance, with a closed loop. No paid optional reactions. */
export const AURA_GENERATION_ANIMATIONS = [
  { name: 'aura_unbothered', motion: 'a relaxed confident unbothered idle loop, subtle breathing and a tiny head nod, arms relaxed, feet planted' },
  { name: 'aura_six_seven', motion: 'a six-seven hand gesture dance loop: alternating palms up at waist and chest height, elbows bent, small shoulder bounce, feet planted' },
  { name: 'aura_mog_check', motion: 'a confident mog-check pose loop: straighten posture, lift chin slightly, turn the face slightly toward the viewer while retaining right-facing body orientation, then settle' },
  { name: 'aura_glide', motion: 'a smooth in-place glide dance loop with alternating heel and toe slides and soft knee bends; the root stays centered without traveling across the cell' },
  { name: 'aura_floor_worm', motion: 'a floor-worm dance loop, body horizontal on the ground, chest and hips lifting in a sequential wave, supported naturally by hands and toes, full body always inside the cell' },
  { name: 'aura_one_leg', motion: 'a playful one-leg hop dance loop: one knee raised, support leg bends and extends through a small hop, arms balancing, returning to the opening pose' },
] as const;

const UNIQUE_FRAMES: Record<string, number> = {
  idle: 8, walk: 16, high_punch: 4, high_kick: 4, low_punch: 4, low_kick: 4,
  jump: 4, crouch: 4, hit: 4, ko: 8, victory: 8,
};
const FULL_PRICE: Record<QualityTier, number> = { rookie: 2, contender: 11, champion: 18 };
// Existing measured whole-fighter QA divided by its documented nominal cost.
const OVERHEAD: Record<QualityTier, number> = { rookie: 1.43 / (0.41 + 11 * 0.067), contender: 7.88 / (0.41 + 11 * 0.067 + 68 * 0.069), champion: 12.64 / (0.41 + 11 * 0.067 + 68 * 0.136) };
/** Lowest-value current pack, including VAT, EEA card processing and Stripe Tax. */
export const GENERATION_NET_EUR_PER_CREDIT = (56.99 / 1.21 - 56.99 * (0.015 + 0.005) - 0.25) / 47;
export const GENERATION_COST_COVERAGE = 1.30;

export function quoteGenerationPackage(
  tier: QualityTier,
  creationPackage: GenerationPackage,
  options: { expansion?: boolean; existingAnimations?: readonly string[] } = {},
) {
  const existing = new Set(options.expansion ? options.existingAnimations ?? [] : []);
  const animations = generationPackageAnimationNames(creationPackage).filter((name) => !existing.has(name));
  const uniqueFrames = animations.reduce((sum, name) => sum + (name.startsWith('aura_') ? 6 : UNIQUE_FRAMES[name] ?? 8), 0);
  const nominalUsd = (options.expansion ? 0 : 0.41) + animations.length * 0.067
    + (tier === 'rookie' ? 0 : uniqueFrames * ((tier === 'champion' ? 0.134 : 0.067) + 0.002));
  const estimatedUsdCost = nominalUsd * OVERHEAD[tier];
  const derivedCredits = animations.length === 0 ? 0 : Math.ceil(estimatedUsdCost * GENERATION_COST_COVERAGE / GENERATION_NET_EUR_PER_CREDIT);
  const creditCost = creationPackage === 'complete' && !options.expansion ? FULL_PRICE[tier] : derivedCredits;
  return {
    creationPackage, tier, creditCost, priceLabel: `${creditCost} credits`,
    animationCount: animations.length, animations, uniqueFrames, estimatedUsdCost,
    compatibleModes: creationPackage === 'aura' ? ['aura'] as const : ['fight', 'rush'] as const,
    /** These are conservative extrapolations, not measured Aura provider invoices. */
    costBasis: 'existing-qa-overhead-and-planned-operations' as const,
  };
}

export function assertPackageAnimationFrameCount(name: string, frameCount: number): void {
  if (AURA_ANIMATION_NAMES.includes(name as typeof AURA_ANIMATION_NAMES[number]) && frameCount !== 6) {
    throw new Error(`Aura performance ${name} requires six complete unique frames`);
  }
}
