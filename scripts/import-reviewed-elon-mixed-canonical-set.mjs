import { createHash, randomUUID } from 'node:crypto';
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
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authenticatedAssetClient,
  authenticatedRequestClient,
  createAdminTokenProvider,
  loadReviewedCanonicalBundle,
  validateBundlePromptAndRequest,
} from './import-reviewed-xai-canonical-bundle.mjs';
import { inspectPng } from './arcade-xai-canonical-bundle.mjs';
import {
  REVIEWED_CANONICAL_SOURCE_MODE,
  validateManifest,
} from './seed-arcade-roster.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_ROSTER_PATH = join(root, 'arcade/roster-2026.json');
const MAX_PNG_BYTES = 12 * 1024 * 1024;
const SOURCE_NAMES = Object.freeze(['side', 'upright', 'crouch']);
const MUTATED_KINDS = Object.freeze(['upright', 'upright_raw', 'crouch', 'crouch_raw']);
const RESPONSE_KEYS = Object.freeze({
  side: 'side',
  side_raw: 'sideRaw',
  upright: 'upright',
  upright_raw: 'uprightRaw',
  crouch: 'crouch',
  crouch_raw: 'crouchRaw',
});

export const ELON_MIXED_IMPORT_CONFIRMATION = 'IMPORT_REVIEWED_ELON_MIXED_CANONICAL_SET_V1';
export const ELON_MIXED_IMPORT_SAFETY_CONFIRMATION = 'SOURCES_ONLY_NO_PROVIDER_NO_GENERATION_NO_ACTIVATION';
export const ELON_MIXED_QA_DECISION = 'APPROVE_ELON_SIDE_ALIAS_AND_CROUCH_V1';
export const ELON_UPRIGHT_ALIAS_DECISION = 'ALIAS_EXACT_REVIEWED_SIDE_BYTES_AS_UPRIGHT_V1';
export const INSERT_PLAYER_PRODUCTION_WORKER_ORIGIN = 'https://api.insertplayer.ai';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value ?? {}).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} keys are not sealed.`);
}

function requireString(value, label, pattern) {
  if (typeof value !== 'string' || !value || (pattern && !pattern.test(value))) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${label} is missing or invalid JSON.`);
  }
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is invalid JSON.`);
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.writing-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function safeSibling(basePath, relativePath, label) {
  requireString(relativePath, `${label} path`);
  if (relativePath.startsWith('/') || relativePath.includes('\\')) throw new Error(`${label} path is not relative.`);
  const base = dirname(resolve(basePath));
  const absolute = resolve(base, relativePath);
  if (!absolute.startsWith(`${base}${sep}`)) throw new Error(`${label} path escapes the assembly plan.`);
  return absolute;
}

function validateSourceIdentity(value, label) {
  exactKeys(value, ['versionId', 'blobKey', 'contentSha256', 'sizeBytes', 'width', 'height'], label);
  requireString(value.versionId, `${label} version id`, /^[a-f0-9]{32}$/);
  requireString(value.blobKey, `${label} blob key`);
  requireString(value.contentSha256, `${label} content hash`, /^[a-f0-9]{64}$/);
  if (
    !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 24 || value.sizeBytes > MAX_PNG_BYTES
    || !Number.isSafeInteger(value.width) || value.width < 64 || value.width > 4096
    || !Number.isSafeInteger(value.height) || value.height < 64 || value.height > 4096
  ) throw new Error(`${label} byte or dimension bounds are invalid.`);
  return value;
}

function validateAssemblyPlan(plan) {
  exactKeys(plan, [
    'schemaVersion', 'planType', 'fighter', 'side', 'sideApproval', 'uprightAlias',
    'crouch', 'qaEvidence', 'safety',
  ], 'mixed canonical assembly plan');
  if (plan.schemaVersion !== 1 || plan.planType !== 'elon_reviewed_mixed_canonical_set_v1') {
    throw new Error('Mixed canonical assembly plan schema is invalid.');
  }
  exactKeys(plan.fighter, ['slug', 'fighterId', 'name', 'photoHash'], 'assembly fighter');
  if (
    plan.fighter.slug !== 'elon-musk'
    || plan.fighter.name !== 'Elon Musk'
    || !/^[a-f0-9]{32}$/.test(plan.fighter.fighterId ?? '')
    || !/^[a-f0-9]{64}$/.test(plan.fighter.photoHash ?? '')
  ) throw new Error('Assembly plan is not sealed to the exact Elon fighter and photo.');
  exactKeys(plan.side, ['processed', 'raw'], 'assembly current SIDE');
  validateSourceIdentity(plan.side.processed, 'assembly current SIDE processed');
  validateSourceIdentity(plan.side.raw, 'assembly current SIDE raw');
  exactKeys(plan.sideApproval, [
    'status', 'runId', 'jobId', 'completedByJobId', 'artifactKind', 'artifactName',
    'stageIndex', 'qualityTier', 'createdAt', 'verifiedAt',
  ], 'assembly current SIDE approval lineage');
  if (
    plan.sideApproval.status !== 'approved'
    || ![plan.sideApproval.runId, plan.sideApproval.jobId, plan.sideApproval.completedByJobId]
      .every((id) => /^[a-f0-9]{32}$/.test(id ?? ''))
    || plan.sideApproval.runId !== plan.sideApproval.jobId
    || plan.sideApproval.runId !== plan.sideApproval.completedByJobId
    || plan.sideApproval.artifactKind !== 'source'
    || plan.sideApproval.artifactName !== 'side'
    || plan.sideApproval.stageIndex !== 1
    || plan.sideApproval.qualityTier !== 'champion'
    || plan.sideApproval.createdAt !== '2026-08-25 13:59:21'
    || plan.sideApproval.verifiedAt !== null
  ) throw new Error('Current SIDE approval lineage is not the exact reviewed production checkpoint.');
  exactKeys(plan.uprightAlias, ['decision', 'fromProcessedVersionId', 'fromRawVersionId'], 'UPRIGHT alias decision');
  if (
    plan.uprightAlias.decision !== ELON_UPRIGHT_ALIAS_DECISION
    || plan.uprightAlias.fromProcessedVersionId !== plan.side.processed.versionId
    || plan.uprightAlias.fromRawVersionId !== plan.side.raw.versionId
  ) throw new Error('UPRIGHT alias is not explicitly sealed to the reviewed current SIDE pair.');
  exactKeys(plan.crouch, [
    'bundleRunId', 'bundleId', 'reviewedDescriptorSha256', 'processedSha256', 'rawSha256',
  ], 'assembly CROUCH');
  requireString(plan.crouch.bundleRunId, 'CROUCH bundle run id', /^[1-9][0-9]*$/);
  requireString(plan.crouch.bundleId, 'CROUCH bundle id', /^arcade-xai-canonical-source-elon-musk-crouch-v1$/);
  for (const key of ['reviewedDescriptorSha256', 'processedSha256', 'rawSha256']) {
    requireString(plan.crouch[key], `CROUCH ${key}`, /^[a-f0-9]{64}$/);
  }
  exactKeys(plan.qaEvidence, ['path', 'contentSha256'], 'assembly QA evidence');
  requireString(plan.qaEvidence.contentSha256, 'assembly QA evidence hash', /^[a-f0-9]{64}$/);
  exactKeys(plan.safety, [
    'providerCalls', 'generationStarted', 'activated', 'sideMutation', 'allowedSourcePosts',
  ], 'assembly safety policy');
  if (
    plan.safety.providerCalls !== 0
    || plan.safety.generationStarted !== false
    || plan.safety.activated !== false
    || plan.safety.sideMutation !== false
    || canonicalJson(plan.safety.allowedSourcePosts) !== canonicalJson(MUTATED_KINDS)
  ) throw new Error('Assembly plan safety policy changed.');
  return plan;
}

function validateQaEvidence(plan, planPath) {
  const evidencePath = safeSibling(planPath, plan.qaEvidence.path, 'QA evidence');
  const bytes = readFileSync(evidencePath);
  if (sha256(bytes) !== plan.qaEvidence.contentSha256) throw new Error('QA evidence SHA-256 mismatch.');
  const evidence = parseJsonBytes(bytes, 'QA evidence');
  exactKeys(evidence, [
    'schemaVersion', 'evidenceType', 'status', 'decision', 'reviewedBy', 'reviewedAt',
    'fighter', 'side', 'uprightAlias', 'crouch', 'blockingFindings',
  ], 'mixed canonical QA evidence');
  if (
    evidence.schemaVersion !== 1
    || evidence.evidenceType !== 'elon_mixed_canonical_human_review_v1'
    || evidence.status !== 'approved'
    || evidence.decision !== ELON_MIXED_QA_DECISION
    || !/^\d{4}-\d{2}-\d{2}T/.test(evidence.reviewedAt ?? '')
    || !Array.isArray(evidence.blockingFindings)
    || evidence.blockingFindings.length !== 0
  ) throw new Error('Mixed canonical QA evidence is not an unblocked explicit approval.');
  requireString(evidence.reviewedBy, 'mixed canonical QA reviewer');
  if (canonicalJson(evidence.fighter) !== canonicalJson(plan.fighter)) throw new Error('QA evidence fighter binding changed.');
  exactKeys(evidence.side, [
    'processedVersionId', 'processedSha256', 'rawVersionId', 'rawSha256', 'approvalLineage',
  ], 'QA SIDE');
  if (
    evidence.side.processedVersionId !== plan.side.processed.versionId
    || evidence.side.processedSha256 !== plan.side.processed.contentSha256
    || evidence.side.rawVersionId !== plan.side.raw.versionId
    || evidence.side.rawSha256 !== plan.side.raw.contentSha256
    || canonicalJson(evidence.side.approvalLineage) !== canonicalJson(plan.sideApproval)
  ) throw new Error('QA evidence does not bind the exact current SIDE pair.');
  exactKeys(evidence.uprightAlias, ['decision', 'processedSha256', 'rawSha256'], 'QA UPRIGHT alias');
  if (
    evidence.uprightAlias.decision !== ELON_UPRIGHT_ALIAS_DECISION
    || evidence.uprightAlias.processedSha256 !== plan.side.processed.contentSha256
    || evidence.uprightAlias.rawSha256 !== plan.side.raw.contentSha256
  ) throw new Error('QA evidence does not approve the exact byte alias.');
  exactKeys(evidence.crouch, ['bundleRunId', 'descriptorSha256', 'processedSha256', 'rawSha256'], 'QA CROUCH');
  if (
    evidence.crouch.bundleRunId !== plan.crouch.bundleRunId
    || evidence.crouch.descriptorSha256 !== plan.crouch.reviewedDescriptorSha256
    || evidence.crouch.processedSha256 !== plan.crouch.processedSha256
    || evidence.crouch.rawSha256 !== plan.crouch.rawSha256
  ) throw new Error('QA evidence does not bind the exact reviewed CROUCH pair.');
  return { evidence, evidencePath, contentSha256: plan.qaEvidence.contentSha256 };
}

function assertProductionFighter(detail, plan, rosterFighter) {
  const fighter = detail?.fighter;
  if (
    !fighter
    || fighter.id !== plan.fighter.fighterId
    || fighter.name !== rosterFighter.name
    || fighter.photoHash !== rosterFighter.reference.sourceSha256
    || fighter.qualityTier !== 'champion'
    || fighter.public !== false
    || !fighter.sources?.original
    || fighter.sourceHashes?.original !== rosterFighter.reference.sourceSha256
  ) throw new Error('Production fighter identity, privacy, tier, or licensed photo changed.');
  return fighter;
}

function remoteHash(fighter, kind) {
  return fighter.sourceHashes?.[RESPONSE_KEYS[kind]] ?? null;
}

function parsePrivateSourceUrl(urlValue, expectedOrigin, fighterId, kind) {
  const url = new URL(requireString(urlValue, `${kind} private asset URL`));
  if (
    url.origin !== expectedOrigin
    || url.username || url.password || url.search || url.hash
    || !url.pathname.startsWith('/assets/')
  ) throw new Error(`${kind} private asset URL is outside the exact Worker asset origin.`);
  const encodedKey = url.pathname.slice('/assets/'.length);
  let blobKey;
  try {
    blobKey = encodedKey.split('/').map(decodeURIComponent).join('/');
  } catch {
    throw new Error(`${kind} private asset URL cannot be decoded.`);
  }
  const escapedKind = kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = blobKey.match(new RegExp(
    `^users\/([A-Za-z0-9_-]{1,128})\/fighters\/${fighterId}\/sources\/${escapedKind}_([a-f0-9]{32})\\.png$`,
  ));
  if (!match) throw new Error(`${kind} private asset blob key is not an exact current source version.`);
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
  if (!response.body) throw new Error(`${label} asset has no body.`);
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
  const bytes = Buffer.concat(chunks, total);
  return { bytes, ...inspectPng(bytes, label) };
}

async function verifyRemoteSource({ fighter, kind, expectedOrigin, requestAsset, expected = null }) {
  const responseKey = RESPONSE_KEYS[kind];
  const parsed = parsePrivateSourceUrl(fighter.sources?.[responseKey], expectedOrigin, fighter.id, kind);
  const inspected = await readBoundedPngResponse(await requestAsset(parsed.path), kind);
  const record = {
    versionId: parsed.versionId,
    blobKey: parsed.blobKey,
    contentSha256: inspected.contentSha256,
    sizeBytes: inspected.sizeBytes,
    width: inspected.width,
    height: inspected.height,
    r2BytesVerifiedVia: 'authenticated_worker_asset_get_v1',
  };
  if (remoteHash(fighter, kind) !== record.contentSha256) {
    throw new Error(`${kind} source hash pointer does not match its R2 bytes.`);
  }
  if (expected) {
    const { r2BytesVerifiedVia: _verification, ...comparable } = record;
    if (canonicalJson(comparable) !== canonicalJson(expected)) {
      throw new Error(`${kind} current source identity or R2 bytes changed from the reviewed plan.`);
    }
  }
  return { record, bytes: inspected.bytes, ownerUserId: parsed.ownerUserId };
}

async function verifySidePair(fighter, plan, expectedOrigin, requestAsset) {
  const processed = await verifyRemoteSource({
    fighter, kind: 'side', expectedOrigin, requestAsset, expected: plan.side.processed,
  });
  const raw = await verifyRemoteSource({
    fighter, kind: 'side_raw', expectedOrigin, requestAsset, expected: plan.side.raw,
  });
  if (processed.ownerUserId !== raw.ownerUserId) throw new Error('Current SIDE pair belongs to different R2 owners.');
  return { processed, raw };
}

function acquireLock(statePath) {
  const path = `${statePath}.lock`;
  const nonce = randomUUID();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Mixed import lock exists and requires manual reconciliation.');
    throw error;
  }
  writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, nonce, statePath })}\n`);
  fsyncSync(descriptor);
  return { path, nonce, descriptor };
}

