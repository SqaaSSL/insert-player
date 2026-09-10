import { describe, expect, it } from 'vitest';
import {
  AURA_ANIMATION_NAMES,
  AURA_ASSET_PACK_ID,
  AURA_OPTIONAL_ANIMATION_NAMES,
  FIGHT_ASSET_PACK_ID,
  assertFighterReadyForMode,
  fighterAssetPackReadiness,
  fighterModeCompatibilityLabel,
  inferFighterAssetPacks,
  isAuraAnimationName,
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

  it('keeps Fight-only characters out of Aura even when their combat pack is complete', () => {
    expect(resolveFighterModeReadiness(assetsFor(PLAYABLE_ANIMATION_NAMES), 'aura'))
      .toMatchObject({ kind: 'unavailable', activePackId: null, missingAnimations: [...AURA_ANIMATION_NAMES] });
    expect(isAnimationNameSetReadyForMode(PLAYABLE_ANIMATION_NAMES, 'aura')).toBe(false);
    expect(() => assertFighterReadyForMode(assetsFor(PLAYABLE_ANIMATION_NAMES), 'Fight Player', 'aura'))
      .toThrow('Fight Player is not ready for AURA');
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

  it('loads optional reactions without adding them to the paid Aura requirement', () => {
    const requiredAssets = assetsFor(AURA_ANIMATION_NAMES);
    const withShrug = [
      ...requiredAssets,
      ...assetsFor(AURA_OPTIONAL_ANIMATION_NAMES),
    ];

    expect(fighterAssetPackReadiness(requiredAssets, AURA_ASSET_PACK_ID).complete).toBe(true);
    expect(fighterAssetPackReadiness(withShrug, AURA_ASSET_PACK_ID).complete).toBe(true);
    expect(resolveFighterModeReadiness([
      ...requiredAssets, { ...assetsFor(AURA_OPTIONAL_ANIMATION_NAMES)[0], pngBlob: null, frameCount: 0 },
    ], 'aura').kind).toBe('custom');
    expect(isAuraAnimationName('aura_shrug')).toBe(true);
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
    expect(resolveFighterModeReadiness([...assetsFor(PLAYABLE_ANIMATION_NAMES), ...invalid], 'aura'))
      .toMatchObject({ kind: 'unavailable', invalidAnimations: ['aura_floor_worm'] });
  });

  it('checks actual Aura payloads at launch even when all six animation names are advertised', () => {
    const invalidPayloads: Array<Partial<AssetPackSprite>> = [
      { pngBlob: null },
      { pngBlob: new Blob([]) },
      { pngBlob: undefined, url: null },
      { pngBlob: undefined, url: '  ' },
      { frameWidth: Number.NaN },
      { frameHeight: Number.POSITIVE_INFINITY },
      { frameCount: 1.5 },
    ];
    for (const invalidPayload of invalidPayloads) {
      const assets = assetsFor(AURA_ANIMATION_NAMES);
      assets[0] = { ...assets[0], ...invalidPayload };
      expect(isAnimationNameSetReadyForMode(assets.map((asset) => asset.animationName), 'aura')).toBe(true);
      expect(() => assertFighterReadyForMode(assets, 'Cached Player', 'aura'))
        .toThrow('invalid aura_unbothered');
    }
    const metadataOnly = assetsFor(AURA_ANIMATION_NAMES).map(({ pngBlob: _pngBlob, ...asset }) => asset);
    expect(resolveFighterModeReadiness(metadataOnly, 'aura').kind).toBe('unavailable');
  });

  it('does not count misspelled or padded names as loaded performances', () => {
    const assets = assetsFor(AURA_ANIMATION_NAMES);
    assets[0] = { ...assets[0], animationName: ' aura_unbothered ' };
    expect(resolveFighterModeReadiness(assets, 'aura'))
      .toMatchObject({ kind: 'unavailable', missingAnimations: ['aura_unbothered'] });
  });

  it('accepts the reviewed official bundle without granting a paid or combat pack', () => {
    const identity = {
      photoHash: 'arcade:donald-trump:public-trump', cloudFighterId: 'public-trump', cloudPublic: true,
    };
    expect(assertFighterReadyForMode([], 'Donald Trump', 'aura', identity)).toMatchObject({
      kind: 'custom', activePackId: AURA_ASSET_PACK_ID,
    });
    expect(isAnimationNameSetReadyForMode([], 'aura', identity)).toBe(true);
    expect(resolveFighterModeReadiness([], 'fight', identity).kind).toBe('unavailable');
    expect(inferFighterAssetPacks([]).every((pack) => !pack.complete)).toBe(true);
    expect(() => assertFighterReadyForMode([], 'Donald Trump', 'aura', {
      ...identity, cloudFighterId: 'someone-else',
    })).toThrow('not ready for AURA');
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
    expect(fighterModeCompatibilityLabel(PLAYABLE_ANIMATION_NAMES)).toBe('Fight · Rush');
    expect(fighterModeCompatibilityLabel([
      ...PLAYABLE_ANIMATION_NAMES,
      ...AURA_ANIMATION_NAMES,
    ])).toBe('Fight · Rush · Aura');
  });
});
