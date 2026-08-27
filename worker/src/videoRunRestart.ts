import type { Env } from './types';

export const UNSEALED_VIDEO_RESTART_FAILURE_STAGE =
  'restart:terminal-unsealed-zero-checkpoint';
export const UNSEALED_VIDEO_RESTART_AUDIT_STAGE = 'restart:full';

interface UnsealedVideoRestartRow {
  run_id: string;
}

// This intentionally recognizes only the pre-reviewed Video root shape. Any
// sealed source identity, preserved artifact, review candidate, continuation,
// live provider state, or ambiguous cost record keeps the run immutable.
const ELIGIBLE_UNSEALED_VIDEO_RESTART_FROM = `
  FROM generation_jobs recovery
  JOIN generation_artifact_runs run
    ON run.id = recovery.artifact_run_id
  JOIN generation_charges charge
    ON charge.id = recovery.charge_id
  JOIN provider_sessions provider_session
    ON provider_session.id = recovery.provider_session_id
    AND provider_session.charge_id = charge.id
    AND provider_session.user_id = recovery.user_id
  WHERE recovery.id = ?
    AND recovery.user_id = ?
    AND recovery.fighter_id = ?
    AND recovery.creation_flow = 'video'
    AND recovery.tier = 'champion'
    AND recovery.operation = 'fighter_generation'
    AND recovery.target_kind IS NULL
    AND recovery.target_name IS NULL
    AND recovery.status IN ('failed', 'cancelled')
    AND recovery.review_status = 'none'
    AND recovery.id = (
      SELECT latest.id
      FROM generation_jobs latest
      WHERE latest.user_id = recovery.user_id
        AND latest.fighter_id = recovery.fighter_id
        AND latest.creation_flow = 'video'
        AND latest.operation = 'fighter_generation'
      ORDER BY latest.created_at DESC, latest.rowid DESC
      LIMIT 1
    )
    AND run.root_job_id = recovery.id
    AND run.user_id = recovery.user_id
    AND run.fighter_id = recovery.fighter_id
    AND run.tier = 'champion'
    AND run.creation_flow = 'video'
    AND run.operation = 'fighter_generation'
    AND run.target_kind IS NULL
    AND run.target_name IS NULL
    AND run.status = 'partial'
    AND CASE
      WHEN run.source_manifest_json IS NULL THEN 1
      WHEN json_valid(run.source_manifest_json) = 1
        THEN json_type(run.source_manifest_json, '$.reviewedCanonicalSources') IS NULL
      ELSE 0
    END = 1
    AND run.original_charge_id = charge.id
    AND charge.user_id = recovery.user_id
    AND charge.fighter_id = recovery.fighter_id
    AND charge.tier = 'champion'
    AND charge.status = 'committed'
    AND charge.creation_flow = 'video'
    AND provider_session.tier = 'champion'
    AND provider_session.purpose = 'fighter_generation'
    AND provider_session.creation_flow = 'video'
    AND provider_session.status IN ('completed', 'cancelled')
    AND NOT EXISTS (
      SELECT 1
      FROM provider_sessions other_session
      WHERE other_session.charge_id = charge.id
        AND other_session.id <> provider_session.id
    )
    AND provider_session.provider_calls_used = (
      SELECT COUNT(*)
      FROM provider_cost_events accounted_call
      WHERE (
        accounted_call.artifact_run_id = run.id
        OR accounted_call.job_id = recovery.id
      )
        AND accounted_call.upstream_outcome IN ('http_succeeded', 'http_failed')
    )
    AND provider_session.provider_cost_used_cents = (
      SELECT COALESCE(SUM(accounted_cost.estimated_cost_cents), 0)
      FROM provider_cost_events accounted_cost
      WHERE (
        accounted_cost.artifact_run_id = run.id
        OR accounted_cost.job_id = recovery.id
      )
        AND accounted_cost.upstream_outcome IN ('http_succeeded', 'http_failed')
    )
    AND EXISTS (
      SELECT 1
      FROM provider_cost_events committed_dispatch
      WHERE committed_dispatch.artifact_run_id = run.id
        AND committed_dispatch.job_id = recovery.id
        AND committed_dispatch.session_id = provider_session.id
        AND committed_dispatch.charge_id = charge.id
        AND committed_dispatch.estimated_cost_cents > 0
        AND committed_dispatch.outcome IN ('succeeded', 'failed')
        AND committed_dispatch.upstream_outcome IN ('http_succeeded', 'http_failed')
        AND committed_dispatch.finalized_at IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM generation_jobs active_job
      WHERE active_job.fighter_id = recovery.fighter_id
        AND active_job.status IN ('queued', 'running')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM generation_artifact_runs competing_run
      WHERE competing_run.user_id = recovery.user_id
        AND competing_run.fighter_id = recovery.fighter_id
        AND competing_run.creation_flow = 'video'
        AND competing_run.status IN ('active', 'partial')
        AND competing_run.id <> run.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM generation_jobs sibling
      WHERE sibling.artifact_run_id = run.id
        AND sibling.id <> recovery.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM generation_jobs child
      WHERE child.resumed_from_job_id = recovery.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM generation_charges extra_charge
      WHERE extra_charge.id <> charge.id
        AND extra_charge.status IN ('reserved', 'committed')
        AND (
          extra_charge.continuation_run_id = run.id
          OR extra_charge.resumed_from_job_id = recovery.id
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM generation_artifact_checkpoints checkpoint
      WHERE checkpoint.run_id = run.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM video_sprite_candidates candidate
      WHERE candidate.run_id = run.id
        OR candidate.job_id = recovery.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM provider_request_cache provider_request
      WHERE (
        provider_request.artifact_run_id = run.id
        OR provider_request.job_id = recovery.id
      )
        AND provider_request.status NOT IN ('succeeded', 'failed')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM provider_request_cache correlated_request
      WHERE (
        correlated_request.artifact_run_id = run.id
        OR correlated_request.job_id = recovery.id
      )
        AND (
          correlated_request.artifact_run_id IS NOT run.id
          OR correlated_request.job_id IS NOT recovery.id
          OR correlated_request.request_key IS NULL
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM provider_request_cache terminal_request
      WHERE (
        terminal_request.artifact_run_id = run.id
        OR terminal_request.job_id = recovery.id
      )
        AND terminal_request.status IN ('succeeded', 'failed')
        AND NOT EXISTS (
          SELECT 1
          FROM provider_cost_events terminal_cost
          WHERE terminal_cost.request_key = terminal_request.request_key
            AND (
              terminal_cost.artifact_run_id = run.id
              OR terminal_cost.job_id = recovery.id
            )
            AND terminal_cost.outcome IN ('succeeded', 'failed')
            AND terminal_cost.upstream_outcome IN (
              'http_succeeded', 'http_failed', 'not_dispatched'
            )
            AND terminal_cost.stage_outcome IN ('succeeded', 'failed')
            AND terminal_cost.job_outcome IN (
              'failed', 'failed_partial', 'cancelled'
            )
            AND terminal_cost.finalized_at IS NOT NULL
            AND (
              (terminal_request.status = 'succeeded' AND terminal_cost.outcome = 'succeeded')
              OR (terminal_request.status = 'failed' AND terminal_cost.outcome = 'failed')
            )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM provider_cost_events cost_event
      WHERE (
        cost_event.artifact_run_id = run.id
        OR cost_event.job_id = recovery.id
      )
        AND (
          cost_event.outcome NOT IN ('succeeded', 'failed')
          OR cost_event.upstream_outcome NOT IN (
            'http_succeeded', 'http_failed', 'not_dispatched'
          )
          OR cost_event.stage_outcome NOT IN ('succeeded', 'failed')
          OR cost_event.job_outcome NOT IN (
            'failed', 'failed_partial', 'cancelled'
          )
          OR NOT (
            (cost_event.outcome = 'succeeded' AND cost_event.upstream_outcome = 'http_succeeded')
            OR (
              cost_event.outcome = 'failed'
              AND cost_event.upstream_outcome IN ('http_failed', 'not_dispatched')
            )
          )
          OR cost_event.finalized_at IS NULL
          OR (cost_event.estimated_cost_cents > 0 AND cost_event.request_key IS NULL)
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM provider_cost_events correlated_cost
      WHERE (
        correlated_cost.artifact_run_id = run.id
        OR correlated_cost.job_id = recovery.id
      )
        AND (
          correlated_cost.artifact_run_id IS NOT run.id
          OR correlated_cost.job_id IS NOT recovery.id
          OR correlated_cost.session_id IS NOT provider_session.id
          OR correlated_cost.charge_id IS NOT charge.id
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM provider_cost_events committed_cost
      WHERE (
        committed_cost.artifact_run_id = run.id
        OR committed_cost.job_id = recovery.id
      )
        AND committed_cost.estimated_cost_cents > 0
        AND NOT EXISTS (
          SELECT 1
          FROM provider_request_cache terminal_request
          WHERE terminal_request.request_key = committed_cost.request_key
            AND (
              terminal_request.artifact_run_id = run.id
              OR terminal_request.job_id = recovery.id
            )
            AND terminal_request.status IN ('succeeded', 'failed')
        )
    )
`;

