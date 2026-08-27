import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import { hashString } from './auth';
import {
  generationSourceManifest,
  importReviewedCanonicalSourceCheckpoint,
  parseSealedReviewedCanonicalSources,
  type SealedReviewedCanonicalSources,
} from './reviewedCanonicalSources';
import type { Env, GenerationJob } from './types';

const USER_ID = 'reviewed-source-admin';
const FIGHTER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RUN_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const SCHEMA = `
  CREATE TABLE source_versions (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    content_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    animation_format TEXT,
    processing_version INTEGER,
    metadata_json TEXT,
    completed_by_job_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    verified_at TEXT,
    PRIMARY KEY (run_id, artifact_kind, artifact_name)
  );
`;

async function bindings() {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: 'reviewed-source-test',
        compatibilityDate: '2026-08-23',
        manifest: {
          mainModule: 'index.js',
          modules: {
            'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response("ok"); } };' },
          },
        },
        env: {
          DB: { type: 'd1', id: 'reviewed-source-db' },
          SPRITES: { type: 'r2', name: 'reviewed-source-assets' },
        },
      },
    }],
  });
  const db = await mf.getD1Database('DB');
  const bucket = await mf.getR2Bucket('SPRITES') as unknown as R2Bucket;
  await db.batch(SCHEMA.split(';').map((value) => value.trim()).filter(Boolean)
    .map((statement) => db.prepare(statement)));
  await db.prepare("INSERT INTO generation_artifact_runs (id, status) VALUES (?, 'active')")
    .bind(RUN_ID).run();
  return { mf, db, bucket, env: { DB: db, SPRITES: bucket } as Env };
}

async function stageSealed(db: D1Database, bucket: R2Bucket): Promise<SealedReviewedCanonicalSources> {
  const names = ['side', 'side_raw', 'upright', 'upright_raw', 'crouch', 'crouch_raw'] as const;
  const identities = [];
  for (const [index, kind] of names.entries()) {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, index + 1]);
    const contentSha256 = await hashString(bytes.buffer);
    const versionId = String(index + 1).repeat(32);
    const blobKey = `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/${kind}.png`;
    await bucket.put(blobKey, bytes, { customMetadata: { contentHash: contentSha256 } });
    await db.prepare(`
      INSERT INTO source_versions (id, fighter_id, kind, blob_key, content_hash)
      VALUES (?, ?, ?, ?, ?)
    `).bind(versionId, FIGHTER_ID, kind, blobKey, contentSha256).run();
    identities.push({ versionId, blobKey, contentSha256 });
  }
  return {
    schemaVersion: 1,
    mode: 'reviewed-current-v1',
    fighterId: FIGHTER_ID,
    ownerUserId: USER_ID,
    sources: {
      side: { processed: identities[0], raw: identities[1] },
      upright: { processed: identities[2], raw: identities[3] },
      crouch: { processed: identities[4], raw: identities[5] },
    },
  };
}

const job = {
  id: 'cccccccccccccccccccccccccccccccc',
  user_id: USER_ID,
  fighter_id: FIGHTER_ID,
  tier: 'champion',
  creation_flow: 'video',
  operation: 'fighter_generation',
  artifact_run_id: RUN_ID,
} as GenerationJob;

describe('reviewed canonical source checkpoint import', () => {
  it('imports all three sealed pairs with no image-provider binding or source generation call', async () => {
    const { mf, db, bucket, env } = await bindings();
    try {
      const sealed = await stageSealed(db, bucket);
      expect(env.IMAGE_PROCESSOR).toBeUndefined();
      for (const [index, sourceName] of ['side', 'upright', 'crouch'].entries()) {
        await expect(importReviewedCanonicalSourceCheckpoint(
          env,
          job,
          sealed,
          sourceName as 'side' | 'upright' | 'crouch',
          index + 1,
        )).resolves.toEqual({
          cleanKey: sealed.sources[sourceName as 'side'].processed.blobKey,
          rawKey: sealed.sources[sourceName as 'side'].raw.blobKey,
        });
      }
      expect(await db.prepare(`
        SELECT artifact_name, clean_version_id, raw_version_id, clean_content_hash, raw_content_hash
        FROM generation_artifact_checkpoints ORDER BY stage_index
      `).all()).toMatchObject({ results: [
        {
          artifact_name: 'side',
          clean_version_id: sealed.sources.side.processed.versionId,
          raw_version_id: sealed.sources.side.raw.versionId,
          clean_content_hash: sealed.sources.side.processed.contentSha256,
          raw_content_hash: sealed.sources.side.raw.contentSha256,
        },
        { artifact_name: 'upright' },
        { artifact_name: 'crouch' },
      ] });

      await db.prepare('DELETE FROM source_versions').run();
      await expect(importReviewedCanonicalSourceCheckpoint(env, job, sealed, 'side', 1))
        .resolves.toEqual({
          cleanKey: sealed.sources.side.processed.blobKey,
          rawKey: sealed.sources.side.raw.blobKey,
        });
      expect((await db.prepare('SELECT COUNT(*) AS count FROM generation_artifact_checkpoints')
        .first<{ count: number }>())?.count).toBe(3);
    } finally {
      await mf.dispose();
    }
  }, 30_000);

  it('keeps legacy manifests compatible while fail-closing a malformed reviewed seal', () => {
    const legacy = generationSourceManifest({
      side: 'side',
      sideRaw: 'sideRaw',
      upright: 'upright',
      uprightRaw: 'uprightRaw',
      crouch: 'crouch',
      crouchRaw: 'crouchRaw',
    });
    expect(parseSealedReviewedCanonicalSources(JSON.stringify(legacy))).toBeNull();
    expect(() => parseSealedReviewedCanonicalSources(JSON.stringify({
      ...legacy,
      reviewedCanonicalSources: { schemaVersion: 1 },
    }))).toThrow(/sealed reviewed canonical source manifest is invalid/i);
  });

  it('rehashes checkpointed source bytes on continuation even when R2 metadata is absent', async () => {
    const { mf, db, bucket, env } = await bindings();
    try {
      const sealed = await stageSealed(db, bucket);
      await importReviewedCanonicalSourceCheckpoint(env, job, sealed, 'side', 1);

      await bucket.put(
        sealed.sources.side.processed.blobKey,
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff]),
      );

      await expect(importReviewedCanonicalSourceCheckpoint(env, job, sealed, 'side', 1))
        .rejects.toThrow(/processed source bytes do not match the reviewed SHA-256/i);
    } finally {
      await mf.dispose();
    }
  }, 30_000);
});
