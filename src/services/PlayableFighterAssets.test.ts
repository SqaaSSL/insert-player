import { describe, expect, it } from 'vitest';
import {
  PLAYABLE_ANIMATION_NAMES,
  assertCompletePlayableSpriteSet,
  invalidPlayableAnimationNames,
  isCompletePlayableSpriteSet,
  isTemplateOnlyFighterIdentity,
  missingPlayableAnimationNames,
} from './PlayableFighterAssets.ts';
import { getAnimationList } from './CharacterPipeline.ts';

function completeAssets() {
  return PLAYABLE_ANIMATION_NAMES.map((animationName) => ({
    animationName,
    frameWidth: 256,
    frameHeight: 256,
    frameCount: 4,
    pngBlob: new Blob(['sprite'], { type: 'image/png' }),
  }));
}

describe('playable fighter asset invariant', () => {
  it('reserves Template Zero for generation infrastructure', () => {
    expect(isTemplateOnlyFighterIdentity({ name: 'Template Zero' })).toBe(true);
    expect(isTemplateOnlyFighterIdentity({ name: 'Donald Trump — Template Zero' })).toBe(true);
    expect(isTemplateOnlyFighterIdentity({ arcadeSlug: 'template-zero-v2' })).toBe(true);
    expect(isTemplateOnlyFighterIdentity({ photoHash: 'arcade:template_zero:internal-id' })).toBe(true);
    expect(isTemplateOnlyFighterIdentity({ name: 'Vanta' })).toBe(false);
  });

  it('stays aligned with the generation pipeline contract', () => {
    expect(getAnimationList().map((animation) => animation.name))
      .toEqual([...PLAYABLE_ANIMATION_NAMES]);
  });

  it('requires every one of the eleven gameplay animations', () => {
    const partial = completeAssets().filter((asset) => asset.animationName !== 'victory');

    expect(missingPlayableAnimationNames(partial)).toEqual(['victory']);
    expect(isCompletePlayableSpriteSet(partial)).toBe(false);
    expect(() => assertCompletePlayableSpriteSet(partial, 'Test Fighter'))
      .toThrow('Test Fighter is not ready to play (missing victory)');
  });

  it('rejects empty bytes and invalid playback dimensions', () => {
    const invalid = completeAssets().map((asset) => (
      asset.animationName === 'idle'
        ? { ...asset, pngBlob: new Blob([]), frameWidth: 0 }
        : asset
    ));

    expect(invalidPlayableAnimationNames(invalid)).toEqual(['idle']);
    expect(isCompletePlayableSpriteSet(invalid)).toBe(false);
  });

  it('accepts exactly one usable asset for every required animation', () => {
    expect(isCompletePlayableSpriteSet(completeAssets())).toBe(true);
    expect(() => assertCompletePlayableSpriteSet(completeAssets(), 'Test Fighter')).not.toThrow();
  });
});
