import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authenticatedAssetClient,
  authenticatedRequestClient,
  createAdminTokenProvider,
} from './import-reviewed-xai-canonical-bundle.mjs';
import { inspectPng } from './arcade-xai-canonical-bundle.mjs';
import {
  INSERT_PLAYER_PRODUCTION_WORKER_ORIGIN,
  normalizeProductionWorkerUrl,
  parsePrivateSourceUrl,
  readBoundedPngResponse,
} from './import-reviewed-manual-canonical-set.mjs';
import {
  REVIEWED_CANONICAL_SOURCE_MODE,
  assertReviewGatedVideoExtraFighter,
  assertReviewedCanonicalManifest,
  validateManifest,
} from './seed-arcade-roster.mjs';

/**
 * Seal the CURRENT live canonical sources of an active official Champion into
 * a reviewed-current-v1 manifest, so review-gated extra Video moves can start.
 *
 * Read-only by construction: it never POSTs sources, calls a provider,
 * starts generation, or activates anything. It keeps the human review the
 * source importers provide, in two separately confirmed phases:
 *
 *   review -> download the six live PNGs, write them plus a review
 *             descriptor (exact version ids, R2 keys, SHA-256, dimensions).
 *             No manifest is produced.
 *   seal   -> a human looked at those PNGs and passes the descriptor SHA-256
 *             with an explicit QA decision. The script re-reads the live
 *             sources; only if they are still byte-identical to the approved
 *             descriptor does it emit the reviewed canonical manifest.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_ROSTER_PATH = join(root, 'arcade/roster-2026.json');

export const LIVE_CANONICAL_SEAL_SLUGS = Object.freeze(['rosalia-v2', 'lamine-yamal', 'elon-musk', 'donald-trump']);
export const LIVE_CANONICAL_REVIEW_CONFIRMATION = 'REVIEW_LIVE_CANONICAL_SOURCES_PRODUCTION_V1';
export const LIVE_CANONICAL_SEAL_CONFIRMATION = 'SEAL_LIVE_CANONICAL_SOURCES_PRODUCTION_V1';
export const LIVE_CANONICAL_SEAL_QA_DECISION = 'APPROVE_LIVE_CANONICAL_SOURCES_V1';
export const LIVE_CANONICAL_SEAL_SAFETY_CONFIRMATION = 'SOURCES_ONLY_NO_PROVIDER_NO_GENERATION_NO_ACTIVATION';
export const LIVE_CANONICAL_REVIEW_DESCRIPTOR_TYPE = 'live_canonical_source_seal_review_v1';
export const LIVE_CANONICAL_SOURCE_KINDS = Object.freeze([
  'side', 'side_raw', 'upright', 'upright_raw', 'crouch', 'crouch_raw',
]);

const SOURCE_NAMES = Object.freeze(['side', 'upright', 'crouch']);
const RESPONSE_KEYS = Object.freeze({
  side: 'side', side_raw: 'sideRaw', upright: 'upright', upright_raw: 'uprightRaw',
  crouch: 'crouch', crouch_raw: 'crouchRaw',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function liveCanonicalDescriptorSha256(descriptor) {
  return sha256(canonicalJson(descriptor));
}

function writePrivate(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.writing-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, bytes, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function writeJson(path, value) {
  writePrivate(path, `${JSON.stringify(value, null, 2)}\n`);
}

function requireSlug(slug) {
  if (!LIVE_CANONICAL_SEAL_SLUGS.includes(slug)) {
    throw new Error(`Live canonical sealing is restricted to ${LIVE_CANONICAL_SEAL_SLUGS.join(', ')}.`);
  }
  return slug;
}

function requireSafety(value) {
  if (value !== LIVE_CANONICAL_SEAL_SAFETY_CONFIRMATION) {
    throw new Error(`Live canonical sealing requires safety confirmation ${LIVE_CANONICAL_SEAL_SAFETY_CONFIRMATION}.`);
  }
}

/** Read the exact live state of one active official Champion: identity plus six verified source PNGs. */
export async function readLiveCanonicalSources({ slug, roster, requestApi, requestAsset }) {
  requireSlug(slug);
  validateManifest(roster);
  const matches = roster.fighters.filter((entry) => entry.slug === slug);
  if (matches.length !== 1) throw new Error(`${slug} is missing or ambiguous in the reviewed roster.`);
  const rosterFighter = matches[0];
  if (typeof requestApi !== 'function' || typeof requestAsset !== 'function') {
    throw new Error('Authenticated production JSON and bounded asset clients are required.');
  }
  const admin = await requestApi('/api/admin/arcade');
  const entries = (Array.isArray(admin?.fighters) ? admin.fighters : [])
    .filter((entry) => entry?.slug === slug && entry?.status !== 'retired');
  if (entries.length !== 1) throw new Error(`Live canonical sealing requires exactly one current ${slug} Arcade fighter.`);
  const entry = entries[0];
  if (entry.status !== 'active') throw new Error(`${slug} is not an active official fighter.`);
  const detail = await requestApi(`/api/fighters/${encodeURIComponent(entry.fighterId ?? '')}`);
  const fighter = detail?.fighter;
  const photoHash = rosterFighter.reference?.sourceSha256;
  const { fighterId } = assertReviewGatedVideoExtraFighter({
    manifest: roster, fighter: rosterFighter, entry, owned: fighter, approvedPhotoHash: photoHash,
  });

  const sources = {};
  const assets = {};
  const owners = new Set();
  for (const kind of LIVE_CANONICAL_SOURCE_KINDS) {
    const pointer = fighter.sources?.[RESPONSE_KEYS[kind]] ?? null;
    const hash = fighter.sourceHashes?.[kind] ?? null;
    if (!pointer || !/^[a-f0-9]{64}$/.test(hash ?? '')) {
      throw new Error(`${slug} has no complete current ${kind} source; nothing can be sealed.`);
    }
    const parsed = parsePrivateSourceUrl(pointer, fighterId, kind);
    const bytes = await readBoundedPngResponse(await requestAsset(parsed.path), `${kind} live source`);
    const inspected = inspectPng(bytes, `${kind} live source`);
    if (inspected.contentSha256 !== hash) {
      throw new Error(`${kind} live source bytes do not match the fighter's current source hash.`);
    }
    owners.add(parsed.ownerUserId);
    sources[kind] = {
      versionId: parsed.versionId,
      blobKey: parsed.blobKey,
      contentSha256: inspected.contentSha256,
      sizeBytes: inspected.sizeBytes,
      width: inspected.width,
      height: inspected.height,
      filename: `${kind}.png`,
    };
    assets[kind] = bytes;
  }
  if (owners.size !== 1) throw new Error('Live canonical sources do not share one owner.');
  const descriptor = {
    schemaVersion: 1,
    descriptorType: LIVE_CANONICAL_REVIEW_DESCRIPTOR_TYPE,
    fighter: { slug, name: rosterFighter.name, fighterId, photoHash },
    sources,
  };
  return { descriptor, descriptorSha256: liveCanonicalDescriptorSha256(descriptor), assets };
}

