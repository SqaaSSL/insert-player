import { generateId } from './auth';
import { drainFighterAssetDeletions } from './assetDeletion';
import { settleGenerationPurchase } from './billing';
import { reconcileNotDispatchedProviderReservation } from './providerSessions';
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

interface ProvenNotDispatchedCostEventRow {
  event_id: string;
  session_id: string;
  charge_id: string | null;
  user_id: string | null;
  fighter_id: string | null;
  estimated_cost_cents: number;
  monthly_period: string;
  http_status: number | null;
}

interface PendingNotDispatchedRefundRow {
  charge_id: string;
  user_id: string;
  fighter_id: string | null;
}

const PROVIDER_NOT_DISPATCHED_EVENT_MARKER_PREFIX = '(provider_request_not_dispatched:';
const NOT_DISPATCHED_RECONCILIATION_PAGE_SIZE = 100;
const NOT_DISPATCHED_RECONCILIATION_LIMIT = 1_000;

async function settlePendingNotDispatchedRefunds(env: Env): Promise<void> {
  let settled = 0;
  while (true) {
    const { results } = await env.DB.prepare(`
      SELECT
        charge.id AS charge_id,
        charge.user_id,
        COALESCE(
          charge.fighter_id,
          (
            SELECT job.fighter_id
            FROM provider_cost_events linked_cost
            JOIN generation_jobs job ON job.id = linked_cost.job_id
            WHERE linked_cost.charge_id = charge.id
            ORDER BY linked_cost.created_at ASC, linked_cost.id ASC
            LIMIT 1
          )
        ) AS fighter_id
      FROM generation_charges charge
      WHERE charge.status = 'reserved'
        AND EXISTS (
          SELECT 1
          FROM provider_cost_events released_cost
          WHERE released_cost.charge_id = charge.id
            AND released_cost.outcome = 'failed'
            AND released_cost.upstream_outcome = 'not_dispatched'
            AND released_cost.estimated_cost_cents = 0
        )
        AND NOT EXISTS (
          SELECT 1
          FROM provider_cost_events incurred_cost
          WHERE incurred_cost.charge_id = charge.id
            AND incurred_cost.estimated_cost_cents > 0
        )
      ORDER BY charge.created_at ASC, charge.id ASC
      LIMIT ?
    `).bind(NOT_DISPATCHED_RECONCILIATION_PAGE_SIZE).all<PendingNotDispatchedRefundRow>();
    const rows = results ?? [];
    if (rows.length === 0) return;

    for (const row of rows) {
      if (settled >= NOT_DISPATCHED_RECONCILIATION_LIMIT) {
        throw new Error('Not-dispatched provider refunds exceeded their maintenance limit');
      }
      const settlement = await settleGenerationPurchase(
        env,
        row.user_id,
        row.charge_id,
        false,
        row.fighter_id,
      );
      if (!settlement || settlement.status === 'reserved') {
        throw new Error(`Not-dispatched generation refund remained reserved (${row.charge_id})`);
      }
      settled += 1;
    }
  }
}

async function closeEmptyPartialRunsAfterNotDispatchedRefunds(env: Env): Promise<void> {
  await env.DB.prepare(`
    UPDATE generation_artifact_runs
    SET status = 'failed', updated_at = datetime('now')
    WHERE status = 'partial'
      AND NOT EXISTS (
        SELECT 1
        FROM generation_artifact_checkpoints checkpoint
        WHERE checkpoint.run_id = generation_artifact_runs.id
          AND checkpoint.status = 'approved'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM generation_charges original_charge
        WHERE original_charge.id = generation_artifact_runs.original_charge_id
          AND original_charge.status = 'committed'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM generation_jobs valid_job
        JOIN generation_charges valid_charge ON valid_charge.id = valid_job.charge_id
        WHERE valid_job.artifact_run_id = generation_artifact_runs.id
          AND valid_charge.status = 'committed'
      )
      AND EXISTS (
        SELECT 1
        FROM provider_cost_events released_cost
        JOIN generation_charges released_charge ON released_charge.id = released_cost.charge_id
        WHERE released_charge.status = 'refunded'
          AND released_cost.outcome = 'failed'
          AND released_cost.upstream_outcome = 'not_dispatched'
          AND released_cost.estimated_cost_cents = 0
          AND (
            released_cost.artifact_run_id = generation_artifact_runs.id
            OR released_cost.charge_id = generation_artifact_runs.original_charge_id
            OR EXISTS (
              SELECT 1
              FROM generation_jobs refunded_job
              WHERE refunded_job.artifact_run_id = generation_artifact_runs.id
                AND refunded_job.charge_id = released_cost.charge_id
            )
          )
      )
  `).run();
}

