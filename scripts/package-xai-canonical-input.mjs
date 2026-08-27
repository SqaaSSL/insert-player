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
import { loadXaiCanonicalPoseManifest } from './arcade-xai-canonical-bundle.mjs';
import { verifyBakeoffSource } from './arcade-side-bakeoff.mjs';
import { validateManifest } from './seed-arcade-roster.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_ROSTER_PATH = join(root, 'arcade/roster-2026.json');
const DEFAULT_SOURCE_DIR = join(root, '.arcade-sources');
const PRIVATE_INPUT_CONFIRMATION = 'PREPARE_PRIVATE_XAI_CANONICAL_INPUT_V1';
const SOURCE_NAMES = Object.freeze(['side', 'upright', 'crouch']);

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

export function packageXaiCanonicalInput(options = {}) {
  if (options.confirmation !== PRIVATE_INPUT_CONFIRMATION) {
    throw new Error(`Private input packaging requires confirmation ${PRIVATE_INPUT_CONFIRMATION}.`);
  }
  const slug = requireString(options.slug, 'roster slug', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  const sourceNames = options.sourceName
    ? [requireString(options.sourceName, 'single canonical source', /^crouch$/)]
    : SOURCE_NAMES;
  if (sourceNames.length === 1 && slug !== 'elon-musk') {
    throw new Error('Single-source private packaging is sealed only for Elon Musk CROUCH.');
  }
  const roster = JSON.parse(readFileSync(options.rosterPath ?? DEFAULT_ROSTER_PATH, 'utf8'));
  validateManifest(roster);
  const matches = roster.fighters.filter((fighter) => fighter.slug === slug);
  if (matches.length !== 1) throw new Error(`Roster slug is missing or ambiguous: ${slug}.`);
  const fighter = matches[0];
  const poseManifestPath = resolve(requireString(options.poseManifestPath, 'pose manifest path'));
  const expectedPoseManifestSha256 = requireString(
    options.poseManifestSha256,
    'pose manifest SHA-256',
    /^[a-f0-9]{64}$/,
  );
  const loaded = loadXaiCanonicalPoseManifest(
    poseManifestPath,
    expectedPoseManifestSha256,
    sourceNames,
  );
  const originalPath = join(options.sourceDir ?? DEFAULT_SOURCE_DIR, `${slug}.png`);
  const original = verifyBakeoffSource(fighter, originalPath);
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
  for (const sourceName of sourceNames) {
    for (const role of ['pose', 'rendering']) {
      const source = loaded.sources[sourceName][role];
      const referenceName = `${source.contentSha256}.png`;
      if (!writtenReferences.has(referenceName)) {
        writeFileSync(join(referencesRoot, referenceName), source.bytes, { mode: 0o600 });
        writtenReferences.add(referenceName);
      }
      const evidencePath = containedPath(
        manifestDirectory,
        source.approvalEvidence.path,
        `${sourceName} ${role} approval evidence`,
      );
      const evidenceBytes = readFileSync(evidencePath);
      if (sha256(evidenceBytes) !== source.approvalEvidence.contentSha256) {
        throw new Error(`${sourceName} ${role} approval evidence SHA-256 changed.`);
      }
      const evidenceName = `${source.approvalEvidence.contentSha256}.json`;
      if (!writtenEvidence.has(evidenceName)) {
        writeFileSync(join(evidenceRoot, evidenceName), evidenceBytes, { mode: 0o600 });
        writtenEvidence.add(evidenceName);
      }
      portableManifest.sources[sourceName][role].path = `references/${referenceName}`;
      portableManifest.sources[sourceName][role].approvalEvidence.path = `evidence/${evidenceName}`;
    }
  }
  const portableManifestBytes = Buffer.from(`${JSON.stringify(portableManifest, null, 2)}\n`);
  const portableManifestPath = join(poseRoot, 'pose-manifest.json');
  writeFileSync(portableManifestPath, portableManifestBytes, { mode: 0o600 });
  writeFileSync(join(sourcesRoot, `${slug}.png`), original.bytes, { mode: 0o600 });

  const portablePoseManifestSha256 = sha256(portableManifestBytes);
  loadXaiCanonicalPoseManifest(portableManifestPath, portablePoseManifestSha256, sourceNames);
  const archiveStem = sourceNames.length === 1 ? `${slug}-${sourceNames[0]}` : slug;
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
