import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HUMANOID_POSTPROCESS_CANVAS,
  HUMANOID_POSTPROCESS_THRESHOLDS,
  analyzeForeground,
  applyUniformTransform,
  buildCheckerboardContactSheet,
  compositeRgbaOnPureChroma,
  computeRegistrationTransform,
  decontaminateForegroundRegion,
  evaluatePostprocessMetrics,
  keyHumanoidChroma,
  resizeRgbaNearest,
  scaleSourceBbox,
  suppressGreenSpill,
  transformedBbox,
} from './humanoid-pose-template-postprocess-core.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CORE_PATH = fileURLToPath(new URL('./humanoid-pose-template-postprocess-core.mjs', import.meta.url));
const root = dirname(dirname(SCRIPT_PATH));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_BYTES = 80 * 1024 * 1024;
const EXPECTED_EXPERIMENT_ID = 'humanoid-neutral-medium-xai-template-v4';
const EXPECTED_MODEL_ID = 'grok-imagine-image-2-edit';
const EXPECTED_PLAN_SHA256 = '6eae3d89e52a89e9e6b1c17f194ab1c93605aedb23521e2bb0dcc4a02878ff89';
const EXPECTED_STATE_SHA256 = '0cd3ec47df48421b38077deb30b803a97daeb5cc8ddae786525727d29af3b5c4';
const EXPECTED_INPUT_MANIFEST_SHA256 = 'd85fb7c4b8642fd1671fc6300a084d948c53a96172630ca4177c71e9aa8814b3';
const EXPECTED_POSES = 94;
const EXPECTED_FRAME_SLOTS = 98;
const EXPECTED_ALIASES = 4;
const QA_THUMBNAIL_WIDTH = 128;
const QA_THUMBNAIL_HEIGHT = 171;
const V5_EXPERIMENT_ID = 'humanoid-neutral-medium-xai-selective-v5';
const V5_INPUT_MANIFEST_SHA256 = '88db095eb86f716a798ba7c873c698ea87f1150da07d1b3909f500f39cc87578';
const V5_INPUT_PLAN_SHA256 = '51f7763cecb4ba9cc761846d5ae7a076660610c018bf4b180aea12eab31a8ac9';
const V5_CANARY_STATE_SHA256 = '77f519280e9701d833362c32f9cb008a238557eb02ad921a4f432f74d9a8c867';
const V5_CANARY_RUN_ID = '33343450009';
const V5_CANARY_GENERATOR_SHA = '0a66f1631958a5a96100eac8d39b9f9cc0cbed5f';
const V5_CANARY_ARTIFACT_ID = '9741312074';
const V5_CANARY_ARTIFACT_ZIP_SHA256 = '420adad6d1f4a97cbf18d3f00ec5f1676800f35988d97ac1d6b7d3594e840dcd';
const V5_CANARY_CIPHERTEXT_SHA256 = 'd48a3f78e0a1491fc36ca4310f723e8b9e0c00b3f4946d6970175bcacdfb293e';
const V5_CANARY_POSE_IDS = Object.freeze([
  'pose-007-8a6769c69246',
  'pose-022-df0e781f8635',
  'pose-050-3403e3eacd1f',
  'pose-071-138071f13b72',
  'pose-080-592f648f729a',
]);
const V5_REPAIR_POSE_IDS = Object.freeze([
  'pose-009-1c68f61f7b8e',
  'pose-010-08c72b553ad3',
  'pose-019-39abc3e8c7c8',
  'pose-021-f9ad82f8f8e1',
  'pose-023-b51d09cf8edc',
  'pose-032-45917e89bfe6',
  'pose-045-7d8079f55708',
  'pose-047-85c06b8f3ff4',
  'pose-048-a238272c2686',
  'pose-049-2def2dd84191',
  'pose-052-3230240640e1',
  'pose-055-5655accf5650',
  'pose-060-3f470ba7a879',
  'pose-061-86dfa9041794',
  'pose-063-9b96aee26b28',
  'pose-065-c469b54664bc',
  'pose-070-6b1de52c67b6',
  'pose-074-e755e505b366',
  'pose-079-f70b975fff94',
]);

export const HUMANOID_V5_REPLACEMENT_POSE_IDS = Object.freeze([
  ...V5_CANARY_POSE_IDS,
  ...V5_REPAIR_POSE_IDS,
]);

export const HUMANOID_V5_REPLACEMENT_CONTRACT = Object.freeze({
  experimentId: V5_EXPERIMENT_ID,
  inputManifestSha256: V5_INPUT_MANIFEST_SHA256,
  inputPlanSha256: V5_INPUT_PLAN_SHA256,
  repairPlanVerification: 'recomputed_from_sealed_linux_manifest',
  canaryStateSha256: V5_CANARY_STATE_SHA256,
  canaryRunId: V5_CANARY_RUN_ID,
  canaryGeneratorCommitSha: V5_CANARY_GENERATOR_SHA,
  canaryArtifactId: V5_CANARY_ARTIFACT_ID,
  canaryArtifactZipSha256: V5_CANARY_ARTIFACT_ZIP_SHA256,
  canaryCiphertextSha256: V5_CANARY_CIPHERTEXT_SHA256,
  replacementPoseCount: 24,
  retainedV4PoseCount: 70,
  combinedPoseCount: 94,
  repairPaidCalls: 19,
  repairCostMicrocredits: 1_900_000,
  combinedCostMicrocredits: 2_400_000,
});
export const HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL = Object.freeze({
  path: join(root, 'scripts', 'humanoid-v5-repair-trusted-seal.json'),
  contentSha256: 'd4a2b9a3094bde41eb32b0d2d7d7ac9f3a393169450825ec9bc3281254db5521',
  githubActionsRunId: '33345211634',
  githubArtifactId: '9741870159',
  generatorCommitSha: '8af2a462336263157137dab84620da4dcc9a9b12',
});

export const HUMANOID_POSTPROCESS_ID = 'humanoid-neutral-medium-xai-template-v4-postprocess-v1';
export const HUMANOID_V4_TRUSTED_SEAL = Object.freeze({
  executionStateSha256: EXPECTED_STATE_SHA256,
  inputManifestSha256: EXPECTED_INPUT_MANIFEST_SHA256,
  planSha256: EXPECTED_PLAN_SHA256,
  encryptedArtifactSha256: '6b38494913314b07fe0e3808f13512c0db3a0babd831daf0cf98a00163d2fab4',
  githubActionsRunId: '33340491399',
});
export const HUMANOID_POSTPROCESS_POLICY = Object.freeze({
  providerCalls: 0,
  inference: false,
  publish: false,
  import: false,
  activation: false,
  rawMutation: false,
  automaticRetry: false,
  humanReviewRequired: true,
  automatedSemanticApproval: false,
});

