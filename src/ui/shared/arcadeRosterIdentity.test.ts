import { describe, expect, it } from 'vitest';
import type { CachedMeta } from '../../services/SpriteCache.ts';
import {
  arcadeRosterFighterIds,
  galleryFighterIndexForSelection,
  isGlobalRosterMeta,
  markArcadeManagedMetas,
  ownedRosterMetas,
  visibleGalleryMetas,
} from './arcadeRosterIdentity.ts';

function meta(photoHash: string, cloudFighterId: string | null = null): CachedMeta {
  return {
    photoHash,
    cloudFighterId,
    version: 1,
    originalPhotoBlob: null,
    sideViewBlob: null,
    sideViewRawBlob: null,
    uprightViewBlob: null,
    uprightViewRawBlob: null,
    sideViewCleanBlob: null,
    crouchViewBlob: null,
    crouchViewRawBlob: null,
    crouchViewCleanBlob: null,
    noBgBlob: null,
    characterName: photoHash,
    qualityTier: 'champion',
    status: 'ready',
    animationsReady: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('Arcade roster identity', () => {
  it('recognizes both the public cache and the private owner backing row', () => {
    const publicCache = meta('arcade:elon-musk:elon-id', 'elon-id');
    const privateBacking = meta('private-photo-hash', 'elon-id');
    const ids = arcadeRosterFighterIds(
      [publicCache, privateBacking],
      [{ id: 'elon-id' }],
    );

    expect(isGlobalRosterMeta(publicCache, ids)).toBe(true);
    expect(isGlobalRosterMeta(privateBacking, ids)).toBe(true);
  });

  it('keeps only genuine personal fighters in the owned roster', () => {
    const publicCache = meta('arcade:elon-musk:elon-id', 'elon-id');
    const privateBacking = meta('private-photo-hash', 'elon-id');
    const personal = meta('personal-photo-hash', 'personal-id');

    expect(ownedRosterMetas(
      [publicCache, privateBacking, personal],
      [{ id: 'elon-id' }],
    )).toEqual([personal]);
    expect(visibleGalleryMetas(
      [publicCache, privateBacking, personal],
      [{ id: 'elon-id' }],
    )).toEqual([publicCache, personal]);
  });

  it('uses a saved public cache to hide its private duplicate offline', () => {
    const publicCache = meta('arcade:donald-trump:trump-id', 'trump-id');
    const privateBacking = meta('private-trump-photo', 'trump-id');

    expect(ownedRosterMetas([publicCache, privateBacking], [])).toEqual([]);
    expect(visibleGalleryMetas([publicCache, privateBacking], [])).toEqual([publicCache]);
  });

  it('persists enough identity to keep a private backing row read-only offline', () => {
    const privateBacking = meta('private-rosalia-photo', 'rosalia-id');
    const marked = markArcadeManagedMetas([privateBacking], [{ id: 'rosalia-id' }]);

    expect(marked.changed).toHaveLength(1);
    expect(marked.metas[0]?.cloudManagement).toBe('arcade');
    expect(ownedRosterMetas(marked.metas, [])).toEqual([]);
    expect(visibleGalleryMetas(marked.metas, [])).toEqual([]);
  });

  it('preserves the selected fighter by identity when background sync reorders the list', () => {
    const before = [meta('personal-photo'), meta('arcade:elon-musk:elon-id', 'elon-id')];
    const after = [meta('new-cloud-photo'), ...before];

    expect(galleryFighterIndexForSelection(after, 'arcade:elon-musk:elon-id', 1)).toBe(2);
  });
});
