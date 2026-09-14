import { describe, expect, it } from 'vitest';
import { animationRetryQuote } from './generationRetry';
import type { QualityTier } from '../../services/QualityTiers';

describe('animation retry quotes for mixed-quality characters', () => {
  const sprites: { animationName: string; qualityTier: QualityTier }[] = [
    { animationName: 'aura_glide', qualityTier: 'champion' },
    { animationName: 'walk', qualityTier: 'contender' },
    { animationName: 'idle', qualityTier: 'rookie' },
  ];

  it('quotes each saved animation instead of the highest fighter quality', () => {
    expect(animationRetryQuote('walk', sprites, 'champion')).toEqual({ tier: 'contender', credits: 2 });
    expect(animationRetryQuote('idle', sprites, 'champion')).toEqual({ tier: 'rookie', credits: 1 });
    expect(animationRetryQuote('aura_glide', sprites, 'champion')).toEqual({ tier: 'champion', credits: 4 });
  });

  it('keeps the confirmed quote stable when an asset changes while confirmation is open', () => {
    const mutable = [{ animationName: 'walk', qualityTier: 'contender' as QualityTier }];
    const confirmed = animationRetryQuote('walk', mutable, 'champion');
    mutable[0].qualityTier = 'champion';
    expect(confirmed).toEqual({ tier: 'contender', credits: 2 });
    expect(animationRetryQuote('walk', mutable, 'champion')).toEqual({ tier: 'champion', credits: 4 });
  });

  it('uses the fighter quality for an animation that has not been generated yet', () => {
    expect(animationRetryQuote('aura_shrug', sprites, 'contender')).toEqual({ tier: 'contender', credits: 2 });
  });
});
