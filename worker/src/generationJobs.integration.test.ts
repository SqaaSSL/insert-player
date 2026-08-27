import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import { startAdminArcadeGeneration } from './arcadeGeneration';
import { createGenerationJob, getGenerationJob, listGenerationJobs } from './generationJobs';
import { GEMINI_PRO_IMAGE_MODEL, recordProviderDailyQuota } from './providerCapacity';
import type { AuthContext, Env } from './types';
import type { SealedReviewedCanonicalSources } from './reviewedCanonicalSources';

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
const VIDEO_ACTIONS = [
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
] as const;
const LEGAL = {
  legalVersion: '2026-08-23.1',
  ageConfirmed: true,
  termsAccepted: true,
  photoRightsConfirmed: true,
  aiProcessingConfirmed: true,
  immediatePerformanceConfirmed: true,
  withdrawalLossAcknowledged: true,
};

function sealedReviewedSources(): SealedReviewedCanonicalSources {
  return {
    schemaVersion: 1,
    mode: 'reviewed-current-v1',
    fighterId: FIGHTER_ID,
    ownerUserId: USER_ID,
    sources: {
      side: {
        processed: { versionId: '1'.repeat(32), blobKey: SOURCE_KEYS.side, contentSha256: '1'.repeat(64) },
        raw: { versionId: '2'.repeat(32), blobKey: SOURCE_KEYS.sideRaw, contentSha256: '2'.repeat(64) },
      },
      upright: {
        processed: { versionId: '3'.repeat(32), blobKey: SOURCE_KEYS.upright, contentSha256: '3'.repeat(64) },
        raw: { versionId: '4'.repeat(32), blobKey: SOURCE_KEYS.uprightRaw, contentSha256: '4'.repeat(64) },
      },
      crouch: {
        processed: { versionId: '5'.repeat(32), blobKey: SOURCE_KEYS.crouch, contentSha256: '5'.repeat(64) },
        raw: { versionId: '6'.repeat(32), blobKey: SOURCE_KEYS.crouchRaw, contentSha256: '6'.repeat(64) },
      },
    },
  };
}

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
    creation_flow TEXT NOT NULL DEFAULT 'original',
    credit_cost INTEGER NOT NULL DEFAULT 0,
    free_quota_delta INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    fighter_id TEXT,
    ledger_id TEXT,
    refund_ledger_id TEXT,
    continuation_run_id TEXT,
    resumed_from_job_id TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE provider_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    rate_limit_key TEXT NOT NULL,
    tier TEXT NOT NULL,
    creation_flow TEXT NOT NULL DEFAULT 'original',
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
    creation_flow TEXT NOT NULL DEFAULT 'original',
    operation TEXT NOT NULL,
    target_kind TEXT,
    target_name TEXT,
    artifact_run_id TEXT,
    resumed_from_job_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    review_status TEXT NOT NULL DEFAULT 'none',
    stage TEXT NOT NULL DEFAULT 'queued',
    failure_stage TEXT,
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
  CREATE TABLE arcade_fighters (
    fighter_id TEXT PRIMARY KEY,
    generation_prompt TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
  );
  CREATE TABLE sprites (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL,
    animation_name TEXT NOT NULL,
    quality_tier TEXT NOT NULL,
    blob_key TEXT,
    raw_blob_key TEXT
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
    root_job_id TEXT NOT NULL,
    original_charge_id TEXT,
    original_blob_key TEXT,
    source_manifest_json TEXT,
    generation_prompt TEXT,
    pipeline_version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',
    failure_stage TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE TABLE generation_artifact_checkpoints (
    run_id TEXT NOT NULL,
    artifact_kind TEXT NOT NULL,
    artifact_name TEXT NOT NULL,
    stage_index INTEGER NOT NULL,
    tier TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'approved',
    clean_version_id TEXT NOT NULL,
    raw_version_id TEXT,
    clean_blob_key TEXT NOT NULL,
    raw_blob_key TEXT,
    clean_content_hash TEXT,
    raw_content_hash TEXT,
    frame_w INTEGER,
    frame_h INTEGER,
    frame_count INTEGER,
    processing_version INTEGER,
    metadata_json TEXT,
    completed_by_job_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    verified_at TEXT,
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
    PRIMARY KEY(candidate_id, revision)
  );
  CREATE TABLE provider_capacity_windows (
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    reason TEXT NOT NULL,
    retry_at_epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider, model)
  );
  CREATE TABLE provider_meterkey_capacity_windows (
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    reason TEXT NOT NULL,
    retry_at_epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider, model)
  );
`;

function png(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
}

function request(
  purchaseId = PURCHASE_ID,
  providerSessionId = SESSION_ID,
  target?: { targetKind: 'animation' | 'source'; targetName: string },
  creationFlow?: 'original' | 'video',
): Request {
  return new Request('https://api.insertplayer.ai/api/generation-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fighterId: FIGHTER_ID, purchaseId, providerSessionId, ...target, creationFlow }),
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
      INSERT INTO arcade_fighters (fighter_id, status) VALUES (?, 'draft')
    `).bind(FIGHTER_ID),
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
const adminAuth = {
  userId: USER_ID,
  rateLimitKey: `user:${USER_ID}`,
  claims: {},
  user: { id: USER_ID, plan_tier: 'admin' },
} as unknown as AuthContext;

