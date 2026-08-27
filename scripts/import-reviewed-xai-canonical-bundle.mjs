import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildXaiCanonicalBundlePayload,
  buildXaiCanonicalBundlePrompt,
  inspectPng,
  XAI_CANONICAL_BUNDLE_BASE_COMMIT,
  XAI_CANONICAL_BUNDLE_CLEANUP,
  XAI_CANONICAL_BUNDLE_MODEL,
  resolveXaiCanonicalSingleSourcePromptProfile,
} from './arcade-xai-canonical-bundle.mjs';
import { validateManifest } from './seed-arcade-roster.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_ROSTER_PATH = join(root, 'arcade/roster-2026.json');
const REQUEST_TIMEOUT_MS = 60_000;
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;
const TOKEN_TTL_SECONDS = 900;
const SOURCE_NAMES = Object.freeze(['side', 'upright', 'crouch']);
const SOURCE_KINDS = Object.freeze(SOURCE_NAMES.flatMap((sourceName) => [sourceName, `${sourceName}_raw`]));

function sealedPolicy(sourceNames) {
  const singleSource = sourceNames.length === 1;
  return {
    expectedPaidCalls: sourceNames.length,
    maximumPaidCalls: sourceNames.length,
    automaticRetries: 0,
    fallback: 'none',
    promptEnrichment: false,
    catalogCostPerOutputUsd: 0.11,
    maximumCostPerOutputUsd: singleSource ? 0.11 : 0.12,
    maximumBundleCostUsd: singleSource ? 0.11 : 0.36,
    outputVisibility: 'private_local',
    import: false,
    activation: false,
    humanReviewRequired: true,
  };
}

const SEALED_POLICY = Object.freeze(sealedPolicy(SOURCE_NAMES));

export const REVIEWED_CANONICAL_IMPORT_CONFIRMATION = 'IMPORT_REVIEWED_XAI_CANONICAL_BUNDLE_PRODUCTION_V1';
export const REVIEWED_CANONICAL_QA_DECISION = 'APPROVE_XAI_CANONICAL_BUNDLE_FOR_SOURCE_IMPORT_V1';
export const REVIEWED_CANONICAL_IMPORT_SAFETY_CONFIRMATION = 'SOURCES_ONLY_NO_GENERATION_NO_ACTIVATION';
export const REVIEWED_CANONICAL_SOURCE_MODE = 'reviewed-current-v1';
export const REVIEWED_CANONICAL_BUNDLE_ARTIFACT_PREFIX = 'arcade-xai-canonical-bundle-';
export const REVIEWED_CANONICAL_MANIFEST_ARTIFACT_PREFIX = 'arcade-reviewed-canonical-manifest-';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value ?? {}).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) throw new Error(`${label} keys are not sealed.`);
}

function requireString(value, label, pattern) {
  if (typeof value !== 'string' || !value || (pattern && !pattern.test(value))) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.writing-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function safeBundlePath(bundleDirectory, path, expected, label) {
  if (path !== expected) throw new Error(`${label} path is not the sealed bundle path.`);
  const absolute = resolve(bundleDirectory, path);
  if (!absolute.startsWith(`${resolve(bundleDirectory)}${sep}`)) throw new Error(`${label} escapes the bundle.`);
  return absolute;
}

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing.`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${label} is not JSON.`);
  }
}

function portableArtifact(artifact, bundleDirectory, expectedPath, label, raw) {
  exactKeys(
    artifact,
    raw
      ? ['contentSha256', 'sizeBytes', 'mimeType', 'pixcliAssetHash', 'providerRequestId', 'width', 'height', 'path']
      : ['contentSha256', 'sizeBytes', 'width', 'height', 'path'],
    label,
  );
  requireString(artifact.contentSha256, `${label} SHA-256`, /^[a-f0-9]{64}$/);
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 24) throw new Error(`${label} size is invalid.`);
  if (!Number.isSafeInteger(artifact.width) || !Number.isSafeInteger(artifact.height)) {
    throw new Error(`${label} dimensions are invalid.`);
  }
  if (raw) {
    if (artifact.mimeType !== 'image/png') throw new Error(`${label} MIME type is not PNG.`);
    requireString(artifact.pixcliAssetHash, `${label} PixCLI hash`, /^[a-f0-9]{32}$/);
    requireString(artifact.providerRequestId, `${label} provider request id`);
  }
  const absolutePath = safeBundlePath(bundleDirectory, artifact.path, expectedPath, label);
  if (!existsSync(absolutePath)) throw new Error(`${label} PNG is missing.`);
  const inspected = inspectPng(readFileSync(absolutePath), label);
  for (const key of ['contentSha256', 'sizeBytes', 'width', 'height']) {
    if (inspected[key] !== artifact[key]) throw new Error(`${label} ${key} was tampered.`);
  }
  return { ...artifact, absolutePath };
}

