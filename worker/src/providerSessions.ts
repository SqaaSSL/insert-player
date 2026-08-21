import { generateId } from './auth';
import type { Env, PublicAuthContext, QualityTier } from './types';
import {
  normalizeGenerationBillingOperation,
  normalizeQualityTier,
  type GenerationBillingOperation,
} from './tiers';
import { readJsonBody } from './requestBody';
import { enforceRateLimit } from './rateLimit';
import {
  parseGenerationLegalAttestation,
  prepareLegalAcceptance,
  type GenerationLegalAttestation,
} from './legal';

export const PROVIDER_SESSION_HEADER = 'X-ASF-Provider-Session';

export type ProviderSessionProvider = 'gemini' | 'ludo' | 'freepik' | 'runway' | 'fal';

type ProviderSessionPurpose =
  | 'fighter_generation'
  | 'fighter_retry'
  | 'fighter_upgrade'
  | 'stage_background'
  | 'intro_video';

interface ProviderSessionRow {
  id: string;
  charge_id?: string | null;
  tier: QualityTier;
  purpose: ProviderSessionPurpose;
  provider_calls_used?: number;
  provider_call_limit?: number;
  provider_cost_used_cents?: number;
  provider_cost_limit_cents?: number;
  charge_reason?: string | null;
  expires_at: string;
}

interface ProviderSessionUsageRow {
  id: string;
  provider_calls_used: number;
  provider_call_limit: number;
  provider_cost_used_cents: number;
  provider_cost_limit_cents: number;
}

interface ProviderSpendReservation {
  sessionId: string;
  estimatedCostCents: number;
  monthlyPeriod: string;
  rollingReservationId: string | null;
  eventId: string | null;
}

const SESSION_TTL_HOURS = 12;
const MAX_PROVIDER_SESSION_BODY_BYTES = 8 * 1024;

const FIGHTER_GENERATION_CALL_LIMITS: Record<QualityTier, number> = {
  rookie: 48,
  contender: 280,
  champion: 320,
};
const FIGHTER_RETRY_CALL_LIMITS: Record<QualityTier, number> = {
  rookie: 16,
  contender: 72,
  champion: 72,
};
const SOURCE_RETRY_CALL_LIMIT = 8;
const FEATURE_PROVIDER_CALL_LIMITS: Record<'stage_background' | 'intro_video', number> = {
  stage_background: 1,
  intro_video: 24,
};
const FIGHTER_GENERATION_COST_LIMITS_CENTS: Record<QualityTier, number> = {
  rookie: 300,
  contender: 1_000,
  champion: 1_800,
};
const FIGHTER_RETRY_COST_LIMITS_CENTS: Record<QualityTier, number> = {
  rookie: 50,
  contender: 300,
  champion: 500,
};
const SOURCE_RETRY_COST_LIMIT_CENTS = 75;
const FEATURE_PROVIDER_COST_LIMITS_CENTS: Record<'stage_background' | 'intro_video', number> = {
  stage_background: 10,
  intro_video: 300,
};

const GEMINI_FLASH_IMAGE_MODEL = 'gemini-3.1-flash-image';
const GEMINI_PRO_IMAGE_MODEL = 'gemini-3-pro-image';
const GEMINI_SPEND_WINDOW_SECONDS = 10 * 60;
const providerRequestReservations = new WeakMap<Request, ProviderSpendReservation>();

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return Response.json(data, { status, headers: extraHeaders });
}

function providerSessionLimitResponse(expiresAt: string): Response {
  const remainingSeconds = Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
  return json(
    { error: 'Provider session call limit exceeded' },
    429,
    { 'Retry-After': String(remainingSeconds) },
  );
}

function providerSessionCostLimitResponse(expiresAt: string): Response {
  const remainingSeconds = Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
  return json(
    { error: 'Provider session spend limit exceeded', code: 'provider_session_spend_limit' },
    429,
    { 'Retry-After': String(remainingSeconds) },
  );
}

function nextUtcMonthRetryAfter(): string {
  const now = new Date();
  const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return String(Math.max(1, Math.ceil((nextMonth - now.getTime()) / 1000)));
}

function providerMonthlyBudgetResponse(): Response {
  return json(
    { error: 'Generation capacity is temporarily exhausted', code: 'provider_monthly_budget_exhausted' },
    503,
    { 'Retry-After': nextUtcMonthRetryAfter() },
  );
}

