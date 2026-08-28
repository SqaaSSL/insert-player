import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authenticatedAssetClient,
  authenticatedRequestClient,
  createAdminTokenProvider,
} from './import-reviewed-xai-canonical-bundle.mjs';
import { inspectPng } from './arcade-xai-canonical-bundle.mjs';
import {
  REVIEWED_CANONICAL_SOURCE_MODE,
  assertReviewGatedVideoDraft,
  assertReviewedCanonicalManifest,
  validateManifest,
} from './seed-arcade-roster.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_DESCRIPTOR_PATH = join(root, 'arcade/reviewed-manual-canonical/rosalia-v2.json');
const DEFAULT_ROSTER_PATH = join(root, 'arcade/roster-2026.json');
const DEFAULT_WRANGLER_CLI_PATH = join(root, 'worker/node_modules/wrangler/bin/wrangler.js');
const DEFAULT_WRANGLER_CONFIG_PATH = join(root, 'worker/wrangler.toml');
const MAX_PNG_BYTES = 12 * 1024 * 1024;

export const REVIEWED_MANUAL_CANONICAL_IMPORT_CONFIRMATION =
  'IMPORT_REVIEWED_MANUAL_CANONICAL_SET_PRODUCTION_V1';
export const REVIEWED_MANUAL_CANONICAL_QA_DECISION =
  'APPROVE_REVIEWED_MANUAL_CANONICAL_SET_V1';
export const REVIEWED_MANUAL_CANONICAL_SAFETY_CONFIRMATION =
  'SOURCES_ONLY_NO_PROVIDER_NO_GENERATION_NO_ACTIVATION';
export const INSERT_PLAYER_PRODUCTION_WORKER_ORIGIN = 'https://api.insertplayer.ai';
export const REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS = Object.freeze([
  'side',
  'side_raw',
  'upright',
  'upright_raw',
  'crouch',
  'crouch_raw',
]);

