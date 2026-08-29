import { generateId } from './auth';
import { artifactProgress, generationStagesForOperation } from './generationArtifacts';
import { settleGenerationPurchase } from './billing';
import { activeGenerationCapacity } from './providerCapacity';
import { readJsonBody } from './requestBody';
import type {
  AuthContext,
  Env,
  GenerationArtifactRun,
  GenerationJob,
  GenerationJobOperation,
  QualityTier,
} from './types';
import type { GenerationCreationFlow } from '../../src/services/GenerationCreationFlow';
import { VIDEO_SPRITE_ACTIONS } from '../../src/services/VideoSpriteCompileContract';
import {
  generationCreationFlowAvailable,
  parseRequestedGenerationCreationFlow,
} from './generationCreationFlow';
import {
  generationSourceManifest,
  parseSealedReviewedCanonicalSources,
  reviewedCanonicalHashesFromSealed,
  ReviewedCanonicalSourceError,
  type SealedReviewedCanonicalSources,
} from './reviewedCanonicalSources';
import {
  prepareUnsealedVideoRestartAudit,
  prepareUnsealedVideoRestartRetirement,
  readEligibleUnsealedVideoPartialRestart,
} from './videoRunRestart';
import {
  SELF_SERVICE_VIDEO_POLICY,
  STUDIO_CURATED_VIDEO_POLICY,
  storedVideoGenerationPolicy,
  type VideoGenerationPolicy,
} from '../../src/services/VideoGenerationPolicy';

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
  charge_creation_flow: GenerationCreationFlow;
  charge_reason: string;
  charge_status: 'reserved' | 'committed' | 'refunded';
  charge_fighter_id: string | null;
  charge_expires_at: string;
  continuation_run_id: string | null;
  resumed_from_job_id: string | null;
  provider_session_id: string;
  provider_tier: QualityTier;
  provider_creation_flow: GenerationCreationFlow;
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
  generation_prompt: string | null;
  resume_run_user_id: string | null;
  resume_run_fighter_id: string | null;
  resume_run_tier: QualityTier | null;
  resume_run_creation_flow: GenerationCreationFlow | null;
  resume_run_video_generation_policy: VideoGenerationPolicy | null;
  resume_run_operation: GenerationJobOperation | null;
  resume_run_target_kind: 'animation' | 'source' | null;
  resume_run_target_name: string | null;
  resume_run_status: string | null;
  resume_run_source_manifest_json: string | null;
  resume_run_approved_action_count: number | null;
  resume_job_status: string | null;
  resume_job_review_status: string | null;
  resume_candidate_status: string | null;
  resume_candidate_current_revision: number | null;
  resume_candidate_approved_revision: number | null;
  resume_candidate_report_sha256: string | null;
  resume_child_job_id: string | null;
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
  details: Record<string, unknown> = {},
): Promise<Response> {
  await settleGenerationPurchase(env, userId, purchaseId, false, fighterId);
  return json({ error, ...details }, status);
}

interface GenerationRunSnapshot {
  status: string;
  failureStage: string | null;
  completedStages: string[];
  pendingStages: string[];
  preservedArtifactCount: number;
  continuationConsumed: boolean;
  canonicalSourceMode: 'reviewed-current-v1' | null;
  canonicalSourceHashes: ReturnType<typeof reviewedCanonicalHashesFromSealed> | null;
  unsealedVideoRestartRequired: boolean;
}

