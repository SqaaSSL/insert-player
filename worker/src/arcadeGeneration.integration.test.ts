import { Miniflare } from 'miniflare';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGenerationJob } from './generationJobs';
import {
  readAdminArcadeGenerationContract,
  startAdminArcadeAnimationGeneration,
  startAdminArcadeGeneration,
  startAdminArcadeSourceGeneration,
} from './arcadeGeneration';
import {
  constrainProviderSessionToArtifactRunRemaining,
  createProviderSession,
} from './providerSessions';
import type { AuthContext, Env } from './types';
import { OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT } from '../../src/services/ImageProviderContract';

vi.mock('./generationJobs', () => ({
  createGenerationJob: vi.fn(),
}));

vi.mock('./providerSessions', () => ({
  createProviderSession: vi.fn(),
  constrainProviderSessionToArtifactRunRemaining: vi.fn(),
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
const MINIFLARE_TEST_TIMEOUT_MS = 30_000;

const SCHEMA = `
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
  CREATE TABLE arcade_fighters (
    fighter_id TEXT PRIMARY KEY,
    status TEXT NOT NULL
  );
  CREATE TABLE sprites (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL,
    animation_name TEXT NOT NULL,
    quality_tier TEXT NOT NULL,
    blob_key TEXT,
    raw_blob_key TEXT
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
    continuation_run_id TEXT,
    resumed_from_job_id TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE generation_jobs (
    id TEXT PRIMARY KEY,
    charge_id TEXT,
    user_id TEXT,
    fighter_id TEXT NOT NULL,
    artifact_run_id TEXT,
    tier TEXT,
    operation TEXT,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    progress_current INTEGER NOT NULL,
    progress_total INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE generation_artifact_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    fighter_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    operation TEXT NOT NULL,
    target_kind TEXT,
    target_name TEXT,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE generation_artifact_checkpoints (
    run_id TEXT NOT NULL,
    artifact_kind TEXT NOT NULL,
    artifact_name TEXT NOT NULL,
    stage_index INTEGER NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (run_id, artifact_kind, artifact_name)
  );
  CREATE TABLE provider_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    charge_id TEXT,
    status TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

function generationRequest(restart = false): Request {
  return new Request(`https://api.insertplayer.ai/api/admin/arcade/${FIGHTER_ID}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ legal: LEGAL, ...(restart ? { restart: true } : {}) }),
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

function sourceRequest(sourceName = 'upright', restart = false, canary = false): Request {
  return new Request(
    `https://api.insertplayer.ai/api/admin/arcade/${FIGHTER_ID}/generate/source/${sourceName}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        legal: LEGAL,
        ...(restart ? { restart: true } : {}),
        ...(canary ? { canary: true } : {}),
      }),
    },
  );
}

function contractEnv(payload: unknown, status = 200): {
  env: Env;
  getByName: ReturnType<typeof vi.fn>;
  processorFetch: ReturnType<typeof vi.fn>;
} {
  const processorFetch = vi.fn().mockResolvedValue(Response.json(payload, { status }));
  const getByName = vi.fn().mockReturnValue({ fetch: processorFetch });
  return {
    env: { IMAGE_PROCESSOR: { getByName } } as unknown as Env,
    getByName,
    processorFetch,
  };
}

async function bindings(): Promise<{ mf: Miniflare; db: D1Database; bucket: R2Bucket; env: Env }> {
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
    bucket,
    env: {
      DB: db,
      SPRITES: bucket,
      ENVIRONMENT: 'development',
      CORS_ORIGIN: 'https://insertplayer.ai',
    } as Env,
  };
}

async function stageCompleteChampionInventory(
  db: D1Database,
  bucket: R2Bucket,
  storeObjects: boolean,
): Promise<void> {
  const sourceKeys = {
    side: `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/side.png`,
    sideRaw: `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/side-raw.png`,
    upright: `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/upright.png`,
    uprightRaw: `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/upright-raw.png`,
    crouch: `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/crouch.png`,
    crouchRaw: `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/crouch-raw.png`,
  };
  await db.batch([
    db.prepare(`
      UPDATE fighters SET
        side_view_blob_key = ?,
        side_view_raw_blob_key = ?,
        upright_view_blob_key = ?,
        upright_view_raw_blob_key = ?,
        crouch_view_blob_key = ?,
        crouch_view_raw_blob_key = ?
      WHERE id = ?
    `).bind(
      sourceKeys.side,
      sourceKeys.sideRaw,
      sourceKeys.upright,
      sourceKeys.uprightRaw,
      sourceKeys.crouch,
      sourceKeys.crouchRaw,
      FIGHTER_ID,
    ),
    ...ANIMATIONS.map((animation, index) => db.prepare(`
      INSERT INTO sprites (
        id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key
      ) VALUES (?, ?, ?, 'champion', ?, ?)
    `).bind(
      `sprite-${index}`,
      FIGHTER_ID,
      animation,
      `users/${USER_ID}/fighters/${FIGHTER_ID}/sprites/${animation}.png`,
      `users/${USER_ID}/fighters/${FIGHTER_ID}/sprites/${animation}-raw.png`,
    )),
  ]);
  if (!storeObjects) return;
  await Promise.all([
    ...Object.values(sourceKeys).map((key) => bucket.put(key, new Uint8Array([1, 2, 3]))),
    ...ANIMATIONS.flatMap((animation) => [
      bucket.put(
        `users/${USER_ID}/fighters/${FIGHTER_ID}/sprites/${animation}.png`,
        new Uint8Array([4, 5, 6]),
      ),
      bucket.put(
        `users/${USER_ID}/fighters/${FIGHTER_ID}/sprites/${animation}-raw.png`,
        new Uint8Array([7, 8, 9]),
      ),
    ]),
  ]);
}

describe('official Arcade generation authorization', { timeout: MINIFLARE_TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createProviderSession).mockResolvedValue({
      id: 'provider-session',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      providerCallLimit: 320,
      providerCostLimitCents: 1_800,
    });
    vi.mocked(constrainProviderSessionToArtifactRunRemaining).mockImplementation(
      async (_env, session) => ({
        ...session,
        providerCallLimit: 219,
        providerCostLimitCents: 915,
      }),
    );
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

  it('resumes the failed Champion roster after 3 sources and 4 animations on the same run', async () => {
    const { mf, db, env } = await bindings();
    const failedJobId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const originalChargeId = 'cccccccccccccccccccccccccccccccc';
    const completedStages = [
      ['source', 'side', 1],
      ['source', 'upright', 2],
      ['source', 'crouch', 3],
      ['sprite', 'idle', 4],
      ['sprite', 'walk', 5],
      ['sprite', 'high_punch', 6],
      ['sprite', 'high_kick', 7],
    ] as const;
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES ('original-roster-ledger', ?, 0, 'arcade_seed_generation', ?)
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, credit_cost, free_quota_delta, status,
            reason, fighter_id, ledger_id, expires_at
          ) VALUES (?, ?, 'champion', 0, 0, 'committed',
            'arcade_seed_generation', ?, 'original-roster-ledger', datetime('now', '+1 hour'))
        `).bind(originalChargeId, USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_artifact_runs (
            id, user_id, fighter_id, tier, operation, status
          ) VALUES (?, ?, ?, 'champion', 'fighter_generation', 'partial')
        `).bind(failedJobId, USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, charge_id, user_id, fighter_id, artifact_run_id, tier, operation,
            status, stage, progress_current, progress_total
          ) VALUES (?, ?, ?, ?, ?, 'champion', 'fighter_generation',
            'failed', 'sprite:low_punch', 7, 14)
        `).bind(failedJobId, originalChargeId, USER_ID, FIGHTER_ID, failedJobId),
        ...completedStages.map(([kind, name, index]) => db.prepare(`
          INSERT INTO generation_artifact_checkpoints (
            run_id, artifact_kind, artifact_name, stage_index, status
          ) VALUES (?, ?, ?, ?, 'approved')
        `).bind(failedJobId, kind, name, index)),
      ]);

      const response = await startAdminArcadeGeneration(
        generationRequest(),
        env,
        adminAuth,
        FIGHTER_ID,
      );

      expect(response.status).toBe(201);
      expect(constrainProviderSessionToArtifactRunRemaining).toHaveBeenCalledOnce();
      const [, , , continuationRunId] = vi.mocked(
        constrainProviderSessionToArtifactRunRemaining,
      ).mock.calls[0];
      expect(continuationRunId).toBe(failedJobId);
      expect(await db.prepare(`
        SELECT continuation_run_id, resumed_from_job_id, credit_cost
        FROM generation_charges WHERE status = 'reserved'
      `).first()).toEqual({
        continuation_run_id: failedJobId,
        resumed_from_job_id: failedJobId,
        credit_cost: 0,
      });
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM generation_artifact_checkpoints
        WHERE run_id = ? AND status = 'approved'
      `).bind(failedJobId).first<{ count: number }>())?.count).toBe(7);
      const [jobRequest] = vi.mocked(createGenerationJob).mock.calls[0];
      expect(await jobRequest.clone().json()).toMatchObject({ fighterId: FIGHTER_ID });
    } finally {
      await mf.dispose();
    }
  });

  it('starts a fresh full run when restart is explicit and never inherits an older partial run', async () => {
    const { mf, db, env } = await bindings();
    const failedJobId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES ('restart-ledger', ?, 0, 'arcade_seed_generation', ?)
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, credit_cost, free_quota_delta, status,
            reason, fighter_id, ledger_id, expires_at
          ) VALUES ('restart-charge', ?, 'champion', 0, 0, 'committed',
            'arcade_seed_generation', ?, 'restart-ledger', datetime('now', '+1 hour'))
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_artifact_runs (
            id, user_id, fighter_id, tier, operation, status
          ) VALUES (?, ?, ?, 'champion', 'fighter_generation', 'partial')
        `).bind(failedJobId, USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, charge_id, user_id, fighter_id, artifact_run_id, tier, operation,
            status, stage, progress_current, progress_total
          ) VALUES (?, 'restart-charge', ?, ?, ?, 'champion', 'fighter_generation',
            'failed', 'sprite:low_punch', 7, 14)
        `).bind(failedJobId, USER_ID, FIGHTER_ID, failedJobId),
      ]);

      const response = await startAdminArcadeGeneration(
        generationRequest(true), env, adminAuth, FIGHTER_ID,
      );

      expect(response.status).toBe(201);
      expect(constrainProviderSessionToArtifactRunRemaining).not.toHaveBeenCalled();
      const charge = await db.prepare(`
        SELECT continuation_run_id, resumed_from_job_id
        FROM generation_charges WHERE status = 'reserved'
      `).first();
      expect(charge).toEqual({ continuation_run_id: null, resumed_from_job_id: null });
    } finally {
      await mf.dispose();
    }
  });

  it('cancels a continuation session when its aggregate budget cannot be bounded', async () => {
    const { mf, db, env } = await bindings();
    const failedJobId = 'dddddddddddddddddddddddddddddddd';
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES ('failed-budget-ledger', ?, 0, 'arcade_seed_generation', ?)
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, credit_cost, free_quota_delta, status,
            reason, fighter_id, ledger_id, expires_at
          ) VALUES ('failed-budget-charge', ?, 'champion', 0, 0, 'committed',
            'arcade_seed_generation', ?, 'failed-budget-ledger', datetime('now', '+1 hour'))
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_artifact_runs (
            id, user_id, fighter_id, tier, operation, status
          ) VALUES (?, ?, ?, 'champion', 'fighter_generation', 'partial')
        `).bind(failedJobId, USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, charge_id, user_id, fighter_id, artifact_run_id, tier, operation,
            status, stage, progress_current, progress_total
          ) VALUES (?, 'failed-budget-charge', ?, ?, ?, 'champion', 'fighter_generation',
            'failed', 'sprite:low_punch', 7, 14)
        `).bind(failedJobId, USER_ID, FIGHTER_ID, failedJobId),
        db.prepare(`
          INSERT INTO provider_sessions (id, user_id, charge_id, status, expires_at)
          VALUES ('provider-session', ?, NULL, 'active', datetime('now', '+1 hour'))
        `).bind(USER_ID),
      ]);
      vi.mocked(constrainProviderSessionToArtifactRunRemaining)
        .mockRejectedValueOnce(new Error('budget unavailable'));

      await expect(startAdminArcadeGeneration(
        generationRequest(),
        env,
        adminAuth,
        FIGHTER_ID,
      )).rejects.toThrow('budget unavailable');

      expect((await db.prepare(`
        SELECT status FROM generation_charges
        WHERE continuation_run_id = ?
      `).bind(failedJobId).first<{ status: string }>())?.status).toBe('refunded');
      expect((await db.prepare(`
        SELECT status FROM provider_sessions WHERE id = 'provider-session'
      `).first<{ status: string }>())?.status).toBe('cancelled');
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

  it('does not mistake stale Champion rows with missing R2 objects for a ready fighter', async () => {
    const { mf, db, bucket, env } = await bindings();
    try {
      await stageCompleteChampionInventory(db, bucket, false);
      const response = await startAdminArcadeGeneration(generationRequest(), env, adminAuth, FIGHTER_ID);
      const body = await response.json() as { ready?: boolean; job?: { id: string } };
      expect(body.ready).not.toBe(true);
      expect(body.job?.id).toBe('arcade-job');
      expect(createGenerationJob).toHaveBeenCalledOnce();
    } finally {
      await mf.dispose();
    }
  });

  it('returns ready only when every canonical and Champion object exists in R2', async () => {
    const { mf, db, bucket, env } = await bindings();
    try {
      await stageCompleteChampionInventory(db, bucket, true);
      const response = await startAdminArcadeGeneration(generationRequest(), env, adminAuth, FIGHTER_ID);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ready: true,
        fighterId: FIGHTER_ID,
        tier: 'champion',
        animationCount: ANIMATIONS.length,
      });
      expect(createProviderSession).not.toHaveBeenCalled();
      expect(createGenerationJob).not.toHaveBeenCalled();
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

  it('continues a failed Arcade animation on its original artifact run', async () => {
    const { mf, db, env } = await bindings();
    const failedJobId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const originalChargeId = 'cccccccccccccccccccccccccccccccc';
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES ('original-ledger', ?, 0, 'fighter_retry_animation', ?)
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, credit_cost, free_quota_delta, status,
            reason, fighter_id, ledger_id, expires_at
          ) VALUES (?, ?, 'champion', 0, 0, 'committed',
            'fighter_retry_animation', ?, 'original-ledger', datetime('now', '+1 hour'))
        `).bind(originalChargeId, USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_artifact_runs (
            id, user_id, fighter_id, tier, operation, target_kind, target_name, status
          ) VALUES (?, ?, ?, 'champion', 'fighter_retry_animation', 'animation', 'walk', 'partial')
        `).bind(failedJobId, USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, charge_id, user_id, fighter_id, artifact_run_id, tier, operation,
            status, stage, progress_current, progress_total
          ) VALUES (?, ?, ?, ?, ?, 'champion', 'fighter_retry_animation',
            'failed', 'sprite:walk', 0, 1)
        `).bind(failedJobId, originalChargeId, USER_ID, FIGHTER_ID, failedJobId),
      ]);

      const response = await startAdminArcadeAnimationGeneration(
        animationRequest(),
        env,
        adminAuth,
        FIGHTER_ID,
        'walk',
      );
      expect(response.status).toBe(201);
      expect(constrainProviderSessionToArtifactRunRemaining).toHaveBeenCalledOnce();
      const [, continuationSession, continuationChargeId, continuationRunId] = vi.mocked(
        constrainProviderSessionToArtifactRunRemaining,
      ).mock.calls[0];
      expect(continuationSession).toMatchObject({ id: 'provider-session' });
      expect(continuationChargeId).toMatch(/^[a-f0-9]{32}$/);
      expect(continuationRunId).toBe(failedJobId);
      expect(await db.prepare(`
        SELECT continuation_run_id, resumed_from_job_id, credit_cost
        FROM generation_charges
        WHERE status = 'reserved'
      `).first()).toEqual({
        continuation_run_id: failedJobId,
        resumed_from_job_id: failedJobId,
        credit_cost: 0,
      });
      const [jobRequest] = vi.mocked(createGenerationJob).mock.calls[0];
      expect(await jobRequest.clone().json()).toMatchObject({
        targetKind: 'animation',
        targetName: 'walk',
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

  it('starts a fresh one-source canary when restart is explicit', async () => {
    const { mf, db, env } = await bindings();
    const failedJobId = 'ffffffffffffffffffffffffffffffff';
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES ('source-restart-ledger', ?, 0, 'fighter_retry_source', ?)
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, credit_cost, free_quota_delta, status,
            reason, fighter_id, ledger_id, expires_at
          ) VALUES ('source-restart-charge', ?, 'champion', 0, 0, 'committed',
            'fighter_retry_source', ?, 'source-restart-ledger', datetime('now', '+1 hour'))
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_artifact_runs (
            id, user_id, fighter_id, tier, operation, target_kind, target_name, status
          ) VALUES (?, ?, ?, 'champion', 'fighter_retry_source', 'source', 'side', 'partial')
        `).bind(failedJobId, USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, charge_id, user_id, fighter_id, artifact_run_id, tier, operation,
            status, stage, progress_current, progress_total
          ) VALUES (?, 'source-restart-charge', ?, ?, ?, 'champion', 'fighter_retry_source',
            'failed', 'source:side', 0, 1)
        `).bind(failedJobId, USER_ID, FIGHTER_ID, failedJobId),
      ]);

      const response = await startAdminArcadeSourceGeneration(
        sourceRequest('side', true, true), env, adminAuth, FIGHTER_ID, 'side',
      );

      expect(response.status).toBe(201);
      expect(constrainProviderSessionToArtifactRunRemaining).not.toHaveBeenCalled();
      const [, , providerParams] = vi.mocked(createProviderSession).mock.calls[0];
      expect(providerParams).toMatchObject({
        providerCallLimitCap: 2,
        providerCostLimitCentsCap: 30,
      });
      expect(await db.prepare(`
        SELECT continuation_run_id, resumed_from_job_id
        FROM generation_charges WHERE status = 'reserved'
      `).first()).toEqual({ continuation_run_id: null, resumed_from_job_id: null });
      const [jobRequest] = vi.mocked(createGenerationJob).mock.calls[0];
      expect(await jobRequest.clone().json()).toMatchObject({
        targetKind: 'source',
        targetName: 'side',
      });
    } finally {
      await mf.dispose();
    }
  });

  it('rejects a canary unless it is a fresh side generation', async () => {
    const { mf, db, env } = await bindings();
    try {
      const responses = await Promise.all([
        startAdminArcadeSourceGeneration(
          sourceRequest('side', false, true), env, adminAuth, FIGHTER_ID, 'side',
        ),
        startAdminArcadeSourceGeneration(
          sourceRequest('upright', true, true), env, adminAuth, FIGHTER_ID, 'upright',
        ),
      ]);
      expect(responses.map((response) => response.status)).toEqual([400, 400]);
      expect(createProviderSession).not.toHaveBeenCalled();
      expect(await db.prepare('SELECT COUNT(*) AS count FROM generation_charges')
        .first<{ count: number }>()).toEqual({ count: 0 });
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

describe('official Arcade deployed provider preflight', () => {
  it('returns the approved contract only after reading the deployed processor health endpoint', async () => {
    const { env, getByName, processorFetch } = contractEnv({
      status: 'ok',
      runtime: 'canvas-skia',
      imageProviderContract: OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT,
    });
    const response = await readAdminArcadeGenerationContract(env, adminAuth);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ready: true,
      runtime: 'canvas-skia',
      contract: OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT,
    });
    expect(getByName).toHaveBeenCalledWith('official-arcade-provider-contract-v1');
    expect(processorFetch).toHaveBeenCalledOnce();
    const [healthRequest] = processorFetch.mock.calls[0] as [Request];
    expect(healthRequest.url).toBe('http://image-processor/health');
    expect(healthRequest.method).toBe('GET');
  });

  it('fails closed when the processor advertises another generation provider', async () => {
    const rejected = structuredClone(OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT) as Record<string, unknown>;
    rejected.allowedGenerationProviders = ['fal'];
    const { env } = contractEnv({
      status: 'ok',
      runtime: 'canvas-skia',
      imageProviderContract: rejected,
    });
    const response = await readAdminArcadeGenerationContract(env, adminAuth);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Image processor provider contract is not approved',
      reason: 'processor_contract_unapproved',
    });
  });

  it('reports a safe reason when the deployed processor has not published the contract', async () => {
    const { env } = contractEnv({
      status: 'ok',
      runtime: 'canvas-skia',
    });
    const response = await readAdminArcadeGenerationContract(env, adminAuth);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Image processor provider contract is missing',
      reason: 'processor_contract_missing',
    });
  });

  it('does not expose the processor contract to non-admin users', async () => {
    const { env, processorFetch } = contractEnv({
      status: 'ok',
      runtime: 'canvas-skia',
      imageProviderContract: OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT,
    });
    const nonAdmin = structuredClone(adminAuth);
    nonAdmin.user.plan_tier = 'free';
    const response = await readAdminArcadeGenerationContract(env, nonAdmin);
    expect(response.status).toBe(403);
    expect(processorFetch).not.toHaveBeenCalled();
  });
});
