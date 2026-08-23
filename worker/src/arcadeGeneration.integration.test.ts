import { Miniflare } from 'miniflare';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGenerationJob } from './generationJobs';
import {
  startAdminArcadeAnimationGeneration,
  startAdminArcadeGeneration,
  startAdminArcadeSourceGeneration,
} from './arcadeGeneration';
import { createProviderSession } from './providerSessions';
import type { AuthContext, Env } from './types';

vi.mock('./generationJobs', () => ({
  createGenerationJob: vi.fn(),
}));

vi.mock('./providerSessions', () => ({
  createProviderSession: vi.fn(),
}));

const USER_ID = 'arcade-admin';
const FIGHTER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ORIGINAL_KEY = `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/original.png`;
const LEGAL = {
  legalVersion: '2026-08-23.1',
  ageConfirmed: true,
  termsAccepted: true,
  photoRightsConfirmed: true,
  aiProcessingConfirmed: true,
  immediatePerformanceConfirmed: true,
  withdrawalLossAcknowledged: true,
};
const ANIMATIONS = [
  'idle',
  'walk',
  'high_punch',
  'low_punch',
  'high_kick',
  'low_kick',
  'jump',
  'crouch',
  'hit',
  'ko',
  'victory',
];

const SCHEMA = `
  CREATE TABLE fighters (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    original_blob_key TEXT
  );
  CREATE TABLE arcade_fighters (
    fighter_id TEXT PRIMARY KEY,
    status TEXT NOT NULL
  );
  CREATE TABLE sprites (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL,
    animation_name TEXT NOT NULL,
    quality_tier TEXT NOT NULL
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
    credit_cost INTEGER NOT NULL,
    free_quota_delta INTEGER NOT NULL,
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    fighter_id TEXT,
    ledger_id TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE generation_jobs (
    id TEXT PRIMARY KEY,
    charge_id TEXT,
    fighter_id TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    progress_current INTEGER NOT NULL,
    progress_total INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE provider_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    charge_id TEXT,
    status TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`;

const adminAuth = {
  userId: USER_ID,
  rateLimitKey: `user:${USER_ID}`,
  claims: {},
  user: {
    id: USER_ID,
    plan_tier: 'admin',
  },
} as unknown as AuthContext;

function generationRequest(): Request {
  return new Request(`https://api.insertplayer.ai/api/admin/arcade/${FIGHTER_ID}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ legal: LEGAL }),
  });
}

function animationRequest(animationName = 'walk'): Request {
  return new Request(
    `https://api.insertplayer.ai/api/admin/arcade/${FIGHTER_ID}/generate/${animationName}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ legal: LEGAL }),
    },
  );
}

