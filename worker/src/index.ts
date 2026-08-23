import { generateId, optionalAuth, requireAuth } from './auth';
import {
  authorizeGenerationPurchase,
  completeGenerationPurchase,
  createCreditCheckoutSession,
  creditPacksResponse,
  handleStripeWebhook,
  releaseExpiredGenerationCharges,
} from './billing';
import {
  createFighter,
  cloneCommunityFighter,
  deleteFighter,
  getAsset,
  getCommunityFighter,
  getFighter,
  getPublicFighterSourceAsset,
  getPublicFighterSpriteAsset,
  listAdminArcadeFighters,
  listArcadeFighters,
  listCommunityFighters,
  listFighters,
  listStages,
  patchFighter,
  promoteFighterSpriteVersion,
  reportCommunityFighter,
  requestFighterUpgrade,
  shareCommunityFighterPage,
  tiersResponse,
  uploadFighterSource,
  uploadFighterSprite,
  upsertAdminArcadeFighter,
} from './fighters';
import { ensureSystemUser, getLeaderboard, getPlayerStats, reportMatchResult } from './leaderboard';
import { getTempAsset, handleProxy } from './proxy';
import { enforceRateLimit } from './rateLimit';
import { createFeatureProviderSession } from './providerSessions';
import type { AuthContext, Env, PublicAuthContext, User } from './types';
import { turnstileConfigurationStatus } from './turnstile';
import { handleClerkWebhook } from './clerkWebhooks';
import { cleanupOperationalData } from './maintenance';
import { listCommunityReports, moderateCommunityReport } from './moderation';
import { CURRENT_LEGAL_VERSION } from './legal';
import { optionalGenerationJobAuth } from './generationAuth';
import {
  startAdminArcadeAnimationGeneration,
  startAdminArcadeGeneration,
} from './arcadeGeneration';
import {
  createGenerationJob,
  getGenerationJob,
  listGenerationJobs,
} from './generationJobs';
import {
  InvalidMultipartBodyError,
  InvalidJsonBodyError,
  readJsonBody,
  RequestBodyTooLargeError,
} from './requestBody';

export { FighterGenerationWorkflow } from './generationWorkflow';
export { ImageProcessorContainer } from './imageProcessorContainer';

const MAX_MATCH_ROUNDS = 5;
const MAX_MATCH_DURATION_SECONDS = 20 * 60;
const MAX_MATCH_ID_LENGTH = 128;
const MAX_MATCH_REPORT_BODY_BYTES = 16 * 1024;
const ARCADE_ADMIN_SEED_HEADER = 'X-Insert-Player-Admin-Seed';

