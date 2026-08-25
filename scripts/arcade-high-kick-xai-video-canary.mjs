import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureXaiPoseMasterUpload } from './arcade-side-xai-canary.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CANONICAL_PATH = join(
  root,
  '.artifacts/arcade-side-xai-pose-transfer-canary/arcade-side-xai-trump-pose-transfer-v2/donald-trump--grok-imagine-image-2-edit--image.png',
);
const DEFAULT_CANONICAL_UPLOAD_STATE_PATH = join(root, '.arcade-xai-trump-canonical-upload-state.json');
const DEFAULT_OUTPUT_DIR = join(root, '.artifacts/arcade-high-kick-xai-video-canary');
const DEFAULT_STATE_PATH = join(root, '.arcade-high-kick-xai-video-canary-state.json');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const REQUEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 5_000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_VIDEO_BYTES = 128 * 1024 * 1024;

export const XAI_HIGH_KICK_VIDEO_EXPERIMENT_ID = 'arcade-high-kick-xai-video-v1';
export const XAI_HIGH_KICK_VIDEO_CONFIRMATION = 'ARCADE_HIGH_KICK_XAI_VIDEO_V1';
export const XAI_HIGH_KICK_VIDEO_MODEL = Object.freeze({
  id: 'grok-imagine-i2v-pinned',
  endpoint: 'xai/grok-imagine-video/v1.5/image-to-video',
  durationSeconds: 2,
  resolution: '720p',
  estimatedProviderCostUsd: 0.29,
  pixcliReservedMicrocredits: 330_000,
  pixcliReservedUsd: 0.33,
});
export const XAI_HIGH_KICK_VIDEO_CANONICAL = Object.freeze({
  id: 'xai-trump-side-pose-transfer-v2',
  slug: 'canonical-trump-xai-side-v2',
  contentSha256: '9429960a62d833e1899d8572efde3f7df2cceb88ff1510b3c146e8489bf7f2c0',
});
export const XAI_HIGH_KICK_VIDEO_PLAYBACK = Object.freeze([0, 1, 2, 3, 2, 1, 0]);

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

function parseArg(rawArgs, name, fallback = '') {
  return rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.writing-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function acquireExclusiveRunLock(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, acquiredAt: nowIso() })}\n`);
    closeSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      throw new Error(`Video canary is already locked: ${path}. Reconcile the owner before removing the lock.`);
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unlinkSync(path);
  };
}

function responseBodyHash(text) {
  return text ? sha256(text) : null;
}

async function parseJsonResponse(response, label) {
  const text = await response.text();
  try {
    return { body: text ? JSON.parse(text) : {}, text };
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status} (${responseBodyHash(text)}).`);
  }
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function ensureCanonical(path, descriptor = XAI_HIGH_KICK_VIDEO_CANONICAL) {
  if (!existsSync(path)) throw new Error(`Approved Trump canonical is missing: ${path}.`);
  const bytes = readFileSync(path);
  if (
    bytes.byteLength < PNG_SIGNATURE.byteLength
    || bytes.byteLength > 12 * 1024 * 1024
    || !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
  ) {
    throw new Error('Approved Trump canonical must be a bounded PNG.');
  }
  const contentSha256 = sha256(bytes);
  if (contentSha256 !== descriptor.contentSha256) {
    throw new Error(`Approved Trump canonical hash mismatch: ${contentSha256}.`);
  }
  return { bytes, contentSha256 };
}

function ensureMp4(path) {
  if (!existsSync(path)) throw new Error(`Video artifact is missing: ${path}.`);
  const sizeBytes = statSync(path).size;
  if (sizeBytes < 12 || sizeBytes > MAX_VIDEO_BYTES) throw new Error('Video artifact has an invalid size.');
  const prefix = readFileSync(path).subarray(0, 12);
  if (prefix.subarray(4, 8).toString('ascii') !== 'ftyp') {
    throw new Error('Video artifact is not an MP4 container.');
  }
  return { sizeBytes, contentSha256: sha256(readFileSync(path)) };
}

