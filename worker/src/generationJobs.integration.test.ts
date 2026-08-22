import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import { createGenerationJob } from './generationJobs';
import type { AuthContext, Env } from './types';

const USER_ID = 'user-generation-job';
const FIGHTER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PURCHASE_ID = '11111111111111111111111111111111';
const SESSION_ID = '22222222222222222222222222222222';
const SECOND_PURCHASE_ID = '33333333333333333333333333333333';
const SECOND_SESSION_ID = '44444444444444444444444444444444';
const ORIGINAL_KEY = `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/original.png`;
const SOURCE_KEYS = {
  side: `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/side.png`,
  sideRaw: `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/side_raw.png`,
  upright: `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/upright.png`,
  uprightRaw: `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/upright_raw.png`,
  crouch: `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/crouch.png`,
  crouchRaw: `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/crouch_raw.png`,
} as const;

const SCHEMA = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    credits_balance INTEGER NOT NULL DEFAULT 0,
    free_rookie_generations_used INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE fighters (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    original_blob_key TEXT,
    side_view_blob_key TEXT,
    side_view_raw_blob_key TEXT,
    upright_view_blob_key TEXT,
    upright_view_raw_blob_key TEXT,
    crouch_view_blob_key TEXT,
    crouch_view_raw_blob_key TEXT
  );
  CREATE TABLE credit_ledger (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    fighter_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE generation_charges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    credit_cost INTEGER NOT NULL DEFAULT 0,
    free_quota_delta INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    fighter_id TEXT,
    ledger_id TEXT,
    refund_ledger_id TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE provider_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    rate_limit_key TEXT NOT NULL,
    tier TEXT NOT NULL,
    purpose TEXT NOT NULL,
    charge_id TEXT,
    status TEXT NOT NULL,
    provider_calls_used INTEGER NOT NULL DEFAULT 0,
    provider_call_limit INTEGER NOT NULL DEFAULT 48,
    provider_cost_used_cents INTEGER NOT NULL DEFAULT 0,
    provider_cost_limit_cents INTEGER NOT NULL DEFAULT 300,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE generation_jobs (
    id TEXT PRIMARY KEY,
    workflow_instance_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    fighter_id TEXT NOT NULL,
    charge_id TEXT NOT NULL UNIQUE,
    provider_session_id TEXT NOT NULL UNIQUE,
    tier TEXT NOT NULL,
    operation TEXT NOT NULL,
    target_kind TEXT,
    target_name TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    stage TEXT NOT NULL DEFAULT 'queued',
    progress_current INTEGER NOT NULL DEFAULT 0,
    progress_total INTEGER NOT NULL DEFAULT 14,
    error_code TEXT,
    error_message TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_generation_jobs_active_fighter
    ON generation_jobs(fighter_id)
    WHERE status IN ('queued', 'running');
  CREATE TABLE generation_job_events (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function png(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
}

function request(
  purchaseId = PURCHASE_ID,
  providerSessionId = SESSION_ID,
  target?: { targetKind: 'animation' | 'source'; targetName: string },
): Request {
  return new Request('https://api.insertplayer.ai/api/generation-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fighterId: FIGHTER_ID, purchaseId, providerSessionId, ...target }),
  });
}

async function bindings(): Promise<{
  mf: Miniflare;
  db: D1Database;
  env: Env;
  workflowStarts: string[];
}> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: 'generation-job-test',
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
          DB: { type: 'd1', id: 'generation-job-db' },
          SPRITES: { type: 'r2', name: 'generation-job-assets' },
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
    db.prepare('INSERT INTO users (id, credits_balance) VALUES (?, 7)').bind(USER_ID),
    db.prepare(`
      INSERT INTO fighters (id, owner_user_id, original_blob_key)
      VALUES (?, ?, ?)
    `).bind(FIGHTER_ID, USER_ID, ORIGINAL_KEY),
    db.prepare(`
      INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
      VALUES ('ledger-first', ?, -3, 'fighter_generation', ?)
    `).bind(USER_ID, FIGHTER_ID),
    db.prepare(`
      INSERT INTO generation_charges (
        id, user_id, tier, credit_cost, status, reason, fighter_id, ledger_id, expires_at
      ) VALUES (?, ?, 'rookie', 3, 'reserved', 'fighter_generation', ?, 'ledger-first', datetime('now', '+12 hours'))
    `).bind(PURCHASE_ID, USER_ID, FIGHTER_ID),
    db.prepare(`
      INSERT INTO provider_sessions (
        id, user_id, rate_limit_key, tier, purpose, charge_id, status, expires_at
      ) VALUES (?, ?, ?, 'rookie', 'fighter_generation', ?, 'active', datetime('now', '+12 hours'))
    `).bind(SESSION_ID, USER_ID, `user:${USER_ID}`, PURCHASE_ID),
  ]);
  await bucket.put(ORIGINAL_KEY, png(), { httpMetadata: { contentType: 'image/png' } });

  const workflowStarts: string[] = [];
  const workflow = {
    async create(options: { id: string }) {
      if (workflowStarts.includes(options.id)) throw new Error('Workflow instance already exists');
      workflowStarts.push(options.id);
      return { id: options.id };
    },
    async get(id: string) {
      return { async status() { return { status: workflowStarts.includes(id) ? 'running' : 'unknown' }; } };
    },
  };
  return {
    mf,
    db,
    workflowStarts,
    env: {
      DB: db,
      SPRITES: bucket,
      ENVIRONMENT: 'development',
      CORS_ORIGIN: 'https://insertplayer.ai',
      FIGHTER_GENERATION: workflow as unknown as NonNullable<Env['FIGHTER_GENERATION']>,
      IMAGE_PROCESSOR: {} as NonNullable<Env['IMAGE_PROCESSOR']>,
      GENERATION_JOB_SIGNING_SECRET: 'test-generation-job-signing-secret-with-enough-entropy',
    } as Env,
  };
}