function serializeJob(
  job: GenerationJob,
  events: GenerationJobEventRow[] = [],
  run?: GenerationRunSnapshot,
) {
  return {
    id: job.id,
    fighterId: job.fighter_id,
    tier: job.tier,
    creationFlow: job.creation_flow,
    operation: job.operation,
    targetKind: job.target_kind,
    targetName: job.target_name,
    artifactRunId: job.artifact_run_id,
    resumedFromJobId: job.resumed_from_job_id,
    status: job.status,
    reviewStatus: job.review_status ?? 'none',
    fullRunRestartRequired: job.creation_flow === 'video' &&
      job.operation === 'fighter_generation' && (
        run?.status === 'failed' || run?.unsealedVideoRestartRequired === true
      ),
    stage: job.stage,
    failureStage: job.failure_stage ?? run?.failureStage ?? null,
    progressCurrent: job.progress_current,
    progressTotal: job.progress_total,
    errorCode: job.error_code,
    errorMessage: job.error_message,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    resumable: (
      (job.status === 'failed' || job.status === 'cancelled') ||
      (job.creation_flow === 'video' && job.status === 'succeeded' && job.review_status === 'approved')
    ) && run?.status === 'partial' && run.unsealedVideoRestartRequired !== true && (
      job.creation_flow !== 'video' || !run.continuationConsumed
    ) && (
      job.creation_flow !== 'video' || run.pendingStages.length > 0
    ),
    completedStages: run?.completedStages ?? [],
    pendingStages: run?.pendingStages ?? generationStagesForOperation(job.operation, job.target_name)
      .map((entry) => entry.key),
    preservedArtifactCount: run?.preservedArtifactCount ?? 0,
    canonicalSourceMode: run?.canonicalSourceMode ?? null,
    canonicalSourceHashes: run?.canonicalSourceHashes ?? null,
    events: events.map((event) => ({
      stage: event.stage,
      status: event.status,
      detail: event.detail,
      createdAt: event.created_at,
    })),
  };
}

async function getRunSnapshot(env: Env, job: GenerationJob): Promise<GenerationRunSnapshot | undefined> {
  if (!job.artifact_run_id) return undefined;
  const run = await env.DB.prepare(`
    SELECT * FROM generation_artifact_runs
    WHERE id = ? AND user_id = ? AND fighter_id = ?
    LIMIT 1
  `).bind(job.artifact_run_id, job.user_id, job.fighter_id).first<GenerationArtifactRun>();
  if (!run) return undefined;
  const reviewedCanonicalSources = parseSealedReviewedCanonicalSources(run.source_manifest_json);
  const unsealedVideoRestartRequired = job.creation_flow === 'video' &&
    job.operation === 'fighter_generation' &&
    (job.status === 'failed' || job.status === 'cancelled') &&
    run.status === 'partial' &&
    Boolean(await readEligibleUnsealedVideoPartialRestart(
      env,
      job.user_id,
      job.fighter_id,
      job.id,
    ));
  return {
    status: run.status,
    failureStage: run.failure_stage,
    ...await artifactProgress(env, run),
    continuationConsumed: Boolean(await env.DB.prepare(`
      SELECT 1 AS present FROM generation_jobs WHERE resumed_from_job_id = ? LIMIT 1
    `).bind(job.id).first()),
    canonicalSourceMode: reviewedCanonicalSources?.mode ?? null,
    canonicalSourceHashes: reviewedCanonicalSources
      ? reviewedCanonicalHashesFromSealed(reviewedCanonicalSources)
      : null,
    unsealedVideoRestartRequired,
  };
}

