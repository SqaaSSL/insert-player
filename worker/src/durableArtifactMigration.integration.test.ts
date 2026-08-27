import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const integrationTestTimeoutMs = 30_000;

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

async function applyMigrations(db: D1Database, through: string): Promise<void> {
  const migrations = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql') && name <= through)
    .sort();
  for (const migration of migrations) {
    await applyMigration(db, migration);
  }
}

async function applyMigration(db: D1Database, migration: string): Promise<void> {
  for (const statement of migrationStatements(
    readFileSync(`${migrationsDirectory}/${migration}`, 'utf8'),
  )) {
    await db.prepare(statement).run();
  }
}

async function database(): Promise<{ mf: Miniflare; db: D1Database }> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: 'durable-artifact-migration-test',
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
          DB: { type: 'd1', id: 'durable-artifact-migration-db' },
        },
      },
    }],
  });
  return { mf, db: await mf.getD1Database('DB') };
}

describe('0023 durable artifact resume migration', () => {
  it('refuses to migrate underneath an active generation job', async () => {
    const { mf, db } = await database();
    try {
      await applyMigrations(db, '0022_provider_capacity_windows.sql');
      await db.batch([
        db.prepare(`
          INSERT INTO users (id, display_name, oauth_provider, oauth_id)
          VALUES ('user-active', 'Active User', 'clerk', 'clerk-active')
        `),
        db.prepare(`
          INSERT INTO fighters (id, owner_user_id, name, photo_hash, quality_tier)
          VALUES ('fighter-active', 'user-active', 'Active', 'photo-active', 'champion')
        `),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, status, reason, fighter_id, expires_at
          ) VALUES (
            'charge-active', 'user-active', 'champion', 'reserved',
            'fighter_generation', 'fighter-active', datetime('now', '+1 day')
          )
        `),
        db.prepare(`
          INSERT INTO provider_sessions (
            id, user_id, rate_limit_key, tier, purpose, charge_id, status,
            provider_call_limit, provider_cost_limit_cents, expires_at
          ) VALUES (
            'session-active', 'user-active', 'user:user-active', 'champion',
            'fighter_generation', 'charge-active', 'active', 320, 1800,
            datetime('now', '+1 day')
          )
        `),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, workflow_instance_id, user_id, fighter_id, charge_id,
            provider_session_id, tier, operation, status
          ) VALUES (
            'job-active', 'job-active', 'user-active', 'fighter-active',
            'charge-active', 'session-active', 'champion',
            'fighter_generation', 'running'
          )
        `),
      ]);

      await expect(applyMigration(db, '0023_durable_artifact_resume.sql'))
        .rejects.toThrow(/CHECK constraint failed/);
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM generation_jobs WHERE status = 'running'
      `).first<{ count: number }>())?.count).toBe(1);

      await db.prepare(`
        UPDATE generation_jobs
        SET status = 'failed', stage = 'job:stalled', finished_at = datetime('now')
        WHERE id = 'job-active'
      `).run();
      await applyMigration(db, '0023_durable_artifact_resume.sql');
      expect(await db.prepare(`
        SELECT artifact_run_id, failure_stage
        FROM generation_jobs WHERE id = 'job-active'
      `).first()).toMatchObject({
        artifact_run_id: 'job-active',
        failure_stage: 'job:stalled',
      });
    } finally {
      await mf.dispose();
    }
  }, integrationTestTimeoutMs);

  it('fails old dispatches closed while preserving jobs created during rollout', async () => {
    const { mf, db } = await database();
    try {
      await applyMigrations(db, '0022_provider_capacity_windows.sql');
      await db.batch([
        db.prepare(`
          INSERT INTO users (id, display_name, oauth_provider, oauth_id)
          VALUES ('user-rollout', 'Rollout User', 'clerk', 'clerk-rollout')
        `),
        db.prepare(`
          INSERT INTO fighters (
            id, owner_user_id, name, photo_hash, quality_tier, original_blob_key
          ) VALUES (
            'fighter-existing', 'user-rollout', 'Existing', 'photo-existing',
            'champion', 'fighters/existing/original.png'
          )
        `),
        db.prepare(`
          INSERT INTO fighters (
            id, owner_user_id, name, photo_hash, quality_tier, original_blob_key
          ) VALUES (
            'fighter-rollout', 'user-rollout', 'Rollout', 'photo-rollout',
            'champion', 'fighters/rollout/original.png'
          )
        `),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, status, reason, fighter_id, expires_at
          ) VALUES (
            'charge-existing', 'user-rollout', 'champion', 'committed',
            'fighter_generation', 'fighter-existing', datetime('now', '+1 day')
          )
        `),
        db.prepare(`
          INSERT INTO provider_sessions (
            id, user_id, rate_limit_key, tier, purpose, charge_id, status,
            provider_call_limit, provider_cost_limit_cents, expires_at
          ) VALUES (
            'session-existing', 'user-rollout', 'user:user-rollout', 'champion',
            'fighter_generation', 'charge-existing', 'completed', 320, 1800,
            datetime('now', '+1 day')
          )
        `),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, workflow_instance_id, user_id, fighter_id, charge_id,
            provider_session_id, tier, operation, status, stage,
            progress_current, progress_total, error_message
          ) VALUES (
            'job-existing', 'job-existing', 'user-rollout', 'fighter-existing',
            'charge-existing', 'session-existing', 'champion',
            'fighter_generation', 'failed', 'failed', 7, 14,
            'low_punch produced only 4 reliable frames'
          )
        `),
        db.prepare(`
          INSERT INTO provider_request_cache (
            id, job_id, provider, method, request_path, request_hash, status,
            response_blob_key, response_status, response_content_type,
            owner_attempt_id
          ) VALUES (
            'cache-existing', 'job-existing', 'gemini', 'POST',
            '/v1beta/models/gemini-3-pro-image:generateContent', 'hash-existing',
            'succeeded', 'provider-cache/job-existing/response.json', 200,
            'application/json', 'attempt-existing'
          )
        `),
      ]);

      await applyMigration(db, '0023_durable_artifact_resume.sql');

      expect(await db.prepare(`
        SELECT artifact_run_id FROM provider_request_cache WHERE id = 'cache-existing'
      `).first()).toMatchObject({ artifact_run_id: 'job-existing' });

      await db.batch([
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, status, reason, fighter_id, expires_at
          ) VALUES (
            'charge-rollout', 'user-rollout', 'champion', 'committed',
            'fighter_generation', 'fighter-rollout', datetime('now', '+1 day')
          )
        `),
        db.prepare(`
          INSERT INTO provider_sessions (
            id, user_id, rate_limit_key, tier, purpose, charge_id, status,
            provider_call_limit, provider_cost_limit_cents, expires_at
          ) VALUES (
            'session-rollout', 'user-rollout', 'user:user-rollout', 'champion',
            'fighter_generation', 'charge-rollout', 'active', 320, 1800,
            datetime('now', '+1 day')
          )
        `),
        // This is the INSERT shape used by the Worker deployed before 0023.
        db.prepare(`
          INSERT INTO generation_jobs (
            id, workflow_instance_id, user_id, fighter_id, charge_id,
            provider_session_id, tier, operation, target_kind, target_name,
            progress_total
          ) VALUES (
            'job-rollout', 'job-rollout', 'user-rollout', 'fighter-rollout',
            'charge-rollout', 'session-rollout', 'champion',
            'fighter_generation', NULL, NULL, 14
          )
        `),
      ]);

      expect(await db.prepare(`
        SELECT artifact_run_id FROM generation_jobs WHERE id = 'job-rollout'
      `).first()).toMatchObject({ artifact_run_id: 'job-rollout' });
      expect(await db.prepare(`
        SELECT id, root_job_id, original_blob_key, status
        FROM generation_artifact_runs WHERE id = 'job-rollout'
      `).first()).toMatchObject({
        id: 'job-rollout',
        root_job_id: 'job-rollout',
        original_blob_key: 'fighters/rollout/original.png',
        status: 'active',
      });

      // An old Worker cache claim is removed by the trigger, so its subsequent
      // SELECT returns no row and it exits before dispatching to the provider.
      await db.prepare(`
        INSERT OR IGNORE INTO provider_request_cache (
          id, job_id, provider, method, request_path, request_hash,
          owner_attempt_id
        ) VALUES (
          'cache-old-worker', 'job-rollout', 'gemini', 'POST',
          '/v1beta/models/gemini-3-pro-image:generateContent', 'hash-rollout',
          'attempt-old-worker'
        )
      `).run();
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM provider_request_cache
        WHERE id = 'cache-old-worker'
      `).first<{ count: number }>())?.count).toBe(0);

      await db.prepare(`
        INSERT INTO provider_request_cache (
          id, job_id, artifact_run_id, provider, method, request_path,
          request_hash, request_key, owner_attempt_id
        ) VALUES (
          'cache-new-worker', 'job-rollout', 'job-rollout', 'gemini', 'POST',
          '/v1beta/models/gemini-3-pro-image:generateContent', 'hash-rollout',
          'source:side:image', 'attempt-new-worker'
        )
      `).run();
      expect(await db.prepare(`
        SELECT artifact_run_id, request_key FROM provider_request_cache
        WHERE id = 'cache-new-worker'
      `).first()).toMatchObject({
        artifact_run_id: 'job-rollout',
        request_key: 'source:side:image',
      });

      await db.prepare(`
        UPDATE generation_jobs
        SET status = 'failed', stage = 'failed',
            error_message = 'low_punch produced only 4 reliable frames',
            finished_at = datetime('now'), updated_at = datetime('now')
        WHERE id = 'job-rollout'
      `).run();
      expect(await db.prepare(`
        SELECT status, failure_stage FROM generation_artifact_runs
        WHERE id = 'job-rollout'
      `).first()).toMatchObject({
        status: 'partial',
        failure_stage: 'sprite:low_punch',
      });
    } finally {
      await mf.dispose();
    }
  }, integrationTestTimeoutMs);
});