export function buildXaiHighKickVideoPrompt() {
  return [
    'Create one continuous two-second fighting-game animation from IMAGE 1, which is the approved character and visual identity master.',
    'This clip is frame material for a HIGH_KICK sprite, not a cinematic shot.',
    'Start in the exact supplied ready stance, then progress monotonically through wind-up, compact knee chamber, extension, and a fully extended high-kick impact on the final frame.',
    'Do not retract the kick or return to idle; the final frame must be the strongest impact pose.',
    'Keep the planted foot fixed on one floor line and keep the torso balance physically plausible.',
    'Preserve the exact same recognizable face, age, swept blond hair, navy suit, light-blue tie, body proportions, fabric texture, material finish, lighting, camera distance, and viewer-right facing direction from IMAGE 1.',
    'Exactly one connected adult fighter throughout. Do not introduce or duplicate limbs, hands, feet, heads, people, props, trails, afterimages, or detached anatomy. Preserve natural occlusions.',
    'Fixed locked camera, full body always visible with margin, no crop, no zoom, no pan, no cut, no camera shake, and no change of scale or perspective.',
    'Perfectly flat uniform pure #00FF00 background throughout, with no floor, shadow, grid, text, scenery, particles, motion blur, or audio-dependent action.',
  ].join(' ');
}

export function buildXaiHighKickVideoPayload(assetHash, options = {}) {
  if (!/^[a-f0-9]{32}$/.test(assetHash ?? '')) throw new Error('PixCLI canonical asset hash is invalid.');
  const model = options.model ?? XAI_HIGH_KICK_VIDEO_MODEL;
  const prompt = options.prompt ?? buildXaiHighKickVideoPrompt();
  return {
    prompt,
    model: model.id,
    image: assetHash,
    resolution: model.resolution,
    params: {
      duration: model.durationSeconds,
      resolution: model.resolution,
    },
    enrich_prompt: false,
    output_format: 'url',
    publish: false,
    publish_name: 'ip-trump-high-kick-xai-video-v1',
  };
}

export function buildXaiHighKickVideoPlan(options = {}) {
  const model = options.model ?? XAI_HIGH_KICK_VIDEO_MODEL;
  const canonical = options.canonical ?? XAI_HIGH_KICK_VIDEO_CANONICAL;
  const prompt = options.prompt ?? buildXaiHighKickVideoPrompt();
  return {
    schemaVersion: 1,
    experimentId: XAI_HIGH_KICK_VIDEO_EXPERIMENT_ID,
    fighter: 'donald-trump',
    action: 'high_kick',
    canonical,
    model,
    prompt,
    promptSha256: sha256(prompt),
    extraction: {
      sampleFps: 8,
      uniqueFrames: 4,
      frameSources: ['canonical-derived', 'video@33%', 'video@67%', 'video@92%'],
      playback: [...XAI_HIGH_KICK_VIDEO_PLAYBACK],
      normalizedCell: { width: 768, height: 1024 },
      runtimeCell: { width: 192, height: 256 },
    },
    policy: {
      expectedPaidCalls: 1,
      providerRetries: 0,
      fallback: 'none',
      promptEnrichment: false,
      activation: false,
      productionPointers: false,
    },
  };
}

export function selectFrameIndices(frameCount, uniqueCount = 4) {
  if (!Number.isSafeInteger(frameCount) || frameCount < uniqueCount || uniqueCount < 2) {
    throw new Error(`Cannot select ${uniqueCount} unique frames from ${frameCount}.`);
  }
  const indices = Array.from({ length: uniqueCount }, (_, index) => (
    Math.round(((frameCount - 1) * index) / (uniqueCount - 1))
  ));
  if (new Set(indices).size !== uniqueCount) throw new Error('Deterministic frame selection produced duplicates.');
  return indices;
}

export function selectMotionFrameIndices(frameCount) {
  if (!Number.isSafeInteger(frameCount) || frameCount < 4) {
    throw new Error(`Cannot select three motion frames from ${frameCount}.`);
  }
  const last = frameCount - 1;
  const indices = [0.33, 0.67, 0.92].map((fraction) => Math.round(last * fraction));
  if (new Set(indices).size !== indices.length) {
    throw new Error('Deterministic motion-frame selection produced duplicates.');
  }
  return indices;
}

