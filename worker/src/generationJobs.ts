import { generateId } from './auth';
import { settleGenerationPurchase } from './billing';
import { readJsonBody } from './requestBody';
import type { AuthContext, Env, GenerationJob, GenerationJobOperation, QualityTier } from './types';

const MAX_JOB_BODY_BYTES = 8 * 1024;
const JOB_TTL_HOURS = 48;
const ANIMATION_TARGETS = new Set([
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
]);
const SOURCE_TARGETS = new Set(['side', 'upright', 'crouch']);

interface GenerationJobAuthorizationRow {
  charge_id: string;
  charge_tier: QualityTier;
  charge_reason: string;
  charge_status: 'reserved' | 'committed' | 'refunded';
  charge_fighter_id: string | null;
  charge_expires_at: string;
  provider_session_id: string;
  provider_tier: QualityTier;
  provider_purpose: string;
  provider_status: string;
  provider_expires_at: string;
  fighter_id: string;
  original_blob_key: string | null;
  side_view_blob_key: string | null;
  side_view_raw_blob_key: string | null;
  upright_view_blob_key: string | null;
  upright_view_raw_blob_key: string | null;
  crouch_view_blob_key: string | null;
  crouch_view_raw_blob_key: string | null;
}

interface GenerationJobEventRow {
  stage: string;
  status: string;
  detail: string | null;
  created_at: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function rejectReservedJob(
  env: Env,
  userId: string,
  purchaseId: string,
  fighterId: string,
  error: string,
  status: number,
): Promise<Response> {
  await settleGenerationPurchase(env, userId, purchaseId, false, fighterId);
  return json({ error }, status);
}

function serializeJob(job: GenerationJob, events: GenerationJobEventRow[] = []) {
  return {
    id: job.id,
    fighterId: job.fighter_id,
    tier: job.tier,
    operation: job.operation,
    targetKind: job.target_kind,
    targetName: job.target_name,
    status: job.status,
    stage: job.stage,
    progressCurrent: job.progress_current,
    progressTotal: job.progress_total,
    errorCode: job.error_code,
    errorMessage: job.error_message,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    events: events.map((event) => ({
      stage: event.stage,
      status: event.status,
      detail: event.detail,
      createdAt: event.created_at,
    })),
  };
}

async function getOwnedJob(env: Env, userId: string, jobId: string): Promise<GenerationJob | null> {
  return env.DB.prepare(
    'SELECT * FROM generation_jobs WHERE id = ? AND user_id = ?'
  ).bind(jobId, userId).first<GenerationJob>();
}

async function getJobEvents(env: Env, jobId: string): Promise<GenerationJobEventRow[]> {
  const { results } = await env.DB.prepare(`
    SELECT stage, status, detail, created_at
    FROM generation_job_events
    WHERE job_id = ?
    ORDER BY created_at DESC
    LIMIT 24
  `).bind(jobId).all<GenerationJobEventRow>();
  return (results ?? []).reverse();
}

function matchesJobRequest(
  job: GenerationJob,
  fighterId: string,
  purchaseId: string,
  providerSessionId: string,
  targetKind: 'animation' | 'source' | null,
  targetName: string | null,
): boolean {
  return job.id === purchaseId
    && job.charge_id === purchaseId
    && job.fighter_id === fighterId
    && job.provider_session_id === providerSessionId
    && job.target_kind === targetKind
    && job.target_name === targetName;
}

async function replayExistingJob(env: Env, userId: string, job: GenerationJob): Promise<Response> {
  if (job.status === 'queued') {
    try {
      await startWorkflow(env, job.id);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'generation_workflow_recovery_failed',
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      }));
      return json({
        error: 'The accepted generation job is waiting for the cloud runner; retry this request to reconnect',
        job: serializeJob(job, await getJobEvents(env, job.id)),
      }, 503);
    }
  }
  const refreshed = await getOwnedJob(env, userId, job.id) ?? job;
  return json({ job: serializeJob(refreshed, await getJobEvents(env, refreshed.id)) });
}