function validateReviewDescriptor(descriptor, bundleDirectory, expectedDescriptorSha256) {
  const sourceNames = descriptor?.sourceNames === undefined ? SOURCE_NAMES : descriptor.sourceNames;
  if (
    !Array.isArray(sourceNames)
    || ![1, SOURCE_NAMES.length].includes(sourceNames.length)
    || sourceNames.some((sourceName) => !SOURCE_NAMES.includes(sourceName))
    || new Set(sourceNames).size !== sourceNames.length
    || (sourceNames.length === SOURCE_NAMES.length && canonicalJson(sourceNames) !== canonicalJson(SOURCE_NAMES))
  ) throw new Error('Review descriptor source selection is invalid.');
  exactKeys(descriptor, [
    'schemaVersion', 'descriptorType', 'bundleId', 'status', 'baseCommit', 'fighter',
    'poseManifest', ...(sourceNames.length === 1 ? ['sourceNames'] : []),
    'provider', 'cleanup', 'policy', 'sources', 'contactSheet', 'descriptorSha256',
  ], 'review descriptor');
  if (
    descriptor.schemaVersion !== 1
    || descriptor.descriptorType !== 'arcade_xai_canonical_bundle_review'
    || descriptor.status !== 'awaiting_human_review'
    || descriptor.baseCommit !== XAI_CANONICAL_BUNDLE_BASE_COMMIT
  ) {
    throw new Error('Review descriptor is not an awaiting-review canonical bundle.');
  }
  requireString(descriptor.bundleId, 'review descriptor bundle id');
  requireString(descriptor.descriptorSha256, 'review descriptor seal', /^[a-f0-9]{64}$/);
  const { descriptorSha256, ...unsigned } = descriptor;
  const computed = sha256(canonicalJson(unsigned));
  if (descriptorSha256 !== computed || descriptorSha256 !== expectedDescriptorSha256) {
    throw new Error('Review descriptor SHA-256 does not match the explicit reviewed seal.');
  }
  exactKeys(descriptor.fighter, ['slug', 'name', 'originalSha256'], 'review descriptor fighter');
  requireString(descriptor.fighter.slug, 'review descriptor slug', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  requireString(descriptor.fighter.name, 'review descriptor fighter name');
  requireString(descriptor.fighter.originalSha256, 'review descriptor photo hash', /^[a-f0-9]{64}$/);
  exactKeys(descriptor.poseManifest, ['id', 'contentSha256'], 'review descriptor pose manifest');
  requireString(descriptor.poseManifest.id, 'review descriptor pose manifest id');
  requireString(descriptor.poseManifest.contentSha256, 'review descriptor pose manifest hash', /^[a-f0-9]{64}$/);
  exactKeys(descriptor.provider, [
    'modelId', 'endpoint', 'provider', 'backend', 'auditedCostPerOutputUsd',
    'maximumCostPerOutputUsd', 'maximumBundleCostUsd', 'paidCalls', 'actualCostUsd',
  ], 'review descriptor provider');
  if (
    descriptor.provider.modelId !== XAI_CANONICAL_BUNDLE_MODEL.id
    || descriptor.provider.endpoint !== XAI_CANONICAL_BUNDLE_MODEL.endpoint
    || descriptor.provider.provider !== XAI_CANONICAL_BUNDLE_MODEL.provider
    || descriptor.provider.backend !== XAI_CANONICAL_BUNDLE_MODEL.backend
    || descriptor.provider.auditedCostPerOutputUsd !== XAI_CANONICAL_BUNDLE_MODEL.auditedCostUsd
    || descriptor.provider.maximumCostPerOutputUsd !== sealedPolicy(sourceNames).maximumCostPerOutputUsd
    || descriptor.provider.maximumBundleCostUsd !== sealedPolicy(sourceNames).maximumBundleCostUsd
    || descriptor.provider.paidCalls !== sourceNames.length
    || descriptor.provider.actualCostUsd !== Number((sourceNames.length * 0.11).toFixed(2))
  ) {
    throw new Error('Review descriptor generation or private-review policy changed.');
  }
  exactKeys(descriptor.cleanup, ['ffmpegVersion', 'filter'], 'review descriptor cleanup');
  if (
    descriptor.cleanup.ffmpegVersion !== XAI_CANONICAL_BUNDLE_CLEANUP.ffmpegVersion
    || descriptor.cleanup.filter !== XAI_CANONICAL_BUNDLE_CLEANUP.filter
  ) throw new Error('Review descriptor cleanup contract changed.');
  const expectedPolicy = sealedPolicy(sourceNames);
  exactKeys(descriptor.policy, Object.keys(expectedPolicy), 'review descriptor policy');
  if (canonicalJson(descriptor.policy) !== canonicalJson(expectedPolicy)) {
    throw new Error('Review descriptor generation or private-review policy changed.');
  }
  exactKeys(descriptor.sources, sourceNames, 'review descriptor sources');
  const sources = {};
  for (const sourceName of sourceNames) {
    const source = descriptor.sources[sourceName];
    exactKeys(source, [
      'references', 'promptSha256', 'requestSha256', 'pixcliJobId', 'providerRequestId', 'raw', 'clean',
    ], `${sourceName} review source`);
    requireString(source.promptSha256, `${sourceName} prompt SHA-256`, /^[a-f0-9]{64}$/);
    requireString(source.requestSha256, `${sourceName} request SHA-256`, /^[a-f0-9]{64}$/);
    requireString(source.pixcliJobId, `${sourceName} PixCLI job id`);
    requireString(source.providerRequestId, `${sourceName} provider request id`);
    exactKeys(source.references, ['pose', 'rendering', 'identity'], `${sourceName} references`);
    exactKeys(source.references.pose, ['id', 'contentSha256'], `${sourceName} pose reference`);
    exactKeys(source.references.rendering, ['id', 'contentSha256'], `${sourceName} rendering reference`);
    exactKeys(source.references.identity, ['contentSha256'], `${sourceName} identity reference`);
    requireString(source.references.pose.id, `${sourceName} pose reference id`);
    requireString(source.references.pose.contentSha256, `${sourceName} pose reference hash`, /^[a-f0-9]{64}$/);
    requireString(source.references.rendering.id, `${sourceName} rendering reference id`);
    requireString(source.references.rendering.contentSha256, `${sourceName} rendering reference hash`, /^[a-f0-9]{64}$/);
    if (source.references.identity.contentSha256 !== descriptor.fighter.originalSha256) {
      throw new Error(`${sourceName} identity reference does not match the reviewed fighter photo.`);
    }
    const raw = portableArtifact(
      source.raw,
      bundleDirectory,
      `sources/${sourceName}_raw.png`,
      `${sourceName} raw`,
      true,
    );
    const processed = portableArtifact(
      source.clean,
      bundleDirectory,
      `sources/${sourceName}.png`,
      `${sourceName} processed`,
      false,
    );
    if (raw.contentSha256 === processed.contentSha256) {
      throw new Error(`${sourceName} raw and processed sources are not a distinct reviewed pair.`);
    }
    if (raw.providerRequestId !== source.providerRequestId) {
      throw new Error(`${sourceName} raw provider request does not match the reviewed source.`);
    }
    sources[sourceName] = { raw, processed };
  }
  exactKeys(descriptor.contactSheet, ['path', 'contentSha256', 'sizeBytes', 'width', 'height', 'layout'], 'contact sheet');
  const contactPath = safeBundlePath(bundleDirectory, descriptor.contactSheet.path, 'contact-sheet.png', 'contact sheet');
  const contact = inspectPng(readFileSync(contactPath), 'contact sheet');
  for (const key of ['contentSha256', 'sizeBytes', 'width', 'height']) {
    if (contact[key] !== descriptor.contactSheet[key]) throw new Error(`Contact sheet ${key} was tampered.`);
  }
  const expectedLayout = sourceNames.length === 1
    ? [`${sourceNames[0]}_raw`, `${sourceNames[0]}_clean`]
    : ['side_raw', 'upright_raw', 'crouch_raw', 'side_clean', 'upright_clean', 'crouch_clean'];
  const expectedContactSize = sourceNames.length === 1
    ? { width: 768, height: 512 }
    : { width: 1152, height: 1024 };
  if (
    canonicalJson(descriptor.contactSheet.layout) !== canonicalJson(expectedLayout)
    || descriptor.contactSheet.width !== expectedContactSize.width
    || descriptor.contactSheet.height !== expectedContactSize.height
  ) {
    throw new Error('Contact sheet review layout changed.');
  }
  return { descriptor, sources, sourceNames };
}

function validateGenerationState(state, descriptor) {
  const sourceNames = descriptor.sourceNames === undefined ? SOURCE_NAMES : descriptor.sourceNames;
  exactKeys(state, [
    'schemaVersion', 'bundleId', 'fighterSlug', 'fighterName', 'originalSha256', 'poseManifestId',
    'poseManifestSha256', 'matrixSha256', 'status', 'createdAt', 'updatedAt', 'policy', 'uploads',
    ...(sourceNames.length === 1 ? ['sourceNames'] : []),
    'slots', 'lastCatalogPreflight', 'descriptorSha256', 'contactSheetSha256',
  ], 'generation state');
  if (
    state?.schemaVersion !== 1
    || state.status !== 'awaiting_human_review'
    || state.bundleId !== descriptor.bundleId
    || state.fighterSlug !== descriptor.fighter.slug
    || state.fighterName !== descriptor.fighter.name
    || state.originalSha256 !== descriptor.fighter.originalSha256
    || state.poseManifestId !== descriptor.poseManifest.id
    || state.poseManifestSha256 !== descriptor.poseManifest.contentSha256
    || state.descriptorSha256 !== descriptor.descriptorSha256
    || state.contactSheetSha256 !== descriptor.contactSheet.contentSha256
    || !/^[a-f0-9]{64}$/.test(state.matrixSha256 ?? '')
    || !/^\d{4}-\d{2}-\d{2}T/.test(state.createdAt ?? '')
    || !/^\d{4}-\d{2}-\d{2}T/.test(state.updatedAt ?? '')
    || canonicalJson(state.policy) !== canonicalJson(sealedPolicy(sourceNames))
    || canonicalJson(state.sourceNames) !== canonicalJson(descriptor.sourceNames)
    || !state.uploads || typeof state.uploads !== 'object' || Array.isArray(state.uploads)
  ) {
    throw new Error('Generation state does not match the reviewed descriptor.');
  }
  exactKeys(state.lastCatalogPreflight, ['modelId', 'catalogSha256', 'checkedAt'], 'generation model preflight');
  if (
    state.lastCatalogPreflight.modelId !== XAI_CANONICAL_BUNDLE_MODEL.id
    || !/^[a-f0-9]{64}$/.test(state.lastCatalogPreflight.catalogSha256 ?? '')
    || !/^\d{4}-\d{2}-\d{2}T/.test(state.lastCatalogPreflight.checkedAt ?? '')
  ) throw new Error('Generation model preflight does not match the sealed model.');
  exactKeys(state.slots, sourceNames, 'generation state slots');
  for (const sourceName of sourceNames) {
    const slot = state.slots[sourceName];
    const reviewed = descriptor.sources[sourceName];
    if (
      slot?.status !== 'completed'
      || slot.sourceName !== sourceName
      || slot.fighterSlug !== descriptor.fighter.slug
      || slot.originalSha256 !== descriptor.fighter.originalSha256
      || slot.poseSha256 !== reviewed.references.pose.contentSha256
      || slot.renderingSha256 !== reviewed.references.rendering.contentSha256
      || slot.promptSha256 !== reviewed.promptSha256
      || slot.promptProfile !== (sourceNames.length === 1
        ? resolveXaiCanonicalSingleSourcePromptProfile(descriptor.fighter.slug, sourceName)
        : undefined)
      || slot.modelId !== XAI_CANONICAL_BUNDLE_MODEL.id
      || slot.requestSha256 !== reviewed.requestSha256
      || slot.pixcliJobId !== reviewed.pixcliJobId
      || slot.raw?.contentSha256 !== reviewed.raw.contentSha256
      || slot.clean?.contentSha256 !== reviewed.clean.contentSha256
      || slot.audit?.providerRun?.requestId !== reviewed.providerRequestId
      || slot.audit?.providerRun?.requestId !== reviewed.raw.providerRequestId
      || slot.audit?.inputSha256 !== reviewed.requestSha256
      || slot.audit?.costMicrocredits !== XAI_CANONICAL_BUNDLE_MODEL.auditedCostMicrocredits
      || slot.audit?.costUsd !== 0.11
      || slot.cleanupFfmpegVersion !== XAI_CANONICAL_BUNDLE_CLEANUP.ffmpegVersion
    ) {
      throw new Error(`${sourceName} generation state is not the exact completed reviewed source.`);
    }
  }
  return state;
}

function reviewedUpload(state, reference, label) {
  const upload = state.uploads[`reference:${reference.contentSha256}`];
  if (
    upload?.status !== 'uploaded'
    || upload.id !== reference.id
    || upload.contentSha256 !== reference.contentSha256
    || upload.sourceSha256 !== reference.contentSha256
    || !/^[a-f0-9]{32}$/.test(upload.pixcliAssetHash ?? '')
  ) throw new Error(`${label} upload state is not sealed to the reviewed reference.`);
  return upload;
}

export function validateBundlePromptAndRequest(bundle, rosterFighter) {
  const promptProfile = bundle.sourceNames.length === 1
    ? resolveXaiCanonicalSingleSourcePromptProfile(rosterFighter.slug, bundle.sourceNames[0])
    : undefined;
  const identityReference = {
    id: `identity-${rosterFighter.slug}`,
    contentSha256: rosterFighter.reference.sourceSha256,
  };
  for (const sourceName of bundle.sourceNames) {
    const reviewed = bundle.descriptor.sources[sourceName];
    if (sha256(buildXaiCanonicalBundlePrompt(
      rosterFighter,
      sourceName,
      { promptProfile },
    )) !== reviewed.promptSha256) {
      throw new Error(`${sourceName} reviewed prompt does not match the immutable roster prompt.`);
    }
    const pose = reviewedUpload(bundle.state, reviewed.references.pose, `${sourceName} pose`);
    const rendering = reviewedUpload(bundle.state, reviewed.references.rendering, `${sourceName} rendering`);
    const identity = reviewedUpload(bundle.state, identityReference, `${sourceName} identity`);
    const payload = buildXaiCanonicalBundlePayload({
      fighter: rosterFighter,
      sourceName,
      promptProfile,
      poseAssetHash: pose.pixcliAssetHash,
      renderingAssetHash: rendering.pixcliAssetHash,
      identityAssetHash: identity.pixcliAssetHash,
    });
    if (sha256(canonicalJson(payload)) !== reviewed.requestSha256) {
      throw new Error(`${sourceName} reviewed request does not match the sealed three-reference payload.`);
    }
  }
}

export function loadReviewedCanonicalBundle(options) {
  const bundleDirectory = resolve(options.bundleDirectory);
  const expectedDescriptorSha256 = requireString(
    options.reviewedDescriptorSha256,
    'explicit reviewed descriptor SHA-256',
    /^[a-f0-9]{64}$/,
  );
  const descriptor = readJson(join(bundleDirectory, 'review-descriptor.json'), 'review descriptor');
  const validated = validateReviewDescriptor(descriptor, bundleDirectory, expectedDescriptorSha256);
  const state = validateGenerationState(
    readJson(join(bundleDirectory, 'generation-state.json'), 'generation state'),
    descriptor,
  );
  return { ...validated, state, bundleDirectory };
}

function currentHashKey(kind) {
  if (kind === 'side') return 'side';
  if (kind === 'side_raw') return 'sideRaw';
  if (kind === 'upright') return 'upright';
  if (kind === 'upright_raw') return 'uprightRaw';
  if (kind === 'crouch') return 'crouch';
  if (kind === 'crouch_raw') return 'crouchRaw';
  throw new Error(`Unsupported import source kind: ${kind}.`);
}

function sourceOperations(bundle) {
  return SOURCE_NAMES.flatMap((sourceName) => [
    {
      sourceName,
      kind: sourceName,
      artifact: bundle.sources[sourceName].processed,
    },
    {
      sourceName,
      kind: `${sourceName}_raw`,
      artifact: bundle.sources[sourceName].raw,
    },
  ]);
}

function assertProductionFighter(detail, fighterId, rosterFighter) {
  const fighter = detail?.fighter;
  if (
    !fighter
    || fighter.id !== fighterId
    || fighter.name !== rosterFighter.name
    || fighter.photoHash !== rosterFighter.reference.sourceSha256
    || fighter.qualityTier !== 'champion'
    || fighter.public !== false
    || !fighter.sources?.original
    || fighter.sourceHashes?.original !== rosterFighter.reference.sourceSha256
  ) {
    throw new Error('Production fighter identity, privacy, tier, or licensed photo does not match the reviewed roster.');
  }
  return fighter;
}

function remoteHash(fighter, kind) {
  return fighter.sourceHashes?.[currentHashKey(kind)] ?? null;
}

function initialImportState(options, bundle, fighterId) {
  return {
    schemaVersion: 1,
    status: 'importing',
    bundleRunId: String(options.bundleRunId),
    bundleId: bundle.descriptor.bundleId,
    descriptorSha256: bundle.descriptor.descriptorSha256,
    slug: bundle.descriptor.fighter.slug,
    fighterId,
    photoHash: bundle.descriptor.fighter.originalSha256,
    qaDecision: REVIEWED_CANONICAL_QA_DECISION,
    safetyConfirmation: REVIEWED_CANONICAL_IMPORT_SAFETY_CONFIRMATION,
    uploads: {},
  };
}

function validateImportState(state, expected) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('Import checkpoint is not a sealed object.');
  }
  if (!['importing', 'completed'].includes(state.status)) throw new Error('Import checkpoint status is invalid.');
  exactKeys(
    state,
    state.status === 'completed'
      ? [...Object.keys(expected), 'reviewedManifestSha256']
      : Object.keys(expected),
    'import checkpoint',
  );
  for (const key of [
    'schemaVersion', 'bundleRunId', 'bundleId', 'descriptorSha256', 'slug', 'fighterId',
    'photoHash', 'qaDecision', 'safetyConfirmation',
  ]) {
    if (state[key] !== expected[key]) throw new Error(`Import checkpoint mismatch: ${key}.`);
  }
  if (!state.uploads || typeof state.uploads !== 'object' || Array.isArray(state.uploads)) {
    throw new Error('Import checkpoint uploads are invalid.');
  }
  const unknown = Object.keys(state.uploads).filter((kind) => !SOURCE_KINDS.includes(kind));
  if (unknown.length > 0) throw new Error('Import checkpoint contains an unknown source mutation.');
  for (const [kind, upload] of Object.entries(state.uploads)) {
    if (!upload || typeof upload !== 'object' || Array.isArray(upload)) {
      throw new Error(`${kind} import checkpoint mutation is invalid.`);
    }
    const statuses = ['uploading', 'outcome_unknown', 'verified', 'verified_existing', 'reconciled'];
    if (!statuses.includes(upload.status) || !/^[a-f0-9]{64}$/.test(upload.expectedSha256 ?? '')) {
      throw new Error(`${kind} import checkpoint mutation is invalid.`);
    }
    exactKeys(
      upload,
      upload.status === 'outcome_unknown' && Object.hasOwn(upload, 'error')
        ? ['status', 'expectedSha256', 'error']
        : ['status', 'expectedSha256'],
      `${kind} import checkpoint mutation`,
    );
    if (Object.hasOwn(upload, 'error') && typeof upload.error !== 'string') {
      throw new Error(`${kind} import checkpoint error is invalid.`);
    }
  }
  if (state.status === 'completed' && !/^[a-f0-9]{64}$/.test(state.reviewedManifestSha256 ?? '')) {
    throw new Error('Import checkpoint reviewed manifest hash is invalid.');
  }
}

