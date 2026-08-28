import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_ORIGIN = 'https://api.insertplayer.ai';
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ACTIONS = new Set([
  'idle', 'walk', 'high_punch', 'high_kick', 'low_punch', 'low_kick',
  'jump', 'crouch', 'hit', 'ko', 'victory',
]);
const CONFIRMATIONS = Object.freeze({
  stage: 'STAGE_IMPORTED_GLOBAL_VIDEO_RECURATION_PRODUCTION',
  promote: 'PROMOTE_IMPORTED_GLOBAL_VIDEO_RECURATION_PRODUCTION',
  rollback: 'ROLLBACK_IMPORTED_GLOBAL_VIDEO_RECURATION_PRODUCTION',
});
const SOURCE_KIND = 'imported-global-video-recuration-source-v1';
const DESCRIPTOR_KIND = 'imported-global-video-recuration-v1';
const RECEIPT_KIND = 'imported-global-video-recuration-transition-v1';
const ASSET_DEFINITIONS = Object.freeze({
  runtime: ['runtime.png', 'image/png'],
  raw: ['raw.png', 'image/png'],
  contactSheet: ['contact-sheet.png', 'image/png'],
  uniqueSheet: ['unique-sheet.png', 'image/png'],
  report: ['report.json', 'application/json'],
  video: ['video.mp4', 'video/mp4'],
  canonical: ['canonical.png', 'image/png'],
  evidence: ['evidence.json', 'application/json'],
});

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function exactSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function exactId(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

function exactWorkerSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

function exactArray(value) {
  return Array.isArray(value) && value.length >= 2 && value.length <= 12 &&
    value.every((entry, index) => Number.isSafeInteger(entry) && entry >= 0 &&
      (index === 0 || entry > value[index - 1]));
}

function exactSpriteGeometry(value, { raw = false } = {}) {
  if (
    value?.frameWidth !== 192 || value?.frameHeight !== 256 ||
    !Number.isSafeInteger(value.frameCount) || value.frameCount < 2 || value.frameCount > 64
  ) return false;
  if (!raw) return true;
  const playback = value.playback;
  return value.rawFrameWidth === 768 && value.rawFrameHeight === 1024 &&
    Array.isArray(playback) && playback.length === value.frameCount &&
    playback.every((entry) => Number.isSafeInteger(entry) && entry >= 0) &&
    Number.isSafeInteger(value.rawFrameCount) && value.rawFrameCount >= 2 &&
    value.rawFrameCount <= 12 && value.rawFrameCount === Math.max(...playback) + 1;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertDirectFile(path, maximumBytes = MAX_JSON_BYTES) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximumBytes) {
    throw new Error(`${path} must be a direct regular file from 1 to ${maximumBytes} bytes.`);
  }
}

function readExactJson(path, maximumBytes = MAX_JSON_BYTES) {
  assertDirectFile(path, maximumBytes);
  const bytes = readFileSync(path);
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object');
    return { bytes, value, digest: sha256(bytes) };
  } catch {
    throw new Error(`${path} is not a JSON object.`);
  }
}

function parseArgs(argv) {
  const allowedFlags = new Set(['accept-needs-review']);
  const values = new Map();
  const flags = new Set();
  for (const arg of argv) {
    if (!arg.startsWith('--')) throw new Error(`Unexpected positional argument: ${arg}`);
    const separator = arg.indexOf('=');
    if (separator === -1) {
      const name = arg.slice(2);
      if (!allowedFlags.has(name) || flags.has(name)) throw new Error(`Unknown or duplicate flag: --${name}`);
      flags.add(name);
      continue;
    }
    const name = arg.slice(2, separator);
    const value = arg.slice(separator + 1);
    if (!name || !value || values.has(name)) throw new Error(`Invalid or duplicate argument: --${name}`);
    values.set(name, value);
  }
  return { values, flags };
}

function readEnvValues() {
  const values = new Map();
  for (const filename of ['.env.production.local', '.env.production', '.env.local', '.env']) {
    const path = join(ROOT, filename);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && value && !values.has(key)) values.set(key, value);
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && value) values.set(key, value);
  }
  return values;
}

function jwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Clerk did not return a JWT.');
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Clerk returned an invalid JWT payload.');
  }
}

