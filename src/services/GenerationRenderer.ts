import type { QualityTier } from './QualityTiers';
import type { GenerationRendererVersion, TemplateAtlasRendererVersion } from './TemplateAtlasContract';

export function rendererForNewFighter(tier: QualityTier): TemplateAtlasRendererVersion {
  return tier === 'rookie' ? 'rookie-two-atlas-v1' : 'champion-animation-sheet-v1';
}

/** Maintenance follows the selected asset, never the fighter's highest tier. */
export function rendererForSprite(sprite: { animationFormat?: string; qualityTier: QualityTier }): GenerationRendererVersion {
  return sprite.animationFormat === 'template-atlas-v1' ? rendererForNewFighter(sprite.qualityTier) : 'legacy-v1';
}
