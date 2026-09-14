import { describe, expect, it } from 'vitest';
import type { CachedSprite } from './SpriteCache.ts';
import { getBestCachedSpriteSheet, getSpriteSheetPlaybackFrameIndices } from './SpriteSheetSource.ts';

const pngBlob = new Blob(['gameplay'], { type: 'image/png' });
const rawPngBlob = new Blob(['native clean HQ'], { type: 'image/png' });
const sprite: CachedSprite = {
  photoHash: 'arcade:rosalia', animationName: 'high_kick', qualityTier: 'champion',
  pngBlob, rawPngBlob, frameWidth: 192, frameHeight: 256, frameCount: 23,
  rawFrameWidth: 768, rawFrameHeight: 1024, rawFrameCount: 12,
  animationFormat: 'video-dense-v1', createdAt: 1,
};

describe('best available sprite sheet', () => {
  it('exports the original native PNG bytes and metadata, including every unique HQ frame', () => {
    expect(getBestCachedSpriteSheet(sprite)).toEqual({ blob: rawPngBlob, frameWidth: 768, frameHeight: 1024, frameCount: 12, highDensity: true });
    expect(getBestCachedSpriteSheet(sprite).blob).toBe(rawPngBlob);
  });

  it('keeps legacy provider RAW out of ordinary downloads even if it is larger', () => {
    expect(getBestCachedSpriteSheet({ ...sprite, animationFormat: 'legacy' }).blob).toBe(pngBlob);
  });

  it.each([0, -1, NaN, Infinity, 1.5, undefined])('rejects invalid HQ frame metadata (%s)', (rawFrameCount) => {
    expect(getBestCachedSpriteSheet({ ...sprite, rawFrameCount }).blob).toBe(pngBlob);
  });

  it('uses the best processed asset without inventing an upscale when HQ is absent or smaller', () => {
    expect(getBestCachedSpriteSheet({ ...sprite, rawPngBlob: undefined })).toEqual({ blob: pngBlob, frameWidth: 192, frameHeight: 256, frameCount: 23, highDensity: false });
    expect(getBestCachedSpriteSheet({ ...sprite, rawFrameWidth: 96, rawFrameHeight: 128 }).blob).toBe(pngBlob);
  });

  it('reconstructs the dense attack return once, while leaving processed sheets and loops alone', () => {
    expect(getSpriteSheetPlaybackFrameIndices('high_punch', 'video-dense-v1', { frameCount: 3, highDensity: true })).toEqual([0, 1, 2, 1, 0]);
    expect(getSpriteSheetPlaybackFrameIndices('high_punch', 'video-dense-v1', { frameCount: 5, highDensity: false })).toBeUndefined();
    expect(getSpriteSheetPlaybackFrameIndices('idle', 'video-dense-v1', { frameCount: 3, highDensity: true })).toBeUndefined();
  });
});