function reviewedCurrentManifest(bundle, fighterId) {
  return {
    schemaVersion: 1,
    canonicalSourceMode: REVIEWED_CANONICAL_SOURCE_MODE,
    slug: bundle.descriptor.fighter.slug,
    fighterId,
    photoHash: bundle.descriptor.fighter.originalSha256,
    canonicalSourceHashes: Object.fromEntries(SOURCE_NAMES.map((sourceName) => [sourceName, {
      processedSha256: bundle.sources[sourceName].processed.contentSha256,
      rawSha256: bundle.sources[sourceName].raw.contentSha256,
    }])),
  };
}

function assertReviewedCurrentManifest(value) {
  exactKeys(value, [
    'schemaVersion', 'canonicalSourceMode', 'slug', 'fighterId', 'photoHash', 'canonicalSourceHashes',
  ], 'reviewed-current manifest');
  if (
    value.schemaVersion !== 1
    || value.canonicalSourceMode !== REVIEWED_CANONICAL_SOURCE_MODE
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug)
    || !/^[a-f0-9]{32}$/.test(value.fighterId)
    || !/^[a-f0-9]{64}$/.test(value.photoHash)
  ) throw new Error('Reviewed-current manifest identity is invalid.');
  exactKeys(value.canonicalSourceHashes, SOURCE_NAMES, 'reviewed-current hashes');
  for (const sourceName of SOURCE_NAMES) {
    const pair = value.canonicalSourceHashes[sourceName];
    exactKeys(pair, ['processedSha256', 'rawSha256'], `${sourceName} reviewed-current hashes`);
    if (!/^[a-f0-9]{64}$/.test(pair.processedSha256) || !/^[a-f0-9]{64}$/.test(pair.rawSha256)) {
      throw new Error(`${sourceName} reviewed-current hashes are invalid.`);
    }
  }
  return value;
}

