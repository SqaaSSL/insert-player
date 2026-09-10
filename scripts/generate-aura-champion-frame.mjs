import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputRoot = join(
  repositoryRoot,
  'artifacts/aura-animation-canary/donald-trump/aura_six_seven/champion',
);
const templateRoot = join(
  repositoryRoot,
  'artifacts/aura-animation-canary/template-zero/aura_six_seven/keyframes',
);
const referenceRepository = resolve(
  process.env.INSERT_PLAYER_REFERENCE_REPO || join(repositoryRoot, '../AI Street Fighter/ai-street-fighter'),
);
const anchorRoot = join(
  referenceRepository,
  '.local/template-zero-provider-sweep/trump-full-template-v1/inputs/anchors',
);
const statePath = join(outputRoot, 'generation-state.json');
const confirmation = 'GENERATE_AURA_TRUMP_CHAMPION_FRAME';
const endpoint = 'xai/grok-imagine-image/v2.0/edit';
const queueEndpoint = `https://queue.fal.run/${endpoint}`;
const width = 1536;
const height = 2048;
const green = '#00FF00';

const frameDefinitions = Object.freeze({
  previous01: Object.freeze({
    source: 'previous-01.png',
    phase: 'SIX-SEVEN TRANSITION FRAME 1: preserve the exact compact two-palm transition pose, planted stance, torso angle, hand heights and hand orientation from IMAGE 1.',
  }),
  leftHandHigh: Object.freeze({
    source: 'left-hand-high.png',
    phase: "SIX-SEVEN LEFT-HAND-HIGH EXTREME: preserve IMAGE 1 exactly. The subject's anatomical LEFT hand is high on image-right and the anatomical RIGHT hand is low on image-left; do not swap, flatten or equalize their heights.",
  }),
  previous03: Object.freeze({
    source: 'previous-03.png',
    phase: 'SIX-SEVEN TRANSITION FRAME 3: preserve the exact compact two-palm transition pose, planted stance, torso angle, hand heights and hand orientation from IMAGE 1.',
  }),
  rightHandHigh: Object.freeze({
    source: 'right-hand-high.png',
    phase: "SIX-SEVEN RIGHT-HAND-HIGH EXTREME: preserve IMAGE 1 exactly. The subject's anatomical RIGHT hand is high on image-left and the anatomical LEFT hand is low on image-right; do not swap, flatten or equalize their heights.",
  }),
  previous05: Object.freeze({
    source: 'previous-05.png',
    phase: 'SIX-SEVEN TRANSITION FRAME 5: preserve the exact compact two-palm transition pose, planted stance, torso angle, hand heights and hand orientation from IMAGE 1.',
  }),
  previous07: Object.freeze({
    source: 'previous-07.png',
    phase: 'SIX-SEVEN TRANSITION FRAME 7: preserve the exact compact two-palm transition pose, planted stance, torso angle, hand heights and hand orientation from IMAGE 1.',
  }),
});

