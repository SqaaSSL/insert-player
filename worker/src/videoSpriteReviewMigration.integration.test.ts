import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

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

async function applyMigrations(
  db: D1Database,
  through = '0032_video_sprite_safe_registration.sql',
): Promise<void> {
  for (const migration of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql') && name <= through)
    .sort()) {
    for (const statement of migrationStatements(
      readFileSync(join(migrationsDirectory, migration), 'utf8'),
    )) await db.prepare(statement).run();
  }
}

async function database(): Promise<{ mf: Miniflare; db: D1Database }> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: 'video-review-migration-test',
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
        env: { DB: { type: 'd1', id: 'video-review-migration-db' } },
      },
    }],
  });
  return { mf, db: await mf.getD1Database('DB') };
}

async function seedJob(
  db: D1Database,
  suffix: string,
  options: { flow?: 'original' | 'video'; resumedFrom?: string | null; runId?: string } = {},
): Promise<void> {
  const flow = options.flow ?? 'video';
  const runId = options.runId ?? `run-${suffix}`;
  await db.batch([
    db.prepare(`
      INSERT INTO generation_charges (
        id, user_id, tier, status, reason, fighter_id, expires_at, creation_flow
      ) VALUES (?, 'user-video-review', 'champion', 'committed',
        'fighter_generation', 'fighter-video-review', datetime('now', '+1 day'), ?)
    `).bind(`charge-${suffix}`, flow),
    db.prepare(`
      INSERT INTO provider_sessions (
        id, user_id, rate_limit_key, tier, purpose, charge_id, status,
        provider_call_limit, provider_cost_limit_cents, expires_at, creation_flow
      ) VALUES (?, 'user-video-review', 'user:user-video-review', 'champion',
        'fighter_generation', ?, 'completed', 320, 1800, datetime('now', '+1 day'), ?)
    `).bind(`session-${suffix}`, `charge-${suffix}`, flow),
    db.prepare(`
      INSERT OR IGNORE INTO generation_artifact_runs (
        id, user_id, fighter_id, tier, operation, root_job_id,
        original_charge_id, status, creation_flow
      ) VALUES (?, 'user-video-review', 'fighter-video-review', 'champion',
        'fighter_generation', ?, ?, 'partial', ?)
    `).bind(runId, `job-${suffix}`, `charge-${suffix}`, flow),
    db.prepare(`
      INSERT INTO generation_jobs (
        id, workflow_instance_id, user_id, fighter_id, charge_id,
        provider_session_id, tier, operation, artifact_run_id,
        resumed_from_job_id, status, creation_flow
      ) VALUES (?, ?, 'user-video-review', 'fighter-video-review', ?, ?,
        'champion', 'fighter_generation', ?, ?, 'succeeded', ?)
    `).bind(
      `job-${suffix}`, `workflow-${suffix}`, `charge-${suffix}`, `session-${suffix}`,
      runId, options.resumedFrom ?? null, flow,
    ),
  ]);
}

