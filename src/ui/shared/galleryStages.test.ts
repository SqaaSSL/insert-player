import { describe, expect, it } from 'vitest';
import type { CachedStageBackground } from '../../services/SpriteCache.ts';
import {
  GLOBAL_GALLERY_STAGES,
  buildGalleryStageEntries,
  clampGalleryStageIndex,
} from './galleryStages.ts';

function ownedStage(stageKey: string): CachedStageBackground {
  return {
    stageKey,
    prompt: 'A private photo stage',
    pngBlob: new Blob(['stage'], { type: 'image/png' }),
    createdAt: 123,
    kind: 'photo',
    label: 'MY STAGE',
  };
}

describe('Roster Lab stage catalog', () => {
  it('lists every official global stage even when IndexedDB is empty', () => {
    const entries = buildGalleryStageEntries([]);

    expect(entries).toHaveLength(6);
    expect(entries.map((entry) => entry.scope)).toEqual([
      'global',
      'global',
      'global',
      'global',
      'global',
      'global',
    ]);
    expect(entries.map((entry) => entry.key)).toEqual([
      'global:insert-player-arena',
      'global:executive-rumble',
      'global:mars-incorporated',
      'global:tablao-3000',
      'global:la-jaula-304',
      'global:side-street',
    ]);
    expect(GLOBAL_GALLERY_STAGES.map((stage) => stage.assetPath)).toEqual([
      '/assets/stages/signature/insert-player-arena-pipeline-v1.png',
      '/assets/stages/signature/executive-rumble-pipeline-v1.png',
      '/assets/stages/signature/mars-incorporated-pipeline-v1.png',
      '/assets/stages/signature/tablao-3000-pipeline-v1.png',
      '/assets/rush/la-jaula-304/la-jaula-304-fight-v2.webp',
      '/assets/rush/side-street/side-street-fight-v1.webp',
    ]);
  });

  it('keeps owned stages after the read-only global catalog', () => {
    const entries = buildGalleryStageEntries([ownedStage('private-1')]);

    expect(entries).toHaveLength(7);
    expect(entries[6]).toMatchObject({
      scope: 'owned',
      key: 'owned:private-1',
      stage: { stageKey: 'private-1' },
    });
  });

  it('clamps selection against globals plus owned stages', () => {
    expect(clampGalleryStageIndex(99, 0)).toBe(5);
    expect(clampGalleryStageIndex(99, 2)).toBe(7);
    expect(clampGalleryStageIndex(-1, 2)).toBe(0);
  });
});
