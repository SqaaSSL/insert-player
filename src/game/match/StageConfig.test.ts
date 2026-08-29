import { describe, expect, it } from 'vitest';
import {
  CLASSIC_STAGE_THEMES,
  SIGNATURE_STAGE_THEMES,
  getSignatureStageThemeIdForArcadeSlug,
  pickStageThemeIdFromSeed,
  resolveAutoSignatureStageThemeId,
  resolveRosterStageThemeId,
} from './StageConfig.ts';

describe('signature stage configuration', () => {
  it('publishes the brand arena and maps every launch Arcade slug to its signature PNG', () => {
    expect(SIGNATURE_STAGE_THEMES).toMatchObject([
      {
        id: 'insert-player-arena',
        assetPath: '/assets/stages/signature/insert-player-arena-pipeline-v1.png',
      },
      {
        id: 'executive-rumble',
        assetPath: '/assets/stages/signature/executive-rumble-pipeline-v1.png',
        signatureForArcadeSlug: 'donald-trump',
      },
      {
        id: 'mars-incorporated',
        assetPath: '/assets/stages/signature/mars-incorporated-pipeline-v1.png',
        signatureForArcadeSlug: 'elon-musk',
      },
      {
        id: 'tablao-3000',
        assetPath: '/assets/stages/signature/tablao-3000-pipeline-v1.png',
        signatureForArcadeSlug: 'rosalia',
      },
      {
        id: 'la-jaula-304',
        assetPath: '/assets/stages/signature/la-jaula-304-pipeline-v1.png',
        signatureForArcadeSlug: 'lamine-yamal',
      },
    ]);

    expect(getSignatureStageThemeIdForArcadeSlug('donald-trump')).toBe('executive-rumble');
    expect(getSignatureStageThemeIdForArcadeSlug('elon-musk')).toBe('mars-incorporated');
    expect(getSignatureStageThemeIdForArcadeSlug('rosalia')).toBe('tablao-3000');
    expect(getSignatureStageThemeIdForArcadeSlug('lamine-yamal')).toBe('la-jaula-304');
    expect(getSignatureStageThemeIdForArcadeSlug('custom-rookie')).toBeNull();
  });

  it('uses the P2 signature stage first, then falls back to P1', () => {
    expect(resolveAutoSignatureStageThemeId('elon-musk', 'donald-trump')).toBe('executive-rumble');
    expect(resolveAutoSignatureStageThemeId('rosalia', 'custom-rookie')).toBe('tablao-3000');
    expect(resolveAutoSignatureStageThemeId('custom-rookie', 'another-rookie')).toBeNull();
  });

  it('preserves manual and photo choices instead of applying AUTO', () => {
    expect(resolveRosterStageThemeId({
      manualStageId: 'sunset-pier',
      p1ArcadeSlug: 'elon-musk',
      p2ArcadeSlug: 'donald-trump',
    })).toBe('sunset-pier');

    expect(resolveRosterStageThemeId({
      hasCustomPhotoStage: true,
      p1ArcadeSlug: 'elon-musk',
      p2ArcadeSlug: 'donald-trump',
    })).toBeUndefined();

    expect(resolveRosterStageThemeId({
      p1ArcadeSlug: 'custom-rookie',
      p2ArcadeSlug: 'another-rookie',
    })).toBeUndefined();
  });

  it('keeps random AUTO stages inside the original five-stage pool', () => {
    const classicIds = new Set(CLASSIC_STAGE_THEMES.map((stage) => stage.id));
    const pickedIds = new Set(
      Array.from({ length: 200 }, (_, seed) => pickStageThemeIdFromSeed(seed * 7919)),
    );

    expect(classicIds.size).toBe(5);
    expect(pickedIds).toEqual(classicIds);
    for (const id of pickedIds) {
      expect(classicIds.has(id)).toBe(true);
    }
  });
});
