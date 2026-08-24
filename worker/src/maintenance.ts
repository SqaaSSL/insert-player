import { generateId } from './auth';
import { settleGenerationPurchase } from './billing';
import type { Env } from './types';

interface StaleGenerationJobRow {
  id: string;
  user_id: string;
  charge_id: string;
  fighter_id: string;
  stage: string;
}

interface ProviderCacheObjectRow {
  id: string;
  response_blob_key: string;
}

export async function cleanupOperationalData(env: Env): Promise<void> {
  const { results: staleJobs } = await env.DB.prepare(`
    SELECT id, user_id, charge_id, fighter_id, stage
    FROM generation_jobs
    WHERE status IN ('queued', 'running')
      AND datetime(updated_at) <= datetime('now', '-4 days')
    ORDER BY updated_at ASC
    LIMIT 50
  `).all<StaleGenerationJobRow>();
  for (const job of staleJobs ?? []) {
    const settlement = await settleGenerationPurchase(env, job.user_id, job.charge_id, false, job.fighter_id);
    const releasedBeforeProviderStart = settlement?.status === 'refunded';
    const failureStage = ['queued', 'initializing'].includes(job.stage) ? 'job:stalled' : job.stage;
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE generation_jobs
        SET status = 'failed', stage = ?, failure_stage = ?, error_code = 'job_stalled',
            error_message = ?,
            finished_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND status IN ('queued', 'running')
      `).bind(
        failureStage,
        failureStage,
        releasedBeforeProviderStart
          ? 'Generation never reached external processing; the unused reservation was released'
          : 'Generation stalled after external processing began; contact support if it cannot be repaired',
        job.id,
      ),
      env.DB.prepare(`
        INSERT INTO generation_job_events (id, job_id, stage, status, detail)
        SELECT ?, ?, ?, 'failed', 'Stale cloud job closed by maintenance'
        WHERE EXISTS (SELECT 1 FROM generation_jobs WHERE id = ? AND status = 'failed')
      `).bind(generateId(), job.id, failureStage, job.id),
      env.DB.prepare(`
        UPDATE generation_artifact_runs
        SET status = CASE
              WHEN EXISTS (
                SELECT 1 FROM generation_artifact_checkpoints checkpoint
                WHERE checkpoint.run_id = generation_artifact_runs.id
                  AND checkpoint.status = 'approved'
              ) THEN 'partial'
              ELSE 'failed'
            END,
            failure_stage = ?, updated_at = datetime('now')
        WHERE id = (SELECT artifact_run_id FROM generation_jobs WHERE id = ?)
          AND status IN ('active', 'partial')
      `).bind(failureStage, job.id),
      env.DB.prepare(`
        UPDATE provider_cost_events
        SET stage_outcome = CASE
              WHEN stage = ? AND stage_outcome = 'pending' THEN 'failed'
              ELSE stage_outcome
            END,
            job_outcome = CASE
              WHEN EXISTS (
                SELECT 1
                FROM generation_artifact_checkpoints checkpoint
                JOIN generation_jobs generation_job
                  ON generation_job.artifact_run_id = checkpoint.run_id
                WHERE generation_job.id = ? AND checkpoint.status = 'approved'
              ) OR EXISTS (
                SELECT 1
                FROM generation_jobs generation_job
                JOIN generation_charges charge ON charge.id = generation_job.charge_id
                WHERE generation_job.id = ? AND charge.status = 'committed'
              ) THEN 'failed_partial'
              ELSE 'failed'
            END
        WHERE job_id = ? AND job_outcome = 'in_progress'
      `).bind(failureStage, job.id, job.id, job.id),
    ]);
  }

  const { results: cachedResponses } = await env.DB.prepare(`
    SELECT prc.id, prc.response_blob_key
    FROM provider_request_cache prc
    JOIN generation_artifact_runs run ON run.id = prc.artifact_run_id
    WHERE (
        run.status IN ('succeeded', 'superseded')
        OR (
          run.status = 'failed'
          AND NOT EXISTS (
            SELECT 1 FROM generation_charges original_charge
            WHERE original_charge.id = run.original_charge_id
              AND original_charge.status = 'committed'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM generation_jobs paid_job
            JOIN generation_charges paid_charge ON paid_charge.id = paid_job.charge_id
            WHERE paid_job.artifact_run_id = run.id
              AND paid_charge.status = 'committed'
          )
        )
      )
      AND datetime(run.updated_at) <= datetime('now', '-1 day')
      AND prc.response_blob_key IS NOT NULL
    ORDER BY run.updated_at ASC
    LIMIT 100
  `).all<ProviderCacheObjectRow>();
  const responseRows = cachedResponses ?? [];
  if (responseRows.length > 0) {
    await env.SPRITES.delete(responseRows.map((row) => row.response_blob_key));
    await env.DB.batch(responseRows.map((row) => env.DB.prepare(`
      UPDATE provider_request_cache
      SET response_blob_key = NULL, updated_at = datetime('now')
      WHERE id = ? AND response_blob_key = ?
    `).bind(row.id, row.response_blob_key)));
  }

  await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM rate_limits
      WHERE datetime(expires_at) <= datetime('now')
    `),
    env.DB.prepare(`
      DELETE FROM provider_request_cache
      WHERE response_blob_key IS NULL
        AND artifact_run_id IN (
          SELECT run.id FROM generation_artifact_runs run
          WHERE (
              run.status IN ('succeeded', 'superseded')
              OR (
                run.status = 'failed'
                AND NOT EXISTS (
                  SELECT 1 FROM generation_charges original_charge
                  WHERE original_charge.id = run.original_charge_id
                    AND original_charge.status = 'committed'
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM generation_jobs paid_job
                  JOIN generation_charges paid_charge ON paid_charge.id = paid_job.charge_id
                  WHERE paid_job.artifact_run_id = run.id
                    AND paid_charge.status = 'committed'
                )
              )
            )
            AND datetime(updated_at) <= datetime('now', '-1 day')
        )
    `),
    env.DB.prepare(`
      DELETE FROM generation_jobs
      WHERE status IN ('succeeded', 'failed', 'cancelled')
        AND datetime(finished_at) <= datetime('now', '-7 days')
        AND NOT EXISTS (
          SELECT 1
          FROM generation_artifact_runs run
          WHERE run.id = generation_jobs.artifact_run_id
            AND run.status = 'partial'
        )
    `),
    env.DB.prepare(`
      DELETE FROM provider_sessions
      WHERE datetime(expires_at) <= datetime('now', '-7 days')
        AND NOT EXISTS (
          SELECT 1 FROM generation_jobs
          WHERE generation_jobs.provider_session_id = provider_sessions.id
        )
    `),
    env.DB.prepare(`
      DELETE FROM provider_spend_reservations
      WHERE created_at_epoch <= unixepoch('now', '-1 day')
    `),
    env.DB.prepare(`
      DELETE FROM provider_capacity_windows
      WHERE retry_at_epoch <= unixepoch('now', '-1 day')
    `),
    env.DB.prepare(`
      DELETE FROM stripe_events
      WHERE datetime(created_at) <= datetime('now', '-180 days')
    `),
    env.DB.prepare(`
      DELETE FROM clerk_webhook_events
      WHERE datetime(processed_at) <= datetime('now', '-180 days')
    `),
    env.DB.prepare(`
      DELETE FROM checkout_sessions
      WHERE status IN ('open', 'failed')
        AND datetime(updated_at) <= datetime('now', '-30 days')
    `),
    env.DB.prepare(`
      DELETE FROM legal_acceptances
      WHERE datetime(created_at) <= datetime('now', '-6 years')
    `),
    env.DB.prepare(`
      DELETE FROM community_reports
      WHERE status IN ('dismissed', 'actioned')
        AND datetime(updated_at) <= datetime('now', '-1 year')
    `),
  ]);
}