const anchorDefinitions = Object.freeze({
  canonical: Object.freeze({
    fileName: 'trump-canonical.png',
    sha256: '10a1f057097edec2c770f033d50d06b5cf8e2bd08d0320df9640366e24a00d54',
  }),
  original: Object.freeze({
    fileName: 'trump-original.png',
    sha256: 'af76d813828ebd4d56b1b18b44de3f850f3c7968022aafab2ece6514d15829fc',
  }),
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArg(name, fallback = '') {
  return process.argv.find((argument) => argument.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? fallback;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function portablePath(path) {
  const absolutePath = resolve(path);
  if (absolutePath.startsWith(`${repositoryRoot}/`)) {
    return absolutePath.slice(repositoryRoot.length + 1);
  }
  if (absolutePath.startsWith(`${referenceRepository}/`)) {
    return `reference-repo:${absolutePath.slice(referenceRepository.length + 1)}`;
  }
  throw new Error(`Refusing to persist an unscoped absolute path: ${absolutePath}`);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function nowIso() {
  return new Date().toISOString();
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.writing-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function readState() {
  if (!existsSync(statePath)) {
    return {
      schemaVersion: 1,
      experimentId: 'donald-trump-aura-six-seven-champion-v1',
      endpoint,
      modelId: 'grok-imagine-image-2-edit',
      provider: 'fal',
      costPerCompletedFrameMicrocredits: 110_000,
      createdAt: nowIso(),
      uploads: {},
      frames: {},
    };
  }
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function runMagick(args, options = {}) {
  const result = spawnSync('magick', args, {
    encoding: options.binary ? null : 'utf8',
    env: { ...process.env, MAGICK_THREAD_LIMIT: '1' },
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${options.label || 'ImageMagick'} failed: ${(result.stderr || result.stdout || '').toString().trim()}`);
  }
  return result.stdout;
}

function pngDimensions(bytes, label) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  invariant(bytes.length >= 29 && bytes.subarray(0, 8).equals(signature), `${label} is not a PNG.`);
  invariant(bytes.subarray(12, 16).toString('ascii') === 'IHDR', `${label} has no PNG IHDR.`);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorTypeCode: bytes[25],
  };
}

function normalizePose(sourcePath, outputPath, preparation) {
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const sourcePreparation = preparation === 'flat-green'
    ? [
      sourcePath,
      '(',
      '+clone',
      '-fx', 'g > 0.45 && g > r * 1.35 && g > b * 1.35 ? 0 : 1',
      ')',
      '-alpha', 'off',
      '-compose', 'CopyOpacity',
      '-composite',
    ]
    : [sourcePath];
  invariant(
    preparation === 'source-background' || preparation === 'flat-green',
    `Unknown --pose-preparation=${preparation}.`,
  );
  runMagick([
    ...sourcePreparation,
    '-background', green,
    '-alpha', 'background',
    '-alpha', 'off',
    '-filter', 'Lanczos',
    '-resize', `${width}x${height}!`,
    '-depth', '8',
    '-strip',
    '-define', 'png:compression-level=9',
    `PNG24:${outputPath}`,
  ], { label: 'pose normalization' });
  const dimensions = pngDimensions(readFileSync(outputPath), 'normalized pose');
  invariant(
    dimensions.width === width
      && dimensions.height === height
      && dimensions.bitDepth === 8
      && dimensions.colorTypeCode === 2,
    'Normalized pose is not RGB8 1536x2048.',
  );
}

function foregroundGeometry(path) {
  const pixels = runMagick([
    path,
    '-alpha', 'off',
    '-depth', '8',
    'RGB:-',
  ], { binary: true, label: 'RGB extraction', maxBuffer: width * height * 3 + 1024 });
  invariant(pixels.length === width * height * 3, `Unexpected RGB byte count: ${pixels.length}.`);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let foregroundPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      if (green > 115 && green > red * 1.35 && green > blue * 1.35) continue;
      foregroundPixels += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  invariant(foregroundPixels > 0, 'Pose has no foreground pixels.');
  const bboxHeight = maxY - minY + 1;
  const rootBandHeight = Math.max(3, Math.round(bboxHeight * 0.01));
  const rootBandStart = Math.max(minY, maxY - rootBandHeight + 1);
  let rootXSum = 0;
  let rootPixels = 0;
  for (let y = rootBandStart; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const index = (y * width + x) * 3;
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      if (green > 115 && green > red * 1.35 && green > blue * 1.35) continue;
      rootXSum += x + 0.5;
      rootPixels += 1;
    }
  }
  invariant(rootPixels > 0, 'Pose has no root-band foreground.');
  const bounds = {
    left: minX / width,
    right: (maxX + 1) / width,
    top: minY / height,
    bottom: (maxY + 1) / height,
  };
  return {
    algorithm: 'green-dominant-background-rgb8-bbox-v2',
    canvas: { width, height },
    foregroundPixels,
    bboxPixels: {
      leftInclusive: minX,
      rightExclusive: maxX + 1,
      topInclusive: minY,
      bottomExclusive: maxY + 1,
    },
    bboxNormalized: bounds,
    bboxCenterNormalized: {
      x: (bounds.left + bounds.right) / 2,
      y: (bounds.top + bounds.bottom) / 2,
    },
    rootSupportNormalized: {
      x: (rootXSum / rootPixels) / width,
      y: bounds.bottom,
    },
  };
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function composePrompt(frame, geometry) {
  return `PRIMARY TASK: perform an IN-PLACE LOCKED EDIT of IMAGE 1. IMAGE 1 is the immutable pose and registration master. Re-render that same locked body and transfer only identity, face, hair, outfit, palette, materials and polished game-art finish from IMAGE 2. Use IMAGE 3 only to safeguard facial geometry and hairline. Do not generate a new pose or composition. If references conflict, IMAGE 1 wins.

${frame.phase}
NUMERIC FRAME LOCK: exact non-#00FF00 foreground bounds x=${percent(geometry.bboxNormalized.left)}..${percent(geometry.bboxNormalized.right)}, y=${percent(geometry.bboxNormalized.top)}..${percent(geometry.bboxNormalized.bottom)}; bbox center=(${percent(geometry.bboxCenterNormalized.x)}, ${percent(geometry.bboxCenterNormalized.y)}); support/root=(${percent(geometry.rootSupportNormalized.x)}, ${percent(geometry.rootSupportNormalized.y)}). Match IMAGE 1 foreground bounds, horizontal center, root/support point, camera and every empty-green margin exactly. Do not auto-frame.
POSE LOCK: preserve IMAGE 1's normalized joint locations, body axis, silhouette extremes, root/support point, center, camera and empty-green margins. The pose may be awkward: do not naturalize, dramatize, rebalance, widen, lengthen, shrink, zoom, crop, recenter or smart-reframe it.

SUBJECT TRANSFER: Donald Trump from IMAGE 2, with the same recognizable face, swept blond hair, navy suit, white shirt, RED tie, black dress shoes, proportions and polished realistic fighting-game rendering. IMAGE 2 wins for outfit and rendering. IMAGE 3 protects likeness and hairline only. Do not copy the pose from IMAGE 2 or IMAGE 3.

ANATOMY: exactly one connected adult body, one head and torso, two complete arms/hands and two complete legs/feet. Preserve coherent shoulder-elbow-wrist and hip-knee-ankle chains. No duplicated, merged, detached or invented anatomy.

OUTPUT: one 3:4 image only. Pure flat uniform #00FF00 background. No floor, shadow, gradient, text, prop, scenery, extra figure, blur, motion trail, glow or effect.`;
}

async function uploadPng(path, key, state, apiKey) {
  const bytes = readFileSync(path);
  const contentSha256 = sha256(bytes);
  const prior = state.uploads[key];
  if (prior?.contentSha256 === contentSha256 && typeof prior.url === 'string') return prior.url;
  const initiated = await parseJson(await fetch(
    'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3',
    {
      method: 'POST',
      headers: {
        Authorization: `Key ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Fal-Object-Lifecycle': JSON.stringify({ expiration_duration_seconds: 86400 }),
        'User-Agent': 'insert-player-aura-champion/1.0',
      },
      body: JSON.stringify({ content_type: 'image/png', file_name: basename(path) }),
      signal: AbortSignal.timeout(60_000),
    },
  ), `Fal upload initiation for ${key}`);
  invariant(typeof initiated.upload_url === 'string', `Fal upload initiation omitted upload_url for ${key}.`);
  invariant(typeof initiated.file_url === 'string', `Fal upload initiation omitted file_url for ${key}.`);
  const uploaded = await fetch(initiated.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: bytes,
    signal: AbortSignal.timeout(60_000),
  });
  invariant(uploaded.ok, `Fal upload failed for ${key} with HTTP ${uploaded.status}.`);
  const url = initiated.file_url;
  state.uploads[key] = {
    path: portablePath(path),
    contentSha256,
    url,
    uploadedAt: nowIso(),
  };
  writeJsonAtomic(statePath, state);
  return url;
}

async function parseJson(response, label) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status} (${sha256(text)}).`);
  }
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${body.detail || body.message || sha256(text)}`);
  }
  return body;
}

function outputUrlFrom(body) {
  const candidates = [
    body?.images?.[0]?.url,
    body?.image?.url,
    body?.output?.images?.[0]?.url,
    body?.data?.images?.[0]?.url,
  ];
  return candidates.find((value) => typeof value === 'string' && /^https:\/\//.test(value)) ?? null;
}

async function sleep(milliseconds) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function main() {
  invariant(parseArg('--confirm') === confirmation, `Refusing paid generation without --confirm=${confirmation}.`);
  const frameKey = parseArg('--frame');
  const frame = frameDefinitions[frameKey];
  invariant(frame, `Unknown --frame. Choose one of: ${Object.keys(frameDefinitions).join(', ')}.`);
  const apiKey = process.env.FAL_API_KEY?.trim() ?? '';
  invariant(apiKey, 'FAL_API_KEY is required.');

  const sourcePath = join(templateRoot, frame.source);
  invariant(existsSync(sourcePath), `Missing Template Zero pose: ${sourcePath}`);
  const posePreparation = parseArg('--pose-preparation', 'source-background');
  const posePath = join(outputRoot, 'inputs/poses', `${frameKey}.png`);
  normalizePose(sourcePath, posePath, posePreparation);
  const poseBytes = readFileSync(posePath);
  const geometry = foregroundGeometry(posePath);

  const canonicalPath = join(anchorRoot, anchorDefinitions.canonical.fileName);
  const originalPath = join(anchorRoot, anchorDefinitions.original.fileName);
  invariant(existsSync(canonicalPath) && existsSync(originalPath), `Missing trusted Trump anchors under ${anchorRoot}.`);
  invariant(sha256(readFileSync(canonicalPath)) === anchorDefinitions.canonical.sha256, 'Canonical Trump anchor drifted.');
  invariant(sha256(readFileSync(originalPath)) === anchorDefinitions.original.sha256, 'Original Trump identity anchor drifted.');

  const state = readState();
  let existing = state.frames[frameKey];
  const normalizedPoseSha256 = sha256(poseBytes);
  if (existing?.status === 'completed' && existsSync(resolve(repositoryRoot, existing.outputPath))) {
    if (existing.normalizedPoseSha256 === normalizedPoseSha256) {
      process.stdout.write(`SKIP ${frameKey} already completed at ${existing.outputPath}\n`);
      return;
    }
    invariant(
      parseArg('--supersede') === 'BACKGROUND_PREPARATION_FIX_V1',
      `${frameKey} was completed from a different normalized pose. Pass --supersede=BACKGROUND_PREPARATION_FIX_V1 to archive and replace it.`,
    );
    const rejectedPath = join(outputRoot, 'rejected', `${frameKey}-pre-background-fix.png`);
    mkdirSync(dirname(rejectedPath), { recursive: true, mode: 0o700 });
    invariant(!existsSync(rejectedPath), `Rejected artifact already exists: ${rejectedPath}`);
    renameSync(resolve(repositoryRoot, existing.outputPath), rejectedPath);
    state.rejectedAttempts ??= [];
    state.rejectedAttempts.push({
      ...existing,
      rejectedAt: nowIso(),
      rejectedReason: 'Template Zero pose background was not normalized to flat #00FF00, so the numeric foreground lock covered the whole canvas.',
      archivedOutputPath: rejectedPath.slice(repositoryRoot.length + 1),
    });
    delete state.frames[frameKey];
    writeJsonAtomic(statePath, state);
    existing = null;
  }

  const poseUrl = await uploadPng(posePath, `pose:${frameKey}`, state, apiKey);
  const canonicalUrl = await uploadPng(canonicalPath, 'anchor:canonical', state, apiKey);
  const originalUrl = await uploadPng(originalPath, 'anchor:original', state, apiKey);
  const prompt = composePrompt(frame, geometry);
  const input = {
    num_images: 1,
    aspect_ratio: 'auto',
    resolution: '2k',
    output_format: 'png',
    quality: 'medium',
    prompt,
    image_urls: [poseUrl, canonicalUrl, originalUrl],
  };
  const requestSha256 = sha256(canonicalJson(input));
  let active = existing;

  if (!active) {
    state.frames[frameKey] = {
      status: 'submitting',
      sourcePath: portablePath(sourcePath),
      normalizedPosePath: portablePath(posePath),
      sourceSha256: sha256(readFileSync(sourcePath)),
      normalizedPoseSha256,
      posePreparation,
      geometry,
      prompt,
      promptSha256: sha256(prompt),
      requestSha256,
      modelId: 'grok-imagine-image-2-edit',
      providerEndpoint: endpoint,
      expectedCostMicrocredits: 110_000,
      submittedAt: nowIso(),
    };
    writeJsonAtomic(statePath, state);
    let submitted;
    try {
      const response = await fetch(queueEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Key ${apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Fal-Object-Lifecycle-Preference': JSON.stringify({ expiration_duration_seconds: 86400 }),
          'User-Agent': 'insert-player-aura-champion/1.0',
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(60_000),
      });
      submitted = await parseJson(response, 'Fal submission');
    } catch (error) {
      state.frames[frameKey] = {
        ...state.frames[frameKey],
        status: 'submission_outcome_unknown',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: nowIso(),
      };
      writeJsonAtomic(statePath, state);
      throw error;
    }
    invariant(typeof submitted.request_id === 'string' && submitted.request_id, 'Fal submission omitted request_id.');
    active = {
      ...state.frames[frameKey],
      status: 'submitted',
      requestId: submitted.request_id,
      statusUrl: submitted.status_url || `${queueEndpoint}/requests/${submitted.request_id}/status`,
      responseUrl: submitted.response_url || `${queueEndpoint}/requests/${submitted.request_id}`,
      updatedAt: nowIso(),
    };
    state.frames[frameKey] = active;
    writeJsonAtomic(statePath, state);
    process.stdout.write(`SUBMITTED ${frameKey} ${active.requestId}\n`);
  } else {
    invariant(active.requestSha256 === requestSha256, `${frameKey} request inputs drifted.`);
    invariant(['submitted', 'processing'].includes(active.status), `${frameKey} requires manual reconciliation from ${active.status}.`);
  }

  const headers = { Authorization: `Key ${apiKey}`, Accept: 'application/json' };
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = await parseJson(await fetch(active.statusUrl, {
      headers,
      signal: AbortSignal.timeout(60_000),
    }), 'Fal status');
    if (status.status === 'COMPLETED') break;
    if (status.status === 'FAILED') {
      state.frames[frameKey] = { ...active, status: 'failed', providerStatus: status, updatedAt: nowIso() };
      writeJsonAtomic(statePath, state);
      throw new Error(`Fal generation failed for ${frameKey}.`);
    }
    active = { ...active, status: 'processing', providerStatus: status.status, updatedAt: nowIso() };
    state.frames[frameKey] = active;
    writeJsonAtomic(statePath, state);
    await sleep(2_000);
  }
  invariant(Date.now() < deadline, `Fal generation timed out for ${frameKey}; request remains resumable.`);

  const providerResponse = await parseJson(await fetch(active.responseUrl, {
    headers,
    signal: AbortSignal.timeout(60_000),
  }), 'Fal result');
  const imageUrl = outputUrlFrom(providerResponse);
  invariant(imageUrl, `Fal result did not contain a recognized image URL (${sha256(canonicalJson(providerResponse))}).`);
  const imageResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
  invariant(imageResponse.ok, `Generated image download failed with HTTP ${imageResponse.status}.`);
  const imageBytes = Buffer.from(await imageResponse.arrayBuffer());
  const dimensions = pngDimensions(imageBytes, 'generated output');
  const outputPath = join(outputRoot, 'raw', `${frameKey}.png`);
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(outputPath, imageBytes, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
  state.frames[frameKey] = {
    ...active,
    status: 'completed',
    completedAt: nowIso(),
    outputPath: outputPath.slice(repositoryRoot.length + 1),
    outputSha256: sha256(imageBytes),
    outputSizeBytes: imageBytes.length,
    outputDimensions: dimensions,
    providerResponseSha256: sha256(canonicalJson(providerResponse)),
    providerImageUrl: imageUrl,
  };
  state.updatedAt = nowIso();
  writeJsonAtomic(statePath, state);
  process.stdout.write(`COMPLETED ${frameKey} ${dimensions.width}x${dimensions.height} ${state.frames[frameKey].outputSha256}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
