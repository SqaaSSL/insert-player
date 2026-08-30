import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
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

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_BYTES = 80 * 1024 * 1024;
const EXPECTED_EXPERIMENT_ID = 'humanoid-neutral-medium-xai-template-v4';
const EXPECTED_MODEL_ID = 'grok-imagine-image-2-edit';
const EXPECTED_PLAN_SHA256 = '6eae3d89e52a89e9e6b1c17f194ab1c93605aedb23521e2bb0dcc4a02878ff89';
const EXPECTED_POSES = 94;
const EXPECTED_FRAME_SLOTS = 98;
const EXPECTED_ALIASES = 4;
const QA_THUMBNAIL_WIDTH = 128;
const QA_THUMBNAIL_HEIGHT = 171;

export const HUMANOID_POSTPROCESS_ID = 'humanoid-neutral-medium-xai-template-v4-postprocess-v1';
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
  Object.freeze({ category: 'pose', animationName: 'ko', frameNumber: 11, poseId: 'pose-055-5655accf5650', finding: 'kneeling_or_crawling_instead_of_near_prone' }),
  Object.freeze({ category: 'pose', animationName: 'low_kick', frameNumber: 5, poseId: 'pose-061-86dfa9041794', finding: 'stance_or_hip_height_mismatch' }),
  Object.freeze({ category: 'pose', animationName: 'low_kick', frameNumber: 7, poseId: 'pose-063-9b96aee26b28', finding: 'stance_or_hip_height_mismatch' }),
  Object.freeze({ category: 'pose', animationName: 'low_punch', frameNumber: 6, poseId: 'pose-070-6b1de52c67b6', finding: 'punch_extension_missing' }),
  Object.freeze({ category: 'pose', animationName: 'low_punch', frameNumber: 7, poseId: 'pose-071-138071f13b72', finding: 'punch_extension_missing' }),
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

function regularFile(path, label) {
  invariant(existsSync(path), `${label} is missing.`);
  invariant(lstatSync(path).isFile(), `${label} is not a regular file.`);
}

function safeResolve(parent, child, label) {
  invariant(typeof child === 'string' && child.length > 0 && !child.includes('\0'), `${label} path is invalid.`);
  const resolvedParent = resolve(parent);
  const resolved = resolve(resolvedParent, child);
  invariant(resolved.startsWith(`${resolvedParent}${sep}`), `${label} path escapes its directory.`);
  return resolved;
}

function temporaryPngPath(path) {
  return `${path}.writing-${process.pid}-${randomUUID()}.png`;
}

