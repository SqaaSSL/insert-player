import { describe, expect, it } from 'vitest';
import {
  AURA_ANIMATION_NAMES,
  AURA_OPTIONAL_ANIMATION_NAMES,
  FIGHT_ANIMATION_NAMES,
  GENERATED_ANIMATION_NAMES,
  hasCompleteFighterAssetPack,
  summarizeFighterAssetPacks,
} from './fighterAssetPacks';

function sprites(names: readonly string[], qualityTier: 'rookie' | 'contender' | 'champion' = 'contender') {
  return names.map((animation_name) => ({
    animation_name,
    quality_tier: qualityTier,
    blob_key: `sprites/${animation_name}.png`,
    content_hash: 'a'.repeat(64),
    frame_w: 192,
    frame_h: 256,
    frame_count: 8,
  }));
}

describe('worker fighter asset packs', () => {
  it('allows both pack contracts through generated-asset persistence', () => {
    expect(GENERATED_ANIMATION_NAMES.has('victory')).toBe(true);
    expect(GENERATED_ANIMATION_NAMES.has('aura_floor_worm')).toBe(true);
    expect(GENERATED_ANIMATION_NAMES.has('aura_shrug')).toBe(true);
    expect(GENERATED_ANIMATION_NAMES.has('aura_not_real')).toBe(false);
  });

  it('recognizes complete Fight and Aura packs independently', () => {
    expect(hasCompleteFighterAssetPack(sprites(FIGHT_ANIMATION_NAMES))).toBe(true);
    expect(hasCompleteFighterAssetPack(sprites(AURA_ANIMATION_NAMES))).toBe(true);
    expect(hasCompleteFighterAssetPack(sprites([
      ...AURA_ANIMATION_NAMES,
      ...AURA_OPTIONAL_ANIMATION_NAMES,
    ]))).toBe(true);
  });

  it('reports partial packs without making them playable', () => {
    const summary = summarizeFighterAssetPacks(sprites(AURA_ANIMATION_NAMES.slice(0, 2)));
    expect(summary).toEqual([expect.objectContaining({
      id: 'aura-v1-2026',
      status: 'partial',
      animationsReady: ['aura_unbothered', 'aura_six_seven'],
    })]);
    expect(hasCompleteFighterAssetPack(sprites(AURA_ANIMATION_NAMES.slice(0, 2)))).toBe(false);
  });

  it('describes pack quality by its weakest current animation', () => {
    const mixed = sprites(AURA_ANIMATION_NAMES, 'champion');
    mixed[2] = { ...mixed[2], quality_tier: 'rookie' };
    expect(summarizeFighterAssetPacks(mixed)[0].qualityTier).toBe('rookie');
  });
});
