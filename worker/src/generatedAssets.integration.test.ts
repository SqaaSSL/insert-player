import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import { persistGeneratedSource, persistGeneratedSprite } from './generatedAssets';
import type { Env } from './types';

const USER_ID = 'user-generated-assets';
const FIGHTER_ID = 'fighter-generated-assets';

const SCHEMA = `
  CREATE TABLE users (id TEXT PRIMARY KEY);
  CREATE TABLE fighters (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    photo_hash TEXT NOT NULL,
    quality_tier TEXT NOT NULL,
    public_flag INTEGER NOT NULL DEFAULT 0,
    original_blob_key TEXT,
    side_view_blob_key TEXT,
    side_view_raw_blob_key TEXT,
    upright_view_blob_key TEXT,
    upright_view_raw_blob_key TEXT,
    crouch_view_blob_key TEXT,
    crouch_view_raw_blob_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE source_versions (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    content_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_source_versions_content
    ON source_versions (fighter_id, kind, content_hash)
    WHERE content_hash IS NOT NULL;
  CREATE TABLE sprite_versions (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL,
    animation_name TEXT NOT NULL,
    quality_tier TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    raw_blob_key TEXT,
    content_hash TEXT,
    raw_content_hash TEXT,
    frame_w INTEGER NOT NULL,
    frame_h INTEGER NOT NULL,
    frame_count INTEGER NOT NULL,
    processing_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_sprite_versions_content
    ON sprite_versions (
      fighter_id, animation_name, quality_tier, content_hash, COALESCE(raw_content_hash, '')
    ) WHERE content_hash IS NOT NULL;
  CREATE TABLE sprites (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL,
    animation_name TEXT NOT NULL,
    quality_tier TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    raw_blob_key TEXT,
    content_hash TEXT,
    raw_content_hash TEXT,
    frame_w INTEGER NOT NULL,
    frame_h INTEGER NOT NULL,
    frame_count INTEGER NOT NULL,
    processing_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(fighter_id, animation_name, quality_tier)
  );
`;

function png(marker: number): ArrayBuffer {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    marker & 0xff,
  ]).buffer;
}

async function bindings(): Promise<{ mf: Miniflare; db: D1Database; bucket: R2Bucket; env: Env }> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: 'generated-assets-test',
        compatibilityDate: '2026-08-22',
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
          DB: { type: 'd1', id: 'generated-assets-db' },
          SPRITES: { type: 'r2', name: 'generated-assets-bucket' },
        },
      },
    }],
  });
  const db = await mf.getD1Database('DB');
  const bucket = await mf.getR2Bucket('SPRITES') as unknown as R2Bucket;
  await db.batch(SCHEMA
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => db.prepare(statement)));
  await db.batch([
    db.prepare('INSERT INTO users (id) VALUES (?)').bind(USER_ID),
    db.prepare(`
      INSERT INTO fighters (id, owner_user_id, name, photo_hash, quality_tier)
      VALUES (?, ?, 'Version Keeper', 'photo-version-keeper', 'rookie')
    `).bind(FIGHTER_ID, USER_ID),
  ]);
  return {
    mf,
    db,
    bucket,
    env: {
      DB: db,
      SPRITES: bucket,
      ENVIRONMENT: 'development',
      CORS_ORIGIN: 'https://insertplayer.ai',
    } as Env,
  };
}

describe('backend-generated asset persistence', () => {
  it('deduplicates exact source retries while preserving every distinct version', async () => {
    const { mf, db, bucket, env } = await bindings();
    try {
      const first = await persistGeneratedSource(env, {
        jobId: 'job-source-first',
        userId: USER_ID,
        fighterId: FIGHTER_ID,
        kind: 'side',
        bytes: png(1),
      });
      const replay = await persistGeneratedSource(env, {
        jobId: 'job-source-replay',
        userId: USER_ID,
        fighterId: FIGHTER_ID,
        kind: 'side',
        bytes: png(1),
      });
      const distinct = await persistGeneratedSource(env, {
        jobId: 'job-source-distinct',
        userId: USER_ID,
        fighterId: FIGHTER_ID,
        kind: 'side',
        bytes: png(2),
      });

      expect(first.reused).toBe(false);
      expect(replay).toMatchObject({ reused: true, versionId: first.versionId, blobKey: first.blobKey });
      expect(distinct.reused).toBe(false);
      expect(distinct.versionId).not.toBe(first.versionId);
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM source_versions WHERE fighter_id = ? AND kind = 'side'
      `).bind(FIGHTER_ID).first<{ count: number }>())?.count).toBe(2);
      expect((await db.prepare('SELECT side_view_blob_key AS key FROM fighters WHERE id = ?')
        .bind(FIGHTER_ID).first<{ key: string }>())?.key).toBe(distinct.blobKey);
      expect(await bucket.head(first.blobKey)).not.toBeNull();
      expect(await bucket.head(distinct.blobKey)).not.toBeNull();
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('keeps prior sprite versions and tiers while promoting the latest playable asset', async () => {
    const { mf, db, bucket, env } = await bindings();
    try {
      const base = {
        userId: USER_ID,
        fighterId: FIGHTER_ID,
        animationName: 'idle',
        frameWidth: 256,
        frameHeight: 256,
        frameCount: 8,
        processingVersion: 5,
      } as const;
      const first = await persistGeneratedSprite(env, {
        ...base,
        jobId: 'job-sprite-first',
        tier: 'rookie',
        bytes: png(10),
        rawBytes: png(11),
      });
      const replay = await persistGeneratedSprite(env, {
        ...base,
        jobId: 'job-sprite-replay',
        tier: 'rookie',
        bytes: png(10),
        rawBytes: png(11),
      });
      const regenerated = await persistGeneratedSprite(env, {
        ...base,
        jobId: 'job-sprite-regenerated',
        tier: 'rookie',
        bytes: png(12),
        rawBytes: png(13),
      });
      const upgraded = await persistGeneratedSprite(env, {
        ...base,
        jobId: 'job-sprite-upgraded',
        tier: 'contender',
        bytes: png(14),
        rawBytes: png(15),
      });

      expect(replay).toMatchObject({ reused: true, versionId: first.versionId });
      expect(regenerated.versionId).not.toBe(first.versionId);
      expect(upgraded.versionId).not.toBe(regenerated.versionId);
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM sprite_versions WHERE fighter_id = ? AND animation_name = 'idle'
      `).bind(FIGHTER_ID).first<{ count: number }>())?.count).toBe(3);
      expect((await db.prepare('SELECT quality_tier AS tier FROM fighters WHERE id = ?')
        .bind(FIGHTER_ID).first<{ tier: string }>())?.tier).toBe('rookie');

      const current = await db.prepare(`
        SELECT blob_key, raw_blob_key FROM sprites
        WHERE fighter_id = ? AND animation_name = 'idle' AND quality_tier = 'contender'
      `).bind(FIGHTER_ID).first<{ blob_key: string; raw_blob_key: string }>();
      expect(current?.blob_key).toBe(upgraded.blobKey);
      expect(current?.raw_blob_key).toBe(upgraded.rawBlobKey);
      for (const asset of [first, regenerated, upgraded]) {
        expect(await bucket.head(asset.blobKey)).not.toBeNull();
        expect(await bucket.head(asset.rawBlobKey!)).not.toBeNull();
      }
    } finally {
      await mf.dispose();
    }
  }, 15_000);
});
