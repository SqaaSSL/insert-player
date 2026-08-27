import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithTransientNetworkRetry } from './live-smoke-fetch.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function parseEnvText(text, values) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && value && !values.has(key)) values.set(key, value);
  }
}

function readEnvValues() {
  const values = new Map();
  for (const file of ['.env.production.local', '.env.production', '.env.local', '.env']) {
    const path = join(root, file);
    if (existsSync(path)) parseEnvText(readFileSync(path, 'utf8'), values);
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value) values.set(key, value);
  }
  return values;
}

function envValue(values, key) {
  return values.get(key)?.trim() ?? '';
}

const env = readEnvValues();
const smokeTarget = envValue(env, 'ASF_SMOKE_TARGET') || 'production';
if (!['production', 'sandbox'].includes(smokeTarget)) {
  throw new Error('ASF_SMOKE_TARGET must be production or sandbox.');
}
const isSandboxSmoke = smokeTarget === 'sandbox';
const baseUrl = (envValue(env, 'ASF_WORKER_URL') || envValue(env, 'VITE_API_BASE_URL')).replace(/\/+$/, '');
const frontendOrigin = (envValue(env, 'ASF_FRONTEND_ORIGIN') || envValue(env, 'ASF_FRONTEND_URL')).replace(/\/+$/, '');
const clerkJwt = envValue(env, 'ASF_CLERK_JWT');
const cloneClerkJwt = envValue(env, 'ASF_CLERK_JWT_CLONE') || envValue(env, 'ASF_CLERK_JWT_ALT');
const clerkBackendAuthBridgeSecret = envValue(env, 'CLERK_BACKEND_AUTH_BRIDGE_SECRET');
const runRateLimitSmoke = envValue(env, 'ASF_SMOKE_RATE_LIMIT') === '1';
const requireAuthenticatedSmoke =
  envValue(env, 'ASF_SMOKE_REQUIRE_AUTH') === '1' || process.argv.includes('--require-auth');
const requireCloneSmoke =
  envValue(env, 'ASF_SMOKE_REQUIRE_CLONE') === '1' || process.argv.includes('--require-clone');
const preserveSmokeUserState = envValue(env, 'ASF_SMOKE_PRESERVE_USER_STATE') === '1';
const FETCH_TIMEOUT_MS = Number(envValue(env, 'ASF_LIVE_SMOKE_TIMEOUT_MS') || 45_000);
const SAFE_FETCH_MAX_ATTEMPTS = Number(envValue(env, 'ASF_LIVE_SMOKE_SAFE_FETCH_ATTEMPTS') || 3);
const SAFE_FETCH_RETRY_DELAY_MS = Number(envValue(env, 'ASF_LIVE_SMOKE_SAFE_FETCH_RETRY_DELAY_MS') || 250);
const WORKER_READY_TIMEOUT_MS = Number(envValue(env, 'ASF_WORKER_READY_TIMEOUT_MS') || 90_000);
const WORKER_RETRY_DELAY_MS = Number(envValue(env, 'ASF_WORKER_RETRY_DELAY_MS') || 2_500);
const workerVersionOverride = envValue(env, 'ASF_WORKER_VERSION_OVERRIDE');
const workerVersionOverrideName = envValue(env, 'ASF_WORKER_VERSION_OVERRIDE_NAME') || 'ai-street-fighter-api';
const workerVersionOverrideTag = envValue(env, 'ASF_WORKER_VERSION_OVERRIDE_TAG');
const expectedWorkerVersionId = workerVersionOverride || envValue(env, 'ASF_EXPECTED_WORKER_VERSION_ID');
const expectedWorkerVersionTag = workerVersionOverrideTag || envValue(env, 'ASF_EXPECTED_WORKER_VERSION_TAG');
if (workerVersionOverride && !/^[0-9a-f-]{36}$/i.test(workerVersionOverride)) {
  throw new Error('ASF_WORKER_VERSION_OVERRIDE must be a Worker version UUID.');
}
if (!/^[a-z0-9_-]{1,63}$/i.test(workerVersionOverrideName)) {
  throw new Error('ASF_WORKER_VERSION_OVERRIDE_NAME is invalid.');
}
if (expectedWorkerVersionId && !/^[0-9a-f-]{36}$/i.test(expectedWorkerVersionId)) {
  throw new Error('Expected Worker version must be a UUID.');
}
if (expectedWorkerVersionId && !expectedWorkerVersionTag) {
  throw new Error('Expected Worker version tag is required with a version id.');
}

const tinyPngBase64 =
  envValue(env, 'ASF_TEST_IMAGE_BASE64') ||
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const requiredPlayableAnimations = [
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
];
const generationLegal = {
  legalVersion: '2026-08-23.1',
  ageConfirmed: true,
  termsAccepted: true,
  photoRightsConfirmed: true,
  aiProcessingConfirmed: true,
  immediatePerformanceConfirmed: true,
  withdrawalLossAcknowledged: true,
};

const failures = [];
let smokeFighterId = null;
let cloneFighterId = null;

function fail(message) {
  failures.push(message);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function decodeJwtPayload(token, label) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error(`${label} must be a JWT-like Clerk session token.`);
  }
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error(`${label} payload could not be decoded.`);
  }
}

function jwtSubject(token, label) {
  const payload = decodeJwtPayload(token, label);
  const sub = typeof payload?.sub === 'string' ? payload.sub.trim() : '';
  if (!sub) {
    throw new Error(`${label} must include a Clerk subject claim.`);
  }
  return sub;
}

function assertDistinctCloneSmokeUser() {
  if (!cloneClerkJwt) return;
  if (!clerkJwt) {
    throw new Error('ASF_CLERK_JWT must be set when ASF_CLERK_JWT_CLONE is set.');
  }
  if (clerkJwt === cloneClerkJwt) {
    throw new Error('ASF_CLERK_JWT_CLONE must come from a second Clerk user, not the primary smoke user.');
  }
  if (jwtSubject(clerkJwt, 'ASF_CLERK_JWT') === jwtSubject(cloneClerkJwt, 'ASF_CLERK_JWT_CLONE')) {
    throw new Error('ASF_CLERK_JWT_CLONE must use a different Clerk user subject than ASF_CLERK_JWT.');
  }
  log('launch smoke tokens identify two different Clerk users');
}

function assertPublicDisplayName(value, label) {
  assert(typeof value === 'string' && value.trim(), `${label} name is missing`);
  assert(value === value.trim(), `${label} name was not trimmed`);
  assert(!/[\u0000-\u001f\u007f]/.test(value), `${label} name retained control characters`);
  assert(!/\s{2,}/.test(value), `${label} name retained repeated whitespace`);
  assert(Array.from(value).length <= 48, `${label} name exceeded the public metadata cap`);
}