async function uploadSource(requestApi, fighterId, operation) {
  const form = new FormData();
  form.set('kind', operation.kind);
  form.set('file', new Blob([readFileSync(operation.artifact.absolutePath)], { type: 'image/png' }), `${operation.kind}.png`);
  return requestApi(`/api/fighters/${encodeURIComponent(fighterId)}/sources`, {
    method: 'POST',
    body: form,
  });
}

export async function runReviewedCanonicalImport(options = {}) {
  if (options.confirmation !== REVIEWED_CANONICAL_IMPORT_CONFIRMATION) {
    throw new Error(`Import requires confirmation ${REVIEWED_CANONICAL_IMPORT_CONFIRMATION}.`);
  }
  if (options.qaDecision !== REVIEWED_CANONICAL_QA_DECISION) {
    throw new Error(`Import requires explicit QA decision ${REVIEWED_CANONICAL_QA_DECISION}.`);
  }
  if (options.safetyConfirmation !== REVIEWED_CANONICAL_IMPORT_SAFETY_CONFIRMATION) {
    throw new Error(`Import requires safety confirmation ${REVIEWED_CANONICAL_IMPORT_SAFETY_CONFIRMATION}.`);
  }
  const bundleRunId = requireString(String(options.bundleRunId ?? ''), 'bundle artifact run id', /^[1-9][0-9]*$/);
  const slug = requireString(options.slug, 'explicit roster slug', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  const reviewedBy = requireString(options.reviewedBy, 'review actor');
  requireString(options.bundleDirectory, 'private bundle directory');
  const outputDirectoryInput = requireString(options.outputDirectory, 'private import output directory');
  const bundle = loadReviewedCanonicalBundle(options);
  if (canonicalJson(bundle.sourceNames) !== canonicalJson(SOURCE_NAMES)) {
    throw new Error('The six-source importer requires a complete three-source reviewed bundle.');
  }
  if (bundle.descriptor.fighter.slug !== slug) throw new Error('Reviewed bundle belongs to a different fighter slug.');

  const roster = JSON.parse(readFileSync(options.rosterPath ?? DEFAULT_ROSTER_PATH, 'utf8'));
  validateManifest(roster);
  const matches = roster.fighters.filter((fighter) => fighter.slug === slug);
  if (matches.length !== 1) throw new Error('Reviewed import roster fighter is missing or ambiguous.');
  const rosterFighter = matches[0];
  if (
    rosterFighter.name !== bundle.descriptor.fighter.name
    || rosterFighter.reference.sourceSha256 !== bundle.descriptor.fighter.originalSha256
  ) throw new Error('Reviewed bundle fighter or photo does not match the immutable roster.');
  validateBundlePromptAndRequest(bundle, rosterFighter);

  const requestApi = options.requestApi;
  if (typeof requestApi !== 'function') throw new Error('Authenticated production request client is required.');
  const admin = await requestApi('/api/admin/arcade');
  const entries = (Array.isArray(admin?.fighters) ? admin.fighters : [])
    .filter((entry) => entry?.slug === slug && entry?.status !== 'retired');
  if (entries.length !== 1 || entries[0].status !== 'draft' || !/^[a-f0-9]{32}$/.test(entries[0].fighterId ?? '')) {
    throw new Error('Reviewed import requires exactly one current private draft Arcade fighter.');
  }
  const fighterId = entries[0].fighterId;
  let detail = await requestApi(`/api/fighters/${encodeURIComponent(fighterId)}`);
  let fighter = assertProductionFighter(detail, fighterId, rosterFighter);

  const outputDirectory = resolve(outputDirectoryInput);
  const statePath = options.statePath ?? join(outputDirectory, 'import-state.json');
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const expectedState = initialImportState({ ...options, bundleRunId }, bundle, fighterId);
  let state = existsSync(statePath) ? readJson(statePath, 'import checkpoint') : expectedState;
  validateImportState(state, expectedState);
  const saveState = () => writeJsonAtomic(statePath, state);
  saveState();

  for (const operation of sourceOperations(bundle)) {
    const previous = state.uploads[operation.kind] ?? null;
    const expectedHash = operation.artifact.contentSha256;
    const current = remoteHash(fighter, operation.kind);
    if (previous) {
      if (previous.expectedSha256 !== expectedHash) throw new Error(`${operation.kind} import checkpoint hash changed.`);
      if (['verified', 'verified_existing', 'reconciled'].includes(previous.status)) {
        if (current !== expectedHash) throw new Error(`${operation.kind} current source changed after reviewed import.`);
        continue;
      }
      if (previous.status === 'uploading' || previous.status === 'outcome_unknown') {
        if (current === expectedHash) {
          state.uploads[operation.kind] = { ...previous, status: 'reconciled' };
          saveState();
          continue;
        }
        throw new Error(`${operation.kind} has an ambiguous prior upload and cannot be re-POSTed.`);
      }
      throw new Error(`${operation.kind} import checkpoint is terminal.`);
    }
    if (current === expectedHash) {
      state.uploads[operation.kind] = { status: 'verified_existing', expectedSha256: expectedHash };
      saveState();
      continue;
    }
    state.uploads[operation.kind] = { status: 'uploading', expectedSha256: expectedHash };
    saveState();
    try {
      await uploadSource(requestApi, fighterId, operation);
    } catch (error) {
      state.uploads[operation.kind] = {
        status: 'outcome_unknown',
        expectedSha256: expectedHash,
        error: error instanceof Error ? error.message : String(error),
      };
      saveState();
      throw new Error(`${operation.kind} upload outcome is unknown; automatic re-POST is forbidden.`);
    }
    detail = await requestApi(`/api/fighters/${encodeURIComponent(fighterId)}`);
    fighter = assertProductionFighter(detail, fighterId, rosterFighter);
    if (remoteHash(fighter, operation.kind) !== expectedHash) {
      state.uploads[operation.kind] = { status: 'outcome_unknown', expectedSha256: expectedHash };
      saveState();
      throw new Error(`${operation.kind} did not become the exact current reviewed source.`);
    }
    state.uploads[operation.kind] = { status: 'verified', expectedSha256: expectedHash };
    saveState();
  }

  detail = await requestApi(`/api/fighters/${encodeURIComponent(fighterId)}`);
  fighter = assertProductionFighter(detail, fighterId, rosterFighter);
  for (const operation of sourceOperations(bundle)) {
    if (remoteHash(fighter, operation.kind) !== operation.artifact.contentSha256) {
      throw new Error(`Final current source revalidation failed: ${operation.kind}.`);
    }
    const responseKey = currentHashKey(operation.kind);
    if (typeof fighter.sources?.[responseKey] !== 'string' || !fighter.sources[responseKey]) {
      throw new Error(`Final current source URL is missing: ${operation.kind}.`);
    }
  }
  const reviewedManifest = assertReviewedCurrentManifest(reviewedCurrentManifest(bundle, fighterId));
  const manifestPath = join(outputDirectory, 'reviewed-canonical-manifest.json');
  writeJsonAtomic(manifestPath, reviewedManifest);
  const receipt = {
    schemaVersion: 1,
    receiptType: 'reviewed_canonical_source_import',
    status: 'completed',
    bundleRunId,
    bundleId: bundle.descriptor.bundleId,
    descriptorSha256: bundle.descriptor.descriptorSha256,
    slug,
    fighterId,
    photoHash: rosterFighter.reference.sourceSha256,
    qaDecision: REVIEWED_CANONICAL_QA_DECISION,
    safetyConfirmation: REVIEWED_CANONICAL_IMPORT_SAFETY_CONFIRMATION,
    reviewedBy,
    canonicalSourceMode: REVIEWED_CANONICAL_SOURCE_MODE,
    manifestSha256: sha256(canonicalJson(reviewedManifest)),
    generationStarted: false,
    approvedAutomatically: false,
    activated: false,
  };
  writeJsonAtomic(join(outputDirectory, 'import-receipt.json'), receipt);
  state.status = 'completed';
  state.reviewedManifestSha256 = receipt.manifestSha256;
  saveState();
  return { state, receipt, reviewedManifest, outputDirectory, manifestPath };
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('The Arcade admin credential is not a Clerk JWT.');
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('The Arcade admin JWT payload cannot be decoded.');
  }
}