/** Phase 1: export the live sources for a human review. Produces no manifest. */
export async function runLiveCanonicalReview(options) {
  if (options.confirmation !== LIVE_CANONICAL_REVIEW_CONFIRMATION) {
    throw new Error(`Review requires confirmation ${LIVE_CANONICAL_REVIEW_CONFIRMATION}.`);
  }
  requireSafety(options.safetyConfirmation);
  const live = await readLiveCanonicalSources(options);
  const output = resolve(options.outputDirectory);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  for (const kind of LIVE_CANONICAL_SOURCE_KINDS) writePrivate(join(output, `${kind}.png`), live.assets[kind]);
  writeJson(join(output, 'live-canonical-review-descriptor.json'), live.descriptor);
  writeJson(join(output, 'live-canonical-review-receipt.json'), {
    schemaVersion: 1,
    receiptType: 'live_canonical_source_review_export_v1',
    slug: live.descriptor.fighter.slug,
    fighterId: live.descriptor.fighter.fighterId,
    descriptorSha256: live.descriptorSha256,
    providerCalls: 0, sourceMutations: 0, generationStarted: false, activated: false, manifestProduced: false,
  });
  return live;
}

/** Phase 2: seal exactly the approved live sources into a reviewed canonical manifest. */
export async function runLiveCanonicalSeal(options) {
  if (options.confirmation !== LIVE_CANONICAL_SEAL_CONFIRMATION) {
    throw new Error(`Seal requires confirmation ${LIVE_CANONICAL_SEAL_CONFIRMATION}.`);
  }
  if (options.qaDecision !== LIVE_CANONICAL_SEAL_QA_DECISION) {
    throw new Error(`Seal requires QA decision ${LIVE_CANONICAL_SEAL_QA_DECISION}.`);
  }
  requireSafety(options.safetyConfirmation);
  if (!/^[a-f0-9]{64}$/.test(options.approvedDescriptorSha256 ?? '')) {
    throw new Error('Seal requires the exact approved review descriptor SHA-256.');
  }
  const reviewedBy = typeof options.reviewedBy === 'string' ? options.reviewedBy.trim() : '';
  if (!reviewedBy) throw new Error('Seal requires the reviewing actor.');
  if (options.approvedDescriptor !== undefined) {
    if (liveCanonicalDescriptorSha256(options.approvedDescriptor) !== options.approvedDescriptorSha256) {
      throw new Error('The approved review descriptor file does not match its SHA-256.');
    }
  }
  const live = await readLiveCanonicalSources(options);
  if (live.descriptorSha256 !== options.approvedDescriptorSha256) {
    throw new Error('Live canonical sources changed since the approved review; review them again.');
  }
  const { fighter, sources } = live.descriptor;
  const manifest = assertReviewedCanonicalManifest({
    schemaVersion: 1,
    canonicalSourceMode: REVIEWED_CANONICAL_SOURCE_MODE,
    slug: fighter.slug,
    fighterId: fighter.fighterId,
    photoHash: fighter.photoHash,
    canonicalSourceHashes: Object.fromEntries(SOURCE_NAMES.map((name) => [name, {
      processedSha256: sources[name].contentSha256,
      rawSha256: sources[`${name}_raw`].contentSha256,
    }])),
  }, { slug: fighter.slug, fighterId: fighter.fighterId, photoHash: fighter.photoHash });
  const manifestSha256 = sha256(canonicalJson(manifest));
  const operatorUnsigned = {
    schemaVersion: 1,
    manifestType: 'live_canonical_source_seal_operator_manifest_v1',
    status: 'sealed_current_sources_only',
    descriptorSha256: live.descriptorSha256,
    fighter,
    reviewedBy,
    review: { decision: LIVE_CANONICAL_SEAL_QA_DECISION, reviewedDescriptorType: LIVE_CANONICAL_REVIEW_DESCRIPTOR_TYPE },
    sources,
    reviewedCurrentManifest: manifest,
    reviewedCurrentManifestSha256: manifestSha256,
    safety: {
      providerCalls: 0, sourceMutations: 0, generationStarted: false,
      approvedAutomatically: false, activated: false,
    },
  };
  const operatorManifest = { ...operatorUnsigned, operatorManifestSha256: sha256(canonicalJson(operatorUnsigned)) };
  const output = resolve(options.outputDirectory);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeJson(join(output, 'reviewed-canonical-manifest.json'), manifest);
  writeJson(join(output, 'reviewed-canonical-operator-manifest.json'), operatorManifest);
  const receipt = {
    schemaVersion: 1,
    receiptType: 'live_canonical_source_seal_v1',
    status: 'sealed_current_sources_only',
    slug: fighter.slug,
    fighterId: fighter.fighterId,
    photoHash: fighter.photoHash,
    descriptorSha256: live.descriptorSha256,
    qaDecision: LIVE_CANONICAL_SEAL_QA_DECISION,
    safetyConfirmation: LIVE_CANONICAL_SEAL_SAFETY_CONFIRMATION,
    reviewedBy,
    operatorManifestSha256: operatorManifest.operatorManifestSha256,
    reviewedManifestSha256: manifestSha256,
    providerCalls: 0, sourceMutations: 0, generationStarted: false, approvedAutomatically: false, activated: false,
  };
  writeJson(join(output, 'import-receipt.json'), receipt);
  return { manifest, operatorManifest, receipt };
}

