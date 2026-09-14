import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ApiClient.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ApiClient.ts')>();
  return { ...actual, apiFetch: vi.fn() };
});

import {
  ApiSessionChangedError,
  apiFetch,
  captureApiRequestContext,
  configureApiAuth,
} from './ApiClient.ts';
import {
  arcadeFighterPhotoHash,
  cloudPlayableSpriteRefs,
  type CloudFighter,
} from './CloudFighters.ts';
import {
  closeSpriteCacheDatabase,
  configureSpriteCacheOwner,
  getAllSpritesForHash,
  setCachedArchivedSprite,
  setCachedMeta,
  setCachedSprite,
  setCloudPlayableSpriteRefs,
  type CachedSprite,
} from './SpriteCache.ts';
import { prepareSpriteForExport } from './SpriteExportService.ts';
import { getBestCachedSpriteSheet } from './SpriteSheetSource.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function resetCache() {
  await closeSpriteCacheDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('ai-street-fighter');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Sprite export cache deletion was blocked'));
  });
  configureSpriteCacheOwner(null);
}

async function fixture(options: Partial<CachedSprite> = {}) {
  const fighter: CloudFighter = {
    id: 'official-fighter',
    name: 'Official Fighter',
    public: true,
    qualityTier: 'champion',
    sources: {},
    sprites: [],
    arcade: {
      slug: 'official-fighter', rank: 1, challengerLine: 'Ready', defaultPersonality: 'balanced',
      reference: { kind: 'generated', sourceUrl: null, license: 'Internal', credit: 'Studio' },
    },
  };
  const photoHash = arcadeFighterPhotoHash(fighter);
  await setCachedMeta({
    photoHash, version: 1, characterName: fighter.name, qualityTier: 'champion',
    cloudFighterId: fighter.id, cloudPlayableSpriteRefs: {},
    originalPhotoBlob: null, sideViewBlob: null, sideViewRawBlob: null,
    uprightViewBlob: null, uprightViewRawBlob: null, sideViewCleanBlob: null,
    crouchViewBlob: null, crouchViewRawBlob: null, crouchViewCleanBlob: null, noBgBlob: null,
    status: 'ready', animationsReady: ['high_kick'], createdAt: 1, updatedAt: 1,
  });
  await setCachedSprite({
    photoHash, versionId: 'current-kick', animationName: 'high_kick', qualityTier: 'champion',
    pngBlob: new Blob(['gameplay'], { type: 'image/png' }),
    frameWidth: 192, frameHeight: 256, frameCount: 23,
    animationFormat: 'video-dense-v1', processingVersion: 6, createdAt: 1,
    ...options,
  }, { preserveVersionId: true });
  const [sprite] = await getAllSpritesForHash(photoHash);
  fighter.sprites = [{
    id: sprite.versionId, animationName: sprite.animationName, qualityTier: sprite.qualityTier,
    url: 'https://api.example.test/gameplay.png', rawUrl: null,
    hqUrl: 'https://api.example.test/hq.png',
    frameWidth: sprite.frameWidth, frameHeight: sprite.frameHeight, frameCount: sprite.frameCount,
    hqFrameWidth: 768, hqFrameHeight: 1024, hqFrameCount: 12,
    animationFormat: sprite.animationFormat, processingVersion: sprite.processingVersion!,
    contentHash: sprite.contentHash,
  }];
  await setCloudPlayableSpriteRefs(photoHash, cloudPlayableSpriteRefs(fighter.sprites));
  return { fighter, sprite };
}

