import { describe, expect, it } from 'vitest';
import { animationRetryCreditCost, isQualityTier, offeredQualityTier, QUALITY_TIERS, qualityTierInfo, qualityTierRank } from './QualityTiers';
import { quoteGenerationPackage } from './GenerationPackages';

describe('two public quality levels with preserved purchased versions', () => {
  it('offers Rookie and the former Contender as Champion without changing their quotes', () => {
    expect(QUALITY_TIERS.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'rookie', label: 'Rookie' }, { id: 'contender', label: 'Champion' },
    ]);
    expect(QUALITY_TIERS.map(({ id }) => quoteGenerationPackage(id, 'aura').creditCost)).toEqual([2, 6]);
    expect(QUALITY_TIERS.map(({ id }) => quoteGenerationPackage(id, 'complete').creditCost)).toEqual([2, 11]);
  });

  it('still recognizes legacy jobs and uses their original maintenance prices', () => {
    expect(isQualityTier('champion')).toBe(true);
    expect(qualityTierInfo('champion').creditCost).toBe(18);
    expect(animationRetryCreditCost('champion')).toBe(4);
    expect(animationRetryCreditCost('contender')).toBe(2);
  });

  it('does not sell another upgrade or a downgrade to either refined version', () => {
    for (const existing of ['contender', 'champion'] as const) {
      expect(QUALITY_TIERS.filter((tier) => qualityTierRank(tier.id) > qualityTierRank(existing))).toEqual([]);
      expect(offeredQualityTier(existing)).toBe('contender');
    }
    expect(offeredQualityTier('rookie')).toBe('rookie');
  });
});
