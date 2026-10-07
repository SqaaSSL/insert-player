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

async function applyMigrations(db: D1Database, through: string, from = ''): Promise<void> {
  for (const migration of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql') && name > from && name <= through)
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
        name: 'video-extra-migration-test',
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
        env: { DB: { type: 'd1', id: 'video-extra-migration-db' } },
      },
    }],
  });
  return { mf, db: await mf.getD1Database('DB') };
}

const BEFORE = '0046_demo_free_finisher.sql';
const EXTRA = '0047_video_sprite_extra_candidates.sql';
const HASH = 'a'.repeat(64);

async function seedRun(db: D1Database, suffix: string): Promise<void> {
  await db.batch([
    db.prepare(`
      INSERT INTO generation_charges (
        id, user_id, tier, status, reason, fighter_id, expires_at, creation_flow
      ) VALUES (?, 'user-extra', 'champion', 'committed',
        'fighter_generation', 'fighter-extra', datetime('now', '+1 day'), 'video')
    `).bind(`charge-${suffix}`),
    db.prepare(`
      INSERT INTO provider_sessions (
        id, user_id, rate_limit_key, tier, purpose, charge_id, status,
        provider_call_limit, provider_cost_limit_cents, expires_at, creation_flow
      ) VALUES (?, 'user-extra', 'user:user-extra', 'champion',
        'fighter_generation', ?, 'completed', 320, 1800, datetime('now', '+1 day'), 'video')
    `).bind(`session-${suffix}`, `charge-${suffix}`),
    db.prepare(`
      INSERT INTO generation_artifact_runs (
        id, user_id, fighter_id, tier, operation, root_job_id,
        original_charge_id, status, creation_flow
      ) VALUES (?, 'user-extra', 'fighter-extra', 'champion',
        'fighter_generation', ?, ?, 'partial', 'video')
    `).bind(`run-${suffix}`, `job-${suffix}`, `charge-${suffix}`),
    db.prepare(`
      INSERT INTO generation_jobs (
        id, workflow_instance_id, user_id, fighter_id, charge_id,
        provider_session_id, tier, operation, artifact_run_id, status, creation_flow
      ) VALUES (?, ?, 'user-extra', 'fighter-extra', ?, ?,
        'champion', 'fighter_generation', ?, 'succeeded', 'video')
    `).bind(`job-${suffix}`, `workflow-${suffix}`, `charge-${suffix}`, `session-${suffix}`, `run-${suffix}`),
    db.prepare(`
      INSERT INTO sprite_versions (
        id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
        frame_w, frame_h, frame_count, processing_version, animation_format
      ) VALUES (?, 'fighter-extra', ?, 'champion', ?, ?, 192, 256, 8, 6, 'video-dense-v1')
    `).bind(`sprite-${suffix}`, suffix, `runtime-${suffix}.png`, `raw-${suffix}.png`),
  ]);
}

function insertCandidate(db: D1Database, suffix: string, action: string, order: number) {
  return db.prepare(`
    INSERT INTO video_sprite_candidates (
      id, run_id, job_id, user_id, fighter_id, action, sequence_order
    ) VALUES (?, ?, ?, 'user-extra', 'fighter-extra', ?, ?)
  `).bind(`candidate-${suffix}`, `run-${suffix}`, `job-${suffix}`, action, order);
}

function insertRevision(db: D1Database, suffix: string) {
  return db.prepare(`
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
      ?, 1, 'needs_review', ?, 'grok-imagine-i2v-pinned', 'pppppppppppppppppppppppppppppppp',
      'request-extra', ?, 'canonical.png', ?, 'audit.json', ?, 'source.mp4', ?, 12,
      'runtime.png', ?, 'raw.png', ?, 'contact.png', ?, 'unique.png', ?, 'report.json', ?, ?,
      192, 256, 8, 768, 1024, 8, 49, 'video-dense-v1', 6,
      '[0,1,2,3,4,5,6,7]', '[0,1,2,3,4,5,6,7]', '[{"dx":0,"dy":0}]'
    )
  `).bind(`candidate-${suffix}`, `sprite-${suffix}`, ...Array(10).fill(HASH));
}

