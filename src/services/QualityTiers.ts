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

export const QUALITY_TIERS: QualityTierInfo[] = [
  {
    id: 'rookie',
    label: 'Rookie',
    priceLabel: '2 credits',
    creditCost: 2,
    animationRetryCreditCost: 1,
    estimatedTime: '~2 min',
    pitch: 'A quick playable fighter, ready for your first match.',
  },
  {
    id: 'contender',
    label: 'Contender',
    priceLabel: '11 credits',
    creditCost: 11,
    animationRetryCreditCost: 2,
    estimatedTime: '~8 min',
    pitch: 'Refined movement with cleaner edges and more consistent frames.',
  },
  {
    id: 'champion',
    label: 'Champion',
    priceLabel: '18 credits',
    creditCost: 18,
    animationRetryCreditCost: 4,
    estimatedTime: '~12 min',
    pitch: 'Maximum detail and consistency across every move.',
  },
];

export const SOURCE_RETRY_CREDIT_COST = 1;

export function animationRetryCreditCost(tier: QualityTier): number {
  return QUALITY_TIERS.find((definition) => definition.id === tier)?.animationRetryCreditCost ?? 1;
}

export function isQualityTier(value: unknown): value is QualityTier {
  return value === 'rookie' || value === 'contender' || value === 'champion';
}
