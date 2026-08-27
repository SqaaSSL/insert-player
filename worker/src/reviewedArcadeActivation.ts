import { readJsonBody } from './requestBody';
import { requireReviewedProductionWorkerPin } from './reviewedDeploymentPin';
import {
  ReviewedVideoActivationError,
  verifyReviewedVideoRunForActivation,
} from './videoSpriteReview';
import type { AuthContext, Env } from './types';

const MAX_ACTIVATION_BODY_BYTES = 4 * 1024;

interface ReviewedActivationBody {
  finalJobId?: unknown;
  arcadeUpdatedAt?: unknown;
  fighterUpdatedAt?: unknown;
}

interface ReviewedActivationStateRow {
  arcade_status: string;
  arcade_updated_at: string;
  fighter_updated_at: string;
  public_flag: number;
  quality_tier: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function exactTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) return null;
  return value;
}

// Every mutable D1 value validated below is captured in one deterministic JSON
// seal. Re-reading that exact seal inside both publication writes gives the
// batch an atomic compare-and-swap without relying on second-resolution dates.
const REVIEWED_VIDEO_DB_SEAL_SQL = `
  SELECT json_array(
    json_array(
      run.id, run.user_id, run.fighter_id, run.tier, run.creation_flow,
      run.operation, run.target_kind, run.target_name, run.root_job_id,
      run.source_manifest_json, run.status, run.failure_stage, run.completed_at,
      run.updated_at
    ),
    (
      SELECT COALESCE(json_group_array(candidate_row), '[]')
      FROM (
        SELECT json_array(
          json_array(
            candidate.id, candidate.run_id, candidate.job_id, candidate.user_id,
            candidate.fighter_id, candidate.action, candidate.sequence_order,
            candidate.status, candidate.current_revision, candidate.approved_revision,
            candidate.adjustment_claim_token, candidate.adjustment_claim_revision,
            candidate.adjustment_claim_indices_json, candidate.reviewed_at,
            candidate.reviewed_by_user_id, candidate.review_reason
          ),
          json_array(
            job.id, job.user_id, job.fighter_id, job.tier, job.creation_flow,
            job.operation, job.target_kind, job.target_name, job.artifact_run_id,
            job.resumed_from_job_id, job.status, job.review_status, job.stage,
            job.failure_stage, job.progress_current, job.progress_total,
            job.error_code, job.error_message, job.updated_at
          ),
          json_array(
            revision.candidate_id, revision.revision, revision.compiler_outcome,
            revision.semantic_promotion_approved, revision.sprite_version_id,
            revision.provider_model, revision.pixcli_job_id,
            revision.provider_request_id, revision.prompt_sha256,
            revision.canonical_blob_key, revision.canonical_sha256,
            revision.provider_audit_blob_key, revision.provider_audit_sha256,
            revision.video_blob_key, revision.video_sha256, revision.video_size_bytes,
            revision.processed_blob_key, revision.processed_sha256,
            revision.raw_blob_key, revision.raw_sha256,
            revision.contact_sheet_blob_key, revision.contact_sheet_sha256,
            revision.unique_sheet_blob_key, revision.unique_sheet_sha256,
            revision.report_blob_key, revision.report_sha256,
            revision.report_content_sha256, revision.frame_w, revision.frame_h,
            revision.frame_count, revision.raw_frame_w, revision.raw_frame_h,
            revision.raw_frame_count, revision.source_frame_count,
            revision.animation_format, revision.processing_version,
            revision.selected_indices_json, revision.playback_json,
            revision.translations_json
          ),
          json_array(
            version.id, version.fighter_id, version.animation_name,
            version.quality_tier, version.blob_key, version.raw_blob_key,
            version.content_hash, version.raw_content_hash, version.frame_w,
            version.frame_h, version.frame_count, version.animation_format,
            version.processing_version
          ),
          json_array(
            current.id, current.fighter_id, current.animation_name,
            current.quality_tier, current.blob_key, current.raw_blob_key,
            current.content_hash, current.raw_content_hash, current.frame_w,
            current.frame_h, current.frame_count, current.animation_format,
            current.processing_version
          )
        ) AS candidate_row
        FROM video_sprite_candidates candidate
        LEFT JOIN generation_jobs job ON job.id = candidate.job_id
        LEFT JOIN video_sprite_candidate_revisions revision
          ON revision.candidate_id = candidate.id
          AND revision.revision = candidate.current_revision
        LEFT JOIN sprite_versions version ON version.id = revision.sprite_version_id
        LEFT JOIN sprites current
          ON current.fighter_id = candidate.fighter_id
          AND current.animation_name = candidate.action
          AND current.quality_tier = 'champion'
        WHERE candidate.run_id = run.id
        ORDER BY candidate.sequence_order ASC, candidate.id ASC
      )
    ),
    (
      SELECT COALESCE(json_group_array(job_row), '[]')
      FROM (
        SELECT json_array(
          job.id, job.user_id, job.fighter_id, job.tier, job.creation_flow,
          job.operation, job.target_kind, job.target_name, job.artifact_run_id,
          job.resumed_from_job_id, job.status, job.review_status, job.stage,
          job.failure_stage, job.progress_current, job.progress_total,
          job.error_code, job.error_message, job.updated_at
        ) AS job_row
        FROM generation_jobs job
        WHERE job.artifact_run_id = run.id
        ORDER BY job.id ASC
      )
    ),
    (
      SELECT COALESCE(json_group_array(checkpoint_row), '[]')
      FROM (
        SELECT json_array(
          checkpoint.run_id, checkpoint.artifact_kind, checkpoint.artifact_name,
          checkpoint.stage_index, checkpoint.tier, checkpoint.status,
          checkpoint.clean_version_id, checkpoint.raw_version_id,
          checkpoint.clean_blob_key, checkpoint.raw_blob_key,
          checkpoint.clean_content_hash, checkpoint.raw_content_hash,
          checkpoint.frame_w, checkpoint.frame_h, checkpoint.frame_count,
          checkpoint.animation_format, checkpoint.processing_version,
          checkpoint.completed_by_job_id, checkpoint.verified_at
        ) AS checkpoint_row
        FROM generation_artifact_checkpoints checkpoint
        WHERE checkpoint.run_id = run.id
        ORDER BY checkpoint.stage_index ASC, checkpoint.artifact_kind ASC,
          checkpoint.artifact_name ASC
      )
    )
  ) AS seal
  FROM generation_artifact_runs run
  WHERE run.id = ?
  LIMIT 1
`;

