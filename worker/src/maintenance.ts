import { generateId } from './auth';
import { settleGenerationPurchase } from './billing';
import type { Env } from './types';

interface StaleGenerationJobRow {
  id: string;
  user_id: string;
  charge_id: string;
  fighter_id: string;
}

interface ProviderCacheObjectRow {
  id: string;
  response_blob_key: string;
}

export async function cleanupOperationalData(env: Env): Promise<void> {
  const { results: staleJobs } = await env.DB.prepare(`
    SELECT id, user_id, charge_id, fighter_id
    FROM generation_jobs
    WHERE status IN ('queued', 'running')
      AND datetime(updated_at) <= datetime('now', '-4 days')
    ORDER BY updated_at ASC
    LIMIT 50
  `).all<StaleGenerationJobRow>();
  for (const job of staleJobs ?? []) {
    const settlement = await settleGenerationPurchase(env, job.user_id, job.charge_id, false, job.fighter_id);
    const releasedBeforeProviderStart = settlement?.status === 'refunded';
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE generation_jobs
        SET status = 'failed', stage = 'failed', error_code = 'job_stalled',
            error_message = ?,
            finished_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND status IN ('queued', 'running')
      `).bind(
        releasedBeforeProviderStart
          ? 'Generation never reached external processing; the unused reservation was released'
          : 'Generation stalled after external processing began; contact support if it cannot be repaired',
        job.id,
      ),
      env.DB.prepare(`
        INSERT INTO generation_job_events (id, job_id, stage, status, detail)
        SELECT ?, ?, 'failed', 'failed', 'Stale cloud job closed by maintenance'
        WHERE EXISTS (SELECT 1 FROM generation_jobs WHERE id = ? AND status = 'failed')
      `).bind(generateId(), job.id, job.id),
    ]);
  }

  const { results: cachedResponses } = await env.DB.prepare(`
    SELECT prc.id, prc.response_blob_key
    FROM provider_request_cache prc
    JOIN generation_jobs gj ON gj.id = prc.job_id
    WHERE gj.status IN ('succeeded', 'failed', 'cancelled')
      AND datetime(gj.finished_at) <= datetime('now', '-1 day')
      AND prc.response_blob_key IS NOT NULL
    ORDER BY gj.finished_at ASC
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
        AND job_id IN (
          SELECT id FROM generation_jobs
          WHERE status IN ('succeeded', 'failed', 'cancelled')
            AND datetime(finished_at) <= datetime('now', '-1 day')
        )
    `),
    env.DB.prepare(`
      DELETE FROM generation_jobs
      WHERE status IN ('succeeded', 'failed', 'cancelled')
        AND datetime(finished_at) <= datetime('now', '-7 days')
        AND NOT EXISTS (
          SELECT 1 FROM provider_request_cache
          WHERE provider_request_cache.job_id = generation_jobs.id
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
