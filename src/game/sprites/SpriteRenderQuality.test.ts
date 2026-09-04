import { describe, expect, it } from 'vitest';
import { chooseSpriteTextureDensity, spriteSupportsHighResolutionAtlas } from './SpriteRenderQuality.ts';

const REQUEST = {
  atlasWidthAt1x: 12 * 192,
  atlasHeightAt1x: 16 * 256,
  highResolutionSourcesAvailable: true,
};

describe('adaptive sprite texture density', () => {
  it('selects 2x on a capable desktop GPU with enough memory', () => {
    expect(chooseSpriteTextureDensity({
      maxTextureSize: 16_384,
      deviceMemoryGb: 8,
      saveData: false,
      coarsePointer: false,
    }, REQUEST)).toBe(2);
  });

  it('keeps 1x when the expanded atlas exceeds the GPU texture limit', () => {
    expect(chooseSpriteTextureDensity({
      maxTextureSize: 4_096,
      deviceMemoryGb: 8,
      saveData: false,
      coarsePointer: false,
    }, REQUEST)).toBe(1);
  });

  it('keeps 1x on a constrained-memory device even with a large texture limit', () => {
    expect(chooseSpriteTextureDensity({
      maxTextureSize: 16_384,
      deviceMemoryGb: 4,
      saveData: false,
      coarsePointer: false,
    }, REQUEST)).toBe(1);
  });

  it('honors data saver and missing HQ source assets', () => {
    expect(chooseSpriteTextureDensity({
      maxTextureSize: 16_384,
      deviceMemoryGb: 8,
      saveData: true,
      coarsePointer: false,
    }, REQUEST)).toBe(1);
    expect(chooseSpriteTextureDensity({
      maxTextureSize: 16_384,
      deviceMemoryGb: 8,
      saveData: false,
      coarsePointer: false,
    }, { ...REQUEST, highResolutionSourcesAvailable: false })).toBe(1);
  });

  it('requires extra GPU headroom when the browser conceals system memory', () => {
    expect(chooseSpriteTextureDensity({
      maxTextureSize: 8_192,
      deviceMemoryGb: null,
      saveData: false,
      coarsePointer: false,
    }, REQUEST)).toBe(1);
    expect(chooseSpriteTextureDensity({
      maxTextureSize: 16_384,
      deviceMemoryGb: null,
      saveData: false,
      coarsePointer: false,
    }, REQUEST)).toBe(2);
  });

  it('keeps coarse-pointer devices at 1x even with desktop-class reported limits', () => {
    expect(chooseSpriteTextureDensity({
      maxTextureSize: 16_384,
      deviceMemoryGb: 8,
      saveData: false,
      coarsePointer: true,
    }, REQUEST)).toBe(1);
  });
});

describe('spriteSupportsHighResolutionAtlas', () => {
  const target = { w: 384, h: 512 };

  it('accepts a video-dense sprite with complete RAW metadata', () => {
    expect(spriteSupportsHighResolutionAtlas({
      animationFormat: 'video-dense-v1',
      frameWidth: 192,
      frameHeight: 256,
      rawPngBlob: new Blob(['x']),
      rawFrameWidth: 768,
      rawFrameHeight: 1024,
      rawFrameCount: 4,
    }, target.w, target.h)).toBe(true);
  });

  it('rejects a video-dense sprite missing its RAW blob', () => {
    expect(spriteSupportsHighResolutionAtlas({
      animationFormat: 'video-dense-v1',
      frameWidth: 192,
      frameHeight: 256,
      rawPngBlob: null,
      rawFrameWidth: 768,
      rawFrameHeight: 1024,
      rawFrameCount: 4,
    }, target.w, target.h)).toBe(false);
  });

  it('accepts a legacy Champion sheet whose processed frames are 2x or larger', () => {
    expect(spriteSupportsHighResolutionAtlas({
      animationFormat: 'legacy',
      frameWidth: 768,
      frameHeight: 1024,
    }, target.w, target.h)).toBe(true);
  });

  it('rejects a legacy Rookie/Contender sheet below the 2x cell size', () => {
    expect(spriteSupportsHighResolutionAtlas({
      animationFormat: 'legacy',
      frameWidth: 192,
      frameHeight: 256,
    }, target.w, target.h)).toBe(false);
    expect(spriteSupportsHighResolutionAtlas({
      animationFormat: 'legacy',
      frameWidth: 384,
      frameHeight: 500,
    }, target.w, target.h)).toBe(false);
  });
});