async function clerkJson(secretKey, path, init = {}) {
  const response = await fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`Clerk ${path} failed with HTTP ${response.status}.`);
  return body;
}

export async function createAdminTokenProvider(secretKey, userId) {
  const listed = await clerkJson(secretKey, `/sessions?${new URLSearchParams({ user_id: userId, status: 'active', limit: '20' })}`);
  const sessions = Array.isArray(listed.data) ? listed.data : Array.isArray(listed) ? listed : [];
  const session = sessions.find((entry) => entry?.user_id === userId && entry?.status === 'active');
  if (!session?.id) throw new Error('Configured Arcade admin has no active Clerk session.');
  let token = '';
  let expiresAt = 0;
  return async () => {
    if (token && expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS) return token;
    const created = await clerkJson(secretKey, `/sessions/${encodeURIComponent(session.id)}/tokens`, {
      method: 'POST',
      body: JSON.stringify({ expires_in_seconds: TOKEN_TTL_SECONDS }),
    });
    if (typeof created.jwt !== 'string' || !created.jwt) throw new Error('Clerk returned no admin JWT.');
    const claims = decodeJwtPayload(created.jwt);
    if (claims.sub !== userId) throw new Error('Clerk returned a token for another user.');
    token = created.jwt;
    expiresAt = Number(claims.exp ?? 0) * 1000;
    return token;
  };
}