async function clerkJson(secret, path, init = {}) {
  const response = await fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Clerk ${init.method ?? 'GET'} ${path} returned non-JSON (${response.status}).`);
  }
  if (!response.ok) throw new Error(`Clerk ${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}.`);
  return body;
}

async function createAdminToken(secret, userId) {
  const query = new URLSearchParams({ user_id: userId, status: 'active', limit: '20' });
  const listed = await clerkJson(secret, `/sessions?${query}`);
  const sessions = Array.isArray(listed.data) ? listed.data : Array.isArray(listed) ? listed : [];
  const session = sessions.find((entry) => entry?.user_id === userId && entry?.status === 'active');
  if (!session?.id) throw new Error('The configured Arcade admin has no active Clerk session.');
  const created = await clerkJson(secret, `/sessions/${encodeURIComponent(session.id)}/tokens`, {
    method: 'POST',
    body: JSON.stringify({ expires_in_seconds: 600 }),
  });
  if (typeof created.jwt !== 'string' || jwtPayload(created.jwt).sub !== userId) {
    throw new Error('Clerk returned a token for a different Arcade admin.');
  }
  return created.jwt;
}

function adminHeaders(context, body = false) {
  return {
    Authorization: `Bearer ${context.token}`,
    'X-Insert-Player-Admin-Seed': 'clerk-backend',
    'X-Insert-Player-Expected-Worker-Sha': context.expectedWorkerSha,
    ...(context.bridgeSecret ? { 'X-Insert-Player-Clerk-Backend-Auth': context.bridgeSecret } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function apiJson(context, path, init = {}) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) throw new Error('Untrusted API path.');
  const response = await fetch(`${API_ORIGIN}${path}`, {
    ...init,
    headers: { ...adminHeaders(context, Boolean(init.body)), ...(init.headers ?? {}) },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${init.method ?? 'GET'} ${path} returned non-JSON (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed (${response.status}): ${body?.error ?? 'unknown error'}`);
  }
  return body;
}

function responseDigest(headers) {
  const etag = headers.get('ETag');
  const etagMatch = etag === null ? null : /^(?:W\/)?"([a-f0-9]{64})"$/.exec(etag);
  const contentSha = headers.get('X-Content-SHA256');
  if (etag !== null && !etagMatch) throw new Error('Asset returned a malformed ETag.');
  if (contentSha !== null && !exactSha(contentSha)) throw new Error('Asset returned a malformed content SHA.');
  if (etagMatch?.[1] && contentSha && etagMatch[1] !== contentSha) {
    throw new Error('Asset returned conflicting integrity headers.');
  }
  const digest = contentSha ?? etagMatch?.[1];
  if (!digest) throw new Error('Asset returned no SHA-256 integrity header.');
  return digest;
}

