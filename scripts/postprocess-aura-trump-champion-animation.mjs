import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { XAI_CANONICAL_BUNDLE_CLEANUP } from './arcade-xai-canonical-bundle.mjs';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const templateRoot = join(repositoryRoot, 'artifacts/aura-animation-canary/template-zero');
const subjectRoot = join(repositoryRoot, 'artifacts/aura-animation-canary/donald-trump');
const runtimeRoot = join(repositoryRoot, 'public/assets/aura/donald-trump');
const analysisWidth = 1536;
const analysisHeight = 2048;
const alphaThreshold = 16;
const authoredScale = 4;
const supportedAnimations = Object.freeze([
  'aura_unbothered',
  'aura_mog_check',
  'aura_glide',
  'aura_floor_worm',
  'aura_one_leg',
  'aura_shrug',
]);

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

function sha256File(path) {
  invariant(existsSync(path), `Missing file: ${path}`);
  return sha256(readFileSync(path));
}

function nowIso() {
  return new Date().toISOString();
}

function portablePath(path) {
  const absolutePath = resolve(path);
  invariant(absolutePath.startsWith(`${repositoryRoot}/`), `Path is outside the repository: ${absolutePath}`);
  return absolutePath.slice(repositoryRoot.length + 1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.binary ? null : 'utf8',
    env: {
      ...process.env,
      MAGICK_THREAD_LIMIT: '1',
      OMP_NUM_THREADS: '1',
    },
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${options.label || command} failed: ${(result.stderr || result.stdout || '').toString().trim()}`);
  }
  return result.stdout;
}

function runMagick(args, options = {}) {
  return run('magick', args, options);
}

function runFfmpeg(args, options = {}) {
  return run('ffmpeg', args, options);
}

function inspectPng(path, label, stagingRoot = null, processedRoot = null) {
  const bytes = readFileSync(path);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  invariant(bytes.length >= 29 && bytes.subarray(0, 8).equals(signature), `${label} is not PNG.`);
  let finalPath = path;
  if (stagingRoot && processedRoot && path.startsWith(`${stagingRoot}/`)) {
    finalPath = join(processedRoot, path.slice(stagingRoot.length + 1));
  }
  return {
    path: portablePath(finalPath),
    sha256: sha256(bytes),
    sizeBytes: bytes.length,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorTypeCode: bytes[25],
  };
}

function normalizeProviderCanvas(sourcePath, destinationPath, label) {
  runMagick([
    sourcePath,
    '-background', '#00FF00',
    '-alpha', 'background',
    '-alpha', 'off',
    '-filter', 'Lanczos',
    '-resize', `${analysisWidth}x${analysisHeight}!`,
    '-depth', '8',
    '-strip',
    '-define', 'png:compression-level=9',
    `PNG24:${destinationPath}`,
  ], { label: `normalize provider canvas ${label}` });
}

function cleanChroma(sourcePath, destinationPath, label) {
  runFfmpeg([
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-y',
    '-threads', '1',
    '-filter_threads', '1',
    '-filter_complex_threads', '1',
    '-i', sourcePath,
    '-filter_complex', XAI_CANONICAL_BUNDLE_CLEANUP.filter,
    '-map', '[out]',
    '-an',
    '-sn',
    '-dn',
    '-frames:v', '1',
    '-compression_level', '9',
    destinationPath,
  ], { label: `chroma cleanup ${label}` });
  const png = inspectPng(destinationPath, `${label} matte`);
  invariant(
    png.width === analysisWidth
      && png.height === analysisHeight
      && png.bitDepth === 8
      && png.colorTypeCode === 6,
    `${label} matte must be RGBA8 ${analysisWidth}x${analysisHeight}.`,
  );
}

function analyzeRgba(path, width, height, label) {
  const pixels = runMagick([
    path,
    '-depth', '8',
    'RGBA:-',
  ], {
    binary: true,
    label: `decode ${label}`,
    maxBuffer: width * height * 4 + 1024,
  });
  invariant(pixels.length === width * height * 4, `${label} returned ${pixels.length} RGBA bytes.`);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let foregroundPixels = 0;
  let partialAlphaPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = pixels[(y * width + x) * 4 + 3];
      if (alpha > 0 && alpha < 255) partialAlphaPixels += 1;
      if (alpha < alphaThreshold) continue;
      foregroundPixels += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  invariant(foregroundPixels > 0, `${label} has no foreground.`);
  const bbox = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  return {
    alphaThreshold,
    foregroundPixels,
    partialAlphaPixels,
    bbox,
    center: { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 },
    rootY: bbox.y + bbox.h,
    touchesCanvasEdge: bbox.x === 0
      || bbox.y === 0
      || bbox.x + bbox.w === width
      || bbox.y + bbox.h === height,
  };
}

function extractRuntimeTarget(atlasPath, destinationPath, runtime, sequenceIndex, label) {
  const column = sequenceIndex % runtime.gridColumns;
  const row = Math.floor(sequenceIndex / runtime.gridColumns);
  const x = column * runtime.frameWidth;
  const y = row * runtime.frameHeight;
  runMagick([
    atlasPath,
    '-crop', `${runtime.frameWidth}x${runtime.frameHeight}+${x}+${y}`,
    '+repage',
    '-depth', '8',
    '-strip',
    '-define', 'png:compression-level=9',
    `PNG32:${destinationPath}`,
  ], { label: `extract Template Zero runtime target ${label}` });
}

function authoredPlacement(current, target, cellWidth, cellHeight) {
  const outputWidth = cellWidth * authoredScale;
  const outputHeight = cellHeight * authoredScale;
  const targetCenterX = target.center.x * authoredScale;
  const targetRootY = target.rootY * authoredScale;
  const targetHeightScale = (target.bbox.h * authoredScale) / current.bbox.h;
  const centeredWidthLimit = (2 * Math.min(targetCenterX, outputWidth - targetCenterX)) / current.bbox.w;
  const rootHeightLimit = targetRootY / current.bbox.h;
  const scale = Math.min(targetHeightScale, centeredWidthLimit, rootHeightLimit);
  const width = Math.max(1, Math.round(current.bbox.w * scale));
  const height = Math.max(1, Math.round(current.bbox.h * scale));
  const x = Math.round(targetCenterX - width / 2);
  const y = Math.round(targetRootY - height);
  return {
    algorithm: 'target-runtime-height-root-center-uniform-v1',
    uniformScale: scale,
    scaleLimitedBy: scale === targetHeightScale
      ? 'target_height'
      : scale === centeredWidthLimit
        ? 'centered_cell_width'
        : 'root_height',
    currentBbox: current.bbox,
    targetRuntimeBbox: target.bbox,
    placement: {
      x,
      y,
      w: width,
      h: height,
      canvasWidth: outputWidth,
      canvasHeight: outputHeight,
      canFitCanvas: x >= 0 && y >= 0 && x + width <= outputWidth && y + height <= outputHeight,
    },
  };
}

function compositeAuthoredFrame(sourcePath, destinationPath, comparison, label) {
  const source = comparison.currentBbox;
  const placement = comparison.placement;
  invariant(placement.canFitCanvas, `${label} authored placement would leave the canvas.`);
  runMagick([
    '-size', `${placement.canvasWidth}x${placement.canvasHeight}`,
    'canvas:none',
    '(',
    sourcePath,
    '-crop', `${source.w}x${source.h}+${source.x}+${source.y}`,
    '+repage',
    '-filter', 'Lanczos',
    '-resize', `${placement.w}x${placement.h}!`,
    ')',
    '-geometry', `+${placement.x}+${placement.y}`,
    '-composite',
    '-depth', '8',
    '-strip',
    '-define', 'png:compression-level=9',
    `PNG32:${destinationPath}`,
  ], { label: `compose authored frame ${label}` });
}

function downsampleRuntime(sourcePath, destinationPath, runtime, label) {
  runMagick([
    sourcePath,
    '-filter', 'Lanczos',
    '-resize', `${runtime.frameWidth}x${runtime.frameHeight}!`,
    '-depth', '8',
    '-strip',
    '-define', 'png:compression-level=9',
    `PNG32:${destinationPath}`,
  ], { label: `downsample runtime frame ${label}` });
}

function buildAtlas(framePaths, destinationPath, runtime, label) {
  runMagick([
    'montage',
    ...framePaths,
    '-tile', `${runtime.gridColumns}x${runtime.gridRows}`,
    '-geometry', `${runtime.frameWidth}x${runtime.frameHeight}+0+0`,
    '-background', 'none',
    '-depth', '8',
    '-define', 'png:compression-level=9',
    `PNG32:${destinationPath}`,
  ], { label: `build ${label}` });
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.writing-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function processAnimation(animationName) {
  invariant(supportedAnimations.includes(animationName), `Unsupported Aura animation: ${animationName}`);
  const animationRoot = join(subjectRoot, animationName);
  const championRoot = join(animationRoot, 'champion');
  const statePath = join(championRoot, 'generation-state.json');
  const templateManifestPath = join(templateRoot, animationName, 'manifest.json');
  const processedRoot = join(championRoot, 'processed');
  const runtimePath = join(runtimeRoot, `${animationName}.png`);
  invariant(existsSync(statePath), `Missing generation state: ${statePath}`);
  invariant(existsSync(templateManifestPath), `Missing Template Zero manifest: ${templateManifestPath}`);
  invariant(!existsSync(processedRoot), `Refusing to replace existing processed artifacts: ${processedRoot}`);

  const generationState = JSON.parse(readFileSync(statePath, 'utf8'));
  const templateManifest = JSON.parse(readFileSync(templateManifestPath, 'utf8'));
  const runtime = templateManifest.runtime;
  invariant(runtime?.frameCount === 8 && runtime.gridColumns === 4 && runtime.gridRows === 2, `${animationName} runtime grid drifted.`);
  const expectedSequence = templateManifest.keyframes?.sequence
    ?? Array.from({ length: runtime.frameCount }, (_, index) => `frame${String(index + 1).padStart(2, '0')}`);
  invariant(JSON.stringify(generationState.sequence) === JSON.stringify(expectedSequence), `${animationName} generated sequence drifted.`);
  const sequence = expectedSequence;
  const uniqueFrameKeys = [...new Set(sequence)];
  const templateAtlasPath = resolve(repositoryRoot, runtime.path);
  invariant(sha256File(templateAtlasPath) === runtime.sha256, `${animationName} Template Zero runtime atlas drifted.`);
  for (const frameKey of uniqueFrameKeys) {
    const generated = generationState.frames[frameKey];
    invariant(generated?.status === 'completed', `Generated frame is incomplete: ${animationName}/${frameKey}`);
    invariant(sha256File(resolve(repositoryRoot, generated.outputPath)) === generated.outputSha256, `Generated frame hash drifted: ${animationName}/${frameKey}`);
  }

  const stagingRoot = `${processedRoot}.writing-${process.pid}-${randomUUID()}`;
  const directories = ['normalized-rgb', 'matte-rgba', 'target-runtime', 'authored-4x', 'runtime-1x'];
  for (const directory of directories) mkdirSync(join(stagingRoot, directory), { recursive: true, mode: 0o700 });

  try {
    const frames = [];
    for (const [uniqueIndex, frameKey] of uniqueFrameKeys.entries()) {
      const sequenceIndex = sequence.indexOf(frameKey);
      const generated = generationState.frames[frameKey];
      const rawPath = resolve(repositoryRoot, generated.outputPath);
      const normalizedPath = join(stagingRoot, 'normalized-rgb', `${frameKey}.png`);
      const mattePath = join(stagingRoot, 'matte-rgba', `${frameKey}.png`);
      const targetPath = join(stagingRoot, 'target-runtime', `${frameKey}.png`);
      const authoredPath = join(stagingRoot, 'authored-4x', `${frameKey}.png`);
      const runtimeFramePath = join(stagingRoot, 'runtime-1x', `${frameKey}.png`);

      normalizeProviderCanvas(rawPath, normalizedPath, `${animationName}/${frameKey}`);
      cleanChroma(normalizedPath, mattePath, `${animationName}/${frameKey}`);
      extractRuntimeTarget(templateAtlasPath, targetPath, runtime, sequenceIndex, `${animationName}/${frameKey}`);
      const current = analyzeRgba(mattePath, analysisWidth, analysisHeight, `${animationName}/${frameKey} generated matte`);
      const target = analyzeRgba(targetPath, runtime.frameWidth, runtime.frameHeight, `${animationName}/${frameKey} runtime target`);
      invariant(!current.touchesCanvasEdge, `${animationName}/${frameKey} generated foreground is cropped.`);
      invariant(!target.touchesCanvasEdge, `${animationName}/${frameKey} Template Zero target touches its cell edge.`);
      const comparison = authoredPlacement(current, target, runtime.frameWidth, runtime.frameHeight);
      compositeAuthoredFrame(mattePath, authoredPath, comparison, `${animationName}/${frameKey}`);
      downsampleRuntime(authoredPath, runtimeFramePath, runtime, `${animationName}/${frameKey}`);
      const authored = analyzeRgba(
        authoredPath,
        runtime.frameWidth * authoredScale,
        runtime.frameHeight * authoredScale,
        `${animationName}/${frameKey} authored`,
      );
      const compiled = analyzeRgba(runtimeFramePath, runtime.frameWidth, runtime.frameHeight, `${animationName}/${frameKey} runtime`);
      const centerError = compiled.center.x - target.center.x;
      const rootError = compiled.rootY - target.rootY;
      invariant(Math.abs(centerError) <= 2, `${animationName}/${frameKey} runtime center error exceeds 2px.`);
      invariant(Math.abs(rootError) <= 2, `${animationName}/${frameKey} runtime root error exceeds 2px.`);
      const findings = [];
      if (comparison.scaleLimitedBy !== 'target_height') findings.push(`scale_limited_by_${comparison.scaleLimitedBy}`);
      const widthRatio = compiled.bbox.w / target.bbox.w;
      if (Math.abs(widthRatio - 1) > 0.15) findings.push('runtime_width_ratio_differs_over_15_percent');
      frames.push({
        frameKey,
        firstSequenceIndex: sequenceIndex,
        generatedRaw: inspectPng(rawPath, `${animationName}/${frameKey} raw`),
        authored4x: inspectPng(authoredPath, `${animationName}/${frameKey} authored`, stagingRoot, processedRoot),
        runtime1x: inspectPng(runtimeFramePath, `${animationName}/${frameKey} runtime`, stagingRoot, processedRoot),
        geometry: { current, target, comparison, authored, compiled, centerError, rootError, widthRatio },
        findings,
      });
      process.stdout.write(`PROCESSED ${animationName} ${uniqueIndex + 1}/${uniqueFrameKeys.length} ${frameKey}\n`);
    }

    rmSync(join(stagingRoot, 'normalized-rgb'), { recursive: true, force: true });
    rmSync(join(stagingRoot, 'matte-rgba'), { recursive: true, force: true });
    const runtimeFrames = sequence.map((frameKey) => join(stagingRoot, 'runtime-1x', `${frameKey}.png`));
    const runtimeAtlasPath = join(stagingRoot, `${animationName}-runtime.png`);
    buildAtlas(runtimeFrames, runtimeAtlasPath, runtime, `${animationName} runtime atlas`);
    const runtimeAtlas = inspectPng(runtimeAtlasPath, `${animationName} runtime atlas`, stagingRoot, processedRoot);
    invariant(
      runtimeAtlas.width === runtime.frameWidth * runtime.gridColumns
        && runtimeAtlas.height === runtime.frameHeight * runtime.gridRows,
      `${animationName} runtime atlas dimensions drifted.`,
    );

    const previewPath = join(stagingRoot, 'gesture-preview.gif');
    runMagick([
      '-delay', '10',
      ...runtimeFrames,
      '-delay', '18',
      runtimeFrames.at(-1),
      '-loop', '0',
      previewPath,
    ], { label: `${animationName} animated preview` });
    const contactSheetPath = join(stagingRoot, 'runtime-contact-sheet.png');
    runMagick([
      'montage',
      ...runtimeFrames,
      '-thumbnail', `${runtime.frameWidth * 2}x${runtime.frameHeight * 2}`,
      '-tile', '4x2',
      '-geometry', '+12+12',
      '-background', '#151515',
      '-depth', '8',
      contactSheetPath,
    ], { label: `${animationName} runtime contact sheet` });

    const selectedCostMicrocredits = Object.values(generationState.frames)
      .filter((record) => record.status === 'completed')
      .reduce((sum, record) => sum + (record.expectedCostMicrocredits ?? 0), 0);
    const rejectedCostMicrocredits = (generationState.rejectedAttempts ?? [])
      .reduce((sum, record) => sum + (record.expectedCostMicrocredits ?? 0), 0);
    const report = {
      schemaVersion: 1,
      status: 'champion_frames_runtime_ready_human_gameplay_review_required',
      createdAt: nowIso(),
      subject: 'donald-trump',
      animationName,
      process: {
        identityReference: 'Template Zero pose first; Trump original likeness reference; selected legacy canaries may retain the trusted Champion side anchor',
        generatedIndividually: true,
        wholeSheetGeneration: false,
        rawProviderResolution: '1776x2368',
        runtimeRegistration: 'uniform scale to the approved Template Zero runtime height, then horizontal-center and root alignment; no anatomy warp',
        authoredScale,
        chromaCleanupFilterSha256: sha256(XAI_CANONICAL_BUNDLE_CLEANUP.filter),
      },
      sequence,
      uniqueGeneratedFrames: uniqueFrameKeys.length,
      paidCalls: {
        selected: uniqueFrameKeys.length,
        rejected: generationState.rejectedAttempts?.length ?? 0,
        selectedCostMicrocredits,
        rejectedCostMicrocredits,
        observedAttemptCostMicrocredits: selectedCostMicrocredits + rejectedCostMicrocredits,
      },
      templateRuntime: inspectPng(templateAtlasPath, `${animationName} Template Zero runtime`),
      frames,
      runtimeAtlas,
      preview: portablePath(previewPath.replace(stagingRoot, processedRoot)),
      contactSheet: inspectPng(contactSheetPath, `${animationName} contact sheet`, stagingRoot, processedRoot),
      runtimePromotion: {
        targetPath: portablePath(runtimePath),
        previousRuntimeArchived: existsSync(runtimePath),
      },
      toolchain: {
        imageMagick: runMagick(['-version']).split(/\r?\n/, 1)[0],
        ffmpeg: runFfmpeg(['-version']).split(/\r?\n/, 1)[0],
      },
    };
    writeJsonAtomic(join(stagingRoot, 'report.json'), report);
    renameSync(stagingRoot, processedRoot);

    if (existsSync(runtimePath)) {
      const backupPath = join(championRoot, 'replaced', 'development-runtime-before-champion.png');
      mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
      invariant(!existsSync(backupPath), `Runtime backup already exists: ${backupPath}`);
      copyFileSync(runtimePath, backupPath);
      chmodSync(backupPath, 0o600);
    }
    mkdirSync(dirname(runtimePath), { recursive: true });
    const runtimeTemporary = `${runtimePath}.writing-${process.pid}`;
    copyFileSync(join(processedRoot, `${animationName}-runtime.png`), runtimeTemporary);
    renameSync(runtimeTemporary, runtimePath);
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      animationName,
      reportSha256: sha256File(join(processedRoot, 'report.json')),
      runtimeSha256: sha256File(runtimePath),
      selectedCostMicrocredits,
      rejectedCostMicrocredits,
    })}\n`);
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function main() {
  invariant(hasArg('--write'), 'Pass --write to create Champion artifacts and replace the development runtime atlas.');
  const requestedAnimation = parseArg('--animation');
  const all = hasArg('--all');
  invariant(all !== Boolean(requestedAnimation), 'Choose exactly one of --all or --animation=<name>.');
  const animations = all ? supportedAnimations : [requestedAnimation];
  for (const animationName of animations) processAnimation(animationName);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