function providerSpendRateResponse(retryAfterSeconds: number): Response {
  return json(
    {
      error: 'Generation is waiting for available provider capacity',
      code: 'provider_global_spend_rate',
    },
    429,
    { 'Retry-After': String(Math.max(1, retryAfterSeconds)) },
  );
}

function expiresAt(): string {
  return new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();
}

function normalizePurpose(value: unknown): ProviderSessionPurpose | null {
  if (value === 'fighter_generation') return 'fighter_generation';
  if (value === 'fighter_retry') return 'fighter_retry';
  if (value === 'fighter_upgrade') return 'fighter_upgrade';
  if (value === 'stage_background') return 'stage_background';
  if (value === 'intro_video') return 'intro_video';
  return null;
}

export async function createProviderSession(
  env: Env,
  auth: PublicAuthContext,
  params: {
    tier: QualityTier;
    purpose: ProviderSessionPurpose;
    operation?: GenerationBillingOperation;
    chargeId?: string | null;
    legal: GenerationLegalAttestation;
  },
): Promise<{ id: string; expiresAt: string; providerCallLimit: number; providerCostLimitCents: number }> {
  const id = generateId();
  const sessionExpiresAt = expiresAt();
  const providerCallLimit = providerCallLimitFor(params.purpose, params.tier, params.operation);
  const providerCostLimitCents = providerCostLimitFor(params.purpose, params.tier, params.operation);

  const sessionStatement = env.DB.prepare(`
    INSERT INTO provider_sessions (
      id, user_id, rate_limit_key, tier, purpose, charge_id, provider_call_limit,
      provider_cost_limit_cents, expires_at,
      legal_version, age_confirmed, photo_rights_confirmed, ai_processing_confirmed,
      immediate_performance_confirmed, withdrawal_loss_acknowledged
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, 1)
  `).bind(
    id,
    auth.userId,
    auth.rateLimitKey,
    params.tier,
    params.purpose,
    params.chargeId ?? null,
    providerCallLimit,
    providerCostLimitCents,
    sessionExpiresAt,
    params.legal.legalVersion,
  );
  const acceptanceStatement = await prepareLegalAcceptance(
    env,
    auth,
    params.purpose,
    params.legal,
    id,
  );
  await env.DB.batch([sessionStatement, acceptanceStatement]);

  return { id, expiresAt: sessionExpiresAt, providerCallLimit, providerCostLimitCents };
}

function providerCallLimitFor(
  purpose: ProviderSessionPurpose,
  tier: QualityTier,
  operation?: GenerationBillingOperation,
): number {
  if (purpose === 'fighter_generation' || purpose === 'fighter_upgrade') {
    return FIGHTER_GENERATION_CALL_LIMITS[tier];
  }
  if (purpose === 'fighter_retry') {
    if (operation === 'fighter_retry_source') return SOURCE_RETRY_CALL_LIMIT;
    return FIGHTER_RETRY_CALL_LIMITS[tier];
  }
  return FEATURE_PROVIDER_CALL_LIMITS[purpose];
}

function providerCostLimitFor(
  purpose: ProviderSessionPurpose,
  tier: QualityTier,
  operation?: GenerationBillingOperation,
): number {
  if (purpose === 'fighter_generation' || purpose === 'fighter_upgrade') {
    return FIGHTER_GENERATION_COST_LIMITS_CENTS[tier];
  }
  if (purpose === 'fighter_retry') {
    if (operation === 'fighter_retry_source') return SOURCE_RETRY_COST_LIMIT_CENTS;
    return FIGHTER_RETRY_COST_LIMITS_CENTS[tier];
  }
  return FEATURE_PROVIDER_COST_LIMITS_CENTS[purpose];
}

export async function createFeatureProviderSession(
  request: Request,
  env: Env,
  auth: PublicAuthContext,
): Promise<Response> {
  if (!auth.user) {
    return json({ error: 'Sign in to use this AI feature' }, 401);
  }

  const body = await readJsonBody<{
    purpose?: ProviderSessionPurpose;
    tier?: QualityTier;
    legal?: unknown;
  }>(request, MAX_PROVIDER_SESSION_BODY_BYTES);
  const purpose = normalizePurpose(body.purpose);
  if (purpose !== 'stage_background' && purpose !== 'intro_video') {
    return json({ error: 'Unsupported provider session purpose' }, 400);
  }

  const legal = parseGenerationLegalAttestation(body.legal);
  if (!legal) {
    return json({ error: 'Current generation consent is required' }, 428);
  }
  const purposeLimit = await enforceRateLimit(env, `provider:session:${purpose}`, auth);
  if (purposeLimit) return purposeLimit;
  const tier = normalizeQualityTier(body.tier);
  const session = await createProviderSession(env, auth, { tier, purpose, legal });
  return json({
    providerSessionId: session.id,
    providerSessionExpiresAt: session.expiresAt,
    providerCallLimit: session.providerCallLimit,
    providerCostLimitCents: session.providerCostLimitCents,
  });
}

