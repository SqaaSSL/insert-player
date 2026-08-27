import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildXaiCanonicalBundlePrompt,
  loadXaiCanonicalPoseManifest,
  resolveXaiCanonicalSingleSourcePromptProfile,
  validateXaiCanonicalPromptProfileReferences,
  XAI_CANONICAL_BUNDLE_SOURCE_NAMES,
  XAI_CANONICAL_GLOBAL_SIDE_PROMPT_PROFILE,
  XAI_CANONICAL_GLOBAL_SIDE_PROMPT_SHA256_BY_SLUG,
  XAI_CANONICAL_GLOBAL_SIDE_REFERENCES,
  XAI_CANONICAL_SINGLE_SOURCE_PROMPT_PROFILE,
  XAI_CANONICAL_SINGLE_SOURCE_PROMPT_SHA256,
} from './arcade-xai-canonical-bundle.mjs';
import { verifyBakeoffSource } from './arcade-side-bakeoff.mjs';
import { validateManifest } from './seed-arcade-roster.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_ROSTER_PATH = join(root, 'arcade/roster-2026.json');
const DEFAULT_SOURCE_DIR = join(root, '.arcade-sources');
const PRIVATE_INPUT_CONFIRMATION = 'PREPARE_PRIVATE_XAI_CANONICAL_INPUT_V1';
const SOURCE_NAMES = XAI_CANONICAL_BUNDLE_SOURCE_NAMES;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireString(value, label, pattern) {
  if (typeof value !== 'string' || !value || (pattern && !pattern.test(value))) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function containedPath(baseDirectory, relativePath, label) {
  requireString(relativePath, `${label} path`);
  if (relativePath.startsWith('/') || relativePath.includes('\\')) {
    throw new Error(`${label} path must be relative.`);
  }
  const absolute = resolve(baseDirectory, relativePath);
  if (!absolute.startsWith(`${resolve(baseDirectory)}${sep}`)) {
    throw new Error(`${label} path escapes the reviewed pose manifest.`);
  }
  return absolute;
}

function runTar(archivePath, stagingParent) {
  const result = spawnSync('tar', [
    '-czf', archivePath,
    '-C', stagingParent,
    'canonical-input-v1',
  ], {
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`tar failed: ${(result.error?.message ?? result.stderr ?? '').trim().slice(-1000)}`);
  }
  const listed = spawnSync('tar', ['-tzf', archivePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (listed.error || listed.status !== 0) throw new Error('Packaged input archive cannot be listed.');
  const members = listed.stdout.split('\n').filter(Boolean);
  if (members.length === 0 || members.some((member) => (
    member.startsWith('/')
    || member.includes('\\')
    || !member.startsWith('canonical-input-v1/')
    || `/${member}/`.includes('/../')
    || `/${member}/`.includes('/./')
    || member.includes('/._')
    || member.includes('__MACOSX')
  ))) {
    throw new Error('Packaged input archive contains a non-portable member.');
  }
}

function loadPackagingPoseBundle(
  poseManifestPath,
  expectedPoseManifestSha256,
  sourceNames,
  promptProfile,
) {
  if (promptProfile !== XAI_CANONICAL_GLOBAL_SIDE_PROMPT_PROFILE) {
    return loadXaiCanonicalPoseManifest(
      poseManifestPath,
      expectedPoseManifestSha256,
      sourceNames,
    );
  }
  const manifestBytes = readFileSync(poseManifestPath);
  if (sha256(manifestBytes) !== expectedPoseManifestSha256) {
    throw new Error('Pose manifest SHA-256 mismatch.');
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('Pose manifest is not JSON.');
  }
  const manifestSourceNames = Object.keys(manifest?.sources ?? {}).sort();
  if (JSON.stringify(manifestSourceNames) === JSON.stringify(['side'])) {
    return loadXaiCanonicalPoseManifest(
      poseManifestPath,
      expectedPoseManifestSha256,
      sourceNames,
    );
  }
  if (JSON.stringify(manifestSourceNames) !== JSON.stringify([...SOURCE_NAMES].sort())) {
    throw new Error('Global SIDE packaging requires either one exact side or the reviewed three-source pose manifest.');
  }
  const loaded = loadXaiCanonicalPoseManifest(
    poseManifestPath,
    expectedPoseManifestSha256,
    SOURCE_NAMES,
  );
  const selectReviewedReference = (expected, targetRole) => {
    const matches = [];
    for (const selectedSourceName of SOURCE_NAMES) {
      for (const candidateRole of ['pose', 'rendering']) {
        const reference = loaded.sources[selectedSourceName][candidateRole];
        if (reference.id === expected.id && reference.contentSha256 === expected.contentSha256) {
          matches.push({
            reference,
            descriptor: loaded.manifest.sources[selectedSourceName][candidateRole],
          });
        }
      }
    }
    if (matches.length === 0) {
      throw new Error(`The reviewed pose manifest does not contain the sealed global SIDE ${targetRole} asset.`);
    }
    const descriptors = new Set(matches.map(({ descriptor }) => JSON.stringify(descriptor)));
    if (descriptors.size !== 1) {
      throw new Error(`The sealed global SIDE ${targetRole} asset has ambiguous reviewed descriptors.`);
    }
    return matches[0];
  };
  const pose = selectReviewedReference(XAI_CANONICAL_GLOBAL_SIDE_REFERENCES.pose, 'pose');
  const rendering = selectReviewedReference(XAI_CANONICAL_GLOBAL_SIDE_REFERENCES.rendering, 'rendering');
  return {
    manifest: {
      ...loaded.manifest,
      sources: {
        side: {
          pose: structuredClone(pose.descriptor),
          rendering: structuredClone(rendering.descriptor),
        },
      },
    },
    manifestSha256: loaded.manifestSha256,
    sources: {
      side: {
        pose: pose.reference,
        rendering: rendering.reference,
      },
    },
  };
}

export function packageXaiCanonicalInput(options = {}) {
  if (options.confirmation !== PRIVATE_INPUT_CONFIRMATION) {
    throw new Error(`Private input packaging requires confirmation ${PRIVATE_INPUT_CONFIRMATION}.`);
  }
  const slug = requireString(options.slug, 'roster slug', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  const roster = JSON.parse(readFileSync(options.rosterPath ?? DEFAULT_ROSTER_PATH, 'utf8'));
  validateManifest(roster);
  const matches = roster.fighters.filter((fighter) => fighter.slug === slug);
  if (matches.length !== 1) throw new Error(`Roster slug is missing or ambiguous: ${slug}.`);
  const fighter = matches[0];
  const sourceName = options.sourceName || '';
  if (sourceName && !SOURCE_NAMES.includes(sourceName)) {
    throw new Error(`Unsupported canonical source: ${String(sourceName)}.`);
  }
  const sourceNames = sourceName ? Object.freeze([sourceName]) : SOURCE_NAMES;
  const promptProfile = sourceName
    ? resolveXaiCanonicalSingleSourcePromptProfile(slug, sourceName)
    : undefined;
  const poseManifestPath = resolve(requireString(options.poseManifestPath, 'pose manifest path'));
  const expectedPoseManifestSha256 = requireString(
    options.poseManifestSha256,
    'pose manifest SHA-256',
    /^[a-f0-9]{64}$/,
  );
  const loaded = loadPackagingPoseBundle(
    poseManifestPath,
    expectedPoseManifestSha256,
    sourceNames,
    promptProfile,
  );
  validateXaiCanonicalPromptProfileReferences(loaded, promptProfile);
  const originalPath = join(options.sourceDir ?? DEFAULT_SOURCE_DIR, `${slug}.png`);
  const original = verifyBakeoffSource(fighter, originalPath);
  const promptSha256 = sourceName
    ? sha256(buildXaiCanonicalBundlePrompt(fighter, sourceName, { promptProfile }))
    : undefined;
  const reviewedPromptSha256 = promptProfile === XAI_CANONICAL_SINGLE_SOURCE_PROMPT_PROFILE
    ? XAI_CANONICAL_SINGLE_SOURCE_PROMPT_SHA256
    : XAI_CANONICAL_GLOBAL_SIDE_PROMPT_SHA256_BY_SLUG[slug];
  if (promptProfile && promptSha256 !== reviewedPromptSha256) {
    throw new Error(`The exact reviewed single-source prompt snapshot changed for ${slug}.`);
  }
  const outputDirectory = resolve(requireString(options.outputDirectory, 'private output directory'));
  const stagingParent = join(outputDirectory, 'staging');
  const treeRoot = join(stagingParent, 'canonical-input-v1');
  const poseRoot = join(treeRoot, 'pose');
  const referencesRoot = join(poseRoot, 'references');
  const evidenceRoot = join(poseRoot, 'evidence');
  const sourcesRoot = join(treeRoot, 'sources');
  rmSync(stagingParent, { recursive: true, force: true });
  for (const directory of [referencesRoot, evidenceRoot, sourcesRoot]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  const portableManifest = structuredClone(loaded.manifest);
  const manifestDirectory = dirname(poseManifestPath);
  const writtenReferences = new Set();
  const writtenEvidence = new Set();
  for (const selectedSourceName of sourceNames) {
    for (const role of ['pose', 'rendering']) {
      const source = loaded.sources[selectedSourceName][role];
      const referenceName = `${source.contentSha256}.png`;
      if (!writtenReferences.has(referenceName)) {
        writeFileSync(join(referencesRoot, referenceName), source.bytes, { mode: 0o600 });
        writtenReferences.add(referenceName);
      }
      const evidencePath = containedPath(
        manifestDirectory,
        source.approvalEvidence.path,
        `${selectedSourceName} ${role} approval evidence`,
      );
      const evidenceBytes = readFileSync(evidencePath);
      if (sha256(evidenceBytes) !== source.approvalEvidence.contentSha256) {
        throw new Error(`${selectedSourceName} ${role} approval evidence SHA-256 changed.`);
      }
      const evidenceName = `${source.approvalEvidence.contentSha256}.json`;
      if (!writtenEvidence.has(evidenceName)) {
        writeFileSync(join(evidenceRoot, evidenceName), evidenceBytes, { mode: 0o600 });
        writtenEvidence.add(evidenceName);
      }
      portableManifest.sources[selectedSourceName][role].path = `references/${referenceName}`;
      portableManifest.sources[selectedSourceName][role].approvalEvidence.path = `evidence/${evidenceName}`;
    }
  }
  const portableManifestBytes = Buffer.from(`${JSON.stringify(portableManifest, null, 2)}\n`);
  const portableManifestPath = join(poseRoot, 'pose-manifest.json');
  writeFileSync(portableManifestPath, portableManifestBytes, { mode: 0o600 });
  writeFileSync(join(sourcesRoot, `${slug}.png`), original.bytes, { mode: 0o600 });

  const portablePoseManifestSha256 = sha256(portableManifestBytes);
  const portableLoaded = loadXaiCanonicalPoseManifest(
    portableManifestPath,
    portablePoseManifestSha256,
    sourceNames,
  );
  validateXaiCanonicalPromptProfileReferences(portableLoaded, promptProfile);
  const archiveStem = sourceName ? `${slug}-${sourceName}` : slug;
  const archivePath = join(outputDirectory, `${archiveStem}--canonical-input-v1.tar.gz`);
  runTar(archivePath, stagingParent);
  const archiveBytes = readFileSync(archivePath);
  const archiveSha256 = sha256(archiveBytes);
  const r2Key = `temp/arcade-xai-canonical-inputs-v1/${slug}/${archiveStem}--${archiveSha256.slice(0, 16)}.tar.gz`;
  const receipt = {
    schemaVersion: 1,
    status: 'prepared_private_local',
    slug,
    ...(sourceNames.length === 1 ? { sourceName: sourceNames[0] } : {}),
    fighterName: fighter.name,
    originalSha256: original.sourceSha256,
    sourcePoseManifestSha256: expectedPoseManifestSha256,
    portablePoseManifestSha256,
    ...(sourceName ? {
      sourceNames: [...sourceNames],
      promptProfile,
      promptSha256,
    } : {}),
    archivePath,
    archiveSha256,
    archiveSizeBytes: archiveBytes.byteLength,
    r2Bucket: 'insert-player-assets',
    r2Jurisdiction: 'eu',
    r2Key,
    lifecyclePrefix: 'temp/',
    uploaded: false,
    providerCalled: false,
  };
  writeFileSync(join(outputDirectory, 'input-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}

function parseArg(args, name, fallback = '') {
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const receipt = packageXaiCanonicalInput({
    confirmation: parseArg(args, '--confirm-private-input'),
    slug: parseArg(args, '--slug'),
    sourceName: parseArg(args, '--source'),
    rosterPath: parseArg(args, '--roster', DEFAULT_ROSTER_PATH),
    sourceDir: parseArg(args, '--source-dir', DEFAULT_SOURCE_DIR),
    poseManifestPath: parseArg(args, '--pose-manifest'),
    poseManifestSha256: parseArg(args, '--pose-manifest-sha256'),
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

export { PRIVATE_INPUT_CONFIRMATION };
