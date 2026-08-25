import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createCanvas, loadImage, type Image } from '@napi-rs/canvas';

export const QA_POSE_ATLAS_ANIMATIONS = Object.freeze([
  'idle',
  'walk',
  'high_punch',
  'high_kick',
  'low_punch',
  'low_kick',
  'jump',
  'crouch',
  'hit',
  'ko',
  'victory',
] as const);

type AnimationName = typeof QA_POSE_ATLAS_ANIMATIONS[number];
type JsonRecord = Record<string, unknown>;

const EXPECTED_PLAYBACK_FRAME_COUNT: Record<AnimationName, number> = {
  idle: 8,
  walk: 16,
  high_punch: 7,
  high_kick: 7,
  low_punch: 7,
  low_kick: 7,
  jump: 4,
  crouch: 4,
  hit: 4,
  ko: 8,
  victory: 8,
};

const ALPHA_QA_THRESHOLD = 15;

export interface QaPoseAtlasSource {
  characterName: string;
  origin: string;
  photoHash: string;
  archiveFileName: string;
  archiveSha256: string;
  manifestSha256: string;
}

export interface QaPoseAtlasAnimation {
  animation: AnimationName;
  sourceId: string;
  versionId: string;
  qualityTier: string;
  processingVersion: number;
  spriteBlobPath: string;
  spriteSheetSha256: string;
  sourceFrameCount: number;
  grid: { columns: number; rows: number };
  playbackFrameIndices: number[];
  representativeFrameIndex: number;
  selectionRationale: string;
  impactOverride?: {
    id: string;
    bucket: string;
    jurisdiction: string;
    objectKey: string;
    contentSha256: string;
    reason: string;
  };
}

export interface QaPoseAtlasManifest {
  schemaVersion: 1;
  atlasId: string;
  status: 'qa_only';
  frame: { width: number; height: number };
  transferContract: {
    referenceOrder: ['pose_frame', 'canonical_character', 'identity_photo'];
    frameIsolation: 'independent';
    previousOutputChaining: false;
    automaticRetries: 0;
    fallbackPolicy: 'none';
    activationPolicy: 'human_review_required';
  };
  sources: Record<string, QaPoseAtlasSource>;
  animations: QaPoseAtlasAnimation[];
}

export interface QaPoseAtlasFrameArtifact {
  sourceFrameIndex: number;
  playbackIndex: number;
  path: string;
  pngSha256: string;
  pixelSha256: string;
  qa: {
    alphaThreshold: number;
    foregroundPixels: number;
    foregroundRatio: number;
    bounds: { x: number; y: number; width: number; height: number };
    margins: { top: number; right: number; bottom: number; left: number };
  };
}

export interface QaPoseAtlasBuildReport {
  schemaVersion: 1;
  atlasId: string;
  atlasManifestSha256: string;
  sources: Array<{
    sourceId: string;
    archiveFileName: string;
    archiveSha256: string;
    manifestSha256: string;
  }>;
  reviewSheet: { path: string; pngSha256: string };
  animations: Array<{
    animation: AnimationName;
    sourceId: string;
    versionId: string;
    spriteSheetSha256: string;
    representativePlaybackIndex: number;
    frames: QaPoseAtlasFrameArtifact[];
  }>;
}

interface ResolvedAnimation {
  config: QaPoseAtlasAnimation;
  source: QaPoseAtlasSource;
  sheet: Image;
  frames: Array<{
    sourceFrameIndex: number;
    playbackIndex: number;
    bytes: Buffer;
    pngSha256: string;
    pixelSha256: string;
    qa: QaPoseAtlasFrameArtifact['qa'];
  }>;
}

function sha256(bytes: Uint8Array | Uint8ClampedArray | string): string {
  const payload = typeof bytes === 'string'
    ? bytes
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return createHash('sha256').update(payload).digest('hex');
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function requireInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isInteger(value) || Number(value) < minimum) throw new Error(`${label} must be an integer >= ${minimum}.`);
  return Number(value);
}

