import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectPng,
  loadXaiCanonicalPoseManifest,
  validateXaiCanonicalPromptProfileReferences,
  XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE,
  XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE,
  XAI_CANONICAL_GLOBAL_SIDE_SLUGS,
} from './arcade-xai-canonical-bundle.mjs';
import {
  loadReviewedCanonicalBundle,
  validateBundlePromptAndRequest,
} from './import-reviewed-xai-canonical-bundle.mjs';
import {
  packageXaiCanonicalInput,
  PRIVATE_INPUT_CONFIRMATION,
} from './package-xai-canonical-input.mjs';
import { validateManifest } from './seed-arcade-roster.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_ROSTER_PATH = join(root, 'arcade/roster-2026.json');
const DEFAULT_SOURCE_DIR = join(root, '.arcade-sources');

export const REVIEWED_GLOBAL_CROUCH_INPUT_CONFIRMATION =
  'PREPARE_GLOBAL_CROUCH_FROM_REVIEWED_SIDE_PRIVATE_V1';
export const REVIEWED_GLOBAL_SIDE_FOR_CROUCH_DECISION =
  'APPROVE_REVIEWED_GLOBAL_SIDE_FOR_CROUCH_V1';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function requireString(value, label, pattern) {
  if (typeof value !== 'string' || !value || (pattern && !pattern.test(value))) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function writeJson(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return { bytes, contentSha256: sha256(bytes) };
}

function reviewedReferenceDescriptor(reference, path, evidencePath) {
  return {
    id: reference.id,
    path,
    contentSha256: reference.contentSha256,
    sizeBytes: reference.sizeBytes,
    width: reference.width,
    height: reference.height,
    approvalEvidence: {
      ...reference.approvalEvidence,
      path: evidencePath,
    },
  };
}

export function packageReviewedGlobalCrouchInput(options = {}) {
  if (options.confirmation !== REVIEWED_GLOBAL_CROUCH_INPUT_CONFIRMATION) {
    throw new Error(
      `Reviewed global CROUCH packaging requires ${REVIEWED_GLOBAL_CROUCH_INPUT_CONFIRMATION}.`,
    );
  }
  if (options.sideReviewDecision !== REVIEWED_GLOBAL_SIDE_FOR_CROUCH_DECISION) {
    throw new Error(
      `Reviewed SIDE approval requires ${REVIEWED_GLOBAL_SIDE_FOR_CROUCH_DECISION}.`,
    );
  }
  const slug = requireString(options.slug, 'global roster slug', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  if (!XAI_CANONICAL_GLOBAL_SIDE_SLUGS.includes(slug)) {
    throw new Error('Reviewed global CROUCH packaging is sealed only for Rosalía, Ibai Llanos, and Lamine Yamal.');
  }
  const sideBundleRunId = requireString(options.sideBundleRunId, 'SIDE bundle run id', /^[1-9][0-9]*$/);
  const reviewedBy = requireString(options.reviewedBy, 'SIDE reviewer');
  const reviewedAt = requireString(
    options.reviewedAt,
    'SIDE review timestamp',
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:/,
  );
  const reviewedSideDescriptorSha256 = requireString(
    options.reviewedSideDescriptorSha256,
    'reviewed SIDE descriptor SHA-256',
    /^[a-f0-9]{64}$/,
  );

  const rosterPath = options.rosterPath ?? DEFAULT_ROSTER_PATH;
  const roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
  validateManifest(roster);
  const matches = roster.fighters.filter((fighter) => fighter.slug === slug);
  if (matches.length !== 1) throw new Error(`Roster slug is missing or ambiguous: ${slug}.`);
  const fighter = matches[0];

  const sideBundle = (options.loadReviewedBundle ?? loadReviewedCanonicalBundle)({
    bundleDirectory: resolve(requireString(options.sideBundleDirectory, 'reviewed SIDE bundle directory')),
    reviewedDescriptorSha256: reviewedSideDescriptorSha256,
  });
  if (
    canonicalJson(sideBundle.sourceNames) !== canonicalJson(['side'])
    || sideBundle.descriptor.bundleId !== `arcade-xai-canonical-source-${slug}-side-v1`
    || sideBundle.descriptor.fighter.slug !== slug
    || sideBundle.descriptor.fighter.name !== fighter.name
    || sideBundle.descriptor.fighter.originalSha256 !== fighter.reference.sourceSha256
  ) throw new Error('Reviewed SIDE bundle is not sealed to the exact roster fighter and photo.');
  (options.validateReviewedBundle ?? validateBundlePromptAndRequest)(sideBundle, fighter);

  const poseManifestPath = resolve(requireString(options.poseManifestPath, 'Trump CROUCH pose manifest path'));
  const poseManifestSha256 = requireString(
    options.poseManifestSha256,
    'Trump CROUCH pose manifest SHA-256',
    /^[a-f0-9]{64}$/,
  );
  const loadPoseBundle = options.loadPoseBundle ?? loadXaiCanonicalPoseManifest;
  const poseBundle = loadPoseBundle(
    poseManifestPath,
    poseManifestSha256,
    ['crouch'],
  );
  const pose = poseBundle.sources.crouch.pose;
  if (
    pose.id !== XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE.id
    || pose.contentSha256 !== XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE.contentSha256
  ) throw new Error('Base pose manifest does not contain the exact reviewed Trump CROUCH pose.');

  const sideRaw = sideBundle.sources.side.raw;
  const sideRawBytes = readFileSync(sideRaw.absolutePath);
  const inspectedSideRaw = inspectPng(sideRawBytes, `${slug} reviewed SIDE raw`);
  for (const key of ['contentSha256', 'sizeBytes', 'width', 'height']) {
    if (sideRaw[key] !== inspectedSideRaw[key]) throw new Error(`Reviewed SIDE raw ${key} changed.`);
  }
  if (
    sideRaw.contentSha256 === pose.contentSha256
    || sideRaw.contentSha256 === fighter.reference.sourceSha256
  ) throw new Error('Global CROUCH references must be three distinct exact assets.');

  const outputDirectory = resolve(requireString(options.outputDirectory, 'private output directory'));
  const assemblyRoot = join(outputDirectory, 'reviewed-global-crouch-pose');
  const referencesRoot = join(assemblyRoot, 'references');
  const evidenceRoot = join(assemblyRoot, 'evidence');
  rmSync(assemblyRoot, { recursive: true, force: true });
  mkdirSync(referencesRoot, { recursive: true, mode: 0o700 });
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });

  const poseReferenceName = `${pose.contentSha256}.png`;
  writeFileSync(join(referencesRoot, poseReferenceName), pose.bytes, { mode: 0o600 });
  const poseEvidenceBytes = readFileSync(resolve(dirname(poseManifestPath), pose.approvalEvidence.path));
  if (sha256(poseEvidenceBytes) !== pose.approvalEvidence.contentSha256) {
    throw new Error('Reviewed Trump CROUCH pose evidence changed.');
  }
  const poseEvidenceName = `${pose.approvalEvidence.contentSha256}.json`;
  writeFileSync(join(evidenceRoot, poseEvidenceName), poseEvidenceBytes, { mode: 0o600 });

  const sideReferenceName = `${sideRaw.contentSha256}.png`;
  writeFileSync(join(referencesRoot, sideReferenceName), sideRawBytes, { mode: 0o600 });
  const sideApproval = {
    schemaVersion: 1,
    evidenceType: 'reviewed_global_side_for_crouch_v1',
    status: 'approved',
    decision: REVIEWED_GLOBAL_SIDE_FOR_CROUCH_DECISION,
    reviewedBy,
    reviewedAt,
    sideBundleRunId,
    reviewedDescriptorSha256: reviewedSideDescriptorSha256,
    fighter: {
      slug,
      name: fighter.name,
      photoHash: fighter.reference.sourceSha256,
    },
    side: {
      bundleId: sideBundle.descriptor.bundleId,
      promptSha256: sideBundle.descriptor.sources.side.promptSha256,
      pixcliJobId: sideBundle.descriptor.sources.side.pixcliJobId,
      providerRequestId: sideBundle.descriptor.sources.side.providerRequestId,
      processedSha256: sideBundle.sources.side.processed.contentSha256,
      rawSha256: sideRaw.contentSha256,
    },
    blockingFindings: [],
  };
  const sideEvidenceName = 'reviewed-side-approval.json';
  const sideEvidence = writeJson(join(evidenceRoot, sideEvidenceName), sideApproval);

  const renderingReference = {
    id: `reviewed-${slug}-side-raw-v1`,
    path: `references/${sideReferenceName}`,
    contentSha256: sideRaw.contentSha256,
    sizeBytes: sideRaw.sizeBytes,
    width: sideRaw.width,
    height: sideRaw.height,
    approvalEvidence: {
      path: `evidence/${sideEvidenceName}`,
      contentSha256: sideEvidence.contentSha256,
      selector: 'status',
      expectedValue: 'approved',
    },
  };
  const poseDescriptor = reviewedReferenceDescriptor(
    pose,
    `references/${poseReferenceName}`,
    `evidence/${poseEvidenceName}`,
  );
  const derivedManifest = {
    schemaVersion: 1,
    manifestId: `arcade-xai-canonical-pose-bundle-${slug}-reviewed-side-crouch-v1`,
    status: 'human_reviewed',
    referenceOrder: [
      'pose_composition_master',
      'canonical_rendering_master',
      'identity_photo',
    ],
    sources: {
      crouch: {
        pose: poseDescriptor,
        rendering: renderingReference,
      },
    },
  };
  const derivedManifestPath = join(assemblyRoot, 'pose-manifest.json');
  const derivedManifestRecord = writeJson(derivedManifestPath, derivedManifest);
  const loadedDerived = loadPoseBundle(
    derivedManifestPath,
    derivedManifestRecord.contentSha256,
    ['crouch'],
  );
  (options.validatePromptReferences ?? validateXaiCanonicalPromptProfileReferences)(
    loadedDerived,
    XAI_CANONICAL_GLOBAL_CROUCH_PROMPT_PROFILE,
    fighter,
  );

  const receipt = (options.packageCanonicalInput ?? packageXaiCanonicalInput)({
    confirmation: PRIVATE_INPUT_CONFIRMATION,
    slug,
    sourceName: 'crouch',
    rosterPath,
    sourceDir: options.sourceDir ?? DEFAULT_SOURCE_DIR,
    poseManifestPath: derivedManifestPath,
    poseManifestSha256: derivedManifestRecord.contentSha256,
    outputDirectory,
  });
  const lineageReceipt = {
    schemaVersion: 1,
    receiptType: 'reviewed_global_side_to_crouch_input_v1',
    status: 'prepared_private_local',
    slug,
    fighterName: fighter.name,
    photoHash: fighter.reference.sourceSha256,
    sideReview: {
      bundleRunId: sideBundleRunId,
      bundleId: sideBundle.descriptor.bundleId,
      reviewedDescriptorSha256: reviewedSideDescriptorSha256,
      evidenceSha256: sideEvidence.contentSha256,
      processedSha256: sideBundle.sources.side.processed.contentSha256,
      rawSha256: sideRaw.contentSha256,
    },
    crouchInput: receipt,
    providerCalled: false,
    imported: false,
    activated: false,
  };
  writeJson(join(outputDirectory, 'reviewed-global-crouch-input-receipt.json'), lineageReceipt);
  return lineageReceipt;
}

function parseArg(args, name, fallback = '') {
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const receipt = packageReviewedGlobalCrouchInput({
    confirmation: parseArg(args, '--confirm'),
    sideReviewDecision: parseArg(args, '--side-review-decision'),
    slug: parseArg(args, '--slug'),
    sideBundleRunId: parseArg(args, '--side-bundle-run-id'),
    reviewedSideDescriptorSha256: parseArg(args, '--reviewed-side-descriptor-sha256'),
    reviewedBy: parseArg(args, '--reviewed-by'),
    reviewedAt: parseArg(args, '--reviewed-at'),
    sideBundleDirectory: parseArg(args, '--side-bundle-dir'),
    poseManifestPath: parseArg(args, '--pose-manifest'),
    poseManifestSha256: parseArg(args, '--pose-manifest-sha256'),
    rosterPath: parseArg(args, '--roster', DEFAULT_ROSTER_PATH),
    sourceDir: parseArg(args, '--source-dir', DEFAULT_SOURCE_DIR),
    outputDirectory: parseArg(args, '--output-dir'),
  });
  console.log(JSON.stringify(receipt, null, 2));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
