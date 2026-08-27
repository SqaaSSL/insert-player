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
import { hashString } from './auth';
import { REVIEWED_CANONICAL_SOURCE_MODE } from './reviewedCanonicalSources';

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
  CREATE TABLE source_versions (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    content_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE sprites (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL,
    animation_name TEXT NOT NULL,
    quality_tier TEXT NOT NULL,
    blob_key TEXT,
    raw_blob_key TEXT,
    content_hash TEXT,
    raw_content_hash TEXT,
    frame_w INTEGER,
    frame_h INTEGER,
    frame_count INTEGER
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
    creation_flow TEXT NOT NULL DEFAULT 'original',
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
    provider_session_id TEXT,
    user_id TEXT,
    fighter_id TEXT NOT NULL,
    artifact_run_id TEXT,
    tier TEXT,
    creation_flow TEXT NOT NULL DEFAULT 'original',
    operation TEXT,
    target_kind TEXT,
    target_name TEXT,
    resumed_from_job_id TEXT,
    status TEXT NOT NULL,
    review_status TEXT NOT NULL DEFAULT 'none',
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
    creation_flow TEXT NOT NULL DEFAULT 'original',
    operation TEXT NOT NULL,
    target_kind TEXT,
    target_name TEXT,
    root_job_id TEXT,
    original_charge_id TEXT,
    source_manifest_json TEXT,
    status TEXT NOT NULL,
    failure_stage TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
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
  CREATE TABLE video_sprite_candidates (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    job_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    fighter_id TEXT NOT NULL,
    action TEXT NOT NULL,
    sequence_order INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting_review',
    current_revision INTEGER NOT NULL DEFAULT 1,
    approved_revision INTEGER
  );
  CREATE TABLE video_sprite_candidate_revisions (
    candidate_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    report_sha256 TEXT NOT NULL,
    PRIMARY KEY (candidate_id, revision)
  );
  CREATE TABLE provider_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    rate_limit_key TEXT NOT NULL DEFAULT 'test',
    tier TEXT NOT NULL DEFAULT 'champion',
    charge_id TEXT,
    creation_flow TEXT NOT NULL DEFAULT 'original',
    purpose TEXT NOT NULL DEFAULT 'fighter_generation',
    status TEXT NOT NULL,
    provider_calls_used INTEGER NOT NULL DEFAULT 0,
    provider_cost_used_cents INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE provider_request_cache (
    id TEXT PRIMARY KEY,
    job_id TEXT,
    artifact_run_id TEXT,
    request_key TEXT,
    status TEXT NOT NULL
  );
  CREATE TABLE provider_cost_events (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    charge_id TEXT,
    job_id TEXT,
    artifact_run_id TEXT,
    request_key TEXT,
    estimated_cost_cents INTEGER NOT NULL DEFAULT 0,
    outcome TEXT NOT NULL,
    upstream_outcome TEXT NOT NULL,
    stage_outcome TEXT NOT NULL,
    job_outcome TEXT NOT NULL,
    finalized_at TEXT
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

function generationRequest(
  restart = false,
  creationFlow?: 'original' | 'video',
  reviewed?: {
    canonicalSourceMode?: unknown;
    canonicalSourceHashes?: unknown;
    recoveryFromJobId?: unknown;
  },
): Request {
  return new Request(`https://api.insertplayer.ai/api/admin/arcade/${FIGHTER_ID}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      legal: LEGAL,
      ...(restart ? { restart: true } : {}),
      ...(creationFlow ? { creationFlow } : {}),
      ...reviewed,
    }),
  });
}

async function stageReviewedCanonicalSources(db: D1Database, bucket: R2Bucket) {
  const definitions = [
    ['side', 'side_view_blob_key', 1],
    ['side_raw', 'side_view_raw_blob_key', 2],
    ['upright', 'upright_view_blob_key', 3],
    ['upright_raw', 'upright_view_raw_blob_key', 4],
    ['crouch', 'crouch_view_blob_key', 5],
    ['crouch_raw', 'crouch_view_raw_blob_key', 6],
  ] as const;
  const rows = [];
  for (const [kind, column, index] of definitions) {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, index]);
    const hash = await hashString(bytes.buffer);
    const versionId = String(index).repeat(32);
    const blobKey = `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/reviewed-${kind}.png`;
    await bucket.put(blobKey, bytes, { customMetadata: { contentHash: hash } });
    await db.prepare(`
      INSERT INTO source_versions (id, fighter_id, kind, blob_key, content_hash)
      VALUES (?, ?, ?, ?, ?)
    `).bind(versionId, FIGHTER_ID, kind, blobKey, hash).run();
    await db.prepare(`UPDATE fighters SET ${column} = ? WHERE id = ?`)
      .bind(blobKey, FIGHTER_ID).run();
    rows.push({ kind, column, versionId, blobKey, hash, bytes });
  }
  const hashes = {
    side: { processedSha256: rows[0].hash, rawSha256: rows[1].hash },
    upright: { processedSha256: rows[2].hash, rawSha256: rows[3].hash },
    crouch: { processedSha256: rows[4].hash, rawSha256: rows[5].hash },
  };
  return { rows, hashes };
}

const UNSEALED_VIDEO_JOB_ID = '81818181818181818181818181818181';

async function stageTerminalUnsealedVideoPartial(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`
      INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
      VALUES ('unsealed-video-ledger', ?, 0, 'arcade_seed_generation', ?)
    `).bind(USER_ID, FIGHTER_ID),
    db.prepare(`
      INSERT INTO generation_charges (
        id, user_id, tier, creation_flow, credit_cost, free_quota_delta,
        status, reason, fighter_id, ledger_id, expires_at
      ) VALUES (?, ?, 'champion', 'video', 0, 0, 'committed',
        'arcade_seed_generation', ?, 'unsealed-video-ledger', datetime('now', '+1 hour'))
    `).bind(UNSEALED_VIDEO_JOB_ID, USER_ID, FIGHTER_ID),
    db.prepare(`
      INSERT INTO provider_sessions (
        id, user_id, charge_id, creation_flow, status, provider_calls_used,
        provider_cost_used_cents, expires_at
      ) VALUES ('unsealed-video-session', ?, ?, 'video', 'cancelled', 1, 17,
        datetime('now', '+1 hour'))
    `).bind(USER_ID, UNSEALED_VIDEO_JOB_ID),
    db.prepare(`
      INSERT INTO generation_artifact_runs (
        id, user_id, fighter_id, tier, creation_flow, operation,
        root_job_id, original_charge_id, source_manifest_json,
        status, failure_stage
      ) VALUES (?, ?, ?, 'champion', 'video', 'fighter_generation', ?, ?,
        json_object('side', NULL, 'sideRaw', NULL, 'upright', NULL,
          'uprightRaw', NULL, 'crouch', NULL, 'crouchRaw', NULL),
        'partial', 'source:side')
    `).bind(
      UNSEALED_VIDEO_JOB_ID,
      USER_ID,
      FIGHTER_ID,
      UNSEALED_VIDEO_JOB_ID,
      UNSEALED_VIDEO_JOB_ID,
    ),
    db.prepare(`
      INSERT INTO generation_jobs (
        id, charge_id, provider_session_id, user_id, fighter_id,
        artifact_run_id, tier, creation_flow, operation, status,
        review_status, stage, progress_current, progress_total
      ) VALUES (?, ?, 'unsealed-video-session', ?, ?, ?, 'champion', 'video',
        'fighter_generation', 'failed', 'none', 'source:side', 0, 14)
    `).bind(
      UNSEALED_VIDEO_JOB_ID,
      UNSEALED_VIDEO_JOB_ID,
      USER_ID,
      FIGHTER_ID,
      UNSEALED_VIDEO_JOB_ID,
    ),
    db.prepare(`
      INSERT INTO provider_request_cache (
        id, job_id, artifact_run_id, request_key, status
      ) VALUES ('unsealed-video-request', ?, ?, 'run:unsealed:source:side', 'succeeded')
    `).bind(UNSEALED_VIDEO_JOB_ID, UNSEALED_VIDEO_JOB_ID),
    db.prepare(`
      INSERT INTO provider_cost_events (
        id, session_id, charge_id, job_id, artifact_run_id, request_key, estimated_cost_cents,
        outcome, upstream_outcome, stage_outcome, job_outcome, finalized_at
      ) VALUES ('unsealed-video-cost', 'unsealed-video-session', ?, ?, ?,
        'run:unsealed:source:side', 17,
        'succeeded', 'http_succeeded', 'failed', 'failed_partial', datetime('now'))
    `).bind(UNSEALED_VIDEO_JOB_ID, UNSEALED_VIDEO_JOB_ID, UNSEALED_VIDEO_JOB_ID),
  ]);
}

function reviewedGenerationRequest(
  hashes: unknown,
  restart = false,
  recoveryFromJobId?: string,
): Request {
  return generationRequest(restart, 'video', {
    canonicalSourceMode: REVIEWED_CANONICAL_SOURCE_MODE,
    canonicalSourceHashes: hashes,
    ...(recoveryFromJobId ? { recoveryFromJobId } : {}),
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

function sourceRequest(sourceName = 'upright', restart = false, canary = false, probe = false): Request {
  return new Request(
    `https://api.insertplayer.ai/api/admin/arcade/${FIGHTER_ID}/generate/source/${sourceName}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        legal: LEGAL,
        ...(restart ? { restart: true } : {}),
        ...(canary ? { canary: true } : {}),
        ...(probe ? { probe: true } : {}),
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
        id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
        content_hash, raw_content_hash, frame_w, frame_h, frame_count
      ) VALUES (?, ?, ?, 'champion', ?, ?, ?, ?, 768, 1024, 8)
    `).bind(
      `sprite-${index}`,
      FIGHTER_ID,
      animation,
      `users/${USER_ID}/fighters/${FIGHTER_ID}/sprites/${animation}.png`,
      `users/${USER_ID}/fighters/${FIGHTER_ID}/sprites/${animation}-raw.png`,
      'a'.repeat(64),
      'b'.repeat(64),
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
        creationFlow: 'original',
      });
      expect(createGenerationJob).toHaveBeenCalledOnce();
      const [jobRequest] = vi.mocked(createGenerationJob).mock.calls[0];
      expect(await jobRequest.clone().json()).toEqual({
        fighterId: FIGHTER_ID,
        purchaseId: expect.stringMatching(/^[a-f0-9]{32}$/),
        providerSessionId: 'provider-session',
        creationFlow: 'original',
      });

      const ledger = await db.prepare(
        'SELECT delta, reason, fighter_id FROM credit_ledger LIMIT 1'
      ).first<{ delta: number; reason: string; fighter_id: string }>();
      expect(ledger).toEqual({
        delta: 0,
        reason: 'arcade_seed_generation',
        fighter_id: FIGHTER_ID,
      });
      const charge = await db.prepare(`
        SELECT tier, creation_flow, credit_cost, free_quota_delta, status, reason, fighter_id
        FROM generation_charges LIMIT 1
      `).first<Record<string, unknown>>();
      expect(charge).toMatchObject({
        tier: 'champion',
        creation_flow: 'original',
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

  it('seals a full Video authorization into charge, provider session, and job request', async () => {
    const { mf, db, env } = await bindings();
    try {
      const response = await startAdminArcadeGeneration(
        generationRequest(false, 'video'),
        env,
        adminAuth,
        FIGHTER_ID,
      );
      expect(response.status).toBe(201);
      const [, , providerParams] = vi.mocked(createProviderSession).mock.calls[0];
      expect(providerParams).toMatchObject({
        tier: 'champion',
        purpose: 'fighter_generation',
        operation: 'fighter_generation',
        creationFlow: 'video',
      });
      const [jobRequest] = vi.mocked(createGenerationJob).mock.calls[0];
      const jobBody = await jobRequest.clone().json() as {
        fighterId: string;
        purchaseId: string;
        providerSessionId: string;
        creationFlow: string;
      };
      expect(jobBody).toEqual({
        fighterId: FIGHTER_ID,
        purchaseId: expect.stringMatching(/^[a-f0-9]{32}$/),
        providerSessionId: 'provider-session',
        creationFlow: 'video',
      });
      expect(await db.prepare(`
        SELECT tier, creation_flow, credit_cost, free_quota_delta, status, reason
        FROM generation_charges WHERE id = ?
      `).bind(jobBody.purchaseId).first()).toEqual({
        tier: 'champion',
        creation_flow: 'video',
        credit_cost: 0,
        free_quota_delta: 0,
        status: 'reserved',
        reason: 'arcade_seed_generation',
      });
      expect(await db.prepare(`
        SELECT COALESCE(SUM(delta), 0) AS delta FROM credit_ledger
      `).first()).toEqual({ delta: 0 });
    } finally {
      await mf.dispose();
    }
  });

  it('accepts only the exact six current reviewed source identities before authorization', async () => {
    const { mf, db, bucket, env } = await bindings();
    try {
      const staged = await stageReviewedCanonicalSources(db, bucket);
      const response = await startAdminArcadeGeneration(
        reviewedGenerationRequest(staged.hashes),
        env,
        adminAuth,
        FIGHTER_ID,
      );

      expect(response.status).toBe(201);
      expect(createProviderSession).toHaveBeenCalledOnce();
      expect(createGenerationJob).toHaveBeenCalledOnce();
      const options = vi.mocked(createGenerationJob).mock.calls[0][3];
      expect(options?.reviewedCanonicalSources).toEqual({
        schemaVersion: 1,
        mode: REVIEWED_CANONICAL_SOURCE_MODE,
        fighterId: FIGHTER_ID,
        ownerUserId: USER_ID,
        sources: {
          side: {
            processed: {
              versionId: staged.rows[0].versionId,
              blobKey: staged.rows[0].blobKey,
              contentSha256: staged.rows[0].hash,
            },
            raw: {
              versionId: staged.rows[1].versionId,
              blobKey: staged.rows[1].blobKey,
              contentSha256: staged.rows[1].hash,
            },
          },
          upright: {
            processed: {
              versionId: staged.rows[2].versionId,
              blobKey: staged.rows[2].blobKey,
              contentSha256: staged.rows[2].hash,
            },
            raw: {
              versionId: staged.rows[3].versionId,
              blobKey: staged.rows[3].blobKey,
              contentSha256: staged.rows[3].hash,
            },
          },
          crouch: {
            processed: {
              versionId: staged.rows[4].versionId,
              blobKey: staged.rows[4].blobKey,
              contentSha256: staged.rows[4].hash,
            },
            raw: {
              versionId: staged.rows[5].versionId,
              blobKey: staged.rows[5].blobKey,
              contentSha256: staged.rows[5].hash,
            },
          },
        },
      });
    } finally {
      await mf.dispose();
    }
  });

  it('starts the first reviewed Video root over an already complete Original inventory', async () => {
    const { mf, db, bucket, env } = await bindings();
    try {
      await stageCompleteChampionInventory(db, bucket, true);
      const staged = await stageReviewedCanonicalSources(db, bucket);

      const response = await startAdminArcadeGeneration(
        reviewedGenerationRequest(staged.hashes), env, adminAuth, FIGHTER_ID,
      );

      expect(response.status).toBe(201);
      expect(createProviderSession).toHaveBeenCalledOnce();
      expect(createGenerationJob).toHaveBeenCalledOnce();
      expect(await db.prepare(`
        SELECT creation_flow, credit_cost, continuation_run_id, resumed_from_job_id
        FROM generation_charges WHERE status = 'reserved'
      `).first()).toEqual({
        creation_flow: 'video',
        credit_cost: 0,
        continuation_run_id: null,
        resumed_from_job_id: null,
      });
    } finally {
      await mf.dispose();
    }
  });

  it('restarts a reviewed terminal Video run as one fresh zero-credit sealed root', async () => {
    const { mf, db, bucket, env } = await bindings();
    const terminalJobId = '91919191919191919191919191919191';
    try {
      const staged = await stageReviewedCanonicalSources(db, bucket);
      await db.batch([
        db.prepare(`
          INSERT INTO generation_artifact_runs (
            id, user_id, fighter_id, tier, creation_flow, operation, status
          ) VALUES (?, ?, ?, 'champion', 'video', 'fighter_generation', 'failed')
        `).bind(terminalJobId, USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, user_id, fighter_id, artifact_run_id, tier, creation_flow, operation,
            status, review_status, stage, progress_current, progress_total
          ) VALUES (?, ?, ?, ?, 'champion', 'video', 'fighter_generation',
            'succeeded', 'rejected', 'review:rejected', 4, 14)
        `).bind(terminalJobId, USER_ID, FIGHTER_ID, terminalJobId),
      ]);

      const unbound = await startAdminArcadeGeneration(
        reviewedGenerationRequest(staged.hashes, true), env, adminAuth, FIGHTER_ID,
      );
      expect(unbound.status).toBe(400);
      expect(createProviderSession).not.toHaveBeenCalled();
      expect(createGenerationJob).not.toHaveBeenCalled();

      const response = await startAdminArcadeGeneration(
        reviewedGenerationRequest(staged.hashes, true, terminalJobId), env, adminAuth, FIGHTER_ID,
      );

      expect(response.status).toBe(201);
      expect(createProviderSession).toHaveBeenCalledOnce();
      expect(constrainProviderSessionToArtifactRunRemaining).not.toHaveBeenCalled();
      expect(createGenerationJob).toHaveBeenCalledOnce();
      const [jobRequest, , , options] = vi.mocked(createGenerationJob).mock.calls[0];
      expect(await jobRequest.clone().json()).toMatchObject({
        fighterId: FIGHTER_ID,
        creationFlow: 'video',
      });
      expect(options?.reviewedCanonicalSources).toMatchObject({
        schemaVersion: 1,
        mode: REVIEWED_CANONICAL_SOURCE_MODE,
        fighterId: FIGHTER_ID,
        ownerUserId: USER_ID,
      });
      expect(await db.prepare(`
        SELECT creation_flow, credit_cost, continuation_run_id, resumed_from_job_id
        FROM generation_charges WHERE status = 'reserved'
      `).first()).toEqual({
        creation_flow: 'video',
        credit_cost: 0,
        continuation_run_id: null,
        resumed_from_job_id: null,
      });
      expect(await db.prepare(`SELECT COALESCE(SUM(delta), 0) AS delta FROM credit_ledger`)
        .first()).toEqual({ delta: 0 });
    } finally {
      await mf.dispose();
    }
  });

  it('accepts explicit restart-full for the terminal unsealed zero-checkpoint Video shape', async () => {
    const { mf, db, bucket, env } = await bindings();
    try {
      const staged = await stageReviewedCanonicalSources(db, bucket);
      await stageTerminalUnsealedVideoPartial(db);

      const response = await startAdminArcadeGeneration(
        reviewedGenerationRequest(staged.hashes, true, UNSEALED_VIDEO_JOB_ID),
        env,
        adminAuth,
        FIGHTER_ID,
      );

      expect(response.status).toBe(201);
      expect(createProviderSession).toHaveBeenCalledOnce();
      expect(constrainProviderSessionToArtifactRunRemaining).not.toHaveBeenCalled();
      expect(createGenerationJob).toHaveBeenCalledOnce();
      const [, , , options] = vi.mocked(createGenerationJob).mock.calls[0];
      expect(options).toMatchObject({
        unsealedVideoRestartFromJobId: UNSEALED_VIDEO_JOB_ID,
        reviewedCanonicalSources: {
          mode: REVIEWED_CANONICAL_SOURCE_MODE,
          fighterId: FIGHTER_ID,
          ownerUserId: USER_ID,
        },
      });
      expect(await db.prepare(`
        SELECT status, failure_stage FROM generation_artifact_runs WHERE id = ?
      `).bind(UNSEALED_VIDEO_JOB_ID).first()).toEqual({
        status: 'partial',
        failure_stage: 'source:side',
      });
      expect(await db.prepare(`
        SELECT COUNT(*) AS count FROM generation_charges WHERE status = 'reserved'
      `).first()).toEqual({ count: 1 });
    } finally {
      await mf.dispose();
    }
  });

  it.each([
    'different latest Video job',
    'active fighter job',
    'another live Video run',
    'continuation child',
    'artifact checkpoint',
    'video candidate',
    'provider request pending',
    'provider request uncertain',
    'unexpected provider request status',
    'active old provider session',
    'extra provider session',
    'missing committed provider cost',
    'missing all provider evidence',
    'ambiguous committed provider cost',
    'unexpected upstream outcome',
    'unexpected stage outcome',
    'unexpected job outcome',
    'inconsistent succeeded job outcome',
    'mismatched provider outcome',
    'mismatched request outcome',
    'provider accounting mismatch',
    'provider call accounting mismatch',
    'provider correlation mismatch',
    'reserved continuation charge',
    'sealed reviewed manifest',
    'malformed source manifest',
  ])('rejects unsealed restart-full before authorization when there is %s', async (failure) => {
    const { mf, db, bucket, env } = await bindings();
    try {
      const staged = await stageReviewedCanonicalSources(db, bucket);
      await stageTerminalUnsealedVideoPartial(db);
      if (failure === 'different latest Video job') {
        await db.prepare(`
          INSERT INTO generation_jobs (
            id, user_id, fighter_id, tier, creation_flow, operation,
            status, review_status, stage, progress_current, progress_total
          ) VALUES ('82828282828282828282828282828282', ?, ?, 'champion', 'video',
            'fighter_generation', 'failed', 'none', 'video:provider', 0, 14)
        `).bind(USER_ID, FIGHTER_ID).run();
      }
      if (failure === 'active fighter job') {
        await db.prepare(`
          INSERT INTO generation_jobs (
            id, user_id, fighter_id, tier, creation_flow, operation,
            status, review_status, stage, progress_current, progress_total
          ) VALUES ('89898989898989898989898989898989', ?, ?, 'champion', 'original',
            'fighter_generation', 'queued', 'none', 'queued', 0, 14)
        `).bind(USER_ID, FIGHTER_ID).run();
      }
      if (failure === 'another live Video run') {
        await db.prepare(`
          INSERT INTO generation_artifact_runs (
            id, user_id, fighter_id, tier, creation_flow, operation,
            root_job_id, source_manifest_json, status
          ) VALUES ('90909090909090909090909090909090', ?, ?, 'champion', 'video',
            'fighter_generation', '90909090909090909090909090909090', '{}', 'partial')
        `).bind(USER_ID, FIGHTER_ID).run();
      }
      if (failure === 'continuation child') {
        await db.prepare(`
          INSERT INTO generation_jobs (
            id, user_id, fighter_id, tier, creation_flow, operation,
            resumed_from_job_id, status, review_status, stage,
            progress_current, progress_total
          ) VALUES ('83838383838383838383838383838383', ?, ?, 'champion', 'video',
            'fighter_generation', ?, 'failed', 'none', 'video:compile', 0, 14)
        `).bind(USER_ID, FIGHTER_ID, UNSEALED_VIDEO_JOB_ID).run();
      }
      if (failure === 'artifact checkpoint') {
        await db.prepare(`
          INSERT INTO generation_artifact_checkpoints (
            run_id, artifact_kind, artifact_name, stage_index, status
          ) VALUES (?, 'source', 'side', 1, 'approved')
        `).bind(UNSEALED_VIDEO_JOB_ID).run();
      }
      if (failure === 'video candidate') {
        await db.prepare(`
          INSERT INTO video_sprite_candidates (
            id, run_id, job_id, user_id, fighter_id, action, sequence_order, status
          ) VALUES ('unsealed-video-candidate', ?, ?, ?, ?, 'idle', 0, 'rejected')
        `).bind(UNSEALED_VIDEO_JOB_ID, UNSEALED_VIDEO_JOB_ID, USER_ID, FIGHTER_ID).run();
      }
      if (failure === 'provider request pending') {
        await db.prepare(`UPDATE provider_request_cache SET status = 'pending' WHERE id = 'unsealed-video-request'`).run();
      }
      if (failure === 'provider request uncertain') {
        await db.prepare(`UPDATE provider_request_cache SET status = 'uncertain' WHERE id = 'unsealed-video-request'`).run();
      }
      if (failure === 'unexpected provider request status') {
        await db.prepare(`UPDATE provider_request_cache SET status = 'garbage' WHERE id = 'unsealed-video-request'`).run();
      }
      if (failure === 'active old provider session') {
        await db.prepare(`UPDATE provider_sessions SET status = 'active' WHERE id = 'unsealed-video-session'`).run();
      }
      if (failure === 'extra provider session') {
        await db.prepare(`
          INSERT INTO provider_sessions (
            id, user_id, charge_id, creation_flow, status, expires_at
          ) VALUES ('extra-unsealed-video-session', ?, ?, 'video', 'active',
            datetime('now', '+1 hour'))
        `).bind(USER_ID, UNSEALED_VIDEO_JOB_ID).run();
      }
      if (failure === 'ambiguous committed provider cost') {
        await db.prepare(`
          UPDATE provider_cost_events
          SET upstream_outcome = 'unknown'
          WHERE id = 'unsealed-video-cost'
        `).run();
      }
      if (failure === 'unexpected upstream outcome') {
        await db.prepare(`
          UPDATE provider_cost_events
          SET upstream_outcome = 'garbage'
          WHERE id = 'unsealed-video-cost'
        `).run();
      }
      if (failure === 'unexpected stage outcome') {
        await db.prepare(`
          UPDATE provider_cost_events
          SET stage_outcome = 'garbage'
          WHERE id = 'unsealed-video-cost'
        `).run();
      }
      if (failure === 'unexpected job outcome') {
        await db.prepare(`
          UPDATE provider_cost_events
          SET job_outcome = 'garbage'
          WHERE id = 'unsealed-video-cost'
        `).run();
      }
      if (failure === 'inconsistent succeeded job outcome') {
        await db.prepare(`
          UPDATE provider_cost_events
          SET job_outcome = 'succeeded'
          WHERE id = 'unsealed-video-cost'
        `).run();
      }
      if (failure === 'mismatched provider outcome') {
        await db.prepare(`
          UPDATE provider_cost_events
          SET outcome = 'failed'
          WHERE id = 'unsealed-video-cost'
        `).run();
      }
      if (failure === 'mismatched request outcome') {
        await db.prepare(`
          UPDATE provider_request_cache
          SET status = 'failed'
          WHERE id = 'unsealed-video-request'
        `).run();
      }
      if (failure === 'missing committed provider cost') {
        await db.prepare(`DELETE FROM provider_cost_events WHERE id = 'unsealed-video-cost'`).run();
      }
      if (failure === 'missing all provider evidence') {
        await db.batch([
          db.prepare(`DELETE FROM provider_cost_events WHERE id = 'unsealed-video-cost'`),
          db.prepare(`DELETE FROM provider_request_cache WHERE id = 'unsealed-video-request'`),
          db.prepare(`
            UPDATE provider_sessions
            SET provider_calls_used = 0, provider_cost_used_cents = 0
            WHERE id = 'unsealed-video-session'
          `),
        ]);
      }
      if (failure === 'provider accounting mismatch') {
        await db.prepare(`
          UPDATE provider_sessions
          SET provider_cost_used_cents = 16
          WHERE id = 'unsealed-video-session'
        `).run();
      }
      if (failure === 'provider call accounting mismatch') {
        await db.prepare(`
          UPDATE provider_sessions
          SET provider_calls_used = 2
          WHERE id = 'unsealed-video-session'
        `).run();
      }
      if (failure === 'provider correlation mismatch') {
        await db.prepare(`
          UPDATE provider_cost_events
          SET charge_id = NULL
          WHERE id = 'unsealed-video-cost'
        `).run();
      }
      if (failure === 'reserved continuation charge') {
        await db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, creation_flow, credit_cost, free_quota_delta,
            status, reason, fighter_id, ledger_id, continuation_run_id, expires_at
          ) VALUES ('84848484848484848484848484848484', ?, 'champion', 'video', 0, 0,
            'reserved', 'arcade_seed_generation', ?, 'unsealed-video-ledger', ?,
            datetime('now', '+1 hour'))
        `).bind(USER_ID, FIGHTER_ID, UNSEALED_VIDEO_JOB_ID).run();
      }
      if (failure === 'sealed reviewed manifest') {
        await db.prepare(`
          UPDATE generation_artifact_runs
          SET source_manifest_json = '{"reviewedCanonicalSources":{"mode":"reviewed-current-v1"}}'
          WHERE id = ?
        `).bind(UNSEALED_VIDEO_JOB_ID).run();
      }
      if (failure === 'malformed source manifest') {
        await db.prepare(`
          UPDATE generation_artifact_runs
          SET source_manifest_json = '{'
          WHERE id = ?
        `).bind(UNSEALED_VIDEO_JOB_ID).run();
      }
      const before = await db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM generation_charges) AS charges,
          (SELECT COUNT(*) FROM credit_ledger) AS ledger_entries,
          (SELECT COUNT(*) FROM provider_sessions) AS provider_sessions
      `).first();

      const response = await startAdminArcadeGeneration(
        reviewedGenerationRequest(staged.hashes, true, UNSEALED_VIDEO_JOB_ID),
        env,
        adminAuth,
        FIGHTER_ID,
      );

      expect(response.status).toBe(409);
      expect(createProviderSession).not.toHaveBeenCalled();
      expect(createGenerationJob).not.toHaveBeenCalled();
      expect(await db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM generation_charges) AS charges,
          (SELECT COUNT(*) FROM credit_ledger) AS ledger_entries,
          (SELECT COUNT(*) FROM provider_sessions) AS provider_sessions
      `).first()).toEqual(before);
      expect(await db.prepare(`
        SELECT status, failure_stage FROM generation_artifact_runs WHERE id = ?
      `).bind(UNSEALED_VIDEO_JOB_ID).first()).toEqual({
        status: 'partial',
        failure_stage: 'source:side',
      });
    } finally {
      await mf.dispose();
    }
  });

  it('fails closed when preserved work appears between the two unsealed restart seals', async () => {
    const { mf, db, bucket, env } = await bindings();
    try {
      const staged = await stageReviewedCanonicalSources(db, bucket);
      await stageTerminalUnsealedVideoPartial(db);
      const originalBucket = env.SPRITES;
      let interleaved = false;
      env.SPRITES = new Proxy(originalBucket, {
        get(target, property, receiver) {
          if (property === 'get') {
            return async (...args: Parameters<R2Bucket['get']>) => {
              if (!interleaved) {
                interleaved = true;
                await db.prepare(`
                  INSERT INTO generation_artifact_checkpoints (
                    run_id, artifact_kind, artifact_name, stage_index, status
                  ) VALUES (?, 'source', 'side', 1, 'approved')
                `).bind(UNSEALED_VIDEO_JOB_ID).run();
              }
              return originalBucket.get(...args);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      const response = await startAdminArcadeGeneration(
        reviewedGenerationRequest(staged.hashes, true, UNSEALED_VIDEO_JOB_ID),
        env,
        adminAuth,
        FIGHTER_ID,
      );

      expect(interleaved).toBe(true);
      expect(response.status).toBe(409);
      expect(createProviderSession).not.toHaveBeenCalled();
      expect(createGenerationJob).not.toHaveBeenCalled();
      expect(await db.prepare(`SELECT COUNT(*) AS count FROM generation_charges`).first())
        .toEqual({ count: 1 });
      expect(await db.prepare(`SELECT status FROM generation_artifact_runs WHERE id = ?`)
        .bind(UNSEALED_VIDEO_JOB_ID).first()).toEqual({ status: 'partial' });
    } finally {
      await mf.dispose();
    }
  });

  it('rejects a reviewed recovery when a newer UI job appears between its two seals', async () => {
    const { mf, db, bucket, env } = await bindings();
    const recoveryJobId = '92929292929292929292929292929292';
    const newerJobId = '93939393939393939393939393939393';
    try {
      const staged = await stageReviewedCanonicalSources(db, bucket);
      await db.batch([
        db.prepare(`
          INSERT INTO generation_artifact_runs (
            id, user_id, fighter_id, tier, creation_flow, operation, status
          ) VALUES (?, ?, ?, 'champion', 'video', 'fighter_generation', 'failed')
        `).bind(recoveryJobId, USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, user_id, fighter_id, artifact_run_id, tier, creation_flow, operation,
            status, review_status, stage, progress_current, progress_total
          ) VALUES (?, ?, ?, ?, 'champion', 'video', 'fighter_generation',
            'succeeded', 'rejected', 'review:rejected', 4, 14)
        `).bind(recoveryJobId, USER_ID, FIGHTER_ID, recoveryJobId),
      ]);
      const originalBucket = env.SPRITES;
      let interleaved = false;
      env.SPRITES = new Proxy(originalBucket, {
        get(target, property, receiver) {
          if (property === 'get') {
            return async (...args: Parameters<R2Bucket['get']>) => {
              if (!interleaved) {
                interleaved = true;
                await db.batch([
                  db.prepare(`
                    INSERT INTO generation_artifact_runs (
                      id, user_id, fighter_id, tier, creation_flow, operation, status
                    ) VALUES (?, ?, ?, 'champion', 'video', 'fighter_generation', 'failed')
                  `).bind(newerJobId, USER_ID, FIGHTER_ID),
                  db.prepare(`
                    INSERT INTO generation_jobs (
                      id, user_id, fighter_id, artifact_run_id, tier, creation_flow, operation,
                      status, review_status, stage, progress_current, progress_total
                    ) VALUES (?, ?, ?, ?, 'champion', 'video', 'fighter_generation',
                      'failed', 'none', 'video:provider', 4, 14)
                  `).bind(newerJobId, USER_ID, FIGHTER_ID, newerJobId),
                ]);
              }
              return originalBucket.get(...args);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      const response = await startAdminArcadeGeneration(
        reviewedGenerationRequest(staged.hashes, true, recoveryJobId),
        env,
        adminAuth,
        FIGHTER_ID,
      );

      expect(interleaved).toBe(true);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'reviewed_video_recovery_source_changed',
        latestJobId: newerJobId,
      });
      expect(createProviderSession).not.toHaveBeenCalled();
      expect(createGenerationJob).not.toHaveBeenCalled();
      expect(await db.prepare('SELECT COUNT(*) AS count FROM generation_charges').first())
        .toEqual({ count: 0 });
      expect(await db.prepare('SELECT COUNT(*) AS count FROM credit_ledger').first())
        .toEqual({ count: 0 });
    } finally {
      await mf.dispose();
    }
  });

  it('requires the exact deployed Worker SHA before a reviewed production Video mutation', async () => {
    const { mf, db, bucket, env } = await bindings();
    const expectedSha = 'a'.repeat(40);
    try {
      const staged = await stageReviewedCanonicalSources(db, bucket);
      env.ENVIRONMENT = 'production';
      env.WORKER_VERSION_METADATA = {
        id: 'worker-version', tag: `prod-${expectedSha}-3`, timestamp: '2026-08-27T00:00:00Z',
      };
      const missing = await startAdminArcadeGeneration(
        reviewedGenerationRequest(staged.hashes), env, adminAuth, FIGHTER_ID,
      );
      expect(missing.status).toBe(428);
      const staleRequest = reviewedGenerationRequest(staged.hashes);
      staleRequest.headers.set('X-Insert-Player-Expected-Worker-Sha', 'b'.repeat(40));
      const stale = await startAdminArcadeGeneration(
        staleRequest, env, adminAuth, FIGHTER_ID,
      );
      expect(stale.status).toBe(409);
      expect(createProviderSession).not.toHaveBeenCalled();
      expect(createGenerationJob).not.toHaveBeenCalled();
      expect(await db.prepare('SELECT COUNT(*) AS count FROM generation_charges').first())
        .toEqual({ count: 0 });
    } finally {
      await mf.dispose();
    }
  });

  it.each([
    'missing hashes',
    'tampered requested hash',
    'cross-fighter version',
    'stale current key',
    'database hash mismatch',
    'R2 byte mismatch',
    'R2 object missing',
  ])('rejects reviewed sources fail-closed before job or charge: %s', async (failure) => {
    const { mf, db, bucket, env } = await bindings();
    try {
      const staged = await stageReviewedCanonicalSources(db, bucket);
      let request: Request;
      if (failure === 'missing hashes') {
        request = generationRequest(false, 'video', {
          canonicalSourceMode: REVIEWED_CANONICAL_SOURCE_MODE,
        });
      } else {
        const hashes = structuredClone(staged.hashes);
        if (failure === 'tampered requested hash') hashes.side.processedSha256 = 'f'.repeat(64);
        if (failure === 'cross-fighter version') {
          await db.prepare("UPDATE source_versions SET fighter_id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' WHERE kind = 'side'").run();
        }
        if (failure === 'stale current key') {
          await db.prepare("UPDATE fighters SET side_view_blob_key = 'users/stale/current.png' WHERE id = ?")
            .bind(FIGHTER_ID).run();
        }
        if (failure === 'database hash mismatch') {
          await db.prepare("UPDATE source_versions SET content_hash = ? WHERE kind = 'side'")
            .bind('e'.repeat(64)).run();
        }
        if (failure === 'R2 byte mismatch') {
          await bucket.put(staged.rows[0].blobKey, new Uint8Array([9, 9, 9]));
        }
        if (failure === 'R2 object missing') await bucket.delete(staged.rows[0].blobKey);
        request = reviewedGenerationRequest(hashes);
      }

      const response = await startAdminArcadeGeneration(request, env, adminAuth, FIGHTER_ID);
      expect([400, 409]).toContain(response.status);
      expect(createProviderSession).not.toHaveBeenCalled();
      expect(createGenerationJob).not.toHaveBeenCalled();
      expect(await db.prepare('SELECT COUNT(*) AS count FROM generation_charges').first())
        .toEqual({ count: 0 });
      expect(await db.prepare('SELECT COUNT(*) AS count FROM credit_ledger').first())
        .toEqual({ count: 0 });
    } finally {
      await mf.dispose();
    }
  });

  it('blocks an active Original job from being replayed as Video', async () => {
    const { mf, db, env } = await bindings();
    try {
      await db.prepare(`
        INSERT INTO generation_jobs (
          id, user_id, fighter_id, tier, creation_flow, operation,
          status, stage, progress_current, progress_total
        ) VALUES (
          'active-original-job', ?, ?, 'champion', 'original', 'fighter_generation',
          'running', 'source:side', 1, 14
        )
      `).bind(USER_ID, FIGHTER_ID).run();

      const response = await startAdminArcadeGeneration(
        generationRequest(false, 'video'),
        env,
        adminAuth,
        FIGHTER_ID,
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'Another creation flow is already active for this fighter',
        jobId: 'active-original-job',
      });
      expect(createProviderSession).not.toHaveBeenCalled();
      expect(createGenerationJob).not.toHaveBeenCalled();
      expect(await db.prepare('SELECT COUNT(*) AS count FROM generation_charges')
        .first()).toEqual({ count: 0 });
    } finally {
      await mf.dispose();
    }
  });

  it('never continues or reuses an Original run authorization for Video', async () => {
    const { mf, db, env } = await bindings();
    const originalRunId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES ('original-partial-ledger', ?, 0, 'arcade_seed_generation', ?)
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, creation_flow, credit_cost, free_quota_delta,
            status, reason, fighter_id, ledger_id, expires_at
          ) VALUES (
            'original-partial-charge', ?, 'champion', 'original', 0, 0,
            'committed', 'arcade_seed_generation', ?, 'original-partial-ledger',
            datetime('now', '+1 hour')
          )
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_artifact_runs (
            id, user_id, fighter_id, tier, creation_flow, operation, status
          ) VALUES (?, ?, ?, 'champion', 'original', 'fighter_generation', 'partial')
        `).bind(originalRunId, USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, charge_id, user_id, fighter_id, artifact_run_id, tier,
            creation_flow, operation, status, stage, progress_current, progress_total
          ) VALUES (
            ?, 'original-partial-charge', ?, ?, ?, 'champion', 'original',
            'fighter_generation', 'failed', 'sprite:idle', 3, 14
          )
        `).bind(originalRunId, USER_ID, FIGHTER_ID, originalRunId),
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES ('original-reusable-ledger', ?, 0, 'arcade_seed_generation', ?)
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, creation_flow, credit_cost, free_quota_delta,
            status, reason, fighter_id, ledger_id, expires_at
          ) VALUES (
            'original-reusable-charge', ?, 'champion', 'original', 0, 0,
            'reserved', 'arcade_seed_generation', ?, 'original-reusable-ledger',
            datetime('now', '+1 hour')
          )
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO provider_sessions (
            id, user_id, charge_id, creation_flow, status, expires_at
          ) VALUES (
            'original-reusable-session', ?, 'original-reusable-charge',
            'original', 'active', datetime('now', '+1 hour')
          )
        `).bind(USER_ID),
      ]);

      const response = await startAdminArcadeGeneration(
        generationRequest(false, 'video'),
        env,
        adminAuth,
        FIGHTER_ID,
      );

      expect(response.status).toBe(201);
      expect(constrainProviderSessionToArtifactRunRemaining).not.toHaveBeenCalled();
      expect(createProviderSession).toHaveBeenCalledOnce();
      expect(vi.mocked(createProviderSession).mock.calls[0][2]).toMatchObject({
        creationFlow: 'video',
      });
      const [jobRequest] = vi.mocked(createGenerationJob).mock.calls[0];
      const jobBody = await jobRequest.clone().json() as {
        purchaseId: string;
        providerSessionId: string;
        creationFlow: string;
      };
      expect(jobBody).toMatchObject({
        providerSessionId: 'provider-session',
        creationFlow: 'video',
      });
      expect(jobBody.purchaseId).not.toBe('original-reusable-charge');
      expect(await db.prepare(`
        SELECT creation_flow, continuation_run_id, resumed_from_job_id
        FROM generation_charges WHERE id = ?
      `).bind(jobBody.purchaseId).first()).toEqual({
        creation_flow: 'video',
        continuation_run_id: null,
        resumed_from_job_id: null,
      });
      expect((await db.prepare(`
        SELECT status FROM generation_charges WHERE id = 'original-reusable-charge'
      `).first<{ status: string }>())?.status).toBe('reserved');
    } finally {
      await mf.dispose();
    }
  });

  it('creates a sealed zero-credit continuation from an approved Video leaf', async () => {
    const { mf, db, env } = await bindings();
    const approvedJobId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES ('approved-video-ledger', ?, 0, 'arcade_seed_generation', ?)
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, creation_flow, credit_cost, free_quota_delta,
            status, reason, fighter_id, ledger_id, expires_at
          ) VALUES (
            'approved-video-charge', ?, 'champion', 'video', 0, 0,
            'committed', 'arcade_seed_generation', ?, 'approved-video-ledger',
            datetime('now', '+1 hour')
          )
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_artifact_runs (
            id, user_id, fighter_id, tier, creation_flow, operation, status
          ) VALUES (?, ?, ?, 'champion', 'video', 'fighter_generation', 'partial')
        `).bind(approvedJobId, USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, charge_id, user_id, fighter_id, artifact_run_id, tier,
            creation_flow, operation, status, review_status, stage,
            progress_current, progress_total
          ) VALUES (
            ?, 'approved-video-charge', ?, ?, ?, 'champion', 'video',
            'fighter_generation', 'succeeded', 'approved', 'review:approved', 1, 14
          )
        `).bind(approvedJobId, USER_ID, FIGHTER_ID, approvedJobId),
        db.prepare(`
          INSERT INTO video_sprite_candidates (
            id, run_id, job_id, user_id, fighter_id, action, sequence_order,
            status, current_revision, approved_revision
          ) VALUES (
            'approved-video-candidate', ?, ?, ?, ?, 'idle', 0, 'approved', 1, 1
          )
        `).bind(approvedJobId, approvedJobId, USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO video_sprite_candidate_revisions (
            candidate_id, revision, report_sha256
          ) VALUES ('approved-video-candidate', 1, ?)
        `).bind('a'.repeat(64)),
      ]);

      const response = await startAdminArcadeGeneration(
        generationRequest(false, 'video'),
        env,
        adminAuth,
        FIGHTER_ID,
      );

      expect(response.status).toBe(201);
      expect(createProviderSession).toHaveBeenCalledOnce();
      expect(vi.mocked(createProviderSession).mock.calls[0][2]).toMatchObject({
        tier: 'champion',
        purpose: 'fighter_generation',
        operation: 'fighter_generation',
        creationFlow: 'video',
      });
      expect(constrainProviderSessionToArtifactRunRemaining).toHaveBeenCalledOnce();
      expect(vi.mocked(constrainProviderSessionToArtifactRunRemaining).mock.calls[0][3])
        .toBe(approvedJobId);
      const [jobRequest] = vi.mocked(createGenerationJob).mock.calls[0];
      expect(await jobRequest.clone().json()).toMatchObject({
        fighterId: FIGHTER_ID,
        providerSessionId: 'provider-session',
        creationFlow: 'video',
      });
      expect(await db.prepare(`
        SELECT tier, creation_flow, credit_cost, free_quota_delta, status,
          reason, continuation_run_id, resumed_from_job_id
        FROM generation_charges
        WHERE continuation_run_id = ? AND status = 'reserved'
      `).bind(approvedJobId).first()).toEqual({
        tier: 'champion',
        creation_flow: 'video',
        credit_cost: 0,
        free_quota_delta: 0,
        status: 'reserved',
        reason: 'arcade_seed_generation',
        continuation_run_id: approvedJobId,
        resumed_from_job_id: approvedJobId,
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

  it('returns ready for a completed Video roster with no partial run', async () => {
    const { mf, db, bucket, env } = await bindings();
    try {
      await stageCompleteChampionInventory(db, bucket, true);
      const response = await startAdminArcadeGeneration(
        generationRequest(false, 'video'),
        env,
        adminAuth,
        FIGHTER_ID,
      );
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
      env.GEMINI_TRANSPORT = 'meterkey';
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
        providerCostLimitCentsCap: 34,
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

  it('caps an official side probe at one paid provider request', async () => {
    const { mf, db, env } = await bindings();
    try {
      env.GEMINI_TRANSPORT = 'meterkey';
      const response = await startAdminArcadeSourceGeneration(
        sourceRequest('side', true, false, true), env, adminAuth, FIGHTER_ID, 'side',
      );

      expect(response.status).toBe(201);
      expect(constrainProviderSessionToArtifactRunRemaining).not.toHaveBeenCalled();
      const [, , providerParams] = vi.mocked(createProviderSession).mock.calls[0];
      expect(providerParams).toMatchObject({
        providerCallLimitCap: 1,
        providerCostLimitCentsCap: 17,
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

  it('rejects an invalid or mixed probe before reserving provider spend', async () => {
    const { mf, db, env } = await bindings();
    try {
      const responses = await Promise.all([
        startAdminArcadeSourceGeneration(
          sourceRequest('side', false, false, true), env, adminAuth, FIGHTER_ID, 'side',
        ),
        startAdminArcadeSourceGeneration(
          sourceRequest('upright', true, false, true), env, adminAuth, FIGHTER_ID, 'upright',
        ),
        startAdminArcadeSourceGeneration(
          sourceRequest('side', true, true, true), env, adminAuth, FIGHTER_ID, 'side',
        ),
      ]);
      expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
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
