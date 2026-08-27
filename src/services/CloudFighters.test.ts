import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ApiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ApiClient')>();
  return { ...actual, apiFetch: vi.fn() };
});

import { apiFetch, type ApiRequestContext } from './ApiClient.ts';
import {
  arcadeFighterPhotoHash,
  buildSpriteDownloadPlan,
  buildSpriteUploadPlan,
  cloudPlayableSpriteRefs,
  cloudSpritesForImport,
  formatCloudRosterSyncStatus,
  isCompleteCloudFighterRoster,
  isSourceOnlyCloudFighter,
  selectPlayableCloudSprites,
  shouldRefreshLocalFighter,
  syncFighterToCloud,
  type CloudSprite,
  type FingerprintedSprite,
} from './CloudFighters.ts';
import {
  closeSpriteCacheDatabase,
  configureSpriteCacheOwner,
  getAllSpritesForHash,
  getCachedMeta,
  hashPhoto,
  setCachedMeta,
  setCachedSprite,
  type CachedMeta,
  type CachedSprite,
} from './SpriteCache.ts';

function candidate(
  versionId: string,
  createdAt: number,
  contentHash: string,
  qualityTier: CachedSprite['qualityTier'] = 'champion',
  animationFormat: CachedSprite['animationFormat'] = 'legacy',
): FingerprintedSprite {
  return {
    contentHash,
    rawContentHash: `${contentHash}-raw`,
    sprite: {
      ownerScope: 'user:test',
      versionId,
      photoHash: 'fighter-hash',
      animationName: 'walk',
      qualityTier,
      pngBlob: new Blob(['sprite']),
      rawPngBlob: new Blob(['raw']),
      frameWidth: 256,
      frameHeight: 256,
      frameCount: 8,
      animationFormat,
      processingVersion: 5,
      createdAt,
    },
  };
}

function cloudSprite(
  contentHash: string,
  qualityTier: CloudSprite['qualityTier'] = 'champion',
  animationFormat: CloudSprite['animationFormat'] = 'legacy',
): CloudSprite {
  return {
    animationName: 'walk',
    qualityTier,
    contentHash,
    rawContentHash: `${contentHash}-raw`,
    url: 'https://api.insertplayer.ai/assets/walk.png',
    rawUrl: 'https://api.insertplayer.ai/assets/walk-raw.png',
    frameWidth: 256,
    frameHeight: 256,
    frameCount: 8,
    animationFormat,
    processingVersion: 5,
  };
}

