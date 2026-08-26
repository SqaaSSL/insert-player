import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import {
  persistGeneratedSource,
  persistGeneratedSprite,
  promoteGeneratedSourceVersion,
  promoteGeneratedSpriteVersion,
} from './generatedAssets';
import {
  artifactProgress,
  recordSourceCheckpoint,
  recordSpriteCheckpoint,
  reuseSourceCheckpoint,
  reuseSpriteCheckpoint,
} from './generationArtifacts';
import type { Env, GenerationJob } from './types';

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
    animation_format TEXT NOT NULL DEFAULT 'legacy' CHECK (animation_format IN ('legacy', 'video-dense-v1')),
    processing_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_sprite_versions_content
    ON sprite_versions (
      fighter_id, animation_name, quality_tier, animation_format,
      frame_w, frame_h, frame_count, processing_version,
      content_hash, COALESCE(raw_content_hash, '')
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
    animation_format TEXT NOT NULL DEFAULT 'legacy' CHECK (animation_format IN ('legacy', 'video-dense-v1')),
    processing_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(fighter_id, animation_name, quality_tier)
  );
  CREATE TABLE generation_artifact_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'active',
    failure_stage TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE generation_artifact_checkpoints (
    run_id TEXT NOT NULL,
    artifact_kind TEXT NOT NULL,
    artifact_name TEXT NOT NULL,
    stage_index INTEGER NOT NULL,
    tier TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'approved',
    clean_version_id TEXT NOT NULL,
    raw_version_id TEXT,
    clean_blob_key TEXT NOT NULL,
    raw_blob_key TEXT,
    clean_content_hash TEXT,
    raw_content_hash TEXT,
    frame_w INTEGER,
    frame_h INTEGER,
    frame_count INTEGER,
    animation_format TEXT NOT NULL DEFAULT 'legacy' CHECK (animation_format IN ('legacy', 'video-dense-v1')),
    processing_version INTEGER,
    metadata_json TEXT,
    completed_by_job_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    verified_at TEXT,
    PRIMARY KEY (run_id, artifact_kind, artifact_name)
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
      const restored = await promoteGeneratedSourceVersion(env, {
        userId: USER_ID,
        fighterId: FIGHTER_ID,
        kind: 'side',
        versionId: first.versionId,
      });
      expect(restored.blob_key).toBe(first.blobKey);
      expect((await db.prepare('SELECT side_view_blob_key AS key FROM fighters WHERE id = ?')
        .bind(FIGHTER_ID).first<{ key: string }>())?.key).toBe(first.blobKey);
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM source_versions WHERE fighter_id = ? AND kind = 'side'
      `).bind(FIGHTER_ID).first<{ count: number }>())?.count).toBe(2);
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

      expect(first.animationFormat).toBe('legacy');
      expect(replay).toMatchObject({ reused: true, versionId: first.versionId });
      expect(regenerated.versionId).not.toBe(first.versionId);
      expect(upgraded.versionId).not.toBe(regenerated.versionId);
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM sprite_versions WHERE fighter_id = ? AND animation_name = 'idle'
      `).bind(FIGHTER_ID).first<{ count: number }>())?.count).toBe(3);
      expect((await db.prepare('SELECT quality_tier AS tier FROM fighters WHERE id = ?')
        .bind(FIGHTER_ID).first<{ tier: string }>())?.tier).toBe('rookie');

      const current = await db.prepare(`
        SELECT blob_key, raw_blob_key, animation_format FROM sprites
        WHERE fighter_id = ? AND animation_name = 'idle' AND quality_tier = 'contender'
      `).bind(FIGHTER_ID).first<{ blob_key: string; raw_blob_key: string; animation_format: string }>();
      expect(current?.blob_key).toBe(upgraded.blobKey);
      expect(current?.raw_blob_key).toBe(upgraded.rawBlobKey);
      expect(current?.animation_format).toBe('legacy');
      const restored = await promoteGeneratedSpriteVersion(env, {
        userId: USER_ID,
        fighterId: FIGHTER_ID,
        tier: 'rookie',
        animationName: 'idle',
        versionId: first.versionId,
      });
      expect(restored.blob_key).toBe(first.blobKey);
      expect(await db.prepare(`
        SELECT blob_key, raw_blob_key FROM sprites
        WHERE fighter_id = ? AND animation_name = 'idle' AND quality_tier = 'rookie'
      `).bind(FIGHTER_ID).first()).toEqual({
        blob_key: first.blobKey,
        raw_blob_key: first.rawBlobKey,
      });
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM sprite_versions WHERE fighter_id = ? AND animation_name = 'idle'
      `).bind(FIGHTER_ID).first<{ count: number }>())?.count).toBe(3);
      for (const asset of [first, regenerated, upgraded]) {
        expect(await bucket.head(asset.blobKey)).not.toBeNull();
        expect(await bucket.head(asset.rawBlobKey!)).not.toBeNull();
      }
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('keeps identical bytes as separate immutable versions when the playback contract changes', async () => {
    const { mf, db, env } = await bindings();
    try {
      const base = {
        userId: USER_ID,
        fighterId: FIGHTER_ID,
        tier: 'champion' as const,
        animationName: 'walk',
        bytes: png(101),
        rawBytes: png(102),
        frameWidth: 256,
        frameHeight: 256,
        frameCount: 12,
        processingVersion: 5,
      };
      const legacy = await persistGeneratedSprite(env, {
        ...base,
        jobId: 'job-format-legacy',
      });
      const correctedMetadata = await persistGeneratedSprite(env, {
        ...base,
        jobId: 'job-format-corrected-metadata',
        frameCount: 11,
      });
      const dense = await persistGeneratedSprite(env, {
        ...base,
        jobId: 'job-format-dense',
        animationFormat: 'video-dense-v1',
      });

      expect(legacy.versionId).not.toBe(dense.versionId);
      expect(correctedMetadata.versionId).not.toBe(legacy.versionId);
      expect(legacy.animationFormat).toBe('legacy');
      expect(dense.animationFormat).toBe('video-dense-v1');
      const { results } = await db.prepare(`
        SELECT animation_format FROM sprite_versions
        WHERE fighter_id = ? AND animation_name = 'walk'
        ORDER BY animation_format
      `).bind(FIGHTER_ID).all<{ animation_format: string }>();
      expect(results).toEqual([
        { animation_format: 'legacy' },
        { animation_format: 'legacy' },
        { animation_format: 'video-dense-v1' },
      ]);
      expect((await db.prepare(`
        SELECT animation_format FROM sprites
        WHERE fighter_id = ? AND animation_name = 'walk' AND quality_tier = 'champion'
      `).bind(FIGHTER_ID).first<{ animation_format: string }>())?.animation_format)
        .toBe('video-dense-v1');
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('archives a private video candidate without changing the current sprite on new or duplicate paths', async () => {
    const { mf, db, env } = await bindings();
    try {
      const base = {
        userId: USER_ID,
        fighterId: FIGHTER_ID,
        tier: 'champion' as const,
        animationName: 'high_kick',
        frameWidth: 192,
        frameHeight: 256,
        frameCount: 23,
        processingVersion: 5,
        animationFormat: 'video-dense-v1' as const,
      };
      const current = await persistGeneratedSprite(env, {
        ...base,
        jobId: 'job-current-video-sprite',
        bytes: png(120),
        rawBytes: png(121),
      });
      const privateCandidate = await persistGeneratedSprite(env, {
        ...base,
        jobId: 'job-private-video-sprite',
        bytes: png(122),
        rawBytes: png(123),
        setCurrent: false,
      });
      const privateReplay = await persistGeneratedSprite(env, {
        ...base,
        jobId: 'job-private-video-sprite-replay',
        bytes: png(122),
        rawBytes: png(123),
        setCurrent: false,
      });

      expect(privateCandidate.versionId).not.toBe(current.versionId);
      expect(privateReplay).toMatchObject({ reused: true, versionId: privateCandidate.versionId });
      expect(await db.prepare(`
        SELECT blob_key, raw_blob_key, content_hash, raw_content_hash
        FROM sprites
        WHERE fighter_id = ? AND animation_name = 'high_kick' AND quality_tier = 'champion'
      `).bind(FIGHTER_ID).first()).toEqual({
        blob_key: current.blobKey,
        raw_blob_key: current.rawBlobKey,
        content_hash: current.contentHash,
        raw_content_hash: current.rawContentHash,
      });
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM sprite_versions
        WHERE fighter_id = ? AND animation_name = 'high_kick' AND quality_tier = 'champion'
      `).bind(FIGHTER_ID).first<{ count: number }>())?.count).toBe(2);
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('restores the exact 3 source and 4 sprite checkpoints before low_punch without deleting newer versions', async () => {
    const { mf, db, bucket, env } = await bindings();
    const runId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const job: GenerationJob = {
      id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      workflow_instance_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      user_id: USER_ID,
      fighter_id: FIGHTER_ID,
      charge_id: 'cccccccccccccccccccccccccccccccc',
      provider_session_id: 'dddddddddddddddddddddddddddddddd',
      creation_flow: 'original',
      tier: 'champion',
      operation: 'fighter_generation',
      target_kind: null,
      target_name: null,
      artifact_run_id: runId,
      resumed_from_job_id: null,
      status: 'running',
      stage: 'source:side',
      failure_stage: null,
      progress_current: 0,
      progress_total: 14,
      error_code: null,
      error_message: null,
      started_at: null,
      finished_at: null,
      created_at: '2026-08-24 00:00:00',
      updated_at: '2026-08-24 00:00:00',
    };
    try {
      await db.prepare('INSERT INTO generation_artifact_runs (id) VALUES (?)').bind(runId).run();
      const sources = [
        ['side', 'side_raw', 1, 20],
        ['upright', 'upright_raw', 2, 30],
        ['crouch', 'crouch_raw', 3, 40],
      ] as const;
      const sourceCheckpoints: Array<{
        clean: Awaited<ReturnType<typeof persistGeneratedSource>>;
        raw: Awaited<ReturnType<typeof persistGeneratedSource>>;
      }> = [];
      for (const [cleanKind, rawKind, stageIndex, marker] of sources) {
        const clean = await persistGeneratedSource(env, {
          jobId: job.id,
          userId: USER_ID,
          fighterId: FIGHTER_ID,
          kind: cleanKind,
          bytes: png(marker),
        });
        const raw = await persistGeneratedSource(env, {
          jobId: job.id,
          userId: USER_ID,
          fighterId: FIGHTER_ID,
          kind: rawKind,
          bytes: png(marker + 1),
        });
        sourceCheckpoints.push({ clean, raw });
        await recordSourceCheckpoint(env, job, {
          sourceName: cleanKind,
          stageIndex,
          clean,
          raw,
        });
      }

      const animations = ['idle', 'walk', 'high_punch', 'high_kick'] as const;
      const spriteCheckpoints: Array<Awaited<ReturnType<typeof persistGeneratedSprite>>> = [];
      for (const [index, animationName] of animations.entries()) {
        const sprite = await persistGeneratedSprite(env, {
          jobId: job.id,
          userId: USER_ID,
          fighterId: FIGHTER_ID,
          tier: 'champion',
          animationName,
          bytes: png(60 + index * 2),
          rawBytes: png(61 + index * 2),
          frameWidth: 256,
          frameHeight: 256,
          frameCount: animationName === 'idle' || animationName === 'walk' ? 8 : 7,
          processingVersion: 5,
          animationFormat: animationName === 'high_kick' ? 'video-dense-v1' : undefined,
        });
        spriteCheckpoints.push(sprite);
        await recordSpriteCheckpoint(env, job, {
          animationName,
          stageIndex: index + 4,
          sprite,
          processingVersion: 5,
        });
      }

      const newerSide = await persistGeneratedSource(env, {
        jobId: 'job-newer-side',
        userId: USER_ID,
        fighterId: FIGHTER_ID,
        kind: 'side',
        bytes: png(90),
      });
      const newerIdle = await persistGeneratedSprite(env, {
        jobId: 'job-newer-idle',
        userId: USER_ID,
        fighterId: FIGHTER_ID,
        tier: 'champion',
        animationName: 'idle',
        bytes: png(91),
        rawBytes: png(92),
        frameWidth: 256,
        frameHeight: 256,
        frameCount: 8,
        processingVersion: 5,
      });

      for (const [cleanKind] of sources) {
        expect(await reuseSourceCheckpoint(env, job, cleanKind)).not.toBeNull();
      }
      for (const animationName of animations) {
        expect(await reuseSpriteCheckpoint(env, job, animationName)).not.toBeNull();
      }
      expect((await db.prepare(`
        SELECT animation_format FROM generation_artifact_checkpoints
        WHERE run_id = ? AND artifact_kind = 'sprite' AND artifact_name = 'high_kick'
      `).bind(runId).first<{ animation_format: string }>())?.animation_format)
        .toBe('video-dense-v1');

      const progress = await artifactProgress(env, {
        id: runId,
        operation: 'fighter_generation',
        target_name: null,
      });
      expect(progress.completedStages).toEqual([
        'source:side',
        'source:upright',
        'source:crouch',
        'sprite:idle',
        'sprite:walk',
        'sprite:high_punch',
        'sprite:high_kick',
      ]);
      expect(progress.pendingStages[0]).toBe('sprite:low_punch');
      expect(progress.preservedArtifactCount).toBe(7);
      expect((await db.prepare('SELECT side_view_blob_key AS key FROM fighters WHERE id = ?')
        .bind(FIGHTER_ID).first<{ key: string }>())?.key).toBe(sourceCheckpoints[0].clean.blobKey);
      expect((await db.prepare(`
        SELECT blob_key FROM sprites
        WHERE fighter_id = ? AND quality_tier = 'champion' AND animation_name = 'idle'
      `).bind(FIGHTER_ID).first<{ blob_key: string }>())?.blob_key).toBe(spriteCheckpoints[0].blobKey);
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM source_versions WHERE fighter_id = ? AND kind = 'side'
      `).bind(FIGHTER_ID).first<{ count: number }>())?.count).toBe(2);
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM sprite_versions
        WHERE fighter_id = ? AND quality_tier = 'champion' AND animation_name = 'idle'
      `).bind(FIGHTER_ID).first<{ count: number }>())?.count).toBe(2);
      expect(await bucket.head(newerSide.blobKey)).not.toBeNull();
      expect(await bucket.head(newerIdle.blobKey)).not.toBeNull();

      await bucket.delete(sourceCheckpoints[0].clean.blobKey);
      await expect(reuseSourceCheckpoint(env, job, 'side'))
        .rejects.toThrow('checkpoint blob is missing from durable storage');
      expect((await db.prepare(`
        SELECT status FROM generation_artifact_checkpoints
        WHERE run_id = ? AND artifact_kind = 'source' AND artifact_name = 'side'
      `).bind(runId).first<{ status: string }>())?.status).toBe('corrupt');
      expect((await db.prepare('SELECT status FROM generation_artifact_runs WHERE id = ?')
        .bind(runId).first<{ status: string }>())?.status).toBe('failed');
    } finally {
      await mf.dispose();
    }
  }, 15_000);
});
