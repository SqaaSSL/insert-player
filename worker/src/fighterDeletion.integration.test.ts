import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import { drainFighterAssetDeletions } from './assetDeletion';
import { deleteFighter } from './fighters';
import type { AuthContext, Env } from './types';

const USER_ID = 'delete-user';
const FIGHTER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SOURCE_KEY = `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/side.png`;
const ORPHAN_KEY = `users/${USER_ID}/fighters/${FIGHTER_ID}/orphaned/extra.png`;
const SPRITE_KEY = `users/${USER_ID}/fighters/${FIGHTER_ID}/sprites/idle.png`;

const SCHEMA = `
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
  CREATE TABLE arcade_fighters (
    fighter_id TEXT PRIMARY KEY REFERENCES fighters(id) ON DELETE CASCADE,
    status TEXT NOT NULL
  );
  CREATE TABLE sprites (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
    animation_name TEXT NOT NULL,
    quality_tier TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    raw_blob_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE source_versions (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    content_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE sprite_versions (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
    animation_name TEXT NOT NULL,
    quality_tier TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    raw_blob_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE generation_artifact_runs (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE
  );
  CREATE TABLE generation_jobs (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
    artifact_run_id TEXT REFERENCES generation_artifact_runs(id) ON DELETE RESTRICT
  );
  CREATE TABLE fighter_asset_deletions (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    fighter_id TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    reason TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(fighter_id, blob_key)
  );
`;

const RELEASE_RUN_TRIGGER = `
  CREATE TRIGGER generation_jobs_release_artifact_run_before_fighter_delete
  BEFORE DELETE ON fighters
  BEGIN
    UPDATE generation_jobs SET artifact_run_id = NULL WHERE fighter_id = OLD.id;
  END
`;

const auth = {
  userId: USER_ID,
  rateLimitKey: `user:${USER_ID}`,
  claims: {},
  user: { id: USER_ID, plan_tier: 'free' },
} as unknown as AuthContext;