describe('buildSpriteUploadPlan', () => {
  it('promotes an archived current version without re-uploading its bytes', () => {
    const oldVersion = candidate('old', 1, 'old-hash');
    const current = candidate('current', 2, 'current-hash');

    const plan = buildSpriteUploadPlan(
      [current, oldVersion],
      [current],
      [cloudSprite('old-hash'), cloudSprite('current-hash')],
      [cloudSprite('old-hash')],
    );

    expect(plan).toEqual([{ kind: 'promote', candidate: current }]);
  });

  it('does no writes when cloud history and current pointers already match', () => {
    const current = candidate('current', 2, 'current-hash');
    expect(buildSpriteUploadPlan(
      [current],
      [current],
      [cloudSprite('current-hash')],
      [cloudSprite('current-hash')],
    )).toEqual([]);
  });

  it('uploads a missing historical version as archive and a missing current once', () => {
    const archived = candidate('archived', 1, 'archive-hash', 'contender');
    const current = candidate('current', 2, 'current-hash');

    expect(buildSpriteUploadPlan([archived, current], [current], [], [])).toEqual([
      { kind: 'upload', candidate: archived, setCurrent: false },
      { kind: 'upload', candidate: current, setCurrent: true },
    ]);
  });

  it('never promotes a newer higher-tier candidate outside the authoritative playable set', () => {
    const remoteCurrent = candidate('remote-current', 100, 'a'.repeat(64), 'contender');
    const pendingCandidate = candidate('pending-candidate', 200, 'b'.repeat(64), 'champion');

    expect(buildSpriteUploadPlan(
      [remoteCurrent, pendingCandidate],
      [remoteCurrent],
      [cloudSprite('a'.repeat(64), 'contender')],
      [cloudSprite('a'.repeat(64), 'contender')],
    )).toEqual([{ kind: 'upload', candidate: pendingCandidate, setCurrent: false }]);
  });

  it('uploads non-current history without moving a matching current pointer', () => {
    const archived = candidate('archived', 1, 'archive-hash');
    const current = candidate('current', 2, 'current-hash');

    expect(buildSpriteUploadPlan(
      [current, archived],
      [current],
      [cloudSprite('current-hash')],
      [cloudSprite('current-hash')],
    )).toEqual([{ kind: 'upload', candidate: archived, setCurrent: false }]);
  });

  it('treats an explicit dense playback contract as distinct from identical legacy bytes', () => {
    const dense = candidate('dense', 2, 'same-hash', 'champion', 'video-dense-v1');

    expect(buildSpriteUploadPlan(
      [dense],
      [dense],
      [cloudSprite('same-hash', 'champion', 'legacy')],
      [cloudSprite('same-hash', 'champion', 'legacy')],
    )).toEqual([{ kind: 'upload', candidate: dense, setCurrent: true }]);
  });

  it('treats corrected frame metadata as a distinct immutable interpretation', () => {
    const corrected = candidate('corrected', 2, 'same-hash');
    corrected.sprite.frameCount = 12;

    expect(buildSpriteUploadPlan(
      [corrected],
      [corrected],
      [cloudSprite('same-hash')],
      [cloudSprite('same-hash')],
    )).toEqual([{ kind: 'upload', candidate: corrected, setCurrent: true }]);
  });
});

describe('buildSpriteDownloadPlan', () => {
  it('skips remote versions already present by content hash', () => {
    const local = candidate('local-version', 1, 'same-hash');
    expect(buildSpriteDownloadPlan(
      [cloudSprite('same-hash')],
      [local],
    )).toEqual([]);
  });

  it('downloads only a missing RAW blob for an imported version id', () => {
    const local = candidate('remote-version', 1, 'same-hash');
    local.sprite.rawPngBlob = undefined;
    const remote = { ...cloudSprite('same-hash'), id: 'remote-version' };
    expect(buildSpriteDownloadPlan([remote], [local])).toEqual([{
      remote,
      existing: local.sprite,
      downloadProcessed: false,
      downloadRaw: true,
    }]);
  });

  it('downloads both blobs for a genuinely missing remote version', () => {
    const remote = { ...cloudSprite('new-hash'), id: 'new-version' };
    expect(buildSpriteDownloadPlan([remote], [])).toEqual([{
      remote,
      existing: null,
      downloadProcessed: true,
      downloadRaw: true,
    }]);
  });

  it('defers raw-only work during the playable-first import', () => {
    const local = candidate('remote-version', 1, 'same-hash');
    local.sprite.rawPngBlob = undefined;
    const remote = { ...cloudSprite('same-hash'), id: 'remote-version' };

    expect(buildSpriteDownloadPlan([remote], [local], { includeRawAssets: false })).toEqual([]);
  });

  it('redownloads identical bytes when the remote playback contract changed', () => {
    const local = candidate('remote-version', 1, 'same-hash', 'champion', 'legacy');
    const remote = {
      ...cloudSprite('same-hash', 'champion', 'video-dense-v1'),
      id: 'remote-version',
    };

    expect(buildSpriteDownloadPlan([remote], [local])).toEqual([{
      remote,
      existing: null,
      downloadProcessed: true,
      downloadRaw: true,
    }]);
  });

  it('redownloads a public version with no content hash instead of trusting its stable id', () => {
    const local = candidate('remote-version', 1, 'old-hash');
    const remote = {
      ...cloudSprite('ignored-hash'),
      id: 'remote-version',
      contentHash: null,
      rawContentHash: null,
      rawUrl: null,
    };

    expect(buildSpriteDownloadPlan([remote], [local])).toEqual([{
      remote,
      existing: null,
      downloadProcessed: true,
      downloadRaw: false,
    }]);
  });
});

