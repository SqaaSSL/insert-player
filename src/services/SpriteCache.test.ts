import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  claimLocalSpriteCacheForCurrentOwner,
  clearCache,
  closeSpriteCacheDatabase,
  configureSpriteCacheOwner,
  getAllCachedMetas,
  getAllSpritesForHash,
  getAllSpriteVersionsForHash,
  getCachedMeta,
  selectPlayableCachedSprites,
  setCachedArchivedSprite,
  setCachedMeta,
  setCachedSprite,
  type CachedMeta,
  type CachedSprite,
} from './SpriteCache';

const DB_NAME = 'ai-street-fighter';
const PHOTO_HASH = 'same-photo-hash';

function blob(label: string): Blob {
  return new Blob([label], { type: 'image/png' });
}

function meta(name: string, overrides: Partial<CachedMeta> = {}): CachedMeta {
  const now = Date.now();
  return {
    photoHash: PHOTO_HASH,
    version: 1,
    originalPhotoBlob: blob(`${name}-original`),
    sideViewBlob: blob(`${name}-side`),
    sideViewRawBlob: null,
    uprightViewBlob: blob(`${name}-upright`),
    uprightViewRawBlob: null,
    sideViewCleanBlob: blob(`${name}-side-clean`),
    crouchViewBlob: blob(`${name}-crouch`),
    crouchViewRawBlob: null,
    crouchViewCleanBlob: blob(`${name}-crouch-clean`),
    noBgBlob: null,
    characterName: name,
    qualityTier: 'rookie',
    status: 'ready',
    animationsReady: ['idle'],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function sprite(versionId: string, animationName = 'idle'): CachedSprite {
  return {
    versionId,
    photoHash: PHOTO_HASH,
    animationName,
    qualityTier: 'rookie',
    pngBlob: blob(versionId),
    frameWidth: 64,
    frameHeight: 64,
    frameCount: 4,
    processingVersion: 3,
    createdAt: Date.now(),
  };
}

async function deleteDatabase(): Promise<void> {
  await closeSpriteCacheDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Test database deletion was blocked'));
  });
  configureSpriteCacheOwner(null);
}