function adminVideoRequest(): Request {
  return new Request(`https://api.insertplayer.ai/api/admin/arcade/${FIGHTER_ID}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ legal: LEGAL, creationFlow: 'video' }),
  });
}

async function stageCompleteChampionInventory(db: D1Database, env: Env): Promise<void> {
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
    ...VIDEO_ACTIONS.map((action, index) => db.prepare(`
      INSERT INTO sprites (
        id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key
      ) VALUES (?, ?, ?, 'champion', ?, ?)
    `).bind(
      `champion-video-sprite-${index}`,
      FIGHTER_ID,
      action,
      `users/${USER_ID}/fighters/${FIGHTER_ID}/sprites/${action}.png`,
      `users/${USER_ID}/fighters/${FIGHTER_ID}/sprites/${action}-raw.png`,
    )),
  ]);
  await Promise.all([
    ...Object.values(SOURCE_KEYS).map((key) => (
      env.SPRITES.put(key, png(), { httpMetadata: { contentType: 'image/png' } })
    )),
    ...VIDEO_ACTIONS.flatMap((action) => [
      env.SPRITES.put(
        `users/${USER_ID}/fighters/${FIGHTER_ID}/sprites/${action}.png`,
        png(),
        { httpMetadata: { contentType: 'image/png' } },
      ),
      env.SPRITES.put(
        `users/${USER_ID}/fighters/${FIGHTER_ID}/sprites/${action}-raw.png`,
        png(),
        { httpMetadata: { contentType: 'image/png' } },
      ),
    ]),
  ]);
}

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
  it('filters by fighter before the global recent-job limit', async () => {
    const { mf, db, env } = await bindings();
    const targetJobId = 'abababababababababababababababab';
    try {
      const insertJob = (id: string, fighterId: string, index: number) => db.prepare(`
        INSERT INTO generation_jobs (
          id, workflow_instance_id, user_id, fighter_id, charge_id,
          provider_session_id, tier, creation_flow, operation, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'champion', 'video', 'fighter_generation', 'failed')
      `).bind(id, id, USER_ID, fighterId, `list-charge-${index}`, `list-session-${index}`);
      await db.batch([
        insertJob(targetJobId, FIGHTER_ID, 0),
        ...Array.from({ length: 25 }, (_, index) => insertJob(
          (index + 1).toString(16).padStart(32, '0'),
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          index + 1,
        )),
      ]);

      const filtered = await listGenerationJobs(new Request(
        `https://api.insertplayer.ai/api/generation-jobs?fighterId=${FIGHTER_ID}`,
      ), env, auth);
      expect(filtered.status).toBe(200);
      expect(await filtered.json()).toMatchObject({ jobs: [{ id: targetJobId }] });
      const unfiltered = await listGenerationJobs(new Request(
        'https://api.insertplayer.ai/api/generation-jobs',
      ), env, auth);
      const unfilteredBody = await unfiltered.json() as { jobs: Array<{ id: string }> };
      expect(unfilteredBody.jobs).toHaveLength(20);
      expect(unfilteredBody.jobs.some((job) => job.id === targetJobId)).toBe(false);
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('serializes every terminal full video run as requiring a fresh full restart', async () => {
    const { mf, db, env } = await bindings();
    const jobId = '46464646464646464646464646464646';
    try {
      await db.batch([
        db.prepare(`INSERT INTO generation_artifact_runs (
          id, user_id, fighter_id, tier, creation_flow, operation,
          root_job_id, status, failure_stage
        ) VALUES (?, ?, ?, 'champion', 'video', 'fighter_generation', ?,
          'failed', 'video:submit')`).bind(jobId, USER_ID, FIGHTER_ID, jobId),
        db.prepare(`INSERT INTO generation_jobs (
          id, workflow_instance_id, user_id, fighter_id, charge_id,
          provider_session_id, tier, creation_flow, operation, artifact_run_id,
          status, review_status, stage, error_code
        ) VALUES (?, ?, ?, ?, 'terminal-video-charge', 'terminal-video-session',
          'champion', 'video', 'fighter_generation', ?, 'failed', 'none',
          'video:submit', 'video_provider_terminal')`)
          .bind(jobId, jobId, USER_ID, FIGHTER_ID, jobId),
      ]);

      const response = await getGenerationJob(env, auth, jobId);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ job: {
        id: jobId,
        status: 'failed',
        reviewStatus: 'none',
        errorCode: 'video_provider_terminal',
        fullRunRestartRequired: true,
        resumable: false,
      } });
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('creates a fresh video run after a rejected full run was terminally abandoned', async () => {
    const { mf, db, env, workflowStarts } = await bindings();
    const rejectedRunId = '99999999999999999999999999999999';
    try {
      await db.batch([
        db.prepare(`
          UPDATE generation_charges
          SET tier = 'champion', creation_flow = 'video', credit_cost = 18
          WHERE id = ?
        `).bind(PURCHASE_ID),
        db.prepare(`
          UPDATE provider_sessions
          SET tier = 'champion', creation_flow = 'video'
          WHERE id = ?
        `).bind(SESSION_ID),
        db.prepare(`
          INSERT INTO generation_artifact_runs (
            id, user_id, fighter_id, tier, creation_flow, operation,
            root_job_id, status, failure_stage
          ) VALUES (?, ?, ?, 'champion', 'video', 'fighter_generation', ?,
            'failed', 'review:rejected')
        `).bind(rejectedRunId, USER_ID, FIGHTER_ID, rejectedRunId),
      ]);

      const created = await createGenerationJob(request(PURCHASE_ID, SESSION_ID, undefined, 'video'), env, auth);
      expect(created.status).toBe(202);
      expect(workflowStarts).toEqual([PURCHASE_ID]);
      expect(await db.prepare(`
        SELECT id, creation_flow, status FROM generation_artifact_runs
        WHERE id IN (?, ?) ORDER BY id
      `).bind(PURCHASE_ID, rejectedRunId).all()).toMatchObject({ results: [
        { id: PURCHASE_ID, creation_flow: 'video', status: 'active' },
        { id: rejectedRunId, creation_flow: 'video', status: 'failed' },
      ] });
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('persists a zero-credit admin Video authorization through the job and artifact run', async () => {
    const { mf, db, env, workflowStarts } = await bindings();
    try {
      await db.batch([
        db.prepare(`
          UPDATE credit_ledger
          SET delta = 0, reason = 'arcade_seed_generation'
          WHERE id = 'ledger-first'
        `),
        db.prepare(`
          UPDATE generation_charges
          SET tier = 'champion', creation_flow = 'video', credit_cost = 0,
              free_quota_delta = 0, reason = 'arcade_seed_generation'
          WHERE id = ?
        `).bind(PURCHASE_ID),
        db.prepare(`
          UPDATE provider_sessions
          SET tier = 'champion', creation_flow = 'video', purpose = 'fighter_generation'
          WHERE id = ?
        `).bind(SESSION_ID),
      ]);

      const created = await createGenerationJob(
        request(PURCHASE_ID, SESSION_ID, undefined, 'video'),
        env,
        auth,
      );

      expect(created.status).toBe(202);
      expect(await created.json()).toMatchObject({
        job: {
          id: PURCHASE_ID,
          tier: 'champion',
          creationFlow: 'video',
          operation: 'fighter_generation',
        },
      });
      expect(workflowStarts).toEqual([PURCHASE_ID]);
      expect(await db.prepare(`
        SELECT creation_flow, credit_cost, free_quota_delta, reason
        FROM generation_charges WHERE id = ?
      `).bind(PURCHASE_ID).first()).toEqual({
        creation_flow: 'video',
        credit_cost: 0,
        free_quota_delta: 0,
        reason: 'arcade_seed_generation',
      });
      expect(await db.prepare(`
        SELECT creation_flow, purpose FROM provider_sessions WHERE id = ?
      `).bind(SESSION_ID).first()).toEqual({
        creation_flow: 'video',
        purpose: 'fighter_generation',
      });
      expect(await db.prepare(`
        SELECT creation_flow FROM generation_jobs WHERE id = ?
      `).bind(PURCHASE_ID).first()).toEqual({ creation_flow: 'video' });
      expect(await db.prepare(`
        SELECT creation_flow FROM generation_artifact_runs WHERE id = ?
      `).bind(PURCHASE_ID).first()).toEqual({ creation_flow: 'video' });
      expect((await db.prepare(`
        SELECT credits_balance FROM users WHERE id = ?
      `).bind(USER_ID).first<{ credits_balance: number }>())?.credits_balance).toBe(7);
      expect(await db.prepare(`
        SELECT delta, reason FROM credit_ledger WHERE id = 'ledger-first'
      `).first()).toEqual({ delta: 0, reason: 'arcade_seed_generation' });
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('seals reviewed identities without a migration and preserves the exact manifest on continuation', async () => {
    const { mf, db, env } = await bindings();
    const sealed = sealedReviewedSources();
    const continuationPurchaseId = '77777777777777777777777777777777';
    const continuationSessionId = '88888888888888888888888888888888';
    try {
      await db.batch([
        db.prepare("UPDATE credit_ledger SET delta = 0, reason = 'arcade_seed_generation' WHERE id = 'ledger-first'"),
        db.prepare(`
          UPDATE generation_charges
          SET tier = 'champion', creation_flow = 'video', credit_cost = 0,
              free_quota_delta = 0, reason = 'arcade_seed_generation'
          WHERE id = ?
        `).bind(PURCHASE_ID),
        db.prepare(`
          UPDATE provider_sessions
          SET tier = 'champion', creation_flow = 'video', purpose = 'fighter_generation'
          WHERE id = ?
        `).bind(SESSION_ID),
      ]);
      await stageCompleteChampionInventory(db, env);

      const initial = await createGenerationJob(
        request(PURCHASE_ID, SESSION_ID, undefined, 'video'),
        env,
        adminAuth,
        { reviewedCanonicalSources: sealed },
      );
      expect(initial.status).toBe(202);
      const serializedInitial = await getGenerationJob(env, adminAuth, PURCHASE_ID);
      expect(await serializedInitial.json()).toMatchObject({ job: {
        canonicalSourceMode: 'reviewed-current-v1',
        canonicalSourceHashes: {
          side: { processedSha256: '1'.repeat(64), rawSha256: '2'.repeat(64) },
          upright: { processedSha256: '3'.repeat(64), rawSha256: '4'.repeat(64) },
          crouch: { processedSha256: '5'.repeat(64), rawSha256: '6'.repeat(64) },
        },
      } });
      const initialManifest = (await db.prepare(`
        SELECT source_manifest_json FROM generation_artifact_runs WHERE id = ?
      `).bind(PURCHASE_ID).first<{ source_manifest_json: string }>())?.source_manifest_json;
      expect(JSON.parse(initialManifest ?? '{}')).toEqual({
        side: SOURCE_KEYS.side,
        sideRaw: SOURCE_KEYS.sideRaw,
        upright: SOURCE_KEYS.upright,
        uprightRaw: SOURCE_KEYS.uprightRaw,
        crouch: SOURCE_KEYS.crouch,
        crouchRaw: SOURCE_KEYS.crouchRaw,
        reviewedCanonicalSources: sealed,
      });

      await db.batch([
        db.prepare("UPDATE generation_charges SET status = 'committed' WHERE id = ?").bind(PURCHASE_ID),
        db.prepare("UPDATE provider_sessions SET status = 'completed' WHERE id = ?").bind(SESSION_ID),
        db.prepare(`
          UPDATE generation_jobs
          SET status = 'succeeded', review_status = 'approved', stage = 'review:approved'
          WHERE id = ?
        `).bind(PURCHASE_ID),
        db.prepare("UPDATE generation_artifact_runs SET status = 'partial' WHERE id = ?").bind(PURCHASE_ID),
        db.prepare(`
          INSERT INTO video_sprite_candidates (
            id, run_id, job_id, user_id, fighter_id, action, sequence_order,
            status, current_revision, approved_revision
          ) VALUES ('sealed-video-candidate', ?, ?, ?, ?, 'idle', 0, 'approved', 1, 1)
        `).bind(PURCHASE_ID, PURCHASE_ID, USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO video_sprite_candidate_revisions (candidate_id, revision, report_sha256)
          VALUES ('sealed-video-candidate', 1, ?)
        `).bind('a'.repeat(64)),
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES ('sealed-continuation-ledger', ?, 0, 'arcade_seed_generation', ?)
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, creation_flow, credit_cost, free_quota_delta,
            status, reason, fighter_id, ledger_id, continuation_run_id,
            resumed_from_job_id, expires_at
          ) VALUES (?, ?, 'champion', 'video', 0, 0, 'reserved',
            'arcade_seed_generation', ?, 'sealed-continuation-ledger', ?, ?, datetime('now', '+12 hours'))
        `).bind(continuationPurchaseId, USER_ID, FIGHTER_ID, PURCHASE_ID, PURCHASE_ID),
        db.prepare(`
          INSERT INTO provider_sessions (
            id, user_id, rate_limit_key, tier, creation_flow, purpose,
            charge_id, status, expires_at
          ) VALUES (?, ?, ?, 'champion', 'video', 'fighter_generation', ?, 'active', datetime('now', '+12 hours'))
        `).bind(continuationSessionId, USER_ID, `user:${USER_ID}`, continuationPurchaseId),
      ]);

      const continuation = await createGenerationJob(
        request(continuationPurchaseId, continuationSessionId, undefined, 'video'),
        env,
        adminAuth,
        { reviewedCanonicalSources: sealed },
      );
      expect(continuation.status).toBe(202);
      expect((await db.prepare(`
        SELECT source_manifest_json FROM generation_artifact_runs WHERE id = ?
      `).bind(PURCHASE_ID).first<{ source_manifest_json: string }>())?.source_manifest_json)
        .toBe(initialManifest);
    } finally {
      await mf.dispose();
    }
  }, 30_000);

  it('continues an approved Video action through the admin endpoint on the same run', async () => {
    const { mf, db, env, workflowStarts } = await bindings();
    const continuationPurchaseId = '55555555555555555555555555555555';
    const continuationSessionId = '66666666666666666666666666666666';
    try {
      await db.batch([
        db.prepare(`
          UPDATE credit_ledger
          SET delta = 0, reason = 'arcade_seed_generation'
          WHERE id = 'ledger-first'
        `),
        db.prepare(`
          UPDATE generation_charges
          SET tier = 'champion', creation_flow = 'video', credit_cost = 0,
              free_quota_delta = 0, reason = 'arcade_seed_generation'
          WHERE id = ?
        `).bind(PURCHASE_ID),
        db.prepare(`
          UPDATE provider_sessions
          SET tier = 'champion', creation_flow = 'video', purpose = 'fighter_generation'
          WHERE id = ?
        `).bind(SESSION_ID),
      ]);

      const initial = await createGenerationJob(
        request(PURCHASE_ID, SESSION_ID, undefined, 'video'),
        env,
        auth,
      );
      expect(initial.status).toBe(202);
      expect(workflowStarts).toEqual([PURCHASE_ID]);

      await db.batch([
        db.prepare(`
          UPDATE generation_charges
          SET status = 'committed', updated_at = datetime('now')
          WHERE id = ?
        `).bind(PURCHASE_ID),
        db.prepare(`
          UPDATE provider_sessions
          SET status = 'completed', updated_at = datetime('now')
          WHERE id = ?
        `).bind(SESSION_ID),
        db.prepare(`
          UPDATE generation_jobs
          SET status = 'succeeded', review_status = 'approved',
              stage = 'review:approved', progress_current = 1,
              finished_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `).bind(PURCHASE_ID),
        db.prepare(`
          UPDATE generation_artifact_runs
          SET status = 'partial', updated_at = datetime('now')
          WHERE id = ?
        `).bind(PURCHASE_ID),
        db.prepare(`
          INSERT INTO video_sprite_candidates (
            id, run_id, job_id, user_id, fighter_id, action, sequence_order,
            status, current_revision, approved_revision
          ) VALUES (
            'admin-video-candidate-idle', ?, ?, ?, ?, 'idle', 0,
            'approved', 1, 1
          )
        `).bind(PURCHASE_ID, PURCHASE_ID, USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO video_sprite_candidate_revisions (
            candidate_id, revision, report_sha256
          ) VALUES ('admin-video-candidate-idle', 1, ?)
        `).bind('a'.repeat(64)),
        db.prepare(`
          INSERT INTO generation_artifact_checkpoints (
            run_id, artifact_kind, artifact_name, stage_index, tier,
            status, clean_version_id, raw_version_id, clean_blob_key,
            raw_blob_key, completed_by_job_id
          ) VALUES (
            ?, 'sprite', 'idle', 1, 'champion', 'approved',
            'admin-video-idle-clean', 'admin-video-idle-raw', ?, ?, ?
          )
        `).bind(
          PURCHASE_ID,
          `users/${USER_ID}/fighters/${FIGHTER_ID}/sprites/idle.png`,
          `users/${USER_ID}/fighters/${FIGHTER_ID}/sprites/idle-raw.png`,
          PURCHASE_ID,
        ),
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES ('ledger-admin-video-continuation', ?, 0, 'arcade_seed_generation', ?)
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, creation_flow, credit_cost, free_quota_delta,
            status, reason, fighter_id, ledger_id, continuation_run_id,
            resumed_from_job_id, expires_at
          ) VALUES (
            ?, ?, 'champion', 'video', 0, 0, 'reserved',
            'arcade_seed_generation', ?, 'ledger-admin-video-continuation',
            ?, ?, datetime('now', '+12 hours')
          )
        `).bind(
          continuationPurchaseId,
          USER_ID,
          FIGHTER_ID,
          PURCHASE_ID,
          PURCHASE_ID,
        ),
        db.prepare(`
          INSERT INTO provider_sessions (
            id, user_id, rate_limit_key, tier, creation_flow, purpose,
            charge_id, status, expires_at
          ) VALUES (
            ?, ?, ?, 'champion', 'video', 'fighter_generation', ?,
            'active', datetime('now', '+12 hours')
          )
        `).bind(
          continuationSessionId,
          USER_ID,
          `user:${USER_ID}`,
          continuationPurchaseId,
        ),
      ]);
      await stageCompleteChampionInventory(db, env);

      const continuation = await startAdminArcadeGeneration(
        adminVideoRequest(),
        env,
        adminAuth,
        FIGHTER_ID,
      );
      expect(continuation.status).toBe(202);
      expect(await continuation.json()).toMatchObject({ job: {
        id: continuationPurchaseId,
        creationFlow: 'video',
        artifactRunId: PURCHASE_ID,
        resumedFromJobId: PURCHASE_ID,
        status: 'queued',
      } });
      expect(workflowStarts).toEqual([PURCHASE_ID, continuationPurchaseId]);
      expect(await db.prepare(`
        SELECT artifact_run_id, resumed_from_job_id, creation_flow, progress_current
        FROM generation_jobs WHERE id = ?
      `).bind(continuationPurchaseId).first()).toEqual({
        artifact_run_id: PURCHASE_ID,
        resumed_from_job_id: PURCHASE_ID,
        creation_flow: 'video',
        progress_current: 1,
      });
      expect(await db.prepare(`
        SELECT continuation_run_id, resumed_from_job_id, creation_flow,
          credit_cost, free_quota_delta, status
        FROM generation_charges WHERE id = ?
      `).bind(continuationPurchaseId).first()).toMatchObject({
        continuation_run_id: PURCHASE_ID,
        resumed_from_job_id: PURCHASE_ID,
        creation_flow: 'video',
        credit_cost: 0,
        free_quota_delta: 0,
      });
      expect((await db.prepare(`
        SELECT credits_balance FROM users WHERE id = ?
      `).bind(USER_ID).first<{ credits_balance: number }>())?.credits_balance).toBe(7);
      expect(await db.prepare(`
        SELECT COALESCE(SUM(delta), 0) AS delta FROM credit_ledger
      `).first()).toEqual({ delta: 0 });

      const replay = await startAdminArcadeGeneration(
        adminVideoRequest(),
        env,
        adminAuth,
        FIGHTER_ID,
      );
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        replayed: true,
        job: { id: continuationPurchaseId, creationFlow: 'video', status: 'queued' },
      });
      expect(workflowStarts).toEqual([PURCHASE_ID, continuationPurchaseId]);
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM generation_jobs
      `).first<{ count: number }>())?.count).toBe(2);
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM generation_charges
      `).first<{ count: number }>())?.count).toBe(2);
    } finally {
      await mf.dispose();
    }
  }, 30_000);

  it('blocks a Video job from reusing an Original authorization', async () => {
    const { mf, db, env, workflowStarts } = await bindings();
    try {
      const response = await createGenerationJob(
        request(PURCHASE_ID, SESSION_ID, undefined, 'video'),
        env,
        auth,
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: expect.stringMatching(/authorization is no longer active/i),
      });
      expect(workflowStarts).toEqual([]);
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM generation_jobs
      `).first<{ count: number }>())?.count).toBe(0);
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM generation_artifact_runs
      `).first<{ count: number }>())?.count).toBe(0);
      expect((await db.prepare(`
        SELECT status FROM generation_charges WHERE id = ?
      `).bind(PURCHASE_ID).first<{ status: string }>())?.status).toBe('refunded');
      expect((await db.prepare(`
        SELECT status FROM provider_sessions WHERE id = ?
      `).bind(SESSION_ID).first<{ status: string }>())?.status).toBe('cancelled');
      expect((await db.prepare(`
        SELECT credits_balance FROM users WHERE id = ?
      `).bind(USER_ID).first<{ credits_balance: number }>())?.credits_balance).toBe(10);
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('creates a zero-credit video continuation for a failed local post-submit step', async () => {
    const { mf, db, env, workflowStarts } = await bindings();
    const failedJobId = '88888888888888888888888888888888';
    const failedChargeId = '77777777777777777777777777777777';
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES ('ledger-video-failed', ?, -18, 'fighter_generation', ?)
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, creation_flow, credit_cost, status, reason,
            fighter_id, ledger_id, expires_at
          ) VALUES (?, ?, 'champion', 'video', 18, 'committed',
            'fighter_generation', ?, 'ledger-video-failed', datetime('now', '+12 hours'))
        `).bind(failedChargeId, USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO provider_sessions (
            id, user_id, rate_limit_key, tier, creation_flow, purpose,
            charge_id, status, expires_at
          ) VALUES (?, ?, ?, 'champion', 'video', 'fighter_generation', ?,
            'completed', datetime('now', '+12 hours'))
        `).bind('session-video-failed', USER_ID, `user:${USER_ID}`, failedChargeId),
        db.prepare(`
          INSERT INTO generation_artifact_runs (
            id, user_id, fighter_id, tier, creation_flow, operation,
            root_job_id, original_charge_id, original_blob_key, status
          ) VALUES (?, ?, ?, 'champion', 'video', 'fighter_generation', ?, ?, ?, 'partial')
        `).bind(failedJobId, USER_ID, FIGHTER_ID, failedJobId, failedChargeId, ORIGINAL_KEY),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, workflow_instance_id, user_id, fighter_id, charge_id,
            provider_session_id, tier, creation_flow, operation, artifact_run_id,
            status, stage
          ) VALUES (?, ?, ?, ?, ?, 'session-video-failed', 'champion', 'video',
            'fighter_generation', ?, 'failed', 'video:compile')
        `).bind(failedJobId, failedJobId, USER_ID, FIGHTER_ID, failedChargeId, failedJobId),
        db.prepare(`
          UPDATE generation_charges
          SET tier = 'champion', creation_flow = 'video', credit_cost = 0,
              reason = 'fighter_generation', continuation_run_id = ?,
              resumed_from_job_id = ?
          WHERE id = ?
        `).bind(failedJobId, failedJobId, PURCHASE_ID),
        db.prepare(`
          UPDATE provider_sessions
          SET tier = 'champion', creation_flow = 'video'
          WHERE id = ?
        `).bind(SESSION_ID),
      ]);

      const created = await createGenerationJob(request(PURCHASE_ID, SESSION_ID, undefined, 'video'), env, auth);
      expect(created.status).toBe(202);
      expect(workflowStarts).toEqual([PURCHASE_ID]);
      expect(await db.prepare(`
        SELECT artifact_run_id, resumed_from_job_id, creation_flow
        FROM generation_jobs WHERE id = ?
      `).bind(PURCHASE_ID).first()).toEqual({
        artifact_run_id: failedJobId,
        resumed_from_job_id: failedJobId,
        creation_flow: 'video',
      });
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('rejects a stale continuation authorization after the exact retry action is approved', async () => {
    const { mf, db, env, workflowStarts } = await bindings();
    const parentJobId = '56565656565656565656565656565656';
    const parentChargeId = '78787878787878787878787878787878';
    try {
      await db.batch([
        db.prepare(`INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES ('ledger-final-action', ?, -1, 'fighter_retry_animation', ?)`)
          .bind(USER_ID, FIGHTER_ID),
        db.prepare(`INSERT INTO generation_charges (
          id, user_id, tier, creation_flow, credit_cost, status, reason,
          fighter_id, ledger_id, expires_at
        ) VALUES (?, ?, 'champion', 'video', 1, 'committed', 'fighter_retry_animation',
          ?, 'ledger-final-action', datetime('now', '+12 hours'))`)
          .bind(parentChargeId, USER_ID, FIGHTER_ID),
        db.prepare(`INSERT INTO provider_sessions (
          id, user_id, rate_limit_key, tier, creation_flow, purpose,
          charge_id, status, expires_at
        ) VALUES ('session-final-action', ?, ?, 'champion', 'video', 'fighter_retry',
          ?, 'completed', datetime('now', '+12 hours'))`)
          .bind(USER_ID, `user:${USER_ID}`, parentChargeId),
        db.prepare(`INSERT INTO generation_artifact_runs (
          id, user_id, fighter_id, tier, creation_flow, operation,
          target_kind, target_name, root_job_id, status
        ) VALUES (?, ?, ?, 'champion', 'video', 'fighter_retry_animation',
          'animation', 'idle', ?, 'partial')`)
          .bind(parentJobId, USER_ID, FIGHTER_ID, parentJobId),
        db.prepare(`INSERT INTO generation_jobs (
          id, workflow_instance_id, user_id, fighter_id, charge_id,
          provider_session_id, tier, creation_flow, operation, target_kind,
          target_name, artifact_run_id, status, review_status, stage
        ) VALUES (?, ?, ?, ?, ?, 'session-final-action', 'champion', 'video',
          'fighter_retry_animation', 'animation', 'idle', ?, 'succeeded',
          'approved', 'review:approved')`)
          .bind(parentJobId, parentJobId, USER_ID, FIGHTER_ID, parentChargeId, parentJobId),
        db.prepare(`INSERT INTO video_sprite_candidates (
          id, run_id, job_id, user_id, fighter_id, action, sequence_order,
          status, current_revision, approved_revision
        ) VALUES ('candidate-final-action', ?, ?, ?, ?, 'idle', 0,
          'approved', 1, 1)`)
          .bind(parentJobId, parentJobId, USER_ID, FIGHTER_ID),
        db.prepare(`INSERT INTO video_sprite_candidate_revisions (
          candidate_id, revision, report_sha256
        ) VALUES ('candidate-final-action', 1, ?)`).bind('b'.repeat(64)),
        db.prepare(`UPDATE generation_charges
          SET tier = 'champion', creation_flow = 'video', credit_cost = 0,
              reason = 'fighter_retry_animation', continuation_run_id = ?,
              resumed_from_job_id = ? WHERE id = ?`)
          .bind(parentJobId, parentJobId, PURCHASE_ID),
        db.prepare(`UPDATE provider_sessions
          SET tier = 'champion', creation_flow = 'video', purpose = 'fighter_retry'
          WHERE id = ?`).bind(SESSION_ID),
      ]);
      const created = await createGenerationJob(request(
        PURCHASE_ID,
        SESSION_ID,
        { targetKind: 'animation', targetName: 'idle' },
        'video',
      ), env, auth);
      expect(created.status).toBe(400);
      expect(await created.json()).toMatchObject({ code: 'video_creation_operation_unsupported' });
      expect(workflowStarts).toEqual([]);
      expect((await db.prepare(`SELECT status FROM generation_charges WHERE id = ?`)
        .bind(PURCHASE_ID).first<{ status: string }>())?.status).toBe('refunded');
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('starts one idempotent workflow and extends its backend-owned reservation', async () => {
    const { mf, db, env, workflowStarts } = await bindings();
    try {
      const created = await createGenerationJob(request(), env, auth);
      expect(created.status).toBe(202);
      const body = await created.json() as {
        job: { id: string; status: string; fighterId: string; creationFlow: string };
      };
      expect(body.job).toMatchObject({
        id: PURCHASE_ID,
        status: 'queued',
        fighterId: FIGHTER_ID,
        creationFlow: 'original',
      });
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
      expect(await db.prepare(`
        SELECT creation_flow FROM generation_jobs WHERE id = ?
      `).bind(PURCHASE_ID).first()).toEqual({ creation_flow: 'original' });
      expect(await db.prepare(`
        SELECT creation_flow FROM generation_artifact_runs WHERE id = ?
      `).bind(PURCHASE_ID).first()).toEqual({ creation_flow: 'original' });
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('creates a continuation job at 7/14 on the original partial artifact run', async () => {
    const { mf, db, env, workflowStarts } = await bindings();
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
        db.prepare("UPDATE generation_charges SET status = 'committed' WHERE id = ?")
          .bind(PURCHASE_ID),
        db.prepare(`
          INSERT INTO generation_artifact_runs (
            id, user_id, fighter_id, tier, operation, root_job_id,
            original_charge_id, original_blob_key, status, failure_stage
          ) VALUES (?, ?, ?, 'rookie', 'fighter_generation', ?, ?, ?, 'partial', 'sprite:low_punch')
        `).bind(PURCHASE_ID, USER_ID, FIGHTER_ID, PURCHASE_ID, PURCHASE_ID, ORIGINAL_KEY),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, workflow_instance_id, user_id, fighter_id, charge_id, provider_session_id,
            tier, operation, artifact_run_id, status, stage, failure_stage,
            progress_current, progress_total, finished_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, 'rookie', 'fighter_generation', ?,
            'failed', 'sprite:low_punch', 'sprite:low_punch', 7, 14, datetime('now')
          )
        `).bind(
          PURCHASE_ID,
          PURCHASE_ID,
          USER_ID,
          FIGHTER_ID,
          PURCHASE_ID,
          SESSION_ID,
          PURCHASE_ID,
        ),
        ...completedStages.map(([kind, name, index]) => db.prepare(`
          INSERT INTO generation_artifact_checkpoints (
            run_id, artifact_kind, artifact_name, stage_index, tier,
            clean_version_id, clean_blob_key, completed_by_job_id
          ) VALUES (?, ?, ?, ?, 'rookie', ?, ?, ?)
        `).bind(
          PURCHASE_ID,
          kind,
          name,
          index,
          `version-${name}`,
          `users/${USER_ID}/fighters/${FIGHTER_ID}/versions/${name}.png`,
          PURCHASE_ID,
        )),
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES ('ledger-continuation', ?, 0, 'fighter_generation_continuation', ?)
        `).bind(USER_ID, FIGHTER_ID),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, credit_cost, status, reason, fighter_id, ledger_id,
            continuation_run_id, resumed_from_job_id, expires_at
          ) VALUES (
            ?, ?, 'rookie', 0, 'reserved', 'fighter_generation', ?, 'ledger-continuation',
            ?, ?, datetime('now', '+12 hours')
          )
        `).bind(SECOND_PURCHASE_ID, USER_ID, FIGHTER_ID, PURCHASE_ID, PURCHASE_ID),
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
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        job: {
          id: SECOND_PURCHASE_ID,
          artifactRunId: PURCHASE_ID,
          resumedFromJobId: PURCHASE_ID,
          progressCurrent: 7,
          progressTotal: 14,
          preservedArtifactCount: 7,
          completedStages: [
            'source:side',
            'source:upright',
            'source:crouch',
            'sprite:idle',
            'sprite:walk',
            'sprite:high_punch',
            'sprite:high_kick',
          ],
          pendingStages: [
            'sprite:low_punch',
            'sprite:low_kick',
            'sprite:jump',
            'sprite:crouch',
            'sprite:hit',
            'sprite:ko',
            'sprite:victory',
          ],
        },
      });
      expect(workflowStarts).toEqual([SECOND_PURCHASE_ID]);
      expect((await db.prepare('SELECT COUNT(*) AS count FROM generation_artifact_runs')
        .first<{ count: number }>())?.count).toBe(1);
      expect((await db.prepare('SELECT status FROM generation_artifact_runs WHERE id = ?')
        .bind(PURCHASE_ID).first<{ status: string }>())?.status).toBe('active');
      expect((await db.prepare('SELECT credits_balance FROM users WHERE id = ?')
        .bind(USER_ID).first<{ credits_balance: number }>())?.credits_balance).toBe(7);
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

  it('releases the reservation before asset access when a required Gemini model is at daily capacity', async () => {
    const { mf, db, env, workflowStarts } = await bindings();
    try {
      const window = await recordProviderDailyQuota(env, {
        provider: 'gemini',
        model: GEMINI_PRO_IMAGE_MODEL,
        retryAfterSeconds: 3600,
      });
      await env.SPRITES.delete(ORIGINAL_KEY);

      const response = await createGenerationJob(request(), env, auth);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: 'provider_daily_quota_exhausted',
        provider: 'gemini',
        model: GEMINI_PRO_IMAGE_MODEL,
        retryAt: new Date(window.retryAtEpoch * 1_000).toISOString(),
      });
      expect(workflowStarts).toEqual([]);
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

  it('refunds a reserved video action retry without creating a job', async () => {
    const { mf, db, env, workflowStarts } = await bindings();
    try {
      await seedAnimationRetry(db, env);
      await db.batch([
        db.prepare(`UPDATE generation_charges
          SET tier = 'champion', creation_flow = 'video', credit_cost = 4
          WHERE id = ?`).bind(SECOND_PURCHASE_ID),
        db.prepare(`UPDATE provider_sessions
          SET tier = 'champion', creation_flow = 'video'
          WHERE id = ?`).bind(SECOND_SESSION_ID),
      ]);
      const response = await createGenerationJob(request(
        SECOND_PURCHASE_ID,
        SECOND_SESSION_ID,
        { targetKind: 'animation', targetName: 'victory' },
        'video',
      ), env, auth);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'video_creation_operation_unsupported' });
      expect(workflowStarts).toEqual([]);
      expect((await db.prepare('SELECT COUNT(*) AS count FROM generation_jobs')
        .first<{ count: number }>())?.count).toBe(0);
      expect((await db.prepare('SELECT status FROM generation_charges WHERE id = ?')
        .bind(SECOND_PURCHASE_ID).first<{ status: string }>())?.status).toBe('refunded');
      expect((await db.prepare('SELECT status FROM provider_sessions WHERE id = ?')
        .bind(SECOND_SESSION_ID).first<{ status: string }>())?.status).toBe('cancelled');
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
