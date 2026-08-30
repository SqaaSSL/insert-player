import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  archiveJob,
  pollJob,
  resumeActionForSlot,
  submitBakeoffSlot,
} from './arcade-side-bakeoff.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_BYTES = 80 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
export const HUMANOID_TEMPLATE_SUBMISSION_TIMEOUT_MS = 180_000;
const TEMPORARY_UPLOAD_TTL_MS = 23 * 60 * 60 * 1000;

export const HUMANOID_TEMPLATE_EXPERIMENT_ID = 'humanoid-neutral-medium-xai-template-v3';
export const HUMANOID_TEMPLATE_CANARY_CONFIRMATION = 'GENERATE_HUMANOID_POSE_TEMPLATE_XAI_CANARY_V3';
export const HUMANOID_TEMPLATE_FULL_CONFIRMATION = 'GENERATE_HUMANOID_POSE_TEMPLATE_XAI_FULL_V3';
export const HUMANOID_TEMPLATE_SOURCE_ENDPOINT = 'https://api.insertplayer.ai/api/arcade';
export const HUMANOID_TEMPLATE_MODEL = Object.freeze({
  id: 'grok-imagine-image-2-edit',
  endpoint: 'xai/grok-imagine-image/v2.0/edit',
  provider: 'xai',
  backend: 'fal',
  catalogMaximumCostMicrocredits: 110_000,
  expectedTwoReferenceCostMicrocredits: 100_000,
  params: Object.freeze({
    num_images: 1,
    aspect_ratio: 'auto',
    resolution: '2k',
    output_format: 'png',
    quality: 'medium',
  }),
});

export const HUMANOID_TEMPLATE_CANONICAL = Object.freeze({
  originalPath: 'arcade/pose-master-seeds/humanoid-neutral-medium-canonical-v1.png',
  originalSha256: '08cafb31dfaec6612e8fbd4d20ff25a23ccadf5b41e0eb1822615fd7396e4056',
  normalizedPath: 'arcade/pose-master-seeds/humanoid-neutral-medium-canonical-v1-normalized.png',
  normalizedSha256: '5250f08b9dfe2b18816537b8bdb814cb302a7714098d55cd30bd926b7f450cf6',
  identityClosePath: 'arcade/pose-master-seeds/humanoid-neutral-medium-identity-close-v1.png',
  identityCloseSha256: '5642e3dbd7344e7eaa81722a459f382f9f7c1a666e01deeaec568d5077199a3d',
});

export const HUMANOID_TEMPLATE_SOURCE_SHEETS = Object.freeze({
  crouch: Object.freeze({ frameCount: 6, sha256: 'c89ec4638198472c09b7f87f08736ebba02d7f681dac8d7487e9bf904cc0ce3a' }),
  high_kick: Object.freeze({ frameCount: 12, sha256: 'fe38e7ee11eb328c56e8ff461326b058091a8a1fe2882080bd07dec57ae55839' }),
  high_punch: Object.freeze({ frameCount: 6, sha256: '721e1aef16531bbc62625edb7eb3b58cd22789e98ac876e93daa056c13ff9b0e' }),
  hit: Object.freeze({ frameCount: 6, sha256: 'aaa3dddd4287bba2f13882e5b45871518a013bc0272ac43b98ca3e103a7891df' }),
  idle: Object.freeze({ frameCount: 8, sha256: 'ad733cdda5a2a47829004a532ffed39c9f72b35541603b12405c79405eee15e4' }),
  jump: Object.freeze({ frameCount: 8, sha256: '57a4a1e362010e6961deb0d1d816a966fa92a04d85ad1a8ab80401238e9da861' }),
  ko: Object.freeze({ frameCount: 12, sha256: '5e9feab33bdb89fdeef3e49bb173ccf25888e4dc544825862b9420db5264f082' }),
  low_kick: Object.freeze({ frameCount: 9, sha256: '03c1aa9fe2b9234d3c85b26f0e9189f8092c8111b138e8c2db44baf39ea08abe' }),
  low_punch: Object.freeze({ frameCount: 7, sha256: '2650a3a1d5349ca6aa505b3e1cf6a1573f76f2551fa19e47038ff1ad07479fdf' }),
  victory: Object.freeze({ frameCount: 12, sha256: '6c87c71cbb6ec80a5cc9309c21e88a5cbe3c86423534c7a826e7a07e4f6f9b98' }),
  walk: Object.freeze({ frameCount: 12, sha256: 'cbd159532f8bbadbf4c92e98ddc8a34e6cd03631680f041bbead584bc688b4b6' }),
});

export const HUMANOID_TEMPLATE_CANARY_FRAMES = Object.freeze([
  Object.freeze({ animationName: 'walk', frameNumber: 7 }),
  Object.freeze({ animationName: 'high_kick', frameNumber: 7 }),
  Object.freeze({ animationName: 'high_kick', frameNumber: 12 }),
  Object.freeze({ animationName: 'crouch', frameNumber: 6 }),
  Object.freeze({ animationName: 'ko', frameNumber: 12 }),
]);

export const HUMANOID_TEMPLATE_CANARY_POSE_IDS = Object.freeze([
  'pose-089-bdcf17fb68d5',
  'pose-012-b0390c8ff88c',
  'pose-017-ed99c6001f85',
  'pose-006-f381aa6fdd00',
  'pose-056-011d4a420454',
]);

export const HUMANOID_TEMPLATE_POLICY = Object.freeze({
  frameIsolation: true,
  chaining: false,
  automaticRetries: 0,
  fallback: 'none',
  promptEnrichment: false,
  concurrency: 3,
  paidCalls: 94,
  canaryPaidCalls: 5,
  maximumTotalCostMicrocredits: 94 * HUMANOID_TEMPLATE_MODEL.expectedTwoReferenceCostMicrocredits,
  activation: false,
  humanReviewRequired: true,
});

export const HUMANOID_TEMPLATE_PROMPT = `EDIT IMAGE 1 ONLY. IMAGE 1 controls the exact pixel-space pose, silhouette, joint and limb geometry, facing, occlusion, balance, foot contact or airborne height, camera, scale, placement, and pure-green canvas. Keep all of them exactly. Do not copy IMAGE 2's pose or composition.

Use IMAGE 2 only for identity, physique surface, clothing, material, and render finish. It is a torso identity close-up and supplies no leg pose. Replace the person in IMAGE 1 with that exact generic bald androgynous adult humanoid: neutral human face, medium athletic build, warm neutral skin, complete bare human hands, and a seamless matte medium-gray fitted bodysuit over anatomically complete feet. Remove every Donald Trump trait, suit, tie, shoe, hair, logo, and accessory.

Return one coherent full body and one animation frame only. No extra, missing, fused, duplicated, or detached anatomy; no motion blur, trails, props, text, floor, shadow, scenery, gradient, border, or watermark. Keep the background perfectly flat pure #00FF00 and keep IMAGE 1's green margin.`;

const HUMANOID_TEMPLATE_ANIMATION_DIRECTIVES = Object.freeze({
  crouch: 'Preserve the exact crouch depth, both knee bends, hip height, guard, and both foot contacts from IMAGE 1.',
  high_kick: 'Preserve the exact high-kick phase, support leg, kicking-leg angle, raised-foot height, guard, and torso lean from IMAGE 1.',
  high_punch: 'Preserve the exact high-punch extension, striking arm, rear guard, shoulder turn, stance, and balance from IMAGE 1.',
  hit: 'Preserve the exact hit-reaction recoil, torso bend, head angle, limb positions, stance, and balance from IMAGE 1.',
  idle: 'Preserve the exact idle guard, stance width, knee bends, hand positions, and weight distribution from IMAGE 1.',
  jump: 'Preserve the exact jump phase, airborne height, leg tuck or extension, arm positions, and torso angle from IMAGE 1.',
  ko: 'Preserve the exact knockout fall phase, body orientation, floor contact, limb positions, and silhouette from IMAGE 1.',
  low_kick: 'Preserve the exact low-kick phase, support foot, kicking-leg angle and height, guard, and torso lean from IMAGE 1.',
  low_punch: 'Preserve the exact low-punch extension, striking arm, rear guard, stance depth, and torso rotation from IMAGE 1.',
  victory: 'Preserve the exact victory pose, arm gesture, stance, head angle, placement, and silhouette from IMAGE 1.',
  walk: 'Preserve the exact walk stride, leading leg, foot contacts or airborne foot, arm swing, and torso lean from IMAGE 1.',
});