describe('official Arcade cache identity', () => {
  it('uses a deterministic account-scoped cache hash without exposing a private photo hash', () => {
    expect(arcadeFighterPhotoHash({
      id: 'fighter-official',
      name: 'Headline Fighter',
      qualityTier: 'champion',
      public: true,
      sources: {},
      sprites: [],
      arcade: {
        slug: 'headline-fighter',
        rank: 1,
        challengerLine: 'Fight the headline.',
        defaultPersonality: 'showboat',
        reference: {
          kind: 'licensed',
          sourceUrl: 'https://commons.wikimedia.org/wiki/File:Headline_Fighter.jpg',
          license: 'CC BY-SA 4.0',
          credit: 'Example Photographer (2026)',
        },
      },
    })).toBe('arcade:headline-fighter:fighter-official');
  });
});

describe('selectPlayableCloudSprites', () => {
  it('selects one highest-tier current sprite per animation', () => {
    const sprites = [
      { ...cloudSprite('idle-rookie', 'rookie'), animationName: 'idle' },
      { ...cloudSprite('walk-contender', 'contender'), animationName: 'walk' },
      { ...cloudSprite('idle-champion', 'champion'), animationName: 'idle' },
      { ...cloudSprite('walk-rookie', 'rookie'), animationName: 'walk' },
    ];

    expect(selectPlayableCloudSprites(sprites).map((sprite) => [
      sprite.animationName,
      sprite.qualityTier,
    ])).toEqual([
      ['idle', 'champion'],
      ['walk', 'contender'],
    ]);
  });

  it('uses the newest current pointer when an animation has equal-tier entries', () => {
    const older = {
      ...cloudSprite('older', 'champion'),
      createdAt: '2026-08-18T10:00:00.000Z',
    };
    const newer = {
      ...cloudSprite('newer', 'champion'),
      createdAt: '2026-08-18T11:00:00.000Z',
    };

    expect(selectPlayableCloudSprites([older, newer])).toEqual([newer]);
  });
});

describe('cloud roster sync status', () => {
  const fighter = {
    id: 'fighter-cloud',
    name: 'Nova QA',
    photoHash: 'fighter-hash',
    qualityTier: 'champion' as const,
    public: false,
    sources: {},
    sprites: [],
  };

  it('recognizes a preserved source-only fighter as an unfinished draft', () => {
    expect(isSourceOnlyCloudFighter(fighter)).toBe(true);
    expect(isSourceOnlyCloudFighter({
      ...fighter,
      spriteVersions: [{ ...cloudSprite('archived'), animationName: 'idle' }],
    })).toBe(false);
  });

  it('requires all eleven current pointers and never counts archived private versions', () => {
    const animationNames = [
      'idle', 'walk', 'high_punch', 'low_punch', 'high_kick', 'low_kick',
      'jump', 'crouch', 'hit', 'ko', 'victory',
    ];
    const completeSprites = animationNames.map((animationName) => ({
      ...cloudSprite(`current-${animationName}`),
      animationName,
    }));

    expect(isCompleteCloudFighterRoster({ ...fighter, sprites: completeSprites })).toBe(true);
    expect(isCompleteCloudFighterRoster({
      ...fighter,
      sprites: completeSprites.slice(0, 1),
      spriteVersions: completeSprites,
    })).toBe(false);
    expect(cloudSpritesForImport({
      ...fighter,
      sprites: completeSprites.slice(0, 1),
      spriteVersions: completeSprites,
    }, {
      includeArchivedVersions: false,
    })).toHaveLength(1);
    expect(() => cloudSpritesForImport({
      ...fighter,
      sprites: completeSprites,
      spriteVersions: [
        ...completeSprites,
        { ...completeSprites[0], id: 'private-candidate', contentHash: 'private-candidate' },
      ],
    }, {
      includeArchivedVersions: true,
    })).toThrow(/cannot be imported into the playable cache/i);
  });

  it('reports unfinished fighters without presenting them as download failures', () => {
    expect(formatCloudRosterSyncStatus({
      imported: 0,
      updated: 0,
      drafts: 7,
      failed: 0,
    })).toBe('7 unfinished fighters are safely stored for regeneration');
  });

  it('keeps real download failures and successful imports higher priority', () => {
    expect(formatCloudRosterSyncStatus({
      imported: 0,
      updated: 0,
      drafts: 7,
      failed: 1,
    })).toBe('Cloud sync incomplete: 1 fighter could not be downloaded');
    expect(formatCloudRosterSyncStatus({
      imported: 2,
      updated: 1,
      drafts: 7,
      failed: 0,
    })).toBe('Cloud synced: 2 imported, 1 updated');
  });
});

