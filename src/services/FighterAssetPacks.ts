import {
  PLAYABLE_ANIMATION_NAMES,
  type PlayableAnimationName,
} from './PlayableFighterAssets.ts';

export const FIGHT_ASSET_PACK_ID = 'fight-v1' as const;
export const AURA_ASSET_PACK_ID = 'aura-v1-2026' as const;

/**
 * Aura packs are seasonal on purpose: meme language moves much faster than
 * the combat contract. A future pack can coexist with this one without
 * invalidating a fighter somebody already paid for.
 */
export const AURA_ANIMATION_NAMES = [
  'aura_unbothered',
  'aura_six_seven',
  'aura_mog_check',
  'aura_glide',
  'aura_floor_worm',
  'aura_one_leg',
] as const;

/**
 * Reactions enrich a performance when present, but never increase the paid
 * pack's completeness requirement. This keeps seasonal flavour additive.
 */
export const AURA_OPTIONAL_ANIMATION_NAMES = [
  'aura_shrug',
] as const;

export const AURA_LOADABLE_ANIMATION_NAMES = [
  ...AURA_ANIMATION_NAMES,
  ...AURA_OPTIONAL_ANIMATION_NAMES,
] as const;

export type AuraPackAnimationName = typeof AURA_ANIMATION_NAMES[number];
export type AuraOptionalAnimationName = typeof AURA_OPTIONAL_ANIMATION_NAMES[number];
export type AuraAnimationName = typeof AURA_LOADABLE_ANIMATION_NAMES[number];
export type FighterAssetPackId = typeof FIGHT_ASSET_PACK_ID | typeof AURA_ASSET_PACK_ID;
export type FighterGameMode = 'fight' | 'rush' | 'aura';
export type FighterModeReadinessKind = 'custom' | 'legacy' | 'unavailable';

export interface AssetPackSprite {
  animationName: string;
  qualityTier?: 'rookie' | 'contender' | 'champion' | null;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  pngBlob?: Blob | null;
  url?: string | null;
}

export interface FighterAssetPackReadiness {
  packId: FighterAssetPackId;
  complete: boolean;
  qualityTier: AssetPackSprite['qualityTier'];
  missingAnimations: string[];
  invalidAnimations: string[];
}

export interface FighterModeReadiness {
  mode: FighterGameMode;
  kind: FighterModeReadinessKind;
  /** The pack supplying the presentation when this fighter is playable. */
  activePackId: FighterAssetPackId | null;
  missingAnimations: string[];
  invalidAnimations: string[];
}

const PACK_ANIMATIONS: Readonly<Record<FighterAssetPackId, readonly string[]>> = {
  [FIGHT_ASSET_PACK_ID]: PLAYABLE_ANIMATION_NAMES,
  [AURA_ASSET_PACK_ID]: AURA_ANIMATION_NAMES,
};

const QUALITY_TIER_RANK = {
  rookie: 1,
  contender: 2,
  champion: 3,
} as const;

function hasUsablePayload(asset: AssetPackSprite): boolean {
  if (asset.pngBlob instanceof Blob) return asset.pngBlob.size > 0;
  if (typeof asset.url === 'string') return asset.url.trim().length > 0;
  if ('pngBlob' in asset || 'url' in asset) return false;
  return true;
}

function hasUsablePlaybackMetadata(asset: AssetPackSprite): boolean {
  return Number.isFinite(asset.frameWidth) && asset.frameWidth > 0
    && Number.isFinite(asset.frameHeight) && asset.frameHeight > 0
    && Number.isFinite(asset.frameCount) && asset.frameCount > 0
    && hasUsablePayload(asset);
}

function weakestReadyTier(
  assets: ReadonlyArray<AssetPackSprite>,
  requiredAnimations: readonly string[],
): AssetPackSprite['qualityTier'] {
  const required = new Set(requiredAnimations);
  const bestByAnimation = new Map<string, NonNullable<AssetPackSprite['qualityTier']>>();
  for (const asset of assets) {
    if (!required.has(asset.animationName) || !asset.qualityTier || !hasUsablePlaybackMetadata(asset)) continue;
    const current = bestByAnimation.get(asset.animationName);
    if (!current || QUALITY_TIER_RANK[asset.qualityTier] > QUALITY_TIER_RANK[current]) {
      bestByAnimation.set(asset.animationName, asset.qualityTier);
    }
  }
  return Array.from(bestByAnimation.values()).reduce<AssetPackSprite['qualityTier']>((weakest, tier) => (
    !weakest || QUALITY_TIER_RANK[tier] < QUALITY_TIER_RANK[weakest] ? tier : weakest
  ), null);
}

export function assetPackAnimationNames(packId: FighterAssetPackId): readonly string[] {
  return PACK_ANIMATIONS[packId];
}

export function missingAssetPackAnimationNames(
  assets: ReadonlyArray<Pick<AssetPackSprite, 'animationName'>>,
  packId: FighterAssetPackId,
): string[] {
  const available = new Set(assets.map((asset) => asset.animationName.trim()));
  return PACK_ANIMATIONS[packId].filter((name) => !available.has(name));
}

