import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  TRUMP_VIDEO_ROSTER_CONTRACT,
  canonicalJson,
  expectedBundleManifest,
  sha256,
  validateBundleDirectory,
  validateRawSpriteBytes,
  validateSourceBytes,
  validateSpriteBytes,
} from './trump-video-roster-production-contract.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_ROSTER_ROOT = '/private/tmp/insert-player-trump-video-roster.A8ridF';
const DEFAULT_HIGH_KICK_ROOT = '/private/tmp/insert-player-trump-nova-canaries';
const ROSTER_ARTIFACT_DIR = '.artifacts/arcade-trump-xai-video-roster-canary';
const HIGH_KICK_ARTIFACT_DIR = [
  '.artifacts',
  'arcade-high-kick-xai-video-trump-v2-canary',
  'arcade-high-kick-xai-video-trump-v2',
  'extracted-curated-v1',
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function findArg(rawArgs, name) {
  const prefix = `--${name}=`;
  return rawArgs.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? '';
}

function expectedProvenance(contract, kind) {
  const entry = contract.provenance.find((candidate) => candidate.kind === kind);
  if (!entry) throw new Error(`The sealed contract is missing ${kind} provenance.`);
  return entry;
}

function readExactJson(path, entry) {
  invariant(existsSync(path), `Missing ${entry.kind}: ${path}`);
  const bytes = readFileSync(path);
  const digest = sha256(bytes);
  invariant(
    digest === entry.sha256,
    `${entry.kind} SHA-256 mismatch: expected ${entry.sha256}, received ${digest}.`,
  );
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')), path };
  } catch {
    throw new Error(`${entry.kind} is not valid JSON: ${path}`);
  }
}

function resolveRecordedArtifactPath(baseDirectory, recordedPath) {
  invariant(typeof recordedPath === 'string' && recordedPath, 'A QA record is missing its artifact path.');
  if (!isAbsolute(recordedPath)) return resolve(baseDirectory, recordedPath);
  if (existsSync(recordedPath)) return recordedPath;
  const marker = '/.artifacts/';
  const markerIndex = recordedPath.indexOf(marker);
  if (markerIndex >= 0) return resolve(baseDirectory, recordedPath.slice(markerIndex + 1));
  return recordedPath;
}

function batchRuntimeSheet(result) {
  return result.action === 'idle'
    ? result.runtimeSheet
    : result.extractionReport?.artifacts?.runtimeSheet;
}

function assertBatchResult(result, sprite, contract) {
  invariant(result?.action === sprite.animationName, `Missing batch result for ${sprite.animationName}.`);
  invariant(result.status === 'completed', `${sprite.animationName} batch result is not completed.`);
  invariant(result.contractValidated === true, `${sprite.animationName} generation contract was not validated.`);
  invariant(result.qaApproved === true, `${sprite.animationName} did not pass QA.`);
  invariant(
    result.animationFormat === contract.animationFormat,
    `${sprite.animationName} does not use ${contract.animationFormat}.`,
  );
  invariant(
    result.processingVersion === contract.processingVersion,
    `${sprite.animationName} does not use processing version ${contract.processingVersion}.`,
  );
  const recorded = batchRuntimeSheet(result);
  invariant(recorded?.contentSha256 === sprite.sha256, `${sprite.animationName} batch sheet hash is not sealed.`);
  invariant(recorded?.sizeBytes === sprite.sizeBytes, `${sprite.animationName} batch sheet size is not sealed.`);
  if (result.action === 'idle') {
    invariant(recorded.width === sprite.sheetWidth, 'idle batch sheet width is not sealed.');
    invariant(recorded.height === sprite.sheetHeight, 'idle batch sheet height is not sealed.');
    invariant(recorded.frameWidth === sprite.frameWidth, 'idle frame width is not sealed.');
    invariant(recorded.frameHeight === sprite.frameHeight, 'idle frame height is not sealed.');
    invariant(recorded.frameCount === sprite.frameCount, 'idle frame count is not sealed.');
  } else {
    invariant(
      result.extractionReport?.playbackFrameCount === sprite.frameCount,
      `${sprite.animationName} physical playback frame count is not sealed.`,
    );
  }
  const raw = result.action === 'idle'
    ? { path: join(result.outputDir, 'playback-sheet-192x256-on-green.png') }
    : result.extractionReport?.artifacts?.playbackSheet;
  invariant(typeof raw?.path === 'string' && raw.path, `${sprite.animationName} raw sheet is missing.`);
  if (result.action !== 'idle') {
    invariant(raw.contentSha256 === sprite.rawSha256, `${sprite.animationName} batch raw hash is not sealed.`);
    invariant(raw.sizeBytes === sprite.rawSizeBytes, `${sprite.animationName} batch raw size is not sealed.`);
  }
  return { processed: recorded, raw };
}