function assertOptionalHttpsUrl(value, label) {
  if (value == null) return;
  assert(typeof value === 'string', `${label} avatar must be a string or null`);
  assert(value.length <= 2048, `${label} avatar URL exceeded the public metadata cap`);
  assert(/^https:\/\//i.test(value), `${label} avatar was not HTTPS`);
}

function assertCommunityOwner(owner, label) {
  assert(owner && typeof owner === 'object', `${label} owner is missing`);
  assert(owner.name === 'Player', `${label} exposed an account display name`);
  assert(!Object.hasOwn(owner, 'avatarUrl'), `${label} exposed the Clerk profile photo`);
}

function assertOpaqueCommunityAssets(fighter, label, options = {}) {
  // Official Arcade fighters are operator-owned parody assets: their RAW
  // sheets may be published for the high-density gallery preview, but only
  // through the opaque revisioned arcade route. User/community fighters must
  // never expose RAW anything.
  const allowArcadeRawSprites = options.allowArcadeRawSprites ?? false;
  const urls = [
    fighter?.sources?.side,
    fighter?.sources?.upright,
    fighter?.sources?.crouch,
    ...(fighter?.sprites ?? []).map((sprite) => sprite?.url),
  ].filter(Boolean);
  assert(fighter?.sources?.original === null, `${label} exposed the original upload`);
  assert(
    [fighter?.sources?.sideRaw, fighter?.sources?.uprightRaw, fighter?.sources?.crouchRaw]
      .every((value) => value === null),
    `${label} exposed a RAW source view`,
  );
  if (allowArcadeRawSprites) {
    for (const sprite of fighter?.sprites ?? []) {
      if (sprite?.rawUrl === null || sprite?.rawUrl === undefined) continue;
      const rawPath = new URL(sprite.rawUrl).pathname;
      assert(
        rawPath.startsWith(`/public-assets/arcade/${encodeURIComponent(fighter.id)}/sprites/`) &&
          rawPath.includes('/raw/'),
        `${label} RAW sprite URL is not the opaque arcade raw route`,
      );
      assert(!rawPath.includes('/users/'), `${label} RAW sprite URL exposed an owner-scoped R2 path`);
      assert(!/user_[A-Za-z0-9]+/.test(rawPath), `${label} RAW sprite URL exposed a Clerk user id`);
    }
  } else {
    assert(
      (fighter?.sprites ?? []).every((sprite) => sprite?.rawUrl === null),
      `${label} exposed a RAW sprite URL`,
    );
  }
  for (const assetUrl of urls) {
    const parsed = new URL(assetUrl);
    assert(
      parsed.pathname.startsWith(`/public-assets/fighters/${encodeURIComponent(fighter.id)}/`),
      `${label} did not use an opaque public fighter asset route`,
    );
    assert(!parsed.pathname.includes('/users/'), `${label} exposed an owner-scoped R2 path`);
    assert(!/user_[A-Za-z0-9]+/.test(parsed.pathname), `${label} exposed a Clerk user id in an asset URL`);
  }
}

function assertLeaderboardProfile(entry, label) {
  const rank = Number(String(entry.id ?? '').replace(/^rank:/, ''));
  assert(Number.isSafeInteger(rank) && rank > 0, `${label} returned an invalid rank alias`);
  assert(entry.id === `rank:${rank}`, `${label} exposed a stable account identifier`);
  assert(entry.display_name === `Player ${rank}`, `${label} exposed an account display name`);
  assert(entry.avatar_url === null, `${label} exposed an account avatar`);
}

function assertSharePageSecurityHeaders(res, label) {
  const csp = res.headers.get('Content-Security-Policy') ?? '';
  assert(res.headers.get('X-Content-Type-Options') === 'nosniff', `${label} did not set nosniff`);
  assert(
    res.headers.get('Referrer-Policy') === 'strict-origin-when-cross-origin',
    `${label} did not set a strict referrer policy`,
  );
  assert(res.headers.get('X-Frame-Options') === 'DENY', `${label} did not deny framing`);
  assert(
    res.headers.get('Permissions-Policy') === 'camera=(), microphone=(), geolocation=()',
    `${label} did not set the expected permissions policy`,
  );
  assert(
    csp.includes("frame-ancestors 'none'"),
    `${label} did not set a share-page CSP`,
  );
  assert(!csp.includes("'unsafe-inline'"), `${label} CSP allows unsafe inline script`);
}

function log(message) {
  console.log(`✓ ${message}`);
}

function url(pathOrUrl) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${baseUrl}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`;
}

function authHeadersFor(token, extra = {}) {
  if (!token) return extra;
  return {
    ...extra,
    Authorization: `Bearer ${token}`,
    ...(clerkBackendAuthBridgeSecret
      ? { 'X-Insert-Player-Clerk-Backend-Auth': clerkBackendAuthBridgeSecret }
      : {}),
  };
}

function authHeaders(extra = {}) {
  return authHeadersFor(clerkJwt, extra);
}

async function request(pathOrUrl, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (frontendOrigin && !headers.has('Origin')) {
    headers.set('Origin', frontendOrigin);
  }
  const target = url(pathOrUrl);
  if (workerVersionOverride && new URL(target).origin === new URL(baseUrl).origin) {
    headers.set(
      'Cloudflare-Workers-Version-Overrides',
      `${workerVersionOverrideName}="${workerVersionOverride}"`,
    );
  }
  try {
    return await fetchWithTransientNetworkRetry({
      fetchImpl: fetch,
      target,
      init: { ...init, headers },
      timeoutMs: FETCH_TIMEOUT_MS,
      maxAttempts: SAFE_FETCH_MAX_ATTEMPTS,
      baseDelayMs: SAFE_FETCH_RETRY_DELAY_MS,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Request failed for ${target}: ${detail}`);
  }
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Expected JSON from ${res.url}, got: ${text.slice(0, 200)}`);
  }
}

async function expectStatus(label, pathOrUrl, status, init = {}) {
  const res = await request(pathOrUrl, init);
  if (res.status !== status) {
    const body = await res.text();
    throw new Error(`${label} expected ${status}, got ${res.status}: ${body.slice(0, 240)}`);
  }
  return res;
}

async function expectStatusOrAnonymousRateLimit(label, pathOrUrl, status, init = {}) {
  const res = await request(pathOrUrl, init);
  if (res.status === 429) {
    assert(res.headers.has('Retry-After'), `${label} rate limit is missing Retry-After`);
    log(`${label} is behind an active anonymous rate-limit window`);
    return { res, rateLimited: true };
  }
  if (res.status !== status) {
    const body = await res.text();
    throw new Error(`${label} expected ${status} or 429, got ${res.status}: ${body.slice(0, 240)}`);
  }
  return { res, rateLimited: false };
}

async function expectJson(label, pathOrUrl, status = 200, init = {}) {
  const res = await expectStatus(label, pathOrUrl, status, init);
  return readJson(res);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCurrentWorkerHealth() {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started <= WORKER_READY_TIMEOUT_MS) {
    try {
      const health = await expectJson('health', '/health');
      const legalReady = health.legalVersion === generationLegal.legalVersion;
      const versionReady = !expectedWorkerVersionId || (
        health.workerVersion?.id === expectedWorkerVersionId
        && health.workerVersion?.tag === expectedWorkerVersionTag
      );
      if (legalReady && versionReady) return health;
      lastError = new Error([
        `/health reports legal=${String(health.legalVersion ?? 'missing')}`,
        `worker=${String(health.workerVersion?.id ?? 'missing')}`,
        `tag=${String(health.workerVersion?.tag ?? 'missing')}`,
      ].join(', '));
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    const remaining = WORKER_READY_TIMEOUT_MS - (Date.now() - started);
    if (remaining <= 0) break;
    await sleep(Math.min(WORKER_RETRY_DELAY_MS, remaining));
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Current ${smokeTarget} Worker did not become ready: ${detail}`);
}

