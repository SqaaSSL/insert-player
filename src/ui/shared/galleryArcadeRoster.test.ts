import { describe, expect, it, vi } from 'vitest';
import type { CloudFighter } from '../../services/CloudFighters.ts';
import type { CachedMeta } from '../../services/SpriteCache.ts';
import {
  ensureGalleryArcadeFighterReady,
  findCachedArcadeMeta,
} from './galleryArcadeRoster.ts';

function fighter(): CloudFighter {
  return {
    id: 'elon-id',
    arcade: {
      slug: 'elon-musk',
      rank: 2,
      challengerLine: 'Mars awaits',
      defaultPersonality: 'showboat',
      reference: {
        kind: 'generated',
        sourceUrl: null,
        license: 'Internal',
        credit: 'Insert Player',
      },
    },
    name: 'Elon Musk',
    qualityTier: 'champion',
    public: true,
    sources: {},
    sprites: [],
  };
}

function meta(photoHash: string, status: CachedMeta['status'] = 'ready'): CachedMeta {
  return {
    photoHash,
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
    characterName: 'Elon Musk',
    qualityTier: 'champion',
    status,
    animationsReady: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('Gallery Arcade roster cache', () => {
  it('matches current and legacy cached globals without treating them as owned fighters', () => {
    const current = meta('arcade:elon-musk:elon-id');
    const legacy = meta('arcade:elon-musk');
    expect(findCachedArcadeMeta([current], fighter())).toBe(current);
    expect(findCachedArcadeMeta([legacy], fighter())).toBe(legacy);
    expect(findCachedArcadeMeta([legacy, current], fighter())).toBe(current);
    expect(findCachedArcadeMeta([meta('owned-photo')], fighter())).toBeNull();
  });

  it('checks the remote manifest even when the global is already cached', async () => {
    const existing = meta('arcade:elon-musk:elon-id');
    const refreshed = { ...existing, updatedAt: 2 };
    const download = vi.fn().mockResolvedValue(undefined);
    const result = await ensureGalleryArcadeFighterReady(fighter(), {
      download,
      getMeta: vi.fn().mockResolvedValue(refreshed),
    });

    expect(download).toHaveBeenCalledOnce();
    expect(result).toEqual({
      meta: refreshed,
      photoHash: existing.photoHash,
    });
  });

  it('trusts only the current cache key after replacing a legacy entry', async () => {
    const current = meta('arcade:elon-musk:elon-id');
    const result = await ensureGalleryArcadeFighterReady(fighter(), {
      download: vi.fn().mockResolvedValue(undefined),
      getMeta: vi.fn().mockResolvedValue(current),
    });

    expect(result.meta).toBe(current);
  });

  it('reports refresh failures and incomplete playable downloads', async () => {
    const existing = meta('arcade:elon-musk:elon-id');
    await expect(ensureGalleryArcadeFighterReady(fighter(), {
      download: vi.fn().mockRejectedValue(new Error('offline')),
      getMeta: vi.fn(),
    })).rejects.toThrow('offline');

    await expect(ensureGalleryArcadeFighterReady(fighter(), {
      download: vi.fn().mockResolvedValue(undefined),
      getMeta: vi.fn().mockResolvedValue(meta(existing.photoHash, 'sprites_generating')),
    })).rejects.toThrow('the playable assets did not finish downloading');
  });
});
