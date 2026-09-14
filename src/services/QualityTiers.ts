export type QualityTier = 'rookie' | 'contender' | 'champion';
export type GenerationBillingOperation =
  | 'fighter_generation'
  | 'fighter_upgrade'
  | 'fighter_retry_animation'
  | 'fighter_retry_source';

export interface QualityTierInfo {
  id: QualityTier;
  label: string;
  priceLabel: string;
  creditCost: number;
  animationRetryCreditCost: number;
  estimatedTime: string;
  pitch: string;
}

/** Historical IDs remain stable so purchased assets, jobs and retry quotes retain their provenance. */
export const LEGACY_QUALITY_TIERS: QualityTierInfo[] = [
  {
    id: 'rookie',
    label: 'Rookie',
    priceLabel: '2 credits',
    creditCost: 2,
    animationRetryCreditCost: 1,
    estimatedTime: '~2 min',
    pitch: 'Basic-resolution animation. A quick way to make yourself playable.',
  },
  {
    id: 'contender',
    label: 'Champion',
    priceLabel: '11 credits',
    creditCost: 11,
    animationRetryCreditCost: 2,
    estimatedTime: '~8 min',
    pitch: 'Frames refined individually for sharper detail and cleaner edges.',
  },
  {
    id: 'champion',
    label: 'Champion',
    priceLabel: '18 credits',
    creditCost: 18,
    animationRetryCreditCost: 4,
    estimatedTime: '~12 min',
    pitch: 'An earlier premium version. Your generated assets remain available.',
  },
];

/** Two offers: the former Contender is now the single Champion offer. */
export const QUALITY_TIERS = LEGACY_QUALITY_TIERS.filter((tier) => tier.id !== 'champion');

export function qualityTierInfo(tier: QualityTier): QualityTierInfo {
  return LEGACY_QUALITY_TIERS.find((definition) => definition.id === tier)!;
}

export function qualityTierRank(tier: QualityTier): number {
  return tier === 'rookie' ? 0 : 1;
}

/** Normalize a new purchase choice, never a persisted asset or running job. */
export function offeredQualityTier(tier: QualityTier): 'rookie' | 'contender' {
  return tier === 'rookie' ? 'rookie' : 'contender';
}

export const SOURCE_RETRY_CREDIT_COST = 1;

export function animationRetryCreditCost(tier: QualityTier): number {
  return qualityTierInfo(tier).animationRetryCreditCost;
}

export function isQualityTier(value: unknown): value is QualityTier {
  return value === 'rookie' || value === 'contender' || value === 'champion';
}
