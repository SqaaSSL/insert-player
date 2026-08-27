import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE,
  XAI_CANONICAL_GLOBAL_SIDE_SLUGS,
} from './arcade-xai-canonical-bundle.mjs';
import {
  loadReviewedCanonicalBundle,
  validateBundlePromptAndRequest,
} from './import-reviewed-xai-canonical-bundle.mjs';
import {
  GLOBAL_MIXED_QA_DECISION,
  GLOBAL_MIXED_TARGETS,
  GLOBAL_UPRIGHT_ALIAS_DECISION,
} from './import-reviewed-elon-mixed-canonical-set.mjs';
import { validateManifest } from './seed-arcade-roster.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_ROSTER_PATH = join(root, 'arcade/roster-2026.json');
const ALLOWED_SOURCE_POSTS = Object.freeze([
  'side', 'side_raw', 'upright', 'upright_raw', 'crouch', 'crouch_raw',
]);

export const ASSEMBLE_REVIEWED_GLOBAL_MIXED_CONFIRMATION =
  'ASSEMBLE_REVIEWED_GLOBAL_MIXED_CANONICAL_SET_V1';

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
  return { path, contentSha256: sha256(bytes), bytes };
}

function loadExactSourceBundle({
  slug,
  sourceName,
  bundleDirectory,
  bundleRunId,
  reviewedDescriptorSha256,
  fighter,
  loadReviewedBundle,
  validateReviewedBundle,
}) {
  requireString(bundleRunId, `${sourceName} bundle run id`, /^[1-9][0-9]*$/);
  requireString(
    reviewedDescriptorSha256,
    `${sourceName} reviewed descriptor SHA-256`,
    /^[a-f0-9]{64}$/,
  );
  const bundle = loadReviewedBundle({
    bundleDirectory: resolve(requireString(bundleDirectory, `${sourceName} bundle directory`)),
    reviewedDescriptorSha256,
  });
  const source = bundle?.descriptor?.sources?.[sourceName];
  if (
    canonicalJson(bundle?.sourceNames) !== canonicalJson([sourceName])
    || bundle.descriptor.bundleId !== `arcade-xai-canonical-source-${slug}-${sourceName}-v1`
    || bundle.descriptor.fighter?.slug !== slug
    || bundle.descriptor.fighter?.name !== fighter.name
    || bundle.descriptor.fighter?.originalSha256 !== fighter.reference.sourceSha256
    || !/^[a-f0-9]{64}$/.test(source?.clean?.contentSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(source?.raw?.contentSha256 ?? '')
    || source.clean.contentSha256 === source.raw.contentSha256
  ) throw new Error(`Reviewed ${sourceName.toUpperCase()} bundle is not the exact single-source fighter artifact.`);
  validateReviewedBundle(bundle, fighter);
  return {
    bundle,
    lineage: {
      bundleRunId,
      bundleId: bundle.descriptor.bundleId,
      reviewedDescriptorSha256,
      processedSha256: source.clean.contentSha256,
      rawSha256: source.raw.contentSha256,
    },
  };
}

export function assembleReviewedGlobalMixedCanonicalSet(options = {}) {
  if (options.confirmation !== ASSEMBLE_REVIEWED_GLOBAL_MIXED_CONFIRMATION) {
    throw new Error(
      `Global mixed assembly requires ${ASSEMBLE_REVIEWED_GLOBAL_MIXED_CONFIRMATION}.`,
    );
  }
  if (options.qaDecision !== GLOBAL_MIXED_QA_DECISION) {
    throw new Error(`Global mixed assembly requires ${GLOBAL_MIXED_QA_DECISION}.`);
  }
  const slug = requireString(options.slug, 'global roster slug', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  if (!XAI_CANONICAL_GLOBAL_SIDE_SLUGS.includes(slug)) {
    throw new Error('Global mixed assembly is not sealed for this roster slug.');
  }
  const reviewedBy = requireString(options.reviewedBy, 'global mixed reviewer');
  const reviewedAt = requireString(
    options.reviewedAt,
    'global mixed review timestamp',
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:/,
  );
  const roster = JSON.parse(readFileSync(options.rosterPath ?? DEFAULT_ROSTER_PATH, 'utf8'));
  validateManifest(roster);
  const matches = roster.fighters.filter((entry) => entry.slug === slug);
  if (matches.length !== 1) throw new Error(`Roster slug is missing or ambiguous: ${slug}.`);
  const fighter = matches[0];
  const target = GLOBAL_MIXED_TARGETS[slug];
  if (
    target.name !== fighter.name
    || target.photoHash !== fighter.reference.sourceSha256
  ) throw new Error('Global production target does not match the reviewed roster identity/photo.');

  const loadReviewedBundle = options.loadReviewedBundle ?? loadReviewedCanonicalBundle;
  const validateReviewedBundle = options.validateReviewedBundle ?? validateBundlePromptAndRequest;
  const side = loadExactSourceBundle({
    slug,
    sourceName: 'side',
    bundleDirectory: options.sideBundleDirectory,
    bundleRunId: options.sideBundleRunId,
    reviewedDescriptorSha256: options.reviewedSideDescriptorSha256,
    fighter,
    loadReviewedBundle,
    validateReviewedBundle,
  });
  const crouch = loadExactSourceBundle({
    slug,
    sourceName: 'crouch',
    bundleDirectory: options.crouchBundleDirectory,
    bundleRunId: options.crouchBundleRunId,
    reviewedDescriptorSha256: options.reviewedCrouchDescriptorSha256,
    fighter,
    loadReviewedBundle,
    validateReviewedBundle,
  });
  if (
    side.lineage.bundleRunId === crouch.lineage.bundleRunId
    || side.lineage.reviewedDescriptorSha256 === crouch.lineage.reviewedDescriptorSha256
  ) throw new Error('SIDE and CROUCH require two distinct reviewed one-call bundles.');
  const crouchReferences = crouch.bundle.descriptor.sources.crouch.references;
  if (
    crouchReferences?.pose?.id !== XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE.id
    || crouchReferences?.pose?.contentSha256 !== XAI_CANONICAL_GLOBAL_CROUCH_POSE_REFERENCE.contentSha256
    || crouchReferences?.rendering?.contentSha256 !== side.lineage.rawSha256
    || crouchReferences?.identity?.contentSha256 !== target.photoHash
  ) throw new Error('CROUCH lineage is not Trump crouch + exact reviewed SIDE raw + original photo.');

  const outputDirectory = resolve(requireString(options.outputDirectory, 'global assembly output directory'));
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const fighterBinding = {
    slug,
    fighterId: target.fighterId,
    name: target.name,
    photoHash: target.photoHash,
  };
  const sourceQa = (lineage) => ({
    bundleRunId: lineage.bundleRunId,
    bundleId: lineage.bundleId,
    descriptorSha256: lineage.reviewedDescriptorSha256,
    processedSha256: lineage.processedSha256,
    rawSha256: lineage.rawSha256,
  });
  const qaEvidence = {
    schemaVersion: 1,
    evidenceType: 'global_mixed_canonical_human_review_v1',
    status: 'approved',
    decision: GLOBAL_MIXED_QA_DECISION,
    reviewedBy,
    reviewedAt,
    fighter: fighterBinding,
    side: sourceQa(side.lineage),
    uprightAlias: {
      decision: GLOBAL_UPRIGHT_ALIAS_DECISION,
      processedSha256: side.lineage.processedSha256,
      rawSha256: side.lineage.rawSha256,
    },
    crouch: sourceQa(crouch.lineage),
    blockingFindings: [],
  };
  const qa = writeJson(join(outputDirectory, 'qa-evidence.json'), qaEvidence);
  const plan = {
    schemaVersion: 1,
    planType: 'global_reviewed_mixed_canonical_set_v1',
    fighter: fighterBinding,
    side: side.lineage,
    uprightAlias: {
      decision: GLOBAL_UPRIGHT_ALIAS_DECISION,
      fromProcessedSha256: side.lineage.processedSha256,
      fromRawSha256: side.lineage.rawSha256,
    },
    crouch: crouch.lineage,
    qaEvidence: { path: 'qa-evidence.json', contentSha256: qa.contentSha256 },
    safety: {
      providerCalls: 0,
      generationStarted: false,
      activated: false,
      preexistingSourceOverwrite: false,
      allowedSourcePosts: [...ALLOWED_SOURCE_POSTS],
    },
  };
  const planRecord = writeJson(join(outputDirectory, 'assembly-plan.json'), plan);
  return {
    schemaVersion: 1,
    status: 'assembled_reviewed_sources_only',
    slug,
    fighter: fighterBinding,
    side: side.lineage,
    crouch: crouch.lineage,
    qaEvidenceSha256: qa.contentSha256,
    assemblyPlanPath: planRecord.path,
    assemblyPlanSha256: planRecord.contentSha256,
    providerCalls: 0,
    generationStarted: false,
    imported: false,
    activated: false,
  };
}

function parseArg(args, name, fallback = '') {
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const receipt = assembleReviewedGlobalMixedCanonicalSet({
    confirmation: parseArg(args, '--confirm'),
    qaDecision: parseArg(args, '--qa-decision'),
    slug: parseArg(args, '--slug'),
    reviewedBy: parseArg(args, '--reviewed-by'),
    reviewedAt: parseArg(args, '--reviewed-at'),
    sideBundleDirectory: parseArg(args, '--side-bundle-dir'),
    sideBundleRunId: parseArg(args, '--side-bundle-run-id'),
    reviewedSideDescriptorSha256: parseArg(args, '--reviewed-side-descriptor-sha256'),
    crouchBundleDirectory: parseArg(args, '--crouch-bundle-dir'),
    crouchBundleRunId: parseArg(args, '--crouch-bundle-run-id'),
    reviewedCrouchDescriptorSha256: parseArg(args, '--reviewed-crouch-descriptor-sha256'),
    rosterPath: parseArg(args, '--roster', DEFAULT_ROSTER_PATH),
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
