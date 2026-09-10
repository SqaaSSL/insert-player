import { describe, expect, it } from 'vitest';
import { quoteOwnedPackageExpansion, storedGenerationAnimationNames } from './generationPackages';
import { generationStagesForOperation } from './generationArtifacts';
import { AURA_ANIMATION_NAMES } from '../../src/services/FighterAssetPacks';
import { PLAYABLE_ANIMATION_NAMES } from '../../src/services/PlayableFighterAssets';
import { quoteGenerationPackage } from '../../src/services/GenerationPackages';
import type { Env } from './types';

describe('immutable package plans', () => {
  it('rejects malformed or widened plans and excludes sources from expansion', () => {
    const options = { creation_package: 'complete' as const, expansion_only: 1, animation_plan_json: '["walk","jump"]' };
    expect(generationStagesForOperation('fighter_upgrade', null, options).map((stage) => stage.key)).toEqual(['sprite:walk', 'sprite:jump']);
    expect(() => storedGenerationAnimationNames({ ...options, animation_plan_json: '["aura_glide"]' })).toThrow();
    expect(() => storedGenerationAnimationNames({ ...options, animation_plan_json: '["walk","walk"]' })).toThrow();
    expect(() => storedGenerationAnimationNames({ creation_package: 'aura', expansion_only: 1 })).toThrow();
  });
  it('requires precisely three sources and six named performances for Aura', () => {
    expect(generationStagesForOperation('fighter_generation', null, { creation_package: 'aura' }).map((stage) => stage.key))
      .toEqual(['source:side', 'source:upright', 'source:crouch', ...AURA_ANIMATION_NAMES.map((name) => `sprite:${name}`)]);
  });

  it('keeps Worker expansion quote modes and work in parity with the purchased pack', async () => {
    const existing = [...PLAYABLE_ANIMATION_NAMES, ...AURA_ANIMATION_NAMES, 'aura_shrug']
      .filter((name) => name !== 'walk' && name !== 'aura_one_leg');
    const rows = existing.map((animation_name) => ({
      animation_name, quality_tier: 'champion', blob_key: `${animation_name}.png`, raw_blob_key: `${animation_name}.raw.png`,
    }));
    const env = {
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) },
      SPRITES: { head: async () => ({}) },
    } as unknown as Env;

    const combat = await quoteOwnedPackageExpansion(env, 'owner', 'fighter', 'champion', 'complete');
    const aura = await quoteOwnedPackageExpansion(env, 'owner', 'fighter', 'champion', 'aura');
    expect(combat.animations).toEqual(['walk']);
    expect(combat.compatibleModes).toEqual(['fight', 'rush']);
    expect(aura.animations).toEqual(['aura_one_leg']);
    expect(aura.compatibleModes).toEqual(['aura']);
    expect(combat).toEqual(quoteGenerationPackage('champion', 'complete', { expansion: true, existingAnimations: existing }));
    expect(aura).toEqual(quoteGenerationPackage('champion', 'aura', { expansion: true, existingAnimations: existing }));
  });
});