describe('video sprite review migrations', () => {
  it('applies additively and enforces one review gate and one paid video dispatch per job', async () => {
    const { mf, db } = await database();
    try {
      await applyMigrations(db);
      await db.batch([
        db.prepare(`
          INSERT INTO users (id, display_name, oauth_provider, oauth_id)
          VALUES ('user-video-review', 'Video Review', 'clerk', 'clerk-video-review')
        `),
        db.prepare(`
          INSERT INTO fighters (id, owner_user_id, name, photo_hash, quality_tier)
          VALUES ('fighter-video-review', 'user-video-review', 'Video Fighter', 'photo', 'champion')
        `),
      ]);
      await seedJob(db, 'root', { runId: 'run-shared' });
      await seedJob(db, 'first', { runId: 'run-shared', resumedFrom: 'job-root' });

      await expect(seedJob(db, 'second', {
        runId: 'run-shared',
        resumedFrom: 'job-root',
      })).rejects.toThrow(/UNIQUE constraint failed/);

      await seedJob(db, 'original-root', { flow: 'original', runId: 'run-original' });
      await seedJob(db, 'original-first', {
        flow: 'original', runId: 'run-original', resumedFrom: 'job-original-root',
      });
      await seedJob(db, 'original-second', {
        flow: 'original', runId: 'run-original', resumedFrom: 'job-original-root',
      });

      await db.prepare(`
        INSERT INTO provider_request_cache (
          id, job_id, artifact_run_id, provider, method, request_path,
          request_hash, request_key, status, owner_attempt_id
        ) VALUES (
          'cache-video-idle', 'job-first', 'run-shared', 'pixcli', 'POST',
          '/proxy/pixcli/api/v1/video/advanced', 'hash-idle',
          'run:run-shared:sprite:idle', 'pending', 'attempt-idle'
        )
      `).run();
      await expect(db.prepare(`
        INSERT INTO provider_request_cache (
          id, job_id, artifact_run_id, provider, method, request_path,
          request_hash, request_key, status, owner_attempt_id
        ) VALUES (
          'cache-video-walk', 'job-first', 'run-shared', 'pixcli', 'POST',
          '/proxy/pixcli/api/v1/video/advanced', 'hash-walk',
          'run:run-shared:sprite:walk', 'pending', 'attempt-walk'
        )
      `).run()).rejects.toThrow(/UNIQUE constraint failed/);

      await db.prepare(`
        INSERT INTO video_sprite_candidates (
          id, run_id, job_id, user_id, fighter_id, action, sequence_order
        ) VALUES (
          'candidate-idle', 'run-shared', 'job-first', 'user-video-review',
          'fighter-video-review', 'idle', 0
        )
      `).run();
      await expect(db.prepare(`
        INSERT INTO video_sprite_candidates (
          id, run_id, job_id, user_id, fighter_id, action, sequence_order
        ) VALUES (
          'candidate-root', 'run-shared', 'job-root', 'user-video-review',
          'fighter-video-review', 'walk', 1
        )
      `).run()).rejects.toThrow(/UNIQUE constraint failed/);

      expect(await db.prepare(`
        SELECT review_status FROM generation_jobs WHERE id = 'job-root'
      `).first()).toEqual({ review_status: 'none' });
      expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toHaveLength(0);
    } finally {
      await mf.dispose();
    }
  }, 30_000);

  it('preserves version-5 revisions and accepts safe-registration version 6 immutably', async () => {
    const { mf, db } = await database();
    try {
      await applyMigrations(db, '0031_video_sprite_review.sql');
      await db.batch([
        db.prepare(`
          INSERT INTO users (id, display_name, oauth_provider, oauth_id)
          VALUES ('user-video-review', 'Video Review', 'clerk', 'clerk-video-review')
        `),
        db.prepare(`
          INSERT INTO fighters (id, owner_user_id, name, photo_hash, quality_tier)
          VALUES ('fighter-video-review', 'user-video-review', 'Video Fighter', 'photo', 'champion')
        `),
      ]);
      await seedJob(db, 'migration', { runId: 'run-migration' });
      await db.batch([
        db.prepare(`
          INSERT INTO sprite_versions (
            id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
            frame_w, frame_h, frame_count, processing_version, animation_format
          ) VALUES (
            'sprite-v5', 'fighter-video-review', 'high_kick', 'champion',
            'runtime-v5.png', 'raw-v5.png', 192, 256, 23, 5, 'video-dense-v1'
          )
        `),
        db.prepare(`
          INSERT INTO video_sprite_candidates (
            id, run_id, job_id, user_id, fighter_id, action, sequence_order
          ) VALUES (
            'candidate-migration', 'run-migration', 'job-migration', 'user-video-review',
            'fighter-video-review', 'high_kick', 3
          )
        `),
        db.prepare(`
          INSERT INTO video_sprite_candidate_revisions (
            candidate_id, revision, compiler_outcome, sprite_version_id,
            provider_model, pixcli_job_id, provider_request_id, prompt_sha256,
            canonical_blob_key, canonical_sha256,
            provider_audit_blob_key, provider_audit_sha256,
            video_blob_key, video_sha256, video_size_bytes,
            processed_blob_key, processed_sha256, raw_blob_key, raw_sha256,
            contact_sheet_blob_key, contact_sheet_sha256,
            unique_sheet_blob_key, unique_sheet_sha256,
            report_blob_key, report_sha256, report_content_sha256,
            frame_w, frame_h, frame_count, raw_frame_w, raw_frame_h, raw_frame_count,
            source_frame_count, animation_format, processing_version,
            selected_indices_json, playback_json, translations_json
          ) VALUES (
            'candidate-migration', 1, 'needs_review', 'sprite-v5',
            'grok-imagine-i2v-pinned', 'pppppppppppppppppppppppppppppppp',
            'request-v5', ?, 'canonical-v5.png', ?, 'audit-v5.json', ?,
            'source-v5.mp4', ?, 12, 'runtime-v5.png', ?, 'raw-v5.png', ?,
            'contact-v5.png', ?, 'unique-v5.png', ?, 'report-v5.json', ?, ?,
            192, 256, 23, 768, 1024, 12, 49, 'video-dense-v1', 5,
            '[0,1,2,3,4,5,6,7,8,9,10]',
            '[0,1,2,3,4,5,6,7,8,9,10,11,10,9,8,7,6,5,4,3,2,1,0]',
            '[{"dx":0,"dy":0}]'
          )
        `).bind(...Array(10).fill('a'.repeat(64))),
      ]);

      for (const statement of migrationStatements(readFileSync(
        join(migrationsDirectory, '0032_video_sprite_safe_registration.sql'),
        'utf8',
      ))) await db.prepare(statement).run();

      expect(await db.prepare(`
        SELECT processing_version FROM video_sprite_candidate_revisions
        WHERE candidate_id = 'candidate-migration' AND revision = 1
      `).first()).toEqual({ processing_version: 5 });

      await db.prepare(`
        INSERT INTO sprite_versions (
          id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
          frame_w, frame_h, frame_count, processing_version, animation_format
        ) VALUES (
          'sprite-v6', 'fighter-video-review', 'high_kick', 'champion',
          'runtime-v6.png', 'raw-v6.png', 192, 256, 23, 6, 'video-dense-v1'
        )
      `).run();
      const insertRevision = (revision: number, processingVersion: number) => db.prepare(`
        INSERT INTO video_sprite_candidate_revisions (
          candidate_id, revision, compiler_outcome, sprite_version_id,
          provider_model, pixcli_job_id, provider_request_id, prompt_sha256,
          canonical_blob_key, canonical_sha256,
          provider_audit_blob_key, provider_audit_sha256,
          video_blob_key, video_sha256, video_size_bytes,
          processed_blob_key, processed_sha256, raw_blob_key, raw_sha256,
          contact_sheet_blob_key, contact_sheet_sha256,
          unique_sheet_blob_key, unique_sheet_sha256,
          report_blob_key, report_sha256, report_content_sha256,
          frame_w, frame_h, frame_count, raw_frame_w, raw_frame_h, raw_frame_count,
          source_frame_count, animation_format, processing_version,
          selected_indices_json, playback_json, translations_json
        ) VALUES (
          'candidate-migration', ?, 'needs_review', 'sprite-v6',
          'grok-imagine-i2v-pinned', 'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
          'request-v6', ?, 'canonical-v6.png', ?, 'audit-v6.json', ?,
          'source-v6.mp4', ?, 12, 'runtime-v6.png', ?, 'raw-v6.png', ?,
          'contact-v6.png', ?, 'unique-v6.png', ?, 'report-v6.json', ?, ?,
          192, 256, 23, 768, 1024, 12, 49, 'video-dense-v1', ?,
          '[0,1,2,3,4,5,6,7,8,9,10]',
          '[0,1,2,3,4,5,6,7,8,9,10,11,10,9,8,7,6,5,4,3,2,1,0]',
          '[{"dx":0,"dy":0}]'
        )
      `).bind(revision, ...Array(10).fill('b'.repeat(64)), processingVersion);
      await insertRevision(2, 6).run();
      await expect(insertRevision(3, 7).run()).rejects.toThrow(/CHECK constraint failed/);
      await expect(db.prepare(`
        UPDATE video_sprite_candidate_revisions SET compiler_outcome = 'technical_pass'
        WHERE candidate_id = 'candidate-migration' AND revision = 2
      `).run()).rejects.toThrow(/immutable/);
      await expect(db.prepare(`
        UPDATE video_sprite_candidate_revisions SET processing_version = 7
        WHERE candidate_id = 'candidate-migration' AND revision = 2
      `).run()).rejects.toThrow(/immutable/);
      expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toHaveLength(0);
    } finally {
      await mf.dispose();
    }
  }, 30_000);
});