async function reconcileProvenNotDispatchedProviderCosts(env: Env): Promise<void> {
  let reconciled = 0;
  while (true) {
    const { results } = await env.DB.prepare(`
      SELECT
        cost_event.id AS event_id,
        cost_event.session_id,
        cost_event.charge_id,
        charge.user_id,
        COALESCE(charge.fighter_id, job.fighter_id) AS fighter_id,
        cost_event.estimated_cost_cents,
        substr(cost_event.created_at, 1, 7) AS monthly_period,
        cost_event.http_status
      FROM provider_cost_events cost_event
      LEFT JOIN generation_charges charge ON charge.id = cost_event.charge_id
      LEFT JOIN generation_jobs job ON job.id = cost_event.job_id
      WHERE cost_event.outcome = 'reserved'
        AND cost_event.estimated_cost_cents > 0
        AND cost_event.session_id IS NOT NULL
        AND (
          cost_event.upstream_outcome = 'not_dispatched'
          OR EXISTS (
            SELECT 1
            FROM generation_job_events job_event
            WHERE job_event.job_id = cost_event.job_id
              AND job_event.status = 'failed'
              AND instr(
                COALESCE(job_event.detail, ''),
                ? || cost_event.id || ')'
              ) > 0
          )
        )
      ORDER BY cost_event.created_at ASC, cost_event.id ASC
      LIMIT ?
    `).bind(
      PROVIDER_NOT_DISPATCHED_EVENT_MARKER_PREFIX,
      NOT_DISPATCHED_RECONCILIATION_PAGE_SIZE,
    ).all<ProvenNotDispatchedCostEventRow>();
    const rows = results ?? [];
    if (rows.length === 0) return;

    for (const row of rows) {
      if (reconciled >= NOT_DISPATCHED_RECONCILIATION_LIMIT) {
        // Do not continue into retention purges while proven accounting markers remain.
        throw new Error('Not-dispatched provider reconciliation exceeded its maintenance limit');
      }
      if (!/^\d{4}-\d{2}$/.test(row.monthly_period)) {
        throw new Error(`Invalid provider cost event period for reconciliation (${row.event_id})`);
      }
      await reconcileNotDispatchedProviderReservation(env, {
        eventId: row.event_id,
        sessionId: row.session_id,
        chargeId: row.charge_id,
        userId: row.user_id,
        estimatedCostCents: row.estimated_cost_cents,
        monthlyPeriod: row.monthly_period,
      }, Number.isInteger(row.http_status) ? Number(row.http_status) : 503);
      if (row.charge_id && row.user_id) {
        const settlement = await settleGenerationPurchase(
          env,
          row.user_id,
          row.charge_id,
          false,
          row.fighter_id,
        );
        if (!settlement || settlement.status === 'reserved') {
          throw new Error(`Not-dispatched generation refund remained reserved (${row.charge_id})`);
        }
      }
      reconciled += 1;
    }
  }
}

export async function cleanupOperationalData(env: Env): Promise<void> {
  await drainFighterAssetDeletions(env, { maxBatches: 5 });
  // Reconcile durable accounting markers before retention can delete the job
  // event that proves the provider request never left our infrastructure.
  await settlePendingNotDispatchedRefunds(env);
  await closeEmptyPartialRunsAfterNotDispatchedRefunds(env);
  await reconcileProvenNotDispatchedProviderCosts(env);
  await settlePendingNotDispatchedRefunds(env);
  await closeEmptyPartialRunsAfterNotDispatchedRefunds(env);

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
      DELETE FROM provider_meterkey_capacity_windows
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