function requireSha256(value: unknown, label: string): string {
  const hash = requireString(value, label);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`${label} must be a lowercase SHA-256 hash.`);
  return hash;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be a string array.`);
  }
  return value as string[];
}

function parseSource(value: unknown, label: string): QaPoseAtlasSource {
  const source = requireRecord(value, label);
  return {
    characterName: requireString(source.characterName, `${label}.characterName`),
    origin: requireString(source.origin, `${label}.origin`),
    photoHash: requireSha256(source.photoHash, `${label}.photoHash`),
    archiveFileName: requireString(source.archiveFileName, `${label}.archiveFileName`),
    archiveSha256: requireSha256(source.archiveSha256, `${label}.archiveSha256`),
    manifestSha256: requireSha256(source.manifestSha256, `${label}.manifestSha256`),
  };
}

function parseAnimation(value: unknown, index: number): QaPoseAtlasAnimation {
  const label = `animations[${index}]`;
  const animation = requireRecord(value, label);
  const animationName = requireString(animation.animation, `${label}.animation`);
  if (!QA_POSE_ATLAS_ANIMATIONS.includes(animationName as AnimationName)) {
    throw new Error(`${label}.animation is unknown: ${animationName}.`);
  }
  const grid = requireRecord(animation.grid, `${label}.grid`);
  const sourceFrameCount = requireInteger(animation.sourceFrameCount, `${label}.sourceFrameCount`, 1);
  const columns = requireInteger(grid.columns, `${label}.grid.columns`, 1);
  const rows = requireInteger(grid.rows, `${label}.grid.rows`, 1);
  if (columns * rows < sourceFrameCount) throw new Error(`${label}.grid cannot contain every source frame.`);
  if (!Array.isArray(animation.playbackFrameIndices) || animation.playbackFrameIndices.length === 0) {
    throw new Error(`${label}.playbackFrameIndices must not be empty.`);
  }
  const playbackFrameIndices = animation.playbackFrameIndices.map((entry, frameIndex) => {
    const parsed = requireInteger(entry, `${label}.playbackFrameIndices[${frameIndex}]`);
    if (parsed >= sourceFrameCount) throw new Error(`${label}.playbackFrameIndices[${frameIndex}] is outside the source sheet.`);
    return parsed;
  });
  if (new Set(playbackFrameIndices).size !== playbackFrameIndices.length) {
    throw new Error(`${label}.playbackFrameIndices must not contain duplicate source frames.`);
  }
  const expectedPlaybackFrames = EXPECTED_PLAYBACK_FRAME_COUNT[animationName as AnimationName];
  if (playbackFrameIndices.length !== expectedPlaybackFrames) {
    throw new Error(`${label}.playbackFrameIndices must contain ${expectedPlaybackFrames} runtime frames.`);
  }
  const representativeFrameIndex = requireInteger(
    animation.representativeFrameIndex,
    `${label}.representativeFrameIndex`,
  );
  if (!playbackFrameIndices.includes(representativeFrameIndex)) {
    throw new Error(`${label}.representativeFrameIndex must be present in playbackFrameIndices.`);
  }

  let impactOverride: QaPoseAtlasAnimation['impactOverride'];
  if (animation.impactOverride !== undefined) {
    const override = requireRecord(animation.impactOverride, `${label}.impactOverride`);
    impactOverride = {
      id: requireString(override.id, `${label}.impactOverride.id`),
      bucket: requireString(override.bucket, `${label}.impactOverride.bucket`),
      jurisdiction: requireString(override.jurisdiction, `${label}.impactOverride.jurisdiction`),
      objectKey: requireString(override.objectKey, `${label}.impactOverride.objectKey`),
      contentSha256: requireSha256(override.contentSha256, `${label}.impactOverride.contentSha256`),
      reason: requireString(override.reason, `${label}.impactOverride.reason`),
    };
  }

  return {
    animation: animationName as AnimationName,
    sourceId: requireString(animation.sourceId, `${label}.sourceId`),
    versionId: requireString(animation.versionId, `${label}.versionId`),
    qualityTier: requireString(animation.qualityTier, `${label}.qualityTier`),
    processingVersion: requireInteger(animation.processingVersion, `${label}.processingVersion`, 1),
    spriteBlobPath: requireString(animation.spriteBlobPath, `${label}.spriteBlobPath`),
    spriteSheetSha256: requireSha256(animation.spriteSheetSha256, `${label}.spriteSheetSha256`),
    sourceFrameCount,
    grid: { columns, rows },
    playbackFrameIndices,
    representativeFrameIndex,
    selectionRationale: requireString(animation.selectionRationale, `${label}.selectionRationale`),
    ...(impactOverride ? { impactOverride } : {}),
  };
}

export function parseQaPoseAtlasManifest(value: unknown): QaPoseAtlasManifest {
  const root = requireRecord(value, 'pose atlas');
  if (root.schemaVersion !== 1) throw new Error('pose atlas.schemaVersion must be 1.');
  if (root.status !== 'qa_only') throw new Error('pose atlas.status must remain qa_only until human approval.');
  const frame = requireRecord(root.frame, 'pose atlas.frame');
  const transfer = requireRecord(root.transferContract, 'pose atlas.transferContract');
  const referenceOrder = requireStringArray(transfer.referenceOrder, 'pose atlas.transferContract.referenceOrder');
  const expectedOrder = ['pose_frame', 'canonical_character', 'identity_photo'];
  if (referenceOrder.join('|') !== expectedOrder.join('|')) throw new Error('pose atlas reference order changed.');
  if (
    transfer.frameIsolation !== 'independent'
    || transfer.previousOutputChaining !== false
    || transfer.automaticRetries !== 0
    || transfer.fallbackPolicy !== 'none'
    || transfer.activationPolicy !== 'human_review_required'
  ) {
    throw new Error('pose atlas transfer safety contract changed.');
  }

  const sourceValues = requireRecord(root.sources, 'pose atlas.sources');
  const sources = Object.fromEntries(
    Object.entries(sourceValues).map(([sourceId, source]) => [sourceId, parseSource(source, `sources.${sourceId}`)]),
  );
  if (Object.keys(sources).length === 0) throw new Error('pose atlas must define at least one source.');
  if (!Array.isArray(root.animations)) throw new Error('pose atlas.animations must be an array.');
  const animations = root.animations.map(parseAnimation);
  const actualNames = animations.map((entry) => entry.animation);
  const duplicates = actualNames.filter((name, index) => actualNames.indexOf(name) !== index);
  if (duplicates.length > 0) throw new Error(`pose atlas has duplicate animations: ${[...new Set(duplicates)].join(', ')}.`);
  const missing = QA_POSE_ATLAS_ANIMATIONS.filter((name) => !actualNames.includes(name));
  if (missing.length > 0) throw new Error(`pose atlas is missing animations: ${missing.join(', ')}.`);
  for (const animation of animations) {
    if (!sources[animation.sourceId]) throw new Error(`${animation.animation} references unknown source ${animation.sourceId}.`);
  }

  return {
    schemaVersion: 1,
    atlasId: requireString(root.atlasId, 'pose atlas.atlasId'),
    status: 'qa_only',
    frame: {
      width: requireInteger(frame.width, 'pose atlas.frame.width', 1),
      height: requireInteger(frame.height, 'pose atlas.frame.height', 1),
    },
    transferContract: {
      referenceOrder: ['pose_frame', 'canonical_character', 'identity_photo'],
      frameIsolation: 'independent',
      previousOutputChaining: false,
      automaticRetries: 0,
      fallbackPolicy: 'none',
      activationPolicy: 'human_review_required',
    },
    sources,
    animations,
  };
}

export async function loadQaPoseAtlasManifest(path: string): Promise<{ manifest: QaPoseAtlasManifest; sha256: string }> {
  const bytes = await readFile(path);
  return {
    manifest: parseQaPoseAtlasManifest(JSON.parse(bytes.toString('utf8')) as unknown),
    sha256: sha256(bytes),
  };
}

function assertSafeBlobPath(path: string): void {
  if (!/^blobs\/sprites\/[a-zA-Z0-9_-]+\/pngblob\.png$/.test(path)) {
    throw new Error(`Unsafe or unsupported sprite blob path: ${path}.`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function verifySourceArchive(sourceId: string, source: QaPoseAtlasSource, archivePath: string): Promise<void> {
  if (basename(archivePath) !== source.archiveFileName) {
    throw new Error(`${sourceId} archive filename changed: expected ${source.archiveFileName}.`);
  }
  const actualHash = await sha256File(archivePath);
  if (actualHash !== source.archiveSha256) {
    throw new Error(`${sourceId} archive hash mismatch: expected ${source.archiveSha256}, got ${actualHash}.`);
  }
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, path);
}

async function readAndVerifySourceManifest(sourceId: string, source: QaPoseAtlasSource, sourceDir: string): Promise<JsonRecord> {
  const manifestPath = join(sourceDir, 'manifest.json');
  const bytes = await readFile(manifestPath);
  const actualHash = sha256(bytes);
  if (actualHash !== source.manifestSha256) {
    throw new Error(`${sourceId} manifest hash mismatch: expected ${source.manifestSha256}, got ${actualHash}.`);
  }
  const manifest = requireRecord(JSON.parse(bytes.toString('utf8')) as unknown, `${sourceId} export manifest`);
  if (manifest.characterName !== source.characterName || manifest.origin !== source.origin || manifest.photoHash !== source.photoHash) {
    throw new Error(`${sourceId} export identity does not match the frozen atlas source.`);
  }
  if (!Array.isArray(manifest.sprites)) throw new Error(`${sourceId} export has no sprite array.`);
  return manifest;
}

function findSpriteRecord(sourceId: string, manifest: JsonRecord, config: QaPoseAtlasAnimation): JsonRecord {
  const sprites = manifest.sprites as unknown[];
  const record = sprites.find((entry) => isRecord(entry) && entry.versionId === config.versionId);
  if (!record || !isRecord(record)) throw new Error(`${sourceId} is missing frozen sprite ${config.versionId}.`);
  const blob = requireRecord(record.pngBlob, `${sourceId}.${config.animation}.pngBlob`);
  const checks: Array<[unknown, unknown, string]> = [
    [record.animationName, config.animation, 'animationName'],
    [record.qualityTier, config.qualityTier, 'qualityTier'],
    [record.processingVersion, config.processingVersion, 'processingVersion'],
    [record.frameCount, config.sourceFrameCount, 'frameCount'],
    [blob.$blob, config.spriteBlobPath, 'pngBlob.$blob'],
  ];
  for (const [actual, expected, label] of checks) {
    if (actual !== expected) throw new Error(`${sourceId}.${config.animation}.${label} changed.`);
  }
  return record;
}

function measureFrameAlpha(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  label: string,
): QaPoseAtlasFrameArtifact['qa'] {
  let foregroundPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] <= ALPHA_QA_THRESHOLD) continue;
      foregroundPixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (foregroundPixels === 0) throw new Error(`${label} is fully transparent.`);
  const foregroundRatio = foregroundPixels / (width * height);
  if (foregroundRatio < 0.005 || foregroundRatio > 0.7) {
    throw new Error(`${label} foreground ratio is implausible: ${foregroundRatio.toFixed(6)}.`);
  }
  const margins = {
    top: minY,
    right: width - maxX - 1,
    bottom: height - maxY - 1,
    left: minX,
  };
  if (Object.values(margins).some((margin) => margin < 4)) {
    throw new Error(`${label} has less than four pixels of canvas margin and is not a safe pose master.`);
  }
  return {
    alphaThreshold: ALPHA_QA_THRESHOLD,
    foregroundPixels,
    foregroundRatio: Number(foregroundRatio.toFixed(6)),
    bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    margins,
  };
}

async function resolveAnimation(
  manifest: QaPoseAtlasManifest,
  config: QaPoseAtlasAnimation,
  sourceDir: string,
  sourceManifest: JsonRecord,
): Promise<ResolvedAnimation> {
  assertSafeBlobPath(config.spriteBlobPath);
  const source = manifest.sources[config.sourceId];
  const record = findSpriteRecord(config.sourceId, sourceManifest, config);
  if (record.frameWidth !== manifest.frame.width || record.frameHeight !== manifest.frame.height) {
    throw new Error(`${config.animation} source frame dimensions changed.`);
  }
  const sheetBytes = await readFile(join(sourceDir, config.spriteBlobPath));
  const sheetHash = sha256(sheetBytes);
  if (sheetHash !== config.spriteSheetSha256) {
    throw new Error(`${config.animation} sprite sheet hash mismatch: expected ${config.spriteSheetSha256}, got ${sheetHash}.`);
  }
  const sheet = await loadImage(sheetBytes);
  const expectedWidth = manifest.frame.width * config.grid.columns;
  const expectedHeight = manifest.frame.height * config.grid.rows;
  if (sheet.width !== expectedWidth || sheet.height !== expectedHeight) {
    throw new Error(`${config.animation} sprite dimensions changed: expected ${expectedWidth}x${expectedHeight}, got ${sheet.width}x${sheet.height}.`);
  }

  const frames = await Promise.all(config.playbackFrameIndices.map(async (sourceFrameIndex, playbackIndex) => {
    const canvas = createCanvas(manifest.frame.width, manifest.frame.height);
    const context = canvas.getContext('2d');
    const sourceX = (sourceFrameIndex % config.grid.columns) * manifest.frame.width;
    const sourceY = Math.floor(sourceFrameIndex / config.grid.columns) * manifest.frame.height;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      sheet,
      sourceX,
      sourceY,
      manifest.frame.width,
      manifest.frame.height,
      0,
      0,
      manifest.frame.width,
      manifest.frame.height,
    );
    const pixelBytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const bytes = await canvas.encode('png');
    return {
      sourceFrameIndex,
      playbackIndex,
      bytes,
      pngSha256: sha256(bytes),
      pixelSha256: sha256(pixelBytes),
      qa: measureFrameAlpha(
        pixelBytes,
        canvas.width,
        canvas.height,
        `${config.animation} source frame ${sourceFrameIndex + 1}`,
      ),
    };
  }));
  return { config, source, sheet, frames };
}

function drawReviewSheet(manifest: QaPoseAtlasManifest, resolved: ResolvedAnimation[]): Promise<Buffer> {
  const columns = 3;
  const rows = Math.ceil(resolved.length / columns);
  const cardWidth = 920;
  const cardHeight = 700;
  const imageAreaHeight = 610;
  const canvas = createCanvas(columns * cardWidth, rows * cardHeight);
  const context = canvas.getContext('2d');
  context.fillStyle = '#090b0d';
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (const [cardIndex, entry] of resolved.entries()) {
    const cardX = (cardIndex % columns) * cardWidth;
    const cardY = Math.floor(cardIndex / columns) * cardHeight;
    context.fillStyle = '#171b1f';
    context.fillRect(cardX + 8, cardY + 8, cardWidth - 16, cardHeight - 16);

    const maxWidth = cardWidth - 64;
    const maxHeight = imageAreaHeight - 48;
    const scale = Math.min(maxWidth / entry.sheet.width, maxHeight / entry.sheet.height);
    const drawWidth = entry.sheet.width * scale;
    const drawHeight = entry.sheet.height * scale;
    const drawX = cardX + (cardWidth - drawWidth) / 2;
    const drawY = cardY + 24 + (maxHeight - drawHeight) / 2;
    context.drawImage(entry.sheet, drawX, drawY, drawWidth, drawHeight);

    const playback = new Set(entry.config.playbackFrameIndices);
    for (let frameIndex = 0; frameIndex < entry.config.sourceFrameCount; frameIndex += 1) {
      const cellX = drawX + (frameIndex % entry.config.grid.columns) * manifest.frame.width * scale;
      const cellY = drawY + Math.floor(frameIndex / entry.config.grid.columns) * manifest.frame.height * scale;
      const cellWidth = manifest.frame.width * scale;
      const cellHeight = manifest.frame.height * scale;
      context.strokeStyle = frameIndex === entry.config.representativeFrameIndex
        ? '#ffd166'
        : playback.has(frameIndex) ? '#33d6a6' : '#66717c';
      context.lineWidth = frameIndex === entry.config.representativeFrameIndex ? 5 : 2;
      context.strokeRect(cellX + 1, cellY + 1, cellWidth - 2, cellHeight - 2);
      context.fillStyle = 'rgba(9, 11, 13, 0.82)';
      context.fillRect(cellX + 5, cellY + 5, 45, 30);
      context.fillStyle = '#ffffff';
      context.font = 'bold 18px sans-serif';
      context.fillText(String(frameIndex + 1), cellX + 15, cellY + 27);
    }

    context.fillStyle = '#ffffff';
    context.font = 'bold 28px sans-serif';
    context.fillText(entry.config.animation.toUpperCase(), cardX + 28, cardY + imageAreaHeight + 34);
    context.fillStyle = '#aeb8c2';
    context.font = '20px sans-serif';
    const sourceText = `${entry.source.characterName} · p${entry.config.processingVersion} · ${entry.frames.length}/${entry.config.sourceFrameCount} playback frames`;
    context.fillText(sourceText, cardX + 28, cardY + imageAreaHeight + 67);
  }
  return canvas.encode('png');
}

export async function buildQaPoseAtlas(options: {
  manifestPath: string;
  sourceDirs: Record<string, string>;
  archivePaths: Record<string, string>;
  outputDir: string;
}): Promise<QaPoseAtlasBuildReport> {
  if (await pathExists(options.outputDir)) {
    throw new Error(`Pose-atlas output already exists: ${options.outputDir}. Choose a new directory to preserve the previous build.`);
  }
  const loaded = await loadQaPoseAtlasManifest(options.manifestPath);
  const sourceManifests = new Map<string, JsonRecord>();
  for (const [sourceId, source] of Object.entries(loaded.manifest.sources)) {
    const sourceDir = options.sourceDirs[sourceId];
    if (!sourceDir) throw new Error(`Missing --source for ${sourceId}.`);
    const archivePath = options.archivePaths[sourceId];
    if (!archivePath) throw new Error(`Missing --archive for ${sourceId}.`);
    await verifySourceArchive(sourceId, source, archivePath);
    sourceManifests.set(sourceId, await readAndVerifySourceManifest(sourceId, source, sourceDir));
  }

  const resolved: ResolvedAnimation[] = [];
  for (const animation of loaded.manifest.animations) {
    resolved.push(await resolveAnimation(
      loaded.manifest,
      animation,
      options.sourceDirs[animation.sourceId],
      sourceManifests.get(animation.sourceId)!,
    ));
  }

  const temporaryDir = `${options.outputDir}.tmp-${process.pid}`;
  if (await pathExists(temporaryDir)) throw new Error(`Temporary pose-atlas output already exists: ${temporaryDir}.`);
  await mkdir(temporaryDir, { recursive: true, mode: 0o700 });
  const animationReports: QaPoseAtlasBuildReport['animations'] = [];
  for (const entry of resolved) {
    const frameReports: QaPoseAtlasFrameArtifact[] = [];
    for (const frame of entry.frames) {
      const relativePath = join(
        'frames',
        entry.config.animation,
        `playback-${String(frame.playbackIndex + 1).padStart(2, '0')}-source-${String(frame.sourceFrameIndex + 1).padStart(2, '0')}.png`,
      );
      await atomicWrite(join(temporaryDir, relativePath), frame.bytes);
      frameReports.push({
        sourceFrameIndex: frame.sourceFrameIndex,
        playbackIndex: frame.playbackIndex,
        path: relativePath.split('\\').join('/'),
        pngSha256: frame.pngSha256,
        pixelSha256: frame.pixelSha256,
        qa: frame.qa,
      });
    }
    animationReports.push({
      animation: entry.config.animation,
      sourceId: entry.config.sourceId,
      versionId: entry.config.versionId,
      spriteSheetSha256: entry.config.spriteSheetSha256,
      representativePlaybackIndex: entry.config.playbackFrameIndices.indexOf(entry.config.representativeFrameIndex),
      frames: frameReports,
    });
  }

  const reviewBytes = await drawReviewSheet(loaded.manifest, resolved);
  const reviewPath = 'qa-pose-atlas-review.png';
  await atomicWrite(join(temporaryDir, reviewPath), reviewBytes);
  const report: QaPoseAtlasBuildReport = {
    schemaVersion: 1,
    atlasId: loaded.manifest.atlasId,
    atlasManifestSha256: loaded.sha256,
    sources: Object.entries(loaded.manifest.sources).map(([sourceId, source]) => ({
      sourceId,
      archiveFileName: source.archiveFileName,
      archiveSha256: source.archiveSha256,
      manifestSha256: source.manifestSha256,
    })),
    reviewSheet: { path: reviewPath, pngSha256: sha256(reviewBytes) },
    animations: animationReports,
  };
  await atomicWrite(
    join(temporaryDir, 'derived-manifest.json'),
    Buffer.from(`${JSON.stringify(report, null, 2)}\n`),
  );
  await mkdir(dirname(options.outputDir), { recursive: true, mode: 0o700 });
  await rename(temporaryDir, options.outputDir);
  return report;
}

export function summarizeQaPoseAtlas(manifest: QaPoseAtlasManifest): string[] {
  return manifest.animations.map((animation) => {
    const override = animation.impactOverride ? ` + impact override ${animation.impactOverride.id}` : '';
    return `${animation.animation.padEnd(10)} ${animation.sourceId.padEnd(8)} p${animation.processingVersion} ${animation.playbackFrameIndices.length}/${animation.sourceFrameCount} frames${override}`;
  });
}
