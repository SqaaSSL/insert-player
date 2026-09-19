import { sanitizeProductEvent } from '../../src/services/ProductEventContract';
import { readJsonBody } from './requestBody';
import type { AuthContext, Env } from './types';

const MAX_PRODUCT_EVENT_BODY_BYTES = 2048;
const RETENTION_DAYS = 90;
const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function submitProductEvent(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  const allowedOrigins = (env.CORS_ORIGIN ?? '').split(',').map(value => value.trim());
  if (!origin || !allowedOrigins.includes(origin)) {
    return Response.json({ error: 'Origin not allowed' }, { status: 403, headers: NO_STORE });
  }
  if ((request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    return Response.json({ error: 'JSON required' }, { status: 415, headers: NO_STORE });
  }
  if (request.headers.get('DNT') === '1' || request.headers.get('Sec-GPC') === '1') {
    return new Response(null, { status: 204, headers: NO_STORE });
  }
  const event = sanitizeProductEvent(await readJsonBody(request, MAX_PRODUCT_EVENT_BODY_BYTES));
  if (!event) return Response.json({ error: 'Unknown product event' }, { status: 400, headers: NO_STORE });
  const { properties: p } = event;
  await env.DB.prepare(`
    INSERT INTO product_event_daily (
      day, event_name, channel, source, game, tier,
      event_count, duration_count, duration_ms_total
    ) VALUES (date('now'), ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(day, event_name, channel, source, game, tier) DO UPDATE SET
      event_count = product_event_daily.event_count + 1,
      duration_count = product_event_daily.duration_count + excluded.duration_count,
      duration_ms_total = product_event_daily.duration_ms_total + excluded.duration_ms_total
  `).bind(event.name, p.channel ?? 'direct', p.source ?? 'unknown', p.game ?? 'unknown', p.tier ?? 'unknown',
    p.durationMs === undefined ? 0 : 1, p.durationMs ?? 0).run();
  return Response.json({ received: true }, { status: 202, headers: NO_STORE });
}

export async function cleanupProductEventAggregates(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM product_event_daily WHERE day < date('now', '-89 days')").run();
}

interface AggregateRow {
  event: string;
  eventCount: number;
  durationSamples: number;
  durationMsTotal: number;
  day?: string;
  channel?: string;
  source?: string;
  game?: string;
  tier?: string;
}

function withAverage(rows: AggregateRow[]): Array<AggregateRow & { averageDurationMs: number | null }> {
  return rows.map(row => ({
    ...row,
    averageDurationMs: row.durationSamples > 0 ? Math.round(row.durationMsTotal / row.durationSamples) : null,
  }));
}

/** Admin-only totals, with observed client activity separate from stored outcomes. */
export async function getProductEventReport(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  if (auth.user.plan_tier !== 'admin') {
    return Response.json({ error: 'Admin access required' }, { status: 403, headers: NO_STORE });
  }
  const requested = new URL(request.url).searchParams.get('days') ?? '30';
  if (!/^\d{1,2}$/.test(requested) || Number(requested) < 1 || Number(requested) > RETENTION_DAYS) {
    return Response.json({ error: 'days must be between 1 and 90' }, { status: 400, headers: NO_STORE });
  }
  const days = Number(requested);
  const now = new Date();
  const throughDay = now.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days + 1));
  const fromDay = start.toISOString().slice(0, 10);
  const queries = ['', 'day', 'channel', 'source', 'game', 'tier'].map(dimension => env.DB.prepare(`
    SELECT ${dimension ? `${dimension},` : ''} event_name AS event,
      SUM(event_count) AS eventCount, SUM(duration_count) AS durationSamples,
      SUM(duration_ms_total) AS durationMsTotal
    FROM product_event_daily WHERE day >= ? AND day <= ?
    GROUP BY ${dimension ? `${dimension},` : ''} event_name
    ORDER BY ${dimension ? `${dimension},` : ''} event_name
  `).bind(fromDay, throughDay));
  // These already-existing operational rows provide factual outcomes, not
  // campaign attribution or a joined anonymous-user cohort. Never return IDs.
  queries.push(env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE clerk_user_id IS NOT NULL
        AND substr(created_at, 1, 10) BETWEEN ?1 AND ?2) AS accountsCreated,
      (SELECT COUNT(DISTINCT fighter_id) FROM generation_charges WHERE status = 'committed'
        AND tier = 'rookie' AND reason = 'fighter_generation'
        AND substr(updated_at, 1, 10) BETWEEN ?1 AND ?2) AS rookieFightersCommitted,
      (SELECT COUNT(DISTINCT fighter_id) FROM generation_artifact_runs
        WHERE status IN ('succeeded', 'superseded') AND tier = 'rookie' AND operation = 'fighter_generation'
        AND substr(completed_at, 1, 10) BETWEEN ?1 AND ?2) AS rookieFightersReady,
      (SELECT COUNT(DISTINCT user_id) FROM generation_artifact_runs
        WHERE status IN ('succeeded', 'superseded') AND tier = 'rookie' AND operation = 'fighter_generation'
        AND substr(completed_at, 1, 10) BETWEEN ?1 AND ?2) AS rookieCreators,
      (SELECT CAST(ROUND(AVG((julianday(completed_at) - julianday(created_at)) * 86400000)) AS INTEGER)
        FROM generation_artifact_runs WHERE status IN ('succeeded', 'superseded')
        AND tier = 'rookie' AND operation = 'fighter_generation'
        AND substr(completed_at, 1, 10) BETWEEN ?1 AND ?2) AS rookieAverageCreationMs,
      (SELECT COUNT(*) FROM crew_referrals WHERE substr(created_at, 1, 10) BETWEEN ?1 AND ?2) AS invitesCreated,
      (SELECT COUNT(*) FROM crew_referrals WHERE substr(membership_confirmed_at, 1, 10) BETWEEN ?1 AND ?2) AS invitesAccepted,
      (SELECT COUNT(DISTINCT invitee_user_id) FROM crew_referrals
        WHERE substr(membership_confirmed_at, 1, 10) BETWEEN ?1 AND ?2) AS playersJoined,
      (SELECT COUNT(*) FROM crew_stages WHERE status = 'ready'
        AND substr(updated_at, 1, 10) BETWEEN ?1 AND ?2) AS crewStagesReady,
      (SELECT COUNT(*) FROM credit_ledger WHERE stripe_session_id IS NOT NULL
        AND substr(reason, 1, 19) = 'stripe_credit_pack:'
        AND substr(created_at, 1, 10) BETWEEN ?1 AND ?2) AS creditPurchases,
      (SELECT COUNT(DISTINCT user_id) FROM credit_ledger WHERE stripe_session_id IS NOT NULL
        AND substr(reason, 1, 19) = 'stripe_credit_pack:'
        AND substr(created_at, 1, 10) BETWEEN ?1 AND ?2) AS payingPlayers
  `).bind(fromDay, throughDay));
  const result = await env.DB.batch(queries);
  return Response.json({
    fromDay, throughDay, retentionDays: RETENTION_DAYS,
    measurement: {
      client: 'Event counts, not unique people or a joined conversion cohort. Best effort and potentially repeated or blocked.',
      operational: 'Stored outcomes for this period; not attributed to client events or campaigns. Includes test/admin activity and excludes deleted records.',
      durations: 'Average of reported durations for each event; not elapsed time between different funnel steps.',
      purchases: 'Stripe credit grants recorded in the ledger, including purchases later refunded; not net revenue.',
    },
    events: withAverage(result[0].results as unknown as AggregateRow[]),
    daily: withAverage(result[1].results as unknown as AggregateRow[]),
    channels: withAverage(result[2].results as unknown as AggregateRow[]),
    sources: withAverage(result[3].results as unknown as AggregateRow[]),
    games: withAverage(result[4].results as unknown as AggregateRow[]),
    tiers: withAverage(result[5].results as unknown as AggregateRow[]),
    operational: result[6].results[0] ?? {},
  }, { headers: NO_STORE });
}