async function createLegacyV4Cache(): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 4);
    request.onupgradeneeded = () => {
      const database = request.result;
      const sprites = database.createObjectStore('sprites', { keyPath: 'versionId' });
      sprites.createIndex('byHash', 'photoHash');
      sprites.createIndex('byHashAndAnim', ['photoHash', 'animationName']);
      sprites.createIndex('byHashAnimTier', ['photoHash', 'animationName', 'qualityTier']);
      database.createObjectStore('intros', { keyPath: 'photoHash' });
      database.createObjectStore('meta', { keyPath: 'photoHash' });
      database.createObjectStore('stages', { keyPath: 'stageKey' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const tx = db.transaction(['sprites', 'meta'], 'readwrite');
  tx.objectStore('meta').put(meta('Legacy Fighter'));
  tx.objectStore('sprites').put(sprite('legacy-v1'));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

beforeEach(async () => {
  await deleteDatabase();
});

describe('account-scoped sprite cache', () => {
  it('requires the processed hash and playback contract rather than a stable cloud row id', () => {
    const ref = {
      versionId: 'stable-row-id',
      contentHash: 'a'.repeat(64),
      animationName: 'idle',
      qualityTier: 'champion' as const,
      frameWidth: 64,
      frameHeight: 64,
      frameCount: 4,
      animationFormat: 'legacy' as const,
      processingVersion: 3,
    };
    const wrongHash = {
      ...sprite('stable-row-id'),
      qualityTier: 'champion' as const,
      contentHash: 'b'.repeat(64),
    };
    const wrongContract = {
      ...sprite('different-local-id'),
      qualityTier: 'champion' as const,
      contentHash: 'a'.repeat(64),
      frameCount: 8,
    };
    const exactBytesAndContract = {
      ...sprite('different-local-id'),
      qualityTier: 'champion' as const,
      contentHash: 'a'.repeat(64),
    };

    expect(selectPlayableCachedSprites([wrongHash, wrongContract], { idle: ref })).toEqual([]);
    expect(selectPlayableCachedSprites([wrongHash, exactBytesAndContract], { idle: ref }))
      .toEqual([exactBytesAndContract]);
  });

  it('plays the exact remote-current sprite while keeping a newer archived candidate', async () => {
    const remoteCurrent = {
      ...sprite('stable-current'),
      qualityTier: 'champion' as const,
      contentHash: 'a'.repeat(64),
      createdAt: 100,
    };
    const pendingCandidate = {
      ...sprite('pending-review-candidate'),
      qualityTier: 'champion' as const,
      contentHash: 'b'.repeat(64),
      createdAt: 200,
    };
    await setCachedArchivedSprite(remoteCurrent, { preserveVersionId: true });
    await setCachedArchivedSprite(pendingCandidate, { preserveVersionId: true });
    await setCachedMeta(meta('Cloud Fighter', {
      cloudFighterId: 'cloud-fighter',
      cloudPlayableSpriteRefs: {
        idle: {
          versionId: 'stable-current',
          contentHash: 'a'.repeat(64),
          animationName: 'idle',
          qualityTier: 'champion',
          frameWidth: 64,
          frameHeight: 64,
          frameCount: 4,
          animationFormat: 'legacy',
          processingVersion: 3,
        },
      },
    }));

    expect(await getAllSpriteVersionsForHash(PHOTO_HASH)).toHaveLength(2);
    expect((await getAllSpritesForHash(PHOTO_HASH)).map((item) => item.versionId))
      .toEqual(['stable-current']);
  });

  it('fails closed for a cloud fighter without an exact current binding', async () => {
    await setCachedArchivedSprite({
      ...sprite('unapproved-only'),
      contentHash: 'b'.repeat(64),
    }, { preserveVersionId: true });
    await setCachedMeta(meta('Migrated Cloud Fighter', { cloudFighterId: 'cloud-fighter' }));

    expect(await getAllSpritesForHash(PHOTO_HASH)).toEqual([]);
  });

  it('keeps historical best-version selection for an Original local fighter', async () => {
    await setCachedMeta(meta('Original Fighter'));
    await setCachedSprite({ ...sprite('older'), createdAt: 100 }, { preserveVersionId: true });
    await setCachedSprite({ ...sprite('newer'), createdAt: 200 }, { preserveVersionId: true });

    expect((await getAllSpritesForHash(PHOTO_HASH)).map((item) => item.versionId)).toEqual(['newer']);
  });

  it('makes an intentional local retry current without letting a stale meta write undo it', async () => {
    await setCachedArchivedSprite({
      ...sprite('remote-current'),
      contentHash: 'a'.repeat(64),
    }, { preserveVersionId: true });
    await setCachedMeta(meta('Cloud Fighter', {
      cloudFighterId: 'cloud-fighter',
      cloudPlayableSpriteRefs: {
        idle: {
          versionId: 'remote-current',
          contentHash: 'a'.repeat(64),
          animationName: 'idle',
          qualityTier: 'rookie',
          frameWidth: 64,
          frameHeight: 64,
          frameCount: 4,
          animationFormat: 'legacy',
          processingVersion: 3,
        },
      },
    }));
    const staleMeta = await getCachedMeta(PHOTO_HASH);
    expect(staleMeta).not.toBeNull();

    await setCachedSprite(sprite('intentional-local-retry'), { preserveVersionId: true });
    await setCachedMeta({ ...staleMeta!, characterName: 'Cloud Fighter Renamed' });

    expect((await getAllSpritesForHash(PHOTO_HASH)).map((item) => item.versionId))
      .toEqual(['intentional-local-retry']);
    expect((await getCachedMeta(PHOTO_HASH))?.cloudPlayableSpriteRefs?.idle.contentHash)
      .not.toBe('a'.repeat(64));
  });

  it('claims every local sprite version and hides account data from other users', async () => {
    await setCachedMeta(meta('Guest Fighter'));
    await setCachedSprite(sprite('guest-v1'), { preserveVersionId: true });
    await setCachedSprite(sprite('guest-v2', 'walk'), { preserveVersionId: true });

    configureSpriteCacheOwner('user_a');
    await claimLocalSpriteCacheForCurrentOwner();

    expect((await getCachedMeta(PHOTO_HASH))?.characterName).toBe('Guest Fighter');
    expect(await getAllSpriteVersionsForHash(PHOTO_HASH)).toHaveLength(2);

    configureSpriteCacheOwner('user_b');
    expect(await getAllCachedMetas()).toEqual([]);
    expect(await getAllSpriteVersionsForHash(PHOTO_HASH)).toEqual([]);
    await setCachedMeta(meta('User B Fighter'));
    await setCachedSprite(sprite('user-b-v1'), { preserveVersionId: true });

    configureSpriteCacheOwner('user_a');
    expect((await getCachedMeta(PHOTO_HASH))?.characterName).toBe('Guest Fighter');
    expect(await getAllSpriteVersionsForHash(PHOTO_HASH)).toHaveLength(2);

    configureSpriteCacheOwner('user_b');
    expect((await getCachedMeta(PHOTO_HASH))?.characterName).toBe('User B Fighter');
    expect(await getAllSpriteVersionsForHash(PHOTO_HASH)).toHaveLength(1);
  });

  it('migrates the unscoped v4 cache into local ownership without deleting versions', async () => {
    await createLegacyV4Cache();

    expect((await getCachedMeta(PHOTO_HASH))?.characterName).toBe('Legacy Fighter');
    const migratedVersions = await getAllSpriteVersionsForHash(PHOTO_HASH);
    expect(migratedVersions).toHaveLength(1);
    expect(migratedVersions[0]?.animationFormat).toBe('legacy');

    configureSpriteCacheOwner('user_a');
    await claimLocalSpriteCacheForCurrentOwner();
    expect((await getCachedMeta(PHOTO_HASH))?.characterName).toBe('Legacy Fighter');
    expect((await getAllSpriteVersionsForHash(PHOTO_HASH))[0]?.versionId).toBe('legacy-v1');

    configureSpriteCacheOwner(null);
    expect(await getAllCachedMetas()).toEqual([]);
  });

  it('persists an explicit dense-video animation format independently of processing version', async () => {
    await setCachedSprite({
      ...sprite('dense-v1', 'walk'),
      animationFormat: 'video-dense-v1',
      processingVersion: 5,
    }, { preserveVersionId: true });

    const versions = await getAllSpriteVersionsForHash(PHOTO_HASH);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      animationName: 'walk',
      animationFormat: 'video-dense-v1',
      processingVersion: 5,
    });
  });

  it('merges a local collision without dropping either sprite version', async () => {
    configureSpriteCacheOwner('user_a');
    await setCachedMeta(meta('Cloud Fighter', {
      qualityTier: 'champion',
      cloudFighterId: 'cloud-fighter-a',
      animationsReady: ['idle'],
      updatedAt: 100,
    }));
    await setCachedSprite(sprite('shared-version-id'), { preserveVersionId: true });

    configureSpriteCacheOwner(null);
    await setCachedMeta(meta('Guest Retry', {
      animationsReady: ['walk'],
      updatedAt: 200,
    }));
    await setCachedSprite(sprite('shared-version-id', 'walk'), { preserveVersionId: true });

    configureSpriteCacheOwner('user_a');
    await claimLocalSpriteCacheForCurrentOwner();
    const merged = await getCachedMeta(PHOTO_HASH);
    const versions = await getAllSpriteVersionsForHash(PHOTO_HASH);

    expect(merged?.cloudFighterId).toBe('cloud-fighter-a');
    expect(merged?.qualityTier).toBe('champion');
    expect(new Set(merged?.animationsReady)).toEqual(new Set(['idle', 'walk']));
    expect(versions).toHaveLength(2);
    expect(new Set(versions.map((item) => item.animationName))).toEqual(new Set(['idle', 'walk']));
  });

  it('clears only the active account scope', async () => {
    configureSpriteCacheOwner('user_a');
    await setCachedMeta(meta('User A'));
    configureSpriteCacheOwner('user_b');
    await setCachedMeta(meta('User B'));

    configureSpriteCacheOwner('user_a');
    await clearCache();
    expect(await getAllCachedMetas()).toEqual([]);

    configureSpriteCacheOwner('user_b');
    expect((await getCachedMeta(PHOTO_HASH))?.characterName).toBe('User B');
  });

  it('rejects a stale write after the active Clerk user changes', async () => {
    configureSpriteCacheOwner('user_a');
    const staleMeta = meta('User A');
    await setCachedMeta(staleMeta);

    configureSpriteCacheOwner('user_b');
    staleMeta.characterName = 'Leaked into User B';
    await expect(setCachedMeta(staleMeta)).rejects.toThrow('Player changed');
    expect(await getAllCachedMetas()).toEqual([]);

    configureSpriteCacheOwner('user_a');
    expect((await getCachedMeta(PHOTO_HASH))?.characterName).toBe('User A');
  });
});
