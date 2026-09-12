import { animationRetryCreditCost, type QualityTier } from '../../services/QualityTiers';

/** A mixed-quality fighter must retry the selected animation at its own quality. */
export function animationRetryQuote(
  animationName: string | null,
  sprites: readonly { animationName: string; qualityTier: QualityTier }[],
  fallbackTier: QualityTier,
): { tier: QualityTier; credits: number } {
  const tier = sprites.find((sprite) => sprite.animationName === animationName)?.qualityTier ?? fallbackTier;
  return { tier, credits: animationRetryCreditCost(tier) };
}
