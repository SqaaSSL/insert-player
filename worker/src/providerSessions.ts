import { generateId, hashString } from './auth';
import type { Env, PublicAuthContext, QualityTier } from './types';
import { generationJobIdFromAuth } from './generationAuth';
import {
  normalizeGenerationBillingOperation,
  normalizeQualityTier,
  type GenerationBillingOperation,
} from './tiers';
import {
  readJsonBody,
  rejectDeclaredBodyTooLarge,
  RequestBodyTooLargeError,
} from './requestBody';
import { enforceRateLimit } from './rateLimit';
import {
  parseGenerationLegalAttestation,
  prepareLegalAcceptance,
  type GenerationLegalAttestation,
} from './legal';
import { ResponseBodyTooLargeError } from './streamLimits';
import { PROVIDER_REQUEST_BODY_LIMITS, type ProviderName } from './providerLimits';

export const PROVIDER_SESSION_HEADER = 'X-ASF-Provider-Session';

export type ProviderSessionProvider = ProviderName;

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
const PROVIDER_REQUEST_KEY_HEADER = 'X-Insert-Player-Provider-Request-Key';
const PROVIDER_CACHE_MAX_RESPONSE_BYTES = 96 * 1024 * 1024;
const PROVIDER_CACHE_MULTIPART_BYTES = 8 * 1024 * 1024;

interface ProviderRequestCacheRow {
  id: string;
  status: 'pending' | 'succeeded' | 'failed';
  response_blob_key: string | null;
  response_status: number | null;
  response_content_type: string | null;
  owner_attempt_id: string;
  updated_at: string;
}

interface ProviderRequestCacheClaim {
  id: string;
  jobId: string;
  ownerAttemptId: string;
  responseBlobKey: string;
}

export interface ProviderRequestState {
  spendReservation: ProviderSpendReservation | null;
  cacheClaim: ProviderRequestCacheClaim | null;
}

export function createProviderRequestState(): ProviderRequestState {
  return { spendReservation: null, cacheClaim: null };
}

async function uploadMultipartPartWithRetry(
  upload: R2MultipartUpload,
  partNumber: number,
  bytes: Uint8Array,
): Promise<R2UploadedPart> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await upload.uploadPart(partNumber, bytes);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw lastError;
}

async function completeMultipartUploadWithRetry(
  bucket: R2Bucket,
  upload: R2MultipartUpload,
  key: string,
  parts: R2UploadedPart[],
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await upload.complete(parts);
      return;
    } catch (error) {
      if (await bucket.head(key)) return;
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw lastError;
}

async function storeProviderResponseStream(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array> | null,
  options: R2MultipartOptions,
): Promise<void> {
  if (!body) {
    await bucket.put(key, null, options);
    return;
  }

  const upload = await bucket.createMultipartUpload(key, options);
  const reader = body.getReader();
  const parts: R2UploadedPart[] = [];
  let partBytes = new Uint8Array(PROVIDER_CACHE_MULTIPART_BYTES);
  let partOffset = 0;
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > PROVIDER_CACHE_MAX_RESPONSE_BYTES) {
        throw new ResponseBodyTooLargeError();
      }
      let sourceOffset = 0;
      while (sourceOffset < value.byteLength) {
        const copyBytes = Math.min(
          value.byteLength - sourceOffset,
          PROVIDER_CACHE_MULTIPART_BYTES - partOffset,
        );
        partBytes.set(value.subarray(sourceOffset, sourceOffset + copyBytes), partOffset);
        sourceOffset += copyBytes;
        partOffset += copyBytes;
        if (partOffset === PROVIDER_CACHE_MULTIPART_BYTES) {
          parts.push(await uploadMultipartPartWithRetry(upload, parts.length + 1, partBytes));
          partBytes = new Uint8Array(PROVIDER_CACHE_MULTIPART_BYTES);
          partOffset = 0;
        }
      }
    }

    if (partOffset > 0) {
      parts.push(await uploadMultipartPartWithRetry(
        upload,
        parts.length + 1,
        partBytes.subarray(0, partOffset),
      ));
    }
    if (parts.length === 0) {
      await upload.abort();
      await bucket.put(key, null, options);
      return;
    }
    await completeMultipartUploadWithRetry(bucket, upload, key, parts);
  } catch (error) {
    await Promise.allSettled([reader.cancel(error), upload.abort()]);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return Response.json(data, { status, headers: extraHeaders });
}