describe('extra-move video candidate migration', () => {
  it('copies every base candidate and revision, then admits fireball/uppercut at 11/12 only', async () => {
    const { mf, db } = await database();
    try {
      await applyMigrations(db, BEFORE);
      await db.batch([
        db.prepare(`
          INSERT INTO users (id, display_name, oauth_provider, oauth_id)
          VALUES ('user-extra', 'Extra', 'clerk', 'clerk-extra')
        `),
        db.prepare(`
          INSERT INTO fighters (id, owner_user_id, name, photo_hash, quality_tier)
          VALUES ('fighter-extra', 'user-extra', 'Extra Fighter', 'photo', 'champion')
        `),
      ]);
      for (const suffix of ['victory', 'fireball', 'uppercut', 'misordered']) await seedRun(db, suffix);
      await db.batch([insertCandidate(db, 'victory', 'victory', 10), insertRevision(db, 'victory')]);
      await db.prepare(`
        UPDATE video_sprite_candidates
        SET status = 'approved', approved_revision = 1, reviewed_at = '2026-09-01 10:00:00'
        WHERE id = 'candidate-victory'
      `).run();
      // Before 0047 production rejects an extra-move candidate after its paid clip.
      await expect(insertCandidate(db, 'fireball', 'fireball', 11).run())
        .rejects.toThrow(/CHECK constraint failed/);

      const snapshot = () => db.prepare(`
        SELECT candidate.*, revision.revision, revision.report_sha256, revision.sprite_version_id,
          revision.processing_version, revision.created_at AS revision_created_at
        FROM video_sprite_candidates candidate
        JOIN video_sprite_candidate_revisions revision ON revision.candidate_id = candidate.id
        ORDER BY candidate.id
      `).all();
      const before = await snapshot();
      await applyMigrations(db, EXTRA, BEFORE);
      const after = await snapshot();
      expect(after.results).toHaveLength(1);
      expect(after.results).toEqual(before.results);

      await db.batch([insertCandidate(db, 'fireball', 'fireball', 11), insertRevision(db, 'fireball')]);
      await db.batch([insertCandidate(db, 'uppercut', 'uppercut', 12), insertRevision(db, 'uppercut')]);
      for (const [action, order] of [['fireball', 3], ['uppercut', 11], ['idle', 11], ['hadouken', 11]] as const) {
        await expect(insertCandidate(db, 'misordered', action, order).run())
          .rejects.toThrow(/CHECK constraint failed/);
      }

      // Revisions stay immutable and still belong to a real candidate.
      await expect(db.prepare(`
        UPDATE video_sprite_candidate_revisions SET compiler_outcome = 'technical_pass'
        WHERE candidate_id = 'candidate-fireball'
      `).run()).rejects.toThrow(/immutable/);
      await expect(insertRevision(db, 'misordered').run()).rejects.toThrow(/FOREIGN KEY constraint failed/);
      const references = await db.prepare(`
        SELECT "table" FROM pragma_foreign_key_list('video_sprite_candidate_revisions')
        WHERE "from" = 'candidate_id'
      `).first<{ table: string }>();
      expect(references?.table).toBe('video_sprite_candidates');

      const objects = await db.prepare(`
        SELECT name FROM sqlite_master
        WHERE name IN (
          'idx_video_sprite_candidates_run', 'idx_video_sprite_candidates_one_pending_run',
          'idx_video_sprite_candidates_one_approved_action', 'video_sprite_candidate_revisions_immutable',
          'video_extra_source_proofs_immutable'
        ) OR name LIKE '%candidate%base'
        ORDER BY name
      `).all<{ name: string }>();
      expect(objects.results.map((row) => row.name)).toEqual([
        'idx_video_sprite_candidates_one_approved_action',
        'idx_video_sprite_candidates_one_pending_run',
        'idx_video_sprite_candidates_run',
        'video_extra_source_proofs_immutable',
        'video_sprite_candidate_revisions_immutable',
      ]);

      // Deleting a job still cascades through the rebuilt candidate to its revisions.
      await db.prepare(`DELETE FROM generation_jobs WHERE id = 'job-uppercut'`).run();
      expect(await db.prepare(`
        SELECT COUNT(*) AS n FROM video_sprite_candidate_revisions WHERE candidate_id = 'candidate-uppercut'
      `).first('n')).toBe(0);

      const insertProof = (jobId: string, runId: string, action: string) => db.prepare(`
        INSERT INTO video_extra_source_proofs (
          job_id, run_id, fighter_id, owner_user_id, action, proof_json, proof_sha256
        ) VALUES (?, ?, 'fighter-extra', 'user-extra', ?, '{}', ?)
      `).bind(jobId, runId, action, HASH);
      await insertProof('job-fireball', 'run-fireball', 'fireball').run();
      await expect(db.prepare(`
        UPDATE video_extra_source_proofs SET proof_json = '{"x":1}' WHERE job_id = 'job-fireball'
      `).run()).rejects.toThrow(/immutable/);
      await expect(insertProof('job-victory', 'run-victory', 'victory').run())
        .rejects.toThrow(/CHECK constraint failed/);
    } finally {
      await mf.dispose();
    }
  }, 60_000);
});