function sourceRequest(sourceName = 'upright'): Request {
  return new Request(
    `https://api.insertplayer.ai/api/admin/arcade/${FIGHTER_ID}/generate/source/${sourceName}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ legal: LEGAL }),
    },
  );
}

async function bindings(): Promise<{ mf: Miniflare; db: D1Database; env: Env }> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: 'arcade-generation-test',
        compatibilityDate: '2026-08-23',
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
          DB: { type: 'd1', id: 'arcade-generation-db' },
          SPRITES: { type: 'r2', name: 'arcade-generation-assets' },
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
    db.prepare('INSERT INTO fighters (id, owner_user_id, original_blob_key) VALUES (?, ?, ?)')
      .bind(FIGHTER_ID, USER_ID, ORIGINAL_KEY),
    db.prepare("INSERT INTO arcade_fighters (fighter_id, status) VALUES (?, 'draft')")
      .bind(FIGHTER_ID),
  ]);
  await bucket.put(ORIGINAL_KEY, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  return {
    mf,
    db,
    env: {
      DB: db,
      SPRITES: bucket,
      ENVIRONMENT: 'development',
      CORS_ORIGIN: 'https://insertplayer.ai',
    } as Env,
  };
}

describe('official Arcade generation authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createProviderSession).mockResolvedValue({ id: 'provider-session' } as never);
    vi.mocked(createGenerationJob).mockResolvedValue(Response.json({
      job: { id: 'arcade-job', status: 'queued' },
    }, { status: 201 }));
  });

  it('starts a durable Champion inventory job without consuming user credits', async () => {
    const { mf, db, env } = await bindings();
    try {
      const response = await startAdminArcadeGeneration(generationRequest(), env, adminAuth, FIGHTER_ID);
      expect(response.status).toBe(201);
      expect(createProviderSession).toHaveBeenCalledOnce();
      const [, providerAuth, providerParams] = vi.mocked(createProviderSession).mock.calls[0];
      expect(providerAuth).toMatchObject({ userId: USER_ID });
      expect(providerParams).toMatchObject({
        tier: 'champion',
        purpose: 'fighter_generation',
        operation: 'fighter_generation',
      });
      expect(createGenerationJob).toHaveBeenCalledOnce();

      const ledger = await db.prepare(
        'SELECT delta, reason, fighter_id FROM credit_ledger LIMIT 1'
      ).first<{ delta: number; reason: string; fighter_id: string }>();
      expect(ledger).toEqual({
        delta: 0,
        reason: 'arcade_seed_generation',
        fighter_id: FIGHTER_ID,
      });
      const charge = await db.prepare(`
        SELECT tier, credit_cost, free_quota_delta, status, reason, fighter_id
        FROM generation_charges LIMIT 1
      `).first<Record<string, unknown>>();
      expect(charge).toMatchObject({
        tier: 'champion',
        credit_cost: 0,
        free_quota_delta: 0,
        status: 'reserved',
        reason: 'arcade_seed_generation',
        fighter_id: FIGHTER_ID,
      });
    } finally {
      await mf.dispose();
    }
  });

  it('does not mistake a complete Contender set for a ready Champion', async () => {
    const { mf, db, env } = await bindings();
    try {
      await db.batch(ANIMATIONS.map((animation, index) => db.prepare(`
        INSERT INTO sprites (id, fighter_id, animation_name, quality_tier)
        VALUES (?, ?, ?, 'contender')
      `).bind(`sprite-${index}`, FIGHTER_ID, animation)));
      const response = await startAdminArcadeGeneration(generationRequest(), env, adminAuth, FIGHTER_ID);
      const body = await response.json() as { ready?: boolean; job?: { id: string } };
      expect(body.ready).not.toBe(true);
      expect(body.job?.id).toBe('arcade-job');
      expect(createGenerationJob).toHaveBeenCalledOnce();
    } finally {
      await mf.dispose();
    }
  });

  it('starts a zero-credit Champion retry for one approved Arcade animation', async () => {
    const { mf, db, env } = await bindings();
    try {
      const response = await startAdminArcadeAnimationGeneration(
        animationRequest(),
        env,
        adminAuth,
        FIGHTER_ID,
        'walk',
      );
      expect(response.status).toBe(201);
      expect(createProviderSession).toHaveBeenCalledOnce();
      const [, , providerParams] = vi.mocked(createProviderSession).mock.calls[0];
      expect(providerParams).toMatchObject({
        tier: 'champion',
        purpose: 'fighter_retry',
        operation: 'fighter_retry_animation',
      });

      const [jobRequest] = vi.mocked(createGenerationJob).mock.calls[0];
      expect(await jobRequest.clone().json()).toMatchObject({
        fighterId: FIGHTER_ID,
        targetKind: 'animation',
        targetName: 'walk',
      });
      expect(await db.prepare(
        'SELECT delta, reason FROM credit_ledger LIMIT 1'
      ).first()).toEqual({ delta: 0, reason: 'fighter_retry_animation' });
      expect(await db.prepare(`
        SELECT tier, credit_cost, status, reason FROM generation_charges LIMIT 1
      `).first()).toEqual({
        tier: 'champion',
        credit_cost: 0,
        status: 'reserved',
        reason: 'fighter_retry_animation',
      });
    } finally {
      await mf.dispose();
    }
  });

  it('rejects an unknown Arcade animation before reserving provider spend', async () => {
    const { mf, db, env } = await bindings();
    try {
      const response = await startAdminArcadeAnimationGeneration(
        animationRequest('fatality'),
        env,
        adminAuth,
        FIGHTER_ID,
        'fatality',
      );
      expect(response.status).toBe(400);
      expect(createProviderSession).not.toHaveBeenCalled();
      expect(await db.prepare('SELECT COUNT(*) AS count FROM generation_charges')
        .first<{ count: number }>()).toEqual({ count: 0 });
    } finally {
      await mf.dispose();
    }
  });

  it('starts a zero-credit Champion retry for one canonical Arcade source', async () => {
    const { mf, db, env } = await bindings();
    try {
      const response = await startAdminArcadeSourceGeneration(
        sourceRequest(),
        env,
        adminAuth,
        FIGHTER_ID,
        'upright',
      );
      expect(response.status).toBe(201);
      expect(createProviderSession).toHaveBeenCalledOnce();
      const [, , providerParams] = vi.mocked(createProviderSession).mock.calls[0];
      expect(providerParams).toMatchObject({
        tier: 'champion',
        purpose: 'fighter_retry',
        operation: 'fighter_retry_source',
      });

      const [jobRequest] = vi.mocked(createGenerationJob).mock.calls[0];
      expect(await jobRequest.clone().json()).toMatchObject({
        fighterId: FIGHTER_ID,
        targetKind: 'source',
        targetName: 'upright',
      });
      expect(await db.prepare(
        'SELECT delta, reason FROM credit_ledger LIMIT 1'
      ).first()).toEqual({ delta: 0, reason: 'fighter_retry_source' });
    } finally {
      await mf.dispose();
    }
  });

  it('rejects an unknown canonical source before reserving provider spend', async () => {
    const { mf, db, env } = await bindings();
    try {
      const response = await startAdminArcadeSourceGeneration(
        sourceRequest('portrait'),
        env,
        adminAuth,
        FIGHTER_ID,
        'portrait',
      );
      expect(response.status).toBe(400);
      expect(createProviderSession).not.toHaveBeenCalled();
      expect(await db.prepare('SELECT COUNT(*) AS count FROM generation_charges')
        .first<{ count: number }>()).toEqual({ count: 0 });
    } finally {
      await mf.dispose();
    }
  });
});