async function bindings(): Promise<{ mf: Miniflare; db: D1Database; bucket: R2Bucket; env: Env }> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: 'fighter-deletion-test',
        compatibilityDate: '2026-08-24',
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
          DB: { type: 'd1', id: 'fighter-deletion-db' },
          SPRITES: { type: 'r2', name: 'fighter-deletion-assets' },
        },
      },
    }],
  });
  const db = await mf.getD1Database('DB');
  const bucket = await mf.getR2Bucket('SPRITES') as unknown as R2Bucket;
  await db.batch([
    ...SCHEMA
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => db.prepare(statement)),
    db.prepare(RELEASE_RUN_TRIGGER),
  ]);
  await db.batch([
    db.prepare(`
      INSERT INTO fighters (
        id, owner_user_id, name, photo_hash, quality_tier, side_view_blob_key
      ) VALUES (?, ?, 'Delete Me', 'photo', 'champion', ?)
    `).bind(FIGHTER_ID, USER_ID, SOURCE_KEY),
    db.prepare(`
      INSERT INTO source_versions (id, fighter_id, kind, blob_key)
      VALUES ('source-version', ?, 'side', ?)
    `).bind(FIGHTER_ID, SOURCE_KEY),
    db.prepare(`
      INSERT INTO sprites (id, fighter_id, animation_name, quality_tier, blob_key)
      VALUES ('sprite-current', ?, 'idle', 'champion', ?)
    `).bind(FIGHTER_ID, SPRITE_KEY),
    db.prepare(`
      INSERT INTO sprite_versions (
        id, fighter_id, animation_name, quality_tier, blob_key
      ) VALUES ('sprite-version', ?, 'idle', 'champion', ?)
    `).bind(FIGHTER_ID, SPRITE_KEY),
    db.prepare(`INSERT INTO generation_artifact_runs (id, fighter_id) VALUES ('run', ?)`)
      .bind(FIGHTER_ID),
    db.prepare(`INSERT INTO generation_jobs (id, fighter_id, artifact_run_id) VALUES ('job', ?, 'run')`)
      .bind(FIGHTER_ID),
  ]);
  await Promise.all([
    bucket.put(SOURCE_KEY, new Uint8Array([1])),
    bucket.put(SPRITE_KEY, new Uint8Array([2])),
    bucket.put(ORPHAN_KEY, new Uint8Array([3])),
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

describe('durable fighter deletion', () => {
  it('commits D1 first, releases the artifact-run restriction, and removes every R2 prefix object', async () => {
    const { mf, db, bucket, env } = await bindings();
    try {
      const response = await deleteFighter(env, auth, FIGHTER_ID);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        assetCleanup: 'complete',
        deletedAssets: 3,
      });
      expect(await db.prepare('SELECT id FROM fighters WHERE id = ?').bind(FIGHTER_ID).first()).toBeNull();
      expect(await db.prepare('SELECT id FROM generation_jobs').first()).toBeNull();
      expect(await db.prepare('SELECT id FROM generation_artifact_runs').first()).toBeNull();
      expect(await db.prepare('SELECT id FROM fighter_asset_deletions').first()).toBeNull();
      expect(await bucket.head(SOURCE_KEY)).toBeNull();
      expect(await bucket.head(SPRITE_KEY)).toBeNull();
      expect(await bucket.head(ORPHAN_KEY)).toBeNull();
    } finally {
      await mf.dispose();
    }
  });

  it('blocks official Arcade deletion before any D1 or R2 mutation', async () => {
    const { mf, db, bucket, env } = await bindings();
    try {
      await db.prepare(`INSERT INTO arcade_fighters (fighter_id, status) VALUES (?, 'draft')`)
        .bind(FIGHTER_ID).run();
      const response = await deleteFighter(env, auth, FIGHTER_ID);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'arcade_fighter_requires_reconciliation',
      });
      expect(await db.prepare('SELECT id FROM fighters WHERE id = ?').bind(FIGHTER_ID).first())
        .toEqual({ id: FIGHTER_ID });
      expect(await bucket.head(SOURCE_KEY)).not.toBeNull();
      expect(await bucket.head(SPRITE_KEY)).not.toBeNull();
      expect(await bucket.head(ORPHAN_KEY)).not.toBeNull();
    } finally {
      await mf.dispose();
    }
  });

  it('keeps the D1 tombstone queue when R2 fails and finishes on a later drain', async () => {
    const { mf, db, bucket, env } = await bindings();
    let failDelete = true;
    const flakyBucket = {
      list: bucket.list.bind(bucket),
      delete: async (keys: string | string[]) => {
        if (failDelete) throw new Error('temporary R2 outage');
        return bucket.delete(keys);
      },
    } as unknown as R2Bucket;
    const flakyEnv = { ...env, SPRITES: flakyBucket } as Env;
    try {
      const response = await deleteFighter(flakyEnv, auth, FIGHTER_ID);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        assetCleanup: 'pending',
        deletedAssets: 0,
      });
      expect(await db.prepare('SELECT id FROM fighters WHERE id = ?').bind(FIGHTER_ID).first())
        .toBeNull();
      expect(await db.prepare(`
        SELECT COUNT(*) AS count FROM fighter_asset_deletions
      `).first<{ count: number }>()).toEqual({ count: 3 });

      failDelete = false;
      await expect(drainFighterAssetDeletions(flakyEnv, { fighterId: FIGHTER_ID }))
        .resolves.toEqual({ deleted: 3, pending: 0 });
      expect(await db.prepare('SELECT id FROM fighter_asset_deletions').first()).toBeNull();
      expect(await bucket.head(SOURCE_KEY)).toBeNull();
      expect(await bucket.head(SPRITE_KEY)).toBeNull();
      expect(await bucket.head(ORPHAN_KEY)).toBeNull();
    } finally {
      await mf.dispose();
    }
  });
});
