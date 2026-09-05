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
import { keyHumanoidChroma } from './humanoid-pose-template-postprocess-core.mjs';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const templateRoot = join(repositoryRoot, 'artifacts/aura-animation-canary/template-zero');
const subjectRoot = join(repositoryRoot, 'artifacts/aura-animation-canary/donald-trump');
const workRoot = join(repositoryRoot, '.artifacts/aura-trump-champion-poses');
const referenceRepository = resolve(
  process.env.INSERT_PLAYER_REFERENCE_REPO
    || join(repositoryRoot, '../AI Street Fighter/ai-street-fighter'),
);
const anchorRoot = join(
  referenceRepository,
  '.local/template-zero-provider-sweep/trump-full-template-v1/inputs/anchors',
);
const confirmation = 'GENERATE_AURA_TRUMP_CHAMPION_REST';
const endpoint = 'xai/grok-imagine-image/v2.0/edit';
const queueEndpoint = `https://queue.fal.run/${endpoint}`;
const analysisWidth = 1536;
const analysisHeight = 2048;
const referenceModes = Object.freeze({
  full: Object.freeze({ referenceOrder: ['pose', 'canonical', 'original'], expectedCostMicrocredits: 110_000 }),
  'pose-original': Object.freeze({ referenceOrder: ['pose', 'original'], expectedCostMicrocredits: 100_000 }),
});

const animationContracts = Object.freeze({
  aura_unbothered: Object.freeze({
    phrase: 'AURA UNBOTHERED',
    contract: 'Preserve the quiet low-amplitude pose exactly: relaxed hands, subtle weight shift, shoulder level, head direction and planted feet. Do not import a fighting guard from the character references.',
  }),
  aura_mog_check: Object.freeze({
    phrase: 'AURA MOG CHECK',
    contract: 'Preserve the exact head angle, jaw-hand relationship, forward torso lean and facial expression. At the meme peak keep the deliberately enlarged perspective head and strongly pursed lips; do not beautify, normalize or reduce the exaggeration.',
  }),
  aura_glide: Object.freeze({
    phrase: 'AURA GLIDE',
    contract: 'Preserve the exact calm upper body, arm placement, heel-to-toe foot crossing, leg overlap, weight shift and planted support. Do not turn the pose into running, walking, fighting or jumping.',
  }),
  aura_floor_worm: Object.freeze({
    phrase: 'AURA FLOOR WORM',
    contract: 'Preserve the exact floor-level breakdance pose, including hand support, chest height, hip height, bent or extended knees, foot placement and full horizontal silhouette. Do not stand the subject up, crop the body or reinterpret the pose as injury.',
  }),
  aura_one_leg: Object.freeze({
    phrase: 'AURA ONE-LEG HOP',
    contract: 'Preserve the exact same-side hand-to-ankle contact, bent held leg, free balancing arm, torso tilt, planted or airborne support foot and hop height. Do not turn it into a kick or remove the ankle grip.',
  }),
  aura_shrug: Object.freeze({
    phrase: 'AURA SHRUG REACTION',
    contract: 'Preserve the exact compact open-palm shrug pose and asymmetric hand heights. Keep both elbows comfortably bent near the torso; do not turn it into the Six-Seven seesaw, a fighting guard or arms spread wide.',
  }),
});

