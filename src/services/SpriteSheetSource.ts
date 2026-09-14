import type { SpriteAnimationFormat } from '../SpriteAnimationFormat.ts';
import type { CachedSprite } from './SpriteCache.ts';

interface SpriteSheetVariants {
  blob: Blob;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  rawBlob?: Blob;
  rawFrameWidth?: number;
  rawFrameHeight?: number;
  rawFrameCount?: number;
  animationFormat?: SpriteAnimationFormat;
}

export interface SpriteSheetSource {
  blob: Blob;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  highDensity: boolean;
}

function positiveInteger(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && value! > 0;
}

/** Choose native clean pixels, never an upscaled gameplay sheet or legacy provider RAW. */
export function selectBestSpriteSheet(sprite: SpriteSheetVariants): SpriteSheetSource {
  if (
    sprite.animationFormat === 'video-dense-v1' && sprite.rawBlob &&
    positiveInteger(sprite.rawFrameWidth) && positiveInteger(sprite.rawFrameHeight) &&
    positiveInteger(sprite.rawFrameCount) &&
    sprite.rawFrameWidth >= sprite.frameWidth && sprite.rawFrameHeight >= sprite.frameHeight
  ) {
    return {
      blob: sprite.rawBlob,
      frameWidth: sprite.rawFrameWidth,
      frameHeight: sprite.rawFrameHeight,
      frameCount: sprite.rawFrameCount,
      highDensity: true,
    };
  }
  return {
    blob: sprite.blob,
    frameWidth: sprite.frameWidth,
    frameHeight: sprite.frameHeight,
    frameCount: sprite.frameCount,
    highDensity: false,
  };
}

export function getBestCachedSpriteSheet(sprite: CachedSprite): SpriteSheetSource {
  return selectBestSpriteSheet({ ...sprite, blob: sprite.pngBlob, rawBlob: sprite.rawPngBlob });
}

const PING_PONG_ANIMATIONS = new Set(['high_punch', 'low_punch', 'high_kick', 'low_kick']);

/** HQ attacks store unique forward poses; gameplay sheets already include the return. */
export function getSpriteSheetPlaybackFrameIndices(
  animationName: string | undefined,
  animationFormat: SpriteAnimationFormat | undefined,
  sheet: Pick<SpriteSheetSource, 'frameCount' | 'highDensity'>,
): number[] | undefined {
  if (!sheet.highDensity || animationFormat !== 'video-dense-v1' || !animationName || !PING_PONG_ANIMATIONS.has(animationName)) {
    return undefined;
  }
  const forward = Array.from({ length: sheet.frameCount }, (_, index) => index);
  return [...forward, ...forward.slice(0, -1).reverse()];
}
