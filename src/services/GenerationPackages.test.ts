import { describe, expect, it } from 'vitest';
import { AURA_ANIMATION_NAMES, isAnimationNameSetReadyForMode } from './FighterAssetPacks';
import { getAnimationProfile } from './AnimationProfiles';
import { getAnimationList } from './CharacterPipeline';
import { computeRequestedSpriteGrid } from './SpritePostProcess';
import { AURA_GENERATION_ANIMATIONS, assertPackageAnimationFrameCount, GENERATION_COST_COVERAGE, GENERATION_NET_EUR_PER_CREDIT, parseGenerationPackage, quoteGenerationPackage } from './GenerationPackages';

describe('outcome-based generation packages', () => {
  it('quotes only the games supported by the generated pack, without combat fallback in Aura', () => {
    const modes = ['fight', 'rush', 'aura'] as const;
    for (const tier of ['rookie', 'contender', 'champion'] as const) {
      const fight = quoteGenerationPackage(tier, 'complete');
      const aura = quoteGenerationPackage(tier, 'aura');
      expect(fight.compatibleModes).toEqual(['fight', 'rush']);
      expect(aura.compatibleModes).toEqual(['aura']);
      for (const quote of [fight, aura]) {
        expect(quote.compatibleModes).toEqual(modes.filter((mode) => (
          isAnimationNameSetReadyForMode(quote.animations, mode)
        )));
      }
    }
  });

  it('keeps existing complete prices and derives smaller Aura prices from planned work', () => {
    const tiers = ['rookie', 'contender', 'champion'] as const;
    expect(tiers.map((tier) => quoteGenerationPackage(tier, 'complete').creditCost)).toEqual([2, 11, 18]);
    expect(tiers.map((tier) => quoteGenerationPackage(tier, 'aura').creditCost)).toEqual([2, 6, 10]);
    for (const tier of ['rookie', 'contender', 'champion'] as const) {
      for (const pack of ['aura', 'complete'] as const) {
        const quote = quoteGenerationPackage(tier, pack);
        expect(quote.creditCost * GENERATION_NET_EUR_PER_CREDIT / quote.estimatedUsdCost).toBeGreaterThanOrEqual(GENERATION_COST_COVERAGE);
      }
    }
  });

  it('generates the exact six required Aura performances and preserves prone framing', () => {
    expect(AURA_GENERATION_ANIMATIONS.map((animation) => animation.name)).toEqual(AURA_ANIMATION_NAMES);
    expect(getAnimationList('aura').map((animation) => animation.name)).toEqual(AURA_ANIMATION_NAMES);
    for (const animation of getAnimationList('aura')) {
      expect(computeRequestedSpriteGrid(animation.name, animation.frames)).toEqual({ cols: 3, rows: 2 });
    }
    const mirrored = new Set(['high_punch', 'low_punch', 'high_kick', 'low_kick']);
    const actualUniqueFrames = getAnimationList('complete').reduce((total, animation) => total
      + (mirrored.has(animation.name) ? Math.ceil(animation.frames / 2) : animation.frames), 0);
    expect(quoteGenerationPackage('champion', 'complete').uniqueFrames).toBe(actualUniqueFrames);
    expect(getAnimationProfile('aura_floor_worm').targetHeightRatio).toBeLessThan(getAnimationProfile('aura_unbothered').targetHeightRatio);
    expect(() => assertPackageAnimationFrameCount('aura_floor_worm', 6)).not.toThrow();
    expect(() => assertPackageAnimationFrameCount('aura_floor_worm', 5)).toThrow('six complete unique frames');
  });

  it('binds expansion to missing animations, excludes sources and rejects widening or malformed plans', () => {
    expect(parseGenerationPackage('cheaper')).toBeNull();
    expect(parseGenerationPackage(undefined)).toBe('complete');
    const full = quoteGenerationPackage('champion', 'complete');
    const missing = quoteGenerationPackage('champion', 'complete', { expansion: true, existingAnimations: full.animations.filter((name) => name !== 'walk') });
    expect(missing.animations).toEqual(['walk']);
    expect(missing.creditCost).toBeLessThan(full.creditCost);
    expect(quoteGenerationPackage('champion', 'aura', { expansion: true, existingAnimations: AURA_ANIMATION_NAMES }).creditCost).toBe(0);
  });
});