function resolveCorsOrigin(request: Request, env: Env): string {
  const requestOrigin = request.headers.get('Origin') ?? '';
  const configured = (env.CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configured.length === 0) return '*';
  if (requestOrigin && configured.includes(requestOrigin)) return requestOrigin;
  return configured[0];
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = resolveCorsOrigin(request, env);
  const headers: HeadersInit = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-ASF-Provider-Session, X-Insert-Player-Provider-Request-Key',
    'Vary': 'Origin',
  };
  if (origin !== '*') {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function addCors(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

function decodePathParam(value: string): string | Response {
  try {
    return decodeURIComponent(value);
  } catch {
    return json({ error: 'Invalid path parameter' }, 400);
  }
}

async function authenticated(
  request: Request,
  env: Env,
  handler: (auth: AuthContext) => Promise<Response>,
): Promise<Response> {
  const isArcadeAdminSeed = request.headers.get(ARCADE_ADMIN_SEED_HEADER) === 'clerk-backend';
  const auth = await requireAuth(request, env, {
    allowMissingAuthorizedParty: isArcadeAdminSeed,
  });
  if (isResponse(auth)) return auth;
  if (isArcadeAdminSeed && auth.user.plan_tier !== 'admin') {
    return json({ error: 'Admin access required' }, 403);
  }
  return handler(auth);
}

function authAsPublicContext(auth: AuthContext): PublicAuthContext {
  return {
    userId: auth.userId,
    rateLimitKey: `user:${auth.userId}`,
    user: auth.user,
    claims: auth.claims,
  };
}

function hasBearerAuth(request: Request): boolean {
  return /^Bearer\s+\S+/i.test(request.headers.get('Authorization') ?? '');
}

async function sensitiveOptionalAuth(
  request: Request,
  env: Env,
  publicAuth: PublicAuthContext,
): Promise<PublicAuthContext | Response> {
  if (publicAuth.user || !hasBearerAuth(request)) return publicAuth;
  const auth = await requireAuth(request, env);
  if (isResponse(auth)) return auth;
  return authAsPublicContext(auth);
}

function readBoundedInteger(value: unknown, min: number, max: number): number {
  const parsed = Math.round(Number(value ?? 0));
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function readOptionalId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_MATCH_ID_LENGTH) return undefined;
  return /^[a-z0-9:_-]+$/i.test(trimmed) ? trimmed : undefined;
}

async function readOwnedFighterId(env: Env, userId: string, value: unknown): Promise<string | undefined | Response> {
  const fighterId = readOptionalId(value);
  if (!fighterId) return undefined;
  const fighter = await env.DB.prepare(
    'SELECT id FROM fighters WHERE id = ? AND owner_user_id = ?'
  ).bind(fighterId, userId).first<{ id: string }>();
  if (!fighter) return json({ error: 'Match fighter does not belong to this user' }, 403);
  return fighter.id;
}

async function authenticatedLimited(
  request: Request,
  env: Env,
  routeKey: string,
  handler: (auth: AuthContext) => Promise<Response>,
): Promise<Response> {
  return authenticated(request, env, async (auth) => {
    const limited = await enforceRateLimit(env, routeKey, authAsPublicContext(auth));
    if (limited) return limited;
    return handler(auth);
  });
}

function healthResponse(env: Env): Response {
  const providerSecrets = {
    gemini: Boolean(env.GEMINI_API_KEY),
    fal: Boolean(env.FAL_API_KEY),
    runway: Boolean(env.RUNWAY_API_KEY),
    freepik: Boolean(env.FREEPIK_API_KEY),
    ludo: Boolean(env.LUDO_API_KEY),
  };
  const allProvidersConfigured = Object.values(providerSecrets).every(Boolean);
  const authConfigured = Boolean(env.CLERK_ISSUER);
  const anonymousIdentifiersProtected = Boolean(env.ANONYMIZATION_SECRET);
  const stripeSecret = env.STRIPE_SECRET_KEY ?? '';
  const stripeWebhookSecret = env.STRIPE_WEBHOOK_SECRET ?? '';
  const stripeAccountPinned = /^acct_[A-Za-z0-9]+$/.test(env.STRIPE_ACCOUNT_ID ?? '');
  const stripeCatalogPinned = [env.STRIPE_PRICE_STARTER, env.STRIPE_PRICE_VERSUS, env.STRIPE_PRICE_ARCADE]
    .every((priceId) => /^price_[A-Za-z0-9]+$/.test(priceId ?? ''));
  const stripeLiveConfigured = stripeAccountPinned && stripeCatalogPinned && /^sk_live_/i.test(stripeSecret) && /^whsec_/i.test(stripeWebhookSecret);
  const stripeTestConfigured = stripeAccountPinned && stripeCatalogPinned && /^sk_test_/i.test(stripeSecret) && /^whsec_/i.test(stripeWebhookSecret);

  return json({
    status: 'ok',
    version: '0.17.0',
    legalVersion: CURRENT_LEGAL_VERSION,
    environment: env.ENVIRONMENT ?? 'unknown',
    cors: env.CORS_ORIGIN ? 'configured' : 'wildcard',
    auth: authConfigured ? 'clerk' : 'not_configured',
    accountLifecycle: env.CLERK_WEBHOOK_SIGNING_SECRET ? 'clerk_webhook' : 'not_configured',
    billing: stripeLiveConfigured ? 'stripe' : stripeTestConfigured ? 'stripe_test' : 'not_configured',
    turnstile: turnstileConfigurationStatus(env),
    anonymousRookie: env.ANONYMOUS_ROOKIE_ENABLED === 'false' ? 'disabled' : 'enabled',
    providerBudget: /^\d+$/.test(env.PROVIDER_MONTHLY_BUDGET_USD_CENTS ?? '')
      ? 'configured'
      : 'not_configured',
    providerSpendRate: /^\d+$/.test(env.GEMINI_SPEND_RATE_LIMIT_USD_CENTS ?? '')
      ? 'configured'
      : 'not_configured',
    storage: {
      d1: env.DB ? 'bound' : 'missing',
      r2: env.SPRITES ? 'bound' : 'missing',
    },
    durableGeneration: env.FIGHTER_GENERATION
      && env.IMAGE_PROCESSOR
      && env.GENERATION_JOB_SIGNING_SECRET
      ? 'configured'
      : 'not_configured',
    rateLimit: 'd1',
    privacy: anonymousIdentifiersProtected ? 'pseudonymized' : 'not_configured',
    providers: allProvidersConfigured ? 'configured' : 'partial',
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      if (path === '/api/clerk/webhook' && method === 'POST') {
        return addCors(await handleClerkWebhook(request, env), request, env);
      }

      const generationAuth = path.startsWith('/proxy/')
        ? await optionalGenerationJobAuth(request, env)
        : null;
      if (generationAuth instanceof Response) {
        return addCors(generationAuth, request, env);
      }
      const publicAuth: PublicAuthContext = generationAuth ?? await optionalAuth(request, env);
      const proxied = path.startsWith('/proxy/')
        ? await handleProxy(request, env, publicAuth)
        : null;
      if (proxied) return addCors(proxied, request, env);

      if (path === '/health') {
        return addCors(healthResponse(env), request, env);
      }

      if (path.startsWith('/temp-assets/') && method === 'GET') {
        return addCors(await getTempAsset(request, env), request, env);
      }

      if (path === '/api/tiers' && method === 'GET') {
        return addCors(tiersResponse(), request, env);
      }

      if (path === '/api/billing/packs' && method === 'GET') {
        return addCors(creditPacksResponse(), request, env);
      }

      if (path === '/api/billing/generation' && method === 'POST') {
        const generationAuth = await sensitiveOptionalAuth(request, env, publicAuth);
        if (isResponse(generationAuth)) return addCors(generationAuth, request, env);
        const limited = await enforceRateLimit(env, 'generation:authorize', generationAuth);
        if (limited) return addCors(limited, request, env);
        return addCors(await authorizeGenerationPurchase(request, env, generationAuth), request, env);
      }

      if (path === '/api/billing/generation/complete' && method === 'POST') {
        return addCors(await authenticated(request, env, (auth) => completeGenerationPurchase(request, env, auth)), request, env);
      }

      if (path === '/api/provider-sessions' && method === 'POST') {
        return addCors(
          await authenticatedLimited(
            request,
            env,
            'provider:session',
            (auth) => createFeatureProviderSession(request, env, authAsPublicContext(auth)),
          ),
          request,
          env,
        );
      }

      if (path === '/api/billing/checkout' && method === 'POST') {
        return addCors(
          await authenticatedLimited(
            request,
            env,
            'billing:checkout',
            (auth) => createCreditCheckoutSession(request, env, auth),
          ),
          request,
          env,
        );
      }

      if (path === '/api/billing/stripe-webhook' && method === 'POST') {
        return addCors(await handleStripeWebhook(request, env), request, env);
      }

      if (path === '/api/community' && method === 'GET') {
        return addCors(await listCommunityFighters(request, env), request, env);
      }

      if (path === '/api/arcade' && method === 'GET') {
        return addCors(await listArcadeFighters(request, env), request, env);
      }

      const communityDetailMatch = path.match(/^\/api\/community\/([^/]+)$/);
      if (communityDetailMatch && method === 'GET') {
        const fighterId = decodePathParam(communityDetailMatch[1]);
        if (isResponse(fighterId)) return addCors(fighterId, request, env);
        return addCors(await getCommunityFighter(request, env, fighterId), request, env);
      }

      const shareMatch = path.match(/^\/share\/([^/]+)$/);
      if (shareMatch && method === 'GET') {
        const fighterId = decodePathParam(shareMatch[1]);
        if (isResponse(fighterId)) return addCors(fighterId, request, env);
        return addCors(await shareCommunityFighterPage(request, env, fighterId), request, env);
      }

      const publicSourceAssetMatch = path.match(
        /^\/public-assets\/fighters\/([^/]+)\/sources\/(side|upright|crouch)\/([^/]+)$/,
      );
      if (publicSourceAssetMatch && method === 'GET') {
        const fighterId = decodePathParam(publicSourceAssetMatch[1]);
        const revision = decodePathParam(publicSourceAssetMatch[3]);
        if (isResponse(fighterId)) return addCors(fighterId, request, env);
        if (isResponse(revision)) return addCors(revision, request, env);
        return addCors(
          await getPublicFighterSourceAsset(
            env,
            fighterId,
            publicSourceAssetMatch[2] as 'side' | 'upright' | 'crouch',
            revision,
          ),
          request,
          env,
        );
      }

      const publicSpriteAssetMatch = path.match(
        /^\/public-assets\/fighters\/([^/]+)\/sprites\/([^/]+)\/([^/]+)$/,
      );
      if (publicSpriteAssetMatch && method === 'GET') {
        const fighterId = decodePathParam(publicSpriteAssetMatch[1]);
        const spriteId = decodePathParam(publicSpriteAssetMatch[2]);
        const revision = decodePathParam(publicSpriteAssetMatch[3]);
        if (isResponse(fighterId)) return addCors(fighterId, request, env);
        if (isResponse(spriteId)) return addCors(spriteId, request, env);
        if (isResponse(revision)) return addCors(revision, request, env);
        return addCors(
          await getPublicFighterSpriteAsset(env, fighterId, spriteId, revision),
          request,
          env,
        );
      }

      const communityCloneMatch = path.match(/^\/api\/community\/([^/]+)\/clone$/);
      if (communityCloneMatch && method === 'POST') {
        const sourceFighterId = decodePathParam(communityCloneMatch[1]);
        if (isResponse(sourceFighterId)) return addCors(sourceFighterId, request, env);
        return addCors(
          await authenticatedLimited(
            request,
            env,
            'community:clone',
            (auth) => cloneCommunityFighter(request, env, auth, sourceFighterId),
          ),
          request,
          env,
        );
      }

      const communityReportMatch = path.match(/^\/api\/community\/([^/]+)\/report$/);
      if (communityReportMatch && method === 'POST') {
        const fighterId = decodePathParam(communityReportMatch[1]);
        if (isResponse(fighterId)) return addCors(fighterId, request, env);
        return addCors(
          await authenticatedLimited(
            request,
            env,
            'community:report',
            (auth) => reportCommunityFighter(request, env, auth, fighterId),
          ),
          request,
          env,
        );
      }

      if (path === '/api/admin/community-reports' && method === 'GET') {
        return addCors(
          await authenticatedLimited(
            request,
            env,
            'admin:moderation',
            (auth) => listCommunityReports(request, env, auth),
          ),
          request,
          env,
        );
      }

      if (path === '/api/admin/arcade' && method === 'GET') {
        return addCors(
          await authenticatedLimited(
            request,
            env,
            'admin:arcade',
            (auth) => listAdminArcadeFighters(env, auth),
          ),
          request,
          env,
        );
      }

      const arcadeAdminMatch = path.match(/^\/api\/admin\/arcade\/([^/]+)$/);
      if (arcadeAdminMatch && method === 'PATCH') {
        const arcadeFighterId = decodePathParam(arcadeAdminMatch[1]);
        if (isResponse(arcadeFighterId)) return addCors(arcadeFighterId, request, env);
        return addCors(
          await authenticatedLimited(
            request,
            env,
            'admin:arcade',
            (auth) => upsertAdminArcadeFighter(request, env, auth, arcadeFighterId),
          ),
          request,
          env,
        );
      }

      const arcadeGenerationMatch = path.match(/^\/api\/admin\/arcade\/([^/]+)\/generate$/);
      if (arcadeGenerationMatch && method === 'POST') {
        const arcadeFighterId = decodePathParam(arcadeGenerationMatch[1]);
        if (isResponse(arcadeFighterId)) return addCors(arcadeFighterId, request, env);
        return addCors(
          await authenticatedLimited(
            request,
            env,
            'admin:arcade',
            (auth) => startAdminArcadeGeneration(request, env, auth, arcadeFighterId),
          ),
          request,
          env,
        );
      }

      const arcadeAnimationGenerationMatch = path.match(
        /^\/api\/admin\/arcade\/([^/]+)\/generate\/([^/]+)$/,
      );
      if (arcadeAnimationGenerationMatch && method === 'POST') {
        const arcadeFighterId = decodePathParam(arcadeAnimationGenerationMatch[1]);
        if (isResponse(arcadeFighterId)) return addCors(arcadeFighterId, request, env);
        const animationName = decodePathParam(arcadeAnimationGenerationMatch[2]);
        if (isResponse(animationName)) return addCors(animationName, request, env);
        return addCors(
          await authenticatedLimited(
            request,
            env,
            'admin:arcade',
            (auth) => startAdminArcadeAnimationGeneration(
              request,
              env,
              auth,
              arcadeFighterId,
              animationName,
            ),
          ),
          request,
          env,
        );
      }

      const communityModerationMatch = path.match(/^\/api\/admin\/community-reports\/([^/]+)$/);
      if (communityModerationMatch && method === 'PATCH') {
        const reportId = decodePathParam(communityModerationMatch[1]);
        if (isResponse(reportId)) return addCors(reportId, request, env);
        return addCors(
          await authenticatedLimited(
            request,
            env,
            'admin:moderation',
            (auth) => moderateCommunityReport(request, env, auth, reportId),
          ),
          request,
          env,
        );
      }

      if (path === '/auth/me' && method === 'GET') {
        if (!publicAuth.user) return addCors(json({ user: null }), request, env);
        await releaseExpiredGenerationCharges(env, publicAuth.user.id);
        const user = await env.DB.prepare(
          'SELECT * FROM users WHERE id = ?'
        ).bind(publicAuth.user.id).first<User>() ?? publicAuth.user;
        return addCors(json({
          user: {
            id: user.id,
            clerkUserId: user.clerk_user_id,
            displayName: user.display_name,
            avatarUrl: user.avatar_url,
            email: user.email,
            planTier: user.plan_tier,
            creditsBalance: user.credits_balance,
            freeRookieGenerationsUsed: user.free_rookie_generations_used,
            eloRating: user.elo_rating,
            wins: user.wins,
            losses: user.losses,
            winStreak: user.win_streak,
          },
        }), request, env);
      }

      if (path === '/api/fighters' && method === 'GET') {
        return addCors(await authenticated(request, env, (auth) => listFighters(request, env, auth)), request, env);
      }

      if (path === '/api/generation-jobs' && method === 'GET') {
        return addCors(
          await authenticated(request, env, (auth) => listGenerationJobs(env, auth)),
          request,
          env,
        );
      }

      if (path === '/api/generation-jobs' && method === 'POST') {
        return addCors(
          await authenticatedLimited(
            request,
            env,
            'generation:job',
            (auth) => createGenerationJob(request, env, auth),
          ),
          request,
          env,
        );
      }

      const generationJobMatch = path.match(/^\/api\/generation-jobs\/([^/]+)$/);
      if (generationJobMatch && method === 'GET') {
        const jobId = decodePathParam(generationJobMatch[1]);
        if (isResponse(jobId)) return addCors(jobId, request, env);
        return addCors(
          await authenticated(request, env, (auth) => getGenerationJob(env, auth, jobId)),
          request,
          env,
        );
      }

      if (path === '/api/fighters' && method === 'POST') {
        return addCors(
          await authenticatedLimited(
            request,
            env,
            'fighters:write',
            (auth) => createFighter(request, env, auth),
          ),
          request,
          env,
        );
      }

      const fighterMatch = path.match(/^\/api\/fighters\/([^/]+)(?:\/([^/]+))?$/);
      if (fighterMatch) {
        const fighterId = decodePathParam(fighterMatch[1]);
        if (isResponse(fighterId)) return addCors(fighterId, request, env);
        const action = fighterMatch[2] ?? '';
        if (!action && method === 'GET') {
          return addCors(await authenticated(request, env, (auth) => getFighter(request, env, auth, fighterId)), request, env);
        }
        if (!action && method === 'PATCH') {
          return addCors(
            await authenticatedLimited(
              request,
              env,
              'fighters:write',
              (auth) => patchFighter(request, env, auth, fighterId),
            ),
            request,
            env,
          );
        }
        if (!action && method === 'DELETE') {
          return addCors(
            await authenticatedLimited(
              request,
              env,
              'fighters:write',
              (auth) => deleteFighter(env, auth, fighterId),
            ),
            request,
            env,
          );
        }
        if (action === 'sources' && method === 'POST') {
          return addCors(
            await authenticatedLimited(
              request,
              env,
              'fighters:upload',
              (auth) => uploadFighterSource(request, env, auth, fighterId),
            ),
            request,
            env,
          );
        }
        if (action === 'sprites' && method === 'POST') {
          return addCors(
            await authenticatedLimited(
              request,
              env,
              'fighters:upload',
              (auth) => uploadFighterSprite(request, env, auth, fighterId),
            ),
            request,
            env,
          );
        }
        if (action === 'sprites' && method === 'PATCH') {
          return addCors(
            await authenticatedLimited(
              request,
              env,
              'fighters:write',
              (auth) => promoteFighterSpriteVersion(request, env, auth, fighterId),
            ),
            request,
            env,
          );
        }
        if (action === 'upgrade' && method === 'POST') {
          return addCors(
            await authenticatedLimited(
              request,
              env,
              'fighters:write',
              (auth) => requestFighterUpgrade(request, env, auth, fighterId),
            ),
            request,
            env,
          );
        }
      }

      if (path === '/api/stages' && method === 'GET') {
        return addCors(await authenticated(request, env, (auth) => listStages(request, env, auth)), request, env);
      }

      if (path.startsWith('/assets/') && method === 'GET') {
        const key = path.slice('/assets/'.length);
        return addCors(await getAsset(request, env, publicAuth, key), request, env);
      }

      if (path === '/api/leaderboard' && method === 'GET') {
        return addCors(await getLeaderboard(env), request, env);
      }

      if (path === '/api/stats' && method === 'GET') {
        return addCors(await authenticated(request, env, (auth) => getPlayerStats(env, auth.userId)), request, env);
      }

      if (path.startsWith('/api/stats/') && method === 'GET') {
        const userId = decodePathParam(path.split('/')[3] ?? '');
        if (isResponse(userId)) return addCors(userId, request, env);
        return addCors(await authenticated(request, env, (auth) => {
          if (userId !== auth.userId) return Promise.resolve(json({ error: 'Stats are private' }, 403));
          return getPlayerStats(env, auth.userId);
        }), request, env);
      }

      if (path === '/api/matches' && method === 'POST') {
        return addCors(await authenticatedLimited(request, env, 'matches:report', async (auth) => {
          const body = await readJsonBody<Record<string, unknown>>(request, MAX_MATCH_REPORT_BODY_BYTES);
          const opponentKind = body.opponentKind === 'local' ? 'local' : 'cpu';
          const systemOpponentId = opponentKind === 'local' ? 'system:local-player' : 'system:cpu';
          const systemOpponentName = opponentKind === 'local' ? 'Local Player 2' : 'CPU Opponent';
          const player2Id = systemOpponentId;
          await ensureSystemUser(env, systemOpponentId, systemOpponentName);
          const winnerSlot = body.winnerSlot === 'p2' ? 'p2' : 'p1';
          const winnerId = winnerSlot === 'p2' ? player2Id : auth.userId;
          const p1FighterId = await readOwnedFighterId(env, auth.userId, body.p1FighterId);
          if (isResponse(p1FighterId)) return p1FighterId;
          const p2FighterId = await readOwnedFighterId(env, auth.userId, body.p2FighterId);
          if (isResponse(p2FighterId)) return p2FighterId;
          return reportMatchResult(env, {
            matchId: generateId(),
            player1Id: auth.userId,
            player2Id,
            winnerId,
            roundsP1: readBoundedInteger(body.roundsP1, 0, MAX_MATCH_ROUNDS),
            roundsP2: readBoundedInteger(body.roundsP2, 0, MAX_MATCH_ROUNDS),
            duration: readBoundedInteger(body.duration, 0, MAX_MATCH_DURATION_SECONDS),
            p1CharId: readOptionalId(body.p1CharacterId),
            p2CharId: readOptionalId(body.p2CharacterId),
            p1FighterId,
            p2FighterId,
            isRanked: false,
          });
        }), request, env);
      }

      return addCors(json({ error: 'Not found' }, 404), request, env);
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        return addCors(json({ error: 'Request body is too large' }, 413), request, env);
      }
      if (err instanceof InvalidJsonBodyError) {
        return addCors(json({ error: 'Invalid JSON request body' }, 400), request, env);
      }
      if (err instanceof InvalidMultipartBodyError) {
        return addCors(json({ error: 'Invalid multipart request body' }, 400), request, env);
      }
      console.error('Worker error:', err);
      const message = err instanceof Error ? err.message : 'Internal server error';
      const isProduction = env.ENVIRONMENT === 'production';
      return addCors(json(
        isProduction
          ? { error: 'Internal server error' }
          : { error: 'Internal server error', message },
        500,
      ), request, env);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await cleanupOperationalData(env);
  },
};