export async function readEligibleUnsealedVideoPartialRestart(
  env: Env,
  userId: string,
  fighterId: string,
  recoveryFromJobId: string,
): Promise<UnsealedVideoRestartRow | null> {
  return env.DB.prepare(`
    SELECT run.id AS run_id
    ${ELIGIBLE_UNSEALED_VIDEO_RESTART_FROM}
    LIMIT 1
  `).bind(recoveryFromJobId, userId, fighterId).first<UnsealedVideoRestartRow>();
}

export function prepareUnsealedVideoRestartAudit(
  env: Env,
  params: {
    eventId: string;
    userId: string;
    fighterId: string;
    recoveryFromJobId: string;
    newJobId: string;
  },
): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO generation_job_events (id, job_id, stage, status, detail)
    SELECT ?, recovery.id, ?, 'failed', ?
    ${ELIGIBLE_UNSEALED_VIDEO_RESTART_FROM}
  `).bind(
    params.eventId,
    UNSEALED_VIDEO_RESTART_AUDIT_STAGE,
    `Explicit reviewed Video restart retired terminal unsealed zero-checkpoint run before fresh root ${params.newJobId}`,
    params.recoveryFromJobId,
    params.userId,
    params.fighterId,
  );
}

export function prepareUnsealedVideoRestartRetirement(
  env: Env,
  params: {
    auditEventId: string;
    userId: string;
    fighterId: string;
    recoveryFromJobId: string;
  },
): D1PreparedStatement {
  return env.DB.prepare(`
    UPDATE generation_artifact_runs
    SET status = 'failed',
        failure_stage = ?,
        completed_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = (
      SELECT artifact_run_id
      FROM generation_jobs
      WHERE id = ? AND user_id = ? AND fighter_id = ?
      LIMIT 1
    )
      AND status = 'partial'
      AND EXISTS (
        SELECT 1
        FROM generation_job_events audit_event
        WHERE audit_event.id = ?
          AND audit_event.job_id = ?
          AND audit_event.stage = ?
      )
  `).bind(
    UNSEALED_VIDEO_RESTART_FAILURE_STAGE,
    params.recoveryFromJobId,
    params.userId,
    params.fighterId,
    params.auditEventId,
    params.recoveryFromJobId,
    UNSEALED_VIDEO_RESTART_AUDIT_STAGE,
  );
}