export function validateKnownTrumpRosterSources({
  rosterRoot,
  highKickRoot,
  originalSourcePath,
  contract = TRUMP_VIDEO_ROSTER_CONTRACT,
}) {
  const rosterDirectory = resolve(rosterRoot);
  const highKickDirectory = resolve(highKickRoot);
  const provenanceFiles = new Map();

  const batchEntry = expectedProvenance(contract, 'batch-state');
  const batch = readExactJson(join(rosterDirectory, ROSTER_ARTIFACT_DIR, 'batch-state.json'), batchEntry);
  provenanceFiles.set(batchEntry.kind, batch);
  invariant(batch.value.schemaVersion === 2, 'Roster batch state schema is not version 2.');
  invariant(batch.value.experimentId === 'arcade-trump-xai-video-roster-v1', 'Unexpected roster experiment.');
  invariant(batch.value.status === 'completed', 'Roster batch state is not completed.');
  invariant(Array.isArray(batch.value.results), 'Roster batch results are missing.');

  const expectedLocalSprites = contract.sprites.filter((sprite) => sprite.animationName !== 'high_kick');
  invariant(
    canonicalJson(batch.value.results.map((result) => result.action))
      === canonicalJson(expectedLocalSprites.map((sprite) => sprite.animationName)),
    'Roster batch actions do not exactly match the ten locally generated actions.',
  );

  const spriteFiles = new Map();
  const rawSpriteFiles = new Map();
  for (const sprite of expectedLocalSprites) {
    const result = batch.value.results.find((candidate) => candidate.action === sprite.animationName);
    const recorded = assertBatchResult(result, sprite, contract);
    const sourcePath = resolveRecordedArtifactPath(rosterDirectory, recorded.processed.path);
    invariant(existsSync(sourcePath), `Missing ${sprite.animationName} runtime sheet: ${sourcePath}`);
    const bytes = readFileSync(sourcePath);
    validateSpriteBytes(bytes, sprite);
    spriteFiles.set(sprite.animationName, { bytes, path: sourcePath });
    const rawPath = resolveRecordedArtifactPath(rosterDirectory, recorded.raw.path);
    invariant(existsSync(rawPath), `Missing ${sprite.animationName} raw sheet: ${rawPath}`);
    const rawBytes = readFileSync(rawPath);
    validateRawSpriteBytes(rawBytes, sprite);
    rawSpriteFiles.set(sprite.animationName, { bytes: rawBytes, path: rawPath });
  }

  const qaEntry = expectedProvenance(contract, 'qa-manifest');
  const qa = readExactJson(join(rosterDirectory, ROSTER_ARTIFACT_DIR, 'qa', 'qa-manifest.json'), qaEntry);
  provenanceFiles.set(qaEntry.kind, qa);
  invariant(
    canonicalJson(Object.keys(qa.value).sort())
      === canonicalJson(expectedLocalSprites.map((sprite) => sprite.animationName).sort()),
    'QA manifest does not bind exactly the ten locally generated actions.',
  );
  for (const sprite of expectedLocalSprites) {
    const record = qa.value[sprite.animationName];
    invariant(record && typeof record === 'object', `QA manifest is missing ${sprite.animationName}.`);
    invariant(
      typeof (record.curatedExtractionReportPath ?? record.deterministicLocalQaReportPath) === 'string',
      `QA manifest does not bind a report for ${sprite.animationName}.`,
    );
  }

  const approvalEntry = expectedProvenance(contract, 'high-kick-approval');
  const approval = readExactJson(
    join(rosterDirectory, ROSTER_ARTIFACT_DIR, 'qa', 'high-kick-approval.json'),
    approvalEntry,
  );
  provenanceFiles.set(approvalEntry.kind, approval);
  const highKickSprite = contract.sprites.find((sprite) => sprite.animationName === 'high_kick');
  invariant(highKickSprite, 'The sealed contract has no high_kick sprite.');
  invariant(approval.value.status === 'approved', 'High-kick approval is not approved.');
  invariant(approval.value.binding?.action === 'high_kick', 'High-kick approval binds another action.');
  invariant(
    approval.value.binding?.runtimeSheetSha256 === highKickSprite.sha256,
    'High-kick approval binds another runtime sheet.',
  );
  invariant(
    approval.value.binding?.animationFormat === contract.animationFormat,
    'High-kick approval binds another animation format.',
  );
  invariant(
    approval.value.binding?.processingVersion === contract.processingVersion,
    'High-kick approval binds another processing version.',
  );

  const highKickReportEntry = expectedProvenance(contract, 'high-kick-extraction-report');
  const highKickReportPath = join(highKickDirectory, ...HIGH_KICK_ARTIFACT_DIR, 'extraction-report.json');
  const highKickReport = readExactJson(highKickReportPath, highKickReportEntry);
  provenanceFiles.set(highKickReportEntry.kind, highKickReport);
  invariant(highKickReport.value.uniqueFrameCount === 12, 'High-kick report must contain 12 forward poses.');
  invariant(highKickReport.value.playbackFrameCount === highKickSprite.frameCount, 'High-kick playback count is not 23.');
  const highKickRecorded = highKickReport.value.artifacts?.runtimeSheet;
  const highKickRawRecorded = highKickReport.value.artifacts?.playbackSheet;
  invariant(highKickRecorded?.contentSha256 === highKickSprite.sha256, 'High-kick report binds another sheet.');
  invariant(highKickRecorded?.sizeBytes === highKickSprite.sizeBytes, 'High-kick report binds another sheet size.');
  const highKickSheetPath = resolveRecordedArtifactPath(highKickDirectory, highKickRecorded.path);
  invariant(existsSync(highKickSheetPath), `Missing high-kick runtime sheet: ${highKickSheetPath}`);
  const highKickBytes = readFileSync(highKickSheetPath);
  validateSpriteBytes(highKickBytes, highKickSprite);
  spriteFiles.set('high_kick', { bytes: highKickBytes, path: highKickSheetPath });
  invariant(highKickRawRecorded?.contentSha256 === highKickSprite.rawSha256, 'High-kick report binds another raw sheet.');
  invariant(highKickRawRecorded?.sizeBytes === highKickSprite.rawSizeBytes, 'High-kick report binds another raw sheet size.');
  const highKickRawPath = resolveRecordedArtifactPath(highKickDirectory, highKickRawRecorded.path);
  invariant(existsSync(highKickRawPath), `Missing high-kick raw sheet: ${highKickRawPath}`);
  const highKickRawBytes = readFileSync(highKickRawPath);
  validateRawSpriteBytes(highKickRawBytes, highKickSprite);
  rawSpriteFiles.set('high_kick', { bytes: highKickRawBytes, path: highKickRawPath });

  const reused = batch.value.reusedHighKick;
  invariant(reused?.status === 'validated' && reused?.qaApproved === true, 'Batch did not validate the reused high kick.');
  invariant(reused.runtimeSheetSha256 === highKickSprite.sha256, 'Batch reused another high-kick sheet.');
  invariant(
    reused.qaApproval?.approvalDigestSha256 === approval.value.approvalDigestSha256,
    'Batch high-kick approval digest does not match the sealed approval.',
  );

  const originalPath = resolve(originalSourcePath);
  const sourcePaths = {
    original: originalPath,
    side: join(rosterDirectory, ROSTER_ARTIFACT_DIR, 'anchors-v1', 'keyed-master-rgba.png'),
    side_raw: join(rosterDirectory, ROSTER_ARTIFACT_DIR, 'anchors-v1', 'standing-overscan-v1.png'),
    upright: join(rosterDirectory, ROSTER_ARTIFACT_DIR, 'anchors-v1', 'keyed-master-rgba.png'),
    upright_raw: join(rosterDirectory, ROSTER_ARTIFACT_DIR, 'anchors-v1', 'standing-overscan-v1.png'),
    crouch: join(
      rosterDirectory,
      ROSTER_ARTIFACT_DIR,
      'crouch/arcade-trump-xai-video-roster-v1-crouch/crouch-anchor-v1-rgba.png',
    ),
    crouch_raw: join(
      rosterDirectory,
      ROSTER_ARTIFACT_DIR,
      'crouch/arcade-trump-xai-video-roster-v1-crouch/crouch-anchor-v1.png',
    ),
  };
  const sourceFiles = new Map();
  for (const source of contract.sources) {
    const sourcePath = sourcePaths[source.kind];
    invariant(existsSync(sourcePath), `Missing ${source.kind} canonical source: ${sourcePath}`);
    const bytes = readFileSync(sourcePath);
    validateSourceBytes(bytes, source);
    sourceFiles.set(source.kind, { bytes, path: sourcePath });
  }

  return { contract, spriteFiles, rawSpriteFiles, sourceFiles, provenanceFiles };
}

