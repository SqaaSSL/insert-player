import { describe, expect, it } from 'vitest';
import {
  AURA_ANIMATION_NAMES,
  AURA_ASSET_PACK_ID,
  FIGHT_ASSET_PACK_ID,
  assertFighterReadyForMode,
  fighterAssetPackReadiness,
  fighterModeCompatibilityLabel,
  inferFighterAssetPacks,
  isAnimationNameSetReadyForMode,
  resolveFighterModeReadiness,
  type AssetPackSprite,
} from './FighterAssetPacks.ts';
import { PLAYABLE_ANIMATION_NAMES } from './PlayableFighterAssets.ts';

function assetsFor(
  animationNames: readonly string[],
  qualityTier: AssetPackSprite['qualityTier'] = 'contender',
): AssetPackSprite[] {
  return animationNames.map((animationName) => ({
    animationName,
    qualityTier,
    frameWidth: 192,
    frameHeight: 256,
    frameCount: 8,
    pngBlob: new Blob(['sprite'], { type: 'image/png' }),
  }));
}

describe('fighter capability packs', () => {
  it('keeps Fight and Rush on the shared combat pack', () => {
    const fightAssets = assetsFor(PLAYABLE_ANIMATION_NAMES, 'champion');

    expect(resolveFighterModeReadiness(fightAssets, 'fight')).toMatchObject({
      kind: 'custom',
      activePackId: FIGHT_ASSET_PACK_ID,
    });
    expect(resolveFighterModeReadiness(fightAssets, 'rush')).toMatchObject({
      kind: 'custom',
      activePackId: FIGHT_ASSET_PACK_ID,
    });
  });

  it('lets every existing Fight fighter enter Aura through the legacy fallback', () => {
    expect(resolveFighterModeReadiness(assetsFor(PLAYABLE_ANIMATION_NAMES), 'aura'))
      .toMatchObject({ kind: 'legacy', activePackId: FIGHT_ASSET_PACK_ID });
  });

  it('prefers a complete seasonal Aura pack when both packs exist', () => {
    const assets = [
      ...assetsFor(PLAYABLE_ANIMATION_NAMES, 'rookie'),
      ...assetsFor(AURA_ANIMATION_NAMES, 'champion'),
    ];

    expect(resolveFighterModeReadiness(assets, 'aura')).toMatchObject({
      kind: 'custom',
      activePackId: AURA_ASSET_PACK_ID,
    });
    expect(inferFighterAssetPacks(assets)).toEqual([
      expect.objectContaining({ packId: FIGHT_ASSET_PACK_ID, complete: true, qualityTier: 'rookie' }),
      expect.objectContaining({ packId: AURA_ASSET_PACK_ID, complete: true, qualityTier: 'champion' }),
    ]);
  });

  it('allows Aura-only identities in Aura without leaking them into Fight or Rush', () => {
    const auraAssets = assetsFor(AURA_ANIMATION_NAMES);

    expect(resolveFighterModeReadiness(auraAssets, 'aura').kind).toBe('custom');
    expect(resolveFighterModeReadiness(auraAssets, 'fight').kind).toBe('unavailable');
    expect(resolveFighterModeReadiness(auraAssets, 'rush').kind).toBe('unavailable');
    expect(isAnimationNameSetReadyForMode(AURA_ANIMATION_NAMES, 'aura')).toBe(true);
    expect(isAnimationNameSetReadyForMode(AURA_ANIMATION_NAMES, 'fight')).toBe(false);
  });

  it('rejects incomplete or unusable Aura packs', () => {
    const incomplete = assetsFor(AURA_ANIMATION_NAMES.slice(0, -1));
    const invalid = assetsFor(AURA_ANIMATION_NAMES).map((asset) => (
      asset.animationName === 'aura_floor_worm'
        ? { ...asset, frameCount: 0 }
        : asset
    ));

    expect(fighterAssetPackReadiness(incomplete, AURA_ASSET_PACK_ID)).toMatchObject({
      complete: false,
      missingAnimations: ['aura_one_leg'],
    });
    expect(fighterAssetPackReadiness(invalid, AURA_ASSET_PACK_ID)).toMatchObject({
      complete: false,
      invalidAnimations: ['aura_floor_worm'],
    });
    expect(() => assertFighterReadyForMode(incomplete, 'Template Test', 'aura'))
      .toThrow('Template Test is not ready for AURA');
  });

  it('uses the weakest ready animation as pack quality and tolerates archived invalid duplicates', () => {
    const assets = assetsFor(AURA_ANIMATION_NAMES, 'champion');
    assets[2] = { ...assets[2], qualityTier: 'rookie' };
    assets.push({ ...assets[2], frameCount: 0 });

    expect(fighterAssetPackReadiness(assets, AURA_ASSET_PACK_ID)).toMatchObject({
      complete: true,
      qualityTier: 'rookie',
      invalidAnimations: [],
    });
  });

  it('labels Aura-only identities without implying Fight compatibility', () => {
    expect(fighterModeCompatibilityLabel(AURA_ANIMATION_NAMES)).toBe('Aura only');
    expect(fighterModeCompatibilityLabel(PLAYABLE_ANIMATION_NAMES)).toBe('Fight · Rush · Aura legacy');
    expect(fighterModeCompatibilityLabel([
      ...PLAYABLE_ANIMATION_NAMES,
      ...AURA_ANIMATION_NAMES,
    ])).toBe('Fight · Rush · Aura');
  });
});