describe('shouldRefreshLocalFighter', () => {
  it('refreshes a migrated cloud fighter that has no exact current bindings', () => {
    expect(shouldRefreshLocalFighter({
      id: 'fighter-cloud',
      name: 'Nova QA',
      photoHash: 'fighter-hash',
      qualityTier: 'champion',
      public: false,
      sources: {},
      sprites: [{ ...cloudSprite('a'.repeat(64)), animationName: 'idle' }],
      updatedAt: '2026-08-19T02:00:00.000Z',
    }, {
      photoHash: 'fighter-hash',
      version: 1,
      characterName: 'Nova QA',
      qualityTier: 'champion',
      cloudFighterId: 'fighter-cloud',
      cloudSpriteVersionCount: 1,
      status: 'ready',
      animationsReady: ['idle'],
      createdAt: Date.parse('2026-08-19T01:00:00.000Z'),
      updatedAt: Date.parse('2026-08-19T02:00:00.000Z'),
    } as CachedMeta)).toBe(true);
  });

  it('does not refresh the playable cache solely for a new archived private version', () => {
    const currentHash = 'a'.repeat(64);
    const fighter = {
      id: 'fighter-cloud',
      name: 'Nova QA',
      photoHash: 'fighter-hash',
      qualityTier: 'champion' as const,
      public: false,
      sources: {},
      sprites: [{ ...cloudSprite(currentHash), animationName: 'idle' }],
      spriteVersions: [
        { ...cloudSprite(currentHash), animationName: 'idle' },
        { ...cloudSprite('archived'), animationName: 'idle' },
      ],
      updatedAt: '2026-08-19T02:00:00.000Z',
    };
    const existing = {
      photoHash: 'fighter-hash',
      version: 1,
      characterName: 'Nova QA',
      qualityTier: 'champion' as const,
      cloudFighterId: 'fighter-cloud',
      cloudSpriteVersionCount: 1,
      cloudPlayableSpriteRefs: cloudPlayableSpriteRefs(fighter.sprites),
      status: 'ready' as const,
      animationsReady: ['idle'],
      createdAt: Date.parse('2026-08-19T01:00:00.000Z'),
      updatedAt: Date.parse('2026-08-19T02:00:00.000Z'),
    } as CachedMeta;

    expect(shouldRefreshLocalFighter(fighter, existing)).toBe(false);
  });

  it('does not confuse three tier pointers with missing animation names', () => {
    const names = ['idle', 'walk', 'high_punch'];
    const sprites = (['rookie', 'contender', 'champion'] as const).flatMap((tier) =>
      names.map((name) => ({ ...cloudSprite('a'.repeat(64), tier), animationName: name })),
    );
    expect(shouldRefreshLocalFighter({
      id: 'fighter-cloud',
      name: 'Nova QA',
      photoHash: 'fighter-hash',
      qualityTier: 'champion',
      public: false,
      sources: {},
      sprites,
      updatedAt: '2026-08-19T02:00:00.000Z',
    }, {
      photoHash: 'fighter-hash',
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
      characterName: 'Nova QA',
      qualityTier: 'champion',
      cloudFighterId: 'fighter-cloud',
      cloudSpriteVersionCount: sprites.length,
      cloudPlayableSpriteRefs: cloudPlayableSpriteRefs(sprites),
      status: 'ready',
      animationsReady: names,
      createdAt: Date.parse('2026-08-19T01:00:00.000Z'),
      updatedAt: Date.parse('2026-08-19T02:00:00.000Z'),
    } as CachedMeta)).toBe(false);
  });
});