export function validateMotionFrameIndices(indices, frameCount) {
  if (
    !Array.isArray(indices)
    || indices.length !== 3
    || indices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= frameCount)
    || indices.some((index, position) => position > 0 && index <= indices[position - 1])
  ) {
    throw new Error('Motion-frame selection must contain three strictly ascending in-range indexes.');
  }
  return [...indices];
}

function systemCommand(binary, args) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${basename(binary)} failed (${result.status}): ${(result.stderr ?? '').trim().slice(-1200)}`);
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runMediaCommand(runCommand, binary, args) {
  return runCommand(binary, args);
}

function imageFiles(path, prefix) {
  return readdirSync(path)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.png'))
    .sort()
    .map((name) => join(path, name));
}

export function clearGeneratedFrames(path) {
  for (const name of readdirSync(path)) {
    if (/^frame-\d+\.png$/.test(name)) unlinkSync(join(path, name));
  }
}

function hashArtifact(path) {
  const bytes = readFileSync(path);
  return {
    path: relative(root, path),
    contentSha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
  };
}

function ffmpegStillArgs(inputPath, outputPath, filter) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-vf', filter,
    '-frames:v', '1',
    outputPath,
  ];
}

export function extractXaiVideoFrames(options) {
  const videoPath = resolve(options.videoPath);
  const canonicalPath = resolve(options.canonicalPath);
  const outputDir = resolve(options.outputDir);
  const sampleFps = options.sampleFps ?? 8;
  const uniqueCount = 4;
  const ffmpegBin = options.ffmpegBin ?? 'ffmpeg';
  const ffprobeBin = options.ffprobeBin ?? 'ffprobe';
  const runCommand = options.runCommand ?? systemCommand;
  if (!Number.isSafeInteger(sampleFps) || sampleFps < 1 || sampleFps > 30) {
    throw new Error('sampleFps must be an integer from 1 to 30.');
  }
  const video = ensureMp4(videoPath);
  const canonical = ensureCanonical(
    canonicalPath,
    options.canonical ?? XAI_HIGH_KICK_VIDEO_CANONICAL,
  );
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const rawDir = join(outputDir, 'raw-frames');
  const uniqueDir = join(outputDir, 'unique-frames');
  const playbackDir = join(outputDir, 'playback-frames');
  mkdirSync(rawDir, { recursive: true, mode: 0o700 });
  mkdirSync(uniqueDir, { recursive: true, mode: 0o700 });
  mkdirSync(playbackDir, { recursive: true, mode: 0o700 });
  clearGeneratedFrames(rawDir);
  clearGeneratedFrames(uniqueDir);
  clearGeneratedFrames(playbackDir);
  const canonicalInputPath = join(outputDir, 'canonical-input.png');
  copyFileSync(canonicalPath, canonicalInputPath);
  chmodSync(canonicalInputPath, 0o600);

  const probeResult = runMediaCommand(runCommand, ffprobeBin, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames:format=duration,size',
    '-of', 'json',
    videoPath,
  ]);
  let probe;
  try {
    probe = JSON.parse(probeResult.stdout);
  } catch {
    throw new Error('ffprobe did not return valid JSON.');
  }
  const stream = probe?.streams?.[0];
  if (!stream || !Number.isSafeInteger(stream.width) || !Number.isSafeInteger(stream.height)) {
    throw new Error('ffprobe found no valid video stream.');
  }

  runMediaCommand(runCommand, ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoPath,
    '-vf', `fps=${sampleFps}`,
    '-fps_mode', 'vfr',
    join(rawDir, 'frame-%03d.png'),
  ]);
  const rawFrames = imageFiles(rawDir, 'frame-');
  const selectedIndices = options.selectedIndices
    ? validateMotionFrameIndices(options.selectedIndices, rawFrames.length)
    : selectMotionFrameIndices(rawFrames.length);
  const normalizeFilter = [
    'chromakey=0x00FF00:0.20:0.08',
    'format=rgba',
    'scale=768:1024:force_original_aspect_ratio=decrease:flags=lanczos',
    'pad=768:1024:(ow-iw)/2:oh-ih:color=0x00000000',
  ].join(',');
  const uniqueSources = [canonicalPath, ...selectedIndices.map((sourceIndex) => rawFrames[sourceIndex])];
  const uniqueFrames = uniqueSources.map((sourcePath, uniqueIndex) => {
    const outputPath = join(uniqueDir, `frame-${String(uniqueIndex + 1).padStart(3, '0')}.png`);
    runMediaCommand(runCommand, ffmpegBin, ffmpegStillArgs(sourcePath, outputPath, normalizeFilter));
    return outputPath;
  });

  const playbackFrames = XAI_HIGH_KICK_VIDEO_PLAYBACK.map((uniqueIndex, playbackIndex) => {
    const outputPath = join(playbackDir, `frame-${String(playbackIndex + 1).padStart(3, '0')}.png`);
    copyFileSync(uniqueFrames[uniqueIndex], outputPath);
    chmodSync(outputPath, 0o600);
    return outputPath;
  });

  const contactColumns = Math.min(4, rawFrames.length);
  const contactRows = Math.ceil(rawFrames.length / contactColumns);
  const contactSheetPath = join(outputDir, 'all-frames-contact-sheet.png');
  runMediaCommand(runCommand, ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', String(sampleFps),
    '-i', join(rawDir, 'frame-%03d.png'),
    '-vf', `scale=240:-2:flags=lanczos,tile=${contactColumns}x${contactRows}:padding=4:margin=4:color=black`,
    '-frames:v', '1',
    contactSheetPath,
  ]);
  const uniqueSheetPath = join(outputDir, 'unique-frames-sheet.png');
  runMediaCommand(runCommand, ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', '1',
    '-i', join(uniqueDir, 'frame-%03d.png'),
    '-vf', `tile=${uniqueCount}x1:padding=0:margin=0:color=0x00000000`,
    '-frames:v', '1',
    uniqueSheetPath,
  ]);
  const playbackSheetPath = join(outputDir, 'playback-sheet-768x1024.png');
  runMediaCommand(runCommand, ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', '1',
    '-i', join(playbackDir, 'frame-%03d.png'),
    '-vf', `tile=${playbackFrames.length}x1:padding=0:margin=0:color=0x00000000`,
    '-frames:v', '1',
    playbackSheetPath,
  ]);
  const runtimeSheetPath = join(outputDir, 'playback-sheet-192x256.png');
  runMediaCommand(runCommand, ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', '1',
    '-i', join(playbackDir, 'frame-%03d.png'),
    '-vf', `scale=192:256:flags=lanczos,tile=${playbackFrames.length}x1:padding=0:margin=0:color=0x00000000`,
    '-frames:v', '1',
    runtimeSheetPath,
  ]);

  const report = {
    schemaVersion: 1,
    generatedAt: nowIso(),
    sourceVideo: { path: relative(root, videoPath), ...video },
    canonical: {
      sourcePath: relative(root, canonicalPath),
      archivedInput: hashArtifact(canonicalInputPath),
      ...canonical,
    },
    probe,
    sampleFps,
    rawFrameCount: rawFrames.length,
    canonicalDerivedF0: true,
    selectedIndices,
    playback: [...XAI_HIGH_KICK_VIDEO_PLAYBACK],
    rawFrames: rawFrames.map(hashArtifact),
    uniqueFrames: uniqueFrames.map(hashArtifact),
    playbackFrames: playbackFrames.map(hashArtifact),
    artifacts: {
      contactSheet: hashArtifact(contactSheetPath),
      uniqueSheet: hashArtifact(uniqueSheetPath),
      playbackSheet: hashArtifact(playbackSheetPath),
      runtimeSheet: hashArtifact(runtimeSheetPath),
    },
  };
  writeJsonAtomic(join(outputDir, 'extraction-report.json'), report);
  return report;
}

function artifactKind(asset) {
  const kind = asset?.metadata?.artifact_kind;
  if (kind === 'provider_request' || kind === 'provider_response') return kind;
  if (String(asset?.mime_type ?? '').startsWith('video/')) return 'video';
  return null;
}

function artifactExtension(asset, kind) {
  if (asset.mime_type === 'application/json') return 'json';
  if (asset.mime_type === 'video/mp4') return 'mp4';
  return kind === 'video' ? 'mp4' : 'dat';
}

export function validatePinnedVideoAudit(canva) {
  const providerRuns = Array.isArray(canva?.provider_runs) ? canva.provider_runs : [];
  if (providerRuns.length !== 1) {
    throw new Error(`PixCLI video audit expected exactly one provider run, received ${providerRuns.length}.`);
  }
  const [providerRun] = providerRuns;
  const providerRequestId = providerRun.requestId ?? providerRun.request_id;
  if (
    providerRun.provider !== 'fal'
    || (providerRun.modelId ?? providerRun.model_id) !== XAI_HIGH_KICK_VIDEO_MODEL.id
    || typeof providerRequestId !== 'string'
    || !providerRequestId
  ) {
    throw new Error('PixCLI video audit detected an unexpected provider, model, or request id.');
  }
  const assets = Array.isArray(canva.assets) ? canva.assets : [];
  const selected = new Map();
  for (const asset of assets) {
    const kind = artifactKind(asset);
    if (!kind) continue;
    if (selected.has(kind)) throw new Error(`PixCLI video audit contains duplicate ${kind} artifacts.`);
    selected.set(kind, asset);
  }
  for (const kind of ['provider_request', 'provider_response', 'video']) {
    if (!selected.has(kind)) throw new Error(`PixCLI video audit is missing ${kind}.`);
  }
  if (selected.get('provider_request')?.metadata?.model !== XAI_HIGH_KICK_VIDEO_MODEL.id) {
    throw new Error('PixCLI provider request audit does not match the pinned model.');
  }
  if (
    selected.get('provider_response')?.metadata?.model !== XAI_HIGH_KICK_VIDEO_MODEL.id
    || selected.get('provider_response')?.metadata?.provider_request_id !== providerRequestId
  ) {
    throw new Error('PixCLI provider response audit does not match the sole provider run.');
  }
  if (
    selected.get('video')?.metadata?.model !== XAI_HIGH_KICK_VIDEO_MODEL.id
    || selected.get('video')?.metadata?.provider_request_id !== providerRequestId
  ) {
    throw new Error('PixCLI video artifact does not match the sole pinned provider run.');
  }
  return { providerRuns, providerRequestId, selected };
}

export function validatePinnedProviderRequestAudit(value, options = {}) {
  const expectedPrompt = options.expectedPrompt ?? buildXaiHighKickVideoPrompt();
  const expectedAssetHash = options.expectedAssetHash;
  if (!/^[a-f0-9]{32}$/.test(expectedAssetHash ?? '')) {
    throw new Error('PixCLI provider request audit requires the exact canonical asset hash.');
  }
  const expectedOrigin = new URL(options.expectedApiBase).origin;
  const input = value?.input;
  const inputKeys = input && typeof input === 'object' && !Array.isArray(input)
    ? Object.keys(input).sort()
    : [];
  let imageUrl;
  try {
    imageUrl = new URL(input?.image_url);
  } catch {
    throw new Error('PixCLI provider request audit has an invalid image_url.');
  }
  if (
    value?.model !== XAI_HIGH_KICK_VIDEO_MODEL.endpoint
    || value?.retry_policy !== 'none'
    || value?.fallback_policy !== 'none'
    || input?.prompt !== expectedPrompt
    || input?.duration !== XAI_HIGH_KICK_VIDEO_MODEL.durationSeconds
    || input?.resolution !== XAI_HIGH_KICK_VIDEO_MODEL.resolution
    || imageUrl.protocol !== 'https:'
    || imageUrl.origin !== expectedOrigin
    || imageUrl.pathname !== `/api/v1/assets/${expectedAssetHash}`
    || canonicalJson(inputKeys) !== canonicalJson(['duration', 'image_url', 'prompt', 'resolution'])
  ) {
    throw new Error('PixCLI provider request audit does not match the sealed Grok I2V payload.');
  }
  return value;
}

async function downloadArtifact(asset, outputPath, headers, fetchImpl) {
  const response = await fetchImpl(asset.url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`PixCLI artifact download failed with HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentSha256 = sha256(bytes);
  if (asset?.metadata?.content_sha256 && asset.metadata.content_sha256 !== contentSha256) {
    throw new Error(`PixCLI artifact hash mismatch for ${basename(outputPath)}.`);
  }
  if (asset.mime_type === 'application/json') JSON.parse(bytes.toString('utf8'));
  writeFileSync(outputPath, bytes, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
  return { path: relative(root, outputPath), contentSha256, sizeBytes: bytes.byteLength };
}

