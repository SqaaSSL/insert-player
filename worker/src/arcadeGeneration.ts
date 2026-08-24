import { generateId } from './auth';
import { inspectArcadeAssetIntegrity } from './arcadeAssets';
import { createGenerationJob } from './generationJobs';
import {
  CURRENT_LEGAL_VERSION,
  parseGenerationLegalAttestation,
} from './legal';
import { createProviderSession } from './providerSessions';
import { readJsonBody } from './requestBody';
import type { AuthContext, Env, PublicAuthContext } from './types';
import {
  isOfficialArcadeImageProviderContract,
  OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT,
} from '../../src/services/ImageProviderContract';

const MAX_ADMIN_GENERATION_BODY_BYTES = 8 * 1024;
const AUTHORIZATION_TTL_HOURS = 12;
const PLAYABLE_ANIMATION_NAMES = [
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
] as const;
const CANONICAL_SOURCE_NAMES = ['side', 'upright', 'crouch'] as const;

interface ArcadeGenerationFighterRow {
  id: string;
  owner_user_id: string;
  original_blob_key: string | null;
  arcade_status: 'draft' | 'active' | 'retired';
}

interface ActiveArcadeJobRow {
  id: string;
  fighter_id: string;
  status: 'queued' | 'running';
  stage: string;
  progress_current: number;
  progress_total: number;
  created_at: string;
  updated_at: string;
}

interface ReusableArcadeAuthorizationRow {
  purchase_id: string;
  provider_session_id: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function authorizationExpiresAt(): string {
  return new Date(Date.now() + AUTHORIZATION_TTL_HOURS * 60 * 60 * 1000).toISOString();
}

function publicAuth(auth: AuthContext): PublicAuthContext {
  return {
    userId: auth.userId,
    rateLimitKey: `user:${auth.userId}`,
    user: auth.user,
    claims: auth.claims,
  };
}

export async function readAdminArcadeGenerationContract(
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  if (auth.user.plan_tier !== 'admin') return json({ error: 'Admin access required' }, 403);
  if (!env.IMAGE_PROCESSOR) {
    return json({
      error: 'Image processor binding is unavailable',
      reason: 'processor_binding_unavailable',
    }, 503);
  }

  try {
    const processor = env.IMAGE_PROCESSOR.getByName('official-arcade-provider-contract-v1');
    const response = await processor.fetch(new Request('http://image-processor/health'));
    if (!response.ok) {
      return json({
        error: 'Image processor health check failed',
        reason: 'processor_health_http_failed',
        upstreamStatus: response.status,
      }, 503);
    }
    const payload = await response.json<{
      status?: unknown;
      runtime?: unknown;
      imageProviderContract?: unknown;
    }>();
    if (payload.status !== 'ok') {
      return json({
        error: 'Image processor health status is not approved',
        reason: 'processor_health_status_unapproved',
      }, 503);
    }
    if (payload.runtime !== 'canvas-skia') {
      return json({
        error: 'Image processor runtime is not approved',
        reason: 'processor_runtime_unapproved',
      }, 503);
    }
    if (payload.imageProviderContract == null) {
      return json({
        error: 'Image processor provider contract is missing',
        reason: 'processor_contract_missing',
      }, 503);
    }
    if (!isOfficialArcadeImageProviderContract(payload.imageProviderContract)) {
      return json({
        error: 'Image processor provider contract is not approved',
        reason: 'processor_contract_unapproved',
      }, 503);
    }
    return json({
      ready: true,
      runtime: payload.runtime,
      contract: OFFICIAL_ARCADE_IMAGE_PROVIDER_CONTRACT,
    });
  } catch {
    return json({
      error: 'Image processor provider contract could not be verified',
      reason: 'processor_contract_verification_failed',
    }, 503);
  }
}

function generationJobRequest(
  request: Request,
  fighterId: string,
  purchaseId: string,
  providerSessionId: string,
  target?: { kind: 'animation' | 'source'; name: string },
): Request {
  return new Request(request.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fighterId,
      purchaseId,
      providerSessionId,
      ...(target ? { targetKind: target.kind, targetName: target.name } : {}),
    }),
  });
}

