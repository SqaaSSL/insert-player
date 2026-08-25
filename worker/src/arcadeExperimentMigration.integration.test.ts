import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
// The production archivist is JavaScript by design so it can run directly in GitHub Actions.
// @ts-expect-error No declaration file is needed for this integration-only import.
import { buildArcadeExperimentIndexSql } from '../../scripts/archive-arcade-experiment.mjs';

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../migrations/0027_immutable_arcade_experiments.sql',
);

function migrationStatements(sql: string): string[] {
  const statements: string[] = [];
  let statement = '';
  let trigger = false;
  for (const line of sql.split('\n')) {
    if (/^\s*--/.test(line) || (!statement && !line.trim())) continue;
    statement += `${line}\n`;
    if (/^\s*CREATE\s+TRIGGER\b/i.test(line)) trigger = true;
    const complete = trigger ? /^\s*END;\s*$/i.test(line) : /;\s*$/.test(line);
    if (complete) {
      statements.push(statement.trim());
      statement = '';
      trigger = false;
    }
  }
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}

async function database(): Promise<{ mf: Miniflare; db: D1Database }> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: 'arcade-experiment-migration-test',
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
        env: { DB: { type: 'd1', id: 'arcade-experiment-migration-db' } },
      },
    }],
  });
  return { mf, db: await mf.getD1Database('DB') };
}

async function applyMigration(db: D1Database): Promise<void> {
  for (const statement of migrationStatements(readFileSync(migrationPath, 'utf8'))) {
    await db.prepare(statement).run();
  }
}

async function seedArchive(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`
      INSERT INTO arcade_generation_experiments (
        id, schema_version, matrix_sha256, status, policy_json,
        index_content_hash, slot_count, artifact_count,
        state_blob_key, state_content_hash, state_size_bytes,
        manifest_blob_key, manifest_content_hash, manifest_size_bytes,
        github_repository, github_run_id
      ) VALUES (
        'experiment-v1', 2, ?, 'complete', '{"fallback":"none"}',
        ?, 1, 1, 'state.json', ?, 100, 'manifest.json', ?, 200,
        'SqaaSSL/insert-player', 123
      )
    `).bind('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)),
    db.prepare(`
      INSERT INTO arcade_generation_experiment_slots (
        experiment_id, slot_key, fighter_slug, fighter_name, model_id,
        provider_endpoint, source_sha256, prompt_sha256, request_sha256, status
      ) VALUES (
        'experiment-v1', 'fighter:model', 'fighter', 'Fighter', 'model',
        'provider/model', ?, ?, ?, 'completed'
      )
    `).bind('e'.repeat(64), 'f'.repeat(64), '1'.repeat(64)),
    db.prepare(`
      INSERT INTO arcade_generation_experiment_artifacts (
        experiment_id, slot_key, artifact_kind, blob_key,
        content_sha256, mime_type, size_bytes
      ) VALUES (
        'experiment-v1', 'fighter:model', 'image', 'image.png',
        ?, 'image/png', 42
      )
    `).bind('2'.repeat(64)),
  ]);
}

describe('0027 immutable Arcade experiments migration', () => {
  it('stores a complete experiment graph and rejects every mutation', async () => {
    const { mf, db } = await database();
    try {
      await applyMigration(db);
      await seedArchive(db);

      expect(await db.prepare(`
        SELECT slot_count, artifact_count FROM arcade_generation_experiments
        WHERE id = 'experiment-v1'
      `).first()).toMatchObject({ slot_count: 1, artifact_count: 1 });

      await expect(db.prepare(`
        UPDATE arcade_generation_experiments SET status = 'incomplete'
        WHERE id = 'experiment-v1'
      `).run()).rejects.toThrow(/immutable/);
      await expect(db.prepare(`
        UPDATE arcade_generation_experiment_slots SET fighter_name = 'Changed'
        WHERE experiment_id = 'experiment-v1'
      `).run()).rejects.toThrow(/immutable/);
      await expect(db.prepare(`
        DELETE FROM arcade_generation_experiment_artifacts
        WHERE experiment_id = 'experiment-v1'
      `).run()).rejects.toThrow(/immutable/);
      await expect(db.prepare(`
        DELETE FROM arcade_generation_experiments WHERE id = 'experiment-v1'
      `).run()).rejects.toThrow(/immutable/);
    } finally {
      await mf.dispose();
    }
  }, 30_000);

  it('accepts the exact idempotent SQL emitted by the production archivist', async () => {
    const { mf, db } = await database();
    try {
      await applyMigration(db);
      const plan = {
        state: {
          experimentId: 'generated-sql-v1',
          schemaVersion: 2,
          matrixSha256: 'a'.repeat(64),
          status: 'complete',
          policy: { expectedPaidCalls: 1, fallback: 'none', activation: false },
          createdAt: '2026-08-25T00:00:00.000Z',
          completedAt: '2026-08-25T00:01:00.000Z',
        },
        descriptor: { githubRunId: 123 },
        repository: 'SqaaSSL/insert-player',
        indexContentHash: 'b'.repeat(64),
        artifactCount: 1,
        stateBlobKey: 'state.json',
        stateContentHash: 'c'.repeat(64),
        stateBytes: Buffer.alloc(100),
        manifestBlobKey: 'manifest.json',
        manifestContentHash: 'd'.repeat(64),
        manifestBytes: Buffer.alloc(200),
        slots: [{
          slotKey: 'fighter:model',
          fighterSlug: 'fighter',
          fighterName: "Fighter O'Clock",
          modelId: 'model',
          providerEndpoint: 'provider/model',
          sourceSha256: 'e'.repeat(64),
          promptSha256: 'f'.repeat(64),
          requestSha256: '1'.repeat(64),
          status: 'completed',
          pixcliJobId: 'job-1',
          providerRequestId: 'request-1',
          pixcliCostEstimate: 70000,
          imageContentHash: '2'.repeat(64),
          completedAt: '2026-08-25T00:01:00.000Z',
          artifacts: [{
            kind: 'image',
            blobKey: 'image.png',
            contentSha256: '2'.repeat(64),
            mimeType: 'image/png',
            sizeBytes: 42,
            pixcliAssetHash: '3'.repeat(32),
            providerRequestId: 'request-1',
          }],
        }],
      };
      const sql = buildArcadeExperimentIndexSql(plan);
      for (const statement of migrationStatements(sql)) await db.prepare(statement).run();
      for (const statement of migrationStatements(sql)) await db.prepare(statement).run();

      expect(await db.prepare(`
        SELECT e.slot_count, e.artifact_count,
          (SELECT COUNT(*) FROM arcade_generation_experiment_slots s
           WHERE s.experiment_id = e.id) AS actual_slots,
          (SELECT COUNT(*) FROM arcade_generation_experiment_artifacts a
           WHERE a.experiment_id = e.id) AS actual_artifacts
        FROM arcade_generation_experiments e WHERE e.id = 'generated-sql-v1'
      `).first()).toMatchObject({
        slot_count: 1,
        artifact_count: 1,
        actual_slots: 1,
        actual_artifacts: 1,
      });
    } finally {
      await mf.dispose();
    }
  }, 30_000);
});