async function apiAsset(context, path) {
  if (typeof path !== 'string' || !/^\/api\/admin\/arcade\/[a-f0-9]{32}\//.test(path)) {
    throw new Error('Untrusted imported-recuration asset path.');
  }
  const response = await fetch(`${API_ORIGIN}${path}`, {
    headers: adminHeaders(context),
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GET ${path} failed with HTTP ${response.status}.`);
  const declaredLength = Number(response.headers.get('Content-Length') ?? 0);
  if (declaredLength > MAX_ASSET_BYTES) throw new Error('Private asset exceeds the byte limit.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_ASSET_BYTES) {
    throw new Error('Private asset is empty or oversized.');
  }
  const digest = sha256(bytes);
  if (responseDigest(response.headers) !== digest) throw new Error('Private asset failed byte integrity.');
  return {
    bytes,
    digest,
    contentType: response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '',
  };
}

async function pinWorker(expectedSha) {
  if (!exactWorkerSha(expectedSha)) throw new Error('A full lowercase deployed Worker SHA is required.');
  const response = await fetch(`${API_ORIGIN}/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Worker health failed with HTTP ${response.status}.`);
  const health = await response.json();
  const tag = new RegExp(`^prod-${expectedSha}-[1-9][0-9]*$`);
  if (
    health?.status !== 'ok' || health.environment !== 'production' ||
    health.storage?.d1 !== 'bound' || health.storage?.r2 !== 'bound' ||
    typeof health.workerVersion?.id !== 'string' || !health.workerVersion.id ||
    typeof health.workerVersion?.tag !== 'string' || !tag.test(health.workerVersion.tag)
  ) throw new Error(`Live Worker is not the exact healthy deployment for ${expectedSha}.`);
  return health.workerVersion;
}

export function assertSourceBinding(value) {
  if (!exactKeys(value, [
    'schemaVersion', 'kind', 'target', 'fighter', 'action', 'current',
    'canonical', 'source', 'selectedVideoIndices',
  ])) throw new Error('Source binding has an unexpected schema.');
  if (
    value.schemaVersion !== 1 || value.kind !== SOURCE_KIND || value.target !== 'production' ||
    !exactKeys(value.fighter, ['slug', 'fighterId']) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.fighter.slug ?? '') ||
    !exactId(value.fighter.fighterId) || !ACTIONS.has(value.action) ||
    !exactKeys(value.current, [
      'spriteId', 'processedSha256', 'rawSha256', 'frameWidth', 'frameHeight',
      'frameCount', 'animationFormat', 'processingVersion',
    ]) || typeof value.current.spriteId !== 'string' || !value.current.spriteId ||
    !exactSha(value.current.processedSha256) || !exactSha(value.current.rawSha256) ||
    value.current.frameWidth !== 192 || value.current.frameHeight !== 256 ||
    !Number.isInteger(value.current.frameCount) || value.current.frameCount < 2 ||
    value.current.frameCount > 64 || value.current.animationFormat !== 'video-dense-v1' ||
    !Number.isInteger(value.current.processingVersion) || value.current.processingVersion < 0 ||
    value.current.processingVersion > 100 ||
    !exactKeys(value.canonical, ['kind', 'sha256']) ||
    !['side_raw', 'upright_raw', 'crouch_raw'].includes(value.canonical.kind) ||
    !exactSha(value.canonical.sha256) ||
    !exactKeys(value.source, [
      'url', 'sha256', 'sizeBytes', 'provider', 'modelId', 'providerEndpoint',
      'pixcliJobId', 'providerRequestId', 'promptSha256',
      'providerRequestAuditSha256', 'providerResponseSha256',
    ]) || typeof value.source.url !== 'string' || !value.source.url.startsWith('https://') ||
    !exactSha(value.source.sha256) || !Number.isInteger(value.source.sizeBytes) ||
    value.source.sizeBytes < 12 || value.source.sizeBytes > 16 * 1024 * 1024 ||
    value.source.provider !== 'fal' || value.source.modelId !== 'grok-imagine-i2v-pinned' ||
    value.source.providerEndpoint !== 'xai/grok-imagine-video/v1.5/image-to-video' ||
    !exactId(value.source.pixcliJobId) || typeof value.source.providerRequestId !== 'string' ||
    value.source.providerRequestId.length < 8 || value.source.providerRequestId.length > 200 ||
    !exactSha(value.source.promptSha256) || !exactSha(value.source.providerRequestAuditSha256) ||
    !exactSha(value.source.providerResponseSha256) || !exactArray(value.selectedVideoIndices)
  ) throw new Error('Source binding contains invalid exact identities.');
  const url = new URL(value.source.url);
  if (
    url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    (url.port && url.port !== '443') ||
    !(url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media'))
  ) throw new Error('Source binding URL is outside the fal.media allowlist.');
  return value;
}

async function resolveExactCurrent(context, binding) {
  const admin = await apiJson(context, '/api/admin/arcade');
  const matches = (Array.isArray(admin.fighters) ? admin.fighters : []).filter(
    (entry) => entry?.slug === binding.fighter.slug,
  );
  const entry = matches[0];
  if (
    matches.length !== 1 || entry.fighterId !== binding.fighter.fighterId ||
    entry.status !== 'active' || entry.public !== true || entry.qualityTier !== 'champion'
  ) throw new Error('Source binding no longer identifies one active public Champion global.');
  const detail = await apiJson(context, `/api/fighters/${binding.fighter.fighterId}`);
  const fighter = detail.fighter;
  if (
    !fighter || fighter.id !== binding.fighter.fighterId || fighter.public !== true ||
    fighter.qualityTier !== 'champion' || fighter.sourceHashes?.[binding.canonical.kind] !== binding.canonical.sha256
  ) throw new Error('Private fighter or canonical binding changed before stage.');
  const currentMatches = (Array.isArray(fighter.sprites) ? fighter.sprites : []).filter((sprite) =>
    sprite.animationName === binding.action && sprite.qualityTier === 'champion');
  const current = currentMatches[0];
  const expected = binding.current;
  if (
    currentMatches.length !== 1 || current.id !== expected.spriteId ||
    current.contentHash !== expected.processedSha256 || current.rawContentHash !== expected.rawSha256 ||
    current.frameWidth !== expected.frameWidth || current.frameHeight !== expected.frameHeight ||
    current.frameCount !== expected.frameCount || current.animationFormat !== expected.animationFormat ||
    current.processingVersion !== expected.processingVersion
  ) throw new Error('Current Champion sprite changed from the source binding.');
  const versions = (Array.isArray(fighter.spriteVersions) ? fighter.spriteVersions : []).filter((version) =>
    version.animationName === binding.action && version.qualityTier === 'champion' &&
    version.contentHash === expected.processedSha256 && version.rawContentHash === expected.rawSha256 &&
    version.frameWidth === expected.frameWidth && version.frameHeight === expected.frameHeight &&
    version.frameCount === expected.frameCount && version.animationFormat === expected.animationFormat &&
    version.processingVersion === expected.processingVersion);
  if (versions.length !== 1 || typeof versions[0].id !== 'string' || !versions[0].id) {
    throw new Error('Current sprite does not resolve to one exact immutable sprite version.');
  }
  return { fighter, current, spriteVersionId: versions[0].id };
}

function validateProposal(proposal, binding, expectedWorkerSha) {
  if (!exactKeys(proposal, [
    'proposalId', 'fighterId', 'action', 'worker', 'from', 'to', 'source',
    'evidenceSha256', 'createdAt', 'assets',
  ])) throw new Error('Stage returned an unexpected proposal schema.');
  if (
    !exactId(proposal.proposalId) || proposal.fighterId !== binding.fighter.fighterId ||
    proposal.action !== binding.action || !exactKeys(proposal.worker, ['expectedSha', 'versionId', 'versionTag']) ||
    proposal.worker.expectedSha !== expectedWorkerSha || !proposal.worker.versionId ||
    !new RegExp(`^prod-${expectedWorkerSha}-[1-9][0-9]*$`).test(proposal.worker.versionTag ?? '') ||
    !exactSha(proposal.from?.processedSha256) || !exactSha(proposal.from?.rawSha256) ||
    proposal.from.processedSha256 !== binding.current.processedSha256 ||
    proposal.from.rawSha256 !== binding.current.rawSha256 ||
    !exactSpriteGeometry(proposal.from) ||
    !exactSha(proposal.to?.processedSha256) || !exactSha(proposal.to?.rawSha256) ||
    proposal.to.processedSha256 === proposal.from.processedSha256 ||
    proposal.to.rawSha256 === proposal.from.rawSha256 || proposal.to.processingVersion !== 6 ||
    !exactSpriteGeometry(proposal.to, { raw: true }) ||
    !['technical_pass', 'needs_review'].includes(proposal.to.technicalOutcome) ||
    JSON.stringify(proposal.to.selectedVideoIndices) !== JSON.stringify(binding.selectedVideoIndices) ||
    proposal.source.videoSha256 !== binding.source.sha256 ||
    proposal.source.videoSizeBytes !== binding.source.sizeBytes ||
    proposal.source.canonicalKind !== binding.canonical.kind ||
    proposal.source.canonicalSha256 !== binding.canonical.sha256 ||
    !exactSha(proposal.evidenceSha256) ||
    !exactKeys(proposal.assets, Object.keys(ASSET_DEFINITIONS))
  ) throw new Error('Stage proposal crossed its exact source/current/target binding.');
  return proposal;
}

function assertAssetBytes(bytes, contentType, label) {
  if (contentType === 'image/png' && (
    bytes.byteLength <= PNG_SIGNATURE.byteLength ||
    !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
  )) throw new Error(`${label} is not a PNG.`);
  if (contentType === 'video/mp4' && (
    bytes.byteLength < 12 || bytes.subarray(4, 8).toString('ascii') !== 'ftyp'
  )) throw new Error(`${label} is not an MP4.`);
  if (contentType === 'application/json') {
    try {
      const parsed = JSON.parse(bytes.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    } catch {
      throw new Error(`${label} is not a JSON object.`);
    }
  }
}

function emptyDirectory(path) {
  const destination = resolve(path);
  if (existsSync(destination) && readdirSync(destination).length > 0) {
    throw new Error('Export destination must be empty; sealed evidence is never overwritten.');
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  chmodSync(destination, 0o700);
  return destination;
}

async function exportStage(context, binding, bindingSha256, proposal, destination) {
  const directory = emptyDirectory(destination);
  const prefix = `/api/admin/arcade/${binding.fighter.fighterId}/imported-video-recuration/${proposal.proposalId}/assets/`;
  const metadata = {};
  for (const [name, [filename, contentType]] of Object.entries(ASSET_DEFINITIONS)) {
    const routeKind = name === 'contactSheet' ? 'contact-sheet' : name === 'uniqueSheet' ? 'unique-sheet' : name;
    const expectedPath = `${prefix}${routeKind}`;
    if (proposal.assets[name] !== expectedPath) throw new Error(`${name} route is not proposal-bound.`);
    const asset = await apiAsset(context, expectedPath);
    if (asset.contentType !== contentType) throw new Error(`${name} returned ${asset.contentType}, expected ${contentType}.`);
    assertAssetBytes(asset.bytes, contentType, name);
    writeFileSync(join(directory, filename), asset.bytes, { mode: 0o600 });
    metadata[name] = { filename, sha256: asset.digest, contentType, byteLength: asset.bytes.byteLength };
  }
  if (
    metadata.runtime.sha256 !== proposal.to.processedSha256 ||
    metadata.raw.sha256 !== proposal.to.rawSha256 ||
    metadata.report.sha256 !== proposal.to.reportContentSha256 ||
    metadata.video.sha256 !== binding.source.sha256 || metadata.video.byteLength !== binding.source.sizeBytes ||
    metadata.canonical.sha256 !== binding.canonical.sha256 ||
    metadata.evidence.sha256 !== proposal.evidenceSha256
  ) throw new Error('Downloaded evidence does not match proposal hashes.');
  const descriptor = {
    schemaVersion: 1,
    kind: DESCRIPTOR_KIND,
    target: 'production',
    expectedWorkerSha: context.expectedWorkerSha,
    sourceBindingSha256: bindingSha256,
    fighter: binding.fighter,
    action: binding.action,
    proposalId: proposal.proposalId,
    worker: proposal.worker,
    from: proposal.from,
    to: proposal.to,
    source: proposal.source,
    evidenceSha256: proposal.evidenceSha256,
    assetRoutes: proposal.assets,
    assets: metadata,
  };
  const bytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`);
  const digest = sha256(bytes);
  writeFileSync(join(directory, 'recuration-descriptor.json'), bytes, { mode: 0o600 });
  writeFileSync(join(directory, 'recuration-descriptor.sha256'), `${digest}  recuration-descriptor.json\n`, { mode: 0o600 });
  return { descriptor, descriptorSha256: digest, directory };
}

export function assertDescriptor(value, expectedSha = '') {
  if (!exactKeys(value, [
    'schemaVersion', 'kind', 'target', 'expectedWorkerSha', 'sourceBindingSha256',
    'fighter', 'action', 'proposalId', 'worker', 'from', 'to', 'source',
    'evidenceSha256', 'assetRoutes', 'assets',
  ])) throw new Error('Descriptor has an unexpected schema.');
  if (
    value.schemaVersion !== 1 || value.kind !== DESCRIPTOR_KIND || value.target !== 'production' ||
    !exactWorkerSha(value.expectedWorkerSha) || (expectedSha && value.expectedWorkerSha !== expectedSha) ||
    !exactSha(value.sourceBindingSha256) || !exactKeys(value.fighter, ['slug', 'fighterId']) ||
    !exactId(value.fighter.fighterId) || !ACTIONS.has(value.action) || !exactId(value.proposalId) ||
    value.worker?.expectedSha !== value.expectedWorkerSha || !exactSha(value.from?.processedSha256) ||
    !exactSha(value.from?.rawSha256) || !exactSpriteGeometry(value.from) ||
    !exactSha(value.to?.processedSha256) ||
    !exactSha(value.to?.rawSha256) || value.to.processingVersion !== 6 ||
    !exactSpriteGeometry(value.to, { raw: true }) ||
    !['technical_pass', 'needs_review'].includes(value.to.technicalOutcome) ||
    !exactSha(value.evidenceSha256) || !exactKeys(value.assetRoutes, Object.keys(ASSET_DEFINITIONS)) ||
    !exactKeys(value.assets, Object.keys(ASSET_DEFINITIONS))
  ) throw new Error('Descriptor exact identities are invalid.');
  for (const [name, [filename, contentType]] of Object.entries(ASSET_DEFINITIONS)) {
    const asset = value.assets[name];
    if (
      !exactKeys(asset, ['filename', 'sha256', 'contentType', 'byteLength']) ||
      asset.filename !== filename || asset.contentType !== contentType || !exactSha(asset.sha256) ||
      !Number.isInteger(asset.byteLength) || asset.byteLength < 1 || asset.byteLength > MAX_ASSET_BYTES
    ) throw new Error(`Descriptor ${name} metadata is invalid.`);
  }
  return value;
}

function verifyDescriptorBundle(descriptorPath, descriptor, descriptorSha256) {
  const directory = dirname(descriptorPath);
  const sidecar = readFileSync(join(directory, 'recuration-descriptor.sha256'), 'utf8');
  if (sidecar !== `${descriptorSha256}  recuration-descriptor.json\n`) {
    throw new Error('Descriptor SHA sidecar is not exact.');
  }
  for (const [name, [filename, contentType]] of Object.entries(ASSET_DEFINITIONS)) {
    const path = join(directory, filename);
    assertDirectFile(path, MAX_ASSET_BYTES);
    const bytes = readFileSync(path);
    const expected = descriptor.assets[name];
    if (bytes.byteLength !== expected.byteLength || sha256(bytes) !== expected.sha256) {
      throw new Error(`Descriptor ${name} bytes changed.`);
    }
    assertAssetBytes(bytes, contentType, name);
  }
}

async function fetchUrlBytes(url, headers = {}) {
  const parsed = new URL(url);
  if (parsed.origin !== API_ORIGIN || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Smoke attempted an untrusted asset URL.');
  }
  const response = await fetch(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Smoke asset failed with HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_ASSET_BYTES) throw new Error('Smoke asset size is invalid.');
  return { bytes, contentType: response.headers.get('Content-Type')?.split(';', 1)[0]?.trim() ?? '' };
}

function exactCurrentSprite(fighter, action, binding) {
  const matches = (Array.isArray(fighter?.sprites) ? fighter.sprites : []).filter(
    (sprite) => sprite?.animationName === action && sprite?.qualityTier === 'champion',
  );
  const sprite = matches[0];
  if (
    matches.length !== 1 || sprite.contentHash !== binding.processedSha256 ||
    sprite.rawContentHash !== binding.rawSha256 || sprite.processingVersion !== binding.processingVersion ||
    sprite.frameWidth !== binding.frameWidth || sprite.frameHeight !== binding.frameHeight ||
    sprite.frameCount !== binding.frameCount || sprite.animationFormat !== binding.animationFormat ||
    (binding.rawFrameWidth !== undefined && (
      sprite.rawFrameWidth !== binding.rawFrameWidth || sprite.rawFrameHeight !== binding.rawFrameHeight ||
      sprite.rawFrameCount !== binding.rawFrameCount
    ))
  ) throw new Error('Private current sprite does not match the transition target.');
  return sprite;
}

async function smokeTransition(context, descriptor, target) {
  const privateDetail = await apiJson(context, `/api/fighters/${descriptor.fighter.fighterId}`);
  const privateSprite = exactCurrentSprite(privateDetail.fighter, descriptor.action, target);
  const [runtime, raw] = await Promise.all([
    fetchUrlBytes(privateSprite.url, adminHeaders(context)),
    fetchUrlBytes(privateSprite.rawUrl, adminHeaders(context)),
  ]);
  if (sha256(runtime.bytes) !== target.processedSha256 || sha256(raw.bytes) !== target.rawSha256) {
    throw new Error('Private runtime/HQ bytes do not match the transition target.');
  }
  const publicResponse = await fetch(
    `${API_ORIGIN}/api/arcade?importedRecurationSmoke=${target.processedSha256}`,
    { headers: { 'Cache-Control': 'no-cache' }, redirect: 'error', signal: AbortSignal.timeout(30_000) },
  );
  if (!publicResponse.ok) throw new Error(`Public Arcade smoke failed (${publicResponse.status}).`);
  const publicBody = await publicResponse.json();
  const fighter = (Array.isArray(publicBody.fighters) ? publicBody.fighters : []).find(
    (entry) => entry?.id === descriptor.fighter.fighterId && entry?.arcade?.slug === descriptor.fighter.slug,
  );
  const publicMatches = (Array.isArray(fighter?.sprites) ? fighter.sprites : []).filter(
    (sprite) => sprite?.animationName === descriptor.action && sprite?.qualityTier === 'champion',
  );
  const publicSprite = publicMatches[0];
  if (
    publicMatches.length !== 1 || publicSprite.contentHash !== target.processedSha256 ||
    publicSprite.processingVersion !== target.processingVersion ||
    publicSprite.frameWidth !== target.frameWidth || publicSprite.frameHeight !== target.frameHeight ||
    publicSprite.frameCount !== target.frameCount ||
    (target.rawFrameWidth !== undefined && (
      publicSprite.hqFrameWidth !== target.rawFrameWidth ||
      publicSprite.hqFrameHeight !== target.rawFrameHeight ||
      publicSprite.hqFrameCount !== target.rawFrameCount
    )) || !publicSprite.url || !publicSprite.hqUrl
  ) throw new Error('Public Arcade roster did not expose the transition target.');
  const [publicRuntime, publicRaw] = await Promise.all([
    fetchUrlBytes(publicSprite.url), fetchUrlBytes(publicSprite.hqUrl),
  ]);
  if (sha256(publicRuntime.bytes) !== target.processedSha256 || sha256(publicRaw.bytes) !== target.rawSha256) {
    throw new Error('Public runtime/HQ bytes do not match the transition target.');
  }
}

function transitionReceipt(operation, descriptor, descriptorSha256, executingWorkerSha, result) {
  return {
    schemaVersion: 1,
    kind: RECEIPT_KIND,
    target: 'production',
    operation,
    stageWorkerSha: descriptor.expectedWorkerSha,
    executingWorkerSha,
    descriptorSha256,
    fighter: descriptor.fighter,
    action: descriptor.action,
    proposalId: descriptor.proposalId,
    transitionId: result.transitionId,
    from: operation === 'promote' ? descriptor.from : descriptor.to,
    to: operation === 'promote' ? descriptor.to : descriptor.from,
    localArcadeCachePurgeAttempted: result.localArcadeCachePurgeAttempted,
    localArcadeCacheEntryDeleted: result.localArcadeCacheEntryDeleted,
    providerCalls: 0,
  };
}

function writeReceipt(destination, receipt) {
  const directory = emptyDirectory(destination);
  const filename = receipt.operation === 'promote' ? 'promotion-receipt.json' : 'rollback-receipt.json';
  const sidecarName = `${filename}.sha256`;
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const digest = sha256(bytes);
  writeFileSync(join(directory, filename), bytes, { mode: 0o600 });
  writeFileSync(join(directory, sidecarName), `${digest}  ${filename}\n`, { mode: 0o600 });
  return { path: join(directory, filename), digest };
}

export function assertPromotionReceipt(value, descriptor, descriptorSha256) {
  if (!exactKeys(value, [
    'schemaVersion', 'kind', 'target', 'operation', 'stageWorkerSha',
    'executingWorkerSha',
    'descriptorSha256', 'fighter', 'action', 'proposalId', 'transitionId',
    'from', 'to', 'localArcadeCachePurgeAttempted',
    'localArcadeCacheEntryDeleted', 'providerCalls',
  ])) throw new Error('Promotion receipt has an unexpected schema.');
  if (
    value.schemaVersion !== 1 || value.kind !== RECEIPT_KIND || value.target !== 'production' ||
    value.operation !== 'promote' || value.stageWorkerSha !== descriptor.expectedWorkerSha ||
    value.executingWorkerSha !== descriptor.expectedWorkerSha ||
    value.descriptorSha256 !== descriptorSha256 ||
    canonicalJson(value.fighter) !== canonicalJson(descriptor.fighter) ||
    value.action !== descriptor.action || value.proposalId !== descriptor.proposalId ||
    !exactSha(value.transitionId) || typeof value.localArcadeCachePurgeAttempted !== 'boolean' ||
    typeof value.localArcadeCacheEntryDeleted !== 'boolean' || value.providerCalls !== 0 ||
    canonicalJson(value.from) !== canonicalJson(descriptor.from) ||
    canonicalJson(value.to) !== canonicalJson(descriptor.to)
  ) throw new Error('Promotion receipt does not bind this exact promoted proposal.');
  return value;
}

function boundedString(value, maximum = 200) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum;
}

