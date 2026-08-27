import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import {
  cloneCommunityFighter,
  getAsset,
  getCommunityFighter,
  getPublicArcadeSpriteRawAsset,
  getPublicFighterSourceAsset,
  getPublicFighterSpriteAsset,
  listArcadeFighters,
  listAdminArcadeFighters,
  listCommunityFighters,
  listOwnedCommunityFighterIds,
  listFighters,
  promoteFighterSpriteVersion,
  reportCommunityFighter,
  shareCommunityFighterPage,
  uploadFighterSource,
  uploadFighterSprite,
  upsertAdminArcadeFighter,
} from './fighters';
import type { AuthContext, Env, PublicAuthContext, User } from './types';

const SCHEMA = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    clerk_user_id TEXT,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    email TEXT,
    plan_tier TEXT NOT NULL DEFAULT 'free',
    credits_balance INTEGER NOT NULL DEFAULT 0,
    free_rookie_generations_used INTEGER NOT NULL DEFAULT 0,
    elo_rating INTEGER NOT NULL DEFAULT 1200,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    win_streak INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    total_kos INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE fighters (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'Fighter',
    photo_hash TEXT NOT NULL,
    quality_tier TEXT NOT NULL DEFAULT 'contender',
    public_flag INTEGER NOT NULL DEFAULT 0,
    original_blob_key TEXT,
    side_view_blob_key TEXT,
    side_view_raw_blob_key TEXT,
    upright_view_blob_key TEXT,
    upright_view_raw_blob_key TEXT,
    crouch_view_blob_key TEXT,
    crouch_view_raw_blob_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(owner_user_id, photo_hash)
  );

  CREATE TABLE sprites (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
    animation_name TEXT NOT NULL,
    quality_tier TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    raw_blob_key TEXT,
    content_hash TEXT,
    raw_content_hash TEXT,
    frame_w INTEGER NOT NULL,
    frame_h INTEGER NOT NULL,
    frame_count INTEGER NOT NULL,
    animation_format TEXT NOT NULL DEFAULT 'legacy' CHECK (animation_format IN ('legacy', 'video-dense-v1')),
    processing_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(fighter_id, animation_name, quality_tier)
  );

  CREATE TABLE sprite_versions (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
    animation_name TEXT NOT NULL,
    quality_tier TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    raw_blob_key TEXT,
    content_hash TEXT,
    raw_content_hash TEXT,
    frame_w INTEGER NOT NULL,
    frame_h INTEGER NOT NULL,
    frame_count INTEGER NOT NULL,
    animation_format TEXT NOT NULL DEFAULT 'legacy' CHECK (animation_format IN ('legacy', 'video-dense-v1')),
    processing_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX idx_sprite_versions_content
  ON sprite_versions (
    fighter_id,
    animation_name,
    quality_tier,
    animation_format,
    frame_w,
    frame_h,
    frame_count,
    processing_version,
    content_hash,
    COALESCE(raw_content_hash, '')
  )
  WHERE content_hash IS NOT NULL;

  CREATE TABLE source_versions (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    content_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX idx_source_versions_content
  ON source_versions (fighter_id, kind, content_hash)
  WHERE content_hash IS NOT NULL;

  CREATE TABLE stages (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT 'Stage',
    kind TEXT NOT NULL DEFAULT 'photo',
    blob_key TEXT NOT NULL,
    public_flag INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE arcade_fighters (
    fighter_id TEXT PRIMARY KEY REFERENCES fighters(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    challenger_line TEXT NOT NULL,
    default_personality TEXT NOT NULL DEFAULT 'balanced',
    reference_kind TEXT NOT NULL,
    reference_source_url TEXT,
    reference_license TEXT NOT NULL,
    reference_credit TEXT NOT NULL,
    generation_prompt TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX idx_arcade_fighters_live_slug
    ON arcade_fighters(slug)
    WHERE status IN ('draft', 'active');

  CREATE TABLE generation_artifact_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
    creation_flow TEXT NOT NULL CHECK (creation_flow IN ('original', 'video')),
    source_manifest_json TEXT
  );
`;

function fakeUser(): User {
  return {
    id: 'user-target',
    clerk_user_id: 'user-target',
    display_name: 'Target Player',
    avatar_url: null,
    email: 'target@example.com',
    plan_tier: 'free',
    credits_balance: 0,
    free_rookie_generations_used: 0,
    stripe_customer_id: null,
    elo_rating: 1200,
    wins: 0,
    losses: 0,
    win_streak: 0,
    best_streak: 0,
    total_kos: 0,
    created_at: '2026-08-17T00:00:00.000Z',
    updated_at: '2026-08-17T00:00:00.000Z',
  };
}

const auth: AuthContext = {
  userId: 'user-target',
  user: fakeUser(),
  claims: {},
};

const adminAuth: AuthContext = {
  ...auth,
  user: { ...auth.user, plan_tier: 'admin' },
};

function publicAuth(userId: string | null = null): PublicAuthContext {
  return {
    userId,
    rateLimitKey: userId ? `user:${userId}` : 'anon:test',
    user: userId === auth.userId ? auth.user : null,
    claims: userId === auth.userId ? {} : null,
  };
}

function tinyPngFile(name: string): File {
  return new File([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
  ], name, { type: 'image/png' });
}

function sourceRequest(kind = 'side'): Request {
  const formData = new FormData();
  formData.set('kind', kind);
  formData.set('file', tinyPngFile(`${kind}.png`));
  return new Request('https://api.insertplayer.ai/api/fighters/fighter-target/sources', {
    method: 'POST',
    body: formData,
  });
}

function spriteRequest(options: {
  setCurrent?: boolean;
  marker?: number;
  animationFormat?: 'legacy' | 'video-dense-v1';
  frameWidth?: number;
  frameHeight?: number;
  frameCount?: number;
  processingVersion?: number;
} = {}): Request {
  const marker = options.marker ?? 4;
  const formData = new FormData();
  formData.set('animationName', 'idle');
  formData.set('qualityTier', 'contender');
  formData.set('frameWidth', String(options.frameWidth ?? 256));
  formData.set('frameHeight', String(options.frameHeight ?? 256));
  formData.set('frameCount', String(options.frameCount ?? 8));
  if (options.animationFormat) formData.set('animationFormat', options.animationFormat);
  formData.set('processingVersion', String(options.processingVersion ?? 4));
  formData.set('file', new File([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker]),
  ], 'idle.png', { type: 'image/png' }));
  formData.set('rawFile', new File([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker, 0xff]),
  ], 'idle-raw.png', { type: 'image/png' }));
  if (options.setCurrent !== undefined) formData.set('setCurrent', String(options.setCurrent));
  return new Request('https://api.insertplayer.ai/api/fighters/fighter-target/sprites', {
    method: 'POST',
    body: formData,
  });
}

function spritePromotionRequest(
  contentHash: string,
  rawContentHash: string | null,
  animationFormat?: 'legacy' | 'video-dense-v1',
  metadata?: {
    frameWidth: number;
    frameHeight: number;
    frameCount: number;
    processingVersion: number;
  },
): Request {
  return new Request('https://api.insertplayer.ai/api/fighters/fighter-target/sprites', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      animationName: 'idle',
      qualityTier: 'contender',
      contentHash,
      rawContentHash,
      ...(animationFormat ? { animationFormat } : {}),
      ...metadata,
    }),
  });
}

function arcadeRequest(status: 'draft' | 'active' | 'retired'): Request {
  return new Request('https://api.insertplayer.ai/api/admin/arcade/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug: 'headline-fighter',
      rank: 1,
      challengerLine: 'The headline fight starts here.',
      defaultPersonality: 'showboat',
      reference: {
        kind: 'licensed',
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:Headline_Fighter.jpg',
        license: 'CC BY-SA 4.0',
        credit: 'Example Photographer (2026)',
      },
      generationPrompt: 'Transform the person in this licensed photo into a clearly synthetic premium realistic 2.5D full-body arcade avatar. Preserve recognizable facial structure without caricature. Show the complete figure on a flat pure green background with no text, logos, props, shadows, or documentary context.',
      status,
    }),
  });
}

async function createBindings(): Promise<{
  mf: Miniflare;
  db: D1Database;
  bucket: R2Bucket;
  env: Env;
}> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: 'fighter-upload-test',
        compatibilityDate: '2026-08-17',
        manifest: {
          mainModule: 'index.js',
          modules: {
            'index.js': {
              type: 'esm',
              contents: 'export default { fetch() { return new Response("ok"); } };',
            },
          },
        },
        env: {
          DB: { type: 'd1', id: 'test-db' },
          SPRITES: { type: 'r2', name: 'test-assets' },
        },
      },
    }],
  });
  const db = await mf.getD1Database('DB');
  const miniflareBucket = await mf.getR2Bucket('SPRITES');
  const bucket = miniflareBucket as unknown as R2Bucket;
  await db.batch(SCHEMA
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => db.prepare(statement)));
  await db.batch([
    db.prepare('INSERT INTO users (id, clerk_user_id, display_name, avatar_url) VALUES (?, ?, ?, ?)')
      .bind(auth.userId, auth.userId, auth.user.display_name, 'https://img.clerk.com/private-profile.png'),
    db.prepare(`
      INSERT INTO fighters (id, owner_user_id, name, photo_hash, quality_tier)
      VALUES (?, ?, ?, ?, ?)
    `).bind('fighter-target', auth.userId, 'Target Fighter', 'target-photo', 'contender'),
  ]);
  const env = {
    DB: db,
    SPRITES: bucket,
    ENVIRONMENT: 'development',
    CORS_ORIGIN: 'https://insertplayer.ai',
  } as unknown as Env;
  return { mf, db, bucket, env };
}

const INTEGRATION_TEST_TIMEOUT_MS = 15_000;

function sha256Fixture(value: number): string {
  return value.toString(16).padStart(64, '0');
}

describe('fighter uploads against real D1 and R2 bindings', () => {
  it('maps cloned same-photo fighters back to their public community source', async () => {
    const { mf, db, env } = await createBindings();
    try {
      const sourceId = 'community-source';
      const animations = [
        'idle', 'walk', 'high_punch', 'low_punch', 'high_kick', 'low_kick',
        'jump', 'crouch', 'hit', 'ko', 'victory',
      ];
      await db.batch([
        db.prepare(`
          INSERT INTO users (id, clerk_user_id, display_name)
          VALUES ('community-owner', 'community-owner', 'Community Owner')
        `),
        db.prepare(`
          INSERT INTO fighters (
            id, owner_user_id, name, photo_hash, quality_tier, public_flag
          ) VALUES (?, 'community-owner', 'Shared Fighter', 'target-photo', 'contender', 1)
        `).bind(sourceId),
        ...animations.map((animationName, index) => db.prepare(`
          INSERT INTO sprites (
            id, fighter_id, animation_name, quality_tier, blob_key, content_hash,
            frame_w, frame_h, frame_count, processing_version
          ) VALUES (?, ?, ?, 'contender', ?, ?, 256, 256, 8, 4)
        `).bind(
          `community-sprite-${index}`,
          sourceId,
          animationName,
          `users/community-owner/fighters/${sourceId}/sprites/${animationName}.png`,
          index.toString(16).padStart(64, '0'),
        )),
      ]);

      const response = await listOwnedCommunityFighterIds(env, auth);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ fighterIds: [sourceId] });

      await db.prepare(`UPDATE fighters SET photo_hash = 'different-photo' WHERE id = 'fighter-target'`).run();
      expect(await listOwnedCommunityFighterIds(env, auth).then((next) => next.json()))
        .toEqual({ fighterIds: [] });
    } finally {
      await mf.dispose();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('activates, lists, and retires a private-by-default official Arcade fighter', async () => {
    const { mf, db, bucket, env } = await createBindings();
    const fighterId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    try {
      await db.prepare(`
        INSERT INTO fighters (id, owner_user_id, name, photo_hash, quality_tier)
        VALUES (?, ?, ?, ?, 'champion')
      `).bind(fighterId, auth.userId, 'Headline Fighter', 'headline-photo').run();

      expect((await upsertAdminArcadeFighter(
        arcadeRequest('draft'), env, auth, fighterId,
      )).status).toBe(403);
      const draftUpsertResponse = await upsertAdminArcadeFighter(
        arcadeRequest('draft'), env, adminAuth, fighterId,
      );
      expect(draftUpsertResponse.status).toBe(201);
      const draftUpsertBody = await draftUpsertResponse.json() as {
        fighter: { generationPrompt: string };
      };
      expect(draftUpsertBody.fighter.generationPrompt)
        .toContain('clearly synthetic premium realistic 2.5D');
      const adminBody = await listAdminArcadeFighters(env, adminAuth)
        .then((response) => response.json() as Promise<{
          fighters: Array<{ generationPrompt: string }>;
        }>);
      expect(adminBody.fighters[0]?.generationPrompt)
        .toContain('clearly synthetic premium realistic 2.5D');
      expect((await db.prepare(
        'SELECT generation_prompt FROM arcade_fighters WHERE fighter_id = ?'
      ).bind(fighterId).first<{ generation_prompt: string }>())?.generation_prompt)
        .toContain('clearly synthetic premium realistic 2.5D');
      const draftResponse = await listArcadeFighters(
        new Request('https://api.insertplayer.ai/api/arcade'), env,
      );
      const draftBody = await draftResponse.json() as { fighters: unknown[] };
      expect(draftBody.fighters).toHaveLength(0);
      const ownedBody = await listFighters(
        new Request('https://api.insertplayer.ai/api/fighters'), env, auth,
      ).then((response) => response.json() as Promise<{ fighters: Array<{ id: string }> }>);
      expect(ownedBody.fighters.map((fighter) => fighter.id)).toEqual(['fighter-target']);

      const animationNames = [
        'idle', 'walk', 'high_punch', 'low_punch', 'high_kick', 'low_kick',
        'jump', 'crouch', 'hit', 'ko', 'victory',
      ];
      const denseFrameCounts: Record<string, number> = {
        idle: 8,
        walk: 12,
        high_punch: 11,
        low_punch: 13,
        high_kick: 23,
        low_kick: 17,
        jump: 8,
        crouch: 6,
        hit: 6,
        ko: 12,
        victory: 12,
      };
      const sourceKeys = {
        original: `users/user-target/fighters/${fighterId}/sources/original.png`,
        side: `users/user-target/fighters/${fighterId}/sources/side.png`,
        sideRaw: `users/user-target/fighters/${fighterId}/sources/side-raw.png`,
        upright: `users/user-target/fighters/${fighterId}/sources/upright.png`,
        uprightRaw: `users/user-target/fighters/${fighterId}/sources/upright-raw.png`,
        crouch: `users/user-target/fighters/${fighterId}/sources/crouch.png`,
        crouchRaw: `users/user-target/fighters/${fighterId}/sources/crouch-raw.png`,
      };
      await db.batch([
        db.prepare(`
          UPDATE fighters SET
            original_blob_key = ?,
            side_view_blob_key = ?,
            side_view_raw_blob_key = ?,
            upright_view_blob_key = ?,
            upright_view_raw_blob_key = ?,
            crouch_view_blob_key = ?,
            crouch_view_raw_blob_key = ?
          WHERE id = ?
        `).bind(
          sourceKeys.original,
          sourceKeys.side,
          sourceKeys.sideRaw,
          sourceKeys.upright,
          sourceKeys.uprightRaw,
          sourceKeys.crouch,
          sourceKeys.crouchRaw,
          fighterId,
        ),
        ...animationNames.map((animationName, index) => db.prepare(`
          INSERT INTO sprites (
            id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
            content_hash, raw_content_hash,
            frame_w, frame_h, frame_count, animation_format, processing_version
          ) VALUES (?, ?, ?, 'champion', ?, ?, ?, ?, 192, 256, ?, 'video-dense-v1', 5)
        `).bind(
          `arcade-sprite-${index}`,
          fighterId,
          animationName,
          `users/user-target/fighters/${fighterId}/sprites/${animationName}.png`,
          `users/user-target/fighters/${fighterId}/sprites/${animationName}-raw.png`,
          sha256Fixture(index + 1),
          sha256Fixture(index + 101),
          denseFrameCounts[animationName],
        )),
      ]);

      const missingResponse = await upsertAdminArcadeFighter(
        arcadeRequest('active'), env, adminAuth, fighterId,
      );
      expect(missingResponse.status).toBe(409);
      expect(await missingResponse.json()).toMatchObject({
        missingAssets: expect.arrayContaining(['source:original', 'sprite:idle']),
      });

      await Promise.all([
        ...Object.values(sourceKeys).map((key) => bucket.put(key, new Uint8Array([1, 2, 3]))),
        ...animationNames.flatMap((animationName) => [
          bucket.put(
            `users/user-target/fighters/${fighterId}/sprites/${animationName}.png`,
            new Uint8Array([4, 5, 6]),
          ),
          bucket.put(
            `users/user-target/fighters/${fighterId}/sprites/${animationName}-raw.png`,
            new Uint8Array([7, 8, 9]),
          ),
        ]),
      ]);

      await db.prepare(`
        UPDATE sprites SET content_hash = 'not-a-sha256'
        WHERE fighter_id = ? AND animation_name = 'idle' AND quality_tier = 'champion'
      `).bind(fighterId).run();
      const invalidHashResponse = await upsertAdminArcadeFighter(
        arcadeRequest('active'), env, adminAuth, fighterId,
      );
      expect(invalidHashResponse.status).toBe(409);
      expect(await invalidHashResponse.json()).toMatchObject({
        missingAssets: expect.arrayContaining(['sprite:idle:content-hash']),
      });

      await db.prepare(`
        UPDATE sprites SET content_hash = ?, raw_content_hash = 'not-a-sha256'
        WHERE fighter_id = ? AND animation_name = 'idle' AND quality_tier = 'champion'
      `).bind(sha256Fixture(1), fighterId).run();
      const invalidRawHashResponse = await upsertAdminArcadeFighter(
        arcadeRequest('active'), env, adminAuth, fighterId,
      );
      expect(invalidRawHashResponse.status).toBe(409);
      expect(await invalidRawHashResponse.json()).toMatchObject({
        missingAssets: expect.arrayContaining(['sprite:idle:raw-content-hash']),
      });

      await db.prepare(`
        UPDATE sprites SET raw_content_hash = ?, frame_count = 0
        WHERE fighter_id = ? AND animation_name = 'idle' AND quality_tier = 'champion'
      `).bind(sha256Fixture(101), fighterId).run();
      const invalidMetadataResponse = await upsertAdminArcadeFighter(
        arcadeRequest('active'), env, adminAuth, fighterId,
      );
      expect(invalidMetadataResponse.status).toBe(409);
      expect(await invalidMetadataResponse.json()).toMatchObject({
        missingAssets: expect.arrayContaining(['sprite:idle:frame-metadata']),
      });
      await db.prepare(`
        UPDATE sprites SET frame_count = 8
        WHERE fighter_id = ? AND animation_name = 'idle' AND quality_tier = 'champion'
      `).bind(fighterId).run();

      expect((await upsertAdminArcadeFighter(
        arcadeRequest('active'), env, adminAuth, fighterId,
      )).status).toBe(200);

      await db.prepare(`
        UPDATE sprites SET content_hash = 'not-a-sha256'
        WHERE fighter_id = ? AND animation_name = 'idle' AND quality_tier = 'champion'
      `).bind(fighterId).run();
      const invalidHashArcadeBody = await listArcadeFighters(
        new Request('https://api.insertplayer.ai/api/arcade'), env,
      ).then((response) => response.json() as Promise<{ fighters: unknown[] }>);
      expect(invalidHashArcadeBody.fighters).toHaveLength(0);

      await db.prepare(`
        UPDATE sprites SET content_hash = ?, frame_w = 0
        WHERE fighter_id = ? AND animation_name = 'idle' AND quality_tier = 'champion'
      `).bind(sha256Fixture(1), fighterId).run();
      const invalidMetadataArcadeBody = await listArcadeFighters(
        new Request('https://api.insertplayer.ai/api/arcade'), env,
      ).then((response) => response.json() as Promise<{ fighters: unknown[] }>);
      expect(invalidMetadataArcadeBody.fighters).toHaveLength(0);
      await db.prepare(`
        UPDATE sprites SET frame_w = 768
        WHERE fighter_id = ? AND animation_name = 'idle' AND quality_tier = 'champion'
      `).bind(fighterId).run();

      const activeResponse = await listArcadeFighters(
        new Request('https://api.insertplayer.ai/api/arcade'), env,
      );
      const activeBody = await activeResponse.json() as { fighters: Array<Record<string, any>> };
      expect(activeBody.fighters).toHaveLength(1);
      expect(activeBody.fighters[0]?.name).toBe('Headline Fighter');
      expect(activeBody.fighters[0]?.qualityTier).toBe('champion');
      expect(activeBody.fighters[0]?.arcade).toEqual({
        slug: 'headline-fighter',
        rank: 1,
        challengerLine: 'The headline fight starts here.',
        defaultPersonality: 'showboat',
        reference: {
          kind: 'licensed',
          sourceUrl: 'https://commons.wikimedia.org/wiki/File:Headline_Fighter.jpg',
          license: 'CC BY-SA 4.0',
          credit: 'Example Photographer (2026)',
        },
      });
      expect(activeBody.fighters[0]).not.toHaveProperty('photoHash');
      expect(activeBody.fighters[0]).not.toHaveProperty('ownerUserId');
      expect(activeBody.fighters[0]).not.toHaveProperty('generationPrompt');
      const arcadeIdle = activeBody.fighters[0]?.sprites.find(
        (sprite: Record<string, unknown>) => sprite.animationName === 'idle',
      );
      expect(arcadeIdle).toMatchObject({
        rawFrameWidth: 768,
        rawFrameHeight: 1024,
        rawFrameCount: 8,
      });
      expect(activeBody.fighters[0]?.sprites.find(
        (sprite: Record<string, unknown>) => sprite.animationName === 'high_punch',
      )).toMatchObject({
        frameCount: 11,
        rawFrameWidth: 768,
        rawFrameHeight: 1024,
        rawFrameCount: 6,
      });
      expect(arcadeIdle?.rawUrl).toContain(
        `/public-assets/arcade/${fighterId}/sprites/arcade-sprite-0/raw/idle-raw.png`,
      );
      const publicRaw = await getPublicArcadeSpriteRawAsset(
        env,
        fighterId,
        'arcade-sprite-0',
        'idle-raw.png',
      );
      expect(publicRaw.status).toBe(200);
      expect(Array.from(new Uint8Array(await publicRaw.arrayBuffer()))).toEqual([7, 8, 9]);
      expect((await getPublicArcadeSpriteRawAsset(
        env,
        fighterId,
        'arcade-sprite-0',
        'wrong.png',
      )).status).toBe(404);
      const communityBody = await listCommunityFighters(
        new Request('https://api.insertplayer.ai/api/community'), env,
      ).then((response) => response.json() as Promise<{ fighters: unknown[] }>);
      expect(communityBody.fighters).toHaveLength(0);
      expect((await getCommunityFighter(
        new Request(`https://api.insertplayer.ai/api/community/${fighterId}`), env, fighterId,
      )).status).toBe(404);
      expect((await shareCommunityFighterPage(
        new Request(`https://api.insertplayer.ai/share/${fighterId}`), env, fighterId,
      )).status).toBe(404);
      expect((await cloneCommunityFighter(
        new Request(`https://api.insertplayer.ai/api/community/${fighterId}/clone`, { method: 'POST' }),
        env,
        auth,
        fighterId,
      )).status).toBe(404);
      expect((await reportCommunityFighter(
        new Request(`https://api.insertplayer.ai/api/community/${fighterId}/report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'other' }),
        }),
        env,
        auth,
        fighterId,
      )).status).toBe(404);

      expect((await upsertAdminArcadeFighter(
        arcadeRequest('retired'), env, adminAuth, fighterId,
      )).status).toBe(200);
      const retired = await listArcadeFighters(
        new Request('https://api.insertplayer.ai/api/arcade'), env,
      ).then((response) => response.json() as Promise<{ fighters: unknown[] }>);
      expect(retired.fighters).toHaveLength(0);
      expect((await db.prepare('SELECT public_flag FROM fighters WHERE id = ?')
        .bind(fighterId).first<{ public_flag: number }>())?.public_flag).toBe(0);

      expect((await upsertAdminArcadeFighter(
        arcadeRequest('draft'), env, adminAuth, fighterId,
      )).status).toBe(200);
      await db.prepare(`
        INSERT INTO generation_artifact_runs (
          id, user_id, fighter_id, creation_flow, source_manifest_json
        ) VALUES (?, ?, ?, 'video', ?)
      `).bind(
        'reviewed-video-run',
        auth.userId,
        fighterId,
        JSON.stringify({ reviewedCanonicalSources: { mode: 'reviewed-current-v1' } }),
      ).run();
      const legacyActivation = await upsertAdminArcadeFighter(
        arcadeRequest('active'), env, adminAuth, fighterId,
      );
      expect(legacyActivation.status).toBe(409);
      expect(await legacyActivation.json()).toEqual({
        error: 'Reviewed Video fighters must use the dedicated reviewed activation endpoint',
      });
      expect(await db.prepare(`
        SELECT arcade.status, fighter.public_flag
        FROM arcade_fighters arcade
        JOIN fighters fighter ON fighter.id = arcade.fighter_id
        WHERE arcade.fighter_id = ?
      `).bind(fighterId).first()).toEqual({ status: 'draft', public_flag: 0 });
    } finally {
      await mf.dispose();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('keeps Clerk photos and private fighter fields out of community payloads', async () => {
    const { mf, db, bucket, env } = await createBindings();
    try {
      const animationNames = [
        'idle', 'walk', 'high_punch', 'low_punch', 'high_kick', 'low_kick',
        'jump', 'crouch', 'hit', 'ko', 'victory',
      ];
      await db.batch([
        db.prepare(`
          UPDATE fighters
          SET public_flag = 1,
              original_blob_key = 'users/user-target/fighters/fighter-target/sources/original.png',
              side_view_blob_key = 'users/user-target/fighters/fighter-target/sources/side.png',
              side_view_raw_blob_key = 'users/user-target/fighters/fighter-target/sources/side-raw.png'
          WHERE id = 'fighter-target'
        `),
        ...animationNames.map((animationName, index) => db.prepare(`
          INSERT INTO sprites (
            id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
            content_hash, raw_content_hash,
            frame_w, frame_h, frame_count, processing_version
          ) VALUES (?, 'fighter-target', ?, 'contender', ?, ?, ?, ?, 256, 256, 8, 4)
        `).bind(
          `sprite-public-${index}`,
          animationName,
          `users/user-target/fighters/fighter-target/sprites/${animationName}.png`,
          `users/user-target/fighters/fighter-target/sprites/${animationName}-raw.png`,
          sha256Fixture(index + 201),
          sha256Fixture(index + 301),
        )),
      ]);
      await Promise.all([
        bucket.put(
          'users/user-target/fighters/fighter-target/sources/side.png',
          new Uint8Array([1, 2, 3]),
          { httpMetadata: { contentType: 'image/png' } },
        ),
        bucket.put(
          'users/user-target/fighters/fighter-target/sprites/idle.png',
          new Uint8Array([4, 5, 6]),
          { httpMetadata: { contentType: 'image/png' } },
        ),
      ]);

      const response = await listCommunityFighters(
        new Request('https://api.insertplayer.ai/api/community'),
        env,
      );
      const body = await response.json() as { fighters: Array<Record<string, any>> };
      expect(response.status).toBe(200);
      expect(body.fighters).toHaveLength(1);
      const fighter = body.fighters[0];
      expect(fighter.owner).toEqual({ name: 'Player' });
      expect(fighter).not.toHaveProperty('ownerUserId');
      expect(fighter).not.toHaveProperty('photoHash');
      expect(fighter.sources).toMatchObject({ original: null, sideRaw: null });
      expect(fighter.sprites.every((sprite: Record<string, unknown>) => sprite.rawUrl === null)).toBe(true);
      expect(fighter.sources.side).toContain(
        '/public-assets/fighters/fighter-target/sources/side/side.png',
      );
      const idleSprite = fighter.sprites.find((sprite: Record<string, unknown>) => sprite.animationName === 'idle');
      expect(idleSprite?.url).toContain(
        '/public-assets/fighters/fighter-target/sprites/sprite-public-0/idle.png',
      );
      expect(idleSprite?.contentHash).toBe(sha256Fixture(201));
      expect(idleSprite).not.toHaveProperty('rawContentHash');
      expect(JSON.stringify(fighter)).not.toContain('/assets/users/');
      expect(JSON.stringify(fighter)).not.toContain('user-target');

      const shareResponse = await shareCommunityFighterPage(
        new Request('https://api.insertplayer.ai/share/fighter-target'),
        env,
        'fighter-target',
      );
      const shareHtml = await shareResponse.text();
      expect(shareResponse.status).toBe(200);
      expect(shareHtml).not.toContain(auth.user.display_name);
      expect(shareHtml).not.toContain(auth.user.email!);
      expect(shareHtml).not.toContain('private-profile.png');
      expect(shareHtml).not.toContain('user-target');
      expect(shareHtml).toContain('/public-assets/fighters/fighter-target/sources/side/side.png');

      const [publicSource, publicSprite] = await Promise.all([
        getPublicFighterSourceAsset(env, 'fighter-target', 'side', 'side.png'),
        getPublicFighterSpriteAsset(env, 'fighter-target', 'sprite-public-0', 'idle.png'),
      ]);
      expect(publicSource.status).toBe(200);
      expect(publicSource.headers.get('Cache-Control')).toBe(
        'public, max-age=60, s-maxage=300, must-revalidate',
      );
      expect(publicSprite.status).toBe(200);

      await db.prepare(`
        INSERT INTO sprites (
          id, fighter_id, animation_name, quality_tier, blob_key,
          content_hash, frame_w, frame_h, frame_count, processing_version
        ) VALUES (
          'sprite-invalid-champion-idle', 'fighter-target', 'idle', 'champion',
          'users/user-target/fighters/fighter-target/sprites/invalid-champion-idle.png',
          'not-a-sha256', 256, 256, 8, 4
        )
      `).run();
      const invalidHighestTierBody = await listCommunityFighters(
        new Request('https://api.insertplayer.ai/api/community'),
        env,
      ).then((result) => result.json() as Promise<{ fighters: unknown[] }>);
      expect(invalidHighestTierBody.fighters).toHaveLength(0);
      expect((await getPublicFighterSpriteAsset(
        env,
        'fighter-target',
        'sprite-public-0',
        'idle.png',
      )).status).toBe(404);
      await db.prepare("DELETE FROM sprites WHERE id = 'sprite-invalid-champion-idle'").run();

      await db.prepare('UPDATE fighters SET public_flag = 0 WHERE id = ?').bind('fighter-target').run();
      const revokedSource = await getPublicFighterSourceAsset(env, 'fighter-target', 'side', 'side.png');
      expect(revokedSource.status).toBe(404);
      expect(revokedSource.headers.get('Cache-Control')).toBe('no-store');
    } finally {
      await mf.dispose();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('collapses concurrent identical source uploads without orphaning R2 objects', async () => {
    const { mf, db, bucket, env } = await createBindings();
    try {
      const responses = await Promise.all([
        uploadFighterSource(sourceRequest(), env, auth, 'fighter-target'),
        uploadFighterSource(sourceRequest(), env, auth, 'fighter-target'),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);

      const versionCount = await db.prepare(
        'SELECT COUNT(*) AS count FROM source_versions WHERE fighter_id = ? AND kind = ?'
      ).bind('fighter-target', 'side').first<{ count: number }>();
      const fighter = await db.prepare(
        'SELECT side_view_blob_key FROM fighters WHERE id = ?'
      ).bind('fighter-target').first<{ side_view_blob_key: string }>();
      const objects = await bucket.list({ prefix: 'users/user-target/fighters/fighter-target/sources/' });

      expect(versionCount?.count).toBe(1);
      expect(objects.objects).toHaveLength(1);
      expect(fighter?.side_view_blob_key).toBe(objects.objects[0]?.key);
    } finally {
      await mf.dispose();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('repairs a missing canonical source object on an idempotent upload', async () => {
    const { mf, db, bucket, env } = await createBindings();
    try {
      expect((await uploadFighterSource(sourceRequest(), env, auth, 'fighter-target')).status).toBe(200);
      const version = await db.prepare(`
        SELECT blob_key FROM source_versions
        WHERE fighter_id = ? AND kind = ?
      `).bind('fighter-target', 'side').first<{ blob_key: string }>();
      expect(version?.blob_key).toBeTruthy();

      await bucket.delete(version!.blob_key);
      expect(await bucket.head(version!.blob_key)).toBeNull();

      expect((await uploadFighterSource(sourceRequest(), env, auth, 'fighter-target')).status).toBe(200);
      const versionCount = await db.prepare(
        'SELECT COUNT(*) AS count FROM source_versions WHERE fighter_id = ? AND kind = ?'
      ).bind('fighter-target', 'side').first<{ count: number }>();
      const fighter = await db.prepare(
        'SELECT side_view_blob_key FROM fighters WHERE id = ?'
      ).bind('fighter-target').first<{ side_view_blob_key: string }>();

      expect(versionCount?.count).toBe(1);
      expect(fighter?.side_view_blob_key).toBe(version!.blob_key);
      expect(await bucket.head(version!.blob_key)).not.toBeNull();
    } finally {
      await mf.dispose();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('collapses concurrent identical sprite uploads and keeps current on the archived version', async () => {
    const { mf, db, bucket, env } = await createBindings();
    try {
      const responses = await Promise.all([
        uploadFighterSprite(spriteRequest(), env, auth, 'fighter-target'),
        uploadFighterSprite(spriteRequest(), env, auth, 'fighter-target'),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);

      const versionCount = await db.prepare(`
        SELECT COUNT(*) AS count FROM sprite_versions
        WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
      `).bind('fighter-target', 'idle', 'contender').first<{ count: number }>();
      const current = await db.prepare(`
        SELECT blob_key, raw_blob_key FROM sprites
        WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
      `).bind('fighter-target', 'idle', 'contender').first<{ blob_key: string; raw_blob_key: string }>();
      const objects = await bucket.list({ prefix: 'users/user-target/fighters/fighter-target/sprites/' });
      const objectKeys = new Set(objects.objects.map((object) => object.key));

      expect(versionCount?.count).toBe(1);
      expect(objects.objects).toHaveLength(2);
      expect(objectKeys.has(current?.blob_key ?? '')).toBe(true);
      expect(objectKeys.has(current?.raw_blob_key ?? '')).toBe(true);
    } finally {
      await mf.dispose();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('defaults old uploads to legacy and preserves identical bytes under a dense-video contract', async () => {
    const { mf, db, env } = await createBindings();
    try {
      const legacyResponse = await uploadFighterSprite(
        spriteRequest(), env, auth, 'fighter-target',
      );
      const denseResponse = await uploadFighterSprite(
        spriteRequest({ animationFormat: 'video-dense-v1' }), env, auth, 'fighter-target',
      );
      expect([legacyResponse.status, denseResponse.status]).toEqual([200, 200]);

      const { results } = await db.prepare(`
        SELECT animation_format FROM sprite_versions
        WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
        ORDER BY animation_format
      `).bind('fighter-target', 'idle', 'contender').all<{ animation_format: string }>();
      expect(results).toEqual([
        { animation_format: 'legacy' },
        { animation_format: 'video-dense-v1' },
      ]);
      expect((await db.prepare(`
        SELECT animation_format FROM sprites
        WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
      `).bind('fighter-target', 'idle', 'contender')
        .first<{ animation_format: string }>())?.animation_format).toBe('video-dense-v1');

      const body = await denseResponse.json() as {
        fighter: { sprites: Array<{ animationFormat: string }> };
      };
      expect(body.fighter.sprites[0]?.animationFormat).toBe('video-dense-v1');

      const hash = await db.prepare(`
        SELECT content_hash, raw_content_hash FROM sprite_versions
        WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
        LIMIT 1
      `).bind('fighter-target', 'idle', 'contender').first<{
        content_hash: string;
        raw_content_hash: string | null;
      }>();
      expect((await promoteFighterSpriteVersion(
        spritePromotionRequest(hash!.content_hash, hash!.raw_content_hash),
        env,
        auth,
        'fighter-target',
      )).status).toBe(409);
      expect((await promoteFighterSpriteVersion(
        spritePromotionRequest(hash!.content_hash, hash!.raw_content_hash, 'legacy'),
        env,
        auth,
        'fighter-target',
      )).status).toBe(200);
    } finally {
      await mf.dispose();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('repairs missing canonical sprite objects on an idempotent upload', async () => {
    const { mf, db, bucket, env } = await createBindings();
    try {
      expect((await uploadFighterSprite(spriteRequest(), env, auth, 'fighter-target')).status).toBe(200);
      const version = await db.prepare(`
        SELECT blob_key, raw_blob_key FROM sprite_versions
        WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
      `).bind('fighter-target', 'idle', 'contender').first<{ blob_key: string; raw_blob_key: string }>();
      expect(version?.blob_key).toBeTruthy();
      expect(version?.raw_blob_key).toBeTruthy();

      await bucket.delete([version!.blob_key, version!.raw_blob_key]);
      expect(await bucket.head(version!.blob_key)).toBeNull();
      expect(await bucket.head(version!.raw_blob_key)).toBeNull();

      expect((await uploadFighterSprite(spriteRequest(), env, auth, 'fighter-target')).status).toBe(200);
      const versionCount = await db.prepare(`
        SELECT COUNT(*) AS count FROM sprite_versions
        WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
      `).bind('fighter-target', 'idle', 'contender').first<{ count: number }>();
      const current = await db.prepare(`
        SELECT blob_key, raw_blob_key FROM sprites
        WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
      `).bind('fighter-target', 'idle', 'contender').first<{ blob_key: string; raw_blob_key: string }>();

      expect(versionCount?.count).toBe(1);
      expect(current?.blob_key).toBe(version!.blob_key);
      expect(current?.raw_blob_key).toBe(version!.raw_blob_key);
      expect(await bucket.head(version!.blob_key)).not.toBeNull();
      expect(await bucket.head(version!.raw_blob_key)).not.toBeNull();
    } finally {
      await mf.dispose();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('archives historical sprite uploads without changing current until explicitly requested', async () => {
    const { mf, db, env } = await createBindings();
    try {
      expect((await uploadFighterSprite(
        spriteRequest({ marker: 1 }), env, auth, 'fighter-target',
      )).status).toBe(200);
      await db.prepare(
        "UPDATE fighters SET updated_at = '2000-01-01 00:00:00' WHERE id = ?"
      ).bind('fighter-target').run();
      const original = await db.prepare(`
        SELECT content_hash FROM sprites
        WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
      `).bind('fighter-target', 'idle', 'contender').first<{ content_hash: string }>();

      expect((await uploadFighterSprite(
        spriteRequest({ marker: 2, setCurrent: false }), env, auth, 'fighter-target',
      )).status).toBe(200);
      const archivedOnly = await db.prepare(`
        SELECT content_hash FROM sprites
        WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
      `).bind('fighter-target', 'idle', 'contender').first<{ content_hash: string }>();
      const versionCount = await db.prepare(`
        SELECT COUNT(*) AS count FROM sprite_versions
        WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
      `).bind('fighter-target', 'idle', 'contender').first<{ count: number }>();
      const fighterAfterArchive = await db.prepare(
        'SELECT updated_at FROM fighters WHERE id = ?'
      ).bind('fighter-target').first<{ updated_at: string }>();
      expect(archivedOnly?.content_hash).toBe(original?.content_hash);
      expect(versionCount?.count).toBe(2);
      expect(fighterAfterArchive?.updated_at).not.toBe('2000-01-01 00:00:00');

      const archivedVersion = await db.prepare(`
        SELECT content_hash, raw_content_hash FROM sprite_versions
        WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
          AND content_hash <> ?
      `).bind(
        'fighter-target',
        'idle',
        'contender',
        original?.content_hash,
      ).first<{ content_hash: string; raw_content_hash: string | null }>();
      expect(archivedVersion?.content_hash).toBeTruthy();
      expect((await promoteFighterSpriteVersion(
        spritePromotionRequest(archivedVersion!.content_hash, archivedVersion!.raw_content_hash),
        env,
        auth,
        'fighter-target',
      )).status).toBe(200);
      const promoted = await db.prepare(`
        SELECT content_hash FROM sprites
        WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
      `).bind('fighter-target', 'idle', 'contender').first<{ content_hash: string }>();
      expect(promoted?.content_hash).not.toBe(original?.content_hash);
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM sprite_versions
        WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
      `).bind('fighter-target', 'idle', 'contender').first<{ count: number }>())?.count).toBe(2);
    } finally {
      await mf.dispose();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('rejects an old metadata-free promotion when matching hashes have multiple legacy interpretations', async () => {
    const { mf, db, env } = await createBindings();
    try {
      expect((await uploadFighterSprite(
        spriteRequest({ setCurrent: false }), env, auth, 'fighter-target',
      )).status).toBe(200);
      expect((await uploadFighterSprite(
        spriteRequest({ setCurrent: false, frameWidth: 128, frameCount: 16 }),
        env,
        auth,
        'fighter-target',
      )).status).toBe(200);

      const { results } = await db.prepare(`
        SELECT content_hash, raw_content_hash, frame_w, frame_h, frame_count, processing_version
        FROM sprite_versions
        WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
        ORDER BY frame_w
      `).bind('fighter-target', 'idle', 'contender').all<{
        content_hash: string;
        raw_content_hash: string | null;
        frame_w: number;
        frame_h: number;
        frame_count: number;
        processing_version: number;
      }>();
      expect(results).toHaveLength(2);
      expect(results[0]?.content_hash).toBe(results[1]?.content_hash);
      expect(results[0]?.raw_content_hash).toBe(results[1]?.raw_content_hash);

      const ambiguous = await promoteFighterSpriteVersion(
        spritePromotionRequest(results[0]!.content_hash, results[0]!.raw_content_hash),
        env,
        auth,
        'fighter-target',
      );
      expect(ambiguous.status).toBe(409);
      await expect(ambiguous.json()).resolves.toEqual({
        error: 'Sprite version selection is ambiguous; include animationFormat and frame metadata',
      });

      const selected = results[0]!;
      const explicit = await promoteFighterSpriteVersion(
        spritePromotionRequest(selected.content_hash, selected.raw_content_hash, 'legacy', {
          frameWidth: selected.frame_w,
          frameHeight: selected.frame_h,
          frameCount: selected.frame_count,
          processingVersion: selected.processing_version,
        }),
        env,
        auth,
        'fighter-target',
      );
      expect(explicit.status).toBe(200);
      expect((await db.prepare(`
        SELECT frame_w, frame_h, frame_count, processing_version
        FROM sprites
        WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
      `).bind('fighter-target', 'idle', 'contender').first<{
        frame_w: number;
        frame_h: number;
        frame_count: number;
        processing_version: number;
      }>())).toEqual({
        frame_w: selected.frame_w,
        frame_h: selected.frame_h,
        frame_count: selected.frame_count,
        processing_version: selected.processing_version,
      });
    } finally {
      await mf.dispose();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('serves owner assets across devices and keeps namespaced asset keys owner-only', async () => {
    const { mf, db, bucket, env } = await createBindings();
    try {
      expect((await uploadFighterSource(sourceRequest('original'), env, auth, 'fighter-target')).status).toBe(200);
      expect((await uploadFighterSource(sourceRequest('side_raw'), env, auth, 'fighter-target')).status).toBe(200);
      expect((await uploadFighterSource(sourceRequest('side'), env, auth, 'fighter-target')).status).toBe(200);
      expect((await uploadFighterSprite(spriteRequest(), env, auth, 'fighter-target')).status).toBe(200);

      const fighter = await db.prepare(
        'SELECT original_blob_key, side_view_blob_key, side_view_raw_blob_key FROM fighters WHERE id = ?'
      ).bind('fighter-target').first<{
        original_blob_key: string;
        side_view_blob_key: string;
        side_view_raw_blob_key: string;
      }>();
      const sprite = await db.prepare(
        'SELECT blob_key, raw_blob_key FROM sprites WHERE fighter_id = ? AND animation_name = ?'
      ).bind('fighter-target', 'idle').first<{ blob_key: string; raw_blob_key: string }>();

      const sourceKey = fighter?.side_view_blob_key ?? '';
      const originalKey = fighter?.original_blob_key ?? '';
      const sourceRawKey = fighter?.side_view_raw_blob_key ?? '';
      const spriteKey = sprite?.blob_key ?? '';
      const rawKey = sprite?.raw_blob_key ?? '';
      const ownerAsset = await getAsset(
        new Request(`https://api.insertplayer.ai/assets/${sourceKey}`),
        env,
        publicAuth(auth.userId),
        sourceKey,
      );
      expect(ownerAsset.status).toBe(200);
      expect(ownerAsset.headers.get('Cache-Control')).toBe('private, no-store');

      const privateAsset = await getAsset(
        new Request(`https://api.insertplayer.ai/assets/${sourceKey}`),
        env,
        publicAuth(),
        sourceKey,
      );
      expect(privateAsset.status).toBe(404);

      await db.prepare('UPDATE fighters SET public_flag = 1 WHERE id = ?').bind('fighter-target').run();
      const [privateProcessedSource, privateProcessedSprite, privateOriginal, privateSourceRaw, privateSpriteRaw] = await Promise.all([
        getAsset(new Request(`https://api.insertplayer.ai/assets/${sourceKey}`), env, publicAuth(), sourceKey),
        getAsset(new Request(`https://api.insertplayer.ai/assets/${spriteKey}`), env, publicAuth(), spriteKey),
        getAsset(new Request(`https://api.insertplayer.ai/assets/${originalKey}`), env, publicAuth(), originalKey),
        getAsset(new Request(`https://api.insertplayer.ai/assets/${sourceRawKey}`), env, publicAuth(), sourceRawKey),
        getAsset(new Request(`https://api.insertplayer.ai/assets/${rawKey}`), env, publicAuth(), rawKey),
      ]);

      expect(privateProcessedSource.status).toBe(404);
      expect(privateProcessedSprite.status).toBe(404);
      expect(privateOriginal.status).toBe(404);
      expect(privateSourceRaw.status).toBe(404);
      expect(privateSpriteRaw.status).toBe(404);
      expect((await bucket.list({ prefix: 'users/user-target/fighters/fighter-target/' })).objects).toHaveLength(5);
    } finally {
      await mf.dispose();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
