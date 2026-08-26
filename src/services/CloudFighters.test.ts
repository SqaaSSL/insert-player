import { describe, expect, it } from 'vitest';
import {
  arcadeFighterPhotoHash,
  buildSpriteDownloadPlan,
  buildSpriteUploadPlan,
  formatCloudRosterSyncStatus,
  isSourceOnlyCloudFighter,
  selectPlayableCloudSprites,
  shouldRefreshLocalFighter,
  type CloudSprite,
  type FingerprintedSprite,
} from './CloudFighters.ts';
import type { CachedMeta, CachedSprite } from './SpriteCache.ts';

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
      { kind: 'upload', candidate: archived, setCurrent: true },
      { kind: 'upload', candidate: current, setCurrent: true },
    ]);
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
  it('resumes an incomplete archived-version hydration', () => {
    const fighter = {
      id: 'fighter-cloud',
      name: 'Nova QA',
      photoHash: 'fighter-hash',
      qualityTier: 'champion' as const,
      public: false,
      sources: {},
      sprites: [{ ...cloudSprite('current'), animationName: 'idle' }],
      spriteVersions: [
        { ...cloudSprite('current'), animationName: 'idle' },
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
      status: 'ready' as const,
      animationsReady: ['idle'],
      createdAt: Date.parse('2026-08-19T01:00:00.000Z'),
      updatedAt: Date.parse('2026-08-19T02:00:00.000Z'),
    } as CachedMeta;

    expect(shouldRefreshLocalFighter(fighter, existing)).toBe(true);
  });

  it('does not confuse three tier pointers with missing animation names', () => {
    const names = ['idle', 'walk', 'high_punch'];
    const sprites = (['rookie', 'contender', 'champion'] as const).flatMap((tier) =>
      names.map((name) => ({ ...cloudSprite(`${tier}-${name}`, tier), animationName: name })),
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
      status: 'ready',
      animationsReady: names,
      createdAt: Date.parse('2026-08-19T01:00:00.000Z'),
      updatedAt: Date.parse('2026-08-19T02:00:00.000Z'),
    } as CachedMeta)).toBe(false);
  });
});