// Non-exhaustive findings from paired human review of the sealed full V4
// source/output frames. They are review evidence, never instructions to alter
// or auto-repair a raw. Runtime binding adds each state-sealed raw SHA-256.
export const HUMANOID_POSTPROCESS_KNOWN_VISUAL_FINDINGS = Object.freeze([
  Object.freeze({ category: 'outfit', animationName: 'high_punch', frameNumber: 2, poseId: 'pose-019-39abc3e8c7c8', finding: 'barefoot_or_footed_outfit_violation' }),
  Object.freeze({ category: 'outfit', animationName: 'idle', frameNumber: 4, poseId: 'pose-032-45917e89bfe6', finding: 'barefoot_or_footed_outfit_violation' }),
  Object.freeze({ category: 'outfit', animationName: 'ko', frameNumber: 1, poseId: 'pose-045-7d8079f55708', finding: 'barefoot_or_footed_outfit_violation' }),
  Object.freeze({ category: 'outfit', animationName: 'ko', frameNumber: 3, poseId: 'pose-047-85c06b8f3ff4', finding: 'barefoot_or_footed_outfit_violation' }),
  Object.freeze({ category: 'outfit', animationName: 'ko', frameNumber: 6, poseId: 'pose-050-3403e3eacd1f', finding: 'barefoot_or_footed_outfit_violation' }),
  Object.freeze({ category: 'outfit', animationName: 'ko', frameNumber: 8, poseId: 'pose-052-3230240640e1', finding: 'barefoot_or_footed_outfit_violation' }),
  Object.freeze({ category: 'outfit', animationName: 'low_kick', frameNumber: 4, poseId: 'pose-060-3f470ba7a879', finding: 'barefoot_or_footed_outfit_violation' }),
  Object.freeze({ category: 'outfit', animationName: 'victory', frameNumber: 4, poseId: 'pose-074-e755e505b366', finding: 'barefoot_or_footed_outfit_violation' }),
  Object.freeze({ category: 'pose', animationName: 'high_kick', frameNumber: 2, poseId: 'pose-007-8a6769c69246', finding: 'premature_full_kick_vs_source' }),
  Object.freeze({ category: 'pose', animationName: 'high_kick', frameNumber: 4, poseId: 'pose-009-1c68f61f7b8e', finding: 'premature_full_kick_vs_source' }),
  Object.freeze({ category: 'pose', animationName: 'high_kick', frameNumber: 5, poseId: 'pose-010-08c72b553ad3', finding: 'premature_full_kick_vs_source' }),
  Object.freeze({ category: 'pose', animationName: 'high_kick', frameNumber: 6, poseId: 'pose-011-b6a2c729e48f', finding: 'over_raised_knee_vs_source' }),
  Object.freeze({ category: 'pose', animationName: 'high_punch', frameNumber: 3, poseId: 'pose-020-81d1a300ad34', finding: 'extension_progression_missing' }),
  Object.freeze({ category: 'pose', animationName: 'high_punch', frameNumber: 4, poseId: 'pose-021-f9ad82f8f8e1', finding: 'extension_progression_missing' }),
  Object.freeze({ category: 'pose', animationName: 'high_punch', frameNumber: 5, poseId: 'pose-022-df0e781f8635', finding: 'extension_progression_missing' }),
  Object.freeze({ category: 'pose', animationName: 'high_punch', frameNumber: 6, poseId: 'pose-023-b51d09cf8edc', finding: 'extension_progression_missing' }),
  Object.freeze({ category: 'pose', animationName: 'ko', frameNumber: 3, poseId: 'pose-047-85c06b8f3ff4', finding: 'fall_progression_mismatch' }),
  Object.freeze({ category: 'pose', animationName: 'ko', frameNumber: 4, poseId: 'pose-048-a238272c2686', finding: 'fall_progression_mismatch' }),
  Object.freeze({ category: 'pose', animationName: 'ko', frameNumber: 5, poseId: 'pose-049-2def2dd84191', finding: 'fall_progression_mismatch' }),
  Object.freeze({ category: 'pose', animationName: 'ko', frameNumber: 6, poseId: 'pose-050-3403e3eacd1f', finding: 'upright_guard_instead_of_airborne_fall' }),
  Object.freeze({ category: 'pose', animationName: 'ko', frameNumber: 8, poseId: 'pose-052-3230240640e1', finding: 'airborne_face_down_fall_became_all_fours' }),
  Object.freeze({ category: 'pose', animationName: 'ko', frameNumber: 11, poseId: 'pose-055-5655accf5650', finding: 'kneeling_or_crawling_instead_of_near_prone' }),
  Object.freeze({ category: 'pose', animationName: 'low_kick', frameNumber: 5, poseId: 'pose-061-86dfa9041794', finding: 'stance_or_hip_height_mismatch' }),
  Object.freeze({ category: 'pose', animationName: 'low_kick', frameNumber: 7, poseId: 'pose-063-9b96aee26b28', finding: 'stance_or_hip_height_mismatch' }),
  Object.freeze({ category: 'pose', animationName: 'low_kick', frameNumber: 9, poseId: 'pose-065-c469b54664bc', finding: 'deep_low_sweep_became_upright_higher_kick' }),
  Object.freeze({ category: 'pose', animationName: 'low_punch', frameNumber: 5, poseId: 'pose-069-70fd79284ae2', finding: 'arm_anticipation_missing_but_crouch_phase_retained' }),
  Object.freeze({ category: 'pose', animationName: 'low_punch', frameNumber: 6, poseId: 'pose-070-6b1de52c67b6', finding: 'punch_extension_missing' }),
  Object.freeze({ category: 'pose', animationName: 'low_punch', frameNumber: 7, poseId: 'pose-071-138071f13b72', finding: 'punch_extension_missing' }),
  Object.freeze({ category: 'pose', animationName: 'victory', frameNumber: 4, poseId: 'pose-074-e755e505b366', finding: 'arm_raise_progression_became_guard' }),
  Object.freeze({ category: 'pose', animationName: 'victory', frameNumber: 9, poseId: 'pose-079-f70b975fff94', finding: 'return_or_hands_down_transition_missing' }),
  Object.freeze({ category: 'pose', animationName: 'victory', frameNumber: 10, poseId: 'pose-080-592f648f729a', finding: 'return_or_hands_down_transition_missing' }),
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function inspectPngBytes(bytes, label = 'PNG') {
  invariant(Buffer.isBuffer(bytes), `${label} is not bytes.`);
  invariant(bytes.byteLength >= 33 && bytes.byteLength <= MAX_PNG_BYTES, `${label} size is outside bounds.`);
  invariant(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), `${label} signature is invalid.`);
  invariant(bytes.toString('ascii', 12, 16) === 'IHDR', `${label} has no IHDR.`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  invariant(width > 0 && height > 0 && width <= 16_384 && height <= 16_384, `${label} dimensions are invalid.`);
  return {
    width,
    height,
    bitDepth: bytes[24],
    colorType: bytes[25],
    sizeBytes: bytes.byteLength,
    contentSha256: sha256(bytes),
  };
}

function safeResolve(parent, child, label) {
  invariant(typeof child === 'string' && child.length > 0 && !child.includes('\0'), `${label} path is invalid.`);
  const resolvedParent = resolve(parent);
  const resolved = resolve(resolvedParent, child);
  invariant(resolved.startsWith(`${resolvedParent}${sep}`), `${label} path escapes its directory.`);
  return resolved;
}

function pathIdentity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.mode}`;
}

function inspectNoSymlinkChain(path, label) {
  const absolutePath = resolve(path);
  const { root: filesystemRoot } = parse(absolutePath);
  const segments = absolutePath.slice(filesystemRoot.length).split(sep).filter(Boolean);
  const records = [];
  let cursor = filesystemRoot;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = join(cursor, segments[index]);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`${label} is missing: ${cursor}`);
      throw error;
    }
    invariant(!stat.isSymbolicLink(), `${label} contains a symbolic link: ${cursor}`);
    if (index < segments.length - 1) invariant(stat.isDirectory(), `${label} ancestor is not a directory: ${cursor}`);
    records.push({ path: cursor, identity: pathIdentity(stat), stat });
  }
  return { absolutePath, records };
}

function assertStablePathChain(before, after, label) {
  invariant(before.absolutePath === after.absolutePath && before.records.length === after.records.length, `${label} path changed while it was read.`);
  for (let index = 0; index < before.records.length; index += 1) {
    invariant(
      before.records[index].path === after.records[index].path
        && before.records[index].identity === after.records[index].identity,
      `${label} path changed while it was read: ${before.records[index].path}`,
    );
  }
}

function physicalDirectory(path, label) {
  const chain = inspectNoSymlinkChain(path, label);
  const leaf = chain.records.at(-1)?.stat;
  invariant(leaf?.isDirectory(), `${label} is not a directory.`);
  const physicalPath = realpathSync.native(chain.absolutePath);
  invariant(physicalPath === chain.absolutePath, `${label} is not a physical no-symlink path.`);
  return physicalPath;
}

function isWithin(parent, child) {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

export function readRegularFileSnapshot(path, label = 'file', options = {}) {
  const absolutePath = resolve(path);
  if (options.containmentRoot) {
    const physicalRoot = physicalDirectory(options.containmentRoot, `${label} containment root`);
    invariant(absolutePath.startsWith(`${physicalRoot}${sep}`), `${label} escapes its physical containment root.`);
  }
  const before = inspectNoSymlinkChain(absolutePath, label);
  const beforeLeaf = before.records.at(-1)?.stat;
  invariant(beforeLeaf?.isFile(), `${label} is not a regular file.`);
  const physicalPath = realpathSync.native(absolutePath);
  invariant(physicalPath === absolutePath, `${label} is not a physical no-symlink path.`);
  let fileDescriptor;
  let bytes;
  let openedBefore;
  let openedAfter;
  try {
    fileDescriptor = openSync(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    openedBefore = fstatSync(fileDescriptor);
    invariant(openedBefore.isFile(), `${label} opened object is not a regular file.`);
    invariant(openedBefore.dev === beforeLeaf.dev && openedBefore.ino === beforeLeaf.ino, `${label} changed before it was opened.`);
    if (options.maxBytes !== undefined) invariant(openedBefore.size <= options.maxBytes, `${label} exceeds its byte limit.`);
    bytes = readFileSync(fileDescriptor);
    openedAfter = fstatSync(fileDescriptor);
    invariant(bytes.byteLength === openedBefore.size, `${label} byte count changed while it was read.`);
    invariant(
      openedAfter.dev === openedBefore.dev
        && openedAfter.ino === openedBefore.ino
        && openedAfter.size === openedBefore.size
        && openedAfter.mtimeMs === openedBefore.mtimeMs
        && openedAfter.ctimeMs === openedBefore.ctimeMs,
      `${label} was modified while it was read.`,
    );
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
  }
  const after = inspectNoSymlinkChain(absolutePath, label);
  assertStablePathChain(before, after, label);
  invariant(realpathSync.native(absolutePath) === physicalPath, `${label} physical path changed while it was read.`);
  return Object.freeze({
    path: absolutePath,
    physicalPath,
    bytes,
    sizeBytes: bytes.byteLength,
    contentSha256: sha256(bytes),
    device: beforeLeaf.dev,
    inode: beforeLeaf.ino,
  });
}

function snapshotImplementation() {
  const script = readRegularFileSnapshot(SCRIPT_PATH, 'postprocess implementation script');
  const core = readRegularFileSnapshot(CORE_PATH, 'postprocess implementation core');
  return Object.freeze({
    scriptSha256: script.contentSha256,
    coreSha256: core.contentSha256,
  });
}

function assertImplementationUnchanged(snapshot) {
  const current = snapshotImplementation();
  invariant(
    current.scriptSha256 === snapshot.scriptSha256 && current.coreSha256 === snapshot.coreSha256,
    'Postprocess implementation changed during execution; refusing to emit a manifest.',
  );
}

function ensureSecureOutputDirectory(outputRoot, directory) {
  const physicalRoot = physicalDirectory(outputRoot, 'postprocess output root');
  const absoluteDirectory = resolve(directory);
  invariant(isWithin(physicalRoot, absoluteDirectory), 'Output directory escapes the postprocess output root.');
  const suffix = relative(physicalRoot, absoluteDirectory);
  let cursor = physicalRoot;
  for (const segment of suffix.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      mkdirSync(cursor, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(cursor);
    invariant(!stat.isSymbolicLink() && stat.isDirectory(), `Output directory is not a physical directory: ${cursor}`);
  }
  invariant(realpathSync.native(absoluteDirectory) === absoluteDirectory, 'Output directory resolved through a symbolic link.');
}

function assertAvailableOutputEntry(outputRoot, destination) {
  const absoluteDestination = resolve(destination);
  const physicalRoot = physicalDirectory(outputRoot, 'postprocess output root');
  invariant(absoluteDestination.startsWith(`${physicalRoot}${sep}`), 'Output entry escapes the postprocess output root.');
  ensureSecureOutputDirectory(physicalRoot, dirname(absoluteDestination));
  try {
    const existing = lstatSync(absoluteDestination);
    const kind = existing.isSymbolicLink() ? 'symbolic link' : 'existing entry';
    throw new Error(`Refusing to replace output ${kind}: ${absoluteDestination}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return absoluteDestination;
}

function temporaryPath(destination) {
  return join(dirname(destination), `.${basename(destination)}.writing-${process.pid}-${randomUUID()}`);
}

export function writeBytesAtomicExclusive(path, bytes, outputRoot) {
  invariant(Buffer.isBuffer(bytes) || ArrayBuffer.isView(bytes), 'Atomic output must be bytes.');
  const destination = assertAvailableOutputEntry(outputRoot, path);
  const temporary = temporaryPath(destination);
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    chmodSync(temporary, 0o600);
    linkSync(temporary, destination);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  unlinkSync(temporary);
  const stat = lstatSync(destination);
  invariant(!stat.isSymbolicLink() && stat.isFile(), `Atomic output is not a regular file: ${destination}`);
}

function writeJsonAtomic(path, value, outputRoot) {
  writeBytesAtomicExclusive(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), outputRoot);
}

function writeBytesAtomic(path, bytes, outputRoot) {
  writeBytesAtomicExclusive(path, bytes, outputRoot);
}