function parseArg(args, name, fallback = '') {
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--execute-production')) throw new Error('Live canonical sealing requires --execute-production.');
  const mode = parseArg(args, '--mode');
  if (!['review', 'seal'].includes(mode)) throw new Error('--mode must be review or seal.');
  const clerkSecret = process.env.ASF_ARCADE_CLERK_SECRET_KEY?.trim() ?? '';
  const clerkUserId = process.env.ASF_ARCADE_ADMIN_CLERK_USER_ID?.trim() ?? '';
  const bridgeSecret = process.env.CLERK_BACKEND_AUTH_BRIDGE_SECRET?.trim() ?? '';
  if (!clerkSecret || !clerkUserId || bridgeSecret.length < 32) {
    throw new Error('Production Clerk admin secrets are incomplete.');
  }
  const workerUrl = normalizeProductionWorkerUrl(process.env.ASF_WORKER_URL?.trim() || INSERT_PLAYER_PRODUCTION_WORKER_ORIGIN);
  let tokenProviderPromise;
  const getToken = async () => {
    tokenProviderPromise ??= createAdminTokenProvider(clerkSecret, clerkUserId);
    return (await tokenProviderPromise)();
  };
  const common = {
    slug: parseArg(args, '--slug'),
    roster: JSON.parse(readFileSync(parseArg(args, '--roster', DEFAULT_ROSTER_PATH), 'utf8')),
    safetyConfirmation: parseArg(args, '--confirm-safety'),
    confirmation: parseArg(args, '--confirm'),
    outputDirectory: parseArg(args, '--output-dir'),
    requestApi: authenticatedRequestClient(workerUrl, getToken, bridgeSecret),
    requestAsset: authenticatedAssetClient(workerUrl, getToken, bridgeSecret),
  };
  if (!common.outputDirectory) throw new Error('--output-dir is required.');
  if (mode === 'review') {
    const result = await runLiveCanonicalReview(common);
    console.log(`Live canonical review export for ${common.slug}: descriptorSha256=${result.descriptorSha256}; providerCalls=0, no manifest produced.`);
    return;
  }
  const approvedPath = parseArg(args, '--approved-descriptor');
  const result = await runLiveCanonicalSeal({
    ...common,
    qaDecision: parseArg(args, '--qa-decision'),
    approvedDescriptorSha256: parseArg(args, '--approved-descriptor-sha256'),
    approvedDescriptor: approvedPath ? JSON.parse(readFileSync(approvedPath, 'utf8')) : undefined,
    reviewedBy: parseArg(args, '--reviewed-by'),
  });
  console.log(`Live canonical sources sealed for ${result.manifest.slug}; reviewedManifestSha256=${result.receipt.reviewedManifestSha256}; providerCalls=0, activated=false.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
