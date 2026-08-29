import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_STAGE_THEMES,
  STAGE_THEMES,
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
        signatureForArcadeSlug: 'rosalia-v2',
      },
      {
        id: 'la-jaula-304',
        assetPath: '/assets/stages/signature/la-jaula-304-pipeline-v1.png',
        signatureForArcadeSlug: 'lamine-yamal',
      },
    ]);

    expect(getSignatureStageThemeIdForArcadeSlug('donald-trump')).toBe('executive-rumble');
    expect(getSignatureStageThemeIdForArcadeSlug('elon-musk')).toBe('mars-incorporated');
    expect(getSignatureStageThemeIdForArcadeSlug('rosalia-v2')).toBe('tablao-3000');
    expect(getSignatureStageThemeIdForArcadeSlug('rosalia')).toBeNull();
    expect(getSignatureStageThemeIdForArcadeSlug('lamine-yamal')).toBe('la-jaula-304');
    expect(getSignatureStageThemeIdForArcadeSlug('custom-rookie')).toBeNull();
  });

  it('uses the P2 signature stage first, then falls back to P1', () => {
    expect(resolveAutoSignatureStageThemeId('elon-musk', 'donald-trump')).toBe('executive-rumble');
    expect(resolveAutoSignatureStageThemeId('rosalia-v2', 'custom-rookie')).toBe('tablao-3000');
    expect(resolveAutoSignatureStageThemeId('custom-rookie', 'another-rookie')).toBeNull();
  });

  it('preserves manual and photo choices instead of applying AUTO', () => {
    expect(resolveRosterStageThemeId({
      manualStageId: 'insert-player-arena',
      p1ArcadeSlug: 'elon-musk',
      p2ArcadeSlug: 'donald-trump',
    })).toBe('insert-player-arena');

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

  it('lists and randomly chooses only the five published stage assets', () => {
    const publishedIds = new Set(SIGNATURE_STAGE_THEMES.map((stage) => stage.id));
    const pickedIds = new Set(
      Array.from({ length: 200 }, (_, seed) => pickStageThemeIdFromSeed(seed * 7919)),
    );

    expect(STAGE_THEMES).toEqual(SIGNATURE_STAGE_THEMES);
    expect(STAGE_THEMES.every((stage) => Boolean(stage.assetPath))).toBe(true);
    expect(publishedIds.size).toBe(5);
    expect(pickedIds).toEqual(publishedIds);
    for (const id of pickedIds) {
      expect(publishedIds.has(id)).toBe(true);
    }
  });
});