function releaseLock(lock) {
  closeSync(lock.descriptor);
  const current = readJson(lock.path, 'mixed import lock');
  if (current.nonce !== lock.nonce) throw new Error('Mixed import lock ownership changed.');
  unlinkSync(lock.path);
}

function initialState(planSha256, plan) {
  return {
    schemaVersion: 1,
    status: 'importing',
    planSha256,
    descriptorSha256: plan.crouch.reviewedDescriptorSha256,
    fighterId: plan.fighter.fighterId,
    photoHash: plan.fighter.photoHash,
    qaEvidenceSha256: plan.qaEvidence.contentSha256,
    aliasDecision: ELON_UPRIGHT_ALIAS_DECISION,
    uploads: {},
  };
}

function validateState(state, expected) {
  exactKeys(state, state.status === 'completed'
    ? [...Object.keys(expected), 'operatorManifestSha256', 'reviewedManifestSha256']
    : Object.keys(expected), 'mixed import checkpoint');
  if (!['importing', 'completed'].includes(state.status)) throw new Error('Mixed import checkpoint status is invalid.');
  for (const key of [
    'schemaVersion', 'planSha256', 'descriptorSha256', 'fighterId', 'photoHash',
    'qaEvidenceSha256', 'aliasDecision',
  ]) if (state[key] !== expected[key]) throw new Error(`Mixed import checkpoint mismatch: ${key}.`);
  if (!state.uploads || typeof state.uploads !== 'object' || Array.isArray(state.uploads)) {
    throw new Error('Mixed import checkpoint uploads are invalid.');
  }
  if (Object.keys(state.uploads).some((kind) => !MUTATED_KINDS.includes(kind))) {
    throw new Error('Mixed import checkpoint contains an unauthorized source mutation.');
  }
  for (const [kind, upload] of Object.entries(state.uploads)) {
    exactKeys(upload, upload.status === 'outcome_unknown' && upload.error
      ? ['status', 'expectedSha256', 'error']
      : ['status', 'expectedSha256'], `${kind} mixed import checkpoint`);
    if (
      !['uploading', 'outcome_unknown', 'verified', 'verified_existing', 'reconciled'].includes(upload.status)
      || !/^[a-f0-9]{64}$/.test(upload.expectedSha256 ?? '')
    ) throw new Error(`${kind} mixed import checkpoint is invalid.`);
  }
}