function createOutputRootExclusive(outputDirectory) {
  const absoluteOutputDirectory = resolve(outputDirectory);
  const parent = dirname(absoluteOutputDirectory);
  physicalDirectory(parent, 'postprocess output parent');
  try {
    mkdirSync(absoluteOutputDirectory, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Postprocess output already exists; raw-preserving runs are immutable.');
    throw error;
  }
  invariant(physicalDirectory(absoluteOutputDirectory, 'postprocess output root') === absoluteOutputDirectory, 'Postprocess output root is not physical.');
  return absoluteOutputDirectory;
}

function runCommand(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: options.binary ? null : 'utf8',
    input: options.input,
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr;
    throw new Error(`${basename(binary)} failed: ${(result.error?.message ?? stderr ?? '').trim().slice(-4000)}`);
  }
  return result.stdout;
}

function ffmpegVersion(ffmpegBinary) {
  return String(runCommand(ffmpegBinary, ['-version'])).split(/\r?\n/, 1)[0].trim();
}

function decodePixels(pngBytes, label, pixelFormat, width, height, ffmpegBinary) {
  invariant(Buffer.isBuffer(pngBytes), `${label} PNG snapshot is not bytes.`);
  const bytes = runCommand(ffmpegBinary, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
    '-i', 'pipe:0', '-map', '0:v:0', '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', pixelFormat, 'pipe:1',
  ], { binary: true, input: pngBytes });
  const channels = pixelFormat === 'rgba' ? 4 : 3;
  invariant(bytes.byteLength === width * height * channels, `Decoded ${pixelFormat} byte length changed for ${label}.`);
  return bytes;
}

function encodePng({ pixels, width, height, pixelFormat, outputPath, outputRoot, ffmpegBinary }) {
  invariant(pixelFormat === 'rgba' || pixelFormat === 'rgb24', 'PNG pixel format is invalid.');
  const channels = pixelFormat === 'rgba' ? 4 : 3;
  invariant(pixels.length === width * height * channels, 'PNG source dimensions do not match.');
  const bytes = runCommand(ffmpegBinary, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
    '-f', 'rawvideo', '-pix_fmt', pixelFormat, '-s', `${width}x${height}`, '-i', 'pipe:0',
    '-map_metadata', '-1', '-frames:v', '1', '-pix_fmt', pixelFormat,
    '-compression_level', '9', '-pred', 'mixed', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1',
  ], { binary: true, input: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength) });
  const inspected = inspectPngBytes(bytes, `encoded ${pixelFormat} PNG`);
  invariant(inspected.width === width && inspected.height === height && inspected.bitDepth === 8, 'Encoded PNG geometry or bit depth changed.');
  invariant(inspected.colorType === (pixelFormat === 'rgba' ? 6 : 2), `Encoded ${pixelFormat} PNG color type changed.`);
  writeBytesAtomicExclusive(outputPath, bytes, outputRoot);
  return inspected;
}

export function encodeGif({ frames, width, height, outputPath, outputRoot, ffmpegBinary, frameRate = 8 }) {
  invariant(Array.isArray(frames) && frames.length > 0, 'GIF frames are required.');
  invariant(frames.every((frame) => frame.length === width * height * 3), 'GIF frame dimensions do not match.');
  const input = Buffer.concat(frames);
  const bytes = runCommand(ffmpegBinary, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_complex_threads', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-framerate', String(frameRate), '-i', 'pipe:0',
    '-filter_complex', '[0:v]split[palette_source][gif_source];[palette_source]palettegen=max_colors=128:stats_mode=diff[palette];[gif_source][palette]paletteuse=dither=bayer:bayer_scale=3',
    '-frames:v', String(frames.length), '-loop', '0', '-map_metadata', '-1', '-f', 'gif', 'pipe:1',
  ], { binary: true, input, maxBuffer: 512 * 1024 * 1024 });
  invariant(bytes.subarray(0, 6).toString('ascii') === 'GIF89a' || bytes.subarray(0, 6).toString('ascii') === 'GIF87a', 'Encoded GIF signature is invalid.');
  writeBytesAtomicExclusive(outputPath, bytes, outputRoot);
  return { width, height, sizeBytes: bytes.byteLength, contentSha256: sha256(bytes) };
}

function outputDescriptor(path, outputDirectory, expected = {}) {
  const { bytes } = readRegularFileSnapshot(path, 'output', { containmentRoot: outputDirectory });
  const inspected = inspectPngBytes(bytes, 'output PNG');
  if (expected.width) invariant(inspected.width === expected.width, 'Output width changed.');
  if (expected.height) invariant(inspected.height === expected.height, 'Output height changed.');
  if (expected.colorType !== undefined) invariant(inspected.colorType === expected.colorType, 'Output PNG color type changed.');
  return { path: relative(outputDirectory, path), mimeType: 'image/png', ...inspected };
}

function gifDescriptor(path, outputDirectory, geometry) {
  const { bytes } = readRegularFileSnapshot(path, 'QA GIF', { containmentRoot: outputDirectory });
  return {
    path: relative(outputDirectory, path),
    mimeType: 'image/gif',
    width: geometry.width,
    height: geometry.height,
    sizeBytes: bytes.byteLength,
    contentSha256: sha256(bytes),
  };
}

function verifyPureChroma(rgb, width, height) {
  invariant(rgb.length === width * height * 3, 'RGB24 chroma dimensions do not match.');
  for (const offset of [
    0,
    (width - 1) * 3,
    (height - 1) * width * 3,
    (width * height - 1) * 3,
  ]) {
    invariant(rgb[offset] === 0 && rgb[offset + 1] === 255 && rgb[offset + 2] === 0, 'Chroma master corner is not exact #00FF00.');
  }
}

function verifyTransparentCorners(rgba, width, height, label) {
  for (const offset of [
    3,
    (width - 1) * 4 + 3,
    (height - 1) * width * 4 + 3,
    (width * height - 1) * 4 + 3,
  ]) invariant(rgba[offset] === 0, `${label} corner is not transparent.`);
}

function expectedRawPath(workDirectory, manifest, pose) {
  const filename = `${pose.poseId}--${manifest.model.id}--image.png`;
  return safeResolve(join(workDirectory, 'outputs', manifest.experimentId), filename, `${pose.poseId} raw`);
}

function verifyStateArtifactPath(path, manifest, pose) {
  invariant(typeof path === 'string' && !path.includes('\0') && !path.split('/').includes('..'), `${pose.poseId} state artifact path is invalid.`);
  const expectedSuffix = `/outputs/${manifest.experimentId}/${pose.poseId}--${manifest.model.id}--image.png`;
  invariant(`/${path.replace(/^\.\//, '')}`.endsWith(expectedSuffix), `${pose.poseId} state artifact path changed.`);
}