const auth = { userId: USER_ID } as AuthContext;

async function seedAnimationRetry(db: D1Database, env: Env): Promise<void> {
  await db.batch([
    db.prepare(`
      UPDATE fighters
      SET side_view_blob_key = ?, side_view_raw_blob_key = ?,
          upright_view_blob_key = ?, upright_view_raw_blob_key = ?,
          crouch_view_blob_key = ?, crouch_view_raw_blob_key = ?
      WHERE id = ?
    `).bind(
      SOURCE_KEYS.side,
      SOURCE_KEYS.sideRaw,
      SOURCE_KEYS.upright,
      SOURCE_KEYS.uprightRaw,
      SOURCE_KEYS.crouch,
      SOURCE_KEYS.crouchRaw,
      FIGHTER_ID,
    ),
    db.prepare(`
      INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
      VALUES ('ledger-retry', ?, -1, 'fighter_retry_animation', ?)
    `).bind(USER_ID, FIGHTER_ID),
    db.prepare(`
      INSERT INTO generation_charges (
        id, user_id, tier, credit_cost, status, reason, fighter_id, ledger_id, expires_at
      ) VALUES (?, ?, 'rookie', 1, 'reserved', 'fighter_retry_animation', ?, 'ledger-retry', datetime('now', '+12 hours'))
    `).bind(SECOND_PURCHASE_ID, USER_ID, FIGHTER_ID),
    db.prepare(`
      INSERT INTO provider_sessions (
        id, user_id, rate_limit_key, tier, purpose, charge_id, status, expires_at
      ) VALUES (?, ?, ?, 'rookie', 'fighter_retry', ?, 'active', datetime('now', '+12 hours'))
    `).bind(SECOND_SESSION_ID, USER_ID, `user:${USER_ID}`, SECOND_PURCHASE_ID),
  ]);
  await Promise.all(Object.values(SOURCE_KEYS).map((key) => (
    env.SPRITES.put(key, png(), { httpMetadata: { contentType: 'image/png' } })
  )));
}