async function uploadSource(requestApi, fighterId, operation) {
  const form = new FormData();
  form.set('kind', operation.kind);
  form.set('file', new Blob([operation.bytes], { type: 'image/png' }), `${operation.kind}.png`);
  return requestApi(`/api/fighters/${encodeURIComponent(fighterId)}/sources`, {
    method: 'POST',
    body: form,
  });
}

function reviewedCurrentManifest(plan) {
  return {
    schemaVersion: 1,
    canonicalSourceMode: REVIEWED_CANONICAL_SOURCE_MODE,
    slug: plan.fighter.slug,
    fighterId: plan.fighter.fighterId,
    photoHash: plan.fighter.photoHash,
    canonicalSourceHashes: {
      side: {
        processedSha256: plan.side.processed.contentSha256,
        rawSha256: plan.side.raw.contentSha256,
      },
      upright: {
        processedSha256: plan.side.processed.contentSha256,
        rawSha256: plan.side.raw.contentSha256,
      },
      crouch: {
        processedSha256: plan.crouch.processedSha256,
        rawSha256: plan.crouch.rawSha256,
      },
    },
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
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
  ) throw new Error(`Production Worker URL must be exactly ${INSERT_PLAYER_PRODUCTION_WORKER_ORIGIN}.`);
  return INSERT_PLAYER_PRODUCTION_WORKER_ORIGIN;
}

