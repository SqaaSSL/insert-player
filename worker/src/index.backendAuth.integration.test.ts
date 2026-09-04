import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it, vi } from 'vitest';

const jose = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => ({ kind: 'test-jwks' })),
  jwtVerify: vi.fn(),
}));

vi.mock('jose', () => jose);

import { clerkAuthOptionsForRequest, requireAuth } from './auth';
import type { AuthContext, Env } from './types';

const BRIDGE_SECRET = 'backend-bridge-secret-that-is-long-enough';
const ADMIN_USER_ID = 'user_backend_preflight_admin';

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

async function testEnv(): Promise<{ env: Env; mf: Miniflare }> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: 'backend-auth-endpoint-test',
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
        env: { DB: { type: 'd1', id: 'backend-auth-test-db' } },
      },
    }],
  });
  const db = await mf.getD1Database('DB');
  await db.batch(SCHEMA
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => db.prepare(statement)));
  await db.prepare(`
    INSERT INTO users (
      id, clerk_user_id, display_name, oauth_provider, oauth_id, plan_tier
    ) VALUES (?, ?, 'Backend Preflight Admin', 'clerk', ?, 'admin')
  `).bind(ADMIN_USER_ID, ADMIN_USER_ID, ADMIN_USER_ID).run();

  return {
    mf,
    env: {
      DB: db,
      ENVIRONMENT: 'production',
      CORS_ORIGIN: 'https://insertplayer.ai',
      CLERK_ISSUER: 'https://clerk.insertplayer.test',
      CLERK_JWKS_URL: 'https://clerk.insertplayer.test/.well-known/jwks.json',
      CLERK_AUTHORIZED_PARTIES: 'https://insertplayer.ai',
      CLERK_BACKEND_AUTH_BRIDGE_SECRET: BRIDGE_SECRET,
    } as unknown as Env,
  };
}

afterEach(() => {
  jose.jwtVerify.mockReset();
});

describe('Arcade backend authentication', () => {
  it('waives a mismatched Clerk azp only when the private bridge is valid', async () => {
    const { env, mf } = await testEnv();
    jose.jwtVerify.mockResolvedValue({
      payload: {
        sub: ADMIN_USER_ID,
        iss: env.CLERK_ISSUER,
        azp: 'https://unexpected-active-session.example',
      },
    });
    const request = (bridge?: string) => new Request(
      'https://api.insertplayer.ai/api/admin/arcade/generation-contract',
      {
        headers: {
          Authorization: 'Bearer verified-clerk-session-token',
          'X-Insert-Player-Admin-Seed': 'clerk-backend',
          ...(bridge ? { 'X-Insert-Player-Clerk-Backend-Auth': bridge } : {}),
        },
      },
    );

    try {
      const missingBridgeRequest = request();
      const missingBridge = await requireAuth(
        missingBridgeRequest,
        env,
        await clerkAuthOptionsForRequest(missingBridgeRequest, env, {
          allowMissingAuthorizedParty: true,
        }),
      );
      expect(missingBridge).toBeInstanceOf(Response);
      expect((missingBridge as Response).status).toBe(401);

      const wrongBridgeRequest = request(`${BRIDGE_SECRET}-wrong`);
      const wrongBridge = await requireAuth(
        wrongBridgeRequest,
        env,
        await clerkAuthOptionsForRequest(wrongBridgeRequest, env, {
          allowMissingAuthorizedParty: true,
        }),
      );
      expect(wrongBridge).toBeInstanceOf(Response);
      expect((wrongBridge as Response).status).toBe(401);

      const validBridgeRequest = request(BRIDGE_SECRET);
      const accepted = await requireAuth(
        validBridgeRequest,
        env,
        await clerkAuthOptionsForRequest(validBridgeRequest, env, {
          allowMissingAuthorizedParty: true,
        }),
      );
      expect(accepted).not.toBeInstanceOf(Response);
      expect((accepted as AuthContext).user).toMatchObject({
        id: ADMIN_USER_ID,
        plan_tier: 'admin',
      });
    } finally {
      await mf.dispose();
    }
  });
});