describe('best-quality sprite export preparation', () => {
  beforeEach(async () => {
    await resetCache();
    configureApiAuth(null);
    vi.mocked(apiFetch).mockReset();
  });

  afterEach(async () => {
    await resetCache();
    configureApiAuth(null);
  });

  it('waits for native HQ on the first click and preserves the selected version', async () => {
    const { sprite, fighter } = await fixture();
    const response = deferred<Response>();
    vi.mocked(apiFetch).mockReturnValueOnce(response.promise);
    let finished = false;
    const pending = prepareSpriteForExport(sprite, fighter).then((prepared) => {
      finished = true;
      return prepared;
    });
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(finished).toBe(false);
    response.resolve(new Response(new Blob(['native-hq'], { type: 'image/png' })));
    const prepared = await pending;
    expect(prepared.versionId).toBe(sprite.versionId);
    expect(getBestCachedSpriteSheet(prepared)).toMatchObject({
      frameWidth: 768, frameHeight: 1024, frameCount: 12, highDensity: true,
    });
    expect(await prepared.rawPngBlob?.text()).toBe('native-hq');
    expect(await prepared.pngBlob.text()).toBe('gameplay');
  });

  it('shares a pending preview request with concurrent exports and reuses hydrated cache', async () => {
    const { sprite, fighter } = await fixture();
    const response = deferred<Response>();
    vi.mocked(apiFetch).mockReturnValueOnce(response.promise);
    const first = prepareSpriteForExport(sprite, fighter);
    const second = prepareSpriteForExport(sprite, fighter);
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    response.resolve(new Response('native-hq'));
    const [preview, download] = await Promise.all([first, second]);
    expect(download).toBe(preview);
    expect(await (await prepareSpriteForExport(sprite, fighter)).rawPngBlob?.text()).toBe('native-hq');
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('uses already complete native HQ without fetching again', async () => {
    const { sprite, fighter } = await fixture({
      rawPngBlob: new Blob(['cached-hq']), rawFrameWidth: 768, rawFrameHeight: 1024, rawFrameCount: 12,
    });
    expect(await prepareSpriteForExport(sprite, fighter)).toBe(sprite);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it.each(['authentication', 'cache owner'])('rejects a changed %s during hydration', async (change) => {
    const { sprite, fighter } = await fixture();
    const response = deferred<Response>();
    vi.mocked(apiFetch).mockReturnValueOnce(response.promise);
    const pending = prepareSpriteForExport(sprite, fighter);
    const rejection = expect(pending).rejects.toBeInstanceOf(ApiSessionChangedError);
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    if (change === 'authentication') configureApiAuth(async () => 'other-user');
    else configureSpriteCacheOwner('other-user');
    response.resolve(new Response('native-hq'));
    await rejection;
  });

  it('rejects a stale request context before accessing an asset', async () => {
    const { sprite, fighter } = await fixture();
    const context = captureApiRequestContext();
    configureApiAuth(async () => 'new-user');
    await expect(prepareSpriteForExport(sprite, fighter, context)).rejects.toBeInstanceOf(ApiSessionChangedError);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('reports an advertised HQ fetch failure instead of saving gameplay quality and allows retry', async () => {
    const { sprite, fighter } = await fixture();
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(prepareSpriteForExport(sprite, fighter)).rejects.toThrow('503');
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('retried-hq'));
    expect(await (await prepareSpriteForExport(sprite, fighter)).rawPngBlob?.text()).toBe('retried-hq');
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the authoritative playable version when a newer archive has higher resolution', async () => {
    const { sprite, fighter } = await fixture();
    await setCachedArchivedSprite({
      ...sprite, versionId: 'unapproved-candidate', contentHash: 'f'.repeat(64), createdAt: 999,
      rawPngBlob: new Blob(['unapproved']), rawFrameWidth: 1536, rawFrameHeight: 2048, rawFrameCount: 12,
    }, { preserveVersionId: true });
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('approved-hq'));
    const prepared = await prepareSpriteForExport(sprite, fighter);
    expect(prepared.versionId).toBe('current-kick');
    expect(await prepared.rawPngBlob?.text()).toBe('approved-hq');
    expect((await getAllSpritesForHash(sprite.photoHash)).map((item) => item.versionId)).toEqual(['current-kick']);
  });

  it('never hydrates from archives after the playable animation was removed', async () => {
    const { sprite, fighter } = await fixture();
    await setCloudPlayableSpriteRefs(sprite.photoHash, {});
    await expect(prepareSpriteForExport(sprite, fighter)).rejects.toThrow('no longer selected');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('rejects a promoted remote payload even when its sprite ID stayed the same', async () => {
    const { sprite, fighter } = await fixture();
    fighter.sprites[0].contentHash = 'f'.repeat(64);
    await expect(prepareSpriteForExport(sprite, fighter)).rejects.toThrow('animation changed');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('rejects a different fighter or animation before downloading', async () => {
    const { sprite, fighter } = await fixture();
    await expect(prepareSpriteForExport(sprite, { ...fighter, id: 'different-fighter' })).rejects.toThrow('fighter changed');
    await expect(prepareSpriteForExport({ ...sprite, animationName: 'idle' }, fighter)).rejects.toThrow('animation changed');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('returns the approved source when no higher-quality asset is advertised', async () => {
    const { sprite, fighter } = await fixture();
    fighter.sprites[0].hqUrl = null;
    expect(await prepareSpriteForExport(sprite, fighter)).toBe(sprite);
    const legacy = { ...sprite, animationFormat: 'legacy' as const, rawPngBlob: new Blob(['uncleaned']) };
    expect(await prepareSpriteForExport(legacy)).toBe(legacy);
    expect(getBestCachedSpriteSheet(legacy).blob).toBe(legacy.pngBlob);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('rejects advertised HQ with missing or invalid native frame metadata', async () => {
    const { sprite, fighter } = await fixture();
    fighter.sprites[0].hqFrameWidth = 0;
    await expect(prepareSpriteForExport(sprite, fighter)).rejects.toThrow('best-quality animation is unavailable');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('loads an owned video animation native source after a gameplay-only cloud sync', async () => {
    const { sprite, fighter } = await fixture();
    fighter.arcade = undefined;
    fighter.photoHash = sprite.photoHash;
    fighter.public = false;
    Object.assign(fighter.sprites[0], {
      hqUrl: null, rawUrl: 'https://api.example.test/private-native.png',
      rawFrameWidth: 768, rawFrameHeight: 1024, rawFrameCount: 12,
    });
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('owned-native'));
    const prepared = await prepareSpriteForExport(sprite, fighter);
    expect(await prepared.rawPngBlob?.text()).toBe('owned-native');
    expect(apiFetch).toHaveBeenCalledWith(
      'https://api.example.test/private-native.png', {}, expect.anything(),
    );
    expect((await getAllSpritesForHash(sprite.photoHash)).map((item) => item.versionId)).toEqual(['current-kick']);
  });

  it('ignores an owned legacy provider RAW source rather than exporting unfinished pixels', async () => {
    const { sprite, fighter } = await fixture({ animationFormat: 'legacy' });
    fighter.arcade = undefined;
    fighter.photoHash = sprite.photoHash;
    Object.assign(fighter.sprites[0], {
      rawUrl: 'https://api.example.test/uncleaned.png',
      rawFrameWidth: 768, rawFrameHeight: 1024, rawFrameCount: 12,
    });
    expect(await prepareSpriteForExport(sprite, fighter)).toBe(sprite);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('requires the private manifest to match the owned fighter', async () => {
    const { sprite, fighter } = await fixture();
    fighter.arcade = undefined;
    fighter.photoHash = 'different-private-fighter';
    await expect(prepareSpriteForExport(sprite, fighter)).rejects.toThrow('fighter changed');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('does not restore an animation removed from the playable set while HQ was downloading', async () => {
    const { sprite, fighter } = await fixture();
    const response = deferred<Response>();
    vi.mocked(apiFetch).mockReturnValueOnce(response.promise);
    const pending = prepareSpriteForExport(sprite, fighter);
    const rejection = expect(pending).rejects.toThrow('changed while');
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    await setCloudPlayableSpriteRefs(sprite.photoHash, {});
    response.resolve(new Response('native-hq'));
    await rejection;
    expect(await getAllSpritesForHash(sprite.photoHash)).toEqual([]);
  });
});