function temporaryPath(path) {
  return `${path}.writing-${process.pid}-${randomUUID()}`;
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(path);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function writeBytesAtomic(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(path);
  try {
    writeFileSync(temporary, bytes, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function copyFileAtomic(source, destination) {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(destination);
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
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

function decodePixels(path, pixelFormat, width, height, ffmpegBinary) {
  const bytes = runCommand(ffmpegBinary, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
    '-i', path, '-map', '0:v:0', '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', pixelFormat, 'pipe:1',
  ], { binary: true });
  const channels = pixelFormat === 'rgba' ? 4 : 3;
  invariant(bytes.byteLength === width * height * channels, `Decoded ${pixelFormat} byte length changed for ${basename(path)}.`);
  return bytes;
}

function encodePng({ pixels, width, height, pixelFormat, outputPath, ffmpegBinary }) {
  invariant(pixelFormat === 'rgba' || pixelFormat === 'rgb24', 'PNG pixel format is invalid.');
  const channels = pixelFormat === 'rgba' ? 4 : 3;
  invariant(pixels.length === width * height * channels, 'PNG source dimensions do not match.');
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporary = temporaryPngPath(outputPath);
  try {
    runCommand(ffmpegBinary, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1',
      '-f', 'rawvideo', '-pix_fmt', pixelFormat, '-s', `${width}x${height}`, '-i', 'pipe:0',
      '-map_metadata', '-1', '-frames:v', '1', '-pix_fmt', pixelFormat,
      '-compression_level', '9', '-pred', 'mixed', temporary,
    ], { input: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength) });
    chmodSync(temporary, 0o600);
    renameSync(temporary, outputPath);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  const inspected = inspectPngBytes(readFileSync(outputPath), `encoded ${pixelFormat} PNG`);
  invariant(inspected.width === width && inspected.height === height && inspected.bitDepth === 8, 'Encoded PNG geometry or bit depth changed.');
  invariant(inspected.colorType === (pixelFormat === 'rgba' ? 6 : 2), `Encoded ${pixelFormat} PNG color type changed.`);
  return inspected;
}

export function encodeGif({ frames, width, height, outputPath, ffmpegBinary, frameRate = 8 }) {
  invariant(Array.isArray(frames) && frames.length > 0, 'GIF frames are required.');
  invariant(frames.every((frame) => frame.length === width * height * 3), 'GIF frame dimensions do not match.');
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporary = `${temporaryPath(outputPath)}.gif`;
  const input = Buffer.concat(frames);
  try {
    runCommand(ffmpegBinary, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-filter_complex_threads', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-framerate', String(frameRate), '-i', 'pipe:0',
      '-filter_complex', '[0:v]split[palette_source][gif_source];[palette_source]palettegen=max_colors=128:stats_mode=diff[palette];[gif_source][palette]paletteuse=dither=bayer:bayer_scale=3',
      '-frames:v', String(frames.length), '-loop', '0', '-map_metadata', '-1', temporary,
    ], { input, maxBuffer: 512 * 1024 * 1024 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, outputPath);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  const bytes = readFileSync(outputPath);
  invariant(bytes.subarray(0, 6).toString('ascii') === 'GIF89a' || bytes.subarray(0, 6).toString('ascii') === 'GIF87a', 'Encoded GIF signature is invalid.');
  return { width, height, sizeBytes: bytes.byteLength, contentSha256: sha256(bytes) };
}

function outputDescriptor(path, outputDirectory, expected = {}) {
  regularFile(path, 'output');
  const bytes = readFileSync(path);
  const inspected = inspectPngBytes(bytes, 'output PNG');
  if (expected.width) invariant(inspected.width === expected.width, 'Output width changed.');
  if (expected.height) invariant(inspected.height === expected.height, 'Output height changed.');
  if (expected.colorType !== undefined) invariant(inspected.colorType === expected.colorType, 'Output PNG color type changed.');
  return { path: relative(outputDirectory, path), mimeType: 'image/png', ...inspected };
}

function gifDescriptor(path, outputDirectory, geometry) {
  regularFile(path, 'QA GIF');
  const bytes = readFileSync(path);
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
  expectedPlanSha256 = EXPECTED_PLAN_SHA256,
  knownVisualFindings = HUMANOID_POSTPROCESS_KNOWN_VISUAL_FINDINGS,
}) {
  const resolvedWorkDirectory = resolve(workDirectory);
  regularFile(join(resolvedWorkDirectory, 'state.json'), 'humanoid execution state');
  regularFile(join(resolvedWorkDirectory, 'inputs', 'input-manifest.json'), 'humanoid input manifest');
  const stateBytes = readFileSync(join(resolvedWorkDirectory, 'state.json'));
  const manifestBytes = readFileSync(join(resolvedWorkDirectory, 'inputs', 'input-manifest.json'));
  const state = JSON.parse(stateBytes.toString('utf8'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const { planSha256, ...manifestCore } = manifest;

  invariant(manifest.experimentId === EXPECTED_EXPERIMENT_ID, 'Only the sealed V4 humanoid experiment can be postprocessed.');
  invariant(manifest.model?.id === EXPECTED_MODEL_ID, 'Humanoid source model changed.');
  invariant(planSha256 === sha256(canonicalJson(manifestCore)), 'Humanoid input plan SHA-256 changed.');
  invariant(planSha256 === expectedPlanSha256, 'Humanoid V4 input plan is not the reviewed production plan.');
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

  const inputsDirectory = join(resolvedWorkDirectory, 'inputs');
  const verified = [];
  for (const pose of manifest.uniquePoses) {
    invariant(/^pose-[0-9]{3}-[a-f0-9]{12}$/.test(pose.poseId ?? ''), 'Pose id is invalid.');
    const sourcePath = safeResolve(inputsDirectory, pose.path, `${pose.poseId} source`);
    regularFile(sourcePath, `${pose.poseId} source`);
    const source = inspectPngBytes(readFileSync(sourcePath), `${pose.poseId} source`);
    invariant(source.contentSha256 === pose.contentSha256, `${pose.poseId} source SHA-256 changed.`);
    invariant(source.width === HUMANOID_POSTPROCESS_CANVAS.sourceWidth && source.height === HUMANOID_POSTPROCESS_CANVAS.sourceHeight, `${pose.poseId} source dimensions changed.`);

    const slot = state.slots[pose.poseId];
    invariant(slot?.status === 'completed', `${pose.poseId} execution is not completed.`);
    const artifact = slot.artifacts?.image;
    invariant(artifact?.mimeType === 'image/png', `${pose.poseId} raw MIME changed.`);
    invariant(artifact.width === HUMANOID_POSTPROCESS_CANVAS.outputWidth && artifact.height === HUMANOID_POSTPROCESS_CANVAS.outputHeight, `${pose.poseId} raw state dimensions changed.`);
    verifyStateArtifactPath(artifact.path, manifest, pose);
    const rawPath = expectedRawPath(resolvedWorkDirectory, manifest, pose);
    regularFile(rawPath, `${pose.poseId} raw`);
    const raw = inspectPngBytes(readFileSync(rawPath), `${pose.poseId} raw`);
    invariant(raw.contentSha256 === artifact.contentSha256 && raw.sizeBytes === artifact.sizeBytes, `${pose.poseId} raw bytes differ from execution state.`);
    invariant(raw.width === HUMANOID_POSTPROCESS_CANVAS.outputWidth && raw.height === HUMANOID_POSTPROCESS_CANVAS.outputHeight, `${pose.poseId} raw dimensions changed.`);
    verified.push({ pose, slot, sourcePath, source, rawPath, raw });
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
    stateSha256: sha256(stateBytes),
    manifestSha256: sha256(manifestBytes),
    aliasPoseIds,
    knownVisualReviewFindings,
    verified,
  };
}

function hardlinkOrCopy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  invariant(!existsSync(destination), `Frame output already exists: ${destination}`);
  try {
    linkSync(source, destination);
  } catch {
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
  }
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
  invariant(outputDirectory !== workDirectory, 'Postprocess output must not replace the sealed work directory.');
  if (value('--output-dir') === '') invariant(outputDirectory.startsWith(`${workDirectory}${sep}`), 'Default postprocess output path is invalid.');
  return {
    workDirectory,
    outputDirectory,
    ffmpegBinary: value('--ffmpeg', 'ffmpeg'),
  };
}

export async function postprocessHumanoidTemplate(options) {
  const workDirectory = resolve(options.workDirectory);
  const outputDirectory = resolve(options.outputDirectory ?? join(workDirectory, 'postprocessed-v1'));
  const ffmpegBinary = options.ffmpegBinary ?? 'ffmpeg';
  invariant(!existsSync(outputDirectory), 'Postprocess output already exists; raw-preserving runs are immutable.');
  const input = verifyHumanoidPostprocessInputs({ workDirectory });
  const version = ffmpegVersion(ffmpegBinary);
  mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });

  const poseRecords = [];
  const poseOutputs = new Map();
  const thumbnails = new Map();
  const outputHashes = [];
  const topLevelReviewReasons = [];
  const topLevelHardFailures = [];

  for (const item of input.verified) {
    const { pose, sourcePath, rawPath } = item;
    const sourceRgb = decodePixels(
      sourcePath,
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

    const rawBytes = readFileSync(rawPath);
    const rawDestination = join(outputDirectory, 'poses', 'raw', `${pose.poseId}.png`);
    copyFileAtomic(rawPath, rawDestination);
    invariant(readFileSync(rawDestination).equals(rawBytes), `${pose.poseId} raw preservation is not byte-identical.`);
    const rawDescriptor = outputDescriptor(rawDestination, outputDirectory, {
      width: HUMANOID_POSTPROCESS_CANVAS.outputWidth,
      height: HUMANOID_POSTPROCESS_CANVAS.outputHeight,
    });
    invariant(rawDescriptor.contentSha256 === item.raw.contentSha256, `${pose.poseId} copied raw hash changed.`);

    const rawRgb = decodePixels(
      rawPath,
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
      ffmpegBinary,
    });
    const chromaDescriptor = outputDescriptor(chromaPath, outputDirectory, {
      width: HUMANOID_POSTPROCESS_CANVAS.outputWidth,
      height: HUMANOID_POSTPROCESS_CANVAS.outputHeight,
      colorType: 2,
    });
    const decodedChroma = decodePixels(
      chromaPath,
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
    poseRecords.push({
      poseId: pose.poseId,
      sourceSlots: pose.sourceSlots,
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
      hardlinkOrCopy(master.absolute[kind], destination);
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
      outputs: frameOutputs,
      semanticReview: {
        status: 'required',
        automatedApproval: false,
        knownFindings: input.knownVisualReviewFindings.filter((finding) => (
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
    encodePng({ pixels: contact.rgb, width: contact.width, height: contact.height, pixelFormat: 'rgb24', outputPath: contactPath, ffmpegBinary });
    const contactDescriptor = outputDescriptor(contactPath, outputDirectory, { width: contact.width, height: contact.height, colorType: 2 });
    addOutputHash(outputHashes, contactDescriptor);

    const gifFrames = animationThumbnails.map(darkComposite);
    const gifPath = join(outputDirectory, 'qa', 'gifs-dark', `${animationName}.gif`);
    const gifGeometry = encodeGif({
      frames: gifFrames,
      width: QA_THUMBNAIL_WIDTH,
      height: QA_THUMBNAIL_HEIGHT,
      outputPath: gifPath,
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
  const status = topLevelHardFailures.length === 0 ? 'awaiting_human_review' : 'hard_gate_failed';
  const manifest = {
    schemaVersion: 1,
    postprocessId: HUMANOID_POSTPROCESS_ID,
    status,
    source: {
      experimentId: input.manifest.experimentId,
      generatorCommitSha: input.state.generatorCommitSha,
      planSha256: input.manifest.planSha256,
      inputManifestSha256: input.manifestSha256,
      executionStateSha256: input.stateSha256,
      executionStatus: input.state.status,
      rawPoseCount: input.verified.length,
    },
    implementation: {
      scriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
      coreSha256: sha256(readFileSync(new URL('./humanoid-pose-template-postprocess-core.mjs', import.meta.url))),
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
    },
    poses: poseRecords,
    frameSlots: frameRecords,
    aliases,
    qa,
  };
  const manifestPath = join(outputDirectory, 'postprocess-manifest.json');
  writeJsonAtomic(manifestPath, manifest);
  const manifestDescriptor = outputDescriptorJson(manifestPath, outputDirectory);
  outputHashes.push({ path: manifestDescriptor.path, contentSha256: manifestDescriptor.contentSha256 });
  const hashLines = [...outputHashes]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.contentSha256}  ${entry.path}`)
    .join('\n');
  writeBytesAtomic(join(outputDirectory, 'hashes.sha256'), Buffer.from(`${hashLines}\n`));
  writeBytesAtomic(join(outputDirectory, 'postprocess-manifest.json.sha256'), Buffer.from(`${manifestDescriptor.contentSha256}  postprocess-manifest.json\n`));

  if (topLevelHardFailures.length > 0) {
    throw new Error(`Humanoid postprocess hard gates failed (${topLevelHardFailures.length}); inspect ${manifestPath}.`);
  }
  return { manifest, manifestPath, outputDirectory };
}

function outputDescriptorJson(path, outputDirectory) {
  const bytes = readFileSync(path);
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