function imageBlob() {
  const binary = atob(tinyPngBase64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

async function runPublicSmoke() {
  const health = await waitForCurrentWorkerHealth();
  assert(health.status === 'ok', 'Health response did not report ok');
  assert(health.version === '0.19.0', `/health did not report Worker 0.19.0 (got ${String(health.version ?? 'missing')})`);
  if (expectedWorkerVersionId) {
    assert(
      health.workerVersion?.id === expectedWorkerVersionId,
      `/health did not execute the requested Worker candidate (got ${String(health.workerVersion?.id ?? 'missing')})`,
    );
    assert(
      health.workerVersion?.tag === expectedWorkerVersionTag,
      `/health did not report the requested Worker candidate tag (got ${String(health.workerVersion?.tag ?? 'missing')})`,
    );
  }
  assert(health.legalVersion === generationLegal.legalVersion, '/health did not report the current legal version');
  if (isSandboxSmoke) {
    assert(health.environment === 'sandbox', '/health did not report sandbox environment');
  } else {
    assert(health.environment === 'production', '/health did not report production environment');
  }
  assert(health.storage?.d1 === 'bound', '/health did not report D1 binding');
  assert(health.storage?.r2 === 'bound', '/health did not report R2 binding');
  assert(health.providers === 'configured', '/health did not report configured provider secrets');
  assert(
    health.geminiTransport === (isSandboxSmoke ? 'google-direct' : 'meterkey'),
    `/health did not report the expected ${smokeTarget} Gemini transport`,
  );
  assert(health.providerAccounting === 'durable', '/health did not report durable provider cost accounting');
  assert(health.providerSessionLimits === 'configured', '/health did not report per-session provider limits');
  assert(health.providerGlobalCaps === 'disabled', '/health still reports a global provider spend cap');
  assert(health.durableGeneration === 'configured', '/health did not report durable backend generation');
  assert(
    health.turnstile === (isSandboxSmoke ? 'disabled' : 'configured'),
    `/health did not report the expected ${smokeTarget} Turnstile state`,
  );
  if (isSandboxSmoke) {
    assert(health.anonymousRookie === 'disabled', '/health did not report disabled sandbox anonymous Rookie');
  } else {
    assert(health.anonymousRookie === 'enabled', '/health did not report enabled anonymous Rookie launch flow');
  }
  assert(health.privacy === 'pseudonymized', '/health did not report pseudonymized anonymous identifiers');
  const expectedBilling = isSandboxSmoke ? 'stripe_test' : 'stripe';
  if (!isSandboxSmoke) {
    assert(health.billing !== 'stripe_test', '/health reports test Stripe on the production Worker');
  }
  assert(health.billing === expectedBilling, `/health did not report ${expectedBilling} billing`);
  log(`/health reports ${smokeTarget} Worker bindings`);
  if (requireAuthenticatedSmoke || requireCloneSmoke) {
    const launchHealthErrors = [];
    if (health.auth !== 'clerk') {
      launchHealthErrors.push(`Launch smoke requires /health to report Clerk auth; got ${String(health.auth ?? 'missing')}`);
    }
    if (health.accountLifecycle !== 'clerk_webhook') {
      launchHealthErrors.push(`Launch smoke requires /health to report Clerk account lifecycle; got ${String(health.accountLifecycle ?? 'missing')}`);
    }
    if (isSandboxSmoke && health.billing !== 'stripe_test') {
      launchHealthErrors.push(`Launch smoke requires /health to report Stripe test billing; got ${String(health.billing ?? 'missing')}`);
    }
    if (!isSandboxSmoke && health.billing !== 'stripe') {
      launchHealthErrors.push(`Launch smoke requires /health to report live Stripe billing; got ${String(health.billing ?? 'missing')}`);
    }
    assert(launchHealthErrors.length === 0, launchHealthErrors.join('\n'));
    log(`/health reports Clerk auth/lifecycle and ${expectedBilling} billing for launch smoke`);
  } else if (health.auth !== 'clerk' || health.accountLifecycle !== 'clerk_webhook' || health.billing !== expectedBilling) {
    console.warn(
      `Public smoke warning: /health reports auth=${String(health.auth ?? 'missing')} ` +
      `accountLifecycle=${String(health.accountLifecycle ?? 'missing')} ` +
      `billing=${String(health.billing ?? 'missing')}. Use npm run check:launch for launch readiness.`,
    );
  }

  if (frontendOrigin) {
    const preflight = await expectStatus('CORS preflight', '/api/tiers', 204, {
      method: 'OPTIONS',
      headers: {
        Origin: frontendOrigin,
        'Access-Control-Request-Method': 'GET',
      },
    });
    assert(
      preflight.headers.get('Access-Control-Allow-Origin') === frontendOrigin,
      'CORS preflight did not reflect ASF_FRONTEND_ORIGIN',
    );
    log(`CORS preflight reflects the ${smokeTarget} frontend origin`);

    const rejectedOrigin = 'https://evil.example';
    const rejectedPreflight = await expectStatus('rejected CORS preflight', '/api/tiers', 204, {
      method: 'OPTIONS',
      headers: {
        Origin: rejectedOrigin,
        'Access-Control-Request-Method': 'GET',
      },
    });
    assert(
      rejectedPreflight.headers.get('Access-Control-Allow-Origin') !== rejectedOrigin,
      'CORS preflight reflected an unconfigured origin',
    );
    log('CORS preflight does not reflect unconfigured origins');

    const providerPreflight = await expectStatus(
      'provider-session CORS preflight',
      '/proxy/gemini/v1beta/models/gemini-3.1-flash-image:generateContent',
      204,
      {
        method: 'OPTIONS',
        headers: {
          Origin: frontendOrigin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,authorization,x-asf-provider-session',
        },
      },
    );
    assert(
      (providerPreflight.headers.get('Access-Control-Allow-Headers') ?? '')
        .toLowerCase()
        .includes('x-asf-provider-session'),
      'Provider-session CORS preflight did not allow X-ASF-Provider-Session',
    );
    log('provider-session CORS preflight allows browser provider calls');
  }

  const tiers = await expectJson('tiers', '/api/tiers');
  const tierIds = new Set((tiers.tiers ?? []).map((tier) => tier.id));
  for (const id of ['rookie', 'contender', 'champion']) {
    assert(tierIds.has(id), `/api/tiers missing ${id}`);
  }
  log('/api/tiers exposes Rookie, Contender, Champion');

  const arcadeFeed = await expectStatus('official Arcade cache headers', '/api/arcade', 200);
  assert(
    (arcadeFeed.headers.get('Cache-Control') ?? '').includes('s-maxage=300'),
    'Official Arcade feed is missing short shared-cache headers',
  );
  const arcadeBody = await readJson(arcadeFeed);
  assert(Array.isArray(arcadeBody.fighters), 'Official Arcade feed did not return a fighters array');
  let previousRank = 0;
  for (const fighter of arcadeBody.fighters) {
    assert(fighter.qualityTier === 'champion', 'Official Arcade exposed a non-Champion fighter');
    assert(!Object.hasOwn(fighter, 'ownerUserId'), 'Official Arcade exposed ownerUserId');
    assert(!Object.hasOwn(fighter, 'photoHash'), 'Official Arcade exposed photoHash');
    assertCommunityOwner(fighter.owner, 'Official Arcade');
    assertOpaqueCommunityAssets(fighter, 'Official Arcade', { allowArcadeRawSprites: true });
    assert(typeof fighter.arcade?.slug === 'string' && fighter.arcade.slug, 'Official Arcade fighter is missing its slug');
    assert(Number(fighter.arcade?.rank) > previousRank, 'Official Arcade fighters are not in stable rank order');
    assert(typeof fighter.arcade?.challengerLine === 'string', 'Official Arcade fighter is missing its challenger line');
    assert(
      fighter.arcade?.reference?.kind === 'licensed'
        && /^https:\/\//.test(fighter.arcade.reference.sourceUrl ?? '')
        && typeof fighter.arcade.reference.license === 'string'
        && fighter.arcade.reference.license
        && typeof fighter.arcade.reference.credit === 'string'
        && fighter.arcade.reference.credit,
      'Official Arcade fighter is missing public photo attribution',
    );
    previousRank = Number(fighter.arcade.rank);
  }
  log(`/api/arcade safely exposes ${arcadeBody.fighters.length} official Champion fighter${arcadeBody.fighters.length === 1 ? '' : 's'}`);

  const communityFeed = await expectStatus('community feed cache headers', '/api/community?limit=1', 200);
  assert(
    (communityFeed.headers.get('Cache-Control') ?? '').includes('s-maxage=300'),
    'Community feed is missing short shared-cache headers',
  );
  const communityFeedBody = await readJson(communityFeed);
  assert(
    (communityFeedBody.fighters ?? []).every((fighter) => !Object.hasOwn(fighter, 'ownerUserId')),
    'Community feed exposed ownerUserId',
  );
  assert(
    (communityFeedBody.fighters ?? []).every((fighter) => !Object.hasOwn(fighter, 'photoHash')),
    'Community feed exposed photoHash',
  );
  for (const fighter of communityFeedBody.fighters ?? []) {
    assertCommunityOwner(fighter.owner, 'Community feed');
    assertOpaqueCommunityAssets(fighter, 'Community feed');
  }
  log('/api/community is cache-friendly for public feed traffic');

  const firstPublicFighter = (communityFeedBody.fighters ?? [])[0];
  if (firstPublicFighter?.id) {
    const sharePage = await expectStatus('public feed fighter share page', `/share/${firstPublicFighter.id}`, 200);
    assert(
      (sharePage.headers.get('Cache-Control') ?? '').includes('s-maxage=900'),
      'Public feed share page is missing shared-cache headers',
    );
    assertSharePageSecurityHeaders(sharePage, 'Public feed share page');
    const shareHtml = await sharePage.text();
    assert(shareHtml.includes('property="og:image"'), 'Public feed share page missing Open Graph image');
    assert(shareHtml.includes('property="og:image:alt"'), 'Public feed share page missing Open Graph image alt text');
    assert(shareHtml.includes('name="twitter:image:alt"'), 'Public feed share page missing Twitter image alt text');
    assert(shareHtml.includes('rel="canonical"'), 'Public feed share page missing canonical community link');
    assert(/<script nonce="[a-f0-9]{32}">/.test(shareHtml), 'Public feed share page redirect script missing CSP nonce');
    assert(shareHtml.includes(`/community?fighter=${firstPublicFighter.id}`), 'Public feed share page missing community redirect');
    assert(shareHtml.includes('/public-assets/fighters/'), 'Public feed share page did not use an opaque media URL');
    assert(!shareHtml.includes('/users/'), 'Public feed share page exposed an owner-scoped R2 path');
    assert(!/user_[A-Za-z0-9]+/.test(shareHtml), 'Public feed share page exposed a Clerk user id');
    log('public feed share page exposes crawler-ready fighter metadata');
  }

  await expectStatus('community feed invalid limit fallback', '/api/community?limit=banana', 200);
  log('/api/community tolerates invalid limit parameters');
  await expectStatus('community malformed path parameter', '/api/community/%E0%A4%A', 400);
  log('malformed public route parameters return 400');
  await expectStatus('malformed temp asset path parameter', '/temp-assets/%E0%A4%A', 400);
  log('malformed temp asset paths return 400');

  const leaderboard = await expectJson('leaderboard', '/api/leaderboard');
  assert(Array.isArray(leaderboard.leaderboard), '/api/leaderboard did not return a leaderboard array');
  assert(
    (leaderboard.leaderboard ?? []).every((entry) => !/^user_/i.test(String(entry.id ?? ''))),
    '/api/leaderboard exposed raw Clerk user ids',
  );
  for (const [index, entry] of (leaderboard.leaderboard ?? []).entries()) {
    assert(entry.id === `rank:${index + 1}`, 'Leaderboard rank aliases are out of order');
    assertLeaderboardProfile(entry, 'Leaderboard');
  }
  log('/api/leaderboard exposes public fight board with rank-only aliases');

  const packs = await expectJson('billing packs', '/api/billing/packs');
  const packIds = new Set((packs.packs ?? []).map((pack) => pack.id));
  for (const id of ['starter', 'versus', 'arcade']) {
    assert(packIds.has(id), `/api/billing/packs missing ${id}`);
  }
  log('/api/billing/packs exposes credit packs');

  await expectStatus('signed-out fighters', '/api/fighters', 401);
  log('signed-out /api/fighters is protected');
  await expectStatus('signed-out player stats detail', '/api/stats/user_smoke', 401);
  log('signed-out /api/stats/:userId is protected');
  await expectStatus('signed-out checkout', '/api/billing/checkout', 401, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packId: 'starter' }),
  });
  log('signed-out /api/billing/checkout is protected');
  await expectStatus('signed-out community report', '/api/community/not-a-real-fighter/report', 401, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'other' }),
  });
  log('signed-out community reporting is protected');
  await expectStatus('signed-out moderation queue', '/api/admin/community-reports', 401);
  log('signed-out moderation queue is protected');
  const invalidBearerGenerationRes = await request('/api/billing/generation', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer not-a-real-clerk-token',
    },
    body: JSON.stringify({ tier: 'rookie', reason: 'live_smoke_invalid_bearer' }),
  });
  const invalidBearerGeneration = await readJson(invalidBearerGenerationRes);
  assert(
    invalidBearerGenerationRes.status === 401 || invalidBearerGenerationRes.status === 503,
    `invalid bearer generation auth expected 401/503, got ${invalidBearerGenerationRes.status}`,
  );
  assert(!invalidBearerGeneration.authorized, 'Invalid bearer generation auth should not fall back to anonymous Rookie');
  assert(!invalidBearerGeneration.providerSessionId, 'Invalid bearer generation auth should not mint a provider session');
  log('invalid bearer generation auth is not downgraded to anonymous');

  const paidAuthRes = await request('/api/billing/generation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: 'contender', reason: 'live_smoke_signed_out', legal: generationLegal }),
  });
  const paidAuth = await readJson(paidAuthRes);
  if (paidAuthRes.status === 429) {
    assert(paidAuthRes.headers.has('Retry-After'), 'Signed-out paid generation rate limit is missing Retry-After');
    log('signed-out paid generation is rate-limited');
  } else {
    assert(paidAuthRes.status === 401, `signed-out paid generation expected 401 or 429, got ${paidAuthRes.status}`);
    assert(!paidAuth.authorized, 'Signed-out paid generation should not be authorized');
    log('signed-out paid generation is blocked');
  }

  const rookieAuthRes = await request('/api/billing/generation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: 'rookie', reason: 'live_smoke_signed_out', legal: generationLegal }),
  });
  const rookieAuth = await readJson(rookieAuthRes);
  if (rookieAuthRes.status === 429) {
    assert(rookieAuthRes.headers.has('Retry-After'), 'Signed-out Rookie generation rate limit is missing Retry-After');
    log('signed-out Rookie generation authorization is rate-limited');
  } else if (isSandboxSmoke) {
    assert(rookieAuthRes.status === 403, `signed-out sandbox Rookie expected 403 or 429, got ${rookieAuthRes.status}`);
    assert(!rookieAuth.authorized, 'Signed-out sandbox Rookie should not be authorized');
    assert(!rookieAuth.providerSessionId, 'Signed-out sandbox Rookie minted a provider session');
    assert(rookieAuth.code === 'anonymous_rookie_disabled', 'Sandbox did not report disabled anonymous Rookie');
    log('sandbox keeps anonymous Rookie generation disabled');
  } else {
    assert(rookieAuthRes.status === 403, `signed-out Rookie without Turnstile expected 403 or 429, got ${rookieAuthRes.status}`);
    assert(!rookieAuth.authorized, 'Signed-out Rookie without Turnstile should not be authorized');
    assert(!rookieAuth.providerSessionId, 'Signed-out Rookie without Turnstile minted a provider session');
    assert(rookieAuth.code === 'turnstile_required', 'Signed-out Rookie did not report the Turnstile requirement');
    log('signed-out Rookie generation requires a server-verified Turnstile token');
  }

  await expectStatus(
    'private-host image proxy block',
    `/proxy/image?url=${encodeURIComponent('http://127.0.0.1/private.png')}`,
    400,
  );
  log('/proxy/image blocks private/local hosts');

  await expectStatus(
    'image proxy session requirement',
    `/proxy/image?url=${encodeURIComponent('https://example.com/fighter.png')}`,
    402,
  );
  log('/proxy/image requires an authorized provider session');

  await expectStatus(
    'private-host media proxy block',
    `/proxy/media?url=${encodeURIComponent('http://127.0.0.1/private.mp4')}`,
    400,
  );
  log('/proxy/media blocks private/local hosts');

  await expectStatus(
    'media proxy session requirement',
    `/proxy/media?url=${encodeURIComponent('https://example.com/fighter.mp4')}`,
    402,
  );
  log('/proxy/media requires an authorized provider session');

  await expectStatus('provider proxy allowlist block', '/proxy/gemini/v1beta/models', 404);
  log('provider proxy blocks non-allowlisted routes');

  await expectStatus('ludo result listing block', '/proxy/ludo/assets/sprites/results', 400);
  log('provider proxy blocks broad result listing');

  await expectStatus(
    'provider session requirement',
    '/proxy/gemini/v1beta/models/gemini-3.1-flash-image:generateContent',
    402,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'blocked before upstream' }] }] }),
    },
  );
  log('provider proxy requires an authorized provider session');

  await expectStatus(
    'provider polling session requirement',
    '/proxy/fal/fal-ai/birefnet/requests/smoke-request/status',
    402,
  );
  log('provider polling requires an authorized provider session');

  await expectStatus('temp upload session requirement', '/proxy/upload-temp', 402, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: tinyPngBase64 }),
  });
  log('/proxy/upload-temp requires an authorized provider session before R2 writes');

  const missingShare = await expectStatus('missing community share page', '/share/not-a-real-fighter', 404);
  const missingDetail = await expectStatus('missing community detail', '/api/community/not-a-real-fighter', 404);
  assert(missingShare.headers.get('Cache-Control') === 'no-store', 'Missing share pages should not be cached');
  assertSharePageSecurityHeaders(missingShare, 'Missing share page');
  assert(missingDetail.headers.get('Cache-Control') === 'no-store', 'Missing community details should not be cached');
  log('missing community share/detail pages return 404');

  await assertOptionalAnonymousRateLimit();
}