function providerRequestPath(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function digestHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function providerRequestHash(
  request: Request,
  requestKey: string,
  maxBytes: number,
): Promise<string> {
  if (rejectDeclaredBodyTooLarge(request, maxBytes)) throw new RequestBodyTooLargeError();
  const prefix = new Uint8Array(requestKey.length + 1);
  prefix.set(new TextEncoder().encode(requestKey));

  if (typeof DigestStream === 'undefined') {
    const requestBytes = await request.clone().arrayBuffer();
    if (requestBytes.byteLength > maxBytes) throw new RequestBodyTooLargeError();
    const keyedRequest = new Uint8Array(prefix.byteLength + requestBytes.byteLength);
    keyedRequest.set(prefix, 0);
    keyedRequest.set(new Uint8Array(requestBytes), prefix.byteLength);
    return hashString(keyedRequest.buffer);
  }

  const digestStream = new DigestStream('SHA-256');
  const writer = digestStream.getWriter();
  const reader = request.clone().body?.getReader() ?? null;
  let totalBytes = 0;
  try {
    await writer.write(prefix);
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) throw new RequestBodyTooLargeError();
        await writer.write(value);
      }
    }
    await writer.close();
    return digestHex(await digestStream.digest);
  } catch (error) {
    await Promise.allSettled([
      reader?.cancel(error) ?? Promise.resolve(),
      writer.abort(error),
    ]);
    void digestStream.digest.catch(() => undefined);
    throw error;
  } finally {
    reader?.releaseLock();
    writer.releaseLock();
  }
}