async function createAdminGenerationAuthorization(
  env: Env,
  auth: AuthContext,
  fighterId: string,
  params: {
    chargeReason: 'arcade_seed_generation' | 'fighter_retry_animation' | 'fighter_retry_source';
    purpose: 'fighter_generation' | 'fighter_retry';
    operation: 'fighter_generation' | 'fighter_retry_animation' | 'fighter_retry_source';
    legal: NonNullable<ReturnType<typeof parseGenerationLegalAttestation>>;
  },
): Promise<{ purchaseId: string; providerSessionId: string }> {
  const purchaseId = generateId();
  const ledgerId = generateId();
  const expiresAt = authorizationExpiresAt();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
      VALUES (?, ?, 0, ?, ?)
    `).bind(ledgerId, auth.userId, params.chargeReason, fighterId),
    env.DB.prepare(`
      INSERT INTO generation_charges (
        id, user_id, tier, credit_cost, free_quota_delta, status,
        reason, fighter_id, ledger_id, expires_at
      ) VALUES (?, ?, 'champion', 0, 0, 'reserved', ?, ?, ?, ?)
    `).bind(
      purchaseId,
      auth.userId,
      params.chargeReason,
      fighterId,
      ledgerId,
      expiresAt,
    ),
  ]);

  try {
    const providerSession = await createProviderSession(env, publicAuth(auth), {
      tier: 'champion',
      purpose: params.purpose,
      operation: params.operation,
      chargeId: purchaseId,
      legal: params.legal,
    });
    return { purchaseId, providerSessionId: providerSession.id };
  } catch (error) {
    await env.DB.prepare(`
      UPDATE generation_charges
      SET status = 'refunded', updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND status = 'reserved'
    `).bind(purchaseId, auth.userId).run();
    throw error;
  }
}

export async function startAdminArcadeGeneration(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
): Promise<Response> {
  if (auth.user.plan_tier !== 'admin') return json({ error: 'Admin access required' }, 403);
  if (!/^[a-f0-9]{32}$/.test(fighterId)) return json({ error: 'A valid fighterId is required' }, 400);

  const body = await readJsonBody<{ legal?: unknown }>(request, MAX_ADMIN_GENERATION_BODY_BYTES);
  const legal = parseGenerationLegalAttestation(body.legal);
  if (!legal) {
    return json({
      error: 'Current generation consent is required',
      legalVersion: CURRENT_LEGAL_VERSION,
    }, 428);
  }

  const fighter = await env.DB.prepare(`
    SELECT f.id, f.owner_user_id, f.original_blob_key, af.status AS arcade_status
    FROM fighters f
    JOIN arcade_fighters af ON af.fighter_id = f.id
    WHERE f.id = ? AND f.owner_user_id = ?
    LIMIT 1
  `).bind(fighterId, auth.userId).first<ArcadeGenerationFighterRow>();
  if (!fighter) return json({ error: 'Official Arcade fighter not found' }, 404);
  if (fighter.arcade_status === 'retired') {
    return json({ error: 'Retired Arcade fighters cannot start generation' }, 409);
  }
  if (!fighter.original_blob_key || !await env.SPRITES.head(fighter.original_blob_key)) {
    return json({ error: 'Upload the private reference image before generation' }, 409);
  }

  const assetIntegrity = await inspectArcadeAssetIntegrity(env, fighterId);
  if (assetIntegrity.ready) {
    return json({
      ready: true,
      fighterId,
      tier: 'champion',
      animationCount: assetIntegrity.animationCount,
    });
  }

  const active = await env.DB.prepare(`
    SELECT id, fighter_id, status, stage, progress_current, progress_total, created_at, updated_at
    FROM generation_jobs
    WHERE fighter_id = ? AND status IN ('queued', 'running')
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(fighterId).first<ActiveArcadeJobRow>();
  if (active) {
    return json({
      job: {
        id: active.id,
        fighterId: active.fighter_id,
        tier: 'champion',
        operation: 'fighter_generation',
        status: active.status,
        stage: active.stage,
        progressCurrent: active.progress_current,
        progressTotal: active.progress_total,
        createdAt: active.created_at,
        updatedAt: active.updated_at,
      },
      replayed: true,
    });
  }

  const reusable = await env.DB.prepare(`
    SELECT gc.id AS purchase_id, ps.id AS provider_session_id
    FROM generation_charges gc
    JOIN credit_ledger cl
      ON cl.id = gc.ledger_id
      AND cl.reason = 'arcade_seed_generation'
      AND cl.delta = 0
    JOIN provider_sessions ps
      ON ps.charge_id = gc.id
      AND ps.user_id = gc.user_id
      AND ps.status = 'active'
      AND datetime(ps.expires_at) > datetime('now')
    LEFT JOIN generation_jobs gj ON gj.charge_id = gc.id
    WHERE gc.user_id = ?
      AND gc.fighter_id = ?
      AND gc.tier = 'champion'
      AND gc.credit_cost = 0
      AND gc.free_quota_delta = 0
      AND gc.status = 'reserved'
      AND gc.reason = 'arcade_seed_generation'
      AND datetime(gc.expires_at) > datetime('now')
      AND gj.id IS NULL
    ORDER BY gc.created_at DESC
    LIMIT 1
  `).bind(auth.userId, fighterId).first<ReusableArcadeAuthorizationRow>();
  if (reusable) {
    return createGenerationJob(generationJobRequest(
      request,
      fighterId,
      reusable.purchase_id,
      reusable.provider_session_id,
    ), env, auth);
  }

  const authorization = await createAdminGenerationAuthorization(env, auth, fighterId, {
    chargeReason: 'arcade_seed_generation',
    purpose: 'fighter_generation',
    operation: 'fighter_generation',
    legal,
  });

  return createGenerationJob(generationJobRequest(
    request,
    fighterId,
    authorization.purchaseId,
    authorization.providerSessionId,
  ), env, auth);
}