async function reviewedVideoDbSeal(env: Env, runId: string): Promise<string> {
  const row = await env.DB.prepare(REVIEWED_VIDEO_DB_SEAL_SQL)
    .bind(runId).first<{ seal: string }>();
  if (!row?.seal) throw new ReviewedVideoActivationError('Reviewed Video run seal is unavailable');
  return row.seal;
}

async function reviewedVideoRunIdForFinalJob(
  env: Env,
  userId: string,
  fighterId: string,
  finalJobId: string,
): Promise<string> {
  const row = await env.DB.prepare(`
    SELECT candidate.run_id
    FROM video_sprite_candidates candidate
    JOIN generation_jobs job ON job.id = candidate.job_id
    WHERE candidate.job_id = ? AND candidate.user_id = ? AND candidate.fighter_id = ?
      AND job.user_id = ? AND job.fighter_id = ?
    LIMIT 1
  `).bind(finalJobId, userId, fighterId, userId, fighterId)
    .first<{ run_id: string }>();
  if (!row?.run_id) {
    throw new ReviewedVideoActivationError('Completed reviewed Video run not found', 404);
  }
  return row.run_id;
}

const REVIEWED_VIDEO_DB_SEAL_UNCHANGED = `
  (${REVIEWED_VIDEO_DB_SEAL_SQL}) = ?
`;

