import type { QualityTier } from './types';

export const FIGHT_ASSET_PACK_ID = 'fight-v1' as const;
export const AURA_ASSET_PACK_ID = 'aura-v1-2026' as const;

export const FIGHT_ANIMATION_NAMES = [
  'idle',
  'walk',
  'high_punch',
  'low_punch',
  'high_kick',
  'low_kick',
  'jump',
  'crouch',
  'hit',
  'ko',
  'victory',
] as const;

export const AURA_ANIMATION_NAMES = [
  'aura_unbothered',
  'aura_six_seven',
  'aura_mog_check',
  'aura_glide',
  'aura_floor_worm',
  'aura_one_leg',
] as const;

export const AURA_OPTIONAL_ANIMATION_NAMES = [
  'aura_shrug',
] as const;

export const GENERATED_ANIMATION_NAMES = new Set<string>([
  ...FIGHT_ANIMATION_NAMES,
  ...AURA_ANIMATION_NAMES,
  ...AURA_OPTIONAL_ANIMATION_NAMES,
]);

export type FighterAssetPackId = typeof FIGHT_ASSET_PACK_ID | typeof AURA_ASSET_PACK_ID;

interface WorkerSpriteAssetLike {
  animation_name: string;
  quality_tier: QualityTier;
  blob_key?: string | null;
  content_hash?: string | null;
  frame_w: number;
  frame_h: number;
  frame_count: number;
}

export interface WorkerFighterAssetPackSummary {
  id: FighterAssetPackId;
  status: 'ready' | 'partial';
  qualityTier: QualityTier | null;
  animationsReady: string[];
}

const PACK_ANIMATIONS: Readonly<Record<FighterAssetPackId, readonly string[]>> = {
  [FIGHT_ASSET_PACK_ID]: FIGHT_ANIMATION_NAMES,
  [AURA_ASSET_PACK_ID]: AURA_ANIMATION_NAMES,
};

const TIER_RANK: Record<QualityTier, number> = {
  rookie: 1,
  contender: 2,
  champion: 3,
};

function usableSprite(sprite: WorkerSpriteAssetLike): boolean {
  return Boolean(sprite.blob_key)
    && typeof sprite.content_hash === 'string'
    && /^[a-f0-9]{64}$/i.test(sprite.content_hash)
    && Number.isInteger(sprite.frame_w) && sprite.frame_w > 0
    && Number.isInteger(sprite.frame_h) && sprite.frame_h > 0
    && Number.isInteger(sprite.frame_count) && sprite.frame_count > 0;
}

export function summarizeFighterAssetPacks(
  sprites: readonly WorkerSpriteAssetLike[],
): WorkerFighterAssetPackSummary[] {
  return (Object.entries(PACK_ANIMATIONS) as Array<[FighterAssetPackId, readonly string[]]>).flatMap(
    ([id, required]) => {
      const bestByAnimation = new Map<string, WorkerSpriteAssetLike>();
      for (const sprite of sprites) {
        if (!required.includes(sprite.animation_name) || !usableSprite(sprite)) continue;
        const current = bestByAnimation.get(sprite.animation_name);
        if (!current || TIER_RANK[sprite.quality_tier] > TIER_RANK[current.quality_tier]) {
          bestByAnimation.set(sprite.animation_name, sprite);
        }
      }
      if (bestByAnimation.size === 0) return [];
      const animationsReady = required.filter((name) => bestByAnimation.has(name));
      const tiers = animationsReady.map((name) => bestByAnimation.get(name)!.quality_tier);
      const qualityTier = tiers.reduce<QualityTier | null>((lowest, tier) => (
        !lowest || TIER_RANK[tier] < TIER_RANK[lowest] ? tier : lowest
      ), null);
      return [{
        id,
        status: animationsReady.length === required.length ? 'ready' as const : 'partial' as const,
        qualityTier,
        animationsReady,
      }];
    },
  );
}

export function hasCompleteFighterAssetPack(sprites: readonly WorkerSpriteAssetLike[]): boolean {
  return summarizeFighterAssetPacks(sprites).some((pack) => pack.status === 'ready');
}
