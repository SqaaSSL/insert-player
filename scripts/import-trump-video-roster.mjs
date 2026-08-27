import {
  chmodSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateBundleDirectory,
  validateRawSpriteBytes,
  validateSourceBytes,
  validateSpriteBytes,
} from './trump-video-roster-production-contract.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PRODUCTION_API_ORIGIN = 'https://api.insertplayer.ai';
const PRODUCTION_CONFIRMATION = 'ACTIVATE_TRUMP_VIDEO_ROSTER_PRODUCTION';
const REQUEST_TIMEOUT_MS = 120_000;
const CLERK_TOKEN_REFRESH_SKEW_MS = 30_000;
const CLERK_TOKEN_TTL_SECONDS = 10 * 60;
const BRIDGE_HEADER = 'X-Insert-Player-Clerk-Backend-Auth';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function findArg(rawArgs, name) {
  const prefix = `--${name}=`;
  return rawArgs.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? '';
}

function normalizedOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('The Arcade admin credential is not a Clerk JWT.');
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('The Arcade admin Clerk JWT payload could not be decoded.');
  }
}

function jwtExpiresAt(token) {
  return Number(decodeJwtPayload(token).exp ?? 0) * 1000;
}

function clerkErrorDetail(body, fallback) {
  const detail = body?.errors?.[0]?.long_message ?? body?.errors?.[0]?.message;
  return typeof detail === 'string' && detail.trim() ? detail.trim() : fallback;
}

async function clerkRequest(secretKey, path, init = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Clerk ${init.method ?? 'GET'} ${path} returned non-JSON (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(clerkErrorDetail(
      body,
      `Clerk ${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}.`,
    ));
  }
  return body;
}

export async function createClerkAdminTokenProvider(secretKey, userId, { fetchImpl = fetch } = {}) {
  invariant(/^sk_(?:live|test)_/.test(secretKey), 'ASF_ARCADE_CLERK_SECRET_KEY is not a Clerk secret key.');
  invariant(userId.startsWith('user_'), 'ASF_ARCADE_ADMIN_CLERK_USER_ID is invalid.');
  const params = new URLSearchParams({ user_id: userId, status: 'active', limit: '20' });
  const listed = await clerkRequest(secretKey, `/sessions?${params}`, {}, fetchImpl);
  const sessions = Array.isArray(listed.data) ? listed.data : Array.isArray(listed) ? listed : [];
  const session = sessions.find((entry) => entry?.user_id === userId && entry?.status === 'active');
  invariant(session?.id, 'The Arcade admin has no active Clerk session. Sign in to production and retry.');

  let cachedToken = '';
  let cachedExpiresAt = 0;
  return {
    userId,
    getToken: async () => {
      if (cachedToken && cachedExpiresAt > Date.now() + CLERK_TOKEN_REFRESH_SKEW_MS) return cachedToken;
      const created = await clerkRequest(
        secretKey,
        `/sessions/${encodeURIComponent(session.id)}/tokens`,
        {
          method: 'POST',
          body: JSON.stringify({ expires_in_seconds: CLERK_TOKEN_TTL_SECONDS }),
        },
        fetchImpl,
      );
      invariant(typeof created.jwt === 'string' && created.jwt, 'Clerk did not return an admin session token.');
      const claims = decodeJwtPayload(created.jwt);
      invariant(claims.sub === userId, 'Clerk returned a token for a different Arcade admin.');
      cachedToken = created.jwt;
      cachedExpiresAt = jwtExpiresAt(cachedToken);
      invariant(
        cachedExpiresAt > Date.now() + CLERK_TOKEN_REFRESH_SKEW_MS,
        'Clerk returned an admin token that is already expired.',
      );
      return cachedToken;
    },
  };
}

export function createStaticAdminTokenProvider(token) {
  const claims = decodeJwtPayload(token);
  invariant(typeof claims.sub === 'string' && claims.sub, 'The Arcade admin JWT has no subject.');
  invariant(
    jwtExpiresAt(token) > Date.now() + 5 * 60 * 1000,
    'The Arcade admin JWT is expired or expires in under five minutes.',
  );
  return {
    userId: claims.sub,
    getToken: async () => {
      invariant(
        jwtExpiresAt(token) > Date.now() + CLERK_TOKEN_REFRESH_SKEW_MS,
        'The Arcade admin JWT expired while importing.',
      );
      return token;
    },
  };
}

