import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminTokenProviderFromEnv } from './import-trump-video-roster.mjs';
import { assertProductionDeployAllowed } from './production-deploy-guard.mjs';

export const CASUAL_IDENTITY = Object.freeze({
  slug: 'casual', name: 'Casual',
  sourceSha256: 'e29f551726c5e80941bcf63618401bbf00429d56df52f6cbb20d8da57435c210',
});
export const CASUAL_ANIMATIONS = Object.freeze([
  'idle', 'walk', 'high_punch', 'low_punch', 'high_kick', 'low_kick',
  'jump', 'crouch', 'hit', 'ko', 'victory',
  'aura_unbothered', 'aura_six_seven', 'aura_mog_check', 'aura_glide', 'aura_floor_worm', 'aura_one_leg',
]);
export const CASUAL_FRAME_COUNTS = Object.freeze({
  idle: 8, walk: 16, high_punch: 7, low_punch: 7, high_kick: 7, low_kick: 7,
  jump: 4, crouch: 4, hit: 4, ko: 8, victory: 8,
  aura_unbothered: 6, aura_six_seven: 6, aura_mog_check: 6,
  aura_glide: 6, aura_floor_worm: 6, aura_one_leg: 6,
});
const SOURCE_KEYS = Object.freeze({ original: 'original', side: 'side', side_raw: 'sideRaw',
  upright: 'upright', upright_raw: 'uprightRaw', crouch: 'crouch', crouch_raw: 'crouchRaw' });
const ORIGIN = 'https://api.insertplayer.ai';
const CONFIRMATION = 'IMPORT_CASUAL_ROSTER_PRODUCTION_V1';
const SHA = /^[a-f0-9]{64}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const invariant = (condition, message) => { if (!condition) throw new Error(message); };
const spriteKey = sprite => `${sprite.qualityTier}:${sprite.animationName}`;
const positiveInteger = value => Number.isInteger(value) && value > 0;