export function invalidAssetPackAnimationNames(
  assets: ReadonlyArray<AssetPackSprite>,
  packId: FighterAssetPackId,
): string[] {
  const required = new Set(PACK_ANIMATIONS[packId]);
  const seen = new Set<string>();
  const usable = new Set<string>();
  for (const asset of assets) {
    if (!required.has(asset.animationName)) continue;
    seen.add(asset.animationName);
    if (hasUsablePlaybackMetadata(asset)) usable.add(asset.animationName);
  }
  return PACK_ANIMATIONS[packId].filter((name) => seen.has(name) && !usable.has(name));
}

export function fighterAssetPackReadiness(
  assets: ReadonlyArray<AssetPackSprite>,
  packId: FighterAssetPackId,
): FighterAssetPackReadiness {
  const missingAnimations = missingAssetPackAnimationNames(assets, packId);
  const invalidAnimations = invalidAssetPackAnimationNames(assets, packId);
  return {
    packId,
    complete: missingAnimations.length === 0 && invalidAnimations.length === 0,
    qualityTier: weakestReadyTier(assets, PACK_ANIMATIONS[packId]),
    missingAnimations,
    invalidAnimations,
  };
}

export function inferFighterAssetPacks(
  assets: ReadonlyArray<AssetPackSprite>,
): FighterAssetPackReadiness[] {
  return [
    fighterAssetPackReadiness(assets, FIGHT_ASSET_PACK_ID),
    fighterAssetPackReadiness(assets, AURA_ASSET_PACK_ID),
  ];
}

/**
 * Fight and Rush share the combat pack. Aura prefers its dedicated
 * performance pack but deliberately falls back to the legacy combat set so
 * every existing fighter keeps working on launch day.
 */
export function resolveFighterModeReadiness(
  assets: ReadonlyArray<AssetPackSprite>,
  mode: FighterGameMode,
): FighterModeReadiness {
  const fight = fighterAssetPackReadiness(assets, FIGHT_ASSET_PACK_ID);
  if (mode === 'fight' || mode === 'rush') {
    return {
      mode,
      kind: fight.complete ? 'custom' : 'unavailable',
      activePackId: fight.complete ? FIGHT_ASSET_PACK_ID : null,
      missingAnimations: fight.missingAnimations,
      invalidAnimations: fight.invalidAnimations,
    };
  }

  const aura = fighterAssetPackReadiness(assets, AURA_ASSET_PACK_ID);
  if (aura.complete) {
    return {
      mode,
      kind: 'custom',
      activePackId: AURA_ASSET_PACK_ID,
      missingAnimations: [],
      invalidAnimations: [],
    };
  }
  if (fight.complete) {
    return {
      mode,
      kind: 'legacy',
      activePackId: FIGHT_ASSET_PACK_ID,
      missingAnimations: [],
      invalidAnimations: [],
    };
  }
  return {
    mode,
    kind: 'unavailable',
    activePackId: null,
    missingAnimations: aura.missingAnimations,
    invalidAnimations: aura.invalidAnimations,
  };
}

export function assertFighterReadyForMode(
  assets: ReadonlyArray<AssetPackSprite>,
  fighterName: string,
  mode: FighterGameMode,
): FighterModeReadiness {
  const readiness = resolveFighterModeReadiness(assets, mode);
  if (readiness.kind !== 'unavailable') return readiness;

  const details = [
    readiness.missingAnimations.length > 0
      ? `missing ${readiness.missingAnimations.join(', ')}`
      : null,
    readiness.invalidAnimations.length > 0
      ? `invalid ${readiness.invalidAnimations.join(', ')}`
      : null,
  ].filter((value): value is string => Boolean(value));
  throw new Error(
    `${fighterName} is not ready for ${mode.toUpperCase()} (${details.join('; ')}). Download or generate the required animation pack.`,
  );
}

export function isAuraAnimationName(value: string): value is AuraAnimationName {
  return (AURA_LOADABLE_ANIMATION_NAMES as readonly string[]).includes(value);
}

export function isFightAnimationName(value: string): value is PlayableAnimationName {
  return (PLAYABLE_ANIMATION_NAMES as readonly string[]).includes(value);
}

export function isAnimationNameSetReadyForMode(
  animationNames: Iterable<string>,
  mode: FighterGameMode,
): boolean {
  const available = new Set(animationNames);
  const hasPack = (packId: FighterAssetPackId) => (
    PACK_ANIMATIONS[packId].every((name) => available.has(name))
  );
  if (mode === 'fight' || mode === 'rush') return hasPack(FIGHT_ASSET_PACK_ID);
  return hasPack(AURA_ASSET_PACK_ID) || hasPack(FIGHT_ASSET_PACK_ID);
}

export function fighterModeCompatibilityLabel(animationNames: Iterable<string>): string {
  const available = new Set(animationNames);
  const hasFight = PACK_ANIMATIONS[FIGHT_ASSET_PACK_ID].every((name) => available.has(name));
  const hasAura = PACK_ANIMATIONS[AURA_ASSET_PACK_ID].every((name) => available.has(name));
  if (hasFight && hasAura) return 'Fight · Rush · Aura';
  if (hasFight) return 'Fight · Rush · Aura legacy';
  if (hasAura) return 'Aura only';
  return 'Incomplete';
}
