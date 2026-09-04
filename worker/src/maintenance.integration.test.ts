import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import { cleanupOperationalData } from './maintenance';
import type { Env } from './types';

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    credits_balance INTEGER NOT NULL DEFAULT 0,
    free_rookie_generations_used INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE credit_ledger (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    fighter_id TEXT,
    stripe_session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
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
    provider_calls_used INTEGER NOT NULL DEFAULT 0 CHECK (provider_calls_used >= 0),
    provider_cost_used_cents INTEGER NOT NULL DEFAULT 0 CHECK (provider_cost_used_cents >= 0),
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
  CREATE TABLE video_sprite_candidates (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES generation_artifact_runs(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL UNIQUE REFERENCES generation_jobs(id) ON DELETE CASCADE
  );
  CREATE TABLE video_sprite_candidate_revisions (
    candidate_id TEXT NOT NULL REFERENCES video_sprite_candidates(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    PRIMARY KEY(candidate_id, revision)
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
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES provider_sessions(id) ON DELETE SET NULL,
    charge_id TEXT REFERENCES generation_charges(id) ON DELETE SET NULL,
    estimated_cost_cents INTEGER NOT NULL CHECK (estimated_cost_cents >= 0),
    outcome TEXT NOT NULL DEFAULT 'reserved',
    http_status INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finalized_at TEXT,
    job_id TEXT,
    artifact_run_id TEXT,
    stage TEXT,
    upstream_outcome TEXT NOT NULL DEFAULT 'pending',
    stage_outcome TEXT NOT NULL DEFAULT 'pending',
    job_outcome TEXT NOT NULL DEFAULT 'in_progress'
  );
  CREATE TABLE provider_spend_months (
    period TEXT PRIMARY KEY,
    estimated_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (estimated_cost_cents >= 0),
    provider_calls INTEGER NOT NULL DEFAULT 0 CHECK (provider_calls >= 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE client_errors (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    clerk_user_id TEXT,
    route TEXT NOT NULL,
    message TEXT NOT NULL,
    stack TEXT,
    debug_tail TEXT,
    app_context TEXT,
    user_agent TEXT
  );

  CREATE TABLE rate_limits (expires_at TEXT NOT NULL);
  CREATE TABLE provider_spend_reservations (created_at_epoch INTEGER NOT NULL);
  CREATE TABLE provider_capacity_windows (retry_at_epoch INTEGER NOT NULL);
  CREATE TABLE provider_meterkey_capacity_windows (retry_at_epoch INTEGER NOT NULL);
  CREATE TABLE stripe_events (created_at TEXT NOT NULL);
  CREATE TABLE clerk_webhook_events (processed_at TEXT NOT NULL);
  CREATE TABLE checkout_sessions (status TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE legal_acceptances (created_at TEXT NOT NULL);
  CREATE TABLE community_reports (status TEXT NOT NULL, updated_at TEXT NOT NULL);
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
  CREATE TABLE versus_invitations (
    token_hash TEXT PRIMARY KEY,
    template_version TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
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

  it('retains terminal jobs that own archived video review revisions', async () => {
    const { mf, db, env } = await bindings();
    try {
      await db.batch([
        db.prepare("INSERT INTO users (id) VALUES ('user-1')"),
        db.prepare("INSERT INTO fighters (id, owner_user_id) VALUES ('fighter-1', 'user-1')"),
        db.prepare(`
          INSERT INTO generation_charges (id, user_id)
          VALUES ('charge-reviewed', 'user-1'), ('charge-expired', 'user-1')
        `),
        db.prepare(`
          INSERT INTO provider_sessions (id, user_id, expires_at)
          VALUES
            ('session-reviewed', 'user-1', datetime('now', '-8 days')),
            ('session-expired', 'user-1', datetime('now', '-8 days'))
        `),
        db.prepare(`
          INSERT INTO generation_artifact_runs (id, status, updated_at)
          VALUES
            ('run-reviewed', 'succeeded', datetime('now', '-8 days')),
            ('run-expired', 'succeeded', datetime('now', '-8 days'))
        `),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, user_id, fighter_id, charge_id, provider_session_id,
            artifact_run_id, status, stage, finished_at, updated_at
          ) VALUES
            (
              'job-reviewed', 'user-1', 'fighter-1', 'charge-reviewed', 'session-reviewed',
              'run-reviewed', 'succeeded', 'complete',
              datetime('now', '-8 days'), datetime('now', '-8 days')
            ),
            (
              'job-expired', 'user-1', 'fighter-1', 'charge-expired', 'session-expired',
              'run-expired', 'succeeded', 'complete',
              datetime('now', '-8 days'), datetime('now', '-8 days')
            )
        `),
        db.prepare(`
          INSERT INTO video_sprite_candidates (id, run_id, job_id)
          VALUES ('candidate-reviewed', 'run-reviewed', 'job-reviewed')
        `),
        db.prepare(`
          INSERT INTO video_sprite_candidate_revisions (candidate_id, revision)
          VALUES ('candidate-reviewed', 1), ('candidate-reviewed', 2)
        `),
      ]);

      await cleanupOperationalData(env);

      expect((await db.prepare('SELECT id FROM generation_jobs ORDER BY id').all()).results)
        .toEqual([{ id: 'job-reviewed' }]);
      expect((await db.prepare('SELECT id, job_id FROM video_sprite_candidates').all()).results)
        .toEqual([{ id: 'candidate-reviewed', job_id: 'job-reviewed' }]);
      expect((await db.prepare(`
        SELECT candidate_id, revision
        FROM video_sprite_candidate_revisions
        ORDER BY revision
      `).all()).results).toEqual([
        { candidate_id: 'candidate-reviewed', revision: 1 },
        { candidate_id: 'candidate-reviewed', revision: 2 },
      ]);
      expect((await db.prepare('SELECT id FROM provider_sessions ORDER BY id').all()).results)
        .toEqual([{ id: 'session-reviewed' }]);
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
          INSERT INTO provider_cost_events (
            id, session_id, charge_id, estimated_cost_cents, outcome, job_id, stage
          ) VALUES (
            'cost-1', 'session-1', 'charge-1', 8, 'succeeded', 'job-1', 'sprite:low_punch'
          )
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

  it('reconciles exact not-dispatched events and refunds late releases exactly once', async () => {
    const { mf, db, env } = await bindings();
    try {
      await db.batch([
        db.prepare("INSERT INTO users (id) VALUES ('user-1')"),
        db.prepare("INSERT INTO fighters (id, owner_user_id) VALUES ('fighter-1', 'user-1')"),
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES
            ('ledger-correlation', 'user-1', -7, 'generation_charge', 'fighter-1'),
            ('ledger-marker', 'user-1', -7, 'generation_charge', 'fighter-1'),
            ('ledger-outcome', 'user-1', -7, 'generation_charge', 'fighter-1')
        `),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, fighter_id, ledger_id, status
          ) VALUES
            ('charge-correlation', 'user-1', 'fighter-1', 'ledger-correlation', 'committed'),
            ('charge-marker', 'user-1', 'fighter-1', 'ledger-marker', 'committed'),
            ('charge-outcome', 'user-1', 'fighter-1', 'ledger-outcome', 'committed')
        `),
        db.prepare(`
          INSERT INTO provider_sessions (
            id, user_id, charge_id, provider_calls_used, provider_cost_used_cents, expires_at
          ) VALUES
            ('session-correlation', 'user-1', 'charge-correlation', 2, 16, datetime('now', '+1 day')),
            ('session-marker', 'user-1', 'charge-marker', 1, 8, datetime('now', '+1 day')),
            ('session-outcome', 'user-1', 'charge-outcome', 1, 8, datetime('now', '+1 day'))
        `),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, user_id, fighter_id, charge_id, provider_session_id,
            status, stage, finished_at, updated_at
          ) VALUES
            (
              'job-correlation', 'user-1', 'fighter-1', 'charge-correlation', 'session-correlation',
              'failed', 'sprite:high_kick', datetime('now'), datetime('now')
            ),
            (
              'job-marker', 'user-1', 'fighter-1', 'charge-marker', 'session-marker',
              'failed', 'sprite:high_kick', datetime('now'), datetime('now')
            ),
            (
              'job-outcome', 'user-1', 'fighter-1', 'charge-outcome', 'session-outcome',
              'failed', 'sprite:high_kick', datetime('now'), datetime('now')
            )
        `),
        db.prepare(`
          INSERT INTO generation_job_events (id, job_id, stage, status, detail)
          VALUES
            (
              'job-event-correlation', 'job-correlation', 'sprite:high_kick', 'failed',
              'Image provider request is not safe to retry (provider_request_not_dispatched): '
              || '(provider_request_not_dispatched:cost-correlation-b)'
            ),
            (
              'job-event-marker', 'job-marker', 'sprite:high_kick', 'failed',
              'Image provider request is not safe to retry (provider_request_not_dispatched): '
              || '(provider_request_not_dispatched:cost-marker)'
            )
        `),
        db.prepare(`
          INSERT INTO provider_cost_events (
            id, session_id, charge_id, estimated_cost_cents, outcome,
            http_status, job_id, stage, upstream_outcome
          ) VALUES
            (
              'cost-correlation-a', 'session-correlation', 'charge-correlation', 8, 'reserved',
              NULL, 'job-correlation', 'sprite:high_kick', 'pending'
            ),
            (
              'cost-correlation-b', 'session-correlation', 'charge-correlation', 8, 'reserved',
              NULL, 'job-correlation', 'sprite:high_kick', 'pending'
            ),
            (
              'cost-marker', 'session-marker', 'charge-marker', 8, 'reserved',
              NULL, 'job-marker', 'sprite:high_kick', 'pending'
            ),
            (
              'cost-outcome', 'session-outcome', 'charge-outcome', 8, 'reserved',
              429, 'job-outcome', 'sprite:high_kick', 'not_dispatched'
            )
        `),
        db.prepare(`
          INSERT INTO provider_spend_months (period, estimated_cost_cents, provider_calls)
          VALUES (strftime('%Y-%m', 'now'), 32, 4)
        `),
      ]);

      const accountingSnapshot = async () => ({
        charges: (await db.prepare(`
          SELECT id, status,
                 CASE WHEN refund_ledger_id IS NULL THEN 0 ELSE 1 END AS has_refund_ledger
          FROM generation_charges ORDER BY id
        `).all()).results,
        sessions: (await db.prepare(`
          SELECT id, provider_calls_used, provider_cost_used_cents
          FROM provider_sessions ORDER BY id
        `).all()).results,
        costs: (await db.prepare(`
          SELECT id, estimated_cost_cents, outcome, upstream_outcome
          FROM provider_cost_events ORDER BY id
        `).all()).results,
        month: await db.prepare(`
          SELECT estimated_cost_cents, provider_calls FROM provider_spend_months
        `).first(),
        user: await db.prepare(`
          SELECT credits_balance, free_rookie_generations_used FROM users WHERE id = 'user-1'
        `).first(),
        ledgers: await db.prepare(`
          SELECT COUNT(*) AS count,
                 SUM(CASE WHEN reason LIKE 'generation_reservation_release:%' THEN 1 ELSE 0 END)
                   AS release_count,
                 SUM(CASE
                   WHEN reason LIKE 'generation_reservation_release:%' AND fighter_id = 'fighter-1'
                   THEN 1 ELSE 0
                 END) AS fighter_release_count
          FROM credit_ledger
        `).first(),
      });

      await cleanupOperationalData(env);
      const afterFirstMaintenance = await accountingSnapshot();
      expect(afterFirstMaintenance).toEqual({
        charges: [
          { id: 'charge-correlation', status: 'committed', has_refund_ledger: 0 },
          { id: 'charge-marker', status: 'refunded', has_refund_ledger: 1 },
          { id: 'charge-outcome', status: 'refunded', has_refund_ledger: 1 },
        ],
        sessions: [
          { id: 'session-correlation', provider_calls_used: 1, provider_cost_used_cents: 8 },
          { id: 'session-marker', provider_calls_used: 0, provider_cost_used_cents: 0 },
          { id: 'session-outcome', provider_calls_used: 0, provider_cost_used_cents: 0 },
        ],
        costs: [
          {
            id: 'cost-correlation-a',
            estimated_cost_cents: 8,
            outcome: 'reserved',
            upstream_outcome: 'pending',
          },
          {
            id: 'cost-correlation-b',
            estimated_cost_cents: 0,
            outcome: 'failed',
            upstream_outcome: 'not_dispatched',
          },
          {
            id: 'cost-marker',
            estimated_cost_cents: 0,
            outcome: 'failed',
            upstream_outcome: 'not_dispatched',
          },
          {
            id: 'cost-outcome',
            estimated_cost_cents: 0,
            outcome: 'failed',
            upstream_outcome: 'not_dispatched',
          },
        ],
        month: { estimated_cost_cents: 8, provider_calls: 1 },
        user: { credits_balance: 14, free_rookie_generations_used: 0 },
        ledgers: { count: 5, release_count: 2, fighter_release_count: 2 },
      });

      await cleanupOperationalData(env);
      expect(await accountingSnapshot()).toEqual(afterFirstMaintenance);
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('closes only empty partial runs after a late not-dispatched refund', async () => {
    const { mf, db, env } = await bindings();
    try {
      await db.batch([
        db.prepare("INSERT INTO users (id) VALUES ('user-1')"),
        db.prepare("INSERT INTO fighters (id, owner_user_id) VALUES ('fighter-1', 'user-1')"),
        db.prepare(`
          INSERT INTO generation_charges (id, user_id, fighter_id, status)
          VALUES
            ('charge-empty', 'user-1', 'fighter-1', 'reserved'),
            ('charge-checkpoint', 'user-1', 'fighter-1', 'reserved'),
            ('charge-refunded-with-other', 'user-1', 'fighter-1', 'reserved'),
            ('charge-other-committed', 'user-1', 'fighter-1', 'committed')
        `),
        db.prepare(`
          INSERT INTO provider_sessions (id, user_id, charge_id, expires_at)
          VALUES
            ('session-empty', 'user-1', 'charge-empty', datetime('now', '+1 day')),
            ('session-checkpoint', 'user-1', 'charge-checkpoint', datetime('now', '+1 day')),
            (
              'session-refunded-with-other', 'user-1', 'charge-refunded-with-other',
              datetime('now', '+1 day')
            ),
            (
              'session-other-committed', 'user-1', 'charge-other-committed',
              datetime('now', '+1 day')
            )
        `),
        db.prepare(`
          INSERT INTO generation_artifact_runs (id, original_charge_id, status, updated_at)
          VALUES
            ('run-empty', 'charge-empty', 'partial', datetime('now')),
            ('run-checkpoint', 'charge-checkpoint', 'partial', datetime('now')),
            (
              'run-other-charge', 'charge-refunded-with-other', 'partial', datetime('now')
            )
        `),
        db.prepare(`
          INSERT INTO generation_artifact_checkpoints (run_id, status)
          VALUES ('run-checkpoint', 'approved')
        `),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, user_id, fighter_id, charge_id, provider_session_id,
            artifact_run_id, status, stage, finished_at, updated_at
          ) VALUES
            (
              'job-empty', 'user-1', 'fighter-1', 'charge-empty', 'session-empty',
              'run-empty', 'failed', 'source:side', datetime('now'), datetime('now')
            ),
            (
              'job-checkpoint', 'user-1', 'fighter-1', 'charge-checkpoint', 'session-checkpoint',
              'run-checkpoint', 'failed', 'sprite:idle', datetime('now'), datetime('now')
            ),
            (
              'job-refunded-with-other', 'user-1', 'fighter-1',
              'charge-refunded-with-other', 'session-refunded-with-other',
              'run-other-charge', 'failed', 'source:side', datetime('now'), datetime('now')
            ),
            (
              'job-other-committed', 'user-1', 'fighter-1', 'charge-other-committed',
              'session-other-committed', 'run-other-charge', 'failed', 'sprite:idle',
              datetime('now'), datetime('now')
            )
        `),
        db.prepare(`
          INSERT INTO provider_cost_events (
            id, session_id, charge_id, estimated_cost_cents, outcome,
            job_id, artifact_run_id, stage, upstream_outcome
          ) VALUES
            (
              'cost-empty', 'session-empty', 'charge-empty', 0, 'failed',
              'job-empty', 'run-empty', 'source:side', 'not_dispatched'
            ),
            (
              'cost-checkpoint', 'session-checkpoint', 'charge-checkpoint', 0, 'failed',
              'job-checkpoint', 'run-checkpoint', 'sprite:idle', 'not_dispatched'
            ),
            (
              'cost-refunded-with-other', 'session-refunded-with-other',
              'charge-refunded-with-other', 0, 'failed', 'job-refunded-with-other',
              'run-other-charge', 'source:side', 'not_dispatched'
            )
        `),
      ]);

      await cleanupOperationalData(env);
      expect((await db.prepare(`
        SELECT id, status FROM generation_artifact_runs ORDER BY id
      `).all()).results).toEqual([
        { id: 'run-checkpoint', status: 'partial' },
        { id: 'run-empty', status: 'failed' },
        { id: 'run-other-charge', status: 'partial' },
      ]);
      expect((await db.prepare(`
        SELECT id, status FROM generation_charges
        WHERE id <> 'charge-other-committed' ORDER BY id
      `).all()).results).toEqual([
        { id: 'charge-checkpoint', status: 'refunded' },
        { id: 'charge-empty', status: 'refunded' },
        { id: 'charge-refunded-with-other', status: 'refunded' },
      ]);
      expect((await db.prepare(`
        SELECT credits_balance FROM users WHERE id = 'user-1'
      `).first<{ credits_balance: number }>())?.credits_balance).toBe(21);

      await cleanupOperationalData(env);
      expect((await db.prepare(`
        SELECT id, status FROM generation_artifact_runs ORDER BY id
      `).all()).results).toEqual([
        { id: 'run-checkpoint', status: 'partial' },
        { id: 'run-empty', status: 'failed' },
        { id: 'run-other-charge', status: 'partial' },
      ]);
      expect((await db.prepare(`
        SELECT credits_balance FROM users WHERE id = 'user-1'
      `).first<{ credits_balance: number }>())?.credits_balance).toBe(21);
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