export async function runReviewedElonMixedCanonicalImport(options = {}) {
  if (options.confirmation !== ELON_MIXED_IMPORT_CONFIRMATION) {
    throw new Error(`Mixed import requires confirmation ${ELON_MIXED_IMPORT_CONFIRMATION}.`);
  }
  if (options.safetyConfirmation !== ELON_MIXED_IMPORT_SAFETY_CONFIRMATION) {
    throw new Error(`Mixed import requires safety confirmation ${ELON_MIXED_IMPORT_SAFETY_CONFIRMATION}.`);
  }
  const planPath = resolve(requireString(options.assemblyPlanPath, 'assembly plan path'));
  const planSha256 = requireString(options.assemblyPlanSha256, 'assembly plan SHA-256', /^[a-f0-9]{64}$/);
  const planBytes = readFileSync(planPath);
  if (sha256(planBytes) !== planSha256) throw new Error('Assembly plan SHA-256 mismatch.');
  const plan = validateAssemblyPlan(parseJsonBytes(planBytes, 'assembly plan'));
  const qa = validateQaEvidence(plan, planPath);
  const reviewedBy = requireString(options.reviewedBy, 'review actor');
  if (reviewedBy !== qa.evidence.reviewedBy) throw new Error('Review actor does not match the sealed QA evidence.');

  const bundle = (options.loadReviewedBundle ?? loadReviewedCanonicalBundle)({
    bundleDirectory: requireString(options.bundleDirectory, 'private CROUCH bundle directory'),
    reviewedDescriptorSha256: plan.crouch.reviewedDescriptorSha256,
  });
  if (
    canonicalJson(bundle.sourceNames) !== canonicalJson(['crouch'])
    || bundle.descriptor.bundleId !== plan.crouch.bundleId
    || bundle.descriptor.sources.crouch.clean.contentSha256 !== plan.crouch.processedSha256
    || bundle.descriptor.sources.crouch.raw.contentSha256 !== plan.crouch.rawSha256
  ) throw new Error('Reviewed CROUCH bundle does not match the exact assembly plan.');

  const roster = JSON.parse(readFileSync(options.rosterPath ?? DEFAULT_ROSTER_PATH, 'utf8'));
  validateManifest(roster);
  const matches = roster.fighters.filter((fighter) => fighter.slug === 'elon-musk');
  if (matches.length !== 1) throw new Error('Elon is missing or ambiguous in the reviewed roster.');
  const rosterFighter = matches[0];
  if (
    rosterFighter.name !== plan.fighter.name
    || rosterFighter.reference.sourceSha256 !== plan.fighter.photoHash
    || bundle.descriptor.fighter.originalSha256 !== plan.fighter.photoHash
  ) throw new Error('Assembly fighter, CROUCH identity, or roster photo does not match.');
  (options.validateReviewedBundle ?? validateBundlePromptAndRequest)(bundle, rosterFighter);

  const requestApi = options.requestApi;
  const requestAsset = options.requestAsset;
  if (typeof requestApi !== 'function' || typeof requestAsset !== 'function') {
    throw new Error('Authenticated production JSON and bounded asset clients are required.');
  }
  const expectedOrigin = new URL(requireString(options.workerUrl, 'Worker URL')).origin;
  const admin = await requestApi('/api/admin/arcade');
  const entries = (Array.isArray(admin?.fighters) ? admin.fighters : [])
    .filter((entry) => entry?.slug === 'elon-musk' && entry?.status !== 'retired');
  if (
    entries.length !== 1
    || entries[0].status !== 'draft'
    || entries[0].fighterId !== plan.fighter.fighterId
  ) throw new Error('Mixed import requires the exact current private Elon draft.');
  let detail = await requestApi(`/api/fighters/${encodeURIComponent(plan.fighter.fighterId)}`);
  let fighter = assertProductionFighter(detail, plan, rosterFighter);
  let side = await verifySidePair(fighter, plan, expectedOrigin, requestAsset);

  const outputDirectory = resolve(requireString(options.outputDirectory, 'mixed import output directory'));
  const statePath = resolve(options.statePath ?? join(outputDirectory, 'import-state.json'));
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const lock = acquireLock(statePath);
  try {
    const expectedState = initialState(planSha256, plan);
    let state = existsSync(statePath) ? readJson(statePath, 'mixed import checkpoint') : expectedState;
    validateState(state, expectedState);
    const saveState = () => writeJsonAtomic(statePath, state);
    saveState();

    const operations = [
      { kind: 'upright', bytes: side.processed.bytes, expectedSha256: plan.side.processed.contentSha256 },
      { kind: 'upright_raw', bytes: side.raw.bytes, expectedSha256: plan.side.raw.contentSha256 },
      {
        kind: 'crouch',
        bytes: readFileSync(bundle.sources.crouch.processed.absolutePath),
        expectedSha256: plan.crouch.processedSha256,
      },
      {
        kind: 'crouch_raw',
        bytes: readFileSync(bundle.sources.crouch.raw.absolutePath),
        expectedSha256: plan.crouch.rawSha256,
      },
    ];
    for (const operation of operations) {
      if (sha256(operation.bytes) !== operation.expectedSha256) {
        throw new Error(`${operation.kind} local reviewed bytes changed.`);
      }
      if (operation.bytes.byteLength > MAX_PNG_BYTES) {
        throw new Error(`${operation.kind} local reviewed source exceeds the byte limit.`);
      }
      const inspected = inspectPng(operation.bytes, `${operation.kind} local reviewed source`);
      if (
        inspected.width < 64 || inspected.width > 4096
        || inspected.height < 64 || inspected.height > 4096
      ) throw new Error(`${operation.kind} local reviewed source dimensions are outside the safe bounds.`);
    }
    for (const operation of operations) {
      detail = await requestApi(`/api/fighters/${encodeURIComponent(plan.fighter.fighterId)}`);
      fighter = assertProductionFighter(detail, plan, rosterFighter);
      side = await verifySidePair(fighter, plan, expectedOrigin, requestAsset);
      const previous = state.uploads[operation.kind] ?? null;
      const current = remoteHash(fighter, operation.kind);
      if (previous) {
        if (previous.expectedSha256 !== operation.expectedSha256) {
          throw new Error(`${operation.kind} checkpoint hash changed.`);
        }
        if (['verified', 'verified_existing', 'reconciled'].includes(previous.status)) {
          if (current !== operation.expectedSha256) throw new Error(`${operation.kind} changed after verification.`);
          await verifyRemoteSource({ fighter, kind: operation.kind, expectedOrigin, requestAsset });
          continue;
        }
        if (['uploading', 'outcome_unknown'].includes(previous.status)) {
          if (current === operation.expectedSha256) {
            await verifyRemoteSource({ fighter, kind: operation.kind, expectedOrigin, requestAsset });
            state.uploads[operation.kind] = { status: 'reconciled', expectedSha256: operation.expectedSha256 };
            saveState();
            continue;
          }
          throw new Error(`${operation.kind} has an ambiguous prior POST and cannot be re-POSTed.`);
        }
      }
      if (current === operation.expectedSha256) {
        await verifyRemoteSource({ fighter, kind: operation.kind, expectedOrigin, requestAsset });
        state.uploads[operation.kind] = { status: 'verified_existing', expectedSha256: operation.expectedSha256 };
        saveState();
        continue;
      }
      state.uploads[operation.kind] = { status: 'uploading', expectedSha256: operation.expectedSha256 };
      saveState();
      try {
        await uploadSource(requestApi, plan.fighter.fighterId, operation);
      } catch (error) {
        state.uploads[operation.kind] = {
          status: 'outcome_unknown',
          expectedSha256: operation.expectedSha256,
          error: error instanceof Error ? error.message : String(error),
        };
        saveState();
        throw new Error(`${operation.kind} POST outcome is unknown; automatic re-POST is forbidden.`);
      }
      detail = await requestApi(`/api/fighters/${encodeURIComponent(plan.fighter.fighterId)}`);
      fighter = assertProductionFighter(detail, plan, rosterFighter);
      if (remoteHash(fighter, operation.kind) !== operation.expectedSha256) {
        state.uploads[operation.kind] = { status: 'outcome_unknown', expectedSha256: operation.expectedSha256 };
        saveState();
        throw new Error(`${operation.kind} did not become the exact reviewed current source.`);
      }
      await verifyRemoteSource({ fighter, kind: operation.kind, expectedOrigin, requestAsset });
      await verifySidePair(fighter, plan, expectedOrigin, requestAsset);
      state.uploads[operation.kind] = { status: 'verified', expectedSha256: operation.expectedSha256 };
      saveState();
    }

    detail = await requestApi(`/api/fighters/${encodeURIComponent(plan.fighter.fighterId)}`);
    fighter = assertProductionFighter(detail, plan, rosterFighter);
    const records = {};
    const ownerUserIds = new Set();
    for (const kind of ['side', 'side_raw', 'upright', 'upright_raw', 'crouch', 'crouch_raw']) {
      const expected = kind === 'side' ? plan.side.processed : kind === 'side_raw' ? plan.side.raw : null;
      const verified = await verifyRemoteSource({
        fighter, kind, expectedOrigin, requestAsset, expected,
      });
      records[kind] = verified.record;
      ownerUserIds.add(verified.ownerUserId);
    }
    if (ownerUserIds.size !== 1) throw new Error('Final mixed sources do not share one exact R2 owner namespace.');
    if (
      records.upright.contentSha256 !== records.side.contentSha256
      || records.upright_raw.contentSha256 !== records.side_raw.contentSha256
      || records.crouch.contentSha256 !== plan.crouch.processedSha256
      || records.crouch_raw.contentSha256 !== plan.crouch.rawSha256
    ) throw new Error('Final mixed source hashes do not match the explicit alias and reviewed CROUCH decisions.');
    if (new Set(Object.values(records).map((record) => record.blobKey)).size !== 6) {
      throw new Error('Final mixed sources are not six distinct versioned R2 pointers.');
    }

    const reviewedManifest = reviewedCurrentManifest(plan);
    const reviewedManifestSha256 = sha256(canonicalJson(reviewedManifest));
    const operatorUnsigned = {
      schemaVersion: 1,
      manifestType: 'elon_reviewed_mixed_canonical_operator_manifest_v1',
      status: 'completed_sources_only',
      fighter: plan.fighter,
      assemblyPlanSha256: planSha256,
      qaEvidence: {
        contentSha256: qa.contentSha256,
        decision: qa.evidence.decision,
        reviewedBy: qa.evidence.reviewedBy,
        reviewedAt: qa.evidence.reviewedAt,
      },
      crouchBundle: {
        runId: plan.crouch.bundleRunId,
        bundleId: plan.crouch.bundleId,
        descriptorSha256: plan.crouch.reviewedDescriptorSha256,
      },
      sources: {
        side: { processed: records.side, raw: records.side_raw },
        upright: { processed: records.upright, raw: records.upright_raw },
        crouch: { processed: records.crouch, raw: records.crouch_raw },
      },
      sideApprovalLineage: plan.sideApproval,
      aliasDecision: {
        decision: ELON_UPRIGHT_ALIAS_DECISION,
        from: 'side',
        to: 'upright',
        processedByteSha256: records.side.contentSha256,
        rawByteSha256: records.side_raw.contentSha256,
      },
      reviewedCurrentManifest: reviewedManifest,
      reviewedCurrentManifestSha256: reviewedManifestSha256,
      safety: {
        providerCalls: 0,
        generationStarted: false,
        approvedAutomatically: false,
        activated: false,
        sideMutated: false,
        allowedSourcePosts: MUTATED_KINDS,
        sourceMutationResults: state.uploads,
      },
    };
    const operatorManifest = {
      ...operatorUnsigned,
      operatorManifestSha256: sha256(canonicalJson(operatorUnsigned)),
    };
    writeJsonAtomic(join(outputDirectory, 'reviewed-canonical-operator-manifest.json'), operatorManifest);
    writeJsonAtomic(join(outputDirectory, 'reviewed-canonical-manifest.json'), reviewedManifest);
    writeJsonAtomic(join(outputDirectory, 'import-receipt.json'), {
      schemaVersion: 1,
      status: 'completed_sources_only',
      fighter: plan.fighter,
      operatorManifestSha256: operatorManifest.operatorManifestSha256,
      reviewedManifestSha256,
      providerCalls: 0,
      generationStarted: false,
      activated: false,
    });
    state.status = 'completed';
    state.operatorManifestSha256 = operatorManifest.operatorManifestSha256;
    state.reviewedManifestSha256 = reviewedManifestSha256;
    saveState();
    return { state, operatorManifest, reviewedManifest, outputDirectory };
  } finally {
    releaseLock(lock);
  }
}