async function uploadSource(fighterId) {
  const form = new FormData();
  form.append('kind', 'original');
  form.append('file', imageBlob(), 'smoke-original.png');
  return expectJson('source upload', `/api/fighters/${fighterId}/sources`, 200, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
}

async function uploadSprite(fighterId, animationName = 'idle') {
  const form = new FormData();
  form.append('animationName', animationName);
  form.append('qualityTier', 'rookie');
  form.append('frameWidth', '1');
  form.append('frameHeight', '1');
  form.append('frameCount', '1');
  form.append('processingVersion', '4');
  form.append('file', imageBlob(), `${animationName}.png`);
  return expectJson(`sprite upload ${animationName}`, `/api/fighters/${fighterId}/sprites`, 200, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
}

async function uploadRemainingPlayableSprites(fighterId) {
  for (const animationName of requiredPlayableAnimations.filter((name) => name !== 'idle')) {
    await uploadSprite(fighterId, animationName);
  }
}

async function authorizeGeneration(tier, reason, fighterId = null) {
  const res = await request('/api/billing/generation', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ tier, reason, fighterId, legal: generationLegal }),
  });
  const json = await readJson(res);
  return { res, json };
}

async function completeGenerationPurchase(purchaseId, success, fighterId = null) {
  return expectJson('generation purchase completion', '/api/billing/generation/complete', 200, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ purchaseId, success, fighterId }),
  });
}

