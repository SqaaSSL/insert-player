import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import { upsertClerkUser, upsertClerkUserProfile } from './auth';
import type { Env, User } from './types';

const SCHEMA = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    clerk_user_id TEXT,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    email TEXT,
    oauth_provider TEXT NOT NULL,
    oauth_id TEXT NOT NULL,
    plan_tier TEXT NOT NULL DEFAULT 'free',
    credits_balance INTEGER NOT NULL DEFAULT 0,
    free_rookie_generations_used INTEGER NOT NULL DEFAULT 0,
    stripe_customer_id TEXT,
    elo_rating INTEGER NOT NULL DEFAULT 1200,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    win_streak INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    total_kos INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE clerk_user_tombstones (
    subject_hash TEXT PRIMARY KEY,
    webhook_event_id TEXT NOT NULL,
    deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

async function createDatabase(): Promise<{ mf: Miniflare; db: D1Database; env: Env }> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: 'auth-profile-test',
        compatibilityDate: '2026-08-17',
        manifest: {
          mainModule: 'index.js',
          modules: {
            'index.js': {
              type: 'esm',
              contents: 'export default { fetch() { return new Response("ok"); } };',
            },
          },
        },
        env: { DB: { type: 'd1', id: 'auth-test-db' } },
      },
    }],
  });
  const db = await mf.getD1Database('DB');
  await db.batch(SCHEMA
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => db.prepare(statement)));
  return { mf, db, env: { DB: db } as Env };
}

describe('Clerk profile persistence', () => {
  it('keeps authoritative webhook fields when a later session token is sparse', async () => {
    const { mf, db, env } = await createDatabase();
    try {
      await upsertClerkUserProfile(env, 'user_profile_test', {
        displayName: 'QA Player',
        avatarUrl: 'https://img.clerk.com/qa.png',
        email: 'qa+clerk_test@insertplayer.ai',
      });

      await upsertClerkUser(env, 'user_profile_test', {});

      const user = await db.prepare(
        'SELECT * FROM users WHERE id = ?'
      ).bind('user_profile_test').first<User>();
      expect(user).toMatchObject({
        display_name: 'QA Player',
        avatar_url: 'https://img.clerk.com/qa.png',
        email: 'qa+clerk_test@insertplayer.ai',
      });
    } finally {
      await mf.dispose();
    }
  });

  it('still lets an authoritative webhook update clear removed optional fields', async () => {
    const { mf, db, env } = await createDatabase();
    try {
      await upsertClerkUserProfile(env, 'user_profile_test', {
        displayName: 'QA Player',
        avatarUrl: 'https://img.clerk.com/qa.png',
        email: 'qa+clerk_test@insertplayer.ai',
      });
      await upsertClerkUserProfile(env, 'user_profile_test', {
        displayName: 'Renamed Player',
        avatarUrl: null,
        email: null,
      });

      const user = await db.prepare(
        'SELECT * FROM users WHERE id = ?'
      ).bind('user_profile_test').first<User>();
      expect(user).toMatchObject({
        display_name: 'Renamed Player',
        avatar_url: null,
        email: null,
      });
    } finally {
      await mf.dispose();
    }
  });
});