function operationForAuthorization(row: GenerationJobAuthorizationRow): GenerationJobOperation | null {
  if (
    (row.charge_reason === 'fighter_generation' || row.charge_reason === 'arcade_seed_generation')
    && row.provider_purpose === 'fighter_generation'
  ) {
    return 'fighter_generation';
  }
  if (row.charge_reason === 'fighter_upgrade' && row.provider_purpose === 'fighter_upgrade') {
    return 'fighter_upgrade';
  }
  if (row.charge_reason === 'fighter_retry_animation' && row.provider_purpose === 'fighter_retry') {
    return 'fighter_retry_animation';
  }
  if (row.charge_reason === 'fighter_retry_source' && row.provider_purpose === 'fighter_retry') {
    return 'fighter_retry_source';
  }
  return null;
}

function validateTarget(
  operation: GenerationJobOperation,
  targetKind: 'animation' | 'source' | null,
  targetName: string | null,
): string | null {
  if (operation === 'fighter_generation' || operation === 'fighter_upgrade') {
    return targetKind === null && targetName === null
      ? null
      : 'Full fighter generation cannot include a retry target';
  }
  if (operation === 'fighter_retry_animation') {
    return targetKind === 'animation' && targetName !== null && ANIMATION_TARGETS.has(targetName)
      ? null
      : 'A supported animation retry target is required';
  }
  return targetKind === 'source' && targetName !== null && SOURCE_TARGETS.has(targetName)
    ? null
    : 'A supported source retry target is required';
}

async function validateRequiredAssets(
  env: Env,
  row: GenerationJobAuthorizationRow,
  operation: GenerationJobOperation,
  targetName: string | null,
): Promise<string | null> {
  if (operation === 'fighter_generation') {
    if (!row.original_blob_key || !await env.SPRITES.head(row.original_blob_key)) {
      return 'Upload the original fighter photo before starting generation';
    }
    return null;
  }

  let required: Array<string | null>;
  if (operation === 'fighter_retry_source') {
    if (targetName === 'side') {
      required = [row.original_blob_key];
    } else if (targetName === 'upright') {
      required = [row.side_view_raw_blob_key];
    } else {
      required = [row.upright_view_blob_key, row.upright_view_raw_blob_key];
    }
  } else {
    required = [
      row.side_view_blob_key,
      row.side_view_raw_blob_key,
      row.upright_view_blob_key,
      row.upright_view_raw_blob_key,
      row.crouch_view_blob_key,
      row.crouch_view_raw_blob_key,
    ];
  }
  if (required.some((key) => !key)) {
    return 'Required private source views are unavailable for this generation';
  }
  const heads = await Promise.all(required.map((key) => env.SPRITES.head(key!)));
  return heads.some((head) => !head)
    ? 'One or more canonical source assets are unavailable'
    : null;
}

async function startWorkflow(env: Env, jobId: string): Promise<void> {
  if (!env.FIGHTER_GENERATION) throw new Error('Fighter generation Workflow is not configured');
  try {
    await env.FIGHTER_GENERATION.create({
      id: jobId,
      params: { jobId },
      locationHint: 'weur',
      retention: { successRetention: '30 days', errorRetention: '30 days' },
    });
  } catch (error) {
    const status = await env.FIGHTER_GENERATION.get(jobId).then((instance) => instance.status()).catch(() => null);
    if (status && status.status !== 'unknown') return;
    throw error;
  }
}