async function readJob(options, jobId) {
  const response = await options.fetchImpl(
    `${options.apiBase}/api/v1/jobs/${encodeURIComponent(jobId)}`,
    { headers: options.headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  const { body } = await parseJsonResponse(response, 'PixCLI job poll');
  if (!response.ok) throw new Error(`PixCLI job poll failed with HTTP ${response.status}.`);
  return body;
}

async function pollVideoJob(options, state, saveState) {
  const deadline = Date.now() + (options.jobTimeoutMs ?? JOB_TIMEOUT_MS);
  while (Date.now() < deadline) {
    let job;
    try {
      job = await readJob(options, state.pixcliJobId);
    } catch (error) {
      state.status = 'processing';
      state.lastPollError = error instanceof Error ? error.message : String(error);
      state.updatedAt = nowIso();
      saveState(state);
      await (options.sleepImpl ?? sleep)(options.pollIntervalMs ?? POLL_INTERVAL_MS);
      continue;
    }
    if (job.status === 'completed' || job.status === 'completed_with_fallback' || job.status === 'failed') {
      return job;
    }
    state.status = 'processing';
    state.providerStatus = job.status;
    state.updatedAt = nowIso();
    saveState(state);
    await (options.sleepImpl ?? sleep)(options.pollIntervalMs ?? POLL_INTERVAL_MS);
  }
  throw new Error(`PixCLI video job timed out without resubmission: ${state.pixcliJobId}.`);
}

async function archiveVideoJob(options, state, job) {
  const response = await options.fetchImpl(
    `${options.apiBase}/api/v1/jobs/${encodeURIComponent(state.pixcliJobId)}/canva`,
    { headers: options.headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  const { body: canva } = await parseJsonResponse(response, 'PixCLI video audit');
  if (!response.ok) throw new Error(`PixCLI video audit failed with HTTP ${response.status}.`);
  const { providerRuns, selected } = validatePinnedVideoAudit(canva);
  const runDir = join(options.outputDir, XAI_HIGH_KICK_VIDEO_EXPERIMENT_ID);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const artifacts = {};
  for (const kind of ['provider_request', 'provider_response', 'video']) {
    const asset = selected.get(kind);
    const outputPath = join(runDir, `donald-trump--high-kick--${kind}.${artifactExtension(asset, kind)}`);
    artifacts[kind] = {
      ...(await downloadArtifact(asset, outputPath, options.headers, options.fetchImpl)),
      pixcliAssetHash: asset.hash,
      mimeType: asset.mime_type,
      providerRequestId: asset?.metadata?.provider_request_id ?? null,
    };
  }
  const providerRequestAudit = JSON.parse(
    readFileSync(resolve(root, artifacts.provider_request.path), 'utf8'),
  );
  validatePinnedProviderRequestAudit(providerRequestAudit, {
    expectedPrompt: options.expectedPrompt,
    expectedAssetHash: options.expectedAssetHash,
    expectedApiBase: options.apiBase,
  });
  return {
    artifacts,
    providerRuns,
    providerRequestAuditSha256: artifacts.provider_request.contentSha256,
    pixcliCostEstimate: canva?.job?.cost ?? job.cost ?? null,
    pixcliInputSha256: sha256(canonicalJson(canva.input ?? null)),
  };
}

function initialState(plan, payload, canonicalPath) {
  return {
    schemaVersion: 1,
    experimentId: plan.experimentId,
    status: 'planned',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    canonicalPath: relative(root, canonicalPath),
    canonicalSha256: plan.canonical.contentSha256,
    modelId: plan.model.id,
    providerEndpoint: plan.model.endpoint,
    promptSha256: plan.promptSha256,
    requestSha256: sha256(canonicalJson(payload)),
    policy: plan.policy,
  };
}

function assertStateInvariant(state, expected) {
  for (const key of [
    'schemaVersion', 'experimentId', 'canonicalSha256', 'modelId',
    'providerEndpoint', 'promptSha256', 'requestSha256',
  ]) {
    if (state[key] !== expected[key]) throw new Error(`Video canary state mismatch: ${key}.`);
  }
}

async function runXaiHighKickVideoCanaryLocked(options = {}) {
  const apiKey = options.apiKey ?? '';
  if (!apiKey) throw new Error('PIXCLI_API_KEY is required.');
  const apiBase = (options.apiBase ?? 'https://pixcli.hilo.cx').replace(/\/$/, '');
  const canonicalPath = resolve(options.canonicalPath ?? DEFAULT_CANONICAL_PATH);
  const canonical = options.canonical ?? XAI_HIGH_KICK_VIDEO_CANONICAL;
  ensureCanonical(canonicalPath, canonical);
  const plan = buildXaiHighKickVideoPlan({ canonical });
  const ensureUpload = options.ensureUploadImpl ?? ensureXaiPoseMasterUpload;
  const uploaded = await ensureUpload({
    apiBase,
    apiKey,
    poseMaster: canonical,
    poseMasterPath: canonicalPath,
    poseMasterUploadStatePath: options.canonicalUploadStatePath ?? DEFAULT_CANONICAL_UPLOAD_STATE_PATH,
    fetchImpl: options.fetchImpl,
  });
  if (!/^[a-f0-9]{32}$/.test(uploaded?.pixcliAssetHash ?? '')) {
    throw new Error('Approved Trump canonical upload is not reconciled.');
  }
  const payload = buildXaiHighKickVideoPayload(uploaded.pixcliAssetHash);
  const statePath = resolve(options.statePath ?? DEFAULT_STATE_PATH);
  const outputDir = resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
  const expected = initialState(plan, payload, canonicalPath);
  let state = readJson(statePath) ?? expected;
  assertStateInvariant(state, expected);
  const saveState = (next) => {
    state = { ...next, updatedAt: nowIso() };
    writeJsonAtomic(statePath, state);
  };
  saveState(state);

  if (state.status === 'submitting' || state.status === 'submission_outcome_unknown') {
    throw new Error('Prior video submission outcome is ambiguous; automatic retry is forbidden.');
  }
  if (state.status === 'submission_rejected' || state.status === 'failed') return state;
  if (state.status === 'completed' && state.extraction) return state;

  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': 'insert-player-arcade-xai-video-canary/1.0',
  };
  const runtime = {
    apiBase,
    headers,
    fetchImpl,
    sleepImpl: options.sleepImpl,
    pollIntervalMs: options.pollIntervalMs,
    jobTimeoutMs: options.jobTimeoutMs,
    outputDir,
    expectedPrompt: plan.prompt,
    expectedAssetHash: uploaded.pixcliAssetHash,
  };

  if (state.status === 'planned') {
    saveState({ ...state, status: 'submitting', submissionStartedAt: nowIso() });
    let response;
    try {
      response = await fetchImpl(`${apiBase}/api/v1/video/advanced`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      saveState({
        ...state,
        status: 'submission_outcome_unknown',
        submissionError: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Video submission outcome is unknown; automatic retry is forbidden.');
    }
    let parsed;
    try {
      parsed = await parseJsonResponse(response, 'PixCLI video submit');
    } catch (error) {
      const definitive = response.status >= 400 && response.status < 500;
      saveState({
        ...state,
        status: definitive ? 'submission_rejected' : 'submission_outcome_unknown',
        submissionHttpStatus: response.status,
        submissionError: error instanceof Error ? error.message : String(error),
      });
      if (!definitive) throw new Error('Video submission outcome is unknown; automatic retry is forbidden.');
      return state;
    }
    const { body, text } = parsed;
    if (response.status !== 202 || typeof body.job_id !== 'string' || !body.job_id) {
      const definitive = response.status >= 400 && response.status < 500;
      saveState({
        ...state,
        status: definitive ? 'submission_rejected' : 'submission_outcome_unknown',
        submissionHttpStatus: response.status,
        submissionResponseSha256: responseBodyHash(text),
        submissionError: typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
      });
      if (!definitive) throw new Error('Video submission outcome is unknown; automatic retry is forbidden.');
      return state;
    }
    saveState({
      ...state,
      status: 'submitted',
      pixcliJobId: body.job_id,
      deduplicated: body.deduplicated === true,
      submittedAt: nowIso(),
    });
  }

  const job = await pollVideoJob(runtime, state, saveState);
  if (job.status === 'completed_with_fallback') {
    saveState({ ...state, status: 'failed', providerStatus: job.status, providerError: 'fallback_detected' });
    throw new Error('PixCLI completed the pinned Grok canary with a forbidden fallback.');
  }
  if (job.status === 'failed') {
    saveState({ ...state, status: 'failed', providerStatus: job.status, providerError: job.error ?? null });
    return state;
  }
  const archived = await archiveVideoJob(runtime, state, job);
  const videoPath = resolve(root, archived.artifacts.video.path);
  const extractVideo = options.extractVideoImpl ?? extractXaiVideoFrames;
  const extractionDir = join(outputDir, XAI_HIGH_KICK_VIDEO_EXPERIMENT_ID, 'extracted');
  const extraction = await extractVideo({
    videoPath,
    canonicalPath,
    canonical,
    outputDir: extractionDir,
    ffmpegBin: options.ffmpegBin,
    ffprobeBin: options.ffprobeBin,
    runCommand: options.runCommand,
    selectedIndices: options.selectedIndices,
  });
  saveState({
    ...state,
    ...archived,
    status: 'completed',
    providerStatus: job.status,
    extraction,
    completedAt: nowIso(),
  });
  return state;
}

export async function runXaiHighKickVideoCanary(options = {}) {
  const statePath = resolve(options.statePath ?? DEFAULT_STATE_PATH);
  const release = acquireExclusiveRunLock(`${statePath}.lock`);
  try {
    return await runXaiHighKickVideoCanaryLocked({ ...options, statePath });
  } finally {
    release();
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const outputDir = parseArg(rawArgs, '--output-dir', DEFAULT_OUTPUT_DIR);
  if (rawArgs.includes('--extract')) {
    const videoPath = parseArg(rawArgs, '--video');
    if (!videoPath) throw new Error('Local extraction requires --video=/absolute/path.mp4.');
    const canonicalPath = parseArg(rawArgs, '--canonical', DEFAULT_CANONICAL_PATH);
    const selection = parseArg(rawArgs, '--select');
    const selectedIndices = selection
      ? selection.split(',').map((value) => Number(value))
      : undefined;
    const report = extractXaiVideoFrames({
      videoPath,
      canonicalPath,
      outputDir: join(outputDir, XAI_HIGH_KICK_VIDEO_EXPERIMENT_ID, 'extracted'),
      ffmpegBin: parseArg(rawArgs, '--ffmpeg', 'ffmpeg'),
      ffprobeBin: parseArg(rawArgs, '--ffprobe', 'ffprobe'),
      selectedIndices,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!rawArgs.includes('--execute')) {
    console.log(JSON.stringify(buildXaiHighKickVideoPlan(), null, 2));
    return;
  }
  const confirmation = parseArg(rawArgs, '--confirm');
  if (confirmation !== XAI_HIGH_KICK_VIDEO_CONFIRMATION) {
    throw new Error(`Paid execution requires --confirm=${XAI_HIGH_KICK_VIDEO_CONFIRMATION}.`);
  }
  const state = await runXaiHighKickVideoCanary({
    apiKey: process.env.PIXCLI_API_KEY,
    apiBase: process.env.PIXCLI_BASE_URL,
    canonicalPath: parseArg(rawArgs, '--canonical', DEFAULT_CANONICAL_PATH),
    canonicalUploadStatePath: parseArg(
      rawArgs,
      '--canonical-upload-state',
      DEFAULT_CANONICAL_UPLOAD_STATE_PATH,
    ),
    statePath: parseArg(rawArgs, '--state', DEFAULT_STATE_PATH),
    outputDir,
    ffmpegBin: parseArg(rawArgs, '--ffmpeg', 'ffmpeg'),
    ffprobeBin: parseArg(rawArgs, '--ffprobe', 'ffprobe'),
  });
  console.log(`XAI HIGH_KICK video canary terminal: ${state.status}.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