export function assertPromoteTransitionLookup(value, descriptor) {
  if (!exactKeys(value, ['transition', 'proposal'])) {
    throw new Error('Promote transition lookup has an unexpected schema.');
  }
  const transition = value.transition;
  if (
    !exactKeys(transition, [
      'transitionId', 'proposalId', 'fighterId', 'action', 'operation', 'actorUserId',
      'from', 'to', 'expectedWorkerSha', 'visualReviewAccepted',
      'needsReviewAccepted', 'createdAt',
    ]) ||
    !exactKeys(transition?.from, ['spriteVersionId', 'processedSha256', 'rawSha256']) ||
    !exactKeys(transition?.to, ['spriteVersionId', 'processedSha256', 'rawSha256']) ||
    !exactSha(transition.transitionId) || transition.proposalId !== descriptor.proposalId ||
    transition.fighterId !== descriptor.fighter.fighterId || transition.action !== descriptor.action ||
    transition.operation !== 'promote' || !boundedString(transition.actorUserId) ||
    transition.expectedWorkerSha !== descriptor.expectedWorkerSha ||
    transition.visualReviewAccepted !== true ||
    transition.needsReviewAccepted !== (descriptor.to.technicalOutcome === 'needs_review') ||
    !boundedString(transition.createdAt) ||
    transition.from.spriteVersionId !== descriptor.from.spriteVersionId ||
    transition.from.processedSha256 !== descriptor.from.processedSha256 ||
    transition.from.rawSha256 !== descriptor.from.rawSha256 ||
    transition.to.spriteVersionId !== descriptor.to.spriteVersionId ||
    transition.to.processedSha256 !== descriptor.to.processedSha256 ||
    transition.to.rawSha256 !== descriptor.to.rawSha256
  ) throw new Error('Promote transition lookup does not bind this exact descriptor.');
  const proposal = value.proposal;
  if (
    !exactKeys(proposal, [
      'proposalId', 'fighterId', 'action', 'worker', 'from', 'to', 'source',
      'evidenceSha256', 'createdAt', 'assets',
    ]) ||
    proposal.proposalId !== descriptor.proposalId ||
    proposal.fighterId !== descriptor.fighter.fighterId || proposal.action !== descriptor.action ||
    !boundedString(proposal.createdAt) ||
    canonicalJson(proposal.worker) !== canonicalJson(descriptor.worker) ||
    canonicalJson(proposal.from) !== canonicalJson(descriptor.from) ||
    canonicalJson(proposal.to) !== canonicalJson(descriptor.to) ||
    canonicalJson(proposal.source) !== canonicalJson(descriptor.source) ||
    proposal.evidenceSha256 !== descriptor.evidenceSha256 ||
    canonicalJson(proposal.assets) !== canonicalJson(descriptor.assetRoutes)
  ) throw new Error('Promote transition lookup returned a different proposal snapshot.');
  return value;
}

