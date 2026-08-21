import { describe, expect, it } from 'vitest';
import {
  generationCreditCost,
  normalizeGenerationBillingOperation,
  SOURCE_RETRY_CREDIT_COST,
  TIER_DEFINITIONS,
} from './tiers';

describe('generation pricing contract', () => {
  it('keeps full generation and animation retry pricing explicit per tier', () => {
    expect(TIER_DEFINITIONS.rookie).toMatchObject({
      creditCost: 2,
      animationRetryCreditCost: 1,
      estimatedUsdCost: 1.43,
    });
    expect(TIER_DEFINITIONS.contender).toMatchObject({
      creditCost: 11,
      animationRetryCreditCost: 2,
      estimatedUsdCost: 7.88,
    });
    expect(TIER_DEFINITIONS.champion).toMatchObject({
      creditCost: 18,
      animationRetryCreditCost: 4,
      estimatedUsdCost: 12.64,
    });
  });

  it('charges by operation instead of treating every retry as a full fighter', () => {
    expect(generationCreditCost('champion', 'fighter_generation')).toBe(18);
    expect(generationCreditCost('champion', 'fighter_upgrade')).toBe(18);
    expect(generationCreditCost('champion', 'fighter_retry_animation')).toBe(4);
    expect(generationCreditCost('champion', 'fighter_retry_source')).toBe(SOURCE_RETRY_CREDIT_COST);
  });

  it('normalizes legacy retry reasons without undercharging full generation', () => {
    expect(normalizeGenerationBillingOperation(undefined, 'retry_idle')).toBe('fighter_retry_animation');
    expect(normalizeGenerationBillingOperation(undefined, 'retry_source_side')).toBe('fighter_retry_source');
    expect(normalizeGenerationBillingOperation(undefined, 'fighter_upgrade')).toBe('fighter_upgrade');
    expect(normalizeGenerationBillingOperation(undefined, 'unexpected')).toBe('fighter_generation');
  });
});