export async function startAdminArcadeAnimationGeneration(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
  animationName: string,
): Promise<Response> {
  if (auth.user.plan_tier !== 'admin') return json({ error: 'Admin access required' }, 403);
  if (!/^[a-f0-9]{32}$/.test(fighterId)) return json({ error: 'A valid fighterId is required' }, 400);
  if (!(PLAYABLE_ANIMATION_NAMES as readonly string[]).includes(animationName)) {
    return json({ error: 'A valid playable animation is required' }, 400);
  }

  const body = await readJsonBody<{ legal?: unknown }>(request, MAX_ADMIN_GENERATION_BODY_BYTES);
  const legal = parseGenerationLegalAttestation(body.legal);
  if (!legal) {
    return json({
      error: 'Current generation consent is required',
      legalVersion: CURRENT_LEGAL_VERSION,
    }, 428);
  }

  const fighter = await env.DB.prepare(`
    SELECT f.id, f.owner_user_id, f.original_blob_key, af.status AS arcade_status
    FROM fighters f
    JOIN arcade_fighters af ON af.fighter_id = f.id
    WHERE f.id = ? AND f.owner_user_id = ?
    LIMIT 1
  `).bind(fighterId, auth.userId).first<ArcadeGenerationFighterRow>();
  if (!fighter) return json({ error: 'Official Arcade fighter not found' }, 404);
  if (fighter.arcade_status === 'retired') {
    return json({ error: 'Retired Arcade fighters cannot start generation' }, 409);
  }

  const active = await env.DB.prepare(`
    SELECT id
    FROM generation_jobs
    WHERE fighter_id = ? AND status IN ('queued', 'running')
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(fighterId).first<{ id: string }>();
  if (active) {
    return json({
      error: 'Another generation job is already active for this fighter',
      jobId: active.id,
    }, 409);
  }

  const authorization = await createAdminGenerationAuthorization(env, auth, fighterId, {
    chargeReason: 'fighter_retry_animation',
    purpose: 'fighter_retry',
    operation: 'fighter_retry_animation',
    legal,
  });

  return createGenerationJob(generationJobRequest(
    request,
    fighterId,
    authorization.purchaseId,
    authorization.providerSessionId,
    { kind: 'animation', name: animationName },
  ), env, auth);
}

export async function startAdminArcadeSourceGeneration(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
  sourceName: string,
): Promise<Response> {
  if (auth.user.plan_tier !== 'admin') return json({ error: 'Admin access required' }, 403);
  if (!/^[a-f0-9]{32}$/.test(fighterId)) return json({ error: 'A valid fighterId is required' }, 400);
  if (!(CANONICAL_SOURCE_NAMES as readonly string[]).includes(sourceName)) {
    return json({ error: 'A valid canonical source is required' }, 400);
  }

  const body = await readJsonBody<{ legal?: unknown }>(request, MAX_ADMIN_GENERATION_BODY_BYTES);
  const legal = parseGenerationLegalAttestation(body.legal);
  if (!legal) {
    return json({
      error: 'Current generation consent is required',
      legalVersion: CURRENT_LEGAL_VERSION,
    }, 428);
  }

  const fighter = await env.DB.prepare(`
    SELECT f.id, f.owner_user_id, f.original_blob_key, af.status AS arcade_status
    FROM fighters f
    JOIN arcade_fighters af ON af.fighter_id = f.id
    WHERE f.id = ? AND f.owner_user_id = ?
    LIMIT 1
  `).bind(fighterId, auth.userId).first<ArcadeGenerationFighterRow>();
  if (!fighter) return json({ error: 'Official Arcade fighter not found' }, 404);
  if (fighter.arcade_status === 'retired') {
    return json({ error: 'Retired Arcade fighters cannot start generation' }, 409);
  }

  const active = await env.DB.prepare(`
    SELECT id
    FROM generation_jobs
    WHERE fighter_id = ? AND status IN ('queued', 'running')
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(fighterId).first<{ id: string }>();
  if (active) {
    return json({
      error: 'Another generation job is already active for this fighter',
      jobId: active.id,
    }, 409);
  }

  const authorization = await createAdminGenerationAuthorization(env, auth, fighterId, {
    chargeReason: 'fighter_retry_source',
    purpose: 'fighter_retry',
    operation: 'fighter_retry_source',
    legal,
  });

  return createGenerationJob(generationJobRequest(
    request,
    fighterId,
    authorization.purchaseId,
    authorization.providerSessionId,
    { kind: 'source', name: sourceName },
  ), env, auth);
}