describe('durable generation job creation', () => {
  it('starts one idempotent workflow and extends its backend-owned reservation', async () => {
    const { mf, db, env, workflowStarts } = await bindings();
    try {
      const created = await createGenerationJob(request(), env, auth);
      expect(created.status).toBe(202);
      const body = await created.json() as { job: { id: string; status: string; fighterId: string } };
      expect(body.job).toMatchObject({ id: PURCHASE_ID, status: 'queued', fighterId: FIGHTER_ID });
      expect(workflowStarts).toEqual([PURCHASE_ID]);

      const replay = await createGenerationJob(request(), env, auth);
      expect(replay.status).toBe(200);
      expect(workflowStarts).toEqual([PURCHASE_ID]);

      const charge = await db.prepare(`
        SELECT fighter_id, expires_at FROM generation_charges WHERE id = ?
      `).bind(PURCHASE_ID).first<{ fighter_id: string; expires_at: string }>();
      expect(charge?.fighter_id).toBe(FIGHTER_ID);
      expect(Date.parse(charge?.expires_at ?? '')).toBeGreaterThan(Date.now() + 47 * 60 * 60 * 1_000);
      expect((await db.prepare('SELECT COUNT(*) AS count FROM generation_jobs')
        .first<{ count: number }>())?.count).toBe(1);
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('keeps one reserved purchase when identical job requests race', async () => {
    const { mf, db, env, workflowStarts } = await bindings();
    try {
      const responses = await Promise.all([
        createGenerationJob(request(), env, auth),
        createGenerationJob(request(), env, auth),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 202]);
      expect(workflowStarts).toEqual([PURCHASE_ID]);
      expect((await db.prepare('SELECT status FROM generation_charges WHERE id = ?')
        .bind(PURCHASE_ID).first<{ status: string }>())?.status).toBe('reserved');
      expect((await db.prepare('SELECT status FROM provider_sessions WHERE id = ?')
        .bind(SESSION_ID).first<{ status: string }>())?.status).toBe('active');
      expect((await db.prepare('SELECT credits_balance FROM users WHERE id = ?')
        .bind(USER_ID).first<{ credits_balance: number }>())?.credits_balance).toBe(7);
      expect((await db.prepare('SELECT COUNT(*) AS count FROM generation_jobs')
        .first<{ count: number }>())?.count).toBe(1);
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('releases a second unused reservation and returns the already-running fighter job', async () => {
    const { mf, db, env } = await bindings();
    try {
      expect((await createGenerationJob(request(), env, auth)).status).toBe(202);
      await db.batch([
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES ('ledger-second', ?, -3, 'fighter_generation', ?)
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, credit_cost, status, reason, fighter_id, ledger_id, expires_at
          ) VALUES (?, ?, 'rookie', 3, 'reserved', 'fighter_generation', ?, 'ledger-second', datetime('now', '+12 hours'))
        `).bind(SECOND_PURCHASE_ID, USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO provider_sessions (
            id, user_id, rate_limit_key, tier, purpose, charge_id, status, expires_at
          ) VALUES (?, ?, ?, 'rookie', 'fighter_generation', ?, 'active', datetime('now', '+12 hours'))
        `).bind(SECOND_SESSION_ID, USER_ID, `user:${USER_ID}`, SECOND_PURCHASE_ID),
      ]);

      const response = await createGenerationJob(
        request(SECOND_PURCHASE_ID, SECOND_SESSION_ID),
        env,
        auth,
      );
      expect(response.status).toBe(409);
      const body = await response.json() as { job: { id: string }; error: string };
      expect(body.job.id).toBe(PURCHASE_ID);
      expect(body.error).toContain('already running');
      expect((await db.prepare('SELECT status FROM generation_charges WHERE id = ?')
        .bind(SECOND_PURCHASE_ID).first<{ status: string }>())?.status).toBe('refunded');
      expect((await db.prepare('SELECT status FROM provider_sessions WHERE id = ?')
        .bind(SECOND_SESSION_ID).first<{ status: string }>())?.status).toBe('cancelled');
      expect((await db.prepare('SELECT credits_balance FROM users WHERE id = ?')
        .bind(USER_ID).first<{ credits_balance: number }>())?.credits_balance).toBe(10);
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('releases the reservation when required private input is unavailable', async () => {
    const { mf, db, env } = await bindings();
    try {
      await env.SPRITES.delete(ORIGINAL_KEY);
      const response = await createGenerationJob(request(), env, auth);
      expect(response.status).toBe(409);
      expect((await response.json() as { error: string }).error).toContain('unused reservation was released');
      expect((await db.prepare('SELECT status FROM generation_charges WHERE id = ?')
        .bind(PURCHASE_ID).first<{ status: string }>())?.status).toBe('refunded');
      expect((await db.prepare('SELECT status FROM provider_sessions WHERE id = ?')
        .bind(SESSION_ID).first<{ status: string }>())?.status).toBe('cancelled');
      expect((await db.prepare('SELECT credits_balance FROM users WHERE id = ?')
        .bind(USER_ID).first<{ credits_balance: number }>())?.credits_balance).toBe(10);
      expect((await db.prepare('SELECT COUNT(*) AS count FROM generation_jobs')
        .first<{ count: number }>())?.count).toBe(0);
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('releases the reservation when a deployed environment lacks job signing', async () => {
    const { mf, db, env } = await bindings();
    try {
      env.ENVIRONMENT = 'sandbox';
      env.GENERATION_JOB_SIGNING_SECRET = undefined;
      const response = await createGenerationJob(request(), env, auth);
      expect(response.status).toBe(503);
      expect((await response.json() as { error: string }).error).toContain('unused reservation was released');
      expect((await db.prepare('SELECT status FROM generation_charges WHERE id = ?')
        .bind(PURCHASE_ID).first<{ status: string }>())?.status).toBe('refunded');
      expect((await db.prepare('SELECT status FROM provider_sessions WHERE id = ?')
        .bind(SESSION_ID).first<{ status: string }>())?.status).toBe('cancelled');
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('starts an idempotent one-target animation retry in the durable workflow', async () => {
    const { mf, db, env, workflowStarts } = await bindings();
    try {
      await seedAnimationRetry(db, env);
      const retryRequest = request(SECOND_PURCHASE_ID, SECOND_SESSION_ID, {
        targetKind: 'animation',
        targetName: 'victory',
      });
      const created = await createGenerationJob(retryRequest, env, auth);
      expect(created.status).toBe(202);
      expect(await created.json()).toMatchObject({
        job: {
          id: SECOND_PURCHASE_ID,
          operation: 'fighter_retry_animation',
          targetKind: 'animation',
          targetName: 'victory',
          progressTotal: 1,
        },
      });
      expect(workflowStarts).toEqual([SECOND_PURCHASE_ID]);

      const stored = await db.prepare(`
        SELECT operation, target_kind, target_name, progress_total
        FROM generation_jobs WHERE id = ?
      `).bind(SECOND_PURCHASE_ID).first<{
        operation: string;
        target_kind: string;
        target_name: string;
        progress_total: number;
      }>();
      expect(stored).toEqual({
        operation: 'fighter_retry_animation',
        target_kind: 'animation',
        target_name: 'victory',
        progress_total: 1,
      });
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('starts a one-target canonical source retry with the source scope', async () => {
    const { mf, db, env, workflowStarts } = await bindings();
    try {
      await seedAnimationRetry(db, env);
      await db.prepare(`
        UPDATE generation_charges SET reason = 'fighter_retry_source' WHERE id = ?
      `).bind(SECOND_PURCHASE_ID).run();

      const created = await createGenerationJob(request(SECOND_PURCHASE_ID, SECOND_SESSION_ID, {
        targetKind: 'source',
        targetName: 'upright',
      }), env, auth);
      expect(created.status).toBe(202);
      expect(await created.json()).toMatchObject({
        job: {
          id: SECOND_PURCHASE_ID,
          operation: 'fighter_retry_source',
          targetKind: 'source',
          targetName: 'upright',
          progressTotal: 1,
        },
      });
      expect(workflowStarts).toEqual([SECOND_PURCHASE_ID]);
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('releases a retry reservation when its target is outside the scoped animation set', async () => {
    const { mf, db, env } = await bindings();
    try {
      await seedAnimationRetry(db, env);
      const response = await createGenerationJob(request(SECOND_PURCHASE_ID, SECOND_SESSION_ID, {
        targetKind: 'animation',
        targetName: 'taunt',
      }), env, auth);
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toContain('unused reservation was released');
      expect((await db.prepare('SELECT status FROM generation_charges WHERE id = ?')
        .bind(SECOND_PURCHASE_ID).first<{ status: string }>())?.status).toBe('refunded');
      expect((await db.prepare('SELECT status FROM provider_sessions WHERE id = ?')
        .bind(SECOND_SESSION_ID).first<{ status: string }>())?.status).toBe('cancelled');
    } finally {
      await mf.dispose();
    }
  }, 15_000);
});