const SYNC_CACHE_DB_NAME = 'ai-street-fighter';
const SYNC_PHOTO_HASH = 'sync-original-photo';
const SYNC_CONTEXT: ApiRequestContext = {
  authRevision: -1,
  tokenGetter: null,
  providerSessionId: null,
  detached: true,
  apiBaseUrl: 'https://api.insertplayer.test',
};

function syncMeta(): CachedMeta {
  return {
    photoHash: SYNC_PHOTO_HASH,
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
    characterName: 'Original Local Fighter',
    qualityTier: 'champion',
    status: 'ready',
    animationsReady: ['walk'],
    createdAt: 100,
    updatedAt: 100,
  };
}

function syncSprite(): CachedSprite {
  const pngBytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x61, 0x75, 0x74, 0x68,
  ]);
  return {
    versionId: 'local-current-walk',
    photoHash: SYNC_PHOTO_HASH,
    animationName: 'walk',
    qualityTier: 'champion',
    pngBlob: new Blob([pngBytes], { type: 'image/png' }),
    frameWidth: 256,
    frameHeight: 256,
    frameCount: 8,
    animationFormat: 'legacy',
    processingVersion: 5,
    createdAt: 100,
  };
}

function createdCloudFighter() {
  return {
    fighter: {
      id: 'cloud-fighter-created',
      name: 'Original Local Fighter',
      photoHash: SYNC_PHOTO_HASH,
      qualityTier: 'champion' as const,
      public: false,
      sources: {},
      sourceHashes: {},
      sprites: [],
      spriteVersions: [],
    },
  };
}

async function resetSyncCache(): Promise<void> {
  await closeSpriteCacheDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SYNC_CACHE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Sync cache test database deletion was blocked'));
  });
  configureSpriteCacheOwner(null);
}

describe('first cloud association preserves the authoritative local playable set', () => {
  beforeEach(async () => {
    await resetSyncCache();
    vi.mocked(apiFetch).mockReset();
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.insertplayer.test');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await resetSyncCache();
  });

  it('keeps Original sprites playable when the first sprite upload fails after cloud creation', async () => {
    const meta = syncMeta();
    const sprite = syncSprite();
    await setCachedMeta(meta);
    await setCachedSprite(sprite, { preserveVersionId: true });
    const playableBeforeSync = await getAllSpritesForHash(SYNC_PHOTO_HASH);
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(Response.json(createdCloudFighter()))
      .mockRejectedValueOnce(new Error('sprite upload unavailable'));

    await expect(syncFighterToCloud(meta, playableBeforeSync, null, SYNC_CONTEXT))
      .rejects.toThrow('sprite upload unavailable');

    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2);
    expect((await getAllSpritesForHash(SYNC_PHOTO_HASH)).map((item) => item.versionId))
      .toEqual(['local-current-walk']);
    const persisted = await getCachedMeta(SYNC_PHOTO_HASH);
    expect(persisted?.cloudFighterId).toBe('cloud-fighter-created');
    expect(persisted?.cloudPlayableSpriteRefs?.walk.contentHash)
      .toBe(await hashPhoto(sprite.pngBlob));
  });

  it('keeps successful first sync pinned to the exact authoritative sprite hash', async () => {
    const meta = syncMeta();
    const sprite = syncSprite();
    await setCachedMeta(meta);
    await setCachedSprite(sprite, { preserveVersionId: true });
    const playableBeforeSync = await getAllSpritesForHash(SYNC_PHOTO_HASH);
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(Response.json(createdCloudFighter()))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    await expect(syncFighterToCloud(meta, playableBeforeSync, null, SYNC_CONTEXT))
      .resolves.toMatchObject({ status: 'synced', fighterId: 'cloud-fighter-created' });

    expect((await getAllSpritesForHash(SYNC_PHOTO_HASH)).map((item) => item.versionId))
      .toEqual(['local-current-walk']);
    expect((await getCachedMeta(SYNC_PHOTO_HASH))?.cloudPlayableSpriteRefs?.walk.contentHash)
      .toBe(await hashPhoto(sprite.pngBlob));
  });
});