async function assertAuthenticatedGenerationBilling(fighterId) {
  const rookie = await authorizeGeneration('rookie', 'live_smoke_rookie_release', fighterId);
  if (rookie.res.status === 402) {
    console.log('Skipping Rookie reservation-release smoke: signed-in smoke account has no free quota or credits.');
  } else {
    assert(rookie.res.status === 200, `Rookie generation auth expected 200 or 402, got ${rookie.res.status}`);
    assert(rookie.json.authorized === true, 'Signed-in Rookie generation was not authorized');
    assert(rookie.json.purchaseId, 'Signed-in Rookie generation did not return a purchaseId');
    assert(rookie.json.providerSessionId, 'Signed-in Rookie generation did not return a providerSessionId');
    assert(Number(rookie.json.providerCallLimit) === 48, 'Signed-in Rookie generation did not expose the Rookie provider call limit');
    const released = await completeGenerationPurchase(rookie.json.purchaseId, false, fighterId);
    assert(released.status === 'released', 'Unused Rookie reservation was not released');
    const releasedAgain = await completeGenerationPurchase(rookie.json.purchaseId, false, fighterId);
    assert(releasedAgain.status === 'released', 'Duplicate Rookie reservation release was not idempotent');
    log('authenticated Rookie generation releases an unused reservation idempotently');
  }

  const contender = await authorizeGeneration('contender', 'live_smoke_contender_release', fighterId);
  if (contender.res.status === 402) {
    assert(contender.json.authorized === false, 'Contender insufficient-credit response should not be authorized');
    assert(Number(contender.json.requiredCredits ?? 0) > 0, 'Contender insufficient-credit response missing requiredCredits');
    log('authenticated paid-tier generation enforces credits');
    return;
  }

  assert(contender.res.status === 200, `Contender generation auth expected 200 or 402, got ${contender.res.status}`);
  assert(contender.json.authorized === true, 'Signed-in Contender generation was not authorized');
  assert(contender.json.purchaseId, 'Signed-in Contender generation did not return a purchaseId');
  assert(contender.json.providerSessionId, 'Signed-in Contender generation did not return a providerSessionId');
  assert(Number(contender.json.providerCallLimit) === 280, 'Signed-in Contender generation did not expose the Contender provider call limit');
  const released = await completeGenerationPurchase(contender.json.purchaseId, false, fighterId);
  assert(released.status === 'released', 'Unused Contender reservation was not released');
  log('authenticated paid-tier generation releases an unused reservation');
}