async function serializeOwnedJob(
  env: Env,
  job: GenerationJob,
  events: GenerationJobEventRow[] = [],
) {
  return serializeJob(job, events, await getRunSnapshot(env, job));
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
  creationFlow: GenerationCreationFlow,
): boolean {
  return job.id === purchaseId
    && job.charge_id === purchaseId
    && job.fighter_id === fighterId
    && job.provider_session_id === providerSessionId
    && job.target_kind === targetKind
    && job.target_name === targetName
    && job.creation_flow === creationFlow;
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
        job: await serializeOwnedJob(env, job, await getJobEvents(env, job.id)),
      }, 503);
    }
  }
  const refreshed = await getOwnedJob(env, userId, job.id) ?? job;
  return json({ job: await serializeOwnedJob(env, refreshed, await getJobEvents(env, refreshed.id)) });
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
  options: {
    reviewedCanonicalSources?: SealedReviewedCanonicalSources;
    unsealedVideoRestartFromJobId?: string;
    videoGenerationPolicy?: VideoGenerationPolicy;
  } = {},
): Promise<Response> {
  const body = await readJsonBody<{
    fighterId?: string;
    purchaseId?: string;
    providerSessionId?: string;
    targetKind?: string;
    targetName?: string;
    creationFlow?: unknown;
  }>(request, MAX_JOB_BODY_BYTES);
  const fighterId = body.fighterId?.trim() ?? '';
  const purchaseId = body.purchaseId?.trim() ?? '';
  const providerSessionId = body.providerSessionId?.trim() ?? '';
  const targetKind = body.targetKind === 'animation' || body.targetKind === 'source'
    ? body.targetKind
    : null;
  const targetName = body.targetName?.trim().toLowerCase() || null;
  const creationFlow = parseRequestedGenerationCreationFlow(body.creationFlow);
  const unsealedVideoRestartFromJobId = options.unsealedVideoRestartFromJobId?.trim() ?? '';
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
  if (!creationFlow) return json({ error: 'Unsupported generation creation flow' }, 400);
  if (options.videoGenerationPolicy && creationFlow !== 'video') {
    return rejectReservedJob(
      env,
      auth.userId,
      purchaseId,
      fighterId,
      'A Video generation policy cannot authorize the Original creation flow',
      400,
      { code: 'video_generation_policy_flow_mismatch' },
    );
  }
  if (
    options.videoGenerationPolicy === STUDIO_CURATED_VIDEO_POLICY
    && auth.user?.plan_tier !== 'admin'
  ) {
    return rejectReservedJob(
      env,
      auth.userId,
      purchaseId,
      fighterId,
      'The Studio Curated Video policy requires an admin API authorization',
      403,
      { code: 'studio_curated_video_admin_required' },
    );
  }
  if (
    unsealedVideoRestartFromJobId && (
      !/^[a-f0-9]{32}$/.test(unsealedVideoRestartFromJobId) ||
      creationFlow !== 'video' ||
      auth.user.plan_tier !== 'admin' ||
      !options.reviewedCanonicalSources
    )
  ) {
    return rejectReservedJob(
      env,
      auth.userId,
      purchaseId,
      fighterId,
      'Unsealed Video restart authorization is invalid; the unused reservation was released',
      403,
      { code: 'unsealed_video_restart_authorization_invalid' },
    );
  }
  if (!generationCreationFlowAvailable(creationFlow)) {
    return rejectReservedJob(
      env,
      auth.userId,
      purchaseId,
      fighterId,
      'Video generation is not available on this release; the unused reservation was released',
      503,
      { code: 'generation_creation_flow_unavailable' },
    );
  }

  const existing = await env.DB.prepare(`
    SELECT * FROM generation_jobs
    WHERE user_id = ? AND (charge_id = ? OR provider_session_id = ?)
    LIMIT 1
  `).bind(auth.userId, purchaseId, providerSessionId).first<GenerationJob>();
  if (existing) {
    if (!matchesJobRequest(
      existing,
      fighterId,
      purchaseId,
      providerSessionId,
      targetKind,
      targetName,
      creationFlow,
    )) {
      return json({ error: 'Generation authorization is already attached to another job' }, 409);
    }
    return replayExistingJob(env, auth.userId, existing);
  }

  const pendingReview = await env.DB.prepare(`
    SELECT candidate.job_id
    FROM video_sprite_candidates candidate
    WHERE candidate.fighter_id = ? AND candidate.user_id = ?
      AND candidate.status = 'awaiting_review'
    LIMIT 1
  `).bind(fighterId, auth.userId).first<{ job_id: string }>();
  if (pendingReview) {
    return rejectReservedJob(
      env,
      auth.userId,
      purchaseId,
      fighterId,
      'Review the pending video action before starting another generation; the unused reservation was released',
      409,
      { code: 'video_review_pending', reviewJobId: pendingReview.job_id },
    );
  }

  const authorization = await env.DB.prepare(`
    SELECT
      gc.id AS charge_id,
      gc.tier AS charge_tier,
      gc.creation_flow AS charge_creation_flow,
      gc.reason AS charge_reason,
      gc.status AS charge_status,
      gc.fighter_id AS charge_fighter_id,
      gc.expires_at AS charge_expires_at,
      gc.continuation_run_id,
      gc.resumed_from_job_id,
      ps.id AS provider_session_id,
      ps.tier AS provider_tier,
      ps.creation_flow AS provider_creation_flow,
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
      f.crouch_view_raw_blob_key,
      af.generation_prompt,
      resume_run.user_id AS resume_run_user_id,
      resume_run.fighter_id AS resume_run_fighter_id,
      resume_run.tier AS resume_run_tier,
      resume_run.creation_flow AS resume_run_creation_flow,
      resume_run.video_generation_policy AS resume_run_video_generation_policy,
      resume_run.operation AS resume_run_operation,
      resume_run.target_kind AS resume_run_target_kind,
      resume_run.target_name AS resume_run_target_name,
      resume_run.status AS resume_run_status,
      resume_run.source_manifest_json AS resume_run_source_manifest_json,
      (SELECT COUNT(*) FROM video_sprite_candidates approved
        WHERE approved.run_id = resume_run.id AND approved.status = 'approved')
        AS resume_run_approved_action_count,
      resume_job.status AS resume_job_status,
      resume_job.review_status AS resume_job_review_status,
      resume_candidate.status AS resume_candidate_status,
      resume_candidate.current_revision AS resume_candidate_current_revision,
      resume_candidate.approved_revision AS resume_candidate_approved_revision,
      resume_revision.report_sha256 AS resume_candidate_report_sha256,
      resume_child.id AS resume_child_job_id
    FROM generation_charges gc
    JOIN provider_sessions ps ON ps.id = ? AND ps.charge_id = gc.id AND ps.user_id = gc.user_id
    JOIN fighters f ON f.id = ? AND f.owner_user_id = gc.user_id
    LEFT JOIN arcade_fighters af ON af.fighter_id = f.id
    LEFT JOIN generation_artifact_runs resume_run ON resume_run.id = gc.continuation_run_id
    LEFT JOIN generation_jobs resume_job ON resume_job.id = gc.resumed_from_job_id
    LEFT JOIN video_sprite_candidates resume_candidate ON resume_candidate.job_id = resume_job.id
    LEFT JOIN video_sprite_candidate_revisions resume_revision
      ON resume_revision.candidate_id = resume_candidate.id
      AND resume_revision.revision = resume_candidate.current_revision
    LEFT JOIN generation_jobs resume_child ON resume_child.resumed_from_job_id = resume_job.id
    WHERE gc.id = ? AND gc.user_id = ?
      AND (gc.fighter_id IS NULL OR gc.fighter_id = f.id)
    LIMIT 1
  `).bind(providerSessionId, fighterId, purchaseId, auth.userId)
    .first<GenerationJobAuthorizationRow>();
  if (!authorization) return json({ error: 'Generation authorization does not match this fighter' }, 403);
  if (
    authorization.charge_status !== 'reserved' ||
    authorization.provider_status !== 'active' ||
    authorization.charge_tier !== authorization.provider_tier ||
    authorization.charge_creation_flow !== creationFlow ||
    authorization.provider_creation_flow !== creationFlow
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
  if (creationFlow === 'video' && authorization.charge_tier !== 'champion') {
    return rejectReservedJob(
      env,
      auth.userId,
      purchaseId,
      fighterId,
      'The review-gated video flow is currently available only for Champion fighters',
      400,
      { code: 'video_creation_requires_champion' },
    );
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
  if (creationFlow === 'video' && operation !== 'fighter_generation') {
    return rejectReservedJob(
      env,
      auth.userId,
      purchaseId,
      fighterId,
      'The review-gated video flow currently supports full fighter generation only',
      400,
      { code: 'video_creation_operation_unsupported' },
    );
  }
  const reviewedCanonicalSources = options.reviewedCanonicalSources;
  if (reviewedCanonicalSources) {
    const keysMatchAuthorization =
      authorization.side_view_blob_key === reviewedCanonicalSources.sources.side.processed.blobKey &&
      authorization.side_view_raw_blob_key === reviewedCanonicalSources.sources.side.raw.blobKey &&
      authorization.upright_view_blob_key === reviewedCanonicalSources.sources.upright.processed.blobKey &&
      authorization.upright_view_raw_blob_key === reviewedCanonicalSources.sources.upright.raw.blobKey &&
      authorization.crouch_view_blob_key === reviewedCanonicalSources.sources.crouch.processed.blobKey &&
      authorization.crouch_view_raw_blob_key === reviewedCanonicalSources.sources.crouch.raw.blobKey;
    if (
      auth.user.plan_tier !== 'admin' || creationFlow !== 'video' || operation !== 'fighter_generation' ||
      reviewedCanonicalSources.fighterId !== fighterId ||
      reviewedCanonicalSources.ownerUserId !== auth.userId ||
      (!authorization.continuation_run_id && !keysMatchAuthorization)
    ) {
      return rejectReservedJob(
        env,
        auth.userId,
        purchaseId,
        fighterId,
        'Reviewed canonical source authorization does not match this job; the unused reservation was released',
        403,
        { code: 'reviewed_canonical_source_authorization_mismatch' },
      );
    }
    if (authorization.continuation_run_id) {
      try {
        const sealedRunSources = parseSealedReviewedCanonicalSources(
          authorization.resume_run_source_manifest_json,
        );
        if (!sealedRunSources || JSON.stringify(sealedRunSources) !== JSON.stringify(reviewedCanonicalSources)) {
          throw new ReviewedCanonicalSourceError(
            'Reviewed canonical source identities cannot change during a continuation',
          );
        }
      } catch (error) {
        if (!(error instanceof ReviewedCanonicalSourceError)) throw error;
        return rejectReservedJob(
          env,
          auth.userId,
          purchaseId,
          fighterId,
          `${error.message}; the unused reservation was released`,
          error.status,
          { code: 'reviewed_canonical_source_continuation_mismatch' },
        );
      }
    }
  }
  const eligibleUnsealedVideoRestart = unsealedVideoRestartFromJobId
    ? await readEligibleUnsealedVideoPartialRestart(
        env,
        auth.userId,
        fighterId,
        unsealedVideoRestartFromJobId,
      )
    : null;
  if (unsealedVideoRestartFromJobId && !eligibleUnsealedVideoRestart) {
    return rejectReservedJob(
      env,
      auth.userId,
      purchaseId,
      fighterId,
      'Unsealed Video restart state changed; the unused reservation was released',
      409,
      { code: 'unsealed_video_restart_state_changed' },
    );
  }
  if (
    unsealedVideoRestartFromJobId &&
    (authorization.continuation_run_id || authorization.resumed_from_job_id)
  ) {
    return rejectReservedJob(
      env,
      auth.userId,
      purchaseId,
      fighterId,
      'Unsealed Video restart requires a fresh authorization; the unused reservation was released',
      409,
      { code: 'unsealed_video_restart_authorization_not_fresh' },
    );
  }
  const lockedVideoRun = await env.DB.prepare(`
    SELECT id, root_job_id
    FROM generation_artifact_runs
    WHERE fighter_id = ? AND user_id = ? AND creation_flow = 'video' AND status = 'partial'
    ORDER BY updated_at DESC
    LIMIT 1
  `).bind(fighterId, auth.userId).first<{ id: string; root_job_id: string }>();
  const restartingLockedUnsealedRun = Boolean(
    unsealedVideoRestartFromJobId &&
    eligibleUnsealedVideoRestart?.run_id === lockedVideoRun?.id &&
    lockedVideoRun?.root_job_id === unsealedVideoRestartFromJobId,
  );
  if (
    lockedVideoRun &&
    authorization.continuation_run_id !== lockedVideoRun.id &&
    !restartingLockedUnsealedRun
  ) {
    return rejectReservedJob(
      env,
      auth.userId,
      purchaseId,
      fighterId,
      'Continue the current review-gated video run before starting another generation',
      409,
      { code: 'video_run_in_progress' },
    );
  }
  if (authorization.continuation_run_id) {
    if (creationFlow === 'video' && options.videoGenerationPolicy) {
      const resumedPolicy = storedVideoGenerationPolicy(
        authorization.resume_run_video_generation_policy,
      );
      if (resumedPolicy !== options.videoGenerationPolicy) {
        return rejectReservedJob(
          env,
          auth.userId,
          purchaseId,
          fighterId,
          'Video generation policy cannot change during a continuation',
          409,
          { code: 'video_generation_policy_continuation_mismatch' },
        );
      }
    }
    const validResumeState = creationFlow === 'video'
      ? (
          (authorization.resume_job_status === 'failed' || authorization.resume_job_status === 'cancelled') &&
          authorization.resume_candidate_status === null
        ) || (
          authorization.resume_job_status === 'succeeded' &&
          authorization.resume_job_review_status === 'approved' &&
          authorization.resume_candidate_status === 'approved' &&
          authorization.resume_candidate_current_revision === authorization.resume_candidate_approved_revision &&
          Boolean(authorization.resume_candidate_report_sha256) &&
          (authorization.resume_run_approved_action_count ?? 0) < VIDEO_SPRITE_ACTIONS.length
        )
      : authorization.resume_job_status === 'failed' || authorization.resume_job_status === 'cancelled';
    const validContinuation =
      authorization.resume_run_user_id === auth.userId &&
      authorization.resume_run_fighter_id === fighterId &&
      authorization.resume_run_tier === authorization.charge_tier &&
      authorization.resume_run_creation_flow === creationFlow &&
      authorization.resume_run_operation === operation &&
      authorization.resume_run_status === 'partial' &&
      authorization.resume_run_target_kind === targetKind &&
      authorization.resume_run_target_name === targetName &&
      Boolean(authorization.resumed_from_job_id) &&
      validResumeState &&
      (creationFlow !== 'video' || (
        operation === 'fighter_generation' &&
        authorization.resume_run_operation === 'fighter_generation' &&
        (authorization.resume_run_approved_action_count ?? 0) < VIDEO_SPRITE_ACTIONS.length
      )) &&
      (creationFlow !== 'video' || authorization.resume_child_job_id === null);
    if (!validContinuation) {
      return rejectReservedJob(
        env,
        auth.userId,
        purchaseId,
        fighterId,
        'Generation continuation no longer matches preserved work; the unused reservation was released',
        409,
      );
    }
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
  let capacity;
  try {
    capacity = await activeGenerationCapacity(env, operation, authorization.charge_tier);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'provider_capacity_read_failed',
      operation,
      tier: authorization.charge_tier,
      error: error instanceof Error ? error.message : String(error),
    }));
    return rejectReservedJob(
      env,
      auth.userId,
      purchaseId,
      fighterId,
      'Image generation capacity could not be verified; the unused reservation was released',
      503,
      { code: 'provider_capacity_unavailable' },
    );
  }
  if (capacity) {
    return rejectReservedJob(
      env,
      auth.userId,
      purchaseId,
      fighterId,
      'Image generation is temporarily at daily capacity; the unused reservation was released',
      503,
      {
        code: 'provider_daily_quota_exhausted',
        provider: capacity.provider,
        model: capacity.model,
        retryAt: new Date(capacity.retryAtEpoch * 1_000).toISOString(),
      },
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
      creationFlow,
    )) {
      return replayExistingJob(env, auth.userId, activeFighterJob);
    }
    await settleGenerationPurchase(env, auth.userId, purchaseId, false, fighterId);
    return json({
      error: 'A generation is already running for this fighter; the unused reservation was released',
      job: await serializeOwnedJob(env, activeFighterJob, await getJobEvents(env, activeFighterJob.id)),
    }, 409);
  }

  const jobId = purchaseId;
  const progressTotal = operation === 'fighter_generation'
    ? 14
    : operation === 'fighter_upgrade'
      ? 11
      : 1;
  const runId = authorization.continuation_run_id ?? jobId;
  const resumedFromJobId = authorization.resumed_from_job_id ?? null;
  const videoGenerationPolicy = creationFlow === 'video'
    ? authorization.continuation_run_id
      ? storedVideoGenerationPolicy(authorization.resume_run_video_generation_policy)
      : options.videoGenerationPolicy ?? SELF_SERVICE_VIDEO_POLICY
    : null;
  const initialProgress = authorization.continuation_run_id
    ? (await env.DB.prepare(`
        SELECT COUNT(*) AS count
        FROM generation_artifact_checkpoints
        WHERE run_id = ? AND status = 'approved'
      `).bind(runId).first<{ count: number }>())?.count ?? 0
    : 0;
  const sourceManifest = JSON.stringify(generationSourceManifest({
    side: authorization.side_view_blob_key,
    sideRaw: authorization.side_view_raw_blob_key,
    upright: authorization.upright_view_blob_key,
    uprightRaw: authorization.upright_view_raw_blob_key,
    crouch: authorization.crouch_view_blob_key,
    crouchRaw: authorization.crouch_view_raw_blob_key,
  }, reviewedCanonicalSources));
  const extendedExpiry = new Date(Date.now() + JOB_TTL_HOURS * 60 * 60 * 1_000).toISOString();
  const restartAuditEventId = unsealedVideoRestartFromJobId ? generateId() : null;
  const restartGuardBindings = [
    restartAuditEventId,
    restartAuditEventId ?? '',
    unsealedVideoRestartFromJobId,
  ] as const;
  try {
    await env.DB.batch([
      ...(restartAuditEventId ? [
        prepareUnsealedVideoRestartAudit(env, {
          eventId: restartAuditEventId,
          userId: auth.userId,
          fighterId,
          recoveryFromJobId: unsealedVideoRestartFromJobId,
          newJobId: jobId,
        }),
        prepareUnsealedVideoRestartRetirement(env, {
          auditEventId: restartAuditEventId,
          userId: auth.userId,
          fighterId,
          recoveryFromJobId: unsealedVideoRestartFromJobId,
        }),
      ] : []),
      env.DB.prepare(`
        INSERT INTO generation_artifact_runs (
          id, user_id, fighter_id, tier, operation, target_kind, target_name,
          root_job_id, original_charge_id, original_blob_key,
          source_manifest_json, generation_prompt, creation_flow, video_generation_policy
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ? IS NULL
          AND (
            ? IS NULL OR EXISTS (
              SELECT 1 FROM generation_job_events restart_audit
              WHERE restart_audit.id = ?
                AND restart_audit.job_id = ?
                AND restart_audit.stage = 'restart:full'
            )
          )
      `).bind(
        runId,
        auth.userId,
        fighterId,
        authorization.charge_tier,
        operation,
        targetKind,
        targetName,
        jobId,
        purchaseId,
        authorization.original_blob_key,
        sourceManifest,
        authorization.generation_prompt,
        creationFlow,
        videoGenerationPolicy,
        authorization.continuation_run_id,
        ...restartGuardBindings,
      ),
      env.DB.prepare(`
        UPDATE generation_artifact_runs
        SET status = 'active', failure_stage = NULL, updated_at = datetime('now')
        WHERE id = ? AND user_id = ? AND fighter_id = ?
          AND status = 'partial' AND ? IS NOT NULL
      `).bind(runId, auth.userId, fighterId, authorization.continuation_run_id),
      env.DB.prepare(`
        INSERT INTO generation_jobs (
          id, workflow_instance_id, user_id, fighter_id, charge_id,
          provider_session_id, tier, operation, target_kind, target_name,
          artifact_run_id, resumed_from_job_id, progress_current, progress_total,
          creation_flow
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ? IS NULL OR EXISTS (
          SELECT 1 FROM generation_job_events restart_audit
          WHERE restart_audit.id = ?
            AND restart_audit.job_id = ?
            AND restart_audit.stage = 'restart:full'
        )
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
        runId,
        resumedFromJobId,
        Math.min(initialProgress, progressTotal),
        progressTotal,
        creationFlow,
        ...restartGuardBindings,
      ),
      env.DB.prepare(`
        UPDATE generation_charges
        SET fighter_id = COALESCE(fighter_id, ?), expires_at = ?, updated_at = datetime('now')
        WHERE id = ? AND user_id = ? AND status = 'reserved'
          AND (
            ? IS NULL OR EXISTS (
              SELECT 1 FROM generation_job_events restart_audit
              WHERE restart_audit.id = ?
                AND restart_audit.job_id = ?
                AND restart_audit.stage = 'restart:full'
            )
          )
      `).bind(fighterId, extendedExpiry, purchaseId, auth.userId, ...restartGuardBindings),
      env.DB.prepare(`
        UPDATE provider_sessions
        SET expires_at = ?, updated_at = datetime('now')
        WHERE id = ? AND user_id = ? AND status = 'active'
          AND (
            ? IS NULL OR EXISTS (
              SELECT 1 FROM generation_job_events restart_audit
              WHERE restart_audit.id = ?
                AND restart_audit.job_id = ?
                AND restart_audit.stage = 'restart:full'
            )
          )
      `).bind(extendedExpiry, providerSessionId, auth.userId, ...restartGuardBindings),
      env.DB.prepare(`
        INSERT INTO generation_job_events (id, job_id, stage, status, detail)
        SELECT ?, ?, 'queued', 'queued', ?
        WHERE ? IS NULL OR EXISTS (
          SELECT 1 FROM generation_job_events restart_audit
          WHERE restart_audit.id = ?
            AND restart_audit.job_id = ?
            AND restart_audit.stage = 'restart:full'
        )
      `).bind(
        generateId(),
        jobId,
        unsealedVideoRestartFromJobId
          ? `Fresh reviewed Video root accepted after audited restart of ${unsealedVideoRestartFromJobId}`
          : resumedFromJobId
          ? `Generation continuation accepted; ${initialProgress} immutable stages preserved`
          : targetName
            ? `${operation} ${targetName} accepted by the backend`
            : 'Generation accepted by the backend',
        ...restartGuardBindings,
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
    if (matchesJobRequest(
      racedJob,
      fighterId,
      purchaseId,
      providerSessionId,
      targetKind,
      targetName,
      creationFlow,
    )) {
      return replayExistingJob(env, auth.userId, racedJob);
    }
    await settleGenerationPurchase(env, auth.userId, purchaseId, false, fighterId);
    return json({
      error: 'A generation is already running for this fighter; the unused reservation was released',
      job: await serializeOwnedJob(env, racedJob, await getJobEvents(env, racedJob.id)),
    }, 409);
  }

  if (unsealedVideoRestartFromJobId) {
    const restartedJob = await env.DB.prepare(`
      SELECT id FROM generation_jobs
      WHERE id = ? AND user_id = ? AND fighter_id = ?
        AND artifact_run_id = ? AND creation_flow = 'video'
      LIMIT 1
    `).bind(jobId, auth.userId, fighterId, jobId).first<{ id: string }>();
    if (!restartedJob) {
      return rejectReservedJob(
        env,
        auth.userId,
        purchaseId,
        fighterId,
        'Unsealed Video restart state changed; the unused reservation was released',
        409,
        { code: 'unsealed_video_restart_state_changed' },
      );
    }
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
        SET status = 'failed', stage = 'workflow:start', failure_stage = 'workflow:start',
            error_code = 'workflow_start_failed',
            error_message = 'Generation could not start external processing; the unused reservation was released',
            finished_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND status = 'queued'
      `).bind(jobId),
      env.DB.prepare(`
        UPDATE generation_artifact_runs
        SET status = CASE WHEN ? IS NULL THEN 'failed' ELSE 'partial' END,
            failure_stage = 'workflow:start', updated_at = datetime('now')
        WHERE id = ?
      `).bind(authorization.continuation_run_id, runId),
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
  return json({ job: await serializeOwnedJob(env, job, await getJobEvents(env, job.id)) }, 202);
}

export async function getGenerationJob(
  env: Env,
  auth: AuthContext,
  jobId: string,
): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(jobId)) return json({ error: 'Generation job not found' }, 404);
  const job = await getOwnedJob(env, auth.userId, jobId);
  if (!job) return json({ error: 'Generation job not found' }, 404);
  return json({ job: await serializeOwnedJob(env, job, await getJobEvents(env, job.id)) });
}

export async function listGenerationJobs(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const fighterId = new URL(request.url).searchParams.get('fighterId');
  if (fighterId !== null && !/^[a-f0-9]{32}$/.test(fighterId)) {
    return json({ error: 'A valid fighterId filter is required' }, 400);
  }
  const statement = fighterId === null
    ? env.DB.prepare(`
        SELECT * FROM generation_jobs
        WHERE user_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 20
      `).bind(auth.userId)
    : env.DB.prepare(`
        SELECT * FROM generation_jobs
        WHERE user_id = ? AND fighter_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 100
      `).bind(auth.userId, fighterId);
  const { results } = await statement.all<GenerationJob>();
  return json({ jobs: await Promise.all((results ?? []).map((job) => serializeOwnedJob(env, job))) });
}
