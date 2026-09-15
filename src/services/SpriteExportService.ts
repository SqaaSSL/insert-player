import { normalizeSpriteAnimationFormat } from '../SpriteAnimationFormat.ts';
import {
  ApiSessionChangedError,
  assertApiRequestContextCurrent,
  captureApiRequestContext,
  type ApiRequestContext,
} from './ApiClient.ts';
import {
  arcadeFighterPhotoHash,
  downloadArcadeSpriteHighDensityToLocal,
  downloadCloudSpriteHighDensityToLocal,
  selectPlayableCloudSprites,
  type CloudFighter,
  type CloudSprite,
} from './CloudFighters.ts';
import {
  getActiveSpriteCacheScope,
  getAllSpritesForHash,
  type CachedSprite,
} from './SpriteCache.ts';
import { getBestCachedSpriteSheet } from './SpriteSheetSource.ts';

const pendingExports = new Map<string, Promise<CachedSprite>>();

function positiveInteger(value: number | null | undefined): boolean {
  return Number.isSafeInteger(value) && (value ?? 0) > 0;
}

function matchesCurrentSprite(sprite: CachedSprite, remote: CloudSprite): boolean {
  if (
    sprite.animationName !== remote.animationName ||
    sprite.qualityTier !== remote.qualityTier ||
    sprite.frameWidth !== remote.frameWidth ||
    sprite.frameHeight !== remote.frameHeight ||
    sprite.frameCount !== remote.frameCount ||
    (sprite.processingVersion ?? 0) !== remote.processingVersion ||
    normalizeSpriteAnimationFormat(sprite.animationFormat) !== normalizeSpriteAnimationFormat(remote.animationFormat)
  ) return false;

  // Current sprite IDs can remain stable during a reviewed promotion. A new
  // content hash must never be combined with an older version's cached HQ.
  if (sprite.contentHash && remote.contentHash) {
    return sprite.contentHash.toLowerCase() === remote.contentHash.toLowerCase();
  }
  return Boolean(remote.id && remote.id === sprite.versionId);
}

function hasAdvertisedQuality(sprite: CachedSprite, remote: CloudSprite): boolean {
  const source = getBestCachedSpriteSheet(sprite);
  if (source.frameWidth < remote.hqFrameWidth! || source.frameHeight < remote.hqFrameHeight!) {
    return false;
  }
  return !source.highDensity || (
    source.frameCount === remote.hqFrameCount &&
    (!remote.rawContentHash || sprite.rawContentHash === remote.rawContentHash)
  );
}

/** Resolve the selected playable animation's best clean source before saving. */
export async function prepareSpriteForExport(
  sprite: CachedSprite,
  fighter?: CloudFighter,
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<CachedSprite> {
  const ownerScope = getActiveSpriteCacheScope();
  const assertCurrent = () => {
    assertApiRequestContextCurrent(context);
    if (
      getActiveSpriteCacheScope() !== ownerScope ||
      (sprite.ownerScope !== undefined && sprite.ownerScope !== ownerScope)
    ) throw new ApiSessionChangedError();
  };
  assertCurrent();

  if (!fighter) return sprite;
  const arcade = Boolean(fighter.arcade);
  // Public community manifests intentionally have no private source assets.
  if (!arcade && !fighter.photoHash && !fighter.sprites.some((candidate) => candidate.rawUrl)) return sprite;
  if (
    arcade
      ? !fighter.public || arcadeFighterPhotoHash(fighter) !== sprite.photoHash
      : fighter.photoHash !== sprite.photoHash
  ) {
    throw new Error('This fighter changed. Reload its animations before saving.');
  }
  const selected = selectPlayableCloudSprites(fighter.sprites)
    .find((candidate) => candidate.animationName === sprite.animationName);
  if (!selected || !matchesCurrentSprite(sprite, selected)) {
    throw new Error('This animation changed. Reload it before saving.');
  }
  const remote = arcade ? selected : {
    ...selected,
    // Only video-dense RAW is normalized and alpha-cleaned; legacy RAW still
    // contains provider originals and must remain an explicit separate export.
    hqUrl: selected.animationFormat === 'video-dense-v1' ? selected.rawUrl : null,
    hqFrameWidth: selected.rawFrameWidth,
    hqFrameHeight: selected.rawFrameHeight,
    hqFrameCount: selected.rawFrameCount,
  };
  if (!remote.hqUrl) return sprite;
  if (
    remote.animationFormat !== 'video-dense-v1' ||
    !positiveInteger(remote.hqFrameWidth) ||
    !positiveInteger(remote.hqFrameHeight) ||
    !positiveInteger(remote.hqFrameCount)
  ) {
    throw new Error('The best-quality animation is unavailable. Reload and try again.');
  }
  if (hasAdvertisedQuality(sprite, remote)) return sprite;

  const key = JSON.stringify([
    ownerScope, context.authRevision, context.apiBaseUrl ?? '',
    sprite.photoHash, fighter.id, remote.animationName, remote.id,
    remote.contentHash, remote.rawContentHash, remote.hqUrl,
    remote.frameWidth, remote.frameHeight, remote.frameCount,
    remote.animationFormat, remote.processingVersion,
    remote.hqFrameWidth, remote.hqFrameHeight, remote.hqFrameCount,
  ]);
  let pending = pendingExports.get(key);
  if (!pending) {
    // Keep the manifest fixed while an asynchronous request is in flight.
    const manifest = { ...fighter, sprites: [{ ...remote }] };
    pending = (async () => {
      const current = (await getAllSpritesForHash(sprite.photoHash, ownerScope))
        .find((candidate) => matchesCurrentSprite(candidate, remote));
      assertCurrent();
      if (!current) {
        throw new Error('This animation is no longer selected. Reload it before saving.');
      }
      if (hasAdvertisedQuality(current, remote)) return current;

      const download = arcade ? downloadArcadeSpriteHighDensityToLocal : downloadCloudSpriteHighDensityToLocal;
      await download(manifest, sprite.animationName, context);
      assertCurrent();
      const updated = (await getAllSpritesForHash(sprite.photoHash, ownerScope))
        .find((candidate) => matchesCurrentSprite(candidate, remote));
      assertCurrent();
      if (!updated || !hasAdvertisedQuality(updated, remote)) {
        throw new Error('The best-quality animation could not be loaded. Please retry.');
      }
      return updated;
    })();
    pendingExports.set(key, pending);
  }

  try {
    const prepared = await pending;
    assertCurrent();
    return prepared;
  } catch (error) {
    assertCurrent();
    throw error;
  } finally {
    if (pendingExports.get(key) === pending) pendingExports.delete(key);
  }
}
