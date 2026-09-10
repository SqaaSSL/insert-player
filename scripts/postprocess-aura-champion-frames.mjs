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
const animationRoot = join(
  repositoryRoot,
  'artifacts/aura-animation-canary/donald-trump/aura_six_seven',
);
const championRoot = join(animationRoot, 'champion');
const statePath = join(championRoot, 'generation-state.json');
const templateManifestPath = join(
  repositoryRoot,
  'artifacts/aura-animation-canary/template-zero/aura_six_seven/manifest.json',
);
const processedRoot = join(championRoot, 'processed');
const runtimePath = join(repositoryRoot, 'public/assets/aura/donald-trump/aura_six_seven.png');
const analysisWidth = 1536;
const analysisHeight = 2048;
const alphaThreshold = 16;

const uniqueFrameKeys = Object.freeze([
  'previous01',
  'leftHandHigh',
  'previous03',
  'rightHandHigh',
  'previous05',
  'previous07',
]);
const sequence = Object.freeze([
  'previous01',
  'leftHandHigh',
  'previous03',
  'rightHandHigh',
  'previous05',
  'leftHandHigh',
  'previous07',
  'rightHandHigh',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
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

function inspectPng(path, label) {
  const bytes = readFileSync(path);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  invariant(bytes.length >= 29 && bytes.subarray(0, 8).equals(signature), `${label} is not PNG.`);
  let finalPath = path;
  if (path.startsWith(`${processedRoot}.writing-`)) {
    const suffixStart = path.indexOf('/', `${processedRoot}.writing-`.length);
    invariant(suffixStart >= 0, `Cannot map staging artifact path: ${path}`);
    finalPath = join(processedRoot, path.slice(suffixStart + 1));
  }
  return {
    path: finalPath.slice(repositoryRoot.length + 1),
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

function normalizeTemplatePose(sourcePath, destinationPath, label) {
  runMagick([
    sourcePath,
    '(',
    '+clone',
    '-fx', 'g > 0.45 && g > r * 1.35 && g > b * 1.35 ? 0 : 1',
    ')',
    '-alpha', 'off',
    '-compose', 'CopyOpacity',
    '-composite',
    '-background', '#00FF00',
    '-alpha', 'background',
    '-alpha', 'off',
    '-filter', 'Lanczos',
    '-resize', `${analysisWidth}x${analysisHeight}!`,
    '-depth', '8',
    '-strip',
    '-define', 'png:compression-level=9',
    `PNG24:${destinationPath}`,
  ], { label: `normalize Template Zero pose ${label}` });
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

function analyzeMatte(path, label) {
  const pixels = runMagick([
    path,
    '-depth', '8',
    'RGBA:-',
  ], {
    binary: true,
    label: `decode ${label}`,
    maxBuffer: analysisWidth * analysisHeight * 4 + 1024,
  });
  invariant(
    pixels.length === analysisWidth * analysisHeight * 4,
    `${label} returned ${pixels.length} RGBA bytes.`,
  );
  let minX = analysisWidth;
  let minY = analysisHeight;
  let maxX = -1;
  let maxY = -1;
  let foregroundPixels = 0;
  let partialAlphaPixels = 0;
  for (let y = 0; y < analysisHeight; y += 1) {
    for (let x = 0; x < analysisWidth; x += 1) {
      const alpha = pixels[(y * analysisWidth + x) * 4 + 3];
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
  const bbox = {
    x: minX,
    y: minY,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
  };
  return {
    alphaThreshold,
    foregroundPixels,
    partialAlphaPixels,
    bbox,
    center: { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 },
    rootY: bbox.y + bbox.h,
    touchesCanvasEdge: bbox.x === 0
      || bbox.y === 0
      || bbox.x + bbox.w === analysisWidth
      || bbox.y + bbox.h === analysisHeight,
  };
}

function geometryComparison(current, target) {
  const uniformScale = target.bbox.h / current.bbox.h;
  const scaledWidth = Math.max(1, Math.round(current.bbox.w * uniformScale));
  const scaledHeight = target.bbox.h;
  const x = Math.round(target.center.x - scaledWidth / 2);
  const y = target.rootY - scaledHeight;
  return {
    currentBbox: current.bbox,
    targetBbox: target.bbox,
    uniformScale,
    widthRatioBefore: current.bbox.w / target.bbox.w,
    widthRatioAfter: scaledWidth / target.bbox.w,
    centerDeltaBeforePixels: current.center.x - target.center.x,
    rootDeltaBeforePixels: current.rootY - target.rootY,
    placement: {
      x,
      y,
      w: scaledWidth,
      h: scaledHeight,
      canFitCanvas: x >= 0
        && y >= 0
        && x + scaledWidth <= analysisWidth
        && y + scaledHeight <= analysisHeight,
    },
  };
}

function registerUniformly(sourcePath, destinationPath, comparison, label) {
  invariant(comparison.placement.canFitCanvas, `${label} registration would leave the canvas.`);
  const source = comparison.currentBbox;
  const placement = comparison.placement;
  runMagick([
    '-size', `${analysisWidth}x${analysisHeight}`,
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
  ], { label: `uniform registration ${label}` });
}

function resizeFrame(sourcePath, destinationPath, width, height, label) {
  runMagick([
    sourcePath,
    '-filter', 'Lanczos',
    '-resize', `${width}x${height}!`,
    '-depth', '8',
    '-strip',
    '-define', 'png:compression-level=9',
    `PNG32:${destinationPath}`,
  ], { label: `resize ${label}` });
}

function buildAtlas(framePaths, destinationPath, cellWidth, cellHeight, label) {
  runMagick([
    'montage',
    ...framePaths,
    '-tile', '4x2',
    '-geometry', `${cellWidth}x${cellHeight}+0+0`,
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

function main() {
  invariant(process.argv.includes('--write'), 'Pass --write to create Champion artifacts and replace the development runtime atlas.');
  invariant(existsSync(statePath), `Missing generation state: ${statePath}`);
  invariant(existsSync(templateManifestPath), `Missing Template Zero manifest: ${templateManifestPath}`);
  invariant(!existsSync(processedRoot), `Refusing to replace existing processed artifacts: ${processedRoot}`);

  const generationState = JSON.parse(readFileSync(statePath, 'utf8'));
  const templateManifest = JSON.parse(readFileSync(templateManifestPath, 'utf8'));
  invariant(
    JSON.stringify(templateManifest.keyframes.sequence) === JSON.stringify(sequence),
    'Template Zero approved sequence drifted.',
  );
  const templateFrames = templateManifest.keyframes;
  for (const frameKey of uniqueFrameKeys) {
    const generated = generationState.frames[frameKey];
    const template = templateFrames[frameKey];
    invariant(generated?.status === 'completed', `Generated frame is incomplete: ${frameKey}`);
    invariant(template?.path && template?.sha256, `Template frame is missing: ${frameKey}`);
    invariant(sha256File(resolve(repositoryRoot, generated.outputPath)) === generated.outputSha256, `Generated frame hash drifted: ${frameKey}`);
    invariant(sha256File(resolve(repositoryRoot, template.path)) === template.sha256, `Template frame hash drifted: ${frameKey}`);
  }

  const stagingRoot = `${processedRoot}.writing-${process.pid}`;
  invariant(!existsSync(stagingRoot), `Staging directory exists: ${stagingRoot}`);
  const directories = [
    'normalized-rgb',
    'matte-rgba',
    'target-rgb',
    'target-rgba',
    'registered-rgba',
    'authored-2x',
    'runtime-1x',
  ];
  for (const directory of directories) mkdirSync(join(stagingRoot, directory), { recursive: true, mode: 0o700 });

  try {
    const frames = [];
    for (const [index, frameKey] of uniqueFrameKeys.entries()) {
      const generated = generationState.frames[frameKey];
      const template = templateFrames[frameKey];
      const rawPath = resolve(repositoryRoot, generated.outputPath);
      const templatePath = resolve(repositoryRoot, template.path);
      const normalizedPath = join(stagingRoot, 'normalized-rgb', `${frameKey}.png`);
      const mattePath = join(stagingRoot, 'matte-rgba', `${frameKey}.png`);
      const targetRgbPath = join(stagingRoot, 'target-rgb', `${frameKey}.png`);
      const targetRgbaPath = join(stagingRoot, 'target-rgba', `${frameKey}.png`);
      const registeredPath = join(stagingRoot, 'registered-rgba', `${frameKey}.png`);
      const authored2xPath = join(stagingRoot, 'authored-2x', `${frameKey}.png`);
      const runtime1xPath = join(stagingRoot, 'runtime-1x', `${frameKey}.png`);

      normalizeProviderCanvas(rawPath, normalizedPath, frameKey);
      cleanChroma(normalizedPath, mattePath, frameKey);
      normalizeTemplatePose(templatePath, targetRgbPath, frameKey);
      cleanChroma(targetRgbPath, targetRgbaPath, `${frameKey} target`);
      const current = analyzeMatte(mattePath, `${frameKey} generated matte`);
      const target = analyzeMatte(targetRgbaPath, `${frameKey} target matte`);
      const comparison = geometryComparison(current, target);
      registerUniformly(mattePath, registeredPath, comparison, frameKey);
      const registered = analyzeMatte(registeredPath, `${frameKey} registered matte`);
      const centerError = registered.center.x - target.center.x;
      const rootError = registered.rootY - target.rootY;
      const findings = [];
      if (current.touchesCanvasEdge) findings.push('generated_foreground_touches_canvas');
      if (target.touchesCanvasEdge) findings.push('target_foreground_touches_canvas');
      if (Math.abs(comparison.uniformScale - 1) > 0.15) findings.push('scale_deviation_over_15_percent');
      if (Math.abs(comparison.widthRatioAfter - 1) > 0.08) findings.push('width_ratio_after_registration_over_8_percent');
      if (Math.abs(centerError) > 2) findings.push('registered_center_error_over_2_pixels');
      if (Math.abs(rootError) > 2) findings.push('registered_root_error_over_2_pixels');
      invariant(!findings.includes('generated_foreground_touches_canvas'), `${frameKey} generated foreground is cropped.`);
      invariant(comparison.placement.canFitCanvas, `${frameKey} registration does not fit.`);
      invariant(Math.abs(centerError) <= 2 && Math.abs(rootError) <= 2, `${frameKey} registration anchor error is too large.`);

      resizeFrame(registeredPath, authored2xPath, 768, 1024, `${frameKey} authored 2x`);
      resizeFrame(registeredPath, runtime1xPath, 192, 256, `${frameKey} runtime`);
      frames.push({
        frameKey,
        generatedRaw: inspectPng(rawPath, `${frameKey} raw`),
        templateSource: inspectPng(templatePath, `${frameKey} template`),
        registeredRgba: inspectPng(registeredPath, `${frameKey} registered`),
        authored2x: inspectPng(authored2xPath, `${frameKey} 2x`),
        runtime1x: inspectPng(runtime1xPath, `${frameKey} runtime`),
        geometry: { current, target, comparison, registered, centerError, rootError },
        findings,
      });
      process.stdout.write(`PROCESSED ${index + 1}/${uniqueFrameKeys.length} ${frameKey}\n`);
    }

    for (const transientDirectory of [
      'normalized-rgb',
      'matte-rgba',
      'target-rgb',
      'target-rgba',
    ]) {
      rmSync(join(stagingRoot, transientDirectory), { recursive: true, force: true });
    }

    const atlas2xPath = join(stagingRoot, 'aura_six_seven-2x.png');
    const runtimeAtlasPath = join(stagingRoot, 'aura_six_seven-runtime.png');
    const atlas2xFrames = sequence.map((frameKey) => join(stagingRoot, 'authored-2x', `${frameKey}.png`));
    const runtimeFrames = sequence.map((frameKey) => join(stagingRoot, 'runtime-1x', `${frameKey}.png`));
    buildAtlas(atlas2xFrames, atlas2xPath, 768, 1024, 'Champion 2x atlas');
    buildAtlas(runtimeFrames, runtimeAtlasPath, 192, 256, 'runtime atlas');

    const previewPath = join(stagingRoot, 'gesture-preview.gif');
    runMagick([
      '-delay', '10',
      ...runtimeFrames,
      '-delay', '18',
      runtimeFrames.at(-1),
      '-loop', '0',
      previewPath,
    ], { label: 'animated Champion preview' });

    const contactSheetPath = join(stagingRoot, 'registered-contact-sheet.png');
    runMagick([
      'montage',
      ...uniqueFrameKeys.map((frameKey) => join(stagingRoot, 'registered-rgba', `${frameKey}.png`)),
      '-thumbnail', '384x512',
      '-tile', '3x2',
      '-geometry', '+12+12',
      '-background', '#151515',
      '-depth', '8',
      contactSheetPath,
    ], { label: 'registered contact sheet' });

    const atlas2x = inspectPng(atlas2xPath, 'Champion atlas');
    const runtimeAtlas = inspectPng(runtimeAtlasPath, 'runtime atlas');
    invariant(atlas2x.width === 3072 && atlas2x.height === 2048, 'Champion atlas dimensions drifted.');
    invariant(runtimeAtlas.width === 768 && runtimeAtlas.height === 512, 'Runtime atlas dimensions drifted.');
    const report = {
      schemaVersion: 1,
      status: 'champion_frames_registered_runtime_ready_human_gameplay_review_required',
      createdAt: nowIso(),
      subject: 'donald-trump',
      animationName: 'aura_six_seven',
      process: {
        identityReference: 'trusted Trump Champion canonical plus original likeness safeguard',
        poseReference: 'six approved per-frame Template Zero poses',
        generatedIndividually: true,
        wholeSheetGeneration: false,
        rawProviderResolution: '1776x2368',
        registration: 'uniform scale plus x translation and root-aligned y translation; no anatomy warp',
        chromaCleanupFilterSha256: sha256(XAI_CANONICAL_BUNDLE_CLEANUP.filter),
      },
      sequence,
      uniqueGeneratedFrames: uniqueFrameKeys.length,
      paidCalls: {
        selected: uniqueFrameKeys.length,
        rejected: generationState.rejectedAttempts?.length ?? 0,
        costPerCallMicrocredits: 110_000,
        selectedCostMicrocredits: uniqueFrameKeys.length * 110_000,
        observedAttemptCostMicrocredits: (
          uniqueFrameKeys.length + (generationState.rejectedAttempts?.length ?? 0)
        ) * 110_000,
      },
      frames,
      atlas2x,
      runtimeAtlas,
      preview: inspectPng(contactSheetPath, 'registered contact sheet'),
      runtimePromotion: {
        targetPath: runtimePath.slice(repositoryRoot.length + 1),
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
    copyFileSync(join(processedRoot, 'aura_six_seven-runtime.png'), runtimeTemporary);
    renameSync(runtimeTemporary, runtimePath);
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      processedRoot,
      reportSha256: sha256File(join(processedRoot, 'report.json')),
      runtimeSha256: sha256File(runtimePath),
      atlas2xSha256: sha256File(join(processedRoot, 'aura_six_seven-2x.png')),
    })}\n`);
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