export async function activateReviewedVideoArcadeFighter(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
): Promise<Response> {
  if (auth.user.plan_tier !== 'admin') return json({ error: 'Admin access required' }, 403);
  if (!/^[a-f0-9]{32}$/.test(fighterId)) {
    return json({ error: 'A valid fighterId is required' }, 400);
  }
  const deploymentPinFailure = requireReviewedProductionWorkerPin(request, env);
  if (deploymentPinFailure) return deploymentPinFailure;

  const body = await readJsonBody<ReviewedActivationBody>(request, MAX_ACTIVATION_BODY_BYTES);
  const finalJobId = typeof body.finalJobId === 'string' ? body.finalJobId : '';
  const arcadeUpdatedAt = exactTimestamp(body.arcadeUpdatedAt);
  const fighterUpdatedAt = exactTimestamp(body.fighterUpdatedAt);
  if (!/^[a-f0-9]{32}$/.test(finalJobId) || !arcadeUpdatedAt || !fighterUpdatedAt) {
    return json({
      error: 'Exact finalJobId, arcadeUpdatedAt, and fighterUpdatedAt bindings are required',
    }, 400);
  }

  let provenance;
  let originalDatabaseSeal: string;
  let requestedRunId: string;
  try {
    requestedRunId = await reviewedVideoRunIdForFinalJob(
      env, auth.userId, fighterId, finalJobId,
    );
    originalDatabaseSeal = await reviewedVideoDbSeal(env, requestedRunId);
    provenance = await verifyReviewedVideoRunForActivation(
      env, auth, fighterId, finalJobId,
    );
  } catch (error) {
    if (error instanceof ReviewedVideoActivationError) {
      return json({ error: error.message }, error.status);
    }
    return json({
      error: error instanceof Error ? error.message : 'Reviewed Video provenance failed',
    }, 409);
  }
  if (provenance.artifactRunId !== requestedRunId) {
    return json({ error: 'Reviewed Video run identity changed during verification' }, 409);
  }

  const state = await env.DB.prepare(`
    SELECT arcade.status AS arcade_status, arcade.updated_at AS arcade_updated_at,
      fighter.updated_at AS fighter_updated_at, fighter.public_flag, fighter.quality_tier
    FROM arcade_fighters arcade
    JOIN fighters fighter ON fighter.id = arcade.fighter_id
    WHERE arcade.fighter_id = ? AND fighter.owner_user_id = ?
    LIMIT 1
  `).bind(fighterId, auth.userId).first<ReviewedActivationStateRow>();
  if (
    !state || state.arcade_status !== 'draft' || state.public_flag !== 0 ||
    state.quality_tier !== 'champion' || state.arcade_updated_at !== arcadeUpdatedAt ||
    state.fighter_updated_at !== fighterUpdatedAt
  ) {
    return json({
      error: 'Reviewed Arcade draft changed after operator verification; reload before activation',
    }, 409);
  }

  let verifiedDatabaseSeal: string;
  try {
    verifiedDatabaseSeal = await reviewedVideoDbSeal(env, provenance.artifactRunId);
  } catch (error) {
    if (error instanceof ReviewedVideoActivationError) {
      return json({ error: error.message }, error.status);
    }
    throw error;
  }
  if (verifiedDatabaseSeal !== originalDatabaseSeal) {
    return json({
      error: 'Reviewed Video provenance changed during integrity verification; fighter was not published',
    }, 409);
  }

  const activationTimestamp = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE arcade_fighters
      SET status = 'active', updated_at = ?
      WHERE fighter_id = ? AND status = 'draft' AND updated_at = ?
        AND EXISTS (
          SELECT 1 FROM fighters fighter
          WHERE fighter.id = ? AND fighter.owner_user_id = ?
            AND fighter.public_flag = 0 AND fighter.quality_tier = 'champion'
            AND fighter.updated_at = ?
        )
        AND ${REVIEWED_VIDEO_DB_SEAL_UNCHANGED}
    `).bind(
      activationTimestamp, fighterId, arcadeUpdatedAt, fighterId, auth.userId, fighterUpdatedAt,
      provenance.artifactRunId, originalDatabaseSeal,
    ),
    env.DB.prepare(`
      UPDATE fighters
      SET public_flag = 1, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND public_flag = 0
        AND quality_tier = 'champion' AND updated_at = ?
        AND EXISTS (
          SELECT 1 FROM arcade_fighters arcade
          WHERE arcade.fighter_id = fighters.id AND arcade.status = 'active'
            AND arcade.updated_at = ?
        )
        AND ${REVIEWED_VIDEO_DB_SEAL_UNCHANGED}
    `).bind(
      activationTimestamp, fighterId, auth.userId, fighterUpdatedAt, activationTimestamp,
      provenance.artifactRunId, originalDatabaseSeal,
    ),
  ]);
  if (
    (results[0]?.meta.changes ?? 0) !== 1 ||
    (results[1]?.meta.changes ?? 0) !== 1
  ) {
    return json({
      error: 'Reviewed Video provenance changed concurrently; fighter was not published',
    }, 409);
  }

  return json({
    fighter: { fighterId, status: 'active', public: true },
    provenance,
  });
}