function spriteUrlFromFighterPayload(payload) {
  return payload?.fighter?.sprites?.find?.(
    (sprite) => sprite.animationName === 'idle' && sprite.qualityTier === 'rookie',
  )?.url ?? null;
}

function originalSourceUrlFromFighterPayload(payload) {
  return payload?.fighter?.sources?.original ?? null;
}

async function assertOptionalAnonymousRateLimit() {
  if (!runRateLimitSmoke) {
    console.log('Skipping rate-limit smoke: set ASF_SMOKE_RATE_LIMIT=1 to intentionally exhaust the anonymous proxy window.');
    return;
  }

  const blockedUrl = encodeURIComponent('http://127.0.0.1/rate-limit-smoke.png');
  const maxAttempts = Number(process.env.ASF_SMOKE_RATE_LIMIT_ATTEMPTS ?? 90);
  for (let i = 0; i < maxAttempts; i++) {
    const res = await request(`/proxy/image?url=${blockedUrl}&rateLimitSmoke=${Date.now()}-${i}`);
    if (res.status === 429) {
      assert(res.headers.has('Retry-After'), 'Rate-limit response is missing Retry-After');
      log('anonymous proxy rate limit returns 429 with Retry-After');
      return;
    }
    if (res.status !== 400) {
      const body = await res.text();
      throw new Error(`Rate-limit smoke expected 400 or 429, got ${res.status}: ${body.slice(0, 180)}`);
    }
  }
  throw new Error(`Anonymous proxy rate limit did not return 429 after ${maxAttempts} no-cost blocked proxy calls`);
}