export async function markProviderSessionsForCharge(
  env: Env,
  userId: string,
  chargeId: string,
  status: 'completed' | 'cancelled',
): Promise<void> {
  await env.DB.prepare(`
    UPDATE provider_sessions
    SET status = ?,
        updated_at = datetime('now')
    WHERE charge_id = ? AND user_id = ? AND status = 'active'
  `).bind(status, chargeId, userId).run();
}

function billingOperationForSession(
  purpose: ProviderSessionPurpose,
  chargeReason: string | null | undefined,
): GenerationBillingOperation | null {
  if (purpose === 'fighter_upgrade') return 'fighter_upgrade';
  if (purpose === 'fighter_retry') {
    return normalizeGenerationBillingOperation(undefined, chargeReason);
  }
  if (purpose === 'fighter_generation') return 'fighter_generation';
  return null;
}

function isAllowedProviderUse(
  purpose: ProviderSessionPurpose,
  tier: QualityTier,
  chargeReason: string | null | undefined,
  provider: ProviderSessionProvider,
  path: string,
): boolean {
  const isFreepikVideo =
    path.startsWith('/proxy/freepik/v1/ai/image-to-video/') ||
    path.startsWith('/proxy/freepik/v1/ai/reference-to-video/');
  const isFalIntro = path.startsWith('/proxy/fal/fal-ai/ltx-2.3/image-to-video/');
  const isFalBgRemoval = path.startsWith('/proxy/fal/fal-ai/birefnet');

  const geminiModel = path.match(/^\/proxy\/gemini\/v1beta\/models\/([^/:]+):generateContent$/)?.[1];

  if (purpose === 'stage_background') {
    return provider === 'gemini' && geminiModel === GEMINI_FLASH_IMAGE_MODEL;
  }
  if (purpose === 'intro_video') {
    return (
      provider === 'runway' ||
      isFreepikVideo ||
      isFalIntro
    );
  }

  if (provider === 'gemini') {
    if (purpose === 'fighter_retry') {
      const operation = billingOperationForSession(purpose, chargeReason);
      if (operation === 'fighter_retry_source') return geminiModel === GEMINI_PRO_IMAGE_MODEL;
      if (tier === 'champion') {
        return geminiModel === GEMINI_FLASH_IMAGE_MODEL || geminiModel === GEMINI_PRO_IMAGE_MODEL;
      }
      return geminiModel === GEMINI_FLASH_IMAGE_MODEL;
    }
    if (purpose === 'fighter_upgrade') {
      return tier === 'champion'
        ? geminiModel === GEMINI_FLASH_IMAGE_MODEL || geminiModel === GEMINI_PRO_IMAGE_MODEL
        : geminiModel === GEMINI_FLASH_IMAGE_MODEL;
    }
    // New fighters use Pro source views before their tier-specific animations.
    return geminiModel === GEMINI_FLASH_IMAGE_MODEL || geminiModel === GEMINI_PRO_IMAGE_MODEL;
  }

  return (
    provider === 'ludo' ||
    isFalBgRemoval ||
    (
      provider === 'freepik' &&
      !isFreepikVideo
    )
  );
}

function estimatedProviderCallCostCents(provider: ProviderSessionProvider, path: string): number | null {
  if (provider === 'gemini') {
    const model = path.match(/^\/proxy\/gemini\/v1beta\/models\/([^/:]+):generateContent$/)?.[1];
    if (model === GEMINI_FLASH_IMAGE_MODEL) return 8;
    if (model === GEMINI_PRO_IMAGE_MODEL) return 15;
    return null;
  }
  if (provider === 'fal') {
    if (path.startsWith('/proxy/fal/fal-ai/birefnet')) return 1;
    if (path.startsWith('/proxy/fal/fal-ai/ltx-2.3/image-to-video/')) return 50;
    return null;
  }
  if (provider === 'freepik') {
    if (path.startsWith('/proxy/freepik/v1/ai/beta/remove-background')) return 3;
    if (path.startsWith('/proxy/freepik/v1/ai/text-to-image/flux-kontext-pro')) return 10;
    if (path.startsWith('/proxy/freepik/v1/ai/image-to-video/')) return 100;
    if (path.startsWith('/proxy/freepik/v1/ai/reference-to-video/')) return 250;
    return null;
  }
  if (provider === 'runway') return 100;
  if (provider === 'ludo') return 25;
  return null;
}