const SOURCE_NAMES = Object.freeze(['side', 'upright', 'crouch']);
const RESPONSE_KEYS = Object.freeze({
  side: 'side',
  side_raw: 'sideRaw',
  upright: 'upright',
  upright_raw: 'uprightRaw',
  crouch: 'crouch',
  crouch_raw: 'crouchRaw',
});
const EXPECTED_FIGHTER = Object.freeze({
  slug: 'rosalia-v2',
  name: 'Rosalía V2',
  photoHash: '1ac0e6562015961764579ec168ba1091c1059c217ba7484616d1ce3fcab12dac',
});
const EXPECTED_R2 = Object.freeze({
  bucket: 'insert-player-assets',
  jurisdiction: 'eu',
  prefix: 'official-roster-canonical-inputs/rosalia-v2',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not a sealed object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} keys are not exact.`);
  }
}

function requireString(value, label, pattern) {
  if (typeof value !== 'string' || !value || (pattern && !pattern.test(value))) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is invalid JSON.`);
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${label} is missing or invalid JSON.`);
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.writing-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function validateReviewedManualCanonicalDescriptor(descriptor) {
  exactKeys(descriptor, [
    'schemaVersion',
    'descriptorType',
    'status',
    'fighter',
    'r2',
    'review',
    'sources',
    'safety',
  ], 'reviewed manual canonical descriptor');
  if (
    descriptor.schemaVersion !== 1
    || descriptor.descriptorType !== 'reviewed_manual_canonical_set_v1'
    || descriptor.status !== 'approved'
  ) {
    throw new Error('Reviewed manual canonical descriptor schema or approval status is invalid.');
  }

  exactKeys(descriptor.fighter, ['slug', 'name', 'photoHash'], 'reviewed fighter');
  if (canonicalJson(descriptor.fighter) !== canonicalJson(EXPECTED_FIGHTER)) {
    throw new Error('Reviewed manual canonical descriptor is not sealed to rosalia-v2 and its licensed photo.');
  }

  exactKeys(descriptor.r2, ['bucket', 'jurisdiction', 'prefix'], 'reviewed R2 source');
  if (canonicalJson(descriptor.r2) !== canonicalJson(EXPECTED_R2)) {
    throw new Error('Reviewed manual canonical descriptor is not sealed to the exact production R2 staging prefix.');
  }

  exactKeys(descriptor.review, ['decision', 'blockingFindings'], 'manual canonical review');
  if (
    descriptor.review.decision !== REVIEWED_MANUAL_CANONICAL_QA_DECISION
    || !Array.isArray(descriptor.review.blockingFindings)
    || descriptor.review.blockingFindings.length !== 0
  ) {
    throw new Error('Manual canonical review is not an explicit unblocked approval.');
  }

  exactKeys(descriptor.sources, REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS, 'reviewed sources');
  const hashes = new Set();
  const objectKeys = new Set();
  for (const kind of REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS) {
    const source = descriptor.sources[kind];
    exactKeys(source, [
      'kind',
      'r2ObjectKey',
      'contentSha256',
      'sizeBytes',
      'width',
      'height',
      'mimeType',
    ], `${kind} reviewed source`);
    requireString(source.contentSha256, `${kind} content SHA-256`, /^[a-f0-9]{64}$/);
    const expectedObjectKey = `${EXPECTED_R2.prefix}/${kind}_${source.contentSha256}.png`;
    if (
      source.kind !== kind
      || source.r2ObjectKey !== expectedObjectKey
      || source.mimeType !== 'image/png'
      || !Number.isSafeInteger(source.sizeBytes)
      || source.sizeBytes < 24
      || source.sizeBytes > MAX_PNG_BYTES
      || !Number.isSafeInteger(source.width)
      || source.width < 64
      || source.width > 4096
      || !Number.isSafeInteger(source.height)
      || source.height < 64
      || source.height > 4096
    ) {
      throw new Error(`${kind} is not an exact bounded content-addressed PNG source.`);
    }
    hashes.add(source.contentSha256);
    objectKeys.add(source.r2ObjectKey);
  }
  if (hashes.size !== REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS.length || objectKeys.size !== hashes.size) {
    throw new Error('The reviewed manual canonical set must contain six distinct content-addressed R2 objects.');
  }

  exactKeys(descriptor.safety, [
    'providerCalls',
    'generationStarted',
    'activated',
    'allowedSourcePosts',
  ], 'reviewed manual canonical safety policy');
  if (
    descriptor.safety.providerCalls !== 0
    || descriptor.safety.generationStarted !== false
    || descriptor.safety.activated !== false
    || canonicalJson(descriptor.safety.allowedSourcePosts)
      !== canonicalJson(REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS)
  ) {
    throw new Error('Reviewed manual canonical safety policy changed.');
  }
  return descriptor;
}

function assertExactSourceBytes(bytes, source, label) {
  const inspected = inspectPng(bytes, label);
  if (
    inspected.contentSha256 !== source.contentSha256
    || inspected.sizeBytes !== source.sizeBytes
    || inspected.width !== source.width
    || inspected.height !== source.height
  ) {
    throw new Error(`${label} bytes, SHA-256, or dimensions do not match the reviewed descriptor.`);
  }
  return inspected;
}

export async function loadReviewedManualCanonicalSet(options = {}) {
  const descriptorPath = resolve(requireString(options.descriptorPath, 'reviewed descriptor path'));
  const expectedDescriptorSha256 = requireString(
    options.descriptorSha256,
    'explicit reviewed descriptor SHA-256',
    /^[a-f0-9]{64}$/,
  );
  const descriptorBytes = readFileSync(descriptorPath);
  if (sha256(descriptorBytes) !== expectedDescriptorSha256) {
    throw new Error('Reviewed manual canonical descriptor SHA-256 mismatch.');
  }
  const descriptor = validateReviewedManualCanonicalDescriptor(
    parseJsonBytes(descriptorBytes, 'reviewed manual canonical descriptor'),
  );
  if (typeof options.loadR2Object !== 'function') {
    throw new Error('An exact read-only R2 object loader is required.');
  }
  const assets = {};
  for (const kind of REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS) {
    const source = descriptor.sources[kind];
    const loaded = await options.loadR2Object(source, descriptor.r2);
    const bytes = Buffer.isBuffer(loaded)
      ? loaded
      : loaded instanceof Uint8Array
        ? Buffer.from(loaded)
        : null;
    if (!bytes) throw new Error(`${kind} R2 loader did not return immutable bytes.`);
    assertExactSourceBytes(bytes, source, `${kind} reviewed R2 object`);
    assets[kind] = { source, bytes };
  }
  return { descriptor, descriptorPath, descriptorSha256: expectedDescriptorSha256, assets };
}

export function createWranglerR2ObjectLoader(options = {}) {
  const downloadDirectory = resolve(requireString(options.downloadDirectory, 'private R2 download directory'));
  const wranglerCliPath = resolve(options.wranglerCliPath ?? DEFAULT_WRANGLER_CLI_PATH);
  const wranglerConfigPath = resolve(options.wranglerConfigPath ?? DEFAULT_WRANGLER_CONFIG_PATH);
  const bucket = options.bucket ?? EXPECTED_R2.bucket;
  const jurisdiction = options.jurisdiction ?? EXPECTED_R2.jurisdiction;
  if (bucket !== EXPECTED_R2.bucket || jurisdiction !== EXPECTED_R2.jurisdiction) {
    throw new Error('Wrangler R2 loader is not sealed to the reviewed production bucket and jurisdiction.');
  }
  if (!existsSync(wranglerCliPath) || !existsSync(wranglerConfigPath)) {
    throw new Error('Pinned Wrangler CLI or production configuration is unavailable.');
  }
  mkdirSync(downloadDirectory, { recursive: true, mode: 0o700 });
  chmodSync(downloadDirectory, 0o700);
  return async (source) => {
    const destination = join(downloadDirectory, `${source.kind}_${source.contentSha256}.png`);
    if (existsSync(destination)) {
      const current = readFileSync(destination);
      assertExactSourceBytes(current, source, `${source.kind} cached R2 object`);
      return current;
    }
    const result = spawnSync(process.execPath, [
      wranglerCliPath,
      'r2',
      'object',
      'get',
      `${bucket}/${source.r2ObjectKey}`,
      '--file',
      destination,
      '--remote',
      '--jurisdiction',
      jurisdiction,
      '--config',
      wranglerConfigPath,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      const detail = String(result.stderr || result.stdout || result.error?.message || 'unknown error')
        .trim()
        .slice(-2000);
      throw new Error(`Read-only R2 GET failed for ${source.kind}: ${detail}`);
    }
    if (!existsSync(destination)) throw new Error(`Wrangler returned no ${source.kind} R2 object.`);
    chmodSync(destination, 0o600);
    const bytes = readFileSync(destination);
    assertExactSourceBytes(bytes, source, `${source.kind} downloaded R2 object`);
    return bytes;
  };
}

export function normalizeProductionWorkerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Production Worker URL is invalid.');
  }
  if (
    url.origin !== INSERT_PLAYER_PRODUCTION_WORKER_ORIGIN
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error(`Production Worker URL must be exactly ${INSERT_PLAYER_PRODUCTION_WORKER_ORIGIN}.`);
  }
  return INSERT_PLAYER_PRODUCTION_WORKER_ORIGIN;
}

function parsePrivateSourceUrl(urlValue, fighterId, kind) {
  const url = new URL(requireString(urlValue, `${kind} private source URL`));
  if (
    url.origin !== INSERT_PLAYER_PRODUCTION_WORKER_ORIGIN
    || url.username
    || url.password
    || url.search
    || url.hash
    || !url.pathname.startsWith('/assets/')
  ) {
    throw new Error(`${kind} private source URL is outside the exact production Worker asset origin.`);
  }
  let blobKey;
  try {
    blobKey = url.pathname.slice('/assets/'.length).split('/').map(decodeURIComponent).join('/');
  } catch {
    throw new Error(`${kind} private source URL cannot be decoded.`);
  }
  const escapedKind = kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = blobKey.match(new RegExp(
    `^users/([A-Za-z0-9_-]{1,128})/fighters/${fighterId}/sources/${escapedKind}_([a-f0-9]{32})\\.png$`,
  ));
  if (!match) throw new Error(`${kind} private source is not an exact versioned fighter R2 pointer.`);
  return { path: url.pathname, blobKey, ownerUserId: match[1], versionId: match[2] };
}

async function readBoundedPngResponse(response, label) {
  if (!(response instanceof Response)) throw new Error(`${label} asset client returned no Response.`);
  if (response.status >= 300 && response.status < 400) throw new Error(`${label} asset redirect is forbidden.`);
  if (!response.ok) throw new Error(`${label} asset GET failed with HTTP ${response.status}.`);
  const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'image/png') throw new Error(`${label} asset MIME type is not image/png.`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_PNG_BYTES) throw new Error(`${label} asset exceeds the byte limit.`);
  if (!response.body) throw new Error(`${label} asset response has no body.`);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PNG_BYTES) {
      await reader.cancel();
      throw new Error(`${label} asset exceeds the streaming byte limit.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function verifyCurrentSource(fighter, kind, source, requestAsset) {
  if (fighter.sourceHashes?.[kind] !== source.contentSha256) {
    throw new Error(`${kind} current source hash does not match the reviewed source.`);
  }
  const parsed = parsePrivateSourceUrl(fighter.sources?.[RESPONSE_KEYS[kind]], fighter.id, kind);
  const bytes = await readBoundedPngResponse(await requestAsset(parsed.path), `${kind} current source`);
  assertExactSourceBytes(bytes, source, `${kind} current archived source`);
  return {
    versionId: parsed.versionId,
    blobKey: parsed.blobKey,
    contentSha256: source.contentSha256,
    sizeBytes: source.sizeBytes,
    width: source.width,
    height: source.height,
    r2BytesVerifiedVia: 'authenticated_worker_asset_get_v1',
    ownerUserId: parsed.ownerUserId,
  };
}