function parseArg(args, name, fallback = '') {
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--execute-production')) throw new Error('Mixed import requires --execute-production.');
  const clerkSecret = process.env.ASF_ARCADE_CLERK_SECRET_KEY?.trim() ?? '';
  const clerkUserId = process.env.ASF_ARCADE_ADMIN_CLERK_USER_ID?.trim() ?? '';
  const bridgeSecret = process.env.CLERK_BACKEND_AUTH_BRIDGE_SECRET?.trim() ?? '';
  if (!clerkSecret || !clerkUserId || bridgeSecret.length < 32) {
    throw new Error('Production Clerk admin secrets are incomplete.');
  }
  const workerUrl = normalizeProductionWorkerUrl(
    process.env.ASF_WORKER_URL?.trim() || INSERT_PLAYER_PRODUCTION_WORKER_ORIGIN,
  );
  const getToken = await createAdminTokenProvider(clerkSecret, clerkUserId);
  const outputDirectory = resolve(parseArg(args, '--output-dir'));
  const result = await runReviewedElonMixedCanonicalImport({
    confirmation: parseArg(args, '--confirm'),
    safetyConfirmation: parseArg(args, '--confirm-safety'),
    reviewedBy: parseArg(args, '--reviewed-by'),
    assemblyPlanPath: parseArg(args, '--assembly-plan'),
    assemblyPlanSha256: parseArg(args, '--assembly-plan-sha256'),
    bundleDirectory: parseArg(args, '--bundle-dir'),
    outputDirectory,
    statePath: parseArg(args, '--state', join(outputDirectory, 'import-state.json')),
    rosterPath: parseArg(args, '--roster', DEFAULT_ROSTER_PATH),
    workerUrl,
    requestApi: authenticatedRequestClient(workerUrl, getToken, bridgeSecret),
    requestAsset: authenticatedAssetClient(workerUrl, getToken, bridgeSecret),
  });
  console.log(`Mixed reviewed canonical set imported for ${result.reviewedManifest.slug}; no generation or activation started.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