export async function createAdminTokenProviderFromEnv(env = process.env) {
  const staticToken = (env.ASF_ARCADE_ADMIN_JWT || env.ASF_CLERK_JWT || '').trim();
  if (staticToken) return createStaticAdminTokenProvider(staticToken);
  const secretKey = (env.ASF_ARCADE_CLERK_SECRET_KEY || '').trim();
  const userId = (env.ASF_ARCADE_ADMIN_CLERK_USER_ID || '').trim();
  invariant(secretKey && userId, 'Set ASF_ARCADE_CLERK_SECRET_KEY and ASF_ARCADE_ADMIN_CLERK_USER_ID.');
  return createClerkAdminTokenProvider(secretKey, userId);
}

function responseDetail(body, fallback) {
  return typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : fallback;
}

export function createProductionApiClient({
  baseUrl,
  tokenProvider,
  backendAuthBridgeSecret,
  cloudflareApiToken,
  cloudflareZoneId,
  fetchImpl = fetch,
}) {
  const origin = normalizedOrigin(baseUrl);
  invariant(origin === PRODUCTION_API_ORIGIN, `Production import is pinned to ${PRODUCTION_API_ORIGIN}.`);
  invariant(
    typeof backendAuthBridgeSecret === 'string' && backendAuthBridgeSecret.length >= 32,
    'CLERK_BACKEND_AUTH_BRIDGE_SECRET must contain at least 32 characters.',
  );
  invariant(
    typeof cloudflareApiToken === 'string' && cloudflareApiToken.length >= 20,
    'CLOUDFLARE_API_TOKEN is required for the exact Arcade cache purge.',
  );
  invariant(/^[a-f0-9]{32}$/i.test(cloudflareZoneId), 'ASF_CLOUDFLARE_ZONE_ID must be a 32-character zone ID.');

  async function request(path, {
    method = 'GET',
    json,
    form,
    authenticated = true,
    expectedBinary = false,
  } = {}) {
    const headers = { Accept: expectedBinary ? 'image/png' : 'application/json' };
    if (authenticated) {
      headers.Authorization = `Bearer ${await tokenProvider.getToken()}`;
      headers[BRIDGE_HEADER] = backendAuthBridgeSecret;
    }
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    const url = path.startsWith('https://') ? path : `${origin}${path}`;
    const parsed = new URL(url);
    invariant(parsed.origin === origin, `Refusing to request an asset outside ${origin}.`);
    if (path.startsWith('https://')) {
      invariant(
        parsed.pathname.startsWith('/assets/') || parsed.pathname.startsWith('/public-assets/'),
        `Refusing unexpected asset URL: ${parsed.pathname}`,
      );
    }
    const response = await fetchImpl(url, {
      method,
      headers,
      body: json === undefined ? form : JSON.stringify(json),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (expectedBinary) {
      if (!response.ok) throw new Error(`GET ${parsed.pathname} failed with HTTP ${response.status}.`);
      const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      invariant(contentType === 'image/png', `GET ${parsed.pathname} returned ${contentType || 'no content type'}.`);
      return Buffer.from(await response.arrayBuffer());
    }
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${method} ${parsed.pathname} returned non-JSON (${response.status}).`);
    }
    if (!response.ok) {
      throw new Error(responseDetail(body, `${method} ${parsed.pathname} failed with HTTP ${response.status}.`));
    }
    return body;
  }

  return {
    expectedOwnerUserId: tokenProvider.userId,
    health: () => request('/health', { authenticated: false }),
    getFighter: async (fighterId) => (
      await request(`/api/fighters/${encodeURIComponent(fighterId)}`)
    ).fighter,
    listAdminArcade: async () => (await request('/api/admin/arcade')).fighters,
    uploadSource: async (fighterId, source, bytes) => {
      const form = new FormData();
      form.set('kind', source.kind);
      form.set('file', new Blob([bytes], { type: 'image/png' }), `${source.kind}.png`);
      return request(`/api/fighters/${encodeURIComponent(fighterId)}/sources`, { method: 'POST', form });
    },
    uploadSprite: async (fighterId, sprite, contract, bytes, rawBytes) => {
      const form = new FormData();
      form.set('animationName', sprite.animationName);
      form.set('qualityTier', contract.fighter.qualityTier);
      form.set('frameWidth', String(sprite.frameWidth));
      form.set('frameHeight', String(sprite.frameHeight));
      form.set('frameCount', String(sprite.frameCount));
      form.set('animationFormat', contract.animationFormat);
      form.set('processingVersion', String(contract.processingVersion));
      form.set('setCurrent', 'false');
      form.set('file', new Blob([bytes], { type: 'image/png' }), `${sprite.animationName}.png`);
      form.set('rawFile', new Blob([rawBytes], { type: 'image/png' }), `${sprite.animationName}-raw.png`);
      return request(`/api/fighters/${encodeURIComponent(fighterId)}/sprites`, { method: 'POST', form });
    },
    promoteSprite: (fighterId, sprite, contract) => request(
      `/api/fighters/${encodeURIComponent(fighterId)}/sprites`,
      {
        method: 'PATCH',
        json: {
          animationName: sprite.animationName,
          qualityTier: contract.fighter.qualityTier,
          contentHash: sprite.sha256,
          rawContentHash: sprite.rawSha256,
          animationFormat: contract.animationFormat,
          frameWidth: sprite.frameWidth,
          frameHeight: sprite.frameHeight,
          frameCount: sprite.frameCount,
          processingVersion: contract.processingVersion,
        },
      },
    ),
    setArcadeStatus: (fighterId, status) => request(
      `/api/admin/arcade/${encodeURIComponent(fighterId)}`,
      { method: 'PATCH', json: { status } },
    ),
    getPublicArcade: async () => (await request('/api/arcade', { authenticated: false })).fighters,
    downloadPrivateSprite: (url) => request(url, { expectedBinary: true }),
    downloadPublicSprite: (url) => request(url, { expectedBinary: true, authenticated: false }),
    downloadPrivateSource: (url) => request(url, { expectedBinary: true }),
    downloadPublicSource: (url) => request(url, { expectedBinary: true, authenticated: false }),
    purgeArcadeCache: async () => {
      const response = await fetchImpl(
        `https://api.cloudflare.com/client/v4/zones/${cloudflareZoneId}/purge_cache`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cloudflareApiToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ files: [`${PRODUCTION_API_ORIGIN}/api/arcade`] }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      const text = await response.text();
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Cloudflare cache purge returned non-JSON (${response.status}).`);
      }
      invariant(response.ok && body.success === true, `Cloudflare Arcade cache purge failed with HTTP ${response.status}.`);
      return body;
    },
  };
}

function spriteMatches(actual, expected, contract, { requireHash, requireRawHash = requireHash }) {
  return actual?.animationName === expected.animationName
    && actual?.qualityTier === contract.fighter.qualityTier
    && actual?.frameWidth === expected.frameWidth
    && actual?.frameHeight === expected.frameHeight
    && actual?.frameCount === expected.frameCount
    && actual?.animationFormat === contract.animationFormat
    && actual?.processingVersion === contract.processingVersion
    && (!requireHash || actual?.contentHash === expected.sha256)
    && (!requireRawHash || actual?.rawContentHash === expected.rawSha256);
}

function exactSpriteMap(actualSprites, contract, { requireHash, requireRawHash = requireHash, exactSet }) {
  invariant(Array.isArray(actualSprites), 'The fighter response is missing its sprite list.');
  const expectedNames = new Set(contract.sprites.map((sprite) => sprite.animationName));
  const relevant = actualSprites.filter((sprite) => sprite.qualityTier === contract.fighter.qualityTier);
  if (exactSet) {
    invariant(relevant.length === contract.sprites.length, 'Champion sprite set is not exactly 11 animations.');
    invariant(
      relevant.every((sprite) => expectedNames.has(sprite.animationName)),
      'Champion sprite set contains an unexpected animation.',
    );
  }
  const result = new Map();
  for (const expected of contract.sprites) {
    const matches = relevant.filter((actual) => spriteMatches(
      actual,
      expected,
      contract,
      { requireHash, requireRawHash },
    ));
    invariant(matches.length === 1, `Expected exactly one sealed ${expected.animationName} sprite, found ${matches.length}.`);
    result.set(expected.animationName, matches[0]);
  }
  return result;
}

function assertFighterIdentity(fighter, contract, expectedOwnerUserId) {
  invariant(fighter?.id === contract.fighter.id, 'Authenticated fighter response returned another fighter.');
  invariant(fighter.ownerUserId === expectedOwnerUserId, 'Trump fighter is owned by another Clerk user.');
  invariant(fighter.name === contract.fighter.name, `Expected fighter name ${contract.fighter.name}.`);
  invariant(fighter.photoHash === contract.fighter.photoHash, 'Trump fighter photo hash does not match the sealed source.');
  invariant(fighter.qualityTier === contract.fighter.qualityTier, 'Trump fighter is not Champion tier.');
}

function assertHealth(health, expectedDeployedSha) {
  invariant(/^[a-f0-9]{40}$/.test(expectedDeployedSha), 'Expected deployed SHA must be a full 40-character commit SHA.');
  invariant(health?.status === 'ok', 'Production Worker health is not ok.');
  invariant(health.environment === 'production', 'Worker health did not identify the production environment.');
  invariant(health.storage?.d1 === 'bound' && health.storage?.r2 === 'bound', 'Production D1/R2 bindings are not healthy.');
  const tag = health.workerVersion?.tag;
  invariant(
    typeof tag === 'string' && tag.startsWith(`prod-${expectedDeployedSha}-`),
    `Production Worker tag does not match deployed commit ${expectedDeployedSha}.`,
  );
  invariant(typeof health.workerVersion?.id === 'string' && health.workerVersion.id, 'Worker version ID is missing.');
}

async function verifySpriteAssets(serverSprites, bundle, client, { publicAssets }) {
  for (const expected of bundle.contract.sprites) {
    const actual = serverSprites.get(expected.animationName);
    invariant(typeof actual?.url === 'string' && actual.url.startsWith('https://'), `${expected.animationName} has no HTTPS URL.`);
    const bytes = publicAssets
      ? await client.downloadPublicSprite(actual.url)
      : await client.downloadPrivateSprite(actual.url);
    validateSpriteBytes(bytes, expected);
    if (!publicAssets) {
      invariant(typeof actual.rawUrl === 'string' && actual.rawUrl.startsWith('https://'), `${expected.animationName} has no raw HTTPS URL.`);
      const rawBytes = await client.downloadPrivateSprite(actual.rawUrl);
      validateRawSpriteBytes(rawBytes, expected);
    } else {
      invariant(actual.rawUrl === null, `${expected.animationName} public raw URL must be exactly null.`);
      invariant(actual.rawContentHash === undefined, `${expected.animationName} leaked a public raw content hash.`);
    }
  }
}

async function verifyCanonicalSources(fighter, bundle, client) {
  invariant(fighter?.sources && typeof fighter.sources === 'object', 'Fighter response is missing canonical source URLs.');
  invariant(fighter?.sourceHashes && typeof fighter.sourceHashes === 'object', 'Fighter response is missing canonical source hashes.');
  for (const source of bundle.contract.sources) {
    invariant(
      fighter.sourceHashes[source.hashKey] === source.sha256,
      `${source.kind} canonical source hash is not sealed.`,
    );
    const url = fighter.sources[source.responseKey];
    invariant(typeof url === 'string' && url.startsWith('https://'), `${source.kind} canonical source has no HTTPS URL.`);
    const bytes = await client.downloadPrivateSource(url);
    validateSourceBytes(bytes, source);
  }
}

async function verifyPublicArcade(bundle, client) {
  const fighters = await client.getPublicArcade();
  invariant(Array.isArray(fighters), 'Public Arcade response is missing fighters.');
  const matches = fighters.filter((fighter) => fighter.id === bundle.contract.fighter.id);
  invariant(matches.length === 1, `Public Arcade contains ${matches.length} Trump entries.`);
  const fighter = matches[0];
  invariant(fighter.name === bundle.contract.fighter.name, 'Public Arcade Trump name changed.');
  invariant(fighter.arcade?.slug === bundle.contract.fighter.slug, 'Public Arcade Trump slug changed.');
  invariant(fighter.public === true, 'Public Arcade Trump is not public.');
  invariant(fighter.sources?.original === null, 'Public Arcade leaked the original source URL.');
  invariant(fighter.sources?.sideRaw === null, 'Public Arcade leaked the side raw source URL.');
  invariant(fighter.sources?.uprightRaw === null, 'Public Arcade leaked the upright raw source URL.');
  invariant(fighter.sources?.crouchRaw === null, 'Public Arcade leaked the crouch raw source URL.');
  for (const source of bundle.contract.sources.filter((entry) => (
    entry.kind === 'side' || entry.kind === 'upright' || entry.kind === 'crouch'
  ))) {
    const url = fighter.sources?.[source.responseKey];
    invariant(typeof url === 'string' && url.startsWith('https://'), `Public Arcade ${source.kind} source has no HTTPS URL.`);
    const bytes = await client.downloadPublicSource(url);
    validateSourceBytes(bytes, source);
  }
  const sprites = exactSpriteMap(fighter.sprites, bundle.contract, {
    requireHash: true,
    requireRawHash: false,
    exactSet: true,
  });
  await verifySpriteAssets(sprites, bundle, client, { publicAssets: true });
  return fighter;
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function buildTrumpVideoRosterPlan(bundle) {
  return {
    mode: 'plan',
    bundleId: bundle.contract.bundleId,
    contractSha256: bundle.contractSha256,
    fighterId: bundle.contract.fighter.id,
    slug: bundle.contract.fighter.slug,
    operations: [
      'verify exact deployed production Worker commit and D1/R2 health',
      'verify the private draft fighter identity and Arcade record',
      'repair and download-verify all 7 canonical source pointers',
      'stage all 11 sealed sprites with setCurrent=false',
      'download and verify all 11 processed and 11 raw staged sprites',
      'promote all 11 versions while the fighter remains draft',
      'download and verify every current sprite',
      'activate the Arcade fighter',
      'purge the exact Arcade API cache URL',
      'public-smoke all 11 sprites; roll back to draft and purge again if this final phase fails',
    ],
  };
}

export async function executeTrumpVideoRosterImport({
  bundle,
  client,
  expectedDeployedSha,
  expectedOwnerUserId = client.expectedOwnerUserId,
  now = () => new Date().toISOString(),
  onCheckpoint = () => {},
}) {
  const receipt = {
    schemaVersion: 1,
    operation: 'activate-trump-video-roster-production',
    bundleId: bundle.contract.bundleId,
    contractSha256: bundle.contractSha256,
    fighterId: bundle.contract.fighter.id,
    expectedDeployedSha,
    status: 'running',
    startedAt: now(),
    events: [],
    rollback: null,
  };
  let activationAttempted = false;
  const checkpoint = (phase, detail = {}) => {
    receipt.events.push({ at: now(), phase, ...detail });
    onCheckpoint(receipt);
  };

  try {
    const health = await client.health();
    assertHealth(health, expectedDeployedSha);
    receipt.workerVersion = {
      id: health.workerVersion.id,
      tag: health.workerVersion.tag,
    };
    checkpoint('health-verified');

    let fighter = await client.getFighter(bundle.contract.fighter.id);
    assertFighterIdentity(fighter, bundle.contract, expectedOwnerUserId);
    const adminFighters = await client.listAdminArcade();
    invariant(Array.isArray(adminFighters), 'Admin Arcade response is missing fighters.');
    const adminMatches = adminFighters.filter((entry) => entry.fighterId === bundle.contract.fighter.id);
    invariant(adminMatches.length === 1, `Expected one Trump Arcade record, found ${adminMatches.length}.`);
    const admin = adminMatches[0];
    invariant(admin.slug === bundle.contract.fighter.slug, 'Trump Arcade record has another slug.');
    invariant(admin.fighterName === bundle.contract.fighter.name, 'Trump Arcade record has another name.');
    invariant(admin.qualityTier === bundle.contract.fighter.qualityTier, 'Trump Arcade record is not Champion.');
    invariant(admin.status === 'draft' || admin.status === 'active', `Trump Arcade status is ${String(admin.status)}.`);
    invariant(Boolean(admin.public) === (admin.status === 'active'), 'Trump Arcade status and public flag disagree.');
    checkpoint('fighter-identity-verified', { initialArcadeStatus: admin.status });

    if (admin.status === 'active') {
      // A killed prior run may have activated before its final smoke. Treat any
      // resume verification failure as post-activation and fail closed to draft.
      activationAttempted = true;
      await verifyCanonicalSources(fighter, bundle, client);
      const current = exactSpriteMap(fighter.sprites, bundle.contract, { requireHash: true, exactSet: true });
      await verifySpriteAssets(current, bundle, client, { publicAssets: false });
      await client.purgeArcadeCache();
      checkpoint('arcade-cache-purged');
      await verifyPublicArcade(bundle, client);
      receipt.status = 'already-active';
      receipt.completedAt = now();
      checkpoint('already-active-public-smoke-passed');
      onCheckpoint(receipt);
      return receipt;
    }

    invariant(fighter.public === false, 'Draft Trump fighter is unexpectedly public.');
    for (const source of bundle.contract.sources) {
      await client.uploadSource(
        bundle.contract.fighter.id,
        source,
        bundle.sourceBytes.get(source.kind),
      );
      checkpoint('canonical-source-repaired', { kind: source.kind, sha256: source.sha256 });
    }
    fighter = await client.getFighter(bundle.contract.fighter.id);
    assertFighterIdentity(fighter, bundle.contract, expectedOwnerUserId);
    invariant(fighter.public === false, 'Trump became public during source repair.');
    await verifyCanonicalSources(fighter, bundle, client);
    checkpoint('all-canonical-sources-verified');

    for (const sprite of bundle.contract.sprites) {
      await client.uploadSprite(
        bundle.contract.fighter.id,
        sprite,
        bundle.contract,
        bundle.spriteBytes.get(sprite.animationName),
        bundle.rawSpriteBytes.get(sprite.animationName),
      );
      checkpoint('sprite-staged', { animationName: sprite.animationName, sha256: sprite.sha256 });
    }

    fighter = await client.getFighter(bundle.contract.fighter.id);
    assertFighterIdentity(fighter, bundle.contract, expectedOwnerUserId);
    invariant(fighter.public === false, 'Trump became public during staging.');
    const staged = exactSpriteMap(fighter.spriteVersions, bundle.contract, { requireHash: true, exactSet: false });
    await verifySpriteAssets(staged, bundle, client, { publicAssets: false });
    checkpoint('all-staged-assets-verified');

    for (const sprite of bundle.contract.sprites) {
      await client.promoteSprite(bundle.contract.fighter.id, sprite, bundle.contract);
      checkpoint('sprite-promoted', { animationName: sprite.animationName, sha256: sprite.sha256 });
    }

    fighter = await client.getFighter(bundle.contract.fighter.id);
    assertFighterIdentity(fighter, bundle.contract, expectedOwnerUserId);
    invariant(fighter.public === false, 'Trump became public before activation.');
    const current = exactSpriteMap(fighter.sprites, bundle.contract, { requireHash: true, exactSet: true });
    await verifySpriteAssets(current, bundle, client, { publicAssets: false });
    checkpoint('all-current-assets-verified');

    activationAttempted = true;
    const activation = await client.setArcadeStatus(bundle.contract.fighter.id, 'active');
    invariant(activation?.fighter?.status === 'active', 'Arcade activation did not return active status.');
    checkpoint('arcade-activated');

    await client.purgeArcadeCache();
    checkpoint('arcade-cache-purged');
    await verifyPublicArcade(bundle, client);
    checkpoint('public-smoke-passed');
    receipt.status = 'activated';
    receipt.completedAt = now();
    onCheckpoint(receipt);
    return receipt;
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = safeErrorMessage(error);
    if (activationAttempted) {
      try {
        const rollback = await client.setArcadeStatus(bundle.contract.fighter.id, 'draft');
        invariant(rollback?.fighter?.status === 'draft', 'Draft rollback did not return draft status.');
        let cachePurgeSucceeded = false;
        try {
          await client.purgeArcadeCache();
          cachePurgeSucceeded = true;
        } catch {
          // The draft mutation is the safety boundary; report cache purge status separately.
        }
        receipt.rollback = { attempted: true, succeeded: true, cachePurgeSucceeded, at: now() };
      } catch (rollbackError) {
        receipt.rollback = {
          attempted: true,
          succeeded: false,
          at: now(),
          error: safeErrorMessage(rollbackError),
        };
      }
    } else {
      receipt.rollback = { attempted: false, reason: 'activation-not-attempted' };
    }
    receipt.completedAt = now();
    onCheckpoint(receipt);
    const failure = new Error(
      receipt.rollback?.attempted && !receipt.rollback.succeeded
        ? `${receipt.error} Draft rollback also failed: ${receipt.rollback.error}`
        : receipt.error,
      { cause: error },
    );
    failure.importReceipt = receipt;
    throw failure;
  }
}

function writeReceiptAtomic(path, receipt) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
}

export async function runTrumpVideoRosterCli(rawArgs, {
  env = process.env,
  stdout = (text) => process.stdout.write(text),
  validateBundle = validateBundleDirectory,
  createTokenProvider = createAdminTokenProviderFromEnv,
  createApiClient = createProductionApiClient,
} = {}) {
  const bundlePath = findArg(rawArgs, 'bundle');
  invariant(bundlePath, 'Pass --bundle=/absolute/path/to/the/extracted-bundle.');
  const bundle = validateBundle(resolve(bundlePath));
  const plan = buildTrumpVideoRosterPlan(bundle);
  const execute = rawArgs.includes('--execute');
  if (!execute) {
    stdout(`${JSON.stringify(plan, null, 2)}\n`);
    return plan;
  }

  const confirmation = findArg(rawArgs, 'confirm');
  invariant(
    confirmation === PRODUCTION_CONFIRMATION,
    `Production execution requires --confirm=${PRODUCTION_CONFIRMATION}.`,
  );
  const expectedDeployedSha = (
    findArg(rawArgs, 'expected-deployed-sha')
    || env.ASF_EXPECTED_DEPLOYED_SHA
    || env.GITHUB_SHA
    || ''
  ).trim().toLowerCase();
  invariant(/^[a-f0-9]{40}$/.test(expectedDeployedSha), 'Pass the full deployed commit with --expected-deployed-sha.');
  const baseUrl = (env.ASF_WORKER_URL || PRODUCTION_API_ORIGIN).replace(/\/+$/, '');
  invariant(baseUrl === PRODUCTION_API_ORIGIN, `ASF_WORKER_URL must be exactly ${PRODUCTION_API_ORIGIN}.`);
  const bridgeSecret = (env.CLERK_BACKEND_AUTH_BRIDGE_SECRET || '').trim();
  const cloudflareApiToken = (env.CLOUDFLARE_API_TOKEN || '').trim();
  const cloudflareZoneId = (env.ASF_CLOUDFLARE_ZONE_ID || '').trim();
  const tokenProvider = await createTokenProvider(env);
  const client = createApiClient({
    baseUrl,
    tokenProvider,
    backendAuthBridgeSecret: bridgeSecret,
    cloudflareApiToken,
    cloudflareZoneId,
  });
  const receiptPath = resolve(
    findArg(rawArgs, 'receipt')
      || join(root, '.artifacts/arcade-import-receipts', `${bundle.contract.bundleId}.json`),
  );
  let latestReceipt = {
    schemaVersion: 1,
    status: 'starting',
    bundleId: bundle.contract.bundleId,
    contractSha256: bundle.contractSha256,
  };
  writeReceiptAtomic(receiptPath, latestReceipt);
  try {
    const receipt = await executeTrumpVideoRosterImport({
      bundle,
      client,
      expectedDeployedSha,
      expectedOwnerUserId: tokenProvider.userId,
      onCheckpoint: (checkpoint) => {
        latestReceipt = structuredClone(checkpoint);
        writeReceiptAtomic(receiptPath, latestReceipt);
      },
    });
    stdout(`${JSON.stringify({ receiptPath, ...receipt }, null, 2)}\n`);
    return receipt;
  } catch (error) {
    if (error?.importReceipt) writeReceiptAtomic(receiptPath, error.importReceipt);
    throw error;
  }
}

async function main() {
  return runTrumpVideoRosterCli(process.argv.slice(2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