function assertNoUnreviewedCurrentSources(fighter, descriptor) {
  for (const kind of REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS) {
    const hash = fighter.sourceHashes?.[kind] ?? null;
    const pointer = fighter.sources?.[RESPONSE_KEYS[kind]] ?? null;
    if ((hash === null) !== (pointer === null)) {
      throw new Error(`${kind} has inconsistent current pointer/hash lineage.`);
    }
    if (hash !== null && hash !== descriptor.sources[kind].contentSha256) {
      throw new Error(`${kind} already contains a different source; reviewed manual import will not overwrite it.`);
    }
  }
}

function initialState(descriptorSha256, descriptor, fighterId) {
  return {
    schemaVersion: 1,
    status: 'importing',
    descriptorSha256,
    slug: descriptor.fighter.slug,
    fighterId,
    photoHash: descriptor.fighter.photoHash,
    qaDecision: REVIEWED_MANUAL_CANONICAL_QA_DECISION,
    safetyConfirmation: REVIEWED_MANUAL_CANONICAL_SAFETY_CONFIRMATION,
    allowedKinds: [...REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS],
    uploads: {},
  };
}

function validateState(state, expected) {
  exactKeys(state, state.status === 'completed'
    ? [...Object.keys(expected), 'operatorManifestSha256', 'reviewedManifestSha256']
    : Object.keys(expected), 'reviewed manual import checkpoint');
  if (!['importing', 'completed'].includes(state.status)) {
    throw new Error('Reviewed manual import checkpoint status is invalid.');
  }
  for (const key of [
    'schemaVersion',
    'descriptorSha256',
    'slug',
    'fighterId',
    'photoHash',
    'qaDecision',
    'safetyConfirmation',
  ]) {
    if (state[key] !== expected[key]) throw new Error(`Reviewed manual import checkpoint mismatch: ${key}.`);
  }
  if (canonicalJson(state.allowedKinds) !== canonicalJson(expected.allowedKinds)) {
    throw new Error('Reviewed manual import checkpoint allowed source kinds changed.');
  }
  if (!state.uploads || typeof state.uploads !== 'object' || Array.isArray(state.uploads)) {
    throw new Error('Reviewed manual import checkpoint uploads are invalid.');
  }
  if (Object.keys(state.uploads).some((kind) => !REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS.includes(kind))) {
    throw new Error('Reviewed manual import checkpoint contains an unauthorized source kind.');
  }
  for (const [kind, upload] of Object.entries(state.uploads)) {
    exactKeys(upload, upload.error
      ? ['status', 'expectedSha256', 'error']
      : ['status', 'expectedSha256'], `${kind} reviewed manual checkpoint`);
    if (
      !['uploading', 'outcome_unknown', 'verified', 'verified_existing', 'reconciled'].includes(upload.status)
      || !/^[a-f0-9]{64}$/.test(upload.expectedSha256 ?? '')
      || (upload.error !== undefined && typeof upload.error !== 'string')
    ) {
      throw new Error(`${kind} reviewed manual checkpoint is invalid.`);
    }
  }
  if (state.status === 'completed' && (
    !/^[a-f0-9]{64}$/.test(state.operatorManifestSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(state.reviewedManifestSha256 ?? '')
  )) {
    throw new Error('Completed reviewed manual checkpoint hashes are invalid.');
  }
  return state;
}

function acquireLock(statePath) {
  const path = `${statePath}.lock`;
  const nonce = randomUUID();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('Reviewed manual import lock exists and requires operator reconciliation.');
    }
    throw error;
  }
  writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, nonce, statePath })}\n`);
  fsyncSync(descriptor);
  return { path, nonce, descriptor };
}

function releaseLock(lock) {
  closeSync(lock.descriptor);
  const current = readJson(lock.path, 'reviewed manual import lock');
  if (current.nonce !== lock.nonce) throw new Error('Reviewed manual import lock ownership changed.');
  unlinkSync(lock.path);
}

async function uploadSource(requestApi, fighterId, kind, bytes) {
  const form = new FormData();
  form.set('kind', kind);
  form.set('file', new Blob([bytes], { type: 'image/png' }), `${kind}.png`);
  return requestApi(`/api/fighters/${encodeURIComponent(fighterId)}/sources`, {
    method: 'POST',
    body: form,
  });
}

function reviewedCurrentManifest(descriptor, fighterId) {
  return assertReviewedCanonicalManifest({
    schemaVersion: 1,
    canonicalSourceMode: REVIEWED_CANONICAL_SOURCE_MODE,
    slug: descriptor.fighter.slug,
    fighterId,
    photoHash: descriptor.fighter.photoHash,
    canonicalSourceHashes: Object.fromEntries(SOURCE_NAMES.map((sourceName) => [sourceName, {
      processedSha256: descriptor.sources[sourceName].contentSha256,
      rawSha256: descriptor.sources[`${sourceName}_raw`].contentSha256,
    }])),
  }, {
    slug: descriptor.fighter.slug,
    fighterId,
    photoHash: descriptor.fighter.photoHash,
  });
}

export async function runReviewedManualCanonicalImport(options = {}) {
  if (options.confirmation !== REVIEWED_MANUAL_CANONICAL_IMPORT_CONFIRMATION) {
    throw new Error(`Import requires confirmation ${REVIEWED_MANUAL_CANONICAL_IMPORT_CONFIRMATION}.`);
  }
  if (options.qaDecision !== REVIEWED_MANUAL_CANONICAL_QA_DECISION) {
    throw new Error(`Import requires QA decision ${REVIEWED_MANUAL_CANONICAL_QA_DECISION}.`);
  }
  if (options.safetyConfirmation !== REVIEWED_MANUAL_CANONICAL_SAFETY_CONFIRMATION) {
    throw new Error(`Import requires safety confirmation ${REVIEWED_MANUAL_CANONICAL_SAFETY_CONFIRMATION}.`);
  }
  if (options.slug !== EXPECTED_FIGHTER.slug) {
    throw new Error(`Reviewed manual import is restricted to ${EXPECTED_FIGHTER.slug}.`);
  }
  const reviewedBy = requireString(options.reviewedBy, 'manual review actor');
  const reviewed = await loadReviewedManualCanonicalSet(options);
  if (reviewed.descriptor.review.decision !== options.qaDecision) {
    throw new Error('Runtime QA decision does not match the sealed reviewed descriptor.');
  }

  const roster = JSON.parse(readFileSync(options.rosterPath ?? DEFAULT_ROSTER_PATH, 'utf8'));
  validateManifest(roster);
  const matches = roster.fighters.filter((fighter) => fighter.slug === EXPECTED_FIGHTER.slug);
  if (matches.length !== 1) throw new Error('rosalia-v2 is missing or ambiguous in the reviewed roster.');
  const rosterFighter = matches[0];
  if (
    rosterFighter.name !== reviewed.descriptor.fighter.name
    || rosterFighter.reference?.sourceSha256 !== reviewed.descriptor.fighter.photoHash
  ) {
    throw new Error('Reviewed manual fighter name or licensed photo does not match the roster.');
  }

  if (typeof options.requestApi !== 'function' || typeof options.requestAsset !== 'function') {
    throw new Error('Authenticated production JSON and bounded asset clients are required.');
  }
  const loadExactDraft = async () => {
    const admin = await options.requestApi('/api/admin/arcade');
    const entries = (Array.isArray(admin?.fighters) ? admin.fighters : [])
      .filter((entry) => entry?.slug === EXPECTED_FIGHTER.slug && entry?.status !== 'retired');
    if (entries.length !== 1) {
      throw new Error('Reviewed manual import requires exactly one current rosalia-v2 Arcade draft.');
    }
    const entry = entries[0];
    const detail = await options.requestApi(`/api/fighters/${encodeURIComponent(entry.fighterId ?? '')}`);
    assertReviewGatedVideoDraft({
      manifest: roster,
      fighter: rosterFighter,
      entry,
      owned: detail?.fighter,
      approvedPhotoHash: reviewed.descriptor.fighter.photoHash,
    });
    if (!Array.isArray(detail.fighter.sprites) || detail.fighter.sprites.length !== 0) {
      throw new Error('Reviewed manual import requires the exact pre-Video draft with no sprites.');
    }
    return { entry, fighter: detail.fighter };
  };

  const assertNoGenerationJobs = async (fighterId) => {
    const listed = await options.requestApi(
      `/api/generation-jobs?fighterId=${encodeURIComponent(fighterId)}`,
    );
    if (!Array.isArray(listed?.jobs) || listed.jobs.length !== 0) {
      throw new Error('Reviewed manual import requires a draft with no generation jobs.');
    }
  };

  let { entry, fighter } = await loadExactDraft();
  const fighterId = entry.fighterId;
  await assertNoGenerationJobs(fighterId);
  const outputDirectory = resolve(requireString(options.outputDirectory, 'private import output directory'));
  const statePath = resolve(options.statePath ?? join(outputDirectory, 'import-state.json'));
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  chmodSync(outputDirectory, 0o700);
  const lock = acquireLock(statePath);
  try {
    const expectedState = initialState(reviewed.descriptorSha256, reviewed.descriptor, fighterId);
    let state = existsSync(statePath)
      ? readJson(statePath, 'reviewed manual import checkpoint')
      : expectedState;
    validateState(state, expectedState);
    const saveState = () => writeJsonAtomic(statePath, state);
    saveState();

    for (const kind of REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS) {
      ({ fighter } = await loadExactDraft());
      assertNoUnreviewedCurrentSources(fighter, reviewed.descriptor);
      const source = reviewed.descriptor.sources[kind];
      const currentHash = fighter.sourceHashes?.[kind] ?? null;
      const previous = state.uploads[kind] ?? null;
      if (previous && previous.expectedSha256 !== source.contentSha256) {
        throw new Error(`${kind} checkpoint hash changed.`);
      }
      if (currentHash === source.contentSha256) {
        await verifyCurrentSource(fighter, kind, source, options.requestAsset);
        state.uploads[kind] = {
          status: previous && ['uploading', 'outcome_unknown'].includes(previous.status)
            ? 'reconciled'
            : previous?.status === 'verified'
              ? 'verified'
              : 'verified_existing',
          expectedSha256: source.contentSha256,
        };
        saveState();
        continue;
      }
      if (currentHash !== null || fighter.sources?.[RESPONSE_KEYS[kind]] != null) {
        throw new Error(`${kind} contains an unreviewed source and will not be overwritten.`);
      }
      if (previous && ['uploading', 'outcome_unknown'].includes(previous.status)) {
        throw new Error(`${kind} has an ambiguous prior POST and cannot be re-POSTed automatically.`);
      }
      if (previous) {
        throw new Error(`${kind} checkpoint says verified but its exact current source is missing.`);
      }
      state.uploads[kind] = { status: 'uploading', expectedSha256: source.contentSha256 };
      saveState();
      try {
        await uploadSource(options.requestApi, fighterId, kind, reviewed.assets[kind].bytes);
      } catch (error) {
        try {
          ({ fighter } = await loadExactDraft());
          assertNoUnreviewedCurrentSources(fighter, reviewed.descriptor);
          if (fighter.sourceHashes?.[kind] === source.contentSha256) {
            await verifyCurrentSource(fighter, kind, source, options.requestAsset);
            state.uploads[kind] = { status: 'reconciled', expectedSha256: source.contentSha256 };
            saveState();
            continue;
          }
        } catch {
          // Preserve the original POST uncertainty below; a later run may reconcile by exact hash.
        }
        state.uploads[kind] = {
          status: 'outcome_unknown',
          expectedSha256: source.contentSha256,
          error: error instanceof Error ? error.message : String(error),
        };
        saveState();
        throw new Error(`${kind} POST outcome is unknown; automatic re-POST is forbidden.`);
      }
      ({ fighter } = await loadExactDraft());
      assertNoUnreviewedCurrentSources(fighter, reviewed.descriptor);
      if (fighter.sourceHashes?.[kind] !== source.contentSha256) {
        state.uploads[kind] = { status: 'outcome_unknown', expectedSha256: source.contentSha256 };
        saveState();
        throw new Error(`${kind} did not become the exact reviewed current source.`);
      }
      await verifyCurrentSource(fighter, kind, source, options.requestAsset);
      state.uploads[kind] = { status: 'verified', expectedSha256: source.contentSha256 };
      saveState();
    }

    ({ fighter } = await loadExactDraft());
    await assertNoGenerationJobs(fighterId);
    assertNoUnreviewedCurrentSources(fighter, reviewed.descriptor);
    const currentSources = {};
    const ownerUserIds = new Set();
    const currentBlobKeys = new Set();
    for (const kind of REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS) {
      const record = await verifyCurrentSource(
        fighter,
        kind,
        reviewed.descriptor.sources[kind],
        options.requestAsset,
      );
      currentSources[kind] = record;
      ownerUserIds.add(record.ownerUserId);
      currentBlobKeys.add(record.blobKey);
    }
    if (ownerUserIds.size !== 1 || currentBlobKeys.size !== REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS.length) {
      throw new Error('Final reviewed sources do not share one owner and six distinct versioned R2 pointers.');
    }

    const reviewedManifest = reviewedCurrentManifest(reviewed.descriptor, fighterId);
    const reviewedManifestSha256 = sha256(canonicalJson(reviewedManifest));
    const operatorUnsigned = {
      schemaVersion: 1,
      manifestType: 'reviewed_manual_canonical_operator_manifest_v1',
      status: 'completed_sources_only',
      descriptorSha256: reviewed.descriptorSha256,
      fighter: { ...reviewed.descriptor.fighter, fighterId },
      reviewedBy,
      review: reviewed.descriptor.review,
      staging: reviewed.descriptor.r2,
      sources: Object.fromEntries(REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS.map((kind) => [kind, {
        reviewedInput: reviewed.descriptor.sources[kind],
        current: currentSources[kind],
      }])),
      reviewedCurrentManifest: reviewedManifest,
      reviewedCurrentManifestSha256: reviewedManifestSha256,
      safety: {
        providerCalls: 0,
        generationStarted: false,
        approvedAutomatically: false,
        activated: false,
        preexistingSourcesOverwritten: false,
        allowedSourcePosts: [...REVIEWED_MANUAL_CANONICAL_SOURCE_KINDS],
        sourceMutationResults: state.uploads,
      },
    };
    const operatorManifest = {
      ...operatorUnsigned,
      operatorManifestSha256: sha256(canonicalJson(operatorUnsigned)),
    };
    writeJsonAtomic(join(outputDirectory, 'reviewed-canonical-operator-manifest.json'), operatorManifest);
    writeJsonAtomic(join(outputDirectory, 'reviewed-canonical-manifest.json'), reviewedManifest);
    const receipt = {
      schemaVersion: 1,
      receiptType: 'reviewed_manual_canonical_source_import_v1',
      status: 'completed_sources_only',
      descriptorSha256: reviewed.descriptorSha256,
      slug: reviewed.descriptor.fighter.slug,
      fighterId,
      photoHash: reviewed.descriptor.fighter.photoHash,
      qaDecision: REVIEWED_MANUAL_CANONICAL_QA_DECISION,
      safetyConfirmation: REVIEWED_MANUAL_CANONICAL_SAFETY_CONFIRMATION,
      reviewedBy,
      operatorManifestSha256: operatorManifest.operatorManifestSha256,
      reviewedManifestSha256,
      providerCalls: 0,
      generationStarted: false,
      approvedAutomatically: false,
      activated: false,
    };
    writeJsonAtomic(join(outputDirectory, 'import-receipt.json'), receipt);
    state.status = 'completed';
    state.operatorManifestSha256 = operatorManifest.operatorManifestSha256;
    state.reviewedManifestSha256 = reviewedManifestSha256;
    saveState();
    return { state, receipt, operatorManifest, reviewedManifest, outputDirectory };
  } finally {
    releaseLock(lock);
  }
}

function parseArg(args, name, fallback = '') {
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--execute-production')) {
    throw new Error('Reviewed manual canonical import requires --execute-production.');
  }
  if (!process.env.CLOUDFLARE_API_TOKEN?.trim() || !process.env.CLOUDFLARE_ACCOUNT_ID?.trim()) {
    throw new Error('Read-only production R2 credentials are incomplete.');
  }
  const clerkSecret = process.env.ASF_ARCADE_CLERK_SECRET_KEY?.trim() ?? '';
  const clerkUserId = process.env.ASF_ARCADE_ADMIN_CLERK_USER_ID?.trim() ?? '';
  const bridgeSecret = process.env.CLERK_BACKEND_AUTH_BRIDGE_SECRET?.trim() ?? '';
  if (!clerkSecret || !clerkUserId || bridgeSecret.length < 32) {
    throw new Error('Production Clerk admin secrets are incomplete.');
  }
  const workerUrl = normalizeProductionWorkerUrl(
    process.env.ASF_WORKER_URL?.trim() || INSERT_PLAYER_PRODUCTION_WORKER_ORIGIN,
  );
  let tokenProviderPromise;
  const getToken = async () => {
    tokenProviderPromise ??= createAdminTokenProvider(clerkSecret, clerkUserId);
    return (await tokenProviderPromise)();
  };
  const outputDirectory = resolve(requireString(parseArg(args, '--output-dir'), 'private import output directory'));
  const result = await runReviewedManualCanonicalImport({
    confirmation: parseArg(args, '--confirm'),
    qaDecision: parseArg(args, '--qa-decision'),
    safetyConfirmation: parseArg(args, '--confirm-safety'),
    slug: parseArg(args, '--slug'),
    reviewedBy: parseArg(args, '--reviewed-by'),
    descriptorPath: parseArg(args, '--descriptor', DEFAULT_DESCRIPTOR_PATH),
    descriptorSha256: parseArg(args, '--descriptor-sha256'),
    rosterPath: parseArg(args, '--roster', DEFAULT_ROSTER_PATH),
    outputDirectory,
    statePath: parseArg(args, '--state', join(outputDirectory, 'import-state.json')),
    loadR2Object: createWranglerR2ObjectLoader({
      downloadDirectory: parseArg(args, '--r2-download-dir'),
      wranglerCliPath: parseArg(args, '--wrangler-cli', DEFAULT_WRANGLER_CLI_PATH),
      wranglerConfigPath: parseArg(args, '--wrangler-config', DEFAULT_WRANGLER_CONFIG_PATH),
    }),
    requestApi: authenticatedRequestClient(workerUrl, getToken, bridgeSecret),
    requestAsset: authenticatedAssetClient(workerUrl, getToken, bridgeSecret),
  });
  console.log(
    `Reviewed manual canonical sources imported for ${result.reviewedManifest.slug}; providerCalls=0, generationStarted=false, activated=false.`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