function pngGeometry(bytes, label) {
  invariant(bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR', `${label}: expected PNG bytes.`);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  invariant(width > 0 && height > 0, `${label}: invalid PNG geometry.`);
  return { width, height };
}

/** Validates all bytes before any credential creation, request, or mutation. */
export function validateCasualManifest(manifestPath, expectedSha256) {
  invariant(SHA.test(expectedSha256), 'An exact manifest SHA-256 is required.');
  const path = resolve(manifestPath);
  invariant(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Manifest must be a regular file.');
  const manifestBytes = readFileSync(path);
  invariant(digest(manifestBytes) === expectedSha256, 'Manifest SHA-256 mismatch.');
  const manifest = JSON.parse(manifestBytes);
  invariant(manifest.schemaVersion === 1, 'Unsupported Casual manifest schema.');
  for (const [key, value] of Object.entries(CASUAL_IDENTITY)) {
    invariant(manifest.identity?.[key] === value, `Casual identity ${key} mismatch.`);
  }
  invariant(Array.isArray(manifest.sources) && manifest.sources.length === 7, 'Exactly seven canonical sources are required.');
  invariant(Array.isArray(manifest.sprites) && manifest.sprites.length === 34, 'Exactly 17 Rookie and 17 Champion animations are required.');
  const root = realpathSync(dirname(path));
  const files = new Map();
  function readAsset(relativePath, sha256, maxBytes) {
    invariant(typeof relativePath === 'string' && relativePath.length > 0
      && !relativePath.includes('\\') && !relativePath.startsWith('/')
      && relativePath.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe asset path.');
    const target = resolve(root, relativePath);
    invariant(target.startsWith(`${root}${sep}`) && realpathSync(target) === target
      && lstatSync(target).isFile(), `Asset must be a regular file inside the bundle: ${relativePath}`);
    invariant(SHA.test(sha256), `Invalid asset hash: ${relativePath}`);
    const bytes = readFileSync(target);
    invariant(bytes.length > 0 && bytes.length <= maxBytes && digest(bytes) === sha256, `Asset hash or size mismatch: ${relativePath}`);
    files.set(relativePath, bytes);
    return bytes;
  }
  const sourceKinds = new Set();
  for (const source of manifest.sources) {
    invariant(Object.hasOwn(SOURCE_KEYS, source.kind) && !sourceKinds.has(source.kind), 'Missing, repeated, or unsupported source kind.');
    sourceKinds.add(source.kind);
    const bytes = readAsset(source.path, source.sha256, 12 * 1024 * 1024);
    invariant(source.bytes === bytes.length, `Source byte length mismatch: ${source.kind}`);
    if (source.kind === 'original') {
      invariant(source.sha256 === CASUAL_IDENTITY.sourceSha256 && source.mime === 'image/webp'
        && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP', 'The immutable Casual original must be its exact published WebP.');
    } else {
      invariant(source.mime === 'image/png', `Canonical ${source.kind} must be PNG.`);
      pngGeometry(bytes, source.kind);
    }
  }
  const keys = new Set();
  for (const sprite of manifest.sprites) {
    const key = spriteKey(sprite);
    invariant(['rookie', 'contender'].includes(sprite.qualityTier) && CASUAL_ANIMATIONS.includes(sprite.animationName)
      && !keys.has(key), 'Unsupported, mixed, or duplicate sprite tier/animation.');
    keys.add(key);
    invariant(sprite.animationFormat === 'legacy', 'Casual uses the ordinary legacy image pipeline, not Video HQ.');
    invariant([sprite.frameWidth, sprite.frameHeight, sprite.frameCount, sprite.gridCols, sprite.gridRows,
      sprite.rawWidth, sprite.rawHeight].every(positiveInteger)
      && sprite.frameWidth === 768 && sprite.frameHeight === 1024
      && sprite.frameCount === CASUAL_FRAME_COUNTS[sprite.animationName]
      && sprite.gridRows === Math.ceil(sprite.frameCount / sprite.gridCols)
      && Number.isInteger(sprite.processingVersion) && sprite.processingVersion >= 0 && sprite.processingVersion <= 100
      && sprite.rawMime === 'image/png', `Invalid frame or raw metadata: ${key}`);
    const bytes = readAsset(sprite.path, sprite.sha256, 32 * 1024 * 1024);
    const rawBytes = readAsset(sprite.rawPath, sprite.rawSha256, 32 * 1024 * 1024);
    invariant(sprite.mime === 'image/png' && sprite.bytes === bytes.length && sprite.rawBytes === rawBytes.length,
      `Sprite MIME or byte length mismatch: ${key}`);
    const processed = pngGeometry(bytes, key), raw = pngGeometry(rawBytes, `${key} raw`);
    invariant(processed.width === sprite.frameWidth * sprite.gridCols
      && processed.height === sprite.frameHeight * sprite.gridRows, `Processed grid mismatch: ${key}`);
    invariant(raw.width === sprite.rawWidth && raw.height === sprite.rawHeight, `Raw geometry mismatch: ${key}`);
  }
  for (const tier of ['rookie', 'contender']) for (const animation of CASUAL_ANIMATIONS) {
    invariant(keys.has(`${tier}:${animation}`), `Incomplete ${tier} pack: ${animation}`);
  }
  return { manifest, manifestSha256: expectedSha256, files };
}

export function createCasualApiClient({ tokenProvider, backendAuthBridgeSecret, cloudflareApiToken,
  cloudflareZoneId, baseUrl = ORIGIN, fetchImpl = fetch }) {
  invariant(baseUrl === ORIGIN, `Casual import is pinned to ${ORIGIN}.`);
  invariant(backendAuthBridgeSecret?.length >= 32, 'Production backend auth bridge is required.');
  invariant(cloudflareApiToken?.length >= 20 && /^[a-f0-9]{32}$/i.test(cloudflareZoneId), 'Exact Arcade cache purge credentials are required.');
  async function request(path, { method = 'GET', json, form, publicRequest = false, binary = false } = {}) {
    const url = new URL(path, ORIGIN);
    invariant(url.origin === ORIGIN && !url.username && !url.password, 'Refusing a foreign API or asset URL.');
    if (binary) invariant(/^\/(?:public-assets|assets)\//.test(url.pathname), 'Unexpected asset route.');
    const headers = { Accept: binary ? 'image/*' : 'application/json' };
    if (!publicRequest) {
      headers.Authorization = `Bearer ${await tokenProvider.getToken()}`;
      headers['X-Insert-Player-Clerk-Backend-Auth'] = backendAuthBridgeSecret;
    }
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetchImpl(url, { method, headers, body: json === undefined ? form : JSON.stringify(json),
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      const error = new Error(`${method} ${url.pathname} failed (${response.status}).`);
      error.status = response.status; throw error;
    }
    if (binary) {
      invariant(['image/png', 'image/webp'].includes(response.headers.get('content-type')?.split(';')[0]), 'Unexpected downloaded image MIME.');
      return Buffer.from(await response.arrayBuffer());
    }
    return response.json();
  }
  return {
    health: () => request('/health', { publicRequest: true }),
    listAdminArcade: async () => (await request('/api/admin/arcade')).fighters,
    listOwned: async () => (await request('/api/fighters')).fighters,
    getFighter: async id => (await request(`/api/fighters/${id}`)).fighter,
    createFighter: async () => (await request('/api/fighters', { method: 'POST', json: {
      name: CASUAL_IDENTITY.name, photoHash: CASUAL_IDENTITY.sourceSha256, qualityTier: 'contender', public: false,
    } })).fighter,
    setArcade: (id, metadata) => request(`/api/admin/arcade/${id}`, { method: 'PATCH', json: metadata }),
    uploadSource: (id, source, bytes) => {
      const form = new FormData();
      form.set('kind', source.kind);
      form.set('file', new Blob([bytes], { type: source.mime }), `${source.kind}.${source.kind === 'original' ? 'webp' : 'png'}`);
      return request(`/api/fighters/${id}/sources`, { method: 'POST', form });
    },
    uploadSprite: (id, sprite, bytes, rawBytes) => {
      const form = new FormData();
      for (const key of ['animationName', 'qualityTier', 'frameWidth', 'frameHeight', 'frameCount', 'processingVersion']) form.set(key, String(sprite[key]));
      form.set('animationFormat', 'legacy'); form.set('setCurrent', 'false');
      form.set('file', new Blob([bytes], { type: 'image/png' }), `${sprite.animationName}.png`);
      form.set('rawFile', new Blob([rawBytes], { type: 'image/png' }), `${sprite.animationName}-raw.png`);
      return request(`/api/fighters/${id}/sprites`, { method: 'POST', form });
    },
    promoteSprite: (id, sprite) => request(`/api/fighters/${id}/sprites`, { method: 'PATCH', json: {
      animationName: sprite.animationName, qualityTier: sprite.qualityTier, contentHash: sprite.sha256,
      rawContentHash: sprite.rawSha256, animationFormat: 'legacy', frameWidth: sprite.frameWidth,
      frameHeight: sprite.frameHeight, frameCount: sprite.frameCount, processingVersion: sprite.processingVersion,
    } }),
    publicRoster: async () => (await request('/api/arcade', { publicRequest: true })).fighters,
    download: (url, publicRequest = false) => request(url, { publicRequest, binary: true }),
    purgeArcadeCache: async () => {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${cloudflareZoneId}/purge_cache`, {
        method: 'POST', headers: { Authorization: `Bearer ${cloudflareApiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [`${ORIGIN}/api/arcade`] }), redirect: 'error', signal: AbortSignal.timeout(120_000),
      });
      invariant(response.ok && (await response.json()).success === true, 'Exact Arcade cache purge failed.');
    },
  };
}

function assertIdentity(fighter, ownerId) {
  invariant(/^[a-f0-9]{32}$/.test(fighter?.id) && fighter.ownerUserId === ownerId
    && fighter.name === CASUAL_IDENTITY.name && fighter.photoHash === CASUAL_IDENTITY.sourceSha256
    && ['rookie', 'contender'].includes(fighter.qualityTier), 'Existing fighter does not match the sealed Casual identity and actual tier.');
}

function matchesSprite(actual, expected, publicAsset = false) {
  return actual?.animationName === expected.animationName && actual.qualityTier === expected.qualityTier
    && actual.contentHash === expected.sha256 && (publicAsset || actual.rawContentHash === expected.rawSha256)
    && actual.animationFormat === 'legacy' && actual.frameWidth === expected.frameWidth
    && actual.frameHeight === expected.frameHeight && actual.frameCount === expected.frameCount
    && actual.processingVersion === expected.processingVersion;
}

async function verifySprites(actualSprites, expectedSprites, client, { publicAsset = false } = {}) {
  invariant(Array.isArray(actualSprites), 'Missing remote sprite manifest.');
  for (const sprite of expectedSprites) {
    const matches = actualSprites.filter(actual => matchesSprite(actual, sprite, publicAsset));
    invariant(matches.length === 1, `Expected one exact remote ${spriteKey(sprite)} version.`);
    const remote = matches[0];
    invariant(typeof remote.url === 'string' && digest(await client.download(remote.url, publicAsset)) === sprite.sha256,
      `Remote sprite bytes mismatch: ${spriteKey(sprite)}`);
    if (publicAsset) {
      invariant(remote.rawUrl == null && remote.rawContentHash == null && remote.rawFrameWidth == null
        && remote.rawFrameHeight == null && remote.rawFrameCount == null && remote.hqUrl == null
        && remote.hqFrameWidth == null && remote.hqFrameHeight == null && remote.hqFrameCount == null,
      'Public Casual must not expose legacy raw assets or claim Video HQ.');
    } else {
      invariant(typeof remote.rawUrl === 'string' && digest(await client.download(remote.rawUrl)) === sprite.rawSha256,
        `Remote raw bytes mismatch: ${spriteKey(sprite)}`);
    }
  }
}

async function verifySources(fighter, bundle, client) {
  for (const source of bundle.manifest.sources) {
    const url = fighter.sources?.[SOURCE_KEYS[source.kind]];
    invariant(fighter.sourceHashes?.[source.kind] === source.sha256 && typeof url === 'string'
      && digest(await client.download(url)) === source.sha256, `Remote source mismatch: ${source.kind}`);
  }
}

async function verifyPublic(id, bundle, client) {
  const matches = (await client.publicRoster()).filter(fighter => fighter.id === id || fighter.arcade?.slug === 'casual');
  invariant(matches.length === 1 && matches[0].id === id, 'Casual public identity is missing or duplicated.');
  const fighter = matches[0];
  invariant(fighter.public === true && fighter.name === 'Casual' && fighter.qualityTier === 'contender'
    && fighter.arcade?.slug === 'casual' && fighter.arcade?.reference?.kind === 'generated', 'Published Casual identity changed.');
  for (const key of ['original', 'sideRaw', 'uprightRaw', 'crouchRaw']) invariant(fighter.sources?.[key] == null, 'Public original/raw source leak.');
  invariant(fighter.sprites?.every(sprite => sprite.qualityTier === 'contender'), 'Public Casual mixes quality tiers.');
  for (const pack of ['fight-v1', 'aura-v1-2026']) {
    invariant(fighter.assetPacks?.some(entry => entry.id === pack && entry.status === 'ready' && entry.qualityTier === 'contender'), `Public ${pack} pack is incomplete.`);
  }
  for (const source of bundle.manifest.sources.filter(source => ['side', 'upright', 'crouch'].includes(source.kind))) {
    const url = fighter.sources?.[source.kind];
    invariant(typeof url === 'string' && digest(await client.download(url, true)) === source.sha256, `Public source mismatch: ${source.kind}`);
  }
  await verifySprites(fighter.sprites, bundle.manifest.sprites.filter(sprite => sprite.qualityTier === 'contender'), client, { publicAsset: true });
}

export async function executeCasualImport({ bundle, client, ownerId, expectedSha, onCheckpoint = () => {} }) {
  invariant(/^[a-f0-9]{40}$/.test(expectedSha), 'A full production commit SHA is required.');
  const health = await client.health();
  const liveVersionTag = health?.workerVersion?.tag;
  const liveVersion = typeof liveVersionTag === 'string'
    ? /^prod-([a-f0-9]{40})-[1-9][0-9]*$/.exec(liveVersionTag) : null;
  invariant(health?.status === 'ok' && health.environment === 'production' && health.storage?.d1 === 'bound'
    && health.storage?.r2 === 'bound' && liveVersion?.[0] === liveVersionTag && liveVersion?.[1] === expectedSha,
    'Live Worker does not match the exact production commit.');
  const receipt = { schemaVersion: 1, manifestSha256: bundle.manifestSha256, gitSha: expectedSha,
    identity: CASUAL_IDENTITY, status: 'checking', steps: [] };
  const checkpoint = step => { receipt.steps.push(step); onCheckpoint(structuredClone(receipt)); };
  const admin = await client.listAdminArcade();
  invariant(Array.isArray(admin), 'Invalid admin roster.');
  const bySlug = admin.filter(entry => entry.slug === 'casual');
  invariant(bySlug.length <= 1, 'Duplicate Casual Arcade slug.');
  const owned = await client.listOwned();
  invariant(Array.isArray(owned), 'Invalid owned roster.');
  const candidates = new Map(owned.filter(fighter => fighter.photoHash === CASUAL_IDENTITY.sourceSha256).map(fighter => [fighter.id, fighter]));
  // Owned lists omit official fighters. Check their private identities before creating by photo hash.
  for (const entry of admin) {
    let fighter;
    try { fighter = await client.getFighter(entry.fighterId); }
    catch (error) {
      if (error?.status === 404 && entry.slug !== 'casual') continue;
      throw error;
    }
    if (fighter?.photoHash === CASUAL_IDENTITY.sourceSha256 || entry.slug === 'casual') {
      assertIdentity(fighter, ownerId);
      invariant(entry.slug === 'casual', 'Casual source already belongs to another official slug.');
      candidates.set(fighter.id, fighter);
    }
  }
  invariant(candidates.size <= 1, 'Duplicate Casual source identity.');
  let fighter = candidates.size ? await client.getFighter([...candidates.keys()][0]) : null;
  if (fighter) {
    assertIdentity(fighter, ownerId);
    if (fighter.sources?.original || fighter.sourceHashes?.original) {
      invariant(fighter.sourceHashes?.original === CASUAL_IDENTITY.sourceSha256 && typeof fighter.sources?.original === 'string'
        && digest(await client.download(fighter.sources.original)) === CASUAL_IDENTITY.sourceSha256,
      'Existing original source differs; refusing to replace it.');
    }
  }
  if (!fighter) { fighter = await client.createFighter(); assertIdentity(fighter, ownerId); }
  const id = fighter.id;
  receipt.fighterId = id;
  const chosen = bundle.manifest.sprites.filter(sprite => sprite.qualityTier === 'contender');
  if (bySlug[0]?.status === 'active') {
    invariant(bySlug[0].fighterId === id && fighter.public === true, 'Active Casual identity mismatch.');
    // A completed retry preserves every source/version and refreshes only the exact roster cache.
    await verifySources(fighter, bundle, client);
    await verifySprites(fighter.spriteVersions, bundle.manifest.sprites, client);
    await verifySprites(fighter.sprites, chosen, client);
    await client.purgeArcadeCache();
    await verifyPublic(id, bundle, client);
    receipt.status = 'already-active'; checkpoint('verified-existing-public-casual'); return receipt;
  }
  let draftEstablished = false;
  let activationAttempted = false;
  try {
    await client.setArcade(id, { slug: 'casual', rank: bySlug[0]?.rank ?? 16,
      challengerLine: 'One familiar face. Every game.', defaultPersonality: 'balanced',
      reference: { kind: 'generated', license: 'Insert Player original synthetic artwork', credit: 'Insert Player (2026)' },
      generationPrompt: 'Restore the original fictional adult Casual shown in Insert Player presentation films, using the exact published source photo. Preserve his face, grey hoodie, dark grey trousers and brown boots. Use authentic ordinary Rookie and Champion generation outputs for every Fight, Rush and Aura move; never substitute another identity or fabricate quality.',
      status: 'draft' });
    draftEstablished = true; receipt.status = 'draft'; checkpoint('draft-established');
    fighter = await client.getFighter(id); assertIdentity(fighter, ownerId);
    invariant(fighter.public === false, 'Casual became public before staging.');
    for (const source of bundle.manifest.sources) {
      // The exact existing original is immutable; never resend or repoint it.
      if (source.kind === 'original' && fighter.sources?.original) continue;
      await client.uploadSource(id, source, bundle.files.get(source.path));
    }
    fighter = await client.getFighter(id);
    await verifySources(fighter, bundle, client); checkpoint('canonical-sources-verified');
    for (const sprite of bundle.manifest.sprites) {
      const existing = fighter.spriteVersions?.filter(actual => matchesSprite(actual, sprite)) ?? [];
      if (existing.length === 1) {
        try { await verifySprites(existing, [sprite], client); continue; }
        catch { /* Retry the idempotent upload to repair a missing archived R2 object. */ }
      }
      await client.uploadSprite(id, sprite, bundle.files.get(sprite.path), bundle.files.get(sprite.rawPath));
    }
    fighter = await client.getFighter(id); assertIdentity(fighter, ownerId);
    invariant(fighter.public === false, 'Casual became public during staging.');
    await verifySprites(fighter.spriteVersions, bundle.manifest.sprites, client); checkpoint('all-34-versions-verified');
    for (const sprite of chosen) await client.promoteSprite(id, sprite);
    fighter = await client.getFighter(id); assertIdentity(fighter, ownerId);
    invariant(fighter.public === false && fighter.qualityTier === 'contender', 'Casual current tier changed before activation.');
    await verifySources(fighter, bundle, client);
    await verifySprites(fighter.sprites, chosen, client); checkpoint('complete-champion-packs-verified');
    activationAttempted = true;
    await client.setArcade(id, { status: 'active' });
    await client.purgeArcadeCache(); checkpoint('canonical-roster-cache-purged');
    await verifyPublic(id, bundle, client);
    receipt.status = 'active'; checkpoint('public-fight-rush-aura-verified');
    return receipt;
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = error instanceof Error ? error.message : 'Casual import failed.';
    if (draftEstablished) {
      try { await client.setArcade(id, { status: 'draft' }); receipt.leftInDraft = true; }
      catch { receipt.leftInDraft = false; }
      try { await client.purgeArcadeCache(); receipt.rollbackCachePurged = true; }
      catch { receipt.rollbackCachePurged = false; }
    }
    receipt.activationAttempted = activationAttempted;
    checkpoint('failed-with-assets-preserved');
    const failure = new Error(receipt.error, { cause: error }); failure.importReceipt = receipt; throw failure;
  }
}

function writeReceipt(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); renameSync(temporary, path);
}

export async function runCasualImportCli(args, { env = process.env, stdout = text => process.stdout.write(text),
  validate = validateCasualManifest, guard = assertProductionDeployAllowed, createTokenProvider = createAdminTokenProviderFromEnv,
  createClient = createCasualApiClient } = {}) {
  const arg = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const allowed = ['manifest', 'manifest-sha256', 'confirm', 'expected-deployed-sha', 'receipt'];
  invariant(args.every(value => value === '--execute' || allowed.some(name => value.startsWith(`--${name}=`))), 'Unsupported import argument.');
  invariant(arg('manifest'), '--manifest is required.');
  const bundle = validate(arg('manifest'), arg('manifest-sha256'));
  const plan = { identity: CASUAL_IDENTITY, manifestSha256: bundle.manifestSha256, sourceCount: 7, versionCount: 34,
    publicTier: 'contender', providerCalls: 0, deletions: 0 };
  if (!args.includes('--execute')) { stdout(`${JSON.stringify(plan, null, 2)}\n`); return plan; }
  invariant(arg('confirm') === CONFIRMATION, `Execution requires --confirm=${CONFIRMATION}.`);
  invariant(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'Casual production imports run only in the main GitHub Actions workflow.');
  const context = guard({ env });
  const expectedSha = arg('expected-deployed-sha') ?? env.GITHUB_SHA;
  invariant(context.gitSha === expectedSha && env.GITHUB_SHA === expectedSha, 'Import SHA does not match the clean main checkout.');
  invariant((env.ASF_WORKER_URL ?? ORIGIN) === ORIGIN, 'Production API origin mismatch.');
  invariant(arg('receipt'), '--receipt is required for execution.');
  const tokenProvider = await createTokenProvider(env);
  const client = createClient({ tokenProvider, backendAuthBridgeSecret: env.CLERK_BACKEND_AUTH_BRIDGE_SECRET,
    cloudflareApiToken: env.CLOUDFLARE_API_TOKEN, cloudflareZoneId: env.ASF_CLOUDFLARE_ZONE_ID, baseUrl: ORIGIN });
  const receiptPath = resolve(arg('receipt'));
  const receipt = await executeCasualImport({ bundle, client, ownerId: tokenProvider.userId, expectedSha,
    onCheckpoint: checkpoint => writeReceipt(receiptPath, checkpoint) });
  stdout(`${JSON.stringify({ receiptPath, ...receipt }, null, 2)}\n`);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCasualImportCli(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