export function verifyHumanoidPostprocessInputs({
  workDirectory,
  knownVisualFindings = HUMANOID_POSTPROCESS_KNOWN_VISUAL_FINDINGS,
}) {
  const resolvedWorkDirectory = physicalDirectory(resolve(workDirectory), 'sealed humanoid work directory');
  const stateSnapshot = readRegularFileSnapshot(
    join(resolvedWorkDirectory, 'state.json'),
    'humanoid execution state',
    { containmentRoot: resolvedWorkDirectory },
  );
  const manifestSnapshot = readRegularFileSnapshot(
    join(resolvedWorkDirectory, 'inputs', 'input-manifest.json'),
    'humanoid input manifest',
    { containmentRoot: resolvedWorkDirectory },
  );
  invariant(stateSnapshot.contentSha256 === EXPECTED_STATE_SHA256, 'Humanoid execution state SHA-256 is not the exact trusted V4 state.');
  invariant(manifestSnapshot.contentSha256 === EXPECTED_INPUT_MANIFEST_SHA256, 'Humanoid input manifest SHA-256 is not the exact trusted V4 manifest.');
  const stateBytes = stateSnapshot.bytes;
  const manifestBytes = manifestSnapshot.bytes;
  const state = JSON.parse(stateBytes.toString('utf8'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const { planSha256, ...manifestCore } = manifest;

  invariant(manifest.experimentId === EXPECTED_EXPERIMENT_ID, 'Only the sealed V4 humanoid experiment can be postprocessed.');
  invariant(manifest.model?.id === EXPECTED_MODEL_ID, 'Humanoid source model changed.');
  invariant(planSha256 === sha256(canonicalJson(manifestCore)), 'Humanoid input plan SHA-256 changed.');
  invariant(planSha256 === EXPECTED_PLAN_SHA256, 'Humanoid V4 input plan is not the reviewed production plan.');
  invariant(state.experimentId === manifest.experimentId && state.planSha256 === manifest.planSha256, 'Execution state does not match the input plan.');
  invariant(state.manifestSha256 === sha256(manifestBytes), 'Execution state manifest SHA-256 changed.');
  invariant(state.status === 'full_complete_human_review_required', 'Only a completed 94-pose V4 run can be postprocessed.');
  invariant(state.completedPoseCount === EXPECTED_POSES, 'Execution state does not contain exactly 94 completed poses.');
  invariant(Array.isArray(manifest.uniquePoses) && manifest.uniquePoses.length === EXPECTED_POSES, 'Input manifest does not contain exactly 94 unique poses.');
  invariant(Array.isArray(manifest.frameSlots) && manifest.frameSlots.length === EXPECTED_FRAME_SLOTS, 'Input manifest does not contain exactly 98 frame slots.');
  invariant(state.slots && typeof state.slots === 'object' && !Array.isArray(state.slots), 'Execution slots are invalid.');

  const poseIds = manifest.uniquePoses.map((pose) => pose.poseId);
  invariant(new Set(poseIds).size === EXPECTED_POSES, 'Input pose ids are not unique.');
  invariant(canonicalJson(Object.keys(state.slots).sort()) === canonicalJson([...poseIds].sort()), 'Execution state slot set differs from the 94-pose plan.');
  const frameKeys = new Set();
  const slotCounts = new Map();
  for (const frameSlot of manifest.frameSlots) {
    invariant(poseIds.includes(frameSlot.poseId), 'Frame slot references an unknown pose.');
    const key = `${frameSlot.animationName}:${frameSlot.frameNumber}`;
    invariant(!frameKeys.has(key), `Duplicate frame slot ${key}.`);
    frameKeys.add(key);
    slotCounts.set(frameSlot.poseId, (slotCounts.get(frameSlot.poseId) ?? 0) + 1);
  }
  const aliasPoseIds = [...slotCounts].filter(([, count]) => count > 1).map(([poseId]) => poseId);
  invariant(aliasPoseIds.length === EXPECTED_ALIASES && aliasPoseIds.every((poseId) => slotCounts.get(poseId) === 2), 'Expected exactly four two-slot aliases.');
  for (const pose of manifest.uniquePoses) {
    invariant(Array.isArray(pose.sourceSlots) && pose.sourceSlots.length > 0, `${pose.poseId} source slots are invalid.`);
    const plannedSlots = manifest.frameSlots
      .filter((slot) => slot.poseId === pose.poseId)
      .map(({ animationName, frameNumber }) => ({ animationName, frameNumber }));
    invariant(canonicalJson(pose.sourceSlots) === canonicalJson(plannedSlots), `${pose.poseId} source slots differ from frame slots.`);
  }

  const inputsDirectory = physicalDirectory(join(resolvedWorkDirectory, 'inputs'), 'humanoid inputs directory');
  const verified = [];
  for (const pose of manifest.uniquePoses) {
    invariant(/^pose-[0-9]{3}-[a-f0-9]{12}$/.test(pose.poseId ?? ''), 'Pose id is invalid.');
    const sourcePath = safeResolve(inputsDirectory, pose.path, `${pose.poseId} source`);
    const sourceSnapshot = readRegularFileSnapshot(sourcePath, `${pose.poseId} source`, { containmentRoot: inputsDirectory, maxBytes: MAX_PNG_BYTES });
    const source = inspectPngBytes(sourceSnapshot.bytes, `${pose.poseId} source`);
    invariant(source.contentSha256 === pose.contentSha256, `${pose.poseId} source SHA-256 changed.`);
    invariant(source.width === HUMANOID_POSTPROCESS_CANVAS.sourceWidth && source.height === HUMANOID_POSTPROCESS_CANVAS.sourceHeight, `${pose.poseId} source dimensions changed.`);

    const slot = state.slots[pose.poseId];
    invariant(slot?.status === 'completed', `${pose.poseId} execution is not completed.`);
    const artifact = slot.artifacts?.image;
    invariant(artifact?.mimeType === 'image/png', `${pose.poseId} raw MIME changed.`);
    invariant(artifact.width === HUMANOID_POSTPROCESS_CANVAS.outputWidth && artifact.height === HUMANOID_POSTPROCESS_CANVAS.outputHeight, `${pose.poseId} raw state dimensions changed.`);
    verifyStateArtifactPath(artifact.path, manifest, pose);
    const rawPath = expectedRawPath(resolvedWorkDirectory, manifest, pose);
    const rawSnapshot = readRegularFileSnapshot(rawPath, `${pose.poseId} raw`, { containmentRoot: resolvedWorkDirectory, maxBytes: MAX_PNG_BYTES });
    const raw = inspectPngBytes(rawSnapshot.bytes, `${pose.poseId} raw`);
    invariant(raw.contentSha256 === artifact.contentSha256 && raw.sizeBytes === artifact.sizeBytes, `${pose.poseId} raw bytes differ from execution state.`);
    invariant(raw.width === HUMANOID_POSTPROCESS_CANVAS.outputWidth && raw.height === HUMANOID_POSTPROCESS_CANVAS.outputHeight, `${pose.poseId} raw dimensions changed.`);
    verified.push(Object.freeze({
      pose,
      slot,
      sourcePath,
      source,
      sourceBytes: sourceSnapshot.bytes,
      rawPath,
      raw,
      rawBytes: rawSnapshot.bytes,
    }));
  }

  const knownVisualReviewFindings = knownVisualFindings.map((finding) => {
    const matchingSlots = manifest.frameSlots.filter((slot) => (
      slot.animationName === finding.animationName
      && slot.frameNumber === finding.frameNumber
      && slot.poseId === finding.poseId
    ));
    invariant(matchingSlots.length === 1, `Known visual finding no longer maps exactly to ${finding.animationName} frame ${finding.frameNumber}.`);
    const rawContentSha256 = state.slots[finding.poseId]?.artifacts?.image?.contentSha256;
    invariant(/^[a-f0-9]{64}$/.test(rawContentSha256 ?? ''), `Known visual finding ${finding.poseId} has no sealed raw hash.`);
    return { ...finding, rawContentSha256 };
  });

  return {
    workDirectory: resolvedWorkDirectory,
    state,
    manifest,
    stateSha256: stateSnapshot.contentSha256,
    manifestSha256: manifestSnapshot.contentSha256,
    aliasPoseIds,
    knownVisualReviewFindings,
    verified,
  };
}

function humanoidManifestTopology(manifest) {
  return {
    uniquePoses: manifest.uniquePoses.map((pose) => ({
      poseId: pose.poseId,
      path: pose.path,
      contentSha256: pose.contentSha256,
      inputPixelSha256: pose.inputPixelSha256,
      width: pose.width,
      height: pose.height,
      sourceSlots: pose.sourceSlots,
    })),
    frameSlots: manifest.frameSlots,
  };
}

function assertSha256(value, label) {
  invariant(/^[a-f0-9]{64}$/.test(value ?? ''), `${label} is not a SHA-256 digest.`);
}

export function validateHumanoidV5ReplacementSeal(seal) {
  const exactKeys = [
    'schemaVersion',
    'experimentId',
    'githubActionsRunId',
    'generatorCommitSha',
    'githubArtifactId',
    'githubArtifactName',
    'githubArtifactZipSha256',
    'encryptedArtifactSha256',
    'inputManifestSha256',
    'inputPlanSha256',
    'executionStateSha256',
    'repairManifestSha256',
    'repairPlanSha256',
    'sourceCanaryRunId',
    'sourceCanaryGeneratorCommitSha',
    'sourceCanaryArtifactId',
    'sourceCanaryArtifactZipSha256',
    'sourceCanaryCiphertextSha256',
    'sourceCanaryStateSha256',
    'replacementPoseIds',
  ];
  invariant(
    seal && typeof seal === 'object' && !Array.isArray(seal)
      && canonicalJson(Object.keys(seal).sort()) === canonicalJson(exactKeys.sort()),
    'V5 replacement trust seal shape changed.',
  );
  invariant(seal.schemaVersion === 1, 'V5 replacement trust seal schema changed.');
  invariant(seal.experimentId === V5_EXPERIMENT_ID, 'V5 replacement trust seal experiment changed.');
  invariant(/^[1-9][0-9]*$/.test(seal.githubActionsRunId ?? ''), 'V5 repair run id is invalid.');
  invariant(/^[a-f0-9]{40}$/.test(seal.generatorCommitSha ?? ''), 'V5 repair generator SHA is invalid.');
  invariant(/^[1-9][0-9]*$/.test(seal.githubArtifactId ?? ''), 'V5 repair artifact id is invalid.');
  invariant(seal.githubActionsRunId === HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL.githubActionsRunId, 'V5 repair run changed.');
  invariant(seal.githubArtifactId === HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL.githubArtifactId, 'V5 repair artifact changed.');
  invariant(seal.generatorCommitSha === HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL.generatorCommitSha, 'V5 repair generator changed.');
  invariant(
    seal.githubArtifactName === 'humanoid-neutral-medium-xai-selective-v5-repair-encrypted',
    'V5 repair artifact name changed.',
  );
  for (const [value, label] of [
    [seal.githubArtifactZipSha256, 'V5 repair artifact ZIP SHA-256'],
    [seal.encryptedArtifactSha256, 'V5 repair ciphertext SHA-256'],
    [seal.inputManifestSha256, 'V5 input manifest SHA-256'],
    [seal.inputPlanSha256, 'V5 input plan SHA-256'],
    [seal.executionStateSha256, 'V5 execution state SHA-256'],
    [seal.repairManifestSha256, 'V5 repair manifest SHA-256'],
    [seal.repairPlanSha256, 'V5 repair plan SHA-256'],
    [seal.sourceCanaryArtifactZipSha256, 'V5 source canary ZIP SHA-256'],
    [seal.sourceCanaryCiphertextSha256, 'V5 source canary ciphertext SHA-256'],
    [seal.sourceCanaryStateSha256, 'V5 source canary state SHA-256'],
  ]) assertSha256(value, label);
  invariant(seal.inputManifestSha256 === V5_INPUT_MANIFEST_SHA256, 'V5 input manifest trust pin changed.');
  invariant(seal.inputPlanSha256 === V5_INPUT_PLAN_SHA256, 'V5 input plan trust pin changed.');
  invariant(seal.sourceCanaryRunId === V5_CANARY_RUN_ID, 'V5 source canary run changed.');
  invariant(seal.sourceCanaryGeneratorCommitSha === V5_CANARY_GENERATOR_SHA, 'V5 source canary generator changed.');
  invariant(seal.sourceCanaryArtifactId === V5_CANARY_ARTIFACT_ID, 'V5 source canary artifact changed.');
  invariant(seal.sourceCanaryArtifactZipSha256 === V5_CANARY_ARTIFACT_ZIP_SHA256, 'V5 source canary ZIP changed.');
  invariant(seal.sourceCanaryCiphertextSha256 === V5_CANARY_CIPHERTEXT_SHA256, 'V5 source canary ciphertext changed.');
  invariant(seal.sourceCanaryStateSha256 === V5_CANARY_STATE_SHA256, 'V5 source canary state changed.');
  invariant(Array.isArray(seal.replacementPoseIds), 'V5 replacement pose set is not an array.');
  invariant(
    canonicalJson([...seal.replacementPoseIds].sort()) === canonicalJson([...HUMANOID_V5_REPLACEMENT_POSE_IDS].sort()),
    'V5 replacement pose set changed.',
  );
  invariant(new Set(seal.replacementPoseIds).size === 24, 'V5 replacement pose set is not exactly 24 unique poses.');
  return seal;
}

export function loadHumanoidV5ReplacementSeal({ sealPath, expectedSealSha256 }) {
  assertSha256(expectedSealSha256, 'V5 replacement trust-seal SHA-256');
  const snapshot = readRegularFileSnapshot(resolve(sealPath), 'V5 replacement trust seal', { maxBytes: 64 * 1024 });
  invariant(snapshot.contentSha256 === expectedSealSha256, 'V5 replacement trust-seal bytes changed.');
  const seal = JSON.parse(snapshot.bytes.toString('utf8'));
  validateHumanoidV5ReplacementSeal(seal);
  return Object.freeze({
    seal,
    sealPath: snapshot.path,
    sealSha256: snapshot.contentSha256,
  });
}

function verifyHumanoidV5ReplacementInputs({
  baseInput,
  replacementWorkDirectory,
  replacementSealRecord,
}) {
  const { seal, sealSha256 } = replacementSealRecord;
  validateHumanoidV5ReplacementSeal(seal);
  assertSha256(sealSha256, 'V5 replacement trust-seal SHA-256');
  invariant(
    sealSha256 === HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL.contentSha256
      && replacementSealRecord.sealPath === resolve(HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL.path),
    'V5 replacement verifier accepts only the committed reviewed trust seal.',
  );
  const workDirectory = physicalDirectory(resolve(replacementWorkDirectory), 'sealed V5 replacement work directory');
  const stateSnapshot = readRegularFileSnapshot(
    join(workDirectory, 'state.json'),
    'V5 replacement execution state',
    { containmentRoot: workDirectory },
  );
  const manifestSnapshot = readRegularFileSnapshot(
    join(workDirectory, 'inputs', 'input-manifest.json'),
    'V5 replacement input manifest',
    { containmentRoot: workDirectory },
  );
  const repairManifestSnapshot = readRegularFileSnapshot(
    join(workDirectory, 'inputs', 'repair-input-manifest.json'),
    'V5 repair input manifest',
    { containmentRoot: workDirectory },
  );
  invariant(stateSnapshot.contentSha256 === seal.executionStateSha256, 'V5 replacement execution state is not the reviewed sealed state.');
  invariant(manifestSnapshot.contentSha256 === seal.inputManifestSha256, 'V5 replacement input manifest is not the reviewed sealed manifest.');
  invariant(repairManifestSnapshot.contentSha256 === seal.repairManifestSha256, 'V5 repair manifest is not the reviewed sealed manifest.');

  const state = JSON.parse(stateSnapshot.bytes.toString('utf8'));
  const manifest = JSON.parse(manifestSnapshot.bytes.toString('utf8'));
  const repairManifest = JSON.parse(repairManifestSnapshot.bytes.toString('utf8'));
  const { planSha256, ...manifestCore } = manifest;
  const { planSha256: repairPlanSha256, ...repairManifestCore } = repairManifest;
  invariant(manifest.schemaVersion === 2 && manifest.experimentId === V5_EXPERIMENT_ID, 'V5 replacement manifest identity changed.');
  invariant(manifest.model?.id === EXPECTED_MODEL_ID, 'V5 replacement model changed.');
  invariant(planSha256 === sha256(canonicalJson(manifestCore)) && planSha256 === V5_INPUT_PLAN_SHA256, 'V5 replacement input plan changed.');
  invariant(
    repairPlanSha256 === sha256(canonicalJson(repairManifestCore))
      && repairPlanSha256 === seal.repairPlanSha256,
    'V5 repair plan differs from the recomputed sealed Linux plan.',
  );
  invariant(
    canonicalJson(humanoidManifestTopology(manifest)) === canonicalJson(humanoidManifestTopology(baseInput.manifest)),
    'V5 replacement pose topology differs from the sealed V4 plan.',
  );
  invariant(repairManifest.schemaVersion === 1 && repairManifest.experimentId === V5_EXPERIMENT_ID, 'V5 repair manifest identity changed.');
  invariant(repairManifest.sourceManifestSha256 === V5_INPUT_MANIFEST_SHA256, 'V5 repair source manifest changed.');
  invariant(repairManifest.sourcePlanSha256 === V5_INPUT_PLAN_SHA256, 'V5 repair source plan changed.');
  invariant(repairManifest.sourceStateSha256 === V5_CANARY_STATE_SHA256, 'V5 repair source state changed.');
  invariant(
    canonicalJson(repairManifest.selection?.map((entry) => entry.poseId)) === canonicalJson(V5_REPAIR_POSE_IDS),
    'V5 repair selection changed.',
  );
  invariant(repairManifest.policy?.paidCalls === 19, 'V5 repair paid-call count changed.');
  invariant(repairManifest.policy?.maximumTotalCostMicrocredits === 1_900_000, 'V5 repair maximum cost changed.');
  invariant(
    repairManifest.policy?.automaticRetries === 0
      && repairManifest.policy?.fallback === 'none'
      && repairManifest.policy?.fullBatch === false
      && repairManifest.policy?.import === false
      && repairManifest.policy?.activation === false
      && repairManifest.policy?.humanReviewRequired === true,
    'V5 repair safety policy changed.',
  );

  invariant(state.schemaVersion === 2 && state.experimentId === V5_EXPERIMENT_ID, 'V5 replacement state identity changed.');
  invariant(state.planSha256 === V5_INPUT_PLAN_SHA256 && state.manifestSha256 === V5_INPUT_MANIFEST_SHA256, 'V5 replacement state plan changed.');
  invariant(state.status === 'repair_complete_human_review_required', 'V5 replacement checkpoint is not complete and awaiting human review.');
  invariant(state.completedPoseCount === 24 && state.repairCompletedPoseCount === 19, 'V5 replacement completion counts changed.');
  invariant(state.repairCostMicrocredits === 1_900_000 && state.totalCostMicrocredits === 2_400_000, 'V5 replacement cost accounting changed.');
  invariant(state.generatorCommitSha === V5_CANARY_GENERATOR_SHA && state.rootRunId === V5_CANARY_RUN_ID, 'V5 replacement root lineage changed.');
  invariant(state.repair?.generatorCommitSha === seal.generatorCommitSha, 'V5 repair generator lineage changed.');
  invariant(state.repair?.planSha256 === seal.repairPlanSha256, 'V5 state repair plan changed.');
  invariant(state.repair?.manifestSha256 === seal.repairManifestSha256, 'V5 state repair manifest pin changed.');
  invariant(state.repair?.sourceRunId === V5_CANARY_RUN_ID && String(state.repair?.sourceArtifactId) === V5_CANARY_ARTIFACT_ID, 'V5 state source checkpoint changed.');
  invariant(
    state.repair?.policy?.automaticRetries === 0
      && state.repair?.policy?.fallback === 'none'
      && state.repair?.policy?.fullBatch === false
      && state.repair?.policy?.import === false
      && state.repair?.policy?.activation === false
      && state.repair?.policy?.humanReviewRequired === true,
    'V5 state repair safety policy changed.',
  );
  invariant(Array.isArray(state.executionRuns) && state.executionRuns.length === 2, 'V5 execution lineage must contain exactly canary plus repair.');
  invariant(
    state.executionRuns[0]?.runId === V5_CANARY_RUN_ID
      && state.executionRuns[0]?.mode === 'canary'
      && state.executionRuns[0]?.generatorCommitSha === V5_CANARY_GENERATOR_SHA,
    'V5 canary execution tuple changed.',
  );
  invariant(
    state.executionRuns[1]?.runId === seal.githubActionsRunId
      && state.executionRuns[1]?.mode === 'repair'
      && state.executionRuns[1]?.generatorCommitSha === seal.generatorCommitSha,
    'V5 repair execution tuple changed.',
  );
  invariant(
    canonicalJson(Object.keys(state.slots ?? {}).sort()) === canonicalJson([...HUMANOID_V5_REPLACEMENT_POSE_IDS].sort()),
    'V5 replacement state does not contain exactly the reviewed 24 poses.',
  );
  invariant(
    canonicalJson(Object.keys(state.references ?? {}).sort())
      === canonicalJson(['identity', ...HUMANOID_V5_REPLACEMENT_POSE_IDS].sort()),
    'V5 replacement reference set changed.',
  );

  const poseById = new Map(manifest.uniquePoses.map((pose) => [pose.poseId, pose]));
  const baseRawByPoseId = new Map(baseInput.verified.map((entry) => [entry.pose.poseId, entry.raw.contentSha256]));
  const replacements = new Map();
  for (const poseId of HUMANOID_V5_REPLACEMENT_POSE_IDS) {
    const pose = poseById.get(poseId);
    invariant(pose, `${poseId} is missing from the V5 replacement manifest.`);
    const slot = state.slots[poseId];
    invariant(slot?.status === 'completed' && slot?.providerStatus === 'completed', `${poseId} V5 replacement is not completed.`);
    invariant(slot?.modelId === EXPECTED_MODEL_ID, `${poseId} V5 replacement model changed.`);
    invariant(slot?.costMicrocredits === 100_000, `${poseId} V5 replacement cost changed.`);
    const artifact = slot.artifacts?.image;
    invariant(artifact?.mimeType === 'image/png', `${poseId} V5 replacement MIME changed.`);
    invariant(artifact.width === HUMANOID_POSTPROCESS_CANVAS.outputWidth && artifact.height === HUMANOID_POSTPROCESS_CANVAS.outputHeight, `${poseId} V5 replacement dimensions changed.`);
    verifyStateArtifactPath(artifact.path, manifest, pose);
    const rawPath = expectedRawPath(workDirectory, manifest, pose);
    const rawSnapshot = readRegularFileSnapshot(rawPath, `${poseId} V5 replacement raw`, { containmentRoot: workDirectory, maxBytes: MAX_PNG_BYTES });
    const raw = inspectPngBytes(rawSnapshot.bytes, `${poseId} V5 replacement raw`);
    invariant(raw.contentSha256 === artifact.contentSha256 && raw.sizeBytes === artifact.sizeBytes, `${poseId} V5 replacement bytes differ from its sealed state.`);
    invariant(raw.width === HUMANOID_POSTPROCESS_CANVAS.outputWidth && raw.height === HUMANOID_POSTPROCESS_CANVAS.outputHeight, `${poseId} V5 replacement raw dimensions changed.`);
    invariant(raw.contentSha256 !== baseRawByPoseId.get(poseId), `${poseId} V5 replacement is byte-identical to the superseded V4 raw.`);
    replacements.set(poseId, Object.freeze({ slot, rawPath, raw, rawBytes: rawSnapshot.bytes }));
  }
  invariant(replacements.size === 24, 'V5 replacement verification did not produce exactly 24 raws.');
  invariant(
    [...replacements.values()].reduce((total, entry) => total + entry.slot.costMicrocredits, 0) === 2_400_000,
    'V5 replacement slot costs do not sum to the sealed combined cost.',
  );
  return {
    workDirectory,
    state,
    manifest,
    repairManifest,
    stateSha256: stateSnapshot.contentSha256,
    manifestSha256: manifestSnapshot.contentSha256,
    repairManifestSha256: repairManifestSnapshot.contentSha256,
    replacementSeal: seal,
    replacementSealSha256: sealSha256,
    replacements,
  };
}

export function verifyHumanoidCombinedPostprocessInputs({
  workDirectory,
  replacementWorkDirectory,
  knownVisualFindings = HUMANOID_POSTPROCESS_KNOWN_VISUAL_FINDINGS,
}) {
  const replacementSealRecord = loadHumanoidV5ReplacementSeal({
    sealPath: HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL.path,
    expectedSealSha256: HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL.contentSha256,
  });
  const baseInput = verifyHumanoidPostprocessInputs({ workDirectory, knownVisualFindings });
  const replacement = verifyHumanoidV5ReplacementInputs({
    baseInput,
    replacementWorkDirectory,
    replacementSealRecord,
  });
  const replacementPoseIds = new Set(HUMANOID_V5_REPLACEMENT_POSE_IDS);
  const verified = baseInput.verified.map((item) => {
    const replacementItem = replacement.replacements.get(item.pose.poseId);
    if (!replacementItem) return {
      ...item,
      rawProvenance: Object.freeze({ source: 'sealed_v4', executionStateSha256: baseInput.stateSha256 }),
    };
    const canaryReplacement = V5_CANARY_POSE_IDS.includes(item.pose.poseId);
    return {
      ...item,
      slot: replacementItem.slot,
      rawPath: replacementItem.rawPath,
      raw: replacementItem.raw,
      rawBytes: replacementItem.rawBytes,
      rawProvenance: Object.freeze({
        source: 'reviewed_v5_replacement',
        executionStateSha256: replacement.stateSha256,
        checkpointRunId: replacement.replacementSeal.githubActionsRunId,
        generationMode: canaryReplacement ? 'canary' : 'repair',
        generationRunId: canaryReplacement ? V5_CANARY_RUN_ID : replacement.replacementSeal.githubActionsRunId,
        generationGeneratorCommitSha: canaryReplacement
          ? V5_CANARY_GENERATOR_SHA
          : replacement.replacementSeal.generatorCommitSha,
        supersededV4RawSha256: item.raw.contentSha256,
      }),
    };
  });
  invariant(verified.filter((item) => item.rawProvenance.source === 'reviewed_v5_replacement').length === 24, 'Combined input did not replace exactly 24 poses.');
  invariant(verified.filter((item) => item.rawProvenance.source === 'sealed_v4').length === 70, 'Combined input did not retain exactly 70 V4 poses.');
  invariant(verified.filter((item) => item.rawProvenance.generationMode === 'canary').length === 5, 'Combined input lost the five-pose V5 canary generation lineage.');
  invariant(verified.filter((item) => item.rawProvenance.generationMode === 'repair').length === 19, 'Combined input lost the nineteen-pose V5 repair generation lineage.');
  const supersededVisualReviewFindings = baseInput.knownVisualReviewFindings.filter((finding) => replacementPoseIds.has(finding.poseId));
  const activeVisualReviewFindings = baseInput.knownVisualReviewFindings.filter((finding) => !replacementPoseIds.has(finding.poseId));
  const replacementRawByPoseId = new Map(verified.map((item) => [item.pose.poseId, item.raw.contentSha256]));
  const sealedSupersededFindings = supersededVisualReviewFindings.map((finding) => ({
    ...finding,
    replacementRawContentSha256: replacementRawByPoseId.get(finding.poseId),
  }));
  invariant(activeVisualReviewFindings.length === 3, 'Combined input must retain exactly the three accepted V4 P2 findings for human review.');
  invariant(sealedSupersededFindings.length === 28, 'Combined input must supersede exactly the 28 V4 findings covered by the reviewed replacement set.');
  return {
    ...baseInput,
    verified,
    knownVisualReviewFindings: activeVisualReviewFindings,
    supersededVisualReviewFindings: sealedSupersededFindings,
    combination: {
      base: {
        executionStateSha256: baseInput.stateSha256,
        inputManifestSha256: baseInput.manifestSha256,
      },
      replacement: {
        executionStateSha256: replacement.stateSha256,
        inputManifestSha256: replacement.manifestSha256,
        repairManifestSha256: replacement.repairManifestSha256,
        trustSealSha256: replacement.replacementSealSha256,
        trustedArtifactProvenance: {
          encryptedArtifactSha256: replacement.replacementSeal.encryptedArtifactSha256,
          githubArtifactZipSha256: replacement.replacementSeal.githubArtifactZipSha256,
          githubArtifactId: replacement.replacementSeal.githubArtifactId,
          githubActionsRunId: replacement.replacementSeal.githubActionsRunId,
          generatorCommitSha: replacement.replacementSeal.generatorCommitSha,
          verification: 'out_of_band_provenance',
        },
      },
      replacementPoseIds: [...HUMANOID_V5_REPLACEMENT_POSE_IDS],
      replacementPoseCount: 24,
      retainedV4PoseCount: 70,
    },
  };
}

export function hardlinkOrCopyExclusive(source, destination, outputRoot, expectedContentSha256) {
  invariant(/^[a-f0-9]{64}$/.test(expectedContentSha256 ?? ''), 'Frame master expected SHA-256 is required.');
  const absoluteSource = resolve(source);
  const sourceSnapshot = readRegularFileSnapshot(absoluteSource, 'frame master', { containmentRoot: outputRoot });
  invariant(sourceSnapshot.contentSha256 === expectedContentSha256, 'Frame master changed before alias creation.');
  const absoluteDestination = assertAvailableOutputEntry(outputRoot, destination);
  try {
    linkSync(absoluteSource, absoluteDestination);
  } catch (error) {
    if (!['EXDEV', 'EPERM'].includes(error?.code)) throw error;
    const snapshot = readRegularFileSnapshot(absoluteSource, 'frame master fallback', { containmentRoot: outputRoot });
    invariant(snapshot.contentSha256 === expectedContentSha256, 'Frame master changed before alias fallback.');
    writeBytesAtomicExclusive(absoluteDestination, snapshot.bytes, outputRoot);
  }
  const destinationStat = lstatSync(absoluteDestination);
  invariant(!destinationStat.isSymbolicLink() && destinationStat.isFile(), `Frame output is not a regular file: ${absoluteDestination}`);
  const destinationSnapshot = readRegularFileSnapshot(absoluteDestination, 'frame alias', { containmentRoot: outputRoot });
  invariant(destinationSnapshot.contentSha256 === expectedContentSha256, 'Frame alias hash differs from its verified master.');
}

function cleanAnalysisRecord(analysis) {
  return {
    totalPixels: analysis.totalPixels,
    componentCount: analysis.componentCount,
    significantSecondaryComponents: analysis.significantSecondaryComponents,
    largestComponentPixels: analysis.largestComponentPixels,
    largestComponentRatio: analysis.largestComponentRatio,
    largestComponentBbox: analysis.largestComponentBbox,
    allForegroundBbox: analysis.allForegroundBbox,
    touchesEdge: analysis.touchesEdge,
    greenSpillPixels: analysis.greenSpillPixels,
    greenSpillRatio: analysis.greenSpillRatio,
  };
}

function darkComposite(thumbnail) {
  const rgb = Buffer.alloc((thumbnail.length / 4) * 3);
  const background = [16, 19, 31];
  for (let sourceOffset = 0, destinationOffset = 0; sourceOffset < thumbnail.length; sourceOffset += 4, destinationOffset += 3) {
    const alpha = thumbnail[sourceOffset + 3];
    const inverseAlpha = 255 - alpha;
    rgb[destinationOffset] = Math.round((thumbnail[sourceOffset] * alpha + background[0] * inverseAlpha) / 255);
    rgb[destinationOffset + 1] = Math.round((thumbnail[sourceOffset + 1] * alpha + background[1] * inverseAlpha) / 255);
    rgb[destinationOffset + 2] = Math.round((thumbnail[sourceOffset + 2] * alpha + background[2] * inverseAlpha) / 255);
  }
  return rgb;
}

function animationOrder(frameSlots) {
  return [...new Set(frameSlots.map((slot) => slot.animationName))];
}

function addOutputHash(records, descriptor) {
  records.push({ path: descriptor.path, contentSha256: descriptor.contentSha256 });
}

export function parseHumanoidPostprocessCliArgs(rawArgs) {
  const value = (name, fallback = '') => {
    const prefix = `${name}=`;
    return rawArgs.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
  };
  const workDirectory = resolve(value('--work-dir', join(root, '.humanoid-template-v4-work')));
  const outputDirectory = resolve(value('--output-dir', join(workDirectory, 'postprocessed-v1')));
  const replacementWorkValue = value('--replacement-work-dir');
  const replacementSealValue = value('--replacement-seal');
  const replacementSealShaValue = value('--replacement-seal-sha256');
  const replacementConfigured = replacementWorkValue !== '';
  const customSealConfigured = replacementSealValue !== '' || replacementSealShaValue !== '';
  invariant(
    !customSealConfigured,
    'Custom V5 trust seals are forbidden; this postprocessor accepts only the reviewed committed repair artifact.',
  );
  invariant(outputDirectory !== workDirectory, 'Postprocess output must not replace the sealed work directory.');
  if (value('--output-dir') === '') invariant(outputDirectory.startsWith(`${workDirectory}${sep}`), 'Default postprocess output path is invalid.');
  return {
    workDirectory,
    outputDirectory,
    ffmpegBinary: value('--ffmpeg', 'ffmpeg'),
    replacementWorkDirectory: replacementConfigured ? resolve(replacementWorkValue) : null,
    replacementSealPath: replacementConfigured
      ? HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL.path
      : null,
    replacementSealSha256: replacementConfigured
      ? HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL.contentSha256
      : null,
  };
}

export async function postprocessHumanoidTemplate(options) {
  const implementationSnapshot = snapshotImplementation();
  const workDirectory = resolve(options.workDirectory);
  const outputDirectory = resolve(options.outputDirectory ?? join(workDirectory, 'postprocessed-v1'));
  const ffmpegBinary = options.ffmpegBinary ?? 'ffmpeg';
  const replacementConfigured = Boolean(options.replacementWorkDirectory);
  const input = replacementConfigured
    ? verifyHumanoidCombinedPostprocessInputs({
      workDirectory,
      replacementWorkDirectory: options.replacementWorkDirectory,
    })
    : verifyHumanoidPostprocessInputs({ workDirectory });
  const version = ffmpegVersion(ffmpegBinary);
  createOutputRootExclusive(outputDirectory);

  const poseRecords = [];
  const poseOutputs = new Map();
  const thumbnails = new Map();
  const outputHashes = [];
  const topLevelReviewReasons = [];
  const topLevelHardFailures = [];

  for (const item of input.verified) {
    const { pose, sourcePath, sourceBytes, rawBytes } = item;
    const sourceRgb = decodePixels(
      sourceBytes,
      `${pose.poseId} source snapshot`,
      'rgb24',
      HUMANOID_POSTPROCESS_CANVAS.sourceWidth,
      HUMANOID_POSTPROCESS_CANVAS.sourceHeight,
      ffmpegBinary,
    );
    const sourceKeyed = keyHumanoidChroma(
      sourceRgb,
      HUMANOID_POSTPROCESS_CANVAS.sourceWidth,
      HUMANOID_POSTPROCESS_CANVAS.sourceHeight,
    );
    const sourceAnalysis = analyzeForeground(
      sourceKeyed.rgba,
      HUMANOID_POSTPROCESS_CANVAS.sourceWidth,
      HUMANOID_POSTPROCESS_CANVAS.sourceHeight,
    );
    invariant(sourceAnalysis.totalPixels > 0 && sourceAnalysis.largestComponentBbox, `${pose.poseId} source foreground is empty.`);
    invariant(!sourceAnalysis.touchesEdge, `${pose.poseId} source foreground touches the canvas edge.`);
    const targetBbox = scaleSourceBbox(sourceAnalysis.largestComponentBbox);

    const rawDestination = join(outputDirectory, 'poses', 'raw', `${pose.poseId}.png`);
    writeBytesAtomicExclusive(rawDestination, rawBytes, outputDirectory);
    const rawDescriptor = outputDescriptor(rawDestination, outputDirectory, {
      width: HUMANOID_POSTPROCESS_CANVAS.outputWidth,
      height: HUMANOID_POSTPROCESS_CANVAS.outputHeight,
    });
    invariant(rawDescriptor.contentSha256 === item.raw.contentSha256, `${pose.poseId} copied raw hash changed.`);

    const rawRgb = decodePixels(
      rawBytes,
      `${pose.poseId} raw snapshot`,
      'rgb24',
      HUMANOID_POSTPROCESS_CANVAS.outputWidth,
      HUMANOID_POSTPROCESS_CANVAS.outputHeight,
      ffmpegBinary,
    );
    const keyed = keyHumanoidChroma(
      rawRgb,
      HUMANOID_POSTPROCESS_CANVAS.outputWidth,
      HUMANOID_POSTPROCESS_CANVAS.outputHeight,
    );
    const before = analyzeForeground(
      keyed.rgba,
      HUMANOID_POSTPROCESS_CANVAS.outputWidth,
      HUMANOID_POSTPROCESS_CANVAS.outputHeight,
    );
    invariant(before.totalPixels > 0 && before.largestComponentBbox && before.allForegroundBbox, `${pose.poseId} keyed foreground is empty.`);
    decontaminateForegroundRegion(
      keyed.rgba,
      HUMANOID_POSTPROCESS_CANVAS.outputWidth,
      HUMANOID_POSTPROCESS_CANVAS.outputHeight,
      before.allForegroundBbox,
    );
    const despill = suppressGreenSpill(keyed.rgba);
    const unregisteredAnalysis = analyzeForeground(
      keyed.rgba,
      HUMANOID_POSTPROCESS_CANVAS.outputWidth,
      HUMANOID_POSTPROCESS_CANVAS.outputHeight,
    );
    verifyTransparentCorners(keyed.rgba, HUMANOID_POSTPROCESS_CANVAS.outputWidth, HUMANOID_POSTPROCESS_CANVAS.outputHeight, `${pose.poseId} unregistered RGBA`);
    const unregisteredPath = join(outputDirectory, 'poses', 'unregistered-rgba', `${pose.poseId}.png`);
    encodePng({
      pixels: keyed.rgba,
      width: HUMANOID_POSTPROCESS_CANVAS.outputWidth,
      height: HUMANOID_POSTPROCESS_CANVAS.outputHeight,
      pixelFormat: 'rgba',
      outputPath: unregisteredPath,
      outputRoot: outputDirectory,
      ffmpegBinary,
    });
    const unregisteredDescriptor = outputDescriptor(unregisteredPath, outputDirectory, {
      width: HUMANOID_POSTPROCESS_CANVAS.outputWidth,
      height: HUMANOID_POSTPROCESS_CANVAS.outputHeight,
      colorType: 6,
    });

    const mode = pose.sourceSlots.some((slot) => slot.animationName === 'ko') ? 'horizontal' : 'vertical';
    const transform = computeRegistrationTransform({
      generatedBbox: unregisteredAnalysis.largestComponentBbox,
      targetBbox,
      mode,
    });
    const projectedFullBbox = transformedBbox(unregisteredAnalysis.allForegroundBbox, transform);
    const projectionFitsCanvas = projectedFullBbox.left >= 0
      && projectedFullBbox.top >= 0
      && projectedFullBbox.right <= HUMANOID_POSTPROCESS_CANVAS.outputWidth
      && projectedFullBbox.bottom <= HUMANOID_POSTPROCESS_CANVAS.outputHeight;
    // A semantically wrong raw (for example, an upright body for a horizontal
    // KO source) can make the required one-axis transform leave the canvas.
    // Never crop or apply a second/non-uniform fit. Preserve the cleaned
    // unregistered pixels as an explicitly blocked review candidate instead.
    const registered = projectionFitsCanvas
      ? applyUniformTransform(
        keyed.rgba,
        HUMANOID_POSTPROCESS_CANVAS.outputWidth,
        HUMANOID_POSTPROCESS_CANVAS.outputHeight,
        transform,
        unregisteredAnalysis.allForegroundBbox,
      )
      : new Uint8ClampedArray(keyed.rgba);
    verifyTransparentCorners(registered, HUMANOID_POSTPROCESS_CANVAS.outputWidth, HUMANOID_POSTPROCESS_CANVAS.outputHeight, `${pose.poseId} registered RGBA`);
    const after = analyzeForeground(
      registered,
      HUMANOID_POSTPROCESS_CANVAS.outputWidth,
      HUMANOID_POSTPROCESS_CANVAS.outputHeight,
    );
    const metrics = evaluatePostprocessMetrics({ before: unregisteredAnalysis, after, targetBbox, transform, mode });
    if (!projectionFitsCanvas) metrics.hardFailures.push('registration_not_applied:uniform_projection_would_crop');
    for (const reason of metrics.reviewReasons) topLevelReviewReasons.push(`${pose.poseId}:${reason}`);
    for (const failure of metrics.hardFailures) topLevelHardFailures.push(`${pose.poseId}:${failure}`);

    const registeredPath = join(outputDirectory, 'poses', 'registered-rgba', `${pose.poseId}.png`);
    encodePng({
      pixels: registered,
      width: HUMANOID_POSTPROCESS_CANVAS.outputWidth,
      height: HUMANOID_POSTPROCESS_CANVAS.outputHeight,
      pixelFormat: 'rgba',
      outputPath: registeredPath,
      outputRoot: outputDirectory,
      ffmpegBinary,
    });
    const registeredDescriptor = outputDescriptor(registeredPath, outputDirectory, {
      width: HUMANOID_POSTPROCESS_CANVAS.outputWidth,
      height: HUMANOID_POSTPROCESS_CANVAS.outputHeight,
      colorType: 6,
    });

    const chromaRgb = compositeRgbaOnPureChroma(
      registered,
      HUMANOID_POSTPROCESS_CANVAS.outputWidth,
      HUMANOID_POSTPROCESS_CANVAS.outputHeight,
    );
    verifyPureChroma(chromaRgb, HUMANOID_POSTPROCESS_CANVAS.outputWidth, HUMANOID_POSTPROCESS_CANVAS.outputHeight);
    const chromaPath = join(outputDirectory, 'poses', 'chroma-rgb24', `${pose.poseId}.png`);
    encodePng({
      pixels: chromaRgb,
      width: HUMANOID_POSTPROCESS_CANVAS.outputWidth,
      height: HUMANOID_POSTPROCESS_CANVAS.outputHeight,
      pixelFormat: 'rgb24',
      outputPath: chromaPath,
      outputRoot: outputDirectory,
      ffmpegBinary,
    });
    const chromaDescriptor = outputDescriptor(chromaPath, outputDirectory, {
      width: HUMANOID_POSTPROCESS_CANVAS.outputWidth,
      height: HUMANOID_POSTPROCESS_CANVAS.outputHeight,
      colorType: 2,
    });
    const chromaSnapshot = readRegularFileSnapshot(chromaPath, `${pose.poseId} chroma master`, { containmentRoot: outputDirectory });
    const decodedChroma = decodePixels(
      chromaSnapshot.bytes,
      `${pose.poseId} chroma master`,
      'rgb24',
      HUMANOID_POSTPROCESS_CANVAS.outputWidth,
      HUMANOID_POSTPROCESS_CANVAS.outputHeight,
      ffmpegBinary,
    );
    verifyPureChroma(decodedChroma, HUMANOID_POSTPROCESS_CANVAS.outputWidth, HUMANOID_POSTPROCESS_CANVAS.outputHeight);

    const outputs = {
      raw: rawDescriptor,
      unregisteredRgba: unregisteredDescriptor,
      registeredRgba: registeredDescriptor,
      chromaRgb24: chromaDescriptor,
    };
    for (const descriptor of Object.values(outputs)) addOutputHash(outputHashes, descriptor);
    poseOutputs.set(pose.poseId, { outputs, absolute: { raw: rawDestination, unregisteredRgba: unregisteredPath, registeredRgba: registeredPath, chromaRgb24: chromaPath } });
    thumbnails.set(pose.poseId, resizeRgbaNearest(
      registered,
      HUMANOID_POSTPROCESS_CANVAS.outputWidth,
      HUMANOID_POSTPROCESS_CANVAS.outputHeight,
      QA_THUMBNAIL_WIDTH,
      QA_THUMBNAIL_HEIGHT,
    ));
    const poseKnownFindings = input.knownVisualReviewFindings.filter((finding) => finding.poseId === pose.poseId);
    const poseSupersededFindings = (input.supersededVisualReviewFindings ?? []).filter((finding) => finding.poseId === pose.poseId);
    poseRecords.push({
      poseId: pose.poseId,
      sourceSlots: pose.sourceSlots,
      rawProvenance: item.rawProvenance ?? {
        source: 'sealed_v4',
        executionStateSha256: input.stateSha256,
      },
      source: {
        path: relative(workDirectory, sourcePath),
        contentSha256: pose.contentSha256,
        bbox: sourceAnalysis.largestComponentBbox,
        scaledTargetBbox: targetBbox,
      },
      outputs,
      key: keyed.keyMetrics,
      despill,
      foregroundBeforeRegistration: cleanAnalysisRecord(unregisteredAnalysis),
      registration: {
        ...transform,
        applied: projectionFitsCanvas,
        blockedReason: projectionFitsCanvas ? null : 'uniform_projection_would_crop',
        projectedFullBbox,
      },
      foregroundAfterRegistration: cleanAnalysisRecord(after),
      metrics,
      semanticReview: {
        status: 'required',
        automatedApproval: false,
        knownFindings: poseKnownFindings,
        supersededSourceFindings: poseSupersededFindings,
      },
    });
  }

  const frameRecords = [];
  for (const frameSlot of input.manifest.frameSlots) {
    const master = poseOutputs.get(frameSlot.poseId);
    invariant(master, `Missing processed pose ${frameSlot.poseId}.`);
    const frameName = `frame-${String(frameSlot.frameNumber).padStart(3, '0')}.png`;
    const frameOutputs = {};
    for (const [kind, directoryName] of [
      ['raw', 'raw'],
      ['unregisteredRgba', 'unregistered-rgba'],
      ['registeredRgba', 'registered-rgba'],
      ['chromaRgb24', 'chroma-rgb24'],
    ]) {
      const destination = join(outputDirectory, 'frames', directoryName, frameSlot.animationName, frameName);
      hardlinkOrCopyExclusive(master.absolute[kind], destination, outputDirectory, master.outputs[kind].contentSha256);
      const descriptor = outputDescriptor(destination, outputDirectory, {
        width: HUMANOID_POSTPROCESS_CANVAS.outputWidth,
        height: HUMANOID_POSTPROCESS_CANVAS.outputHeight,
        colorType: kind === 'raw' ? undefined : kind === 'chromaRgb24' ? 2 : 6,
      });
      invariant(descriptor.contentSha256 === master.outputs[kind].contentSha256 && descriptor.sizeBytes === master.outputs[kind].sizeBytes, `${frameSlot.animationName} ${frameName} is not byte-identical to ${frameSlot.poseId}.`);
      frameOutputs[kind] = descriptor;
      addOutputHash(outputHashes, descriptor);
    }
    frameRecords.push({
      ...frameSlot,
      rawProvenance: input.verified.find((entry) => entry.pose.poseId === frameSlot.poseId)?.rawProvenance ?? {
        source: 'sealed_v4',
        executionStateSha256: input.stateSha256,
      },
      outputs: frameOutputs,
      semanticReview: {
        status: 'required',
        automatedApproval: false,
        knownFindings: input.knownVisualReviewFindings.filter((finding) => (
          finding.animationName === frameSlot.animationName
          && finding.frameNumber === frameSlot.frameNumber
          && finding.poseId === frameSlot.poseId
        )),
        supersededSourceFindings: (input.supersededVisualReviewFindings ?? []).filter((finding) => (
          finding.animationName === frameSlot.animationName
          && finding.frameNumber === frameSlot.frameNumber
          && finding.poseId === frameSlot.poseId
        )),
      },
    });
  }

  const aliases = input.aliasPoseIds.map((poseId) => {
    const frames = frameRecords.filter((frame) => frame.poseId === poseId);
    invariant(frames.length === 2, `${poseId} alias cardinality changed.`);
    for (const kind of ['raw', 'unregisteredRgba', 'registeredRgba', 'chromaRgb24']) {
      invariant(frames[0].outputs[kind].contentSha256 === frames[1].outputs[kind].contentSha256, `${poseId} ${kind} aliases differ.`);
    }
    return {
      poseId,
      slots: frames.map(({ animationName, frameNumber }) => ({ animationName, frameNumber })),
      hashes: Object.fromEntries(['raw', 'unregisteredRgba', 'registeredRgba', 'chromaRgb24'].map((kind) => [kind, frames[0].outputs[kind].contentSha256])),
    };
  });

  const qa = {};
  for (const animationName of animationOrder(input.manifest.frameSlots)) {
    const slots = input.manifest.frameSlots.filter((slot) => slot.animationName === animationName);
    const animationThumbnails = slots.map((slot) => thumbnails.get(slot.poseId));
    invariant(animationThumbnails.every(Boolean), `${animationName} QA thumbnail is missing.`);
    const contact = buildCheckerboardContactSheet(animationThumbnails, QA_THUMBNAIL_WIDTH, QA_THUMBNAIL_HEIGHT);
    const contactPath = join(outputDirectory, 'qa', 'contact-sheets', `${animationName}.png`);
    encodePng({ pixels: contact.rgb, width: contact.width, height: contact.height, pixelFormat: 'rgb24', outputPath: contactPath, outputRoot: outputDirectory, ffmpegBinary });
    const contactDescriptor = outputDescriptor(contactPath, outputDirectory, { width: contact.width, height: contact.height, colorType: 2 });
    addOutputHash(outputHashes, contactDescriptor);

    const gifFrames = animationThumbnails.map(darkComposite);
    const gifPath = join(outputDirectory, 'qa', 'gifs-dark', `${animationName}.gif`);
    const gifGeometry = encodeGif({
      frames: gifFrames,
      width: QA_THUMBNAIL_WIDTH,
      height: QA_THUMBNAIL_HEIGHT,
      outputPath: gifPath,
      outputRoot: outputDirectory,
      ffmpegBinary,
    });
    const animatedDescriptor = gifDescriptor(gifPath, outputDirectory, gifGeometry);
    addOutputHash(outputHashes, animatedDescriptor);
    qa[animationName] = {
      frameCount: slots.length,
      frameSlots: slots,
      contactSheetCheckerboard: contactDescriptor,
      animatedDark: animatedDescriptor,
    };
  }

  invariant(poseRecords.length === EXPECTED_POSES, 'Postprocessor did not emit exactly 94 pose masters.');
  invariant(frameRecords.length === EXPECTED_FRAME_SLOTS, 'Postprocessor did not reconstruct exactly 98 frame positions.');
  invariant(aliases.length === EXPECTED_ALIASES, 'Postprocessor did not verify exactly four aliases.');
  assertImplementationUnchanged(implementationSnapshot);
  const status = topLevelHardFailures.length === 0 ? 'awaiting_human_review' : 'hard_gate_failed';
  const manifest = {
    schemaVersion: 1,
    postprocessId: HUMANOID_POSTPROCESS_ID,
    status,
    source: {
      mode: input.combination ? 'sealed_v4_plus_reviewed_v5_replacements' : 'sealed_v4',
      experimentId: input.manifest.experimentId,
      generatorCommitSha: input.state.generatorCommitSha,
      planSha256: input.manifest.planSha256,
      inputManifestSha256: input.manifestSha256,
      executionStateSha256: input.stateSha256,
      executionStatus: input.state.status,
      rawPoseCount: input.verified.length,
      trustedArtifactProvenance: {
        encryptedArtifactSha256: HUMANOID_V4_TRUSTED_SEAL.encryptedArtifactSha256,
        githubActionsRunId: HUMANOID_V4_TRUSTED_SEAL.githubActionsRunId,
        verification: 'out_of_band_provenance',
      },
      combination: input.combination ?? null,
    },
    implementation: {
      scriptSha256: implementationSnapshot.scriptSha256,
      coreSha256: implementationSnapshot.coreSha256,
      ffmpegVersion: version,
    },
    policy: HUMANOID_POSTPROCESS_POLICY,
    canvas: HUMANOID_POSTPROCESS_CANVAS,
    thresholds: HUMANOID_POSTPROCESS_THRESHOLDS,
    counts: {
      uniquePoses: poseRecords.length,
      frameSlots: frameRecords.length,
      aliases: aliases.length,
      reviewReasons: topLevelReviewReasons.length,
      hardFailures: topLevelHardFailures.length,
      semanticReviewRequiredFrameSlots: frameRecords.length,
      knownVisualReviewFindings: input.knownVisualReviewFindings.length,
      supersededVisualReviewFindings: input.supersededVisualReviewFindings?.length ?? 0,
      v5ReplacementPoses: input.combination?.replacementPoseCount ?? 0,
      retainedV4Poses: input.combination?.retainedV4PoseCount ?? input.verified.length,
    },
    reviewReasons: topLevelReviewReasons,
    hardFailures: topLevelHardFailures,
    semanticReview: {
      status: 'required',
      scope: 'all_frame_slots',
      completeness: 'known_findings_are_non_exhaustive',
      automatedApproval: false,
      requiredFrameSlots: frameRecords.length,
      knownFindings: input.knownVisualReviewFindings,
      supersededSourceFindings: input.supersededVisualReviewFindings ?? [],
    },
    poses: poseRecords,
    frameSlots: frameRecords,
    aliases,
    qa,
  };
  const manifestPath = join(outputDirectory, 'postprocess-manifest.json');
  assertImplementationUnchanged(implementationSnapshot);
  writeJsonAtomic(manifestPath, manifest, outputDirectory);
  const manifestDescriptor = outputDescriptorJson(manifestPath, outputDirectory);
  outputHashes.push({ path: manifestDescriptor.path, contentSha256: manifestDescriptor.contentSha256 });
  const hashLines = [...outputHashes]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.contentSha256}  ${entry.path}`)
    .join('\n');
  writeBytesAtomic(join(outputDirectory, 'hashes.sha256'), Buffer.from(`${hashLines}\n`), outputDirectory);
  writeBytesAtomic(join(outputDirectory, 'postprocess-manifest.json.sha256'), Buffer.from(`${manifestDescriptor.contentSha256}  postprocess-manifest.json\n`), outputDirectory);

  if (topLevelHardFailures.length > 0) {
    throw new Error(`Humanoid postprocess hard gates failed (${topLevelHardFailures.length}); inspect ${manifestPath}.`);
  }
  return { manifest, manifestPath, outputDirectory };
}

function outputDescriptorJson(path, outputDirectory) {
  const { bytes } = readRegularFileSnapshot(path, 'postprocess manifest', { containmentRoot: outputDirectory });
  return {
    path: relative(outputDirectory, path),
    mimeType: 'application/json',
    sizeBytes: bytes.byteLength,
    contentSha256: sha256(bytes),
  };
}

async function main() {
  const options = parseHumanoidPostprocessCliArgs(process.argv.slice(2));
  const result = await postprocessHumanoidTemplate(options);
  process.stdout.write(`${JSON.stringify({
    status: result.manifest.status,
    outputDirectory: result.outputDirectory,
    manifestPath: result.manifestPath,
    uniquePoses: result.manifest.counts.uniquePoses,
    frameSlots: result.manifest.counts.frameSlots,
    aliases: result.manifest.counts.aliases,
    reviewReasons: result.manifest.counts.reviewReasons,
    hardFailures: result.manifest.counts.hardFailures,
    providerCalls: result.manifest.policy.providerCalls,
  }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