const HUMANOID_TEMPLATE_CANARY_DIRECTIVES = Object.freeze({
  'crouch:6': 'POSE CHECK — CROUCH FRAME 6: deep squat with both knees visibly bent and hips near knee height, while preserving IMAGE 1 exactly. Do not output an upright neutral guard.',
  'high_kick:7': 'POSE CHECK — HIGH KICK FRAME 7: exactly one support foot on the ground; the other knee is raised to waist height and its foot is clearly airborne, while preserving IMAGE 1 exactly. Do not output a neutral guard.',
  'high_kick:12': 'POSE CHECK — HIGH KICK FRAME 12: exactly one support foot on the ground and the kicking leg is fully extended near horizontal, while preserving IMAGE 1 exactly. Do not reduce it to a knee chamber or neutral guard.',
  'ko:12': 'POSE CHECK — KO FRAME 12: the entire body is horizontal and prone with the exact floor contacts and limb arrangement from IMAGE 1. Do not output a standing or crouching guard.',
  'walk:7': 'POSE CHECK — WALK FRAME 7: preserve exactly which leg leads, which foot contacts the ground, the airborne foot height, arm swing, and torso lean from IMAGE 1. Do not output a neutral guard.',
});

function normalizePoseSourceSlots(pose) {
  invariant(Array.isArray(pose?.sourceSlots) && pose.sourceSlots.length > 0, 'Pose source slots are required.');
  return pose.sourceSlots.map((slot) => {
    invariant(Object.hasOwn(HUMANOID_TEMPLATE_SOURCE_SHEETS, slot?.animationName), 'Pose animation name is invalid.');
    invariant(Number.isSafeInteger(slot?.frameNumber) && slot.frameNumber >= 1, 'Pose frame number is invalid.');
    return { animationName: slot.animationName, frameNumber: slot.frameNumber };
  }).sort((left, right) => left.animationName.localeCompare(right.animationName) || left.frameNumber - right.frameNumber);
}

export function buildHumanoidTemplatePoseDirective(pose) {
  const sourceSlots = normalizePoseSourceSlots(pose);
  const exactCanaryDirectives = sourceSlots
    .map((slot) => HUMANOID_TEMPLATE_CANARY_DIRECTIVES[`${slot.animationName}:${slot.frameNumber}`])
    .filter(Boolean);
  if (exactCanaryDirectives.length > 0) return [...new Set(exactCanaryDirectives)].join(' ');
  const animationNames = [...new Set(sourceSlots.map((slot) => slot.animationName))];
  return animationNames.map((animationName) => HUMANOID_TEMPLATE_ANIMATION_DIRECTIVES[animationName]).join(' ');
}

export function buildHumanoidTemplatePrompt(pose) {
  return `${HUMANOID_TEMPLATE_PROMPT}\n\n${buildHumanoidTemplatePoseDirective(pose)}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function nowIso() {
  return new Date().toISOString();
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.writing-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function writeBytesAtomic(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.writing-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, path);
}

function inspectPng(bytes, label = 'PNG') {
  invariant(Buffer.isBuffer(bytes), `${label} is not bytes.`);
  invariant(bytes.byteLength >= 24 && bytes.byteLength <= MAX_PNG_BYTES, `${label} size is outside bounds.`);
  invariant(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), `${label} signature is invalid.`);
  invariant(bytes.toString('ascii', 12, 16) === 'IHDR', `${label} has no IHDR.`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  invariant(width >= 64 && height >= 64 && width <= 16_384 && height <= 16_384, `${label} dimensions are invalid.`);
  return {
    width,
    height,
    bitDepth: bytes.byteLength >= 26 ? bytes[24] : null,
    colorType: bytes.byteLength >= 26 ? bytes[25] : null,
    sizeBytes: bytes.byteLength,
    contentSha256: sha256(bytes),
  };
}

async function readBoundedResponse(response, maximumBytes, label) {
  const declared = Number(response.headers.get('content-length') ?? 0);
  invariant(Number.isFinite(declared) && declared >= 0 && declared <= maximumBytes, `${label} Content-Length is invalid.`);
  invariant(response.body, `${label} has no response body.`);
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeds its byte limit.`);
    }
    chunks.push(Buffer.from(value));
  }
  invariant(declared === 0 || total === declared, `${label} size does not match Content-Length.`);
  return Buffer.concat(chunks, total);
}

async function parseJsonResponse(response, label) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}.`);
  }
  return { body, text };
}

function runCommand(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: options.binary ? null : 'utf8',
    input: options.input,
    maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr;
    throw new Error(`${basename(binary)} failed: ${(result.error?.message ?? stderr ?? '').trim().slice(-2000)}`);
  }
  return result.stdout;
}

function pixelSha256(path, ffmpegBinary = 'ffmpeg') {
  const bytes = runCommand(ffmpegBinary, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
    '-i', path, '-map', '0:v:0', '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1',
  ], { binary: true });
  return sha256(bytes);
}

function sheetCellPixelSha256(path, frameIndex, sheetWidth, frameWidth, frameHeight, ffmpegBinary = 'ffmpeg') {
  const columns = sheetWidth / frameWidth;
  invariant(Number.isSafeInteger(columns) && columns > 0, 'HQ sheet width is not cell-aligned.');
  const x = (frameIndex % columns) * frameWidth;
  const y = Math.floor(frameIndex / columns) * frameHeight;
  const bytes = runCommand(ffmpegBinary, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
    '-i', path, '-map', '0:v:0', '-frames:v', '1',
    '-vf', `crop=${frameWidth}:${frameHeight}:${x}:${y}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1',
  ], { binary: true });
  return sha256(bytes);
}

function extractCell(sheetPath, outputPath, frameIndex, sheetWidth, frameWidth, frameHeight, ffmpegBinary = 'ffmpeg') {
  const columns = sheetWidth / frameWidth;
  invariant(Number.isSafeInteger(columns) && columns > 0, 'HQ sheet width is not cell-aligned.');
  const x = (frameIndex % columns) * frameWidth;
  const y = Math.floor(frameIndex / columns) * frameHeight;
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporary = `${outputPath}.writing-${process.pid}-${randomUUID()}.png`;
  runCommand(ffmpegBinary, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1',
    '-i', sheetPath,
    '-vf', `crop=${frameWidth}:${frameHeight}:${x}:${y}`,
    '-frames:v', '1', '-compression_level', '9', temporary,
  ]);
  renameSync(temporary, outputPath);
  return inspectPng(readFileSync(outputPath), `extracted frame ${frameIndex + 1}`);
}

export function inspectOpaqueChromaPose(path, ffmpegBinary = 'ffmpeg') {
  const bytes = readFileSync(path);
  const inspected = inspectPng(bytes, 'opaque chroma pose');
  invariant(inspected.bitDepth === 8 && inspected.colorType === 2, 'Opaque chroma pose must be an 8-bit RGB24 PNG.');
  const rgb = runCommand(ffmpegBinary, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
    '-i', path, '-map', '0:v:0', '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { binary: true });
  invariant(rgb.byteLength === inspected.width * inspected.height * 3, 'Opaque chroma pose decoded size is invalid.');
  const cornerOffsets = [
    0,
    (inspected.width - 1) * 3,
    (inspected.height - 1) * inspected.width * 3,
    ((inspected.height * inspected.width) - 1) * 3,
  ];
  for (const offset of cornerOffsets) {
    invariant(rgb[offset] === 0 && rgb[offset + 1] === 255 && rgb[offset + 2] === 0, 'Opaque chroma pose corners must be pure #00FF00.');
  }
  return { ...inspected, inputPixelSha256: pixelSha256(path, ffmpegBinary) };
}

export function compositeRgbaOnChroma(rgba, width, height) {
  invariant(Buffer.isBuffer(rgba), 'Source pose RGBA pixels are required.');
  invariant(Number.isSafeInteger(width) && width > 0, 'Source pose width is invalid.');
  invariant(Number.isSafeInteger(height) && height > 0, 'Source pose height is invalid.');
  invariant(rgba.byteLength === width * height * 4, 'Source pose decoded size is invalid.');
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let sourceOffset = 0, outputOffset = 0; sourceOffset < rgba.byteLength; sourceOffset += 4, outputOffset += 3) {
    const alpha = rgba[sourceOffset + 3];
    const inverseAlpha = 255 - alpha;
    rgb[outputOffset] = Math.round((rgba[sourceOffset] * alpha) / 255);
    rgb[outputOffset + 1] = Math.round(((rgba[sourceOffset + 1] * alpha) + (255 * inverseAlpha)) / 255);
    rgb[outputOffset + 2] = Math.round((rgba[sourceOffset + 2] * alpha) / 255);
  }
  return rgb;
}