export function authenticatedRequestClient(baseUrl, getToken, bridgeSecret) {
  return async (path, init = {}) => {
    const token = await getToken();
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Insert-Player-Admin-Seed': 'clerk-backend',
        'X-Insert-Player-Clerk-Backend-Auth': bridgeSecret,
        ...(init.headers ?? {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`${init.method ?? 'GET'} ${path} redirected; authenticated API redirects are forbidden.`);
    }
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${init.method ?? 'GET'} ${path} returned non-JSON HTTP ${response.status}.`);
    }
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}.`);
    return body;
  };
}

export function authenticatedAssetClient(baseUrl, getToken, bridgeSecret) {
  return async (path) => {
    if (typeof path !== 'string' || !path.startsWith('/assets/') || path.includes('?') || path.includes('#')) {
      throw new Error('Private source asset path is invalid.');
    }
    const token = await getToken();
    return fetch(`${baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Insert-Player-Admin-Seed': 'clerk-backend',
        'X-Insert-Player-Clerk-Backend-Auth': bridgeSecret,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  };
}

function parseArg(args, name, fallback = '') {
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--execute-production')) throw new Error('Import requires --execute-production.');
  const clerkSecret = process.env.ASF_ARCADE_CLERK_SECRET_KEY?.trim() ?? '';
  const clerkUserId = process.env.ASF_ARCADE_ADMIN_CLERK_USER_ID?.trim() ?? '';
  const bridgeSecret = process.env.CLERK_BACKEND_AUTH_BRIDGE_SECRET?.trim() ?? '';
  if (!clerkSecret || !clerkUserId || bridgeSecret.length < 32) {
    throw new Error('Production Clerk admin secrets are incomplete.');
  }
  const workerUrl = (process.env.ASF_WORKER_URL?.trim() || 'https://api.insertplayer.ai').replace(/\/+$/, '');
  if (!workerUrl.startsWith('https://')) throw new Error('Production Worker URL must use HTTPS.');
  const getToken = await createAdminTokenProvider(clerkSecret, clerkUserId);
  const outputDirectory = resolve(parseArg(args, '--output-dir'));
  const result = await runReviewedCanonicalImport({
    confirmation: parseArg(args, '--confirm'),
    qaDecision: parseArg(args, '--qa-decision'),
    safetyConfirmation: parseArg(args, '--confirm-safety'),
    bundleRunId: parseArg(args, '--bundle-run-id'),
    reviewedDescriptorSha256: parseArg(args, '--reviewed-descriptor-sha256'),
    slug: parseArg(args, '--slug'),
    reviewedBy: parseArg(args, '--reviewed-by'),
    rosterPath: parseArg(args, '--roster', DEFAULT_ROSTER_PATH),
    bundleDirectory: resolve(parseArg(args, '--bundle-dir')),
    outputDirectory,
    statePath: parseArg(args, '--state', join(outputDirectory, 'import-state.json')),
    requestApi: authenticatedRequestClient(workerUrl, getToken, bridgeSecret),
  });
  console.log(`Reviewed canonical sources imported for ${result.reviewedManifest.slug}; no generation or activation started.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