function monthlyBudgetCents(env: Env): number | null {
  const raw = env.PROVIDER_MONTHLY_BUDGET_USD_CENTS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function geminiSpendRateLimitCents(env: Env): number | null {
  const raw = env.GEMINI_SPEND_RATE_LIMIT_USD_CENTS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function reserveRollingGeminiSpend(
  env: Env,
  route: { provider: ProviderSessionProvider; path: string },
  estimatedCostCents: number,
): Promise<{ id: string | null } | Response> {
  if (route.provider !== 'gemini') return { id: null };
  const limitCents = geminiSpendRateLimitCents(env);
  if (!limitCents) return { id: null };
  if (estimatedCostCents > limitCents) return providerSpendRateResponse(GEMINI_SPEND_WINDOW_SECONDS);

  const nowEpoch = Math.floor(Date.now() / 1_000);
  const cutoffEpoch = nowEpoch - GEMINI_SPEND_WINDOW_SECONDS;
  const id = generateId();
  const reservation = await env.DB.prepare(`
    INSERT INTO provider_spend_reservations (
      id, provider, model_path, estimated_cost_cents, created_at_epoch
    )
    SELECT ?, 'gemini', ?, ?, ?
    WHERE COALESCE((
      SELECT SUM(estimated_cost_cents)
      FROM provider_spend_reservations
      WHERE provider = 'gemini'
        AND created_at_epoch > ?
    ), 0) <= ?
    RETURNING id
  `).bind(
    id,
    route.path,
    estimatedCostCents,
    nowEpoch,
    cutoffEpoch,
    limitCents - estimatedCostCents,
  ).first<{ id: string }>();

  if (reservation) return { id };
  const oldest = await env.DB.prepare(`
    SELECT MIN(created_at_epoch) AS created_at_epoch
    FROM provider_spend_reservations
    WHERE provider = 'gemini'
      AND created_at_epoch > ?
  `).bind(cutoffEpoch).first<{ created_at_epoch: number | null }>();
  const retryAfterSeconds = oldest?.created_at_epoch
    ? oldest.created_at_epoch + GEMINI_SPEND_WINDOW_SECONDS - nowEpoch + 1
    : 1;
  return providerSpendRateResponse(retryAfterSeconds);
}

async function reserveMonthlyProviderSpend(
  env: Env,
  estimatedCostCents: number,
): Promise<string | null> {
  const budgetCents = monthlyBudgetCents(env);
  if (!budgetCents || estimatedCostCents > budgetCents) return null;
  const period = new Date().toISOString().slice(0, 7);

  await env.DB.prepare(`
    INSERT INTO provider_spend_months (period)
    VALUES (?)
    ON CONFLICT(period) DO NOTHING
  `).bind(period).run();

  const reservation = await env.DB.prepare(`
    UPDATE provider_spend_months
    SET estimated_cost_cents = estimated_cost_cents + ?,
        provider_calls = provider_calls + 1,
        updated_at = datetime('now')
    WHERE period = ?
      AND estimated_cost_cents <= ?
    RETURNING period
  `).bind(
    estimatedCostCents,
    period,
    budgetCents - estimatedCostCents,
  ).first<{ period: string }>();

  return reservation?.period ?? null;
}

async function releaseProviderSpend(
  env: Env,
  reservation: Omit<ProviderSpendReservation, 'monthlyPeriod'> & { monthlyPeriod?: string | null },
  httpStatus?: number,
): Promise<void> {
  const statements = [
    env.DB.prepare(`
      UPDATE provider_sessions
      SET provider_calls_used = MAX(0, provider_calls_used - 1),
          provider_cost_used_cents = MAX(0, provider_cost_used_cents - ?),
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(reservation.estimatedCostCents, reservation.sessionId),
  ];
  if (reservation.monthlyPeriod) {
    statements.push(env.DB.prepare(`
      UPDATE provider_spend_months
      SET estimated_cost_cents = MAX(0, estimated_cost_cents - ?),
          provider_calls = MAX(0, provider_calls - 1),
          updated_at = datetime('now')
      WHERE period = ?
    `).bind(reservation.estimatedCostCents, reservation.monthlyPeriod));
  }
  if (reservation.rollingReservationId) {
    statements.push(env.DB.prepare(`
      DELETE FROM provider_spend_reservations
      WHERE id = ?
    `).bind(reservation.rollingReservationId));
  }
  if (reservation.eventId) {
    statements.push(env.DB.prepare(`
      UPDATE provider_cost_events
      SET outcome = 'failed',
          http_status = ?,
          finalized_at = datetime('now')
      WHERE id = ? AND outcome = 'reserved'
    `).bind(httpStatus ?? null, reservation.eventId));
  }
  await env.DB.batch(statements);
}

export async function finalizeProviderRequest(
  request: Request,
  env: Env,
  response: Response,
): Promise<void> {
  const reservation = providerRequestReservations.get(request);
  providerRequestReservations.delete(request);
  if (!reservation) return;
  if (response.ok) {
    try {
      await env.DB.prepare(`
        UPDATE provider_cost_events
        SET outcome = 'succeeded',
            http_status = ?,
            finalized_at = datetime('now')
        WHERE id = ? AND outcome = 'reserved'
      `).bind(response.status, reservation.eventId).run();
    } catch (error) {
      console.error('[provider] Failed to finalize provider cost event', error);
    }
    return;
  }
  try {
    await releaseProviderSpend(env, reservation, response.status);
  } catch (error) {
    console.error('[provider] Failed to release an unsuccessful provider reservation', error);
  }
}

export async function requireProviderSession(
  request: Request,
  env: Env,
  auth: PublicAuthContext,
  route: { provider: ProviderSessionProvider; path: string },
): Promise<Response | null> {
  const sessionId = request.headers.get(PROVIDER_SESSION_HEADER)?.trim();
  if (!sessionId) {
    return json({ error: 'Provider session required' }, 402);
  }

  const existing = await env.DB.prepare(`
    SELECT ps.id, ps.charge_id, ps.tier, ps.purpose, ps.provider_calls_used, ps.provider_call_limit,
           ps.provider_cost_used_cents, ps.provider_cost_limit_cents, ps.expires_at,
           gc.reason AS charge_reason
    FROM provider_sessions ps
    LEFT JOIN generation_charges gc ON gc.id = ps.charge_id
    WHERE ps.id = ?
      AND ps.status = 'active'
      AND datetime(ps.expires_at) > datetime('now')
      AND (
        (ps.user_id IS NOT NULL AND ps.user_id = ?)
        OR (ps.user_id IS NULL AND ps.rate_limit_key = ?)
      )
  `).bind(sessionId, auth.userId ?? '', auth.rateLimitKey).first<ProviderSessionRow>();

  if (!existing) {
    return json({ error: 'Provider session is invalid or expired' }, 402);
  }
  if (!isAllowedProviderUse(
    existing.purpose,
    existing.tier,
    existing.charge_reason,
    route.provider,
    route.path,
  )) {
    return json({ error: 'Provider session is not valid for this provider route' }, 403);
  }
  // Polling/result reads still need the scoped session, but only provider jobs
  // consume its paid call budget.
  if (request.method === 'GET' || request.method === 'HEAD') return null;
  if ((existing.provider_calls_used ?? 0) >= (existing.provider_call_limit ?? 0)) {
    return providerSessionLimitResponse(existing.expires_at);
  }
  const estimatedCostCents = estimatedProviderCallCostCents(route.provider, route.path);
  if (estimatedCostCents === null) {
    return json({ error: 'Provider route has no approved spend estimate' }, 403);
  }
  if (
    (existing.provider_cost_used_cents ?? 0) + estimatedCostCents >
    (existing.provider_cost_limit_cents ?? 0)
  ) {
    return providerSessionCostLimitResponse(existing.expires_at);
  }
  const rollingReservation = await reserveRollingGeminiSpend(env, route, estimatedCostCents);
  if (rollingReservation instanceof Response) return rollingReservation;
  const session = await env.DB.prepare(`
    UPDATE provider_sessions
    SET provider_calls_used = provider_calls_used + 1,
        provider_cost_used_cents = provider_cost_used_cents + ?,
        updated_at = datetime('now')
    WHERE id = ?
      AND status = 'active'
      AND datetime(expires_at) > datetime('now')
      AND provider_calls_used < provider_call_limit
      AND provider_cost_used_cents <= provider_cost_limit_cents - ?
      AND (
        (user_id IS NOT NULL AND user_id = ?)
        OR (user_id IS NULL AND rate_limit_key = ?)
      )
    RETURNING id, purpose, provider_calls_used, provider_call_limit,
              provider_cost_used_cents, provider_cost_limit_cents
  `).bind(
    estimatedCostCents,
    sessionId,
    estimatedCostCents,
    auth.userId ?? '',
    auth.rateLimitKey,
  ).first<ProviderSessionUsageRow>();

  if (session) {
    const monthlyPeriod = await reserveMonthlyProviderSpend(env, estimatedCostCents);
    if (!monthlyPeriod) {
      await releaseProviderSpend(env, {
        sessionId,
        estimatedCostCents,
        monthlyPeriod: null,
        rollingReservationId: rollingReservation.id,
        eventId: null,
      });
      return providerMonthlyBudgetResponse();
    }
    const eventId = generateId();
    try {
      await env.DB.prepare(`
        INSERT INTO provider_cost_events (
          id, session_id, charge_id, tier, purpose, billing_operation,
          provider, model_path, estimated_cost_cents
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        eventId,
        sessionId,
        existing.charge_id ?? null,
        existing.tier,
        existing.purpose,
        billingOperationForSession(existing.purpose, existing.charge_reason),
        route.provider,
        route.path,
        estimatedCostCents,
      ).run();
    } catch (error) {
      await releaseProviderSpend(env, {
        sessionId,
        estimatedCostCents,
        monthlyPeriod,
        rollingReservationId: rollingReservation.id,
        eventId: null,
      });
      console.error('[provider] Failed to reserve durable provider cost event', error);
      return json({ error: 'Provider cost accounting is temporarily unavailable' }, 503);
    }
    providerRequestReservations.set(request, {
      sessionId,
      estimatedCostCents,
      monthlyPeriod,
      rollingReservationId: rollingReservation.id,
      eventId,
    });
    return null;
  }

  if (rollingReservation.id) {
    await env.DB.prepare(`
      DELETE FROM provider_spend_reservations
      WHERE id = ?
    `).bind(rollingReservation.id).run();
  }

  const latest = await env.DB.prepare(`
    SELECT ps.id, ps.charge_id, ps.tier, ps.purpose, ps.provider_calls_used, ps.provider_call_limit,
           ps.provider_cost_used_cents, ps.provider_cost_limit_cents, ps.expires_at,
           gc.reason AS charge_reason
    FROM provider_sessions ps
    LEFT JOIN generation_charges gc ON gc.id = ps.charge_id
    WHERE ps.id = ?
      AND ps.status = 'active'
      AND datetime(ps.expires_at) > datetime('now')
      AND (
        (ps.user_id IS NOT NULL AND ps.user_id = ?)
        OR (ps.user_id IS NULL AND ps.rate_limit_key = ?)
      )
  `).bind(sessionId, auth.userId ?? '', auth.rateLimitKey).first<ProviderSessionRow>();
  if (latest && (latest.provider_calls_used ?? 0) >= (latest.provider_call_limit ?? 0)) {
    return providerSessionLimitResponse(latest.expires_at);
  }
  if (
    latest &&
    (latest.provider_cost_used_cents ?? 0) + estimatedCostCents >
      (latest.provider_cost_limit_cents ?? 0)
  ) {
    return providerSessionCostLimitResponse(latest.expires_at);
  }
  return json({ error: 'Provider session is invalid or expired' }, 402);
}

export async function requireProviderResultSession(
  request: Request,
  env: Env,
  auth: PublicAuthContext,
): Promise<Response | null> {
  const sessionId = request.headers.get(PROVIDER_SESSION_HEADER)?.trim();
  if (!sessionId) {
    return json({ error: 'Provider session required' }, 402);
  }

  const existing = await env.DB.prepare(`
    SELECT id
    FROM provider_sessions
    WHERE id = ?
      AND status = 'active'
      AND datetime(expires_at) > datetime('now')
      AND (
        (user_id IS NOT NULL AND user_id = ?)
        OR (user_id IS NULL AND rate_limit_key = ?)
      )
  `).bind(sessionId, auth.userId ?? '', auth.rateLimitKey).first<{ id: string }>();

  return existing ? null : json({ error: 'Provider session is invalid or expired' }, 402);
}