async function cleanupSmokeFighter() {
  if (cloneFighterId && cloneClerkJwt) {
    const cloneRes = await request(`/api/fighters/${cloneFighterId}`, {
      method: 'DELETE',
      headers: authHeadersFor(cloneClerkJwt),
    });
    if (!cloneRes.ok && cloneRes.status !== 404) {
      console.warn(`Cleanup failed for clone ${cloneFighterId}: ${cloneRes.status} ${await cloneRes.text()}`);
    } else {
      log('clone smoke fighter cleanup completed');
    }
  }
  if (!smokeFighterId || !clerkJwt) return;
  const res = await request(`/api/fighters/${smokeFighterId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok && res.status !== 404) {
    console.warn(`Cleanup failed for ${smokeFighterId}: ${res.status} ${await res.text()}`);
    return;
  }
  log('smoke fighter cleanup completed');
}

async function runAuthenticatedSmoke() {
  if (!clerkJwt) {
    if (requireAuthenticatedSmoke || requireCloneSmoke) {
      throw new Error('ASF_CLERK_JWT is required for launch smoke. Pass a short-lived signed-in Clerk token.');
    }
    console.log('Skipping authenticated D1/R2 smoke: ASF_CLERK_JWT is not set.');
    return;
  }

  const me = await expectJson('auth profile', '/auth/me', 200, {
    headers: authHeaders(),
  });
  assert(me.user?.id, '/auth/me did not return a signed-in user');
  log('/auth/me returns the Clerk-backed user profile');

  await expectJson('list fighters', '/api/fighters', 200, {
    headers: authHeaders(),
  });
  log('authenticated /api/fighters list works');

  const photoHash = `live-smoke-${Date.now()}`;
  const requestedFighterName = `Live Smoke Fighter\n${'X'.repeat(80)}`;
  const created = await expectJson('create fighter', '/api/fighters', 200, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      name: requestedFighterName,
      photoHash,
      qualityTier: 'rookie',
      public: false,
    }),
  });
  smokeFighterId = created.fighter?.id;
  assert(smokeFighterId, 'Create fighter did not return an id');
  assert(!String(created.fighter?.name ?? '').includes('\n'), 'Created fighter name retained control characters');
  assert(String(created.fighter?.name ?? '').length <= 48, 'Created fighter name exceeded the public metadata cap');
  log('authenticated fighter create writes D1');

  if (preserveSmokeUserState) {
    console.log('Skipping generation reservation mutations for persistent production QA users.');
  } else {
    await assertAuthenticatedGenerationBilling(smokeFighterId);
  }

  const firstSourceUpload = await uploadSource(smokeFighterId);
  const firstOriginalUrl = originalSourceUrlFromFighterPayload(firstSourceUpload);
  const secondSourceUpload = await uploadSource(smokeFighterId);
  const secondOriginalUrl = originalSourceUrlFromFighterPayload(secondSourceUpload);
  assert(firstOriginalUrl && secondOriginalUrl, 'Source upload did not return original source URLs');
  assert(firstOriginalUrl === secondOriginalUrl, 'Duplicate source upload did not reuse the archived content-addressed asset');
  const firstSpriteUpload = await uploadSprite(smokeFighterId);
  const firstSpriteUrl = spriteUrlFromFighterPayload(firstSpriteUpload);
  const secondSpriteUpload = await uploadSprite(smokeFighterId);
  const secondSpriteUrl = spriteUrlFromFighterPayload(secondSpriteUpload);
  assert(firstSpriteUrl && secondSpriteUrl, 'Sprite upload did not return playable sprite URLs');
  assert(firstSpriteUrl === secondSpriteUrl, 'Duplicate sprite upload did not reuse the archived content-addressed asset');
  log('idempotent source and sprite uploads write R2/D1');

  const partialPublishRes = await request(`/api/fighters/${smokeFighterId}`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ public: true }),
  });
  assert(partialPublishRes.status === 409, `partial fighter publish should be blocked, got ${partialPublishRes.status}`);
  const partialPublish = await readJson(partialPublishRes);
  assert(
    Array.isArray(partialPublish.missingAnimations) && partialPublish.missingAnimations.includes('walk'),
    'Partial publish response did not list missing launch animations',
  );
  log('community publishing requires the full launch animation set');

  await uploadRemainingPlayableSprites(smokeFighterId);

  const owned = await expectJson('get fighter', `/api/fighters/${smokeFighterId}`, 200, {
    headers: authHeaders(),
  });
  const originalUrl = owned.fighter?.sources?.original;
  const spriteUrl = owned.fighter?.sprites?.[0]?.url;
  assert(originalUrl, 'Owned fighter did not include original source URL');
  assert(spriteUrl, 'Owned fighter did not include sprite URL');
  const ownedAnimationNames = new Set((owned.fighter?.sprites ?? []).map((sprite) => sprite.animationName));
  for (const animationName of requiredPlayableAnimations) {
    assert(ownedAnimationNames.has(animationName), `Owned fighter is missing launch animation ${animationName}`);
  }
  assert(Array.isArray(owned.fighter?.spriteVersions), 'Owned fighter detail did not include spriteVersions');
  assert(owned.fighter.spriteVersions.length >= requiredPlayableAnimations.length, 'Owned fighter detail did not include archived sprite versions');

  const ownedListAfterUpload = await expectJson('list fighters after upload', '/api/fighters', 200, {
    headers: authHeaders(),
  });
  const ownedListFighter = (ownedListAfterUpload.fighters ?? []).find((fighter) => fighter.id === smokeFighterId);
  assert(ownedListFighter, 'Owned fighter list did not include the smoke fighter');
  assert(!Object.hasOwn(ownedListFighter, 'spriteVersions'), 'Owned fighter list should not include bulky spriteVersions');

  const ownedPrivateAsset = await expectStatus('owned private asset with auth', originalUrl, 200, {
    headers: authHeaders(),
  });
  assert(ownedPrivateAsset.headers.get('X-Content-Type-Options') === 'nosniff', 'Private asset did not set nosniff');
  assert(ownedPrivateAsset.headers.get('Cache-Control') === 'private, no-store', 'Private original/raw asset was not no-store');
  await expectStatus('private original without auth', originalUrl, 404);
  log('private asset access is owner-gated');

  await expectJson('publish fighter', `/api/fighters/${smokeFighterId}`, 200, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ public: true }),
  });
  const community = await expectJson('community list', '/api/community?limit=96');
  const published = (community.fighters ?? []).find((fighter) => fighter.id === smokeFighterId);
  assert(published, 'Published smoke fighter did not appear in community list');
  const detail = await expectJson('community fighter detail', `/api/community/${smokeFighterId}`);
  assert(detail.fighter?.id === smokeFighterId, 'Community detail did not return the published fighter');
  assert((published.sprites ?? []).length >= requiredPlayableAnimations.length, 'Community listing did not include the full launch animation set');
  assert((detail.fighter?.sprites ?? []).length >= requiredPlayableAnimations.length, 'Community detail did not include the full launch animation set');
  assert(!Object.hasOwn(published, 'ownerUserId'), 'Community listing exposed ownerUserId');
  assert(!Object.hasOwn(detail.fighter, 'ownerUserId'), 'Community detail exposed ownerUserId');
  assert(!Object.hasOwn(published, 'photoHash'), 'Community listing exposed photoHash');
  assert(!Object.hasOwn(detail.fighter, 'photoHash'), 'Community detail exposed photoHash');
  assertCommunityOwner(published.owner, 'Community listing');
  assertCommunityOwner(detail.fighter.owner, 'Community detail');
  assertOpaqueCommunityAssets(published, 'Community listing');
  assertOpaqueCommunityAssets(detail.fighter, 'Community detail');
  const detailHeaders = await expectStatus('community fighter detail cache headers', `/api/community/${smokeFighterId}`, 200);
  assert(
    (detailHeaders.headers.get('Cache-Control') ?? '').includes('s-maxage=300'),
    'Community detail is missing short shared-cache headers',
  );
  assert(published.sprites?.[0]?.url, 'Community listing did not expose playable sprite URL');
  const publishedPublicAssetUrl = published.sprites[0].url;
  const publicSprite = await expectStatus('public sprite without auth', published.sprites[0].url, 200);
  assert(publicSprite.headers.get('X-Content-Type-Options') === 'nosniff', 'Public sprite did not set nosniff');
  assert(
    publicSprite.headers.get('Cache-Control') === 'public, max-age=60, s-maxage=300, must-revalidate',
    'Public sprite did not use the short revocable public cache policy',
  );
  const sharePage = await expectStatus('published fighter share page', `/share/${smokeFighterId}`, 200);
  assert(
    (sharePage.headers.get('Cache-Control') ?? '').includes('s-maxage=900'),
    'Share page is missing shared-cache headers',
  );
  assertSharePageSecurityHeaders(sharePage, 'Share page');
  const shareHtml = await sharePage.text();
  assert(shareHtml.includes('property="og:image"'), 'Share page missing Open Graph image');
  assert(shareHtml.includes('property="og:image:alt"'), 'Share page missing Open Graph image alt text');
  assert(shareHtml.includes('name="twitter:image:alt"'), 'Share page missing Twitter image alt text');
  assert(shareHtml.includes('rel="canonical"'), 'Share page missing canonical community link');
  assert(/<script nonce="[a-f0-9]{32}">/.test(shareHtml), 'Share page redirect script missing CSP nonce');
  assert(shareHtml.includes(`/community?fighter=${smokeFighterId}`), 'Share page missing community redirect');
  assert(shareHtml.includes('/public-assets/fighters/'), 'Share page did not use an opaque public fighter asset preview');
  assert(!shareHtml.includes('/users/'), 'Share page exposed an owner-scoped R2 path');
  assert(!/user_[A-Za-z0-9]+/.test(shareHtml), 'Share page exposed a Clerk user id');
  log('community publishing exposes playable assets without exposing originals/raws');

  if (cloneClerkJwt) {
    const cloneSeed = await expectJson('create same-photo clone target', '/api/fighters', 200, {
      method: 'POST',
      headers: authHeadersFor(cloneClerkJwt, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        name: 'Live Smoke Clone Shell',
        photoHash,
        qualityTier: 'rookie',
        public: false,
      }),
    });
    const cloneSeedId = cloneSeed.fighter?.id ?? null;
    assert(cloneSeedId, 'Same-photo clone target did not return a fighter id');
    assert((cloneSeed.fighter?.sprites ?? []).length === 0, 'Same-photo clone target should start without playable sprites');
    cloneFighterId = cloneSeedId;

    const cloneRes = await request(`/api/community/${smokeFighterId}/clone`, {
      method: 'POST',
      headers: authHeadersFor(cloneClerkJwt),
    });
    assert(cloneRes.status === 200 || cloneRes.status === 201, `community clone expected 200/201, got ${cloneRes.status}`);
    const clone = await readJson(cloneRes);
    cloneFighterId = clone.fighter?.id ?? null;
    assert(cloneFighterId, 'Community clone did not return a fighter id');
    assert(cloneFighterId === cloneSeedId, 'Community clone did not merge into the existing same-photo fighter');
    assert(clone.cloned === false, 'Same-photo community clone merge should return cloned=false');
    assert(clone.fighter?.sources?.original === null, 'Community clone exposed original upload');
    assert(clone.fighter?.sources?.sideRaw === null, 'Community clone exposed raw side source');
    assert(clone.fighter?.sources?.uprightRaw === null, 'Community clone exposed raw upright source');
    assert(clone.fighter?.sources?.crouchRaw === null, 'Community clone exposed raw crouch source');
    assert(clone.fighter?.sprites?.[0]?.rawUrl === null, 'Community clone exposed raw sprite sheet');
    assert(clone.fighter?.sprites?.[0]?.url, 'Community clone did not include a playable sprite URL');
    await expectStatus('cloned private sprite with clone auth', clone.fighter.sprites[0].url, 200, {
      headers: authHeadersFor(cloneClerkJwt),
    });
    log('same-photo community clone merge copies only public playable assets');

    const foreignBillingRes = await request('/api/billing/generation', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        tier: 'rookie',
        reason: 'live_smoke_foreign_fighter_guard',
        fighterId: cloneFighterId,
        legal: generationLegal,
      }),
    });
    const foreignBilling = await readJson(foreignBillingRes);
    assert(foreignBillingRes.status === 403, `foreign fighter generation auth expected 403, got ${foreignBillingRes.status}`);
    assert(
      /does not belong/i.test(String(foreignBilling.error ?? '')),
      'Foreign fighter generation auth did not reject by ownership',
    );
    log('generation authorization rejects foreign fighter ids before reservation');

    const foreignMatchRes = await request('/api/matches', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        winnerSlot: 'p1',
        roundsP1: 1,
        roundsP2: 0,
        duration: 12,
        p1FighterId: cloneFighterId,
        p2FighterId: smokeFighterId,
        opponentKind: 'cpu',
        isRanked: false,
      }),
    });
    const foreignMatch = await readJson(foreignMatchRes);
    assert(foreignMatchRes.status === 403, `foreign fighter match report expected 403, got ${foreignMatchRes.status}`);
    assert(
      /not owned or an active Arcade fighter/i.test(String(foreignMatch.error ?? '')),
      'Foreign fighter match report did not reject by ownership',
    );
    log('match reporting rejects foreign community fighter ids');
  } else {
    if (requireCloneSmoke) {
      throw new Error('ASF_CLERK_JWT_CLONE is required for launch clone/privacy smoke. Pass a token from a second Clerk user.');
    }
    console.log('Skipping community clone privacy smoke: ASF_CLERK_JWT_CLONE is not set.');
  }

  const statsBeforeMatch = await expectJson('player stats before match', '/api/stats', 200, {
    headers: authHeaders(),
  });
  assert(Array.isArray(statsBeforeMatch.recentMatches), '/api/stats did not include recentMatches');

  const activeArcadeFighterId = arcadeBody.fighters[0]?.id ?? null;
  if (activeArcadeFighterId) {
    const attractReport = await expectJson('Attract Mode match report', '/api/matches', 200, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        winnerSlot: 'p1',
        roundsP1: 2,
        roundsP2: 1,
        duration: 42,
        p1FighterId: activeArcadeFighterId,
        p2FighterId: activeArcadeFighterId,
        opponentKind: 'cpu',
        cpuVsCpu: true,
        isRanked: false,
      }),
    });
    assert(attractReport.recorded === false, 'Attract Mode match report was persisted');
    const statsAfterAttract = await expectJson('player stats after Attract Mode', '/api/stats', 200, {
      headers: authHeaders(),
    });
    assert(
      Number(statsAfterAttract.player?.wins ?? 0) === Number(statsBeforeMatch.player?.wins ?? 0)
        && Number(statsAfterAttract.player?.losses ?? 0) === Number(statsBeforeMatch.player?.losses ?? 0)
        && (statsAfterAttract.recentMatches ?? []).length === (statsBeforeMatch.recentMatches ?? []).length,
      'Attract Mode changed the signed-in player record',
    );
    log('Attract Mode does not persist history or change personal W/L');
  }
  if (preserveSmokeUserState) {
    log('player stats are readable without mutating persistent production QA records');
  } else {
    const winsBeforeMatch = Number(statsBeforeMatch.player?.wins ?? 0);
    await expectJson('match report', '/api/matches', 200, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        winnerSlot: 'p1',
        roundsP1: 2,
        roundsP2: 0,
        duration: 42,
        p1FighterId: smokeFighterId,
        p2FighterId: activeArcadeFighterId ?? smokeFighterId,
        opponentKind: 'cpu',
        cpuVsCpu: false,
        isRanked: false,
      }),
    });
    const stats = await expectJson('player stats', '/api/stats', 200, {
      headers: authHeaders(),
    });
    assert(Array.isArray(stats.recentMatches), '/api/stats did not include recentMatches');
    assert(Number(stats.player?.wins ?? 0) >= winsBeforeMatch + 1, 'Unranked match win did not update signed-in record');
    log('match reporting persists unranked match history');
    log('match reporting updates signed-in record');
    if (activeArcadeFighterId) log('match reporting accepts active published Arcade fighter ids');
  }

  await expectJson('unpublish fighter', `/api/fighters/${smokeFighterId}`, 200, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ public: false }),
  });
  const revokedAssetUrl = new URL(publishedPublicAssetUrl);
  revokedAssetUrl.searchParams.set('smoke-revoked', String(Date.now()));
  const revokedAsset = await expectStatus('revoked public sprite', revokedAssetUrl.toString(), 404);
  assert(revokedAsset.headers.get('Cache-Control') === 'no-store', 'Revoked public sprite should not be cached');
  const unpublishedDetail = await expectStatus(
    'unpublished fighter community detail',
    `/api/community/${smokeFighterId}?smoke-revoked=${Date.now()}`,
    404,
  );
  assert(unpublishedDetail.headers.get('Cache-Control') === 'no-store', 'Unpublished community detail should not be cached');
  log('unpublishing revokes opaque public assets and community detail');
}

async function main() {
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    throw new Error('Set ASF_WORKER_URL or VITE_API_BASE_URL to the deployed Worker URL before running live smoke.');
  }

  try {
    assertDistinctCloneSmokeUser();
    await runPublicSmoke();
    await runAuthenticatedSmoke();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    await cleanupSmokeFighter();
  }

  if (failures.length > 0) {
    throw new Error(`Live smoke failed:\n- ${failures.join('\n- ')}`);
  }
  console.log('Live smoke checks passed.');
}

await main();
