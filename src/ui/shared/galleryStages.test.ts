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

    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => entry.scope)).toEqual([
      'global',
      'global',
      'global',
      'global',
    ]);
    expect(entries.map((entry) => entry.key)).toEqual([
      'global:executive-rumble',
      'global:mars-incorporated',
      'global:tablao-3000',
      'global:la-jaula-304',
    ]);
    expect(GLOBAL_GALLERY_STAGES.map((stage) => stage.assetPath)).toEqual([
      '/assets/stages/signature/executive-rumble-v2.png',
      '/assets/stages/signature/mars-incorporated-v1.png',
      '/assets/stages/signature/tablao-3000-v1.png',
      '/assets/stages/signature/la-jaula-304-v1.png',
    ]);
  });

  it('keeps owned stages after the read-only global catalog', () => {
    const entries = buildGalleryStageEntries([ownedStage('private-1')]);

    expect(entries).toHaveLength(5);
    expect(entries[4]).toMatchObject({
      scope: 'owned',
      key: 'owned:private-1',
      stage: { stageKey: 'private-1' },
    });
  });

  it('clamps selection against globals plus owned stages', () => {
    expect(clampGalleryStageIndex(99, 0)).toBe(3);
    expect(clampGalleryStageIndex(99, 2)).toBe(5);
    expect(clampGalleryStageIndex(-1, 2)).toBe(0);
  });
});