export function flattenPoseOnChroma(inputPath, outputPath, ffmpegBinary = 'ffmpeg') {
  const source = inspectPng(readFileSync(inputPath), 'source pose');
  const rgba = runCommand(ffmpegBinary, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
    '-i', inputPath, '-map', '0:v:0', '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1',
  ], { binary: true });
  const rgb = compositeRgbaOnChroma(rgba, source.width, source.height);
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporary = `${outputPath}.writing-${process.pid}-${randomUUID()}.png`;
  try {
    runCommand(ffmpegBinary, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${source.width}x${source.height}`, '-i', 'pipe:0',
      '-frames:v', '1', '-pix_fmt', 'rgb24', '-compression_level', '9', temporary,
    ], { input: rgb });
    const flattened = inspectOpaqueChromaPose(temporary, ffmpegBinary);
    invariant(flattened.width === source.width && flattened.height === source.height, 'Flattened pose dimensions changed.');
    renameSync(temporary, outputPath);
    return flattened;
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function resolveFighter(payload) {
  const fighters = Array.isArray(payload?.fighters) ? payload.fighters : Array.isArray(payload?.roster) ? payload.roster : [];
  const matches = fighters.filter((fighter) => fighter?.arcade?.slug === 'donald-trump' || fighter?.slug === 'donald-trump');
  invariant(matches.length === 1, 'Production Arcade payload does not contain exactly one Donald Trump fighter.');
  return matches[0];
}

async function fetchSourceSnapshot(fetchImpl = fetch) {
  const response = await fetchImpl(HUMANOID_TEMPLATE_SOURCE_ENDPOINT, {
    headers: { 'User-Agent': 'insert-player-humanoid-pose-template/1.0' },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  invariant(response.ok, `Production Arcade source returned HTTP ${response.status}.`);
  const payload = await response.json();
  const fighter = resolveFighter(payload);
  const sprites = Array.isArray(fighter.sprites) ? fighter.sprites : [];
  const expectedNames = Object.keys(HUMANOID_TEMPLATE_SOURCE_SHEETS).sort();
  const relevant = sprites.filter((sprite) => Object.hasOwn(HUMANOID_TEMPLATE_SOURCE_SHEETS, sprite.animationName));
  invariant(canonicalJson(relevant.map((sprite) => sprite.animationName).sort()) === canonicalJson(expectedNames), 'Trump HQ source set changed.');
  return relevant.map((sprite) => {
    const expected = HUMANOID_TEMPLATE_SOURCE_SHEETS[sprite.animationName];
    const url = new URL(sprite.hqUrl);
    invariant(url.protocol === 'https:' && url.hostname === 'api.insertplayer.ai', `${sprite.animationName} HQ URL is outside production.`);
    invariant(sprite.hqFrameWidth === 768 && sprite.hqFrameHeight === 1024, `${sprite.animationName} HQ cell geometry changed.`);
    invariant(sprite.hqFrameCount === expected.frameCount, `${sprite.animationName} HQ forward count changed.`);
    return {
      animationName: sprite.animationName,
      spriteId: sprite.id,
      hqUrl: sprite.hqUrl,
      hqFrameWidth: sprite.hqFrameWidth,
      hqFrameHeight: sprite.hqFrameHeight,
      hqFrameCount: sprite.hqFrameCount,
      runtimeFrameCount: sprite.frameCount,
      animationFormat: sprite.animationFormat,
      processingVersion: sprite.processingVersion,
      expectedHqSha256: expected.sha256,
    };
  }).sort((left, right) => left.animationName.localeCompare(right.animationName));
}

async function downloadPinnedPng(url, outputPath, expectedSha256, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'insert-player-humanoid-pose-template/1.0' },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  invariant(response.ok, `Pinned HQ source returned HTTP ${response.status}.`);
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
  invariant(contentType === 'image/png', 'Pinned HQ source is not image/png.');
  const bytes = await readBoundedResponse(response, MAX_PNG_BYTES, 'Pinned HQ source');
  const inspected = inspectPng(bytes, 'Pinned HQ source');
  invariant(inspected.contentSha256 === expectedSha256, 'Pinned HQ source SHA-256 changed.');
  writeBytesAtomic(outputPath, bytes);
  return inspected;
}

export async function prepareHumanoidTemplateInputs(options = {}) {
  const outputDirectory = resolve(options.outputDirectory);
  const ffmpegBinary = options.ffmpegBinary ?? 'ffmpeg';
  const manifestPath = join(outputDirectory, 'input-manifest.json');
  invariant(!existsSync(manifestPath), 'Prepared input manifest already exists; use the immutable checkpoint.');
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

  const canonicalRecords = {};
  for (const [name, sourcePathKey, expectedShaKey, outputName] of [
    ['canonicalOriginal', 'originalPath', 'originalSha256', 'canonical-original.png'],
    ['canonicalNormalized', 'normalizedPath', 'normalizedSha256', 'canonical-normalized.png'],
    ['identityClose', 'identityClosePath', 'identityCloseSha256', 'identity-close.png'],
  ]) {
    const sourcePath = resolve(root, HUMANOID_TEMPLATE_CANONICAL[sourcePathKey]);
    const bytes = readFileSync(sourcePath);
    const inspected = inspectPng(bytes, name);
    invariant(inspected.contentSha256 === HUMANOID_TEMPLATE_CANONICAL[expectedShaKey], `${name} SHA-256 changed.`);
    const destination = join(outputDirectory, 'references', outputName);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(sourcePath, destination);
    canonicalRecords[name] = { ...inspected, path: relative(outputDirectory, destination) };
  }

  const snapshot = await fetchSourceSnapshot(options.fetchImpl);
  const frameSlots = [];
  const uniqueByPixelHash = new Map();
  const sourceSheets = [];

  for (const sprite of snapshot) {
    const sheetPath = join(outputDirectory, 'source-sheets', `${sprite.animationName}.png`);
    const sheet = await downloadPinnedPng(sprite.hqUrl, sheetPath, sprite.expectedHqSha256, options.fetchImpl);
    invariant(sheet.width % sprite.hqFrameWidth === 0 && sheet.height % sprite.hqFrameHeight === 0, `${sprite.animationName} HQ sheet is not cell-aligned.`);
    invariant((sheet.width / sprite.hqFrameWidth) * (sheet.height / sprite.hqFrameHeight) >= sprite.hqFrameCount, `${sprite.animationName} HQ sheet has too few cells.`);
    sourceSheets.push({ ...sprite, ...sheet, path: relative(outputDirectory, sheetPath) });

    for (let index = 0; index < sprite.hqFrameCount; index += 1) {
      const frameNumber = index + 1;
      const extractedPath = join(outputDirectory, 'extracted', sprite.animationName, `frame-${String(frameNumber).padStart(3, '0')}.png`);
      const frame = extractCell(
        sheetPath,
        extractedPath,
        index,
        sheet.width,
        sprite.hqFrameWidth,
        sprite.hqFrameHeight,
        ffmpegBinary,
      );
      invariant(frame.width === 768 && frame.height === 1024, `${sprite.animationName} frame ${frameNumber} has invalid dimensions.`);
      const pixelHash = pixelSha256(extractedPath, ffmpegBinary);
      let pose = uniqueByPixelHash.get(pixelHash);
      if (!pose) {
        const poseId = `pose-${String(uniqueByPixelHash.size + 1).padStart(3, '0')}-${pixelHash.slice(0, 12)}`;
        const posePath = join(outputDirectory, 'poses', `${poseId}.png`);
        const flattened = flattenPoseOnChroma(extractedPath, posePath, ffmpegBinary);
        pose = {
          poseId,
          pixelSha256: pixelHash,
          inputPixelSha256: flattened.inputPixelSha256,
          sourceContentSha256: frame.contentSha256,
          contentSha256: flattened.contentSha256,
          sizeBytes: flattened.sizeBytes,
          width: flattened.width,
          height: flattened.height,
          bitDepth: flattened.bitDepth,
          colorType: flattened.colorType,
          path: relative(outputDirectory, posePath),
          sourceSlots: [],
        };
        uniqueByPixelHash.set(pixelHash, pose);
      }
      pose.sourceSlots.push({ animationName: sprite.animationName, frameNumber });
      frameSlots.push({ animationName: sprite.animationName, frameNumber, poseId: pose.poseId });
    }
  }

  const uniquePoses = [...uniqueByPixelHash.values()];
  for (const pose of uniquePoses) {
    pose.poseDirective = buildHumanoidTemplatePoseDirective(pose);
    pose.promptSha256 = sha256(buildHumanoidTemplatePrompt(pose));
  }
  invariant(frameSlots.length === 98, `Expected 98 HQ forward frame slots, received ${frameSlots.length}.`);
  invariant(uniquePoses.length === 94, `Expected 94 distinct HQ poses, received ${uniquePoses.length}.`);
  const duplicateGroups = uniquePoses.filter((pose) => pose.sourceSlots.length > 1);
  invariant(duplicateGroups.length === 4 && duplicateGroups.every((pose) => pose.sourceSlots.length === 2), 'Expected exactly four shared F0 pose groups.');

  const canaryPoseIds = HUMANOID_TEMPLATE_CANARY_FRAMES.map(({ animationName, frameNumber }) => {
    const slot = frameSlots.find((candidate) => candidate.animationName === animationName && candidate.frameNumber === frameNumber);
    invariant(slot, `Canary source ${animationName} frame ${frameNumber} is missing.`);
    return slot.poseId;
  });
  invariant(new Set(canaryPoseIds).size === HUMANOID_TEMPLATE_CANARY_FRAMES.length, 'Canary frames are not five distinct poses.');

  const manifestCore = {
    schemaVersion: 2,
    experimentId: HUMANOID_TEMPLATE_EXPERIMENT_ID,
    sourceEndpoint: HUMANOID_TEMPLATE_SOURCE_ENDPOINT,
    sourceFighter: { id: '8555abdb8beeb6e03679474c24be982f', slug: 'donald-trump' },
    model: HUMANOID_TEMPLATE_MODEL,
    promptBase: HUMANOID_TEMPLATE_PROMPT,
    promptBaseSha256: sha256(HUMANOID_TEMPLATE_PROMPT),
    referenceOrder: ['pose_flat_chroma', 'identity_close'],
    canonical: canonicalRecords,
    sourceSheets,
    frameSlots,
    uniquePoses,
    canary: HUMANOID_TEMPLATE_CANARY_FRAMES.map((frame, index) => ({ ...frame, poseId: canaryPoseIds[index] })),
    policy: { ...HUMANOID_TEMPLATE_POLICY },
  };
  const manifest = { ...manifestCore, planSha256: sha256(canonicalJson(manifestCore)) };
  writeJsonAtomic(manifestPath, manifest);
  return { manifest, manifestPath };
}

function verifyPreparedManifest(inputDirectory, ffmpegBinary = 'ffmpeg') {
  const manifestPath = join(inputDirectory, 'input-manifest.json');
  const bytes = readFileSync(manifestPath);
  const manifest = JSON.parse(bytes.toString('utf8'));
  const { planSha256, ...core } = manifest;
  invariant(planSha256 === sha256(canonicalJson(core)), 'Prepared input plan SHA-256 changed.');
  invariant(manifest.schemaVersion === 2, 'Prepared input schema changed.');
  invariant(manifest.experimentId === HUMANOID_TEMPLATE_EXPERIMENT_ID, 'Prepared input experiment changed.');
  invariant(manifest.promptBase === HUMANOID_TEMPLATE_PROMPT, 'Prepared prompt base changed.');
  invariant(manifest.promptBaseSha256 === sha256(HUMANOID_TEMPLATE_PROMPT), 'Prepared prompt-base pin changed.');
  invariant(manifest.frameSlots.length === 98 && manifest.uniquePoses.length === 94, 'Prepared input cardinality changed.');
  invariant(manifest.referenceOrder.join(',') === 'pose_flat_chroma,identity_close', 'Prepared reference order changed.');
  invariant(canonicalJson(manifest.model) === canonicalJson(HUMANOID_TEMPLATE_MODEL), 'Prepared model contract changed.');
  invariant(canonicalJson(manifest.policy) === canonicalJson(HUMANOID_TEMPLATE_POLICY), 'Prepared execution policy changed.');
  invariant(
    canonicalJson(manifest.canary.map(({ animationName, frameNumber }) => ({ animationName, frameNumber })))
      === canonicalJson(HUMANOID_TEMPLATE_CANARY_FRAMES),
    'Prepared canary selection changed.',
  );
  invariant(
    canonicalJson(manifest.canary.map(({ poseId }) => poseId)) === canonicalJson(HUMANOID_TEMPLATE_CANARY_POSE_IDS),
    'Prepared canary pose ids changed.',
  );
  for (const [key, expected] of [
    ['canonicalOriginal', HUMANOID_TEMPLATE_CANONICAL.originalSha256],
    ['canonicalNormalized', HUMANOID_TEMPLATE_CANONICAL.normalizedSha256],
    ['identityClose', HUMANOID_TEMPLATE_CANONICAL.identityCloseSha256],
  ]) {
    invariant(manifest.canonical[key]?.contentSha256 === expected, `Prepared ${key} pin changed.`);
  }
  const preparedSheets = Object.fromEntries(manifest.sourceSheets.map((sheet) => [sheet.animationName, sheet]));
  invariant(Object.keys(preparedSheets).length === Object.keys(HUMANOID_TEMPLATE_SOURCE_SHEETS).length, 'Prepared source-sheet set changed.');
  for (const [animationName, expected] of Object.entries(HUMANOID_TEMPLATE_SOURCE_SHEETS)) {
    const sheet = preparedSheets[animationName];
    invariant(sheet?.hqFrameCount === expected.frameCount, `${animationName} prepared frame count changed.`);
    invariant(sheet?.contentSha256 === expected.sha256, `${animationName} prepared source pin changed.`);
  }
  for (const record of [manifest.canonical.canonicalOriginal, manifest.canonical.canonicalNormalized, manifest.canonical.identityClose, ...manifest.uniquePoses]) {
    const path = resolve(inputDirectory, record.path);
    invariant(path.startsWith(`${inputDirectory}/`), 'Prepared input path escapes its directory.');
    const inspected = inspectPng(readFileSync(path), 'prepared PNG');
    invariant(inspected.contentSha256 === record.contentSha256, `Prepared input ${record.path} changed.`);
  }
  invariant(
    manifest.canonical.identityClose.width === 768 && manifest.canonical.identityClose.height === 1024,
    'Prepared identity close-up geometry changed.',
  );
  const poseById = new Map(manifest.uniquePoses.map((pose) => [pose.poseId, pose]));
  invariant(poseById.size === 94, 'Prepared pose ids are not unique.');
  for (const pose of manifest.uniquePoses) {
    invariant(Array.isArray(pose.sourceSlots) && pose.sourceSlots.length > 0, `${pose.poseId} has no source slots.`);
    const inputPath = resolve(inputDirectory, pose.path);
    const inspected = inspectOpaqueChromaPose(inputPath, ffmpegBinary);
    const firstSourceSlot = pose.sourceSlots[0];
    const firstExtractedPath = resolve(
      inputDirectory,
      'extracted',
      firstSourceSlot.animationName,
      `frame-${String(firstSourceSlot.frameNumber).padStart(3, '0')}.png`,
    );
    invariant(inspected.contentSha256 === pose.contentSha256, `${pose.poseId} flattened content pin changed.`);
    invariant(inspected.inputPixelSha256 === pose.inputPixelSha256, `${pose.poseId} flattened pixel pin changed.`);
    invariant(
      inspectPng(readFileSync(firstExtractedPath), `${pose.poseId} first source`).contentSha256 === pose.sourceContentSha256,
      `${pose.poseId} first-source content pin changed.`,
    );
    invariant(pose.bitDepth === 8 && pose.colorType === 2, `${pose.poseId} flattened PNG mode changed.`);
    invariant(pose.poseDirective === buildHumanoidTemplatePoseDirective(pose), `${pose.poseId} pose directive changed.`);
    invariant(pose.promptSha256 === sha256(buildHumanoidTemplatePrompt(pose)), `${pose.poseId} prompt pin changed.`);
  }
  const derivedPixelGroups = new Map();
  const expectedSlots = [];
  for (const [animationName, expected] of Object.entries(HUMANOID_TEMPLATE_SOURCE_SHEETS)) {
    const sheet = preparedSheets[animationName];
    const sheetPath = resolve(inputDirectory, sheet.path);
    const sheetBytes = readFileSync(sheetPath);
    const inspectedSheet = inspectPng(sheetBytes, `${animationName} prepared source sheet`);
    invariant(inspectedSheet.contentSha256 === expected.sha256, `${animationName} source-sheet bytes changed.`);
    invariant(inspectedSheet.width === sheet.width && inspectedSheet.height === sheet.height, `${animationName} source-sheet dimensions changed.`);
    for (let index = 0; index < expected.frameCount; index += 1) {
      const frameNumber = index + 1;
      const slot = manifest.frameSlots.find((entry) => entry.animationName === animationName && entry.frameNumber === frameNumber);
      invariant(slot, `${animationName} frame ${frameNumber} mapping is missing.`);
      const sourcePixelHash = sheetCellPixelSha256(
        sheetPath,
        index,
        inspectedSheet.width,
        sheet.hqFrameWidth,
        sheet.hqFrameHeight,
        ffmpegBinary,
      );
      const extractedPath = resolve(inputDirectory, 'extracted', animationName, `frame-${String(frameNumber).padStart(3, '0')}.png`);
      invariant(pixelSha256(extractedPath, ffmpegBinary) === sourcePixelHash, `${animationName} frame ${frameNumber} no longer matches its pinned sheet cell.`);
      const pose = poseById.get(slot.poseId);
      invariant(pose?.pixelSha256 === sourcePixelHash, `${animationName} frame ${frameNumber} pose pixel pin changed.`);
      invariant(slot.poseId === `pose-${String(manifest.uniquePoses.indexOf(pose) + 1).padStart(3, '0')}-${sourcePixelHash.slice(0, 12)}`, `${animationName} frame ${frameNumber} pose id changed.`);
      invariant(
        pixelSha256(resolve(inputDirectory, pose.path), ffmpegBinary) === pose.inputPixelSha256,
        `${slot.poseId} flattened input pixel pin changed.`,
      );
      const group = derivedPixelGroups.get(sourcePixelHash) ?? [];
      group.push({ animationName, frameNumber });
      derivedPixelGroups.set(sourcePixelHash, group);
      expectedSlots.push({ animationName, frameNumber, poseId: slot.poseId });
    }
  }
  invariant(derivedPixelGroups.size === 94, 'Pinned sheets no longer derive exactly 94 distinct poses.');
  invariant(canonicalJson(manifest.frameSlots) === canonicalJson(expectedSlots), 'Prepared frame-slot order or contents changed.');
  for (const [pixelHash, sourceSlots] of derivedPixelGroups) {
    const pose = manifest.uniquePoses.find((entry) => entry.pixelSha256 === pixelHash);
    invariant(pose && canonicalJson(pose.sourceSlots) === canonicalJson(sourceSlots), `Prepared source-slot group changed for ${pixelHash.slice(0, 12)}.`);
  }
  return { manifest, manifestSha256: sha256(bytes) };
}

export function buildHumanoidTemplatePayload({ poseAssetHash, identityAssetHash, pose }) {
  invariant(/^[a-f0-9]{32}$/.test(poseAssetHash ?? ''), 'Pose PixCLI asset hash is invalid.');
  invariant(/^[a-f0-9]{32}$/.test(identityAssetHash ?? ''), 'Identity PixCLI asset hash is invalid.');
  invariant(poseAssetHash !== identityAssetHash, 'Pose and identity references must be distinct.');
  invariant(/^pose-[0-9]{3}-[a-f0-9]{12}$/.test(pose?.poseId ?? ''), 'Pose id is invalid.');
  const prompt = buildHumanoidTemplatePrompt(pose);
  const publishName = `ip-humanoid-template-v3-${pose.poseId.slice(5, 8)}`;
  return {
    prompt,
    model: HUMANOID_TEMPLATE_MODEL.id,
    image: [poseAssetHash, identityAssetHash],
    params: { ...HUMANOID_TEMPLATE_MODEL.params },
    enrich_prompt: false,
    search: false,
    output_format: 'url',
    publish: false,
    publish_name: publishName,
  };
}

function buildPoseExecutionContract({ pose, poseAssetHash, identityAssetHash, manifest }) {
  const payload = buildHumanoidTemplatePayload({ poseAssetHash, identityAssetHash, pose });
  invariant(manifest.promptBaseSha256 === sha256(HUMANOID_TEMPLATE_PROMPT), 'Manifest prompt base changed.');
  invariant(pose.promptSha256 === sha256(payload.prompt), `${pose.poseId} prompt contract changed.`);
  return {
    payload,
    invariants: {
      slotKey: `${pose.poseId}:${HUMANOID_TEMPLATE_MODEL.id}`,
      slug: pose.poseId,
      fighterName: 'Humanoid Neutral Medium',
      modelId: HUMANOID_TEMPLATE_MODEL.id,
      providerEndpoint: HUMANOID_TEMPLATE_MODEL.endpoint,
      sourceSha256: pose.contentSha256,
      promptSha256: pose.promptSha256,
      poseAssetHash,
      identityAssetHash,
      requestSha256: sha256(canonicalJson(payload)),
    },
  };
}

export function verifyStoredSlotContract(slot, expected) {
  const keys = [
    'slotKey',
    'slug',
    'fighterName',
    'modelId',
    'providerEndpoint',
    'sourceSha256',
    'promptSha256',
    'poseAssetHash',
    'identityAssetHash',
    'requestSha256',
  ];
  const mismatches = keys.filter((key) => slot?.[key] !== expected[key]);
  invariant(mismatches.length === 0, `Stored slot contract changed: ${mismatches.join(', ')}.`);
}

async function preflightModel(apiBase, apiKey, fetchImpl = fetch) {
  const response = await fetchImpl(`${apiBase}/api/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'insert-player-humanoid-pose-template/1.0' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const { body, text } = await parseJsonResponse(response, 'PixCLI model preflight');
  invariant(response.ok, `PixCLI model preflight returned HTTP ${response.status}.`);
  const models = Array.isArray(body) ? body : body?.models;
  const matches = Array.isArray(models) ? models.filter((model) => model?.id === HUMANOID_TEMPLATE_MODEL.id) : [];
  invariant(matches.length === 1, 'Pinned Grok model is missing or ambiguous.');
  const model = matches[0];
  invariant(model.provider === HUMANOID_TEMPLATE_MODEL.provider, 'Pinned Grok provider changed.');
  invariant(model.backend === HUMANOID_TEMPLATE_MODEL.backend, 'Pinned Grok backend changed.');
  invariant(model.cost_per_image === HUMANOID_TEMPLATE_MODEL.catalogMaximumCostMicrocredits, 'Pinned Grok catalog price changed.');
  invariant(model.advanced_mode === true, 'Pinned Grok advanced mode changed.');
  invariant(Array.isArray(model.capabilities) && model.capabilities.includes('edit') && model.capabilities.includes('image-to-image'), 'Pinned Grok capabilities changed.');
  return { model, catalogSha256: sha256(text) };
}

function uploadCanBeReused(record, expectedSha256) {
  if (!record || record.status !== 'uploaded' || record.contentSha256 !== expectedSha256) return false;
  if (!/^[a-f0-9]{32}$/.test(record.pixcliAssetHash ?? '')) return false;
  const expiresAt = Date.parse(record.expiresAt ?? '');
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + (15 * 60 * 1000);
}

async function uploadTemporaryReference(options) {
  const { apiBase, apiKey, path, recordKey, expectedSha256, save, fetchImpl = fetch } = options;
  const bytes = readFileSync(path);
  const inspected = inspectPng(bytes, recordKey);
  invariant(inspected.contentSha256 === expectedSha256, `${recordKey} upload source changed.`);
  const uploading = {
    recordKey,
    contentSha256: expectedSha256,
    sizeBytes: bytes.byteLength,
    status: 'uploading',
    uploadStartedAt: nowIso(),
  };
  save(uploading);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/png' }), `${recordKey}.png`);
  let response;
  try {
    response = await fetchImpl(`${apiBase}/api/v1/uploads?temporary=true`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'insert-player-humanoid-pose-template/1.0' },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    save({ ...uploading, status: 'upload_outcome_unknown', error: error instanceof Error ? error.message : String(error), updatedAt: nowIso() });
    throw new Error(`${recordKey} temporary upload outcome is unknown; automatic retry is forbidden.`);
  }
  const { body, text } = await parseJsonResponse(response, 'PixCLI temporary upload');
  if (response.status !== 201 || !/^[a-f0-9]{32}$/.test(body?.hash ?? '') || typeof body?.url !== 'string') {
    const definitive = response.status >= 400 && response.status < 500;
    save({
      ...uploading,
      status: definitive ? 'upload_rejected' : 'upload_outcome_unknown',
      httpStatus: response.status,
      responseSha256: sha256(text),
      error: typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`,
      updatedAt: nowIso(),
    });
    throw new Error(`${recordKey} temporary upload ${definitive ? 'was rejected' : 'outcome is unknown'}.`);
  }
  const uploadedAt = nowIso();
  const uploaded = {
    ...uploading,
    status: 'uploaded',
    pixcliAssetHash: body.hash,
    pixcliAssetUrl: body.url,
    mimeType: body.mime_type ?? 'image/png',
    temporary: true,
    uploadedAt,
    expiresAt: new Date(Date.parse(uploadedAt) + TEMPORARY_UPLOAD_TTL_MS).toISOString(),
    updatedAt: uploadedAt,
  };
  save(uploaded);
  return uploaded;
}

function initialExecutionState(manifest, manifestSha256, catalog, execution) {
  return {
    schemaVersion: 2,
    experimentId: HUMANOID_TEMPLATE_EXPERIMENT_ID,
    planSha256: manifest.planSha256,
    manifestSha256,
    model: HUMANOID_TEMPLATE_MODEL,
    catalog,
    policy: manifest.policy,
    references: {},
    slots: {},
    generatorCommitSha: execution.generatorCommitSha,
    rootRunId: execution.runId,
    executionRuns: [execution],
    completedPoseCount: 0,
    status: 'prepared',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function hasExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

function readArchivedJson(artifact, label) {
  invariant(artifact?.mimeType === 'application/json', `${label} MIME type changed.`);
  const path = resolve(root, artifact.path ?? '');
  invariant(path.startsWith(`${root}/`), `${label} path escapes the repository.`);
  const bytes = readFileSync(path);
  invariant(sha256(bytes) === artifact.contentSha256 && bytes.byteLength === artifact.sizeBytes, `${label} archived bytes changed.`);
  return JSON.parse(bytes.toString('utf8'));
}

function isExpectedSignedTemporaryAssetUrl(value, apiBase, expectedHash, submittedAt) {
  if (typeof value !== 'string') return false;
  let url;
  let expectedOrigin;
  try {
    url = new URL(value);
    expectedOrigin = new URL(apiBase).origin;
  } catch {
    return false;
  }
  const expiresValues = url.searchParams.getAll('expires');
  const signatureValues = url.searchParams.getAll('signature');
  const queryKeys = [...url.searchParams.keys()].sort();
  const expires = expiresValues[0] ?? '';
  const signature = signatureValues[0] ?? '';
  const submittedMs = Date.parse(submittedAt ?? '');
  const expiresSeconds = Number(expires);
  return url.protocol === 'https:'
    && url.origin === expectedOrigin
    && url.username === ''
    && url.password === ''
    && url.pathname === `/api/v1/assets/${expectedHash}`
    && url.hash === ''
    && canonicalJson(queryKeys) === canonicalJson(['expires', 'signature'])
    && expiresValues.length === 1
    && signatureValues.length === 1
    && /^[1-9][0-9]{9}$/.test(expires)
    && /^[A-Za-z0-9_-]{43}$/.test(signature)
    && Number.isFinite(submittedMs)
    && Number.isSafeInteger(expiresSeconds)
    && expiresSeconds * 1000 > submittedMs
    && expiresSeconds * 1000 <= submittedMs + (25 * 60 * 60 * 1000);
}

export function validateCompletedArchive({ archived, active, job, invariants, payload, apiBase }) {
  const errors = [];
  if (job.status !== 'completed') errors.push(`provider status ${String(job.status)}`);
  if (job.cost !== HUMANOID_TEMPLATE_MODEL.expectedTwoReferenceCostMicrocredits) errors.push(`job cost ${String(job.cost)}`);
  for (const kind of ['provider_request', 'provider_response', 'image']) {
    if (archived.assetCounts?.[kind] !== 1) errors.push(`${kind} asset count ${String(archived.assetCounts?.[kind])}`);
  }
  const normalizedInput = archived.canvaInput;
  let imageUrls = null;
  if (!normalizedInput || typeof normalizedInput !== 'object' || Array.isArray(normalizedInput)) {
    errors.push('normalized input is invalid');
  } else {
    const serverDerivedKeys = ['image_url', 'image_urls', 'enriched_prompt'];
    const expectedKeys = [...Object.keys(payload), ...serverDerivedKeys].sort();
    if (canonicalJson(Object.keys(normalizedInput).sort()) !== canonicalJson(expectedKeys)) errors.push('normalized input keys mismatch');
    const submittedProjection = { ...normalizedInput };
    for (const key of serverDerivedKeys) delete submittedProjection[key];
    if (sha256(canonicalJson(submittedProjection)) !== invariants.requestSha256) errors.push('sealed input hash mismatch');
    const normalizedImageUrls = normalizedInput.image_urls;
    const signedReferencesMatch = Array.isArray(normalizedImageUrls)
      && normalizedImageUrls.length === payload.image.length
      && normalizedImageUrls.every((url, index) => isExpectedSignedTemporaryAssetUrl(
        url,
        apiBase,
        payload.image[index],
        active.submittedAt,
      ));
    if (
      normalizedInput.enriched_prompt !== payload.prompt
      || !signedReferencesMatch
      || normalizedInput.image_url !== normalizedImageUrls?.[0]
    ) {
      errors.push('normalized prompt or reference URLs mismatch');
    } else {
      imageUrls = [...normalizedImageUrls];
    }
    if (archived.pixcliInputSha256 !== sha256(canonicalJson(normalizedInput))) errors.push('normalized input archive hash mismatch');
  }
  if (archived.canvaJob?.job_id !== active.pixcliJobId) errors.push('Canva job id mismatch');
  if (archived.canvaJob?.status !== job.status) errors.push('Canva job status mismatch');
  if (archived.canvaJob?.cost !== job.cost) errors.push('Canva job cost mismatch');
  if (archived.providerRuns?.length !== 1) {
    errors.push(`provider run count ${String(archived.providerRuns?.length)}`);
  } else {
    const providerRun = archived.providerRuns[0];
    if (providerRun.modelId !== HUMANOID_TEMPLATE_MODEL.id) errors.push('provider-run model mismatch');
    if (providerRun.provider !== HUMANOID_TEMPLATE_MODEL.backend) errors.push('provider-run backend mismatch');
    if (typeof providerRun.requestId !== 'string' || !providerRun.requestId) errors.push('provider request id missing');
    const requestAuditId = archived.artifacts?.provider_request?.providerRequestId;
    if (requestAuditId !== null && requestAuditId !== undefined && requestAuditId !== providerRun.requestId) errors.push('provider_request request id mismatch');
    if (archived.artifacts?.provider_response?.providerRequestId !== providerRun.requestId) errors.push('provider_response request id mismatch');
    const imageRequestId = archived.artifacts?.image?.providerRequestId;
    if (imageRequestId !== null && imageRequestId !== undefined && imageRequestId !== providerRun.requestId) errors.push('image request id mismatch');
  }
  const requestArtifact = archived.artifacts?.provider_request;
  const responseArtifact = archived.artifacts?.provider_response;
  const imageArtifact = archived.artifacts?.image;
  if (
    requestArtifact?.mimeType !== 'application/json'
    || responseArtifact?.mimeType !== 'application/json'
    || requestArtifact?.modelId !== HUMANOID_TEMPLATE_MODEL.id
    || responseArtifact?.modelId !== HUMANOID_TEMPLATE_MODEL.id
    || imageArtifact?.modelId !== HUMANOID_TEMPLATE_MODEL.id
    || imageArtifact?.prompt !== payload.prompt
  ) {
    errors.push('audit asset metadata mismatch');
  }
  if (imageArtifact?.mimeType !== 'image/png') errors.push('output is not PNG');
  try {
    const requestAudit = readArchivedJson(requestArtifact, 'provider request audit');
    const expectedProviderInput = imageUrls ? {
      ...payload.params,
      prompt: payload.prompt,
      image_urls: imageUrls,
    } : null;
    if (
      !hasExactKeys(requestAudit, ['model', 'input', 'retry_policy', 'fallback_policy'])
      || requestAudit.model !== HUMANOID_TEMPLATE_MODEL.endpoint
      || requestAudit.retry_policy !== 'none'
      || requestAudit.fallback_policy !== 'none'
      || canonicalJson(requestAudit.input) !== canonicalJson(expectedProviderInput)
    ) {
      errors.push('provider request audit mismatch');
    }
  } catch (error) {
    errors.push(`provider request audit unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const responseAudit = readArchivedJson(responseArtifact, 'provider response audit');
    if (!hasExactKeys(responseAudit, ['images', 'revised_prompt']) || responseAudit.revised_prompt !== null || responseAudit.images?.length !== 1) {
      errors.push('provider response audit shape mismatch');
    } else {
      const [image] = responseAudit.images;
      let sourceUrl = null;
      try {
        sourceUrl = new URL(image?.url);
      } catch {
        errors.push('provider response image URL is invalid');
      }
      if (
        !hasExactKeys(image, ['url', 'content_type', 'file_name', 'file_size', 'width', 'height'])
        || sourceUrl?.protocol !== 'https:'
        || sourceUrl?.hostname !== 'v3b.fal.media'
        || sourceUrl?.search !== ''
        || sourceUrl?.hash !== ''
        || image.url !== imageArtifact?.sourceUrl
        || image.content_type !== 'image/png'
        || image.file_name !== basename(sourceUrl?.pathname ?? '')
        || !image.file_name?.endsWith('.png')
        || (image.file_size !== null && image.file_size !== imageArtifact?.declaredSizeBytes)
        || image.width !== imageArtifact?.width
        || image.height !== imageArtifact?.height
      ) {
        errors.push('provider response image does not match the sole archived output');
      }
    }
  } catch (error) {
    errors.push(`provider response audit unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const outputPath = resolve(root, imageArtifact?.path ?? '');
    invariant(outputPath.startsWith(`${root}/`), 'Output image path escapes the repository.');
    const output = inspectPng(readFileSync(outputPath), 'archived humanoid output');
    if (
      output.contentSha256 !== imageArtifact.contentSha256
      || output.sizeBytes !== imageArtifact.sizeBytes
      || (imageArtifact.declaredSizeBytes !== null && output.sizeBytes !== imageArtifact.declaredSizeBytes)
      || output.width !== imageArtifact.width
      || output.height !== imageArtifact.height
    ) {
      errors.push('archived PNG bytes or dimensions mismatch');
    }
  } catch (error) {
    errors.push(`archived PNG unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return errors;
}

function acquireLock(statePath) {
  const path = `${statePath}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`Humanoid template execution lock already exists: ${path}`);
    throw error;
  }
  const nonce = randomUUID();
  writeFileSync(descriptor, `${JSON.stringify({ nonce, pid: process.pid, acquiredAt: nowIso() })}\n`);
  fsyncSync(descriptor);
  return { path, descriptor, nonce };
}

function releaseLock(lock) {
  closeSync(lock.descriptor);
  const current = JSON.parse(readFileSync(lock.path, 'utf8'));
  invariant(current.nonce === lock.nonce, 'Humanoid template execution lock ownership changed.');
  unlinkSync(lock.path);
}

async function mapConcurrent(items, concurrency, callback) {
  let cursor = 0;
  let failure = null;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failure) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        await callback(items[index], index);
      } catch (error) {
        failure ??= error;
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
}

export async function executeHumanoidTemplateBatch(options = {}) {
  const mode = options.mode;
  invariant(mode === 'canary' || mode === 'full', 'Execution mode must be canary or full.');
  const expectedConfirmation = mode === 'canary' ? HUMANOID_TEMPLATE_CANARY_CONFIRMATION : HUMANOID_TEMPLATE_FULL_CONFIRMATION;
  invariant(options.confirmation === expectedConfirmation, `Exact ${mode} confirmation is required.`);
  const apiKey = options.apiKey ?? '';
  invariant(apiKey, 'PIXCLI_API_KEY is required.');
  const apiBase = (options.apiBase ?? 'https://pixcli.hilo.cx').replace(/\/$/, '');
  const generatorCommitSha = options.generatorCommitSha ?? '';
  const runId = options.runId ?? '';
  invariant(/^[a-f0-9]{40}$/.test(generatorCommitSha), 'Exact generator commit SHA is required.');
  invariant(/^[1-9][0-9]*$/.test(runId), 'Exact execution run id is required.');
  const inputDirectory = resolve(options.inputDirectory);
  const outputDirectory = resolve(options.outputDirectory);
  const statePath = resolve(options.statePath);
  const lock = acquireLock(statePath);
  try {
    const { manifest, manifestSha256 } = verifyPreparedManifest(inputDirectory, options.ffmpegBinary);
    const preflight = await preflightModel(apiBase, apiKey, options.fetchImpl);
    const execution = { runId, mode, generatorCommitSha, startedAt: nowIso() };
    let state = existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, 'utf8'))
      : initialExecutionState(manifest, manifestSha256, preflight, execution);
    invariant(state.schemaVersion === 2 && state.experimentId === HUMANOID_TEMPLATE_EXPERIMENT_ID, 'Execution state belongs to another experiment.');
    invariant(state.planSha256 === manifest.planSha256 && state.manifestSha256 === manifestSha256, 'Execution state does not match the immutable input plan.');
    invariant(canonicalJson(state.model) === canonicalJson(HUMANOID_TEMPLATE_MODEL), 'Execution model contract changed.');
    invariant(state.generatorCommitSha === generatorCommitSha, 'Execution checkpoint belongs to another generator commit.');
    invariant(!state.executionRuns.some((entry) => entry.runId === runId && entry.mode === mode && entry.startedAt !== execution.startedAt), 'Execution run was already recorded.');
    if (!state.executionRuns.some((entry) => entry.runId === runId)) state.executionRuns.push(execution);

    const saveState = () => {
      state.updatedAt = nowIso();
      writeJsonAtomic(statePath, state);
    };
    const saveReference = (key, record) => {
      state.references[key] = record;
      saveState();
    };
    const saveSlot = (poseId, record) => {
      state.slots[poseId] = record;
      state.completedPoseCount = Object.values(state.slots).filter((slot) => slot.status === 'completed').length;
      saveState();
    };
    saveState();

    const poseById = new Map(manifest.uniquePoses.map((pose) => [pose.poseId, pose]));
    for (const [poseId, stored] of Object.entries(state.slots)) {
      const pose = poseById.get(poseId);
      invariant(pose, `Stored slot ${poseId} is outside the immutable pose plan.`);
      const { payload, invariants } = buildPoseExecutionContract({
        pose,
        poseAssetHash: stored.poseAssetHash,
        identityAssetHash: stored.identityAssetHash,
        manifest,
      });
      verifyStoredSlotContract(stored, invariants);
      if (stored.status === 'completed') {
        const restoredAuditErrors = validateCompletedArchive({
          archived: stored,
          active: stored,
          job: { status: stored.providerStatus, cost: stored.costMicrocredits },
          invariants,
          payload,
          apiBase,
        });
        invariant(restoredAuditErrors.length === 0, `Stored completed slot ${poseId} audit changed: ${restoredAuditErrors.join('; ')}.`);
      }
    }
    const canaryPoseIds = new Set(manifest.canary.map((entry) => entry.poseId));
    if (mode === 'full') {
      for (const poseId of canaryPoseIds) {
        invariant(state.slots[poseId]?.status === 'completed', `Full run requires completed canary pose ${poseId}.`);
      }
    }
    const selected = mode === 'canary'
      ? manifest.uniquePoses.filter((pose) => canaryPoseIds.has(pose.poseId))
      : manifest.uniquePoses.filter((pose) => state.slots[pose.poseId]?.status !== 'completed');
    invariant(mode !== 'canary' || selected.length === 5, 'Canary must contain exactly five distinct paid outputs.');
    const manuallyBlocked = selected.find((pose) => ['failed', 'submission_rejected', 'submission_outcome_unknown'].includes(state.slots[pose.poseId]?.status));
    invariant(!manuallyBlocked, `${manuallyBlocked?.poseId ?? 'Pose'} requires manual reconciliation; automatic paid continuation is forbidden.`);

    const needsNewSubmissions = selected.some((pose) => resumeActionForSlot(state.slots[pose.poseId] ?? null) === 'submit');
    const identity = manifest.canonical.identityClose;
    let identityUpload = state.references.identity ?? null;
    if (needsNewSubmissions && !uploadCanBeReused(identityUpload, identity.contentSha256)) {
      if (identityUpload && ['uploading', 'upload_outcome_unknown'].includes(identityUpload.status)) {
        throw new Error('Identity upload requires manual reconciliation.');
      }
      identityUpload = await uploadTemporaryReference({
        apiBase,
        apiKey,
        path: resolve(inputDirectory, identity.path),
        recordKey: 'identity',
        expectedSha256: identity.contentSha256,
        save: (record) => saveReference('identity', record),
        fetchImpl: options.fetchImpl,
      });
    }

    state.status = mode === 'canary' ? 'canary_running' : 'full_running';
    state.lastMode = mode;
    saveState();

    const headers = { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'insert-player-humanoid-pose-template/1.0' };
    try {
      await mapConcurrent(selected, manifest.policy.concurrency, async (pose) => {
      const previous = state.slots[pose.poseId] ?? null;
      const action = resumeActionForSlot(previous);
      if (action === 'block') throw new Error(`${pose.poseId} has an ambiguous prior submission.`);
      if (action === 'skip') return;
      let payload;
      let invariants;
      let active = previous;
      if (action === 'submit') {
        let poseUpload = state.references[pose.poseId] ?? null;
        if (!uploadCanBeReused(poseUpload, pose.contentSha256)) {
          if (poseUpload && ['uploading', 'upload_outcome_unknown'].includes(poseUpload.status)) {
            throw new Error(`${pose.poseId} upload requires manual reconciliation.`);
          }
          poseUpload = await uploadTemporaryReference({
            apiBase,
            apiKey,
            path: resolve(inputDirectory, pose.path),
            recordKey: pose.poseId,
            expectedSha256: pose.contentSha256,
            save: (record) => saveReference(pose.poseId, record),
            fetchImpl: options.fetchImpl,
          });
        }
        ({ payload, invariants } = buildPoseExecutionContract({
          pose,
          poseAssetHash: poseUpload.pixcliAssetHash,
          identityAssetHash: identityUpload.pixcliAssetHash,
          manifest,
        }));
        const submitted = await submitBakeoffSlot({
          apiBase,
          apiKey,
          payload,
          slot: previous,
          invariants,
          requestTimeoutMs: HUMANOID_TEMPLATE_SUBMISSION_TIMEOUT_MS,
          save: (record) => saveSlot(pose.poseId, record),
          fetchImpl: options.fetchImpl,
        });
        invariant(submitted.action !== 'rejected', `${pose.poseId} submission was rejected.`);
        active = submitted.slot;
      } else {
        ({ payload, invariants } = buildPoseExecutionContract({
          pose,
          poseAssetHash: previous.poseAssetHash,
          identityAssetHash: previous.identityAssetHash,
          manifest,
        }));
        verifyStoredSlotContract(previous, invariants);
      }
      const job = await pollJob({
        apiBase,
        headers,
        saveSlot: (record) => saveSlot(pose.poseId, record),
        fetchImpl: options.fetchImpl,
        sleepImpl: options.sleepImpl,
        pollIntervalMs: options.pollIntervalMs,
        jobTimeoutMs: options.jobTimeoutMs,
      }, active);
      let archived;
      try {
        archived = await archiveJob({
          apiBase,
          headers,
          outputDir: outputDirectory,
          experimentId: HUMANOID_TEMPLATE_EXPERIMENT_ID,
          fetchImpl: options.fetchImpl,
          sleepImpl: options.sleepImpl,
        }, active, job);
      } catch (error) {
        saveSlot(pose.poseId, {
          ...active,
          status: 'failed',
          providerStatus: job.status,
          costMicrocredits: Number.isFinite(job.cost) ? job.cost : null,
          terminalArchiveError: error instanceof Error ? error.message : String(error),
          completedAt: nowIso(),
          updatedAt: nowIso(),
        });
        throw error;
      }
      const archiveErrors = validateCompletedArchive({ archived, active, job, invariants, payload, apiBase });
      if (archiveErrors.length > 0) {
        saveSlot(pose.poseId, {
          ...active,
          ...archived,
          status: 'failed',
          providerStatus: job.status,
          costMicrocredits: Number.isFinite(job.cost) ? job.cost : null,
          terminalValidationErrors: archiveErrors,
          completedAt: nowIso(),
          updatedAt: nowIso(),
        });
        throw new Error(`${pose.poseId} terminal audit rejected: ${archiveErrors.join('; ')}.`);
      }
      saveSlot(pose.poseId, {
        ...active,
        ...archived,
        status: 'completed',
        providerStatus: job.status,
        costMicrocredits: job.cost,
        completedAt: nowIso(),
        updatedAt: nowIso(),
      });
      });
    } catch (error) {
      state.status = `${mode}_interrupted_manual_review_required`;
      state.lastError = error instanceof Error ? error.message : String(error);
      saveState();
      throw error;
    }

    const completed = manifest.uniquePoses.filter((pose) => state.slots[pose.poseId]?.status === 'completed');
    if (mode === 'canary') {
      invariant(completed.length === 5, `Canary completed ${completed.length} outputs instead of five.`);
      state.status = 'canary_complete_human_review_required';
    } else {
      invariant(completed.length === 94, `Full batch completed ${completed.length} outputs instead of 94.`);
      const totalCost = completed.reduce((sum, pose) => sum + state.slots[pose.poseId].costMicrocredits, 0);
      invariant(totalCost === manifest.policy.maximumTotalCostMicrocredits, 'Full batch total cost changed from $9.40.');
      state.status = 'full_complete_human_review_required';
      state.totalCostMicrocredits = totalCost;
    }
    state.completedPoseCount = completed.length;
    saveState();
    return { state, manifest };
  } finally {
    releaseLock(lock);
  }
}

function parseArg(rawArgs, name, fallback = '') {
  const prefix = `${name}=`;
  return rawArgs.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

export function parseHumanoidTemplateCliArgs(rawArgs) {
  const prepare = rawArgs.includes('--prepare');
  const execute = rawArgs.includes('--execute');
  invariant(prepare !== execute, 'Choose exactly one of --prepare or --execute.');
  const workDirectory = resolve(parseArg(rawArgs, '--work-dir', join(root, '.humanoid-template-v3-work')));
  const mode = parseArg(rawArgs, '--mode');
  if (execute) invariant(mode === 'canary' || mode === 'full', '--mode=canary or --mode=full is required.');
  return {
    prepare,
    execute,
    mode,
    confirmation: parseArg(rawArgs, '--confirm'),
    generatorCommitSha: parseArg(rawArgs, '--generator-sha', process.env.GITHUB_SHA ?? ''),
    runId: parseArg(rawArgs, '--run-id', process.env.GITHUB_RUN_ID ?? ''),
    inputDirectory: resolve(parseArg(rawArgs, '--input-dir', join(workDirectory, 'inputs'))),
    outputDirectory: resolve(parseArg(rawArgs, '--output-dir', join(workDirectory, 'outputs'))),
    statePath: resolve(parseArg(rawArgs, '--state', join(workDirectory, 'state.json'))),
    apiBase: process.env.PIXCLI_BASE_URL ?? 'https://pixcli.hilo.cx',
    apiKey: process.env.PIXCLI_API_KEY ?? '',
  };
}

async function main() {
  const options = parseHumanoidTemplateCliArgs(process.argv.slice(2));
  if (options.prepare) {
    const result = await prepareHumanoidTemplateInputs({ outputDirectory: options.inputDirectory });
    process.stdout.write(`${JSON.stringify({ status: 'prepared', manifestPath: result.manifestPath, planSha256: result.manifest.planSha256, uniquePoses: result.manifest.uniquePoses.length }, null, 2)}\n`);
    return;
  }
  const result = await executeHumanoidTemplateBatch(options);
  process.stdout.write(`${JSON.stringify({ status: result.state.status, completedPoseCount: result.state.completedPoseCount, totalCostMicrocredits: result.state.totalCostMicrocredits ?? null }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
