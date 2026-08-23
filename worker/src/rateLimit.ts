import type { Env, PublicAuthContext } from './types';

interface LimitRule {
  limit: number;
  windowSeconds: number;
}

const ROUTE_LIMITS: Record<string, { anonymous: LimitRule; signedIn: LimitRule }> = {
  'proxy:gemini': {
    anonymous: { limit: 24, windowSeconds: 24 * 60 * 60 },
    signedIn: { limit: 1200, windowSeconds: 60 * 60 },
  },
  'proxy:fal': {
    anonymous: { limit: 20, windowSeconds: 24 * 60 * 60 },
    signedIn: { limit: 1200, windowSeconds: 60 * 60 },
  },
  'proxy:default': {
    anonymous: { limit: 80, windowSeconds: 60 * 60 },
    signedIn: { limit: 600, windowSeconds: 60 * 60 },
  },
  'generation:authorize': {
    anonymous: { limit: 1, windowSeconds: 24 * 60 * 60 },
    signedIn: { limit: 120, windowSeconds: 24 * 60 * 60 },
  },
  'generation:job': {
    anonymous: { limit: 1, windowSeconds: 24 * 60 * 60 },
    signedIn: { limit: 240, windowSeconds: 24 * 60 * 60 },
  },
  'billing:checkout': {
    anonymous: { limit: 4, windowSeconds: 60 * 60 },
    signedIn: { limit: 20, windowSeconds: 60 * 60 },
  },
  'provider:session': {
    anonymous: { limit: 4, windowSeconds: 60 * 60 },
    signedIn: { limit: 80, windowSeconds: 60 * 60 },
  },
  'provider:session:stage_background': {
    anonymous: { limit: 1, windowSeconds: 24 * 60 * 60 },
    signedIn: { limit: 5, windowSeconds: 24 * 60 * 60 },
  },
  'provider:session:intro_video': {
    anonymous: { limit: 1, windowSeconds: 24 * 60 * 60 },
    signedIn: { limit: 12, windowSeconds: 24 * 60 * 60 },
  },
  'community:clone': {
    anonymous: { limit: 4, windowSeconds: 24 * 60 * 60 },
    signedIn: { limit: 60, windowSeconds: 24 * 60 * 60 },
  },
  'community:report': {
    anonymous: { limit: 1, windowSeconds: 24 * 60 * 60 },
    signedIn: { limit: 10, windowSeconds: 24 * 60 * 60 },
  },
  'admin:moderation': {
    anonymous: { limit: 1, windowSeconds: 60 * 60 },
    signedIn: { limit: 300, windowSeconds: 60 * 60 },
  },
  'admin:arcade': {
    anonymous: { limit: 1, windowSeconds: 60 * 60 },
    signedIn: { limit: 300, windowSeconds: 60 * 60 },
  },
  'fighters:upload': {
    anonymous: { limit: 4, windowSeconds: 24 * 60 * 60 },
    signedIn: { limit: 240, windowSeconds: 24 * 60 * 60 },
  },
  'fighters:write': {
    anonymous: { limit: 4, windowSeconds: 60 * 60 },
    signedIn: { limit: 240, windowSeconds: 60 * 60 },
  },
  'matches:report': {
    anonymous: { limit: 4, windowSeconds: 60 * 60 },
    signedIn: { limit: 240, windowSeconds: 60 * 60 },
  },
};

function getLimit(routeKey: string, auth: PublicAuthContext): LimitRule {
  const plan = auth.user?.plan_tier;
  if (plan === 'admin' || plan === 'studio') {
    return { limit: 5000, windowSeconds: 60 * 60 };
  }
  if (plan === 'pro') {
    return { limit: 1200, windowSeconds: 60 * 60 };
  }

  const route = ROUTE_LIMITS[routeKey] ?? ROUTE_LIMITS['proxy:default'];
  return auth.userId ? route.signedIn : route.anonymous;
}

function rateLimitWindow(
  routeKey: string,
  auth: PublicAuthContext,
  windowSeconds: number,
  now: number,
): { key: string; expiresAt: string; retryAfterSeconds: number } {
  const windowMs = windowSeconds * 1000;
  const windowStartMs = Math.floor(now / windowMs) * windowMs;
  const windowEndMs = windowStartMs + windowMs;
  const safeRateKey = auth.rateLimitKey.replace(/[^a-z0-9:_-]/gi, '_');
  return {
    key: `${routeKey}:${safeRateKey}:${Math.floor(windowStartMs / 1000)}`,
    expiresAt: new Date(windowEndMs).toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil((windowEndMs - now) / 1000)),
  };
}

export async function enforceRateLimit(
  env: Env,
  routeKey: string,
  auth: PublicAuthContext,
): Promise<Response | null> {
  const rule = getLimit(routeKey, auth);
  const now = Date.now();
  const window = rateLimitWindow(routeKey, auth, rule.windowSeconds, now);
  const [counter] = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO rate_limits (key, count, expires_at)
      VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE
          WHEN datetime(rate_limits.expires_at) <= datetime('now') THEN 1
          ELSE rate_limits.count + 1
        END,
        expires_at = excluded.expires_at
      RETURNING count
    `).bind(window.key, window.expiresAt),
    env.DB.prepare(`
      DELETE FROM rate_limits
      WHERE key IN (
        SELECT key
        FROM rate_limits
        WHERE datetime(expires_at) <= datetime('now') AND key <> ?
        ORDER BY expires_at ASC
        LIMIT 10
      )
    `).bind(window.key),
  ]);
  const count = Number((counter.results?.[0] as { count?: number } | undefined)?.count ?? 0);
  return count > rule.limit ? rateLimitResponse(window.retryAfterSeconds) : null;
}

function rateLimitResponse(retryAfterSeconds: number): Response {
  return Response.json(
    { error: 'Rate limit exceeded', retryAfter: retryAfterSeconds },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}
