export const PLAYABLE_ANIMATION_NAMES = [
  'idle',
  'walk',
  'high_punch',
  'high_kick',
  'low_punch',
  'low_kick',
  'jump',
  'crouch',
  'hit',
  'ko',
  'victory',
] as const;

export type PlayableAnimationName = typeof PLAYABLE_ANIMATION_NAMES[number];

export interface FighterPlayabilityIdentity {
  name?: string | null;
  characterName?: string | null;
  arcadeSlug?: string | null;
  photoHash?: string | null;
}

const TEMPLATE_ZERO_IDENTITY = /(?:^|[^a-z0-9])template[\s_-]*zero(?:$|[^a-z0-9])/i;

/**
 * Template Zero is pose infrastructure, never a user-facing fighter. Keep the
 * guard at the shared playability boundary so stale offline caches cannot turn
 * an internal generation reference into a selectable character.
 */
export function isTemplateOnlyFighterIdentity(identity: FighterPlayabilityIdentity): boolean {
  return [
    identity.name,
    identity.characterName,
    identity.arcadeSlug,
    identity.photoHash,
  ].some((value) => typeof value === 'string' && TEMPLATE_ZERO_IDENTITY.test(value));
}

interface PlayableSpriteAsset {
  animationName: string;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  pngBlob?: Blob | null;
  url?: string | null;
}

const PLAYABLE_ANIMATION_SET = new Set<string>(PLAYABLE_ANIMATION_NAMES);

function hasUsablePayload(asset: PlayableSpriteAsset): boolean {
  if ('pngBlob' in asset) return asset.pngBlob instanceof Blob && asset.pngBlob.size > 0;
  if ('url' in asset) return typeof asset.url === 'string' && asset.url.trim().length > 0;
  return true;
}

export function playableAnimationNames(
  assets: ReadonlyArray<Pick<PlayableSpriteAsset, 'animationName'>>,
): Set<string> {
  return new Set(
    assets
      .map((asset) => asset.animationName.trim())
      .filter((name) => PLAYABLE_ANIMATION_SET.has(name)),
  );
}

export function missingPlayableAnimationNames(
  assets: ReadonlyArray<Pick<PlayableSpriteAsset, 'animationName'>>,
): PlayableAnimationName[] {
  const available = playableAnimationNames(assets);
  return PLAYABLE_ANIMATION_NAMES.filter((name) => !available.has(name));
}

export function invalidPlayableAnimationNames(
  assets: ReadonlyArray<PlayableSpriteAsset>,
): PlayableAnimationName[] {
  const invalid = new Set<PlayableAnimationName>();
  for (const asset of assets) {
    if (!PLAYABLE_ANIMATION_SET.has(asset.animationName)) continue;
    if (
      !Number.isFinite(asset.frameWidth) || asset.frameWidth <= 0 ||
      !Number.isFinite(asset.frameHeight) || asset.frameHeight <= 0 ||
      !Number.isFinite(asset.frameCount) || asset.frameCount <= 0 ||
      !hasUsablePayload(asset)
    ) {
      invalid.add(asset.animationName as PlayableAnimationName);
    }
  }
  return PLAYABLE_ANIMATION_NAMES.filter((name) => invalid.has(name));
}

export function isCompletePlayableSpriteSet(
  assets: ReadonlyArray<PlayableSpriteAsset>,
): boolean {
  return missingPlayableAnimationNames(assets).length === 0 &&
    invalidPlayableAnimationNames(assets).length === 0;
}

export function assertCompletePlayableSpriteSet(
  assets: ReadonlyArray<PlayableSpriteAsset>,
  fighterName: string,
): void {
  const missing = missingPlayableAnimationNames(assets);
  const invalid = invalidPlayableAnimationNames(assets);
  if (missing.length === 0 && invalid.length === 0) return;

  const details = [
    missing.length > 0 ? `missing ${missing.join(', ')}` : null,
    invalid.length > 0 ? `invalid ${invalid.join(', ')}` : null,
  ].filter((value): value is string => Boolean(value));
  throw new Error(
    `${fighterName} is not ready to play (${details.join('; ')}). Retry the sprite download.`,
  );
}
