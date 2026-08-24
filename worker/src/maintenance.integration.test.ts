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
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE provider_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE generation_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
    charge_id TEXT NOT NULL REFERENCES generation_charges(id) ON DELETE RESTRICT,
    provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id) ON DELETE RESTRICT,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
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
  CREATE TABLE provider_request_cache (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
    response_blob_key TEXT,
    updated_at TEXT NOT NULL
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
          INSERT INTO generation_jobs (
            id, user_id, fighter_id, charge_id, provider_session_id,
            status, stage, finished_at, updated_at
          ) VALUES (
            'job-1', 'user-1', 'fighter-1', 'charge-1', 'session-1',
            'succeeded', 'complete', datetime('now', '-8 days'), datetime('now', '-8 days')
          )
        `),
        db.prepare(`
          INSERT INTO generation_job_events (id, job_id, stage, status, detail)
          VALUES ('event-1', 'job-1', 'complete', 'succeeded', 'done')
        `),
        db.prepare(`
          INSERT INTO provider_request_cache (id, job_id, response_blob_key, updated_at)
          VALUES ('cache-1', 'job-1', ?, datetime('now', '-8 days'))
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
});