const frameContracts = Object.freeze({
  aura_unbothered: Object.freeze({
    frame06: 'MANDATORY SILHOUETTE: both arms hang fully lowered beside the torso with relaxed open hands near the thighs; the head alone turns toward image-left. There are no raised forearms and no fists.',
  }),
  aura_glide: Object.freeze({
    frame04: 'MANDATORY SILHOUETTE: both hands stay hidden or clasped behind the lower back, both elbows point behind the torso, and one straight leg reaches forward heel-first. There are no visible fists and no raised guard.',
  }),
  aura_one_leg: Object.freeze({
    frame04: 'MANDATORY SILHOUETTE: profile facing image-right; one hand visibly grips the lifted rear ankle behind the hips; the other arm reaches straight toward image-right with an open hand; the long support leg points down and both feet are airborne. No fists, no guard, no second planted leg.',
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

function hasArg(name) {
  return process.argv.includes(name);
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

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.writing-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function runMagick(args, label) {
  const result = spawnSync('magick', args, {
    encoding: 'utf8',
    env: { ...process.env, MAGICK_THREAD_LIMIT: '1' },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function pngDimensions(bytes, label) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  invariant(bytes.length >= 29 && bytes.subarray(0, 8).equals(signature), `${label} is not PNG.`);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorTypeCode: bytes[25],
  };
}

function animationDefinition(animationName) {
  const contract = animationContracts[animationName];
  invariant(contract, `Unknown --animation. Choose one of: ${Object.keys(animationContracts).join(', ')}.`);
  const manifestPath = join(templateRoot, animationName, 'manifest.json');
  invariant(existsSync(manifestPath), `Missing Template Zero manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  if (manifest.keyframes?.sequence) {
    const sequence = manifest.keyframes.sequence;
    const uniqueKeys = [...new Set(sequence)];
    return {
      animationName,
      ...contract,
      manifestPath,
      manifest,
      sequence,
      frames: uniqueKeys.map((frameKey, sequenceIndex) => {
        const source = manifest.keyframes[frameKey];
        invariant(source?.path, `Missing Template Zero keyframe ${animationName}/${frameKey}.`);
        return {
          frameKey,
          sourcePath: resolve(repositoryRoot, source.path),
          crop: null,
          sequenceIndex,
          sequenceLength: sequence.length,
        };
      }),
    };
  }

  invariant(manifest.raw?.path, `Template Zero ${animationName} has no raw storyboard.`);
  invariant(manifest.raw.width % 4 === 0 && manifest.raw.height % 2 === 0, `Invalid storyboard grid for ${animationName}.`);
  const cellWidth = manifest.raw.width / 4;
  const cellHeight = manifest.raw.height / 2;
  const sourcePath = resolve(repositoryRoot, manifest.raw.path);
  const frames = Array.from({ length: 8 }, (_, index) => ({
    frameKey: `frame${String(index + 1).padStart(2, '0')}`,
    sourcePath,
    crop: null,
    componentIndex: index,
    sequenceIndex: index,
    sequenceLength: 8,
  }));
  return {
    animationName,
    ...contract,
    manifestPath,
    manifest,
    storyboard: { sourcePath, width: manifest.raw.width, height: manifest.raw.height, cellWidth, cellHeight },
    sequence: frames.map(({ frameKey }) => frameKey),
    frames,
  };
}

function runMagickBinary(args, options = {}) {
  const result = spawnSync('magick', args, {
    encoding: null,
    input: options.input,
    env: { ...process.env, MAGICK_THREAD_LIMIT: '1' },
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${options.label || 'ImageMagick'} failed: ${(result.stderr || result.stdout || '').toString().trim()}`);
  }
  return result.stdout;
}

function connectedForegroundComponents(rgba, width, height) {
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const components = [];
  for (let start = 0; start < pixelCount; start += 1) {
    if (visited[start] || rgba[start * 4 + 3] <= 8) continue;
    let queueStart = 0;
    let queueEnd = 0;
    queue[queueEnd] = start;
    queueEnd += 1;
    visited[start] = 1;
    const indices = [];
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    while (queueStart < queueEnd) {
      const index = queue[queueStart];
      queueStart += 1;
      indices.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
        const nextY = y + deltaY;
        if (nextY < 0 || nextY >= height) continue;
        for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
          const nextX = x + deltaX;
          if ((deltaX === 0 && deltaY === 0) || nextX < 0 || nextX >= width) continue;
          const next = nextY * width + nextX;
          if (visited[next] || rgba[next * 4 + 3] <= 8) continue;
          visited[next] = 1;
          queue[queueEnd] = next;
          queueEnd += 1;
        }
      }
    }
    components.push({
      indices,
      pixels: indices.length,
      bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      center: { x: (minX + maxX + 1) / 2, y: (minY + maxY + 1) / 2 },
      touchesEdge: minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1,
    });
  }
  return components.sort((left, right) => right.pixels - left.pixels);
}

function writeRgbaPng(path, rgba, width, height, label) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  runMagickBinary([
    '-size', `${width}x${height}`,
    '-depth', '8',
    'RGBA:-',
    '-strip',
    '-define', 'png:compression-level=9',
    `PNG32:${path}`,
  ], { input: Buffer.from(rgba), label });
}

function prepareStoryboardPoses(definition) {
  const { sourcePath, width, height } = definition.storyboard;
  const rgb = runMagickBinary([
    sourcePath,
    '-alpha', 'off',
    '-depth', '8',
    'RGB:-',
  ], {
    label: `decode Template Zero storyboard ${definition.animationName}`,
    maxBuffer: width * height * 3 + 1024,
  });
  invariant(rgb.length === width * height * 3, `Unexpected storyboard byte count for ${definition.animationName}.`);
  const keyed = keyHumanoidChroma(rgb, width, height);
  const allComponents = connectedForegroundComponents(keyed.rgba, width, height);
  const people = allComponents.slice(0, 8);
  invariant(people.length === 8, `${definition.animationName} did not yield eight pose components.`);
  const smallestPersonPixels = Math.min(...people.map(({ pixels }) => pixels));
  const largestRejectedPixels = allComponents[8]?.pixels ?? 0;
  invariant(
    smallestPersonPixels > Math.max(2_000, largestRejectedPixels * 2),
    `${definition.animationName} component separation is ambiguous (${smallestPersonPixels} vs ${largestRejectedPixels}).`,
  );
  const rowOrdered = [...people]
    .sort((left, right) => left.center.y - right.center.y)
    .reduce((rows, component, index) => {
      rows[index < 4 ? 0 : 1].push(component);
      return rows;
    }, [[], []])
    .flatMap((row) => row.sort((left, right) => left.center.x - right.center.x));
  const preparedByKey = new Map();

  for (const frame of definition.frames) {
    const component = rowOrdered[frame.componentIndex];
    invariant(component && !component.touchesEdge, `${definition.animationName}/${frame.frameKey} component touches storyboard edge.`);
    const crop = new Uint8ClampedArray(component.bbox.w * component.bbox.h * 4);
    for (const sourceIndex of component.indices) {
      const sourceX = sourceIndex % width;
      const sourceY = Math.floor(sourceIndex / width);
      const destinationX = sourceX - component.bbox.x;
      const destinationY = sourceY - component.bbox.y;
      const sourceOffset = sourceIndex * 4;
      const destinationOffset = (destinationY * component.bbox.w + destinationX) * 4;
      crop.set(keyed.rgba.subarray(sourceOffset, sourceOffset + 4), destinationOffset);
    }
    const componentPath = join(workRoot, definition.animationName, 'components', `${frame.frameKey}.png`);
    writeRgbaPng(
      componentPath,
      crop,
      component.bbox.w,
      component.bbox.h,
      `write isolated pose ${definition.animationName}/${frame.frameKey}`,
    );
    const targetScale = Math.min(
      4,
      (analysisWidth * 0.92) / component.bbox.w,
      (analysisHeight * 0.9) / component.bbox.h,
    );
    const targetWidth = Math.max(1, Math.round(component.bbox.w * targetScale));
    const targetHeight = Math.max(1, Math.round(component.bbox.h * targetScale));
    const targetX = Math.round((analysisWidth - targetWidth) / 2);
    const targetY = Math.round(analysisHeight * 0.95 - targetHeight);
    invariant(targetX >= 0 && targetY >= 0, `${definition.animationName}/${frame.frameKey} normalization does not fit.`);
    const outputPath = join(workRoot, definition.animationName, `${frame.frameKey}.png`);
    runMagick([
      '-size', `${analysisWidth}x${analysisHeight}`,
      'xc:#00FF00',
      '(',
      componentPath,
      '-filter', 'Lanczos',
      '-resize', `${targetWidth}x${targetHeight}!`,
      ')',
      '-geometry', `+${targetX}+${targetY}`,
      '-compose', 'over',
      '-composite',
      '-alpha', 'off',
      '-depth', '8',
      '-strip',
      '-define', 'png:compression-level=9',
      `PNG24:${outputPath}`,
    ], `normalize isolated pose ${definition.animationName}/${frame.frameKey}`);
    const bytes = readFileSync(outputPath);
    expectRgbCanvas(bytes, `${definition.animationName}/${frame.frameKey}`);
    preparedByKey.set(frame.frameKey, {
      outputPath,
      bytes,
      geometry: foregroundGeometry(outputPath),
      extraction: {
        sourceComponentPixels: component.pixels,
        sourceComponentBbox: component.bbox,
        normalizedUniformScale: targetScale,
        discardedComponentCount: Math.max(0, allComponents.length - 8),
        largestDiscardedComponentPixels: largestRejectedPixels,
      },
    });
  }
  return preparedByKey;
}

function preparePose(definition, frame) {
  invariant(existsSync(frame.sourcePath), `Missing Template Zero pose source: ${frame.sourcePath}`);
  const outputPath = join(workRoot, definition.animationName, `${frame.frameKey}.png`);
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const cropArgs = frame.crop
    ? ['-crop', `${frame.crop.width}x${frame.crop.height}+${frame.crop.x}+${frame.crop.y}`, '+repage']
    : [];
  runMagick([
    frame.sourcePath,
    ...cropArgs,
    '-background', '#00FF00',
    '-alpha', 'background',
    '-alpha', 'off',
    '-filter', 'Lanczos',
    '-resize', `${analysisWidth}x${analysisHeight}!`,
    '-depth', '8',
    '-strip',
    '-define', 'png:compression-level=9',
    `PNG24:${outputPath}`,
  ], `prepare pose ${definition.animationName}/${frame.frameKey}`);
  const bytes = readFileSync(outputPath);
  expectRgbCanvas(bytes, `${definition.animationName}/${frame.frameKey}`);
  return { outputPath, bytes, geometry: foregroundGeometry(outputPath) };
}

function expectRgbCanvas(bytes, label) {
  const dimensions = pngDimensions(bytes, label);
  invariant(
    dimensions.width === analysisWidth
      && dimensions.height === analysisHeight
      && dimensions.bitDepth === 8
      && dimensions.colorTypeCode === 2,
    `${label} must be RGB8 ${analysisWidth}x${analysisHeight}.`,
  );
}

function foregroundGeometry(path) {
  const result = spawnSync('magick', [path, '-alpha', 'off', '-depth', '8', 'RGB:-'], {
    encoding: null,
    env: { ...process.env, MAGICK_THREAD_LIMIT: '1' },
    maxBuffer: analysisWidth * analysisHeight * 3 + 1024,
  });
  invariant(result.status === 0, `RGB extraction failed for ${path}.`);
  const pixels = result.stdout;
  invariant(pixels.length === analysisWidth * analysisHeight * 3, `Unexpected RGB length for ${path}.`);
  let minX = analysisWidth;
  let minY = analysisHeight;
  let maxX = -1;
  let maxY = -1;
  let foregroundPixels = 0;
  for (let y = 0; y < analysisHeight; y += 1) {
    for (let x = 0; x < analysisWidth; x += 1) {
      const index = (y * analysisWidth + x) * 3;
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
  invariant(foregroundPixels > 0, `No foreground found in ${path}.`);
  const bbox = {
    left: minX / analysisWidth,
    right: (maxX + 1) / analysisWidth,
    top: minY / analysisHeight,
    bottom: (maxY + 1) / analysisHeight,
  };
  return {
    algorithm: 'green-dominant-background-rgb8-bbox-v2',
    canvas: { width: analysisWidth, height: analysisHeight },
    foregroundPixels,
    bboxNormalized: bbox,
    bboxCenterNormalized: {
      x: (bbox.left + bbox.right) / 2,
      y: (bbox.top + bbox.bottom) / 2,
    },
    rootSupportNormalized: {
      x: (bbox.left + bbox.right) / 2,
      y: bbox.bottom,
    },
  };
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function composePrompt(definition, frame, geometry, referenceMode) {
  const frameContract = frameContracts[definition.animationName]?.[frame.frameKey] ?? '';
  const primaryTask = referenceMode === 'pose-original'
    ? 'PRIMARY TASK: perform an IN-PLACE LOCKED EDIT of IMAGE 1. IMAGE 1 is the immutable pose, silhouette, camera and registration master. Replace only the gray mannequin surface with Donald Trump identity and finished clothing. IMAGE 2 is a face and swept-blond-hair likeness reference only; it contains no usable body pose or full outfit. Do not invent a new pose or composition. IMAGE 1 wins every spatial or anatomical conflict.'
    : 'PRIMARY TASK: perform an IN-PLACE LOCKED EDIT of IMAGE 1. IMAGE 1 is the immutable pose, silhouette, camera and registration master. Re-render that same locked body and transfer only identity, face, hair, outfit, materials and polished game-art finish from IMAGE 2. Use IMAGE 3 only to safeguard facial geometry and hairline. Do not generate a new pose or composition. If references conflict, IMAGE 1 wins.';
  const subjectTransfer = referenceMode === 'pose-original'
    ? 'SUBJECT TRANSFER: render recognizable Donald Trump using IMAGE 2 for face and swept blond hair only. Dress the already-posed IMAGE 1 body in the exact established costume: tailored dark navy two-button suit, white dress shirt, vivid RED necktie, matching navy trousers and black leather dress shoes. Preserve polished realistic fighting-game rendering. Do not derive any limb position, hand gesture, stance, body scale or camera framing from IMAGE 2.'
    : 'SUBJECT TRANSFER: Donald Trump from IMAGE 2, with the same recognizable face, swept blond hair, navy suit, white shirt, RED tie, black dress shoes, body proportions and polished realistic fighting-game rendering. IMAGE 2 wins for identity, outfit and rendering. IMAGE 3 protects likeness and hairline only. Do not copy the pose from IMAGE 2 or IMAGE 3.';
  return `Use case: identity-preserve
Asset type: one individually authored Champion-quality Phaser character-animation keyframe
${primaryTask}

MOVEMENT: ${definition.phrase}, source pose ${frame.sequenceIndex + 1} of ${frame.sequenceLength}. ${definition.contract}
${frameContract}
NUMERIC FRAME LOCK: foreground bounds x=${percent(geometry.bboxNormalized.left)}..${percent(geometry.bboxNormalized.right)}, y=${percent(geometry.bboxNormalized.top)}..${percent(geometry.bboxNormalized.bottom)}; center=(${percent(geometry.bboxCenterNormalized.x)}, ${percent(geometry.bboxCenterNormalized.y)}); support/root=(${percent(geometry.rootSupportNormalized.x)}, ${percent(geometry.rootSupportNormalized.y)}). Match IMAGE 1's bounds, center, support point, camera and empty-green margins. Do not auto-frame.
POSE LOCK: preserve IMAGE 1's joint locations, body axis, silhouette extremes, hand orientation, expression, root/support point and every visible contact. The pose may be awkward, horizontal or exaggerated: do not naturalize, dramatize, rebalance, widen, lengthen, shrink, zoom, crop, recenter or smart-reframe it.

${subjectTransfer}

ANATOMY: exactly one connected adult body, one head and torso, two complete arms/hands and two complete legs/feet. Preserve coherent shoulder-elbow-wrist and hip-knee-ankle chains. No duplicated, merged, detached or invented anatomy.

OUTPUT: one 3:4 image only. Pure flat uniform #00FF00 background. No floor, shadow, gradient, text, prop, scenery, extra figure, blur, motion trail, glow or effect.`;
}

function readState(definition) {
  const statePath = join(subjectRoot, definition.animationName, 'champion/generation-state.json');
  if (existsSync(statePath)) return { statePath, state: JSON.parse(readFileSync(statePath, 'utf8')) };
  return {
    statePath,
    state: {
      schemaVersion: 1,
      experimentId: `donald-trump-${definition.animationName}-champion-v1`,
      animationName: definition.animationName,
      endpoint,
      modelId: 'grok-imagine-image-2-edit',
      provider: 'fal',
      pricingMicrocredits: Object.fromEntries(Object.entries(referenceModes).map(([key, value]) => [key, value.expectedCostMicrocredits])),
      createdAt: nowIso(),
      sequence: definition.sequence,
      uploads: {},
      frames: {},
      rejectedAttempts: [],
    },
  };
}

async function parseJson(response, label) {
  const responseText = await response.text();
  let body;
  try {
    body = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status} (${sha256(responseText)}).`);
  }
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${body.detail || body.message || sha256(responseText)}`);
  }
  return body;
}

async function uploadPng(path, key, statePath, state, apiKey) {
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
  invariant(typeof initiated.upload_url === 'string', `Fal upload omitted upload_url for ${key}.`);
  invariant(typeof initiated.file_url === 'string', `Fal upload omitted file_url for ${key}.`);
  const uploaded = await fetch(initiated.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: bytes,
    signal: AbortSignal.timeout(60_000),
  });
  invariant(uploaded.ok, `Fal upload failed for ${key} with HTTP ${uploaded.status}.`);
  state.uploads[key] = {
    path: portablePath(path),
    contentSha256,
    url: initiated.file_url,
    uploadedAt: nowIso(),
  };
  writeJsonAtomic(statePath, state);
  return initiated.file_url;
}

function outputUrlFrom(body) {
  return [
    body?.images?.[0]?.url,
    body?.image?.url,
    body?.output?.images?.[0]?.url,
    body?.data?.images?.[0]?.url,
  ].find((value) => typeof value === 'string' && /^https:\/\//.test(value)) ?? null;
}

async function sleep(milliseconds) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function generateFrame(definition, frame, prepared, statePath, state, apiKey, options) {
  const outputPath = join(subjectRoot, definition.animationName, 'champion/raw', `${frame.frameKey}.png`);
  const preparedSha256 = sha256(prepared.bytes);
  let existing = state.frames[frame.frameKey];
  if (options.reviewedReject) {
    invariant(existing?.status === 'completed', `Can only replace a reviewed completed frame, got ${existing?.status ?? 'missing'}.`);
    const existingPath = resolve(repositoryRoot, existing.outputPath);
    invariant(existsSync(existingPath), `Reviewed reject output is missing: ${existing.outputPath}`);
    invariant(sha256(readFileSync(existingPath)) === existing.outputSha256, `Reviewed reject output hash drifted: ${existing.outputPath}`);
    const requestSuffix = existing.requestId?.replace(/[^a-zA-Z0-9-]/g, '') || existing.outputSha256.slice(0, 12);
    const rejectedPath = join(subjectRoot, definition.animationName, 'champion/rejected', `${frame.frameKey}-${requestSuffix}.png`);
    invariant(!existsSync(rejectedPath), `Refusing to overwrite reviewed reject: ${rejectedPath}`);
    mkdirSync(dirname(rejectedPath), { recursive: true, mode: 0o700 });
    renameSync(existingPath, rejectedPath);
    state.rejectedAttempts.push({
      ...existing,
      frameKey: frame.frameKey,
      outputPath: portablePath(rejectedPath),
      rejectedAt: nowIso(),
      reviewedReason: options.reviewedReject,
    });
    delete state.frames[frame.frameKey];
    state.updatedAt = nowIso();
    writeJsonAtomic(statePath, state);
    existing = undefined;
    process.stdout.write(`ARCHIVED_REJECT ${definition.animationName}/${frame.frameKey} ${options.reviewedReject}\n`);
  }
  if (existing?.status === 'completed') {
    invariant(existing.normalizedPoseSha256 === preparedSha256, `${definition.animationName}/${frame.frameKey} pose drifted after completion.`);
    invariant(existsSync(resolve(repositoryRoot, existing.outputPath)), `Completed output is missing: ${existing.outputPath}`);
    invariant(sha256(readFileSync(resolve(repositoryRoot, existing.outputPath))) === existing.outputSha256, `Completed output hash drifted: ${existing.outputPath}`);
    process.stdout.write(`SKIP ${definition.animationName}/${frame.frameKey} already completed\n`);
    return;
  }
  invariant(
    !existing,
    `${definition.animationName}/${frame.frameKey} requires manual reconciliation from status ${existing?.status ?? 'unknown'}.`,
  );
  invariant(!existsSync(outputPath), `Refusing to overwrite untracked output: ${outputPath}`);

  const canonicalPath = join(anchorRoot, anchorDefinitions.canonical.fileName);
  const originalPath = join(anchorRoot, anchorDefinitions.original.fileName);
  invariant(existsSync(originalPath), `Missing trusted Trump original anchor under ${anchorRoot}.`);
  invariant(sha256(readFileSync(originalPath)) === anchorDefinitions.original.sha256, 'Original Trump anchor drifted.');
  if (options.referenceMode === 'full') {
    invariant(existsSync(canonicalPath), `Missing trusted Trump canonical anchor under ${anchorRoot}.`);
    invariant(sha256(readFileSync(canonicalPath)) === anchorDefinitions.canonical.sha256, 'Canonical Trump anchor drifted.');
  }

  const poseUrl = await uploadPng(prepared.outputPath, `pose:${frame.frameKey}`, statePath, state, apiKey);
  const originalUrl = await uploadPng(originalPath, 'anchor:original', statePath, state, apiKey);
  const canonicalUrl = options.referenceMode === 'full'
    ? await uploadPng(canonicalPath, 'anchor:canonical', statePath, state, apiKey)
    : null;
  const prompt = composePrompt(definition, frame, prepared.geometry, options.referenceMode);
  const imageUrls = options.referenceMode === 'full'
    ? [poseUrl, canonicalUrl, originalUrl]
    : [poseUrl, originalUrl];
  const input = {
    num_images: 1,
    aspect_ratio: 'auto',
    resolution: '2k',
    output_format: 'png',
    quality: 'medium',
    prompt,
    image_urls: imageUrls,
  };
  const requestSha256 = sha256(canonicalJson(input));
  state.frames[frame.frameKey] = {
    status: 'submitting',
    sourcePath: portablePath(frame.sourcePath),
    sourceCrop: frame.crop,
    sourceComponentIndex: frame.componentIndex ?? null,
    poseExtraction: prepared.extraction ?? null,
    normalizedPosePath: portablePath(prepared.outputPath),
    sourceSha256: sha256(readFileSync(frame.sourcePath)),
    normalizedPoseSha256: preparedSha256,
    geometry: prepared.geometry,
    prompt,
    promptSha256: sha256(prompt),
    requestSha256,
    referenceMode: options.referenceMode,
    referenceOrder: options.referenceConfig.referenceOrder,
    modelId: 'grok-imagine-image-2-edit',
    providerEndpoint: endpoint,
    expectedCostMicrocredits: options.referenceConfig.expectedCostMicrocredits,
    submittedAt: nowIso(),
  };
  writeJsonAtomic(statePath, state);

  let submitted;
  try {
    submitted = await parseJson(await fetch(queueEndpoint, {
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
    }), 'Fal submission');
  } catch (error) {
    state.frames[frame.frameKey] = {
      ...state.frames[frame.frameKey],
      status: 'submission_outcome_unknown',
      error: error instanceof Error ? error.message : String(error),
      updatedAt: nowIso(),
    };
    writeJsonAtomic(statePath, state);
    throw error;
  }
  invariant(typeof submitted.request_id === 'string' && submitted.request_id, 'Fal submission omitted request_id.');
  let active = {
    ...state.frames[frame.frameKey],
    status: 'submitted',
    requestId: submitted.request_id,
    statusUrl: submitted.status_url || `${queueEndpoint}/requests/${submitted.request_id}/status`,
    responseUrl: submitted.response_url || `${queueEndpoint}/requests/${submitted.request_id}`,
    updatedAt: nowIso(),
  };
  state.frames[frame.frameKey] = active;
  writeJsonAtomic(statePath, state);
  process.stdout.write(`SUBMITTED ${definition.animationName}/${frame.frameKey} ${active.requestId}\n`);

  const headers = { Authorization: `Key ${apiKey}`, Accept: 'application/json' };
  const deadline = Date.now() + 20 * 60 * 1000;
  let providerCompleted = false;
  while (Date.now() < deadline) {
    const providerStatus = await parseJson(await fetch(active.statusUrl, {
      headers,
      signal: AbortSignal.timeout(60_000),
    }), 'Fal status');
    if (providerStatus.status === 'COMPLETED') {
      providerCompleted = true;
      break;
    }
    if (providerStatus.status === 'FAILED') {
      state.frames[frame.frameKey] = {
        ...active,
        status: 'failed',
        providerStatus,
        updatedAt: nowIso(),
      };
      writeJsonAtomic(statePath, state);
      throw new Error(`Fal generation failed for ${definition.animationName}/${frame.frameKey}; no retry was attempted.`);
    }
    active = {
      ...active,
      status: 'processing',
      providerStatus: providerStatus.status,
      updatedAt: nowIso(),
    };
    state.frames[frame.frameKey] = active;
    writeJsonAtomic(statePath, state);
    await sleep(2_000);
  }
  invariant(providerCompleted, `Fal generation timed out for ${definition.animationName}/${frame.frameKey}; request remains resumable.`);

  const providerResponse = await parseJson(await fetch(active.responseUrl, {
    headers,
    signal: AbortSignal.timeout(60_000),
  }), 'Fal result');
  const imageUrl = outputUrlFrom(providerResponse);
  invariant(imageUrl, `Fal result omitted image URL (${sha256(canonicalJson(providerResponse))}).`);
  const imageResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
  invariant(imageResponse.ok, `Generated image download failed with HTTP ${imageResponse.status}.`);
  const imageBytes = Buffer.from(await imageResponse.arrayBuffer());
  const dimensions = pngDimensions(imageBytes, 'generated output');
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const outputTemporary = `${outputPath}.writing-${process.pid}-${randomUUID()}`;
  writeFileSync(outputTemporary, imageBytes, { mode: 0o600 });
  chmodSync(outputTemporary, 0o600);
  renameSync(outputTemporary, outputPath);
  state.frames[frame.frameKey] = {
    ...active,
    status: 'completed',
    providerStatus: 'COMPLETED',
    completedAt: nowIso(),
    outputPath: portablePath(outputPath),
    outputSha256: sha256(imageBytes),
    outputSizeBytes: imageBytes.length,
    outputDimensions: dimensions,
    providerResponseSha256: sha256(canonicalJson(providerResponse)),
    providerImageUrl: imageUrl,
  };
  state.updatedAt = nowIso();
  writeJsonAtomic(statePath, state);
  process.stdout.write(`COMPLETED ${definition.animationName}/${frame.frameKey} ${dimensions.width}x${dimensions.height} ${state.frames[frame.frameKey].outputSha256}\n`);
}

async function main() {
  const animationName = parseArg('--animation');
  const definition = animationDefinition(animationName);
  const requestedFrame = parseArg('--frame');
  const all = hasArg('--all');
  const referenceMode = parseArg('--reference-mode', 'full');
  const referenceConfig = referenceModes[referenceMode];
  invariant(referenceConfig, `Unknown --reference-mode. Choose one of: ${Object.keys(referenceModes).join(', ')}.`);
  const reviewedReject = parseArg('--reviewed-reject');
  invariant(all !== Boolean(requestedFrame), 'Choose exactly one of --all or --frame=<key>.');
  invariant(!reviewedReject || Boolean(requestedFrame), '--reviewed-reject requires exactly one --frame=<key>.');
  const frames = all
    ? definition.frames
    : definition.frames.filter(({ frameKey }) => frameKey === requestedFrame);
  invariant(frames.length > 0, `Unknown frame for ${animationName}: ${requestedFrame}`);
  const storyboardPrepared = definition.storyboard ? prepareStoryboardPoses(definition) : null;
  const preparedFrames = frames.map((frame) => ({
    frame,
    prepared: storyboardPrepared?.get(frame.frameKey) ?? preparePose(definition, frame),
  }));

  if (hasArg('--prepare-only')) {
    process.stdout.write(`${JSON.stringify({
      status: 'prepared-only',
      animationName,
      sequence: definition.sequence,
      uniqueFrames: definition.frames.map(({ frameKey }) => frameKey),
      prepared: preparedFrames.map(({ frame, prepared }) => ({
        frameKey: frame.frameKey,
        path: portablePath(prepared.outputPath),
        sha256: sha256(prepared.bytes),
        geometry: prepared.geometry,
        extraction: prepared.extraction ?? null,
      })),
      plannedCalls: frames.length,
      referenceMode,
      referenceOrder: referenceConfig.referenceOrder,
      plannedCostMicrocredits: frames.length * referenceConfig.expectedCostMicrocredits,
    }, null, 2)}\n`);
    return;
  }

  invariant(parseArg('--confirm') === confirmation, `Refusing paid generation without --confirm=${confirmation}.`);
  const apiKey = process.env.FAL_API_KEY?.trim() ?? '';
  invariant(apiKey, 'FAL_API_KEY is required.');
  const { statePath, state } = readState(definition);
  invariant(JSON.stringify(state.sequence) === JSON.stringify(definition.sequence), `${animationName} sequence drifted.`);
  process.stdout.write(`PLAN ${animationName} ${frames.length} frame(s), reference mode ${referenceMode}, at most ${frames.length * referenceConfig.expectedCostMicrocredits} microcredits, no automatic retries\n`);
  for (const { frame, prepared } of preparedFrames) {
    await generateFrame(definition, frame, prepared, statePath, state, apiKey, {
      referenceMode,
      referenceConfig,
      reviewedReject,
    });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