function copyValidatedSources(bundleDirectory, sources) {
  mkdirSync(join(bundleDirectory, 'sprites'), { recursive: true, mode: 0o700 });
  mkdirSync(join(bundleDirectory, 'sprites/raw'), { recursive: true, mode: 0o700 });
  mkdirSync(join(bundleDirectory, 'sources'), { recursive: true, mode: 0o700 });
  mkdirSync(join(bundleDirectory, 'provenance'), { recursive: true, mode: 0o700 });
  for (const sprite of sources.contract.sprites) {
    const source = sources.spriteFiles.get(sprite.animationName);
    invariant(source, `No validated source was supplied for ${sprite.animationName}.`);
    const target = join(bundleDirectory, sprite.file);
    writeFileSync(target, source.bytes, { mode: 0o600, flag: 'wx' });
    chmodSync(target, 0o600);
    const rawSource = sources.rawSpriteFiles.get(sprite.animationName);
    invariant(rawSource, `No validated raw source was supplied for ${sprite.animationName}.`);
    const rawTarget = join(bundleDirectory, sprite.rawFile);
    writeFileSync(rawTarget, rawSource.bytes, { mode: 0o600, flag: 'wx' });
    chmodSync(rawTarget, 0o600);
  }
  for (const source of sources.contract.sources) {
    const validated = sources.sourceFiles.get(source.kind);
    invariant(validated, `No validated canonical source was supplied for ${source.kind}.`);
    const target = join(bundleDirectory, source.file);
    writeFileSync(target, validated.bytes, { mode: 0o600, flag: 'wx' });
    chmodSync(target, 0o600);
  }
  for (const entry of sources.contract.provenance) {
    const source = sources.provenanceFiles.get(entry.kind);
    invariant(source, `No validated source was supplied for ${entry.kind}.`);
    const target = join(bundleDirectory, entry.file);
    copyFileSync(source.path, target, 0);
    chmodSync(target, 0o600);
  }
  const manifestPath = join(bundleDirectory, 'manifest.json');
  writeFileSync(
    manifestPath,
    `${JSON.stringify(expectedBundleManifest(sources.contract), null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  chmodSync(manifestPath, 0o600);
}

function createArchive(bundleDirectory, archivePath) {
  const temporaryArchive = `${archivePath}.tmp-${process.pid}`;
  invariant(!existsSync(temporaryArchive), `Temporary archive already exists: ${temporaryArchive}`);
  const result = spawnSync(
    'tar',
    ['-czf', temporaryArchive, '-C', resolve(bundleDirectory, '..'), bundleDirectory.split('/').at(-1)],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`tar failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
  chmodSync(temporaryArchive, 0o600);
  renameSync(temporaryArchive, archivePath);
}

export function packageTrumpVideoRoster({
  rosterRoot,
  highKickRoot,
  originalSourcePath,
  outputDirectory = join(root, '.artifacts/arcade-import-bundles'),
  contract = TRUMP_VIDEO_ROSTER_CONTRACT,
}) {
  const sources = validateKnownTrumpRosterSources({
    rosterRoot,
    highKickRoot,
    originalSourcePath,
    contract,
  });
  const outputRoot = resolve(outputDirectory);
  const bundleDirectory = join(outputRoot, contract.bundleId);
  const archivePath = join(outputRoot, `${contract.bundleId}.tar.gz`);
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });

  if (existsSync(bundleDirectory)) {
    validateBundleDirectory(bundleDirectory, { contract });
  } else {
    const temporaryDirectory = `${bundleDirectory}.tmp-${process.pid}`;
    invariant(!existsSync(temporaryDirectory), `Temporary bundle already exists: ${temporaryDirectory}`);
    mkdirSync(temporaryDirectory, { recursive: false, mode: 0o700 });
    copyValidatedSources(temporaryDirectory, sources);
    validateBundleDirectory(temporaryDirectory, { contract });
    renameSync(temporaryDirectory, bundleDirectory);
  }

  if (!existsSync(archivePath)) createArchive(bundleDirectory, archivePath);
  const archiveBytes = readFileSync(archivePath);
  return {
    bundleDirectory,
    archivePath,
    archiveSha256: sha256(archiveBytes),
    archiveSizeBytes: archiveBytes.length,
    contractSha256: expectedBundleManifest(contract).contractSha256,
  };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const rosterRoot = resolve(
    findArg(rawArgs, 'roster-root') || process.env.ASF_TRUMP_VIDEO_ROSTER_ROOT || DEFAULT_ROSTER_ROOT,
  );
  const highKickRoot = resolve(
    findArg(rawArgs, 'high-kick-root') || process.env.ASF_TRUMP_HIGH_KICK_ROOT || DEFAULT_HIGH_KICK_ROOT,
  );
  const originalSourceInput = findArg(rawArgs, 'original-source') || process.env.ASF_TRUMP_ORIGINAL_SOURCE || '';
  invariant(
    originalSourceInput,
    'Pass --original-source=/absolute/path/to/.arcade-sources/donald-trump.png.',
  );
  const originalSourcePath = resolve(originalSourceInput);
  const outputDirectory = resolve(
    findArg(rawArgs, 'output-dir') || process.env.ASF_TRUMP_BUNDLE_OUTPUT_DIR
      || join(root, '.artifacts/arcade-import-bundles'),
  );
  const result = packageTrumpVideoRoster({
    rosterRoot,
    highKickRoot,
    originalSourcePath,
    outputDirectory,
  });
  process.stdout.write(`${JSON.stringify({ status: 'packaged', ...result }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