export function assertReceiptMatchesPromoteTransition(receipt, authoritative) {
  if (receipt.transitionId !== authoritative.transition.transitionId) {
    throw new Error('Promotion receipt does not match the authoritative transition.');
  }
  return receipt;
}

export async function persistTransitionReceiptWithSmoke(persist, smoke) {
  // The transition mutates production before smoke reads several eventually
  // cached surfaces, so its local proof must survive a smoke failure.
  const written = persist();
  await smoke();
  return written;
}

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const operation = values.get('operation') ?? '';
  if (!Object.hasOwn(CONFIRMATIONS, operation)) throw new Error('operation must be stage, promote, or rollback.');
  if (values.get('confirm') !== CONFIRMATIONS[operation]) {
    throw new Error(`${operation} requires --confirm=${CONFIRMATIONS[operation]}.`);
  }
  const expectedWorkerSha = values.get('expected-deployed-sha') ?? '';
  if (!exactWorkerSha(expectedWorkerSha)) throw new Error('expected-deployed-sha must be a full lowercase commit SHA.');
  await pinWorker(expectedWorkerSha);
  const env = readEnvValues();
  const secret = env.get('ASF_ARCADE_CLERK_SECRET_KEY')?.trim() ?? '';
  const userId = env.get('ASF_ARCADE_ADMIN_CLERK_USER_ID')?.trim() ?? '';
  const bridgeSecret = env.get('CLERK_BACKEND_AUTH_BRIDGE_SECRET')?.trim() ?? '';
  if (!secret || !userId) throw new Error('Production Clerk admin credentials are unavailable.');
  if (bridgeSecret && bridgeSecret.length < 32) throw new Error('Clerk backend bridge secret is malformed.');
  const context = { token: await createAdminToken(secret, userId), bridgeSecret, expectedWorkerSha };

  if (operation === 'stage') {
    const allowed = new Set(['operation', 'confirm', 'expected-deployed-sha', 'source-binding', 'source-binding-sha256', 'export-dir']);
    for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`Unexpected stage argument: --${key}`);
    if (flags.size > 0) throw new Error('Stage accepts no boolean flags.');
    const path = resolve(values.get('source-binding') ?? '');
    const loaded = readExactJson(path);
    if (loaded.digest !== values.get('source-binding-sha256')) throw new Error('Source binding SHA-256 changed.');
    const binding = assertSourceBinding(loaded.value);
    const current = await resolveExactCurrent(context, binding);
    const body = {
      action: binding.action,
      current: { ...binding.current, spriteVersionId: current.spriteVersionId },
      canonical: binding.canonical,
      source: binding.source,
      selectedVideoIndices: binding.selectedVideoIndices,
    };
    const pathPrefix = `/api/admin/arcade/${binding.fighter.fighterId}/imported-video-recuration`;
    const result = await apiJson(context, `${pathPrefix}/stage`, { method: 'POST', body: JSON.stringify(body) });
    if (result.providerCalls !== 0) throw new Error('Stage did not prove zero provider calls.');
    const proposal = validateProposal(result.proposal, binding, expectedWorkerSha);
    const exported = await exportStage(
      context, binding, loaded.digest, proposal, values.get('export-dir') ?? '',
    );
    console.log(JSON.stringify({
      operation, fighter: binding.fighter.slug, action: binding.action,
      proposalId: proposal.proposalId, descriptorSha256: exported.descriptorSha256,
      technicalOutcome: proposal.to.technicalOutcome, providerCalls: 0,
    }));
    return;
  }

  const allowed = new Set([
    'operation', 'confirm', 'expected-deployed-sha', 'descriptor',
    'descriptor-sha256', 'receipt-dir', 'promotion-receipt', 'promotion-receipt-sha256',
  ]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`Unexpected transition argument: --${key}`);
  if (operation === 'promote' && (
    values.has('promotion-receipt') || values.has('promotion-receipt-sha256')
  )) throw new Error('Promotion receipt input is only valid for rollback.');
  const descriptorPath = resolve(values.get('descriptor') ?? '');
  const loaded = readExactJson(descriptorPath);
  if (loaded.digest !== values.get('descriptor-sha256')) throw new Error('Descriptor SHA-256 changed.');
  const descriptor = assertDescriptor(
    loaded.value,
    operation === 'rollback' ? '' : expectedWorkerSha,
  );
  verifyDescriptorBundle(descriptorPath, descriptor, loaded.digest);
  const basePath = `/api/admin/arcade/${descriptor.fighter.fighterId}/imported-video-recuration`;
  const body = {
    proposalId: descriptor.proposalId,
    fromProcessedSha256: operation === 'promote'
      ? descriptor.from.processedSha256 : descriptor.to.processedSha256,
    fromRawSha256: operation === 'promote' ? descriptor.from.rawSha256 : descriptor.to.rawSha256,
    toProcessedSha256: operation === 'promote'
      ? descriptor.to.processedSha256 : descriptor.from.processedSha256,
    toRawSha256: operation === 'promote' ? descriptor.to.rawSha256 : descriptor.from.rawSha256,
    visualReviewAccepted: operation === 'promote',
    acceptNeedsReview: operation === 'promote' && flags.has('accept-needs-review'),
  };
  if (operation === 'rollback') {
    if (flags.size > 0) throw new Error('Rollback accepts no boolean flags.');
    const authoritative = assertPromoteTransitionLookup(await apiJson(
      context,
      `${basePath}/${descriptor.proposalId}/promote-transition`,
    ), descriptor);
    const receiptPathValue = values.get('promotion-receipt');
    const receiptSha256 = values.get('promotion-receipt-sha256');
    if (Boolean(receiptPathValue) !== Boolean(receiptSha256)) {
      throw new Error('Promotion receipt path and SHA-256 must be supplied together.');
    }
    if (receiptPathValue && receiptSha256) {
      const receiptPath = resolve(receiptPathValue);
      const receipt = readExactJson(receiptPath);
      if (receipt.digest !== receiptSha256) {
        throw new Error('Promotion receipt SHA-256 changed.');
      }
      const promotion = assertPromotionReceipt(receipt.value, descriptor, loaded.digest);
      const sidecar = readFileSync(`${receiptPath}.sha256`, 'utf8');
      if (sidecar !== `${receipt.digest}  promotion-receipt.json\n`) {
        throw new Error('Promotion receipt sidecar is not exact.');
      }
      assertReceiptMatchesPromoteTransition(promotion, authoritative);
    }
    body.promoteTransitionId = authoritative.transition.transitionId;
  } else if (descriptor.to.technicalOutcome === 'needs_review' && !flags.has('accept-needs-review')) {
    throw new Error('A needs_review target requires --accept-needs-review after visual acceptance.');
  } else if (descriptor.to.technicalOutcome === 'technical_pass' && flags.has('accept-needs-review')) {
    throw new Error('--accept-needs-review is invalid for a technical_pass target.');
  }
  const result = await apiJson(context, `${basePath}/${operation}`, {
    method: 'POST', body: JSON.stringify(body),
  });
  if (
    result.operation !== operation || typeof result.replayed !== 'boolean' || !exactSha(result.transitionId) ||
    result.providerCalls !== 0 || typeof result.localArcadeCachePurgeAttempted !== 'boolean' ||
    typeof result.localArcadeCacheEntryDeleted !== 'boolean' ||
    result.proposal?.proposalId !== descriptor.proposalId
  ) throw new Error(`${operation} response did not prove the exact transition and cache purge.`);
  const receipt = transitionReceipt(
    operation, descriptor, loaded.digest, expectedWorkerSha, result,
  );
  const written = await persistTransitionReceiptWithSmoke(
    () => writeReceipt(values.get('receipt-dir') ?? '', receipt),
    () => smokeTransition(context, descriptor, operation === 'promote' ? descriptor.to : descriptor.from),
  );
  console.log(JSON.stringify({
    operation, fighter: descriptor.fighter.slug, action: descriptor.action,
    proposalId: descriptor.proposalId, transitionId: result.transitionId,
    receiptSha256: written.digest, replayed: result.replayed,
    localArcadeCachePurgeAttempted: result.localArcadeCachePurgeAttempted,
    localArcadeCacheEntryDeleted: result.localArcadeCacheEntryDeleted,
    providerCalls: 0,
  }));
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
