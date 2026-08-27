import { describe, expect, it } from 'vitest';
import { chooseSpriteTextureDensity } from './SpriteRenderQuality.ts';

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
