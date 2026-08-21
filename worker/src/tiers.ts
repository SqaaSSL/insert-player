import type { QualityTier } from './types';

export interface TierDefinition {
  id: QualityTier;
  label: string;
  creditCost: number;
  animationRetryCreditCost: number;
  estimatedUsdCost: number;
  pipeline: 'sheet' | 'sheet_refined';
  model: 'flash' | 'pro';
  animationBgRemoval: 'chroma' | 'birefnet';
}

export type GenerationBillingOperation =
  | 'fighter_generation'
  | 'fighter_upgrade'
  | 'fighter_retry_animation'
  | 'fighter_retry_source';

export const SOURCE_RETRY_CREDIT_COST = 1;

export const TIER_ORDER: QualityTier[] = ['rookie', 'contender', 'champion'];

export const TIER_DEFINITIONS: Record<QualityTier, TierDefinition> = {
  rookie: {
    id: 'rookie',
    label: 'Rookie',
    creditCost: 2,
    animationRetryCreditCost: 1,
    estimatedUsdCost: 1.43,
    pipeline: 'sheet',
    model: 'flash',
    animationBgRemoval: 'chroma',
  },
  contender: {
    id: 'contender',
    label: 'Contender',
    creditCost: 11,
    animationRetryCreditCost: 2,
    estimatedUsdCost: 7.88,
    pipeline: 'sheet_refined',
    model: 'flash',
    animationBgRemoval: 'birefnet',
  },
  champion: {
    id: 'champion',
    label: 'Champion',
    creditCost: 18,
    animationRetryCreditCost: 4,
    estimatedUsdCost: 12.64,
    pipeline: 'sheet_refined',
    model: 'pro',
    animationBgRemoval: 'birefnet',
  },
};

export function isQualityTier(value: unknown): value is QualityTier {
  return value === 'rookie' || value === 'contender' || value === 'champion';
}

export function normalizeQualityTier(value: unknown, fallback: QualityTier = 'contender'): QualityTier {
  return isQualityTier(value) ? value : fallback;
}

export function maxTier(a: QualityTier, b: QualityTier): QualityTier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

export function normalizeGenerationBillingOperation(
  value: unknown,
  legacyReason?: string | null,
): GenerationBillingOperation {
  if (value === 'fighter_generation') return value;
  if (value === 'fighter_upgrade') return value;
  if (value === 'fighter_retry_animation') return value;
  if (value === 'fighter_retry_source') return value;

  if (legacyReason === 'fighter_upgrade') return 'fighter_upgrade';
  if (legacyReason?.includes('retry_source') || legacyReason?.includes('retry_side') ||
      legacyReason?.includes('retry_upright') || legacyReason?.includes('retry_crouch')) {
    return 'fighter_retry_source';
  }
  if (legacyReason?.includes('retry')) return 'fighter_retry_animation';
  return 'fighter_generation';
}

export function generationCreditCost(
  tier: QualityTier,
  operation: GenerationBillingOperation,
): number {
  if (operation === 'fighter_retry_source') return SOURCE_RETRY_CREDIT_COST;
  if (operation === 'fighter_retry_animation') {
    return TIER_DEFINITIONS[tier].animationRetryCreditCost;
  }
  return TIER_DEFINITIONS[tier].creditCost;
}
