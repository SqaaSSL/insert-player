import { describe, expect, it } from 'vitest';
import {
  AURA_PLAZA_ASSET_PATH,
  AURA_STAGE_THEMES,
  DEFAULT_AURA_STAGE_ID,
  SIGNATURE_STAGE_THEMES,
  STAGE_THEMES,
  getDefaultStageThemeIdForMode,
  getFightStageCalibration,
  getSignatureStageThemeIdForArcadeSlug,
  getStageTheme,
  getStageThemesForMode,
  nextStageThemeId,
  pickStageThemeIdFromSeed,
  resolveAutoSignatureStageThemeId,
  resolveRosterStageThemeId,
  stageSupportsMode,
} from './StageConfig.ts';

describe('signature stage configuration', () => {
  it('publishes the brand arena and maps every launch Arcade slug to its signature PNG', () => {
    expect(SIGNATURE_STAGE_THEMES.slice(0, 5)).toMatchObject([
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
        assetPath: '/assets/rush/la-jaula-304/la-jaula-304-fight-v2.webp',
        rushAssetPath: '/assets/rush/la-jaula-304/la-jaula-304-route-v1.webp',
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

  it('defaults Aura AUTO to its performance plaza while preserving explicit and photo stages', () => {
    const matchup = { mode: 'aura' as const, p1ArcadeSlug: 'elon-musk', p2ArcadeSlug: 'donald-trump' };
    expect(resolveRosterStageThemeId(matchup)).toBe(DEFAULT_AURA_STAGE_ID);
    expect(resolveRosterStageThemeId({ ...matchup, manualStageId: 'executive-rumble' })).toBe('executive-rumble');
    expect(resolveRosterStageThemeId({ ...matchup, hasCustomPhotoStage: true })).toBeUndefined();
    expect(resolveRosterStageThemeId({ ...matchup, mode: 'fight' })).toBe('executive-rumble');
  });

  it('lists and randomly chooses only the published stage assets', () => {
    const publishedIds = new Set(SIGNATURE_STAGE_THEMES.map((stage) => stage.id));
    const pickedIds = new Set(
      Array.from({ length: 200 }, (_, seed) => pickStageThemeIdFromSeed(seed * 7919)),
    );

    expect(STAGE_THEMES).toEqual([...SIGNATURE_STAGE_THEMES, ...AURA_STAGE_THEMES]);
    expect(STAGE_THEMES.every((stage) => Boolean(stage.assetPath))).toBe(true);
    expect(publishedIds.size).toBe(6);
    expect(pickedIds).toEqual(publishedIds);
    for (const id of pickedIds) {
      expect(publishedIds.has(id)).toBe(true);
    }
  });

  it('offers the new default only to Aura and retains compatibility with the existing six arenas', () => {
    expect(getStageThemesForMode('rush').map((stage) => stage.id)).toEqual(['la-jaula-304', 'side-street']);
    expect(getDefaultStageThemeIdForMode('rush')).toBe('side-street');
    expect(getStageThemesForMode('fight').map((stage) => stage.id)).toContain('side-street');
    expect(getStageThemesForMode('fight').map((stage) => stage.id)).toContain('la-jaula-304');
    expect(getStageThemesForMode('aura').map((stage) => stage.id)).toEqual(
      [...getStageThemesForMode('fight').map((stage) => stage.id), DEFAULT_AURA_STAGE_ID],
    );
    expect(getDefaultStageThemeIdForMode('aura')).toBe(DEFAULT_AURA_STAGE_ID);
    expect(getDefaultStageThemeIdForMode('fight')).toBe('insert-player-arena');
    expect(stageSupportsMode(DEFAULT_AURA_STAGE_ID, 'aura')).toBe(true);
    expect(stageSupportsMode(DEFAULT_AURA_STAGE_ID, 'fight')).toBe(false);
    expect(stageSupportsMode(DEFAULT_AURA_STAGE_ID, 'rush')).toBe(false);
    expect(getStageTheme(DEFAULT_AURA_STAGE_ID)).toMatchObject({
      id: DEFAULT_AURA_STAGE_ID, assetPath: AURA_PLAZA_ASSET_PATH, modes: ['aura'], auraFloorRatio: 0.82,
    });
  });

  it('keeps both older Aura Plazas resolvable for saved challenges without offering them for new sessions', () => {
    expect(DEFAULT_AURA_STAGE_ID).toBe('aura-plaza-v3');
    for (const [id, assetPath] of [
      ['aura-plaza', '/assets/stages/aura/aura-plaza-v1.webp'],
      ['aura-plaza-v2', '/assets/stages/aura/aura-plaza-v2.webp'],
    ] as const) {
      expect(getStageTheme(id)).toMatchObject({ id, assetPath, hiddenFromSelection: true, auraFloorRatio: 0.82 });
      expect(stageSupportsMode(id, 'aura')).toBe(true);
      expect(getStageThemesForMode('aura').some((stage) => stage.id === id)).toBe(false);
      expect(resolveRosterStageThemeId({ mode: 'aura', manualStageId: id })).toBe(id);
    }
  });

  it('keeps historical seeded Fight stages and cycling unchanged after adding an Aura-only stage', () => {
    expect(Array.from({ length: 8 }, (_, seed) => pickStageThemeIdFromSeed(seed))).toEqual([
      'insert-player-arena', 'executive-rumble', 'mars-incorporated', 'tablao-3000',
      'la-jaula-304', 'side-street', 'insert-player-arena', 'executive-rumble',
    ]);
    expect(nextStageThemeId('side-street')).toBeNull();
    expect(nextStageThemeId('side-street', 'aura')).toBe(DEFAULT_AURA_STAGE_ID);
    expect(nextStageThemeId(DEFAULT_AURA_STAGE_ID, 'aura')).toBeNull();
  });

  it('keeps fight-plane calibration attached to the stage asset', () => {
    expect(getFightStageCalibration('la-jaula-304')).toEqual({
      floorY: 480,
      fighterScale: 1.03,
      fighterYOffset: 0,
    });
    expect(getFightStageCalibration('side-street')).toEqual({
      floorY: 480,
      fighterScale: 1.03,
      fighterYOffset: 0,
    });
    expect(getFightStageCalibration('side-street', true)).toEqual({
      floorY: 498,
      fighterScale: 1.2,
      fighterYOffset: 18,
    });
  });
});
