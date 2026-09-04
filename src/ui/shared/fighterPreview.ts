import type { CachedMeta } from '../../services/SpriteCache.ts';
import type { CloudFighter } from '../../services/CloudFighters.ts';
import { QUALITY_TIERS } from '../../services/QualityTiers.ts';
import type { SpriteAnimationFormat } from '../../SpriteAnimationFormat.ts';

/**
 * Single source of truth for user-facing tier names. Accepts both typed
 * QualityTier ids and raw strings from cloud payloads; unknown values are
 * title-cased rather than hidden.
 */
export function tierLabel(tier: string | null | undefined, fallback = 'Contender'): string {
  if (!tier) return fallback;
  const known = QUALITY_TIERS.find((item) => item.id === tier)?.label;
  return known ?? tier.charAt(0).toUpperCase() + tier.slice(1);
}

/**
 * Preview image for a cloud fighter. Published fighters never expose the
 * original photo, so the clean generated views lead and `original` is only a
 * private-owner fallback.
 */
export function cloudPreviewUrl(fighter: CloudFighter): string | null {
  return (
    fighter.sources.side ??
    fighter.sources.upright ??
    fighter.sources.crouch ??
    fighter.sources.original ??
    null
  );
}

export const ANIM_LABELS: Record<string, string> = {
  idle: 'IDLE',
  walk: 'WALK',
  high_punch: 'PUNCH',
  low_punch: 'C.PUNCH',
  high_kick: 'KICK',
  low_kick: 'C.KICK',
  jump: 'JUMP',
  crouch: 'CROUCH',
  hit: 'HIT',
  ko: 'K.O.',
  victory: 'WIN',
  aura_unbothered: 'UNBOTHERED',
  aura_six_seven: '6-7',
  aura_mog_check: 'MOG CHECK',
  aura_glide: 'GLIDE',
  aura_floor_worm: 'FLOOR WORM',
  aura_one_leg: 'ONE-LEG HOP',
  aura_shrug: 'SHRUG',
};

export function animLabel(name: string): string {
  return ANIM_LABELS[name] ?? name.toUpperCase();
}

export type SourceKey = 'original' | 'side' | 'upright' | 'crouch';

export const SOURCE_VIEWS: ReadonlyArray<readonly [SourceKey, string]> = [
  ['original', 'Original'],
  ['side', 'Side View'],
  ['upright', 'Upright'],
  ['crouch', 'Crouch'],
];

export type PreviewSelection =
  | { kind: 'source'; source: SourceKey }
  | { kind: 'animation'; animationName: string };

export function isArcadeCachedMeta(meta: Pick<CachedMeta, 'photoHash'> | null): boolean {
  return meta?.photoHash.startsWith('arcade:') ?? false;
}

export function defaultSourceForMeta(meta: Pick<CachedMeta, 'photoHash'> | null): SourceKey {
  return isArcadeCachedMeta(meta) ? 'side' : 'original';
}

export interface PreviewSpriteLike {
  blob: Blob;
  rawBlob?: Blob;
  animationName?: string;
  animationFormat?: SpriteAnimationFormat;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  rawFrameWidth?: number;
  rawFrameHeight?: number;
  rawFrameCount?: number;
  failed?: boolean;
  reason?: string;
}

export function getSourceBlob(meta: CachedMeta | null, source: SourceKey): Blob | null {
  if (!meta) return null;
  switch (source) {
    case 'original':
      return meta.originalPhotoBlob;
    case 'side':
      return meta.sideViewBlob;
    case 'upright':
      return meta.uprightViewBlob;
    case 'crouch':
      return meta.crouchViewBlob;
  }
}
