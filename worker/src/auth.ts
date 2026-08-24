import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AuthContext, Env, PublicAuthContext, User } from './types';
import { stripTrailingSlashes } from './url';

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedJwksUrl = '';

const MAX_PUBLIC_NAME_CHARS = 48;
const MAX_EMAIL_CHARS = 254;

export function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashString(input: string | ArrayBuffer): Promise<string> {
  const encoded = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacString(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function anonymousRateLimitKey(request: Request, env: Env): Promise<string> {
  const secret = env.ANONYMIZATION_SECRET?.trim() || (
    env.ENVIRONMENT === 'production' ? '' : 'insert-player-local-development-only'
  );
  if (!secret) throw new Error('ANONYMIZATION_SECRET is required');
  const address = (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'anonymous'
  ).trim().toLowerCase().slice(0, 128);
  return `anon:${await hmacString(secret, address)}`;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function getBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function getClerkIssuer(env: Env): string {
  const issuer = stripTrailingSlashes(env.CLERK_ISSUER ?? '');
  if (!issuer) {
    throw new Error('CLERK_ISSUER is required');
  }
  return issuer;
}

function getJwks(env: Env): ReturnType<typeof createRemoteJWKSet> {
  const issuer = getClerkIssuer(env);
  const jwksUrl = env.CLERK_JWKS_URL || (issuer ? `${issuer}/.well-known/jwks.json` : '');
  if (!jwksUrl) {
    throw new Error('CLERK_JWKS_URL is required');
  }
  if (!cachedJwks || cachedJwksUrl !== jwksUrl) {
    cachedJwksUrl = jwksUrl;
    cachedJwks = createRemoteJWKSet(new URL(jwksUrl));
  }
  return cachedJwks;
}

function readStringClaim(claims: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = claims[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function cleanProfileString(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

export function normalizePublicDisplayName(value: unknown, fallback = 'Player'): string {
  const normalized = cleanProfileString(value) || cleanProfileString(fallback) || 'Player';
  return Array.from(normalized).slice(0, MAX_PUBLIC_NAME_CHARS).join('');
}

export function normalizeOptionalHttpsUrl(value: unknown): string | null {
  const normalized = cleanProfileString(value);
  if (!normalized || normalized.length > 2048) return null;
  try {
    const url = new URL(normalized);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeOptionalEmail(value: unknown): string | null {
  const normalized = cleanProfileString(value);
  if (!normalized || normalized.length > MAX_EMAIL_CHARS || !normalized.includes('@')) return null;
  return normalized;
}

function normalizeOrigin(value: string): string {
  return stripTrailingSlashes(value.trim());
}

function configuredAuthorizedParties(env: Env): string[] {
  return (env.CLERK_AUTHORIZED_PARTIES || env.CORS_ORIGIN || '')
    .split(',')
    .map(normalizeOrigin)
    .filter((origin) => /^https?:\/\//i.test(origin));
}

export function assertAuthorizedParty(
  claims: Record<string, unknown>,
  env: Env,
  options: { allowMissingAuthorizedParty?: boolean } = {},
): void {
  const allowed = configuredAuthorizedParties(env);
  if (allowed.length === 0) return;

  const azp = readStringClaim(claims, ['azp']);
  if (!azp && options.allowMissingAuthorizedParty) return;
  if (!azp || !allowed.includes(normalizeOrigin(azp))) {
    throw new Error('Clerk token authorized party is not allowed');
  }
}

function resolveDisplayName(claims: Record<string, unknown>): string | null {
  const fullName = readStringClaim(claims, ['name', 'full_name']);
  if (fullName) return normalizePublicDisplayName(fullName);
  const first = readStringClaim(claims, ['given_name', 'first_name']);
  const last = readStringClaim(claims, ['family_name', 'last_name']);
  const joined = [first, last].filter(Boolean).join(' ').trim();
  if (joined) return normalizePublicDisplayName(joined);
  const fallback = readStringClaim(claims, ['username', 'email']);
  return fallback ? normalizePublicDisplayName(fallback) : null;
}

export async function verifyClerkRequest(
  request: Request,
  env: Env,
  options: { allowMissingAuthorizedParty?: boolean } = {},
): Promise<AuthContext | null> {
  const token = getBearerToken(request);
  if (!token) return null;

  const issuer = getClerkIssuer(env);
  const verifyOptions = { issuer };
  const verified = await jwtVerify(token, getJwks(env), verifyOptions);
  const claims = verified.payload as Record<string, unknown>;
  assertAuthorizedParty(claims, env, options);
  const clerkUserId = typeof verified.payload.sub === 'string' ? verified.payload.sub : null;
  if (!clerkUserId) throw new Error('Clerk token missing subject');

  const user = await upsertClerkUser(env, clerkUserId, claims);
  return { userId: user.id, user, claims };
}

export async function optionalAuth(request: Request, env: Env): Promise<PublicAuthContext> {
  try {
    const auth = await verifyClerkRequest(request, env);
    if (auth) {
      return {
        userId: auth.userId,
        rateLimitKey: `user:${auth.userId}`,
        user: auth.user,
        claims: auth.claims,
      };
    }
  } catch (err) {
    console.warn('Optional auth failed:', err instanceof Error ? err.message : err);
  }

  return {
    userId: null,
    rateLimitKey: await anonymousRateLimitKey(request, env),
    user: null,
    claims: null,
  };
}

export async function requireAuth(
  request: Request,
  env: Env,
  options: { allowMissingAuthorizedParty?: boolean } = {},
): Promise<AuthContext | Response> {
  try {
    const auth = await verifyClerkRequest(request, env, options);
    if (!auth) return json({ error: 'Unauthorized' }, 401);
    return auth;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unauthorized';
    const status = message.includes('CLERK_') ? 503 : 401;
    const error = status === 503 ? 'Auth not configured' : 'Unauthorized';
    if (env.ENVIRONMENT === 'production') return json({ error }, status);
    return json({ error, message }, status);
  }
}

export async function upsertClerkUser(
  env: Env,
  clerkUserId: string,
  claims: Record<string, unknown>,
): Promise<User> {
  return upsertClerkUserProfile(env, clerkUserId, {
    displayName: resolveDisplayName(claims),
    avatarUrl: readStringClaim(claims, ['picture', 'image_url', 'avatar_url']),
    email: readStringClaim(claims, ['email', 'primary_email_address']),
  }, { preserveMissingFields: true });
}

export async function isClerkUserTombstoned(env: Env, clerkUserId: string): Promise<boolean> {
  const subjectHash = await hashString(clerkUserId);
  const tombstone = await env.DB.prepare(
    'SELECT subject_hash FROM clerk_user_tombstones WHERE subject_hash = ?'
  ).bind(subjectHash).first<{ subject_hash: string }>();
  return Boolean(tombstone);
}

export async function upsertClerkUserProfile(
  env: Env,
  clerkUserId: string,
  profile: { displayName?: unknown; avatarUrl?: unknown; email?: unknown },
  options: { preserveMissingFields?: boolean } = {},
): Promise<User> {
  const subjectHash = await hashString(clerkUserId);
  if (await isClerkUserTombstoned(env, clerkUserId)) {
    throw new Error('Clerk user has been deleted');
  }

  const displayNameValue = cleanProfileString(profile.displayName);
  const displayName = displayNameValue ? normalizePublicDisplayName(displayNameValue) : 'Player';
  const avatarUrl = normalizeOptionalHttpsUrl(profile.avatarUrl);
  const email = normalizeOptionalEmail(profile.email);
  const preserveMissingFields = options.preserveMissingFields ? 1 : 0;
  const hasDisplayName = displayNameValue ? 1 : 0;

  await env.DB.prepare(`
    INSERT INTO users (id, clerk_user_id, display_name, avatar_url, email, oauth_provider, oauth_id)
    SELECT ?, ?, ?, ?, ?, 'clerk', ?
    WHERE NOT EXISTS (
      SELECT 1 FROM clerk_user_tombstones WHERE subject_hash = ?
    )
    ON CONFLICT(id) DO UPDATE SET
      clerk_user_id = excluded.clerk_user_id,
      display_name = CASE
        WHEN ? = 1 AND ? = 0 THEN users.display_name
        ELSE excluded.display_name
      END,
      avatar_url = CASE
        WHEN ? = 1 AND excluded.avatar_url IS NULL THEN users.avatar_url
        ELSE excluded.avatar_url
      END,
      email = CASE
        WHEN ? = 1 AND excluded.email IS NULL THEN users.email
        ELSE excluded.email
      END,
      oauth_provider = 'clerk',
      oauth_id = excluded.oauth_id,
      updated_at = datetime('now')
  `).bind(
    clerkUserId,
    clerkUserId,
    displayName,
    avatarUrl,
    email,
    clerkUserId,
    subjectHash,
    preserveMissingFields,
    hasDisplayName,
    preserveMissingFields,
    preserveMissingFields,
  ).run();

  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(clerkUserId).first<User>();
  if (!user) throw new Error('Clerk user has been deleted');
  return user;
}