export async function createGenerationJob(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJsonBody<{
    fighterId?: string;
    purchaseId?: string;
    providerSessionId?: string;
    targetKind?: string;
    targetName?: string;
  }>(request, MAX_JOB_BODY_BYTES);
  const fighterId = body.fighterId?.trim() ?? '';
  const purchaseId = body.purchaseId?.trim() ?? '';
  const providerSessionId = body.providerSessionId?.trim() ?? '';
  const targetKind = body.targetKind === 'animation' || body.targetKind === 'source'
    ? body.targetKind
    : null;
  const targetName = body.targetName?.trim().toLowerCase() || null;
  if (!/^[a-f0-9]{32}$/.test(fighterId)) return json({ error: 'A valid fighterId is required' }, 400);
  if (!/^[a-f0-9]{32}$/.test(purchaseId)) return json({ error: 'A valid purchaseId is required' }, 400);
  if (!/^[a-f0-9]{32}$/.test(providerSessionId)) {
    return json({ error: 'A valid providerSessionId is required' }, 400);
  }
  if (body.targetKind !== undefined && targetKind === null) {
    return json({ error: 'A valid targetKind is required' }, 400);
  }
  if (targetName !== null && !/^[a-z_]{2,64}$/.test(targetName)) {
    return json({ error: 'A valid targetName is required' }, 400);
  }

  const existing = await env.DB.prepare(`
    SELECT * FROM generation_jobs
    WHERE user_id = ? AND (charge_id = ? OR provider_session_id = ?)
    LIMIT 1
  `).bind(auth.userId, purchaseId, providerSessionId).first<GenerationJob>();
  if (existing) {
    if (!matchesJobRequest(existing, fighterId, purchaseId, providerSessionId, targetKind, targetName)) {
      return json({ error: 'Generation authorization is already attached to another job' }, 409);
    }
    return replayExistingJob(env, auth.userId, existing);
  }

  const authorization = await env.DB.prepare(`
    SELECT
      gc.id AS charge_id,
      gc.tier AS charge_tier,
      gc.reason AS charge_reason,
      gc.status AS charge_status,
      gc.fighter_id AS charge_fighter_id,
      gc.expires_at AS charge_expires_at,
      ps.id AS provider_session_id,
      ps.tier AS provider_tier,
      ps.purpose AS provider_purpose,
      ps.status AS provider_status,
      ps.expires_at AS provider_expires_at,
      f.id AS fighter_id,
      f.original_blob_key,
      f.side_view_blob_key,
      f.side_view_raw_blob_key,
      f.upright_view_blob_key,
      f.upright_view_raw_blob_key,
      f.crouch_view_blob_key,
      f.crouch_view_raw_blob_key
    FROM generation_charges gc
    JOIN provider_sessions ps ON ps.id = ? AND ps.charge_id = gc.id AND ps.user_id = gc.user_id
    JOIN fighters f ON f.id = ? AND f.owner_user_id = gc.user_id
    WHERE gc.id = ? AND gc.user_id = ?
      AND (gc.fighter_id IS NULL OR gc.fighter_id = f.id)
    LIMIT 1
  `).bind(providerSessionId, fighterId, purchaseId, auth.userId)
    .first<GenerationJobAuthorizationRow>();
  if (!authorization) return json({ error: 'Generation authorization does not match this fighter' }, 403);
  if (
    authorization.charge_status !== 'reserved' ||
    authorization.provider_status !== 'active' ||
    authorization.charge_tier !== authorization.provider_tier
  ) {
    if (authorization.charge_status === 'reserved') {
      return rejectReservedJob(
        env,
        auth.userId,
        purchaseId,
        fighterId,
        'Generation authorization is no longer active; the unused reservation was released',
        409,
      );
    }
    return json({ error: 'Generation authorization is no longer active' }, 409);
  }
  if (
    Date.parse(authorization.charge_expires_at) <= Date.now() ||
    Date.parse(authorization.provider_expires_at) <= Date.now()
  ) {
    await settleGenerationPurchase(env, auth.userId, purchaseId, false, fighterId);
    return json({ error: 'Generation authorization expired; the unused reservation was released' }, 409);
  }
  const operation = operationForAuthorization(authorization);
  if (!operation) {
    return rejectReservedJob(
      env,
      auth.userId,
      purchaseId,
      fighterId,
      'Generation authorization has the wrong operation scope; the unused reservation was released',
      403,
    );
  }
  const targetError = validateTarget(operation, targetKind, targetName);
  if (targetError) {
    return rejectReservedJob(
      env,
      auth.userId,
      purchaseId,
      fighterId,
      `${targetError}; the unused reservation was released`,
      400,
    );
  }
  const assetError = await validateRequiredAssets(env, authorization, operation, targetName);
  if (assetError) {
    return rejectReservedJob(env, auth.userId, purchaseId, fighterId, `${assetError}; the unused reservation was released`, 409);
  }
  if (
    !env.FIGHTER_GENERATION
    || !env.IMAGE_PROCESSOR
    || (!env.GENERATION_JOB_SIGNING_SECRET?.trim() && env.ENVIRONMENT !== 'development')
  ) {
    return rejectReservedJob(
      env,
      auth.userId,
      purchaseId,
      fighterId,
      'Durable generation is temporarily unavailable; the unused reservation was released',
      503,
    );
  }

  const activeFighterJob = await env.DB.prepare(`
    SELECT * FROM generation_jobs
    WHERE fighter_id = ? AND status IN ('queued', 'running')
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(fighterId).first<GenerationJob>();
  if (activeFighterJob) {
    if (matchesJobRequest(
      activeFighterJob,
      fighterId,
      purchaseId,
      providerSessionId,
      targetKind,
      targetName,
    )) {
      return replayExistingJob(env, auth.userId, activeFighterJob);
    }
    await settleGenerationPurchase(env, auth.userId, purchaseId, false, fighterId);
    return json({
      error: 'A generation is already running for this fighter; the unused reservation was released',
      job: serializeJob(activeFighterJob, await getJobEvents(env, activeFighterJob.id)),
    }, 409);
  }

  const jobId = purchaseId;
  const progressTotal = operation === 'fighter_generation'
    ? 14
    : operation === 'fighter_upgrade'
      ? 11
      : 1;
  const extendedExpiry = new Date(Date.now() + JOB_TTL_HOURS * 60 * 60 * 1_000).toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO generation_jobs (
          id, workflow_instance_id, user_id, fighter_id, charge_id,
          provider_session_id, tier, operation, target_kind, target_name, progress_total
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        jobId,
        jobId,
        auth.userId,
        fighterId,
        purchaseId,
        providerSessionId,
        authorization.charge_tier,
        operation,
        targetKind,
        targetName,
        progressTotal,
      ),
      env.DB.prepare(`
        UPDATE generation_charges
        SET fighter_id = COALESCE(fighter_id, ?), expires_at = ?, updated_at = datetime('now')
        WHERE id = ? AND user_id = ? AND status = 'reserved'
      `).bind(fighterId, extendedExpiry, purchaseId, auth.userId),
      env.DB.prepare(`
        UPDATE provider_sessions
        SET expires_at = ?, updated_at = datetime('now')
        WHERE id = ? AND user_id = ? AND status = 'active'
      `).bind(extendedExpiry, providerSessionId, auth.userId),
      env.DB.prepare(`
        INSERT INTO generation_job_events (id, job_id, stage, status, detail)
        VALUES (?, ?, 'queued', 'queued', ?)
      `).bind(
        generateId(),
        jobId,
        targetName ? `${operation} ${targetName} accepted by the backend` : 'Generation accepted by the backend',
      ),
    ]);
  } catch (error) {
    const racedJob = await env.DB.prepare(`
      SELECT * FROM generation_jobs
      WHERE fighter_id = ? AND status IN ('queued', 'running')
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(fighterId).first<GenerationJob>();
    if (!racedJob) throw error;
    if (matchesJobRequest(racedJob, fighterId, purchaseId, providerSessionId, targetKind, targetName)) {
      return replayExistingJob(env, auth.userId, racedJob);
    }
    await settleGenerationPurchase(env, auth.userId, purchaseId, false, fighterId);
    return json({
      error: 'A generation is already running for this fighter; the unused reservation was released',
      job: serializeJob(racedJob, await getJobEvents(env, racedJob.id)),
    }, 409);
  }

  try {
    await startWorkflow(env, jobId);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'generation_workflow_start_failed',
      jobId,
      error: error instanceof Error ? error.message : String(error),
    }));
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE generation_jobs
        SET status = 'failed', stage = 'failed', error_code = 'workflow_start_failed',
            error_message = 'Generation could not start external processing; the unused reservation was released',
            finished_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND status = 'queued'
      `).bind(jobId),
      env.DB.prepare(`
        INSERT INTO generation_job_events (id, job_id, stage, status, detail)
        VALUES (?, ?, 'failed', 'failed', 'Workflow start failed')
      `).bind(generateId(), jobId),
    ]);
    await settleGenerationPurchase(env, auth.userId, purchaseId, false, fighterId);
    return json({ error: 'Generation could not start external processing; the unused reservation was released' }, 503);
  }

  const job = await getOwnedJob(env, auth.userId, jobId);
  if (!job) return json({ error: 'Generation job could not be loaded' }, 500);
  return json({ job: serializeJob(job, await getJobEvents(env, job.id)) }, 202);
}

export async function getGenerationJob(
  env: Env,
  auth: AuthContext,
  jobId: string,
): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(jobId)) return json({ error: 'Generation job not found' }, 404);
  const job = await getOwnedJob(env, auth.userId, jobId);
  if (!job) return json({ error: 'Generation job not found' }, 404);
  return json({ job: serializeJob(job, await getJobEvents(env, job.id)) });
}

export async function listGenerationJobs(env: Env, auth: AuthContext): Promise<Response> {
  const { results } = await env.DB.prepare(`
    SELECT * FROM generation_jobs
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).bind(auth.userId).all<GenerationJob>();
  return json({ jobs: (results ?? []).map((job) => serializeJob(job)) });
}