function parseSqliteTimestamp(value: string): number {
  return Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

async function cachedProviderResponse(
  env: Env,
  row: ProviderRequestCacheRow,
): Promise<Response | null> {
  if (!row.response_blob_key || !row.response_status) return null;
  const object = await env.SPRITES.get(row.response_blob_key);
  if (!object) {
    if (row.status === 'succeeded') {
      await env.DB.prepare(`
        UPDATE provider_request_cache
        SET status = 'failed', error_message = 'Cached response object is missing', updated_at = datetime('now')
        WHERE id = ? AND status = 'succeeded'
      `).bind(row.id).run();
    }
    return null;
  }
  if (row.status !== 'succeeded') {
    await env.DB.prepare(`
      UPDATE provider_request_cache
      SET status = 'succeeded', error_message = NULL, updated_at = datetime('now')
      WHERE id = ? AND response_blob_key = ? AND response_status = ?
    `).bind(row.id, row.response_blob_key, row.response_status).run();
  }
  return new Response(object.body, {
    status: row.response_status,
    headers: {
      'Content-Type': row.response_content_type ?? object.httpMetadata?.contentType ?? 'application/json',
      'X-Insert-Player-Provider-Cache': 'hit',
    },
  });
}

async function beginProviderRequestCache(
  request: Request,
  env: Env,
  auth: PublicAuthContext,
  route: { provider: ProviderSessionProvider; path: string },
): Promise<Response | ProviderRequestCacheClaim | null> {
  const jobId = generationJobIdFromAuth(auth);
  if (!jobId || request.method !== 'POST') return null;

  const requestKey = request.headers.get(PROVIDER_REQUEST_KEY_HEADER)?.trim() ?? '';
  if (!/^[a-zA-Z0-9:_-]{1,200}$/.test(requestKey)) {
    return json({ error: 'A valid durable provider request key is required' }, 400);
  }
  let requestHash: string;
  try {
    requestHash = await providerRequestHash(
      request,
      requestKey,
      PROVIDER_REQUEST_BODY_LIMITS[route.provider],
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return json({ error: 'Provider request body is too large' }, 413);
    }
    throw error;
  }
  const requestPath = providerRequestPath(request);
  const ownerAttemptId = generateId();
  const id = generateId();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO provider_request_cache (
      id, job_id, provider, method, request_path, request_hash, owner_attempt_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    jobId,
    route.provider,
    request.method,
    requestPath,
    requestHash,
    ownerAttemptId,
  ).run();

  let row = await env.DB.prepare(`
    SELECT id, status, response_blob_key, response_status, response_content_type,
           owner_attempt_id, updated_at
    FROM provider_request_cache
    WHERE job_id = ? AND provider = ? AND method = ? AND request_path = ? AND request_hash = ?
  `).bind(jobId, route.provider, request.method, requestPath, requestHash)
    .first<ProviderRequestCacheRow>();
  if (!row) return json({ error: 'Provider request cache is unavailable' }, 503);

  const cached = await cachedProviderResponse(env, row);
  if (cached) return cached;

  if (row.owner_attempt_id !== ownerAttemptId) {
    const stale = row.status === 'failed' || (
      Number.isFinite(parseSqliteTimestamp(row.updated_at)) &&
      parseSqliteTimestamp(row.updated_at) <= Date.now() - 15 * 60 * 1_000
    );
    if (stale) {
      const takeover = await env.DB.prepare(`
        UPDATE provider_request_cache
        SET status = 'pending', owner_attempt_id = ?, error_message = NULL, updated_at = datetime('now')
        WHERE id = ? AND owner_attempt_id = ? AND status IN ('pending', 'failed')
        RETURNING id
      `).bind(ownerAttemptId, row.id, row.owner_attempt_id).first<{ id: string }>();
      if (takeover) {
        row = { ...row, status: 'pending', owner_attempt_id: ownerAttemptId };
      }
    }
  }

  if (row.owner_attempt_id !== ownerAttemptId) {
    return json(
      { error: 'Identical provider request is already in progress', code: 'provider_request_in_progress' },
      425,
      { 'Retry-After': '5' },
    );
  }

  return {
    id: row.id,
    jobId,
    ownerAttemptId,
    responseBlobKey: `users/${auth.userId}/jobs/${jobId}/provider-responses/${row.id}.bin`,
  };
}

async function finalizeProviderRequestCache(
  env: Env,
  response: Response,
  state: ProviderRequestState,
): Promise<Response> {
  const claim = state.cacheClaim;
  state.cacheClaim = null;
  if (!claim) return response;

  if (!response.ok) {
    await env.DB.prepare(`
      UPDATE provider_request_cache
      SET status = 'failed', response_status = ?, error_message = ?, updated_at = datetime('now')
      WHERE id = ? AND owner_attempt_id = ? AND status = 'pending'
    `).bind(response.status, `Provider returned HTTP ${response.status}`, claim.id, claim.ownerAttemptId).run();
    return response;
  }

  const contentType = response.headers.get('Content-Type') ?? 'application/json';
  const prepared = await env.DB.prepare(`
    UPDATE provider_request_cache
    SET response_blob_key = ?, response_status = ?, response_content_type = ?,
        error_message = NULL, updated_at = datetime('now')
    WHERE id = ? AND owner_attempt_id = ? AND status = 'pending'
    RETURNING id
  `).bind(
    claim.responseBlobKey,
    response.status,
    contentType,
    claim.id,
    claim.ownerAttemptId,
  ).first<{ id: string }>();
  if (!prepared) {
    return json({ error: 'Provider response cache ownership was lost' }, 503);
  }

  try {
    await storeProviderResponseStream(env.SPRITES, claim.responseBlobKey, response.body, {
      httpMetadata: { contentType },
      customMetadata: { responseStatus: String(response.status), jobId: claim.jobId },
    });
  } catch (error) {
    await Promise.allSettled([
      env.SPRITES.delete(claim.responseBlobKey),
      env.DB.prepare(`
        UPDATE provider_request_cache
        SET status = 'failed', response_blob_key = NULL, response_status = NULL,
            response_content_type = NULL, error_message = ?, updated_at = datetime('now')
        WHERE id = ? AND owner_attempt_id = ? AND status = 'pending'
      `).bind(
        error instanceof ResponseBodyTooLargeError
          ? 'Provider response exceeded the durable cache limit'
          : 'Could not persist provider response',
        claim.id,
        claim.ownerAttemptId,
      ).run(),
    ]);
    if (error instanceof ResponseBodyTooLargeError) {
      return json({
        error: 'Provider response exceeded the safe processing limit',
        code: 'provider_response_too_large',
      }, 502);
    }
    throw error;
  }

  const finalized = await env.DB.prepare(`
    UPDATE provider_request_cache
    SET status = 'succeeded', error_message = NULL, updated_at = datetime('now')
    WHERE id = ? AND owner_attempt_id = ? AND status = 'pending'
    RETURNING id
  `).bind(claim.id, claim.ownerAttemptId).first<{ id: string }>();
  if (!finalized) {
    throw new Error('Provider response cache could not be finalized');
  }
  const cached = await cachedProviderResponse(env, {
    id: claim.id,
    status: 'succeeded',
    response_blob_key: claim.responseBlobKey,
    response_status: response.status,
    response_content_type: contentType,
    owner_attempt_id: claim.ownerAttemptId,
    updated_at: new Date().toISOString(),
  });
  if (!cached) {
    await env.DB.prepare(`
      UPDATE provider_request_cache
      SET status = 'failed', error_message = 'Cached response object is missing', updated_at = datetime('now')
      WHERE id = ?
    `).bind(claim.id).run();
    return json({ error: 'Provider response cache is unavailable' }, 503);
  }
  cached.headers.set('X-Insert-Player-Provider-Cache', 'stored');
  return cached;
}

async function abandonProviderRequestCache(
  env: Env,
  state: ProviderRequestState,
  errorMessage: string,
): Promise<void> {
  const claim = state.cacheClaim;
  state.cacheClaim = null;
  if (!claim) return;

  await env.DB.prepare(`
    UPDATE provider_request_cache
    SET status = 'failed', error_message = ?, updated_at = datetime('now')
    WHERE id = ? AND owner_attempt_id = ? AND status = 'pending'
  `).bind(errorMessage, claim.id, claim.ownerAttemptId).run();
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
  env: Env,
  response: Response,
  state: ProviderRequestState,
): Promise<Response> {
  const providerSucceeded = response.ok;
  const providerStatus = response.status;
  let clientResponse = response;
  try {
    clientResponse = await finalizeProviderRequestCache(env, response, state);
  } catch (error) {
    console.error('[provider] Failed to persist idempotent provider response', error);
    clientResponse = json({ error: 'Provider response could not be persisted safely' }, 502);
  }
  const reservation = state.spendReservation;
  state.spendReservation = null;
  if (!reservation) return clientResponse;
  if (providerSucceeded) {
    try {
      await env.DB.prepare(`
        UPDATE provider_cost_events
        SET outcome = 'succeeded',
            http_status = ?,
            finalized_at = datetime('now')
        WHERE id = ? AND outcome = 'reserved'
      `).bind(providerStatus, reservation.eventId).run();
    } catch (error) {
      console.error('[provider] Failed to finalize provider cost event', error);
    }
    return clientResponse;
  }
  try {
    await releaseProviderSpend(env, reservation, providerStatus);
  } catch (error) {
    console.error('[provider] Failed to release an unsuccessful provider reservation', error);
  }
  return clientResponse;
}

export async function requireProviderSession(
  request: Request,
  env: Env,
  auth: PublicAuthContext,
  route: { provider: ProviderSessionProvider; path: string },
  state: ProviderRequestState = createProviderRequestState(),
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
  const cache = await beginProviderRequestCache(request, env, auth, route);
  if (cache instanceof Response) return cache;
  if (cache) state.cacheClaim = cache;
  if ((existing.provider_calls_used ?? 0) >= (existing.provider_call_limit ?? 0)) {
    await abandonProviderRequestCache(env, state, 'Provider session call limit exceeded');
    return providerSessionLimitResponse(existing.expires_at);
  }
  const estimatedCostCents = estimatedProviderCallCostCents(route.provider, route.path);
  if (estimatedCostCents === null) {
    await abandonProviderRequestCache(env, state, 'Provider route has no approved spend estimate');
    return json({ error: 'Provider route has no approved spend estimate' }, 403);
  }
  if (
    (existing.provider_cost_used_cents ?? 0) + estimatedCostCents >
    (existing.provider_cost_limit_cents ?? 0)
  ) {
    await abandonProviderRequestCache(env, state, 'Provider session spend limit exceeded');
    return providerSessionCostLimitResponse(existing.expires_at);
  }
  const rollingReservation = await reserveRollingGeminiSpend(env, route, estimatedCostCents);
  if (rollingReservation instanceof Response) {
    await abandonProviderRequestCache(env, state, 'Provider rolling spend reservation unavailable');
    return rollingReservation;
  }
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
      await abandonProviderRequestCache(env, state, 'Provider monthly capacity unavailable');
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
      await abandonProviderRequestCache(env, state, 'Provider cost accounting unavailable');
      console.error('[provider] Failed to reserve durable provider cost event', error);
      return json({ error: 'Provider cost accounting is temporarily unavailable' }, 503);
    }
    state.spendReservation = {
      sessionId,
      estimatedCostCents,
      monthlyPeriod,
      rollingReservationId: rollingReservation.id,
      eventId,
    };
    return null;
  }

  if (rollingReservation.id) {
    await env.DB.prepare(`
      DELETE FROM provider_spend_reservations
      WHERE id = ?
    `).bind(rollingReservation.id).run();
  }
  await abandonProviderRequestCache(env, state, 'Provider session reservation lost a concurrent race');

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
