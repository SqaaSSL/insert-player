import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import { cleanupOperationalData } from './maintenance';
import type { Env } from './types';

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE users (id TEXT PRIMARY KEY);
  CREATE TABLE fighters (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE generation_charges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tier TEXT NOT NULL DEFAULT 'champion',
    credit_cost INTEGER NOT NULL DEFAULT 7,
    free_quota_delta INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'committed',
    reason TEXT NOT NULL DEFAULT 'fighter_generation',
    fighter_id TEXT,
    ledger_id TEXT,
    refund_ledger_id TEXT,
    continuation_run_id TEXT,
    resumed_from_job_id TEXT,
    expires_at TEXT NOT NULL DEFAULT (datetime('now', '+1 day')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE provider_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    charge_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE generation_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
    charge_id TEXT NOT NULL REFERENCES generation_charges(id) ON DELETE RESTRICT,
    provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id) ON DELETE RESTRICT,
    artifact_run_id TEXT,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    failure_stage TEXT,
    error_code TEXT,
    error_message TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE generation_job_events (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT
  );
  CREATE TABLE generation_artifact_runs (
    id TEXT PRIMARY KEY,
    original_charge_id TEXT,
    status TEXT NOT NULL,
    failure_stage TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE generation_artifact_checkpoints (
    run_id TEXT NOT NULL REFERENCES generation_artifact_runs(id) ON DELETE CASCADE,
    status TEXT NOT NULL
  );
  CREATE TABLE provider_request_cache (
    id TEXT PRIMARY KEY,
    job_id TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL,
    artifact_run_id TEXT NOT NULL REFERENCES generation_artifact_runs(id) ON DELETE CASCADE,
    response_blob_key TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE provider_cost_events (
    job_id TEXT,
    stage TEXT,
    stage_outcome TEXT NOT NULL DEFAULT 'pending',
    job_outcome TEXT NOT NULL DEFAULT 'in_progress'
  );
  CREATE TABLE rate_limits (expires_at TEXT NOT NULL);
  CREATE TABLE provider_spend_reservations (created_at_epoch INTEGER NOT NULL);
  CREATE TABLE provider_capacity_windows (retry_at_epoch INTEGER NOT NULL);
  CREATE TABLE stripe_events (created_at TEXT NOT NULL);
  CREATE TABLE clerk_webhook_events (processed_at TEXT NOT NULL);
  CREATE TABLE checkout_sessions (status TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE legal_acceptances (created_at TEXT NOT NULL);
  CREATE TABLE community_reports (status TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

async function bindings(): Promise<{ mf: Miniflare; db: D1Database; bucket: R2Bucket; env: Env }> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: 'maintenance-test',
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
          DB: { type: 'd1', id: 'maintenance-db' },
          SPRITES: { type: 'r2', name: 'maintenance-assets' },
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
  return { mf, db, bucket, env: { DB: db, SPRITES: bucket } as Env };
}

describe('operational generation retention against D1 and R2', () => {
  it('removes terminal replay data before the referenced provider session', async () => {
    const { mf, db, bucket, env } = await bindings();
    const responseKey = 'users/user-1/jobs/job-1/provider-responses/response-1.bin';
    try {
      await db.batch([
        db.prepare("INSERT INTO users (id) VALUES ('user-1')"),
        db.prepare("INSERT INTO fighters (id, owner_user_id) VALUES ('fighter-1', 'user-1')"),
        db.prepare("INSERT INTO generation_charges (id, user_id) VALUES ('charge-1', 'user-1')"),
        db.prepare(`
          INSERT INTO provider_sessions (id, user_id, expires_at)
          VALUES ('session-1', 'user-1', datetime('now', '-8 days'))
        `),
        db.prepare(`
          INSERT INTO generation_artifact_runs (id, status, updated_at)
          VALUES ('run-1', 'succeeded', datetime('now', '-8 days'))
        `),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, user_id, fighter_id, charge_id, provider_session_id,
            artifact_run_id, status, stage, finished_at, updated_at
          ) VALUES (
            'job-1', 'user-1', 'fighter-1', 'charge-1', 'session-1',
            'run-1', 'succeeded', 'complete', datetime('now', '-8 days'), datetime('now', '-8 days')
          )
        `),
        db.prepare(`
          INSERT INTO generation_job_events (id, job_id, stage, status, detail)
          VALUES ('event-1', 'job-1', 'complete', 'succeeded', 'done')
        `),
        db.prepare(`
          INSERT INTO provider_request_cache (id, job_id, artifact_run_id, response_blob_key, updated_at)
          VALUES ('cache-1', 'job-1', 'run-1', ?, datetime('now', '-8 days'))
        `).bind(responseKey),
      ]);
      await bucket.put(responseKey, new Uint8Array([1, 2, 3]));

      await cleanupOperationalData(env);

      expect(await bucket.head(responseKey)).toBeNull();
      expect((await db.prepare('SELECT COUNT(*) AS count FROM provider_request_cache')
        .first<{ count: number }>())?.count).toBe(0);
      expect((await db.prepare('SELECT COUNT(*) AS count FROM generation_jobs')
        .first<{ count: number }>())?.count).toBe(0);
      expect((await db.prepare('SELECT COUNT(*) AS count FROM generation_job_events')
        .first<{ count: number }>())?.count).toBe(0);
      expect((await db.prepare('SELECT COUNT(*) AS count FROM provider_sessions')
        .first<{ count: number }>())?.count).toBe(0);
      expect((await db.prepare('SELECT COUNT(*) AS count FROM fighters')
        .first<{ count: number }>())?.count).toBe(1);
      expect((await db.prepare('SELECT COUNT(*) AS count FROM generation_charges')
        .first<{ count: number }>())?.count).toBe(1);
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('retains replay data and immutable checkpoints for a partial resumable run', async () => {
    const { mf, db, bucket, env } = await bindings();
    const responseKey = 'users/user-1/generation-runs/run-partial/provider-responses/response.bin';
    try {
      await db.batch([
        db.prepare("INSERT INTO users (id) VALUES ('user-1')"),
        db.prepare("INSERT INTO fighters (id, owner_user_id) VALUES ('fighter-1', 'user-1')"),
        db.prepare("INSERT INTO generation_charges (id, user_id) VALUES ('charge-1', 'user-1')"),
        db.prepare(`
          INSERT INTO provider_sessions (id, user_id, expires_at)
          VALUES ('session-1', 'user-1', datetime('now', '-8 days'))
        `),
        db.prepare(`
          INSERT INTO generation_artifact_runs (id, status, updated_at)
          VALUES ('run-partial', 'partial', datetime('now', '-8 days'))
        `),
        db.prepare(`
          INSERT INTO generation_artifact_checkpoints (run_id, status)
          VALUES ('run-partial', 'approved')
        `),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, user_id, fighter_id, charge_id, provider_session_id,
            artifact_run_id, status, stage, finished_at, updated_at
          ) VALUES (
            'job-1', 'user-1', 'fighter-1', 'charge-1', 'session-1',
            'run-partial', 'failed', 'sprite:low_punch',
            datetime('now', '-8 days'), datetime('now', '-8 days')
          )
        `),
        db.prepare(`
          INSERT INTO provider_request_cache (
            id, job_id, artifact_run_id, response_blob_key, updated_at
          ) VALUES ('cache-1', 'job-1', 'run-partial', ?, datetime('now', '-8 days'))
        `).bind(responseKey),
      ]);
      await bucket.put(responseKey, new Uint8Array([1, 2, 3]));

      await cleanupOperationalData(env);

      expect(await bucket.head(responseKey)).not.toBeNull();
      expect((await db.prepare('SELECT COUNT(*) AS count FROM provider_request_cache')
        .first<{ count: number }>())?.count).toBe(1);
      expect((await db.prepare('SELECT job_id FROM provider_request_cache')
        .first<{ job_id: string | null }>())?.job_id).toBe('job-1');
      expect((await db.prepare('SELECT COUNT(*) AS count FROM generation_jobs')
        .first<{ count: number }>())?.count).toBe(1);
      expect((await db.prepare('SELECT COUNT(*) AS count FROM generation_artifact_runs')
        .first<{ count: number }>())?.count).toBe(1);
      expect((await db.prepare('SELECT COUNT(*) AS count FROM generation_artifact_checkpoints')
        .first<{ count: number }>())?.count).toBe(1);
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('preserves the actual stalled stage and marks paid partial telemetry', async () => {
    const { mf, db, env } = await bindings();
    try {
      await db.batch([
        db.prepare("INSERT INTO users (id) VALUES ('user-1')"),
        db.prepare("INSERT INTO fighters (id, owner_user_id) VALUES ('fighter-1', 'user-1')"),
        db.prepare(`
          INSERT INTO generation_charges (id, user_id, fighter_id)
          VALUES ('charge-1', 'user-1', 'fighter-1')
        `),
        db.prepare(`
          INSERT INTO provider_sessions (id, user_id, charge_id, expires_at)
          VALUES ('session-1', 'user-1', 'charge-1', datetime('now', '+1 day'))
        `),
        db.prepare(`
          INSERT INTO generation_artifact_runs (id, status, updated_at)
          VALUES ('run-1', 'active', datetime('now', '-5 days'))
        `),
        db.prepare(`
          INSERT INTO generation_artifact_checkpoints (run_id, status)
          VALUES ('run-1', 'approved')
        `),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, user_id, fighter_id, charge_id, provider_session_id,
            artifact_run_id, status, stage, updated_at
          ) VALUES (
            'job-1', 'user-1', 'fighter-1', 'charge-1', 'session-1',
            'run-1', 'running', 'sprite:low_punch', datetime('now', '-5 days')
          )
        `),
        db.prepare(`
          INSERT INTO provider_cost_events (job_id, stage)
          VALUES ('job-1', 'sprite:low_punch')
        `),
      ]);

      await cleanupOperationalData(env);

      expect(await db.prepare(`
        SELECT status, stage, failure_stage, error_code FROM generation_jobs WHERE id = 'job-1'
      `).first()).toEqual({
        status: 'failed',
        stage: 'sprite:low_punch',
        failure_stage: 'sprite:low_punch',
        error_code: 'job_stalled',
      });
      expect(await db.prepare(`
        SELECT status, failure_stage FROM generation_artifact_runs WHERE id = 'run-1'
      `).first()).toEqual({ status: 'partial', failure_stage: 'sprite:low_punch' });
      expect(await db.prepare(`
        SELECT stage_outcome, job_outcome FROM provider_cost_events WHERE job_id = 'job-1'
      `).first()).toEqual({ stage_outcome: 'failed', job_outcome: 'failed_partial' });
      expect((await db.prepare("SELECT status FROM provider_sessions WHERE id = 'session-1'")
        .first<{ status: string }>())?.status).toBe('cancelled');
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('retains provider replay data for a paid run that failed closed', async () => {
    const { mf, db, bucket, env } = await bindings();
    const responseKey = 'users/user-1/generation-runs/run-failed-paid/provider-responses/response.bin';
    try {
      await db.batch([
        db.prepare("INSERT INTO users (id) VALUES ('user-1')"),
        db.prepare("INSERT INTO fighters (id, owner_user_id) VALUES ('fighter-1', 'user-1')"),
        db.prepare(`
          INSERT INTO generation_charges (id, user_id, fighter_id)
          VALUES ('charge-1', 'user-1', 'fighter-1')
        `),
        db.prepare(`
          INSERT INTO provider_sessions (id, user_id, charge_id, expires_at)
          VALUES ('session-1', 'user-1', 'charge-1', datetime('now', '-8 days'))
        `),
        db.prepare(`
          INSERT INTO generation_artifact_runs (
            id, original_charge_id, status, updated_at
          ) VALUES (
            'run-failed-paid', 'charge-1', 'failed', datetime('now', '-8 days')
          )
        `),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, user_id, fighter_id, charge_id, provider_session_id,
            artifact_run_id, status, stage, finished_at, updated_at
          ) VALUES (
            'job-1', 'user-1', 'fighter-1', 'charge-1', 'session-1',
            'run-failed-paid', 'failed', 'source:side',
            datetime('now', '-8 days'), datetime('now', '-8 days')
          )
        `),
        db.prepare(`
          INSERT INTO provider_request_cache (
            id, job_id, artifact_run_id, response_blob_key, updated_at
          ) VALUES (
            'cache-1', 'job-1', 'run-failed-paid', ?, datetime('now', '-8 days')
          )
        `).bind(responseKey),
      ]);
      await bucket.put(responseKey, new Uint8Array([1, 2, 3]));

      await cleanupOperationalData(env);

      expect(await bucket.head(responseKey)).not.toBeNull();
      expect((await db.prepare('SELECT COUNT(*) AS count FROM provider_request_cache')
        .first<{ count: number }>())?.count).toBe(1);
      expect((await db.prepare('SELECT job_id FROM provider_request_cache')
        .first<{ job_id: string | null }>())?.job_id).toBeNull();
      expect((await db.prepare('SELECT COUNT(*) AS count FROM generation_jobs')
        .first<{ count: number }>())?.count).toBe(0);
    } finally {
      await mf.dispose();
    }
  }, 15_000);
});
