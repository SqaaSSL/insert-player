import { createHash } from 'node:crypto';
import { ImageData, createCanvas, loadImage } from '@napi-rs/canvas';
import {
  DEFAULT_VIDEO_SPRITE_AUTOMATIC_SELECTION_POLICY,
  VIDEO_SPRITE_ACTION_PROFILES,
  VIDEO_SPRITE_ANIMATION_FORMAT,
  VIDEO_SPRITE_COMPILER_VERSION,
  VIDEO_SPRITE_FRAME_HEIGHT,
  VIDEO_SPRITE_FRAME_WIDTH,
  VIDEO_SPRITE_POLICY_VERSION,
  VIDEO_SPRITE_PROCESSING_VERSION,
  VIDEO_SPRITE_RAW_FRAME_HEIGHT,
  VIDEO_SPRITE_RAW_FRAME_WIDTH,
  VIDEO_SPRITE_REPORT_SCHEMA,
  VideoSpriteCompileError,
  decodeCanonicalBytes,
  decodeVideoBytes,
  parseVideoSpriteCompileRequest,
  type VideoSpriteCompileRequest,
  type VideoSpriteCompileResponse,
} from './videoSpriteContract.ts';
import {
  VIDEO_SPRITE_GATE_POLICY,
  compileVideoSpriteFrames,
  evaluateVideoSpriteSequence,
  translateVideoSpriteFrame,
  type VideoSpriteCoreCompileResult,
  type VideoSpriteRgbaFrame,
} from './videoSpriteCompilerCore.ts';
import {
  createFfmpegVideoSpriteMediaAdapter,
  type VideoSpriteExtractedMedia,
  type VideoSpriteMediaAdapter,
} from './videoSpriteMedia.ts';

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

const MAX_PERSISTED_SPRITE_BYTES = 32 * 1024 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024;

function assertArtifactSize(label: string, bytes: Uint8Array, maximum: number): void {
  if (bytes.byteLength === 0 || bytes.byteLength > maximum) {
    throw new VideoSpriteCompileError(
      'compiled_artifact_too_large',
      `${label} exceeds the deterministic persistence limit.`,
    );
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function decodeNormalizedPng(
  bytes: Buffer,
  sourceIndex: number | null,
  expectedWidth: number = VIDEO_SPRITE_FRAME_WIDTH,
  expectedHeight: number = VIDEO_SPRITE_FRAME_HEIGHT,
): Promise<VideoSpriteRgbaFrame> {
  let image;
  try {
    image = await loadImage(bytes);
  } catch {
    throw new VideoSpriteCompileError('invalid_normalized_frame', 'A normalized media frame is not a valid PNG.');
  }
  if (image.width !== expectedWidth || image.height !== expectedHeight) {
    throw new VideoSpriteCompileError(
      'invalid_normalized_dimensions',
      `Normalized frames must be ${expectedWidth}x${expectedHeight}.`,
    );
  }
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  const data = new Uint8ClampedArray(context.getImageData(0, 0, image.width, image.height).data);
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3];
    if (alpha === 0) {
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      continue;
    }
    if (alpha < 250 && data[offset + 1] > Math.max(data[offset], data[offset + 2]) + 8) {
      data[offset + 1] = Math.max(data[offset], data[offset + 2]);
    }
  }
  return {
    width: image.width,
    height: image.height,
    data,
    pngSha256: sha256(bytes),
    sourceIndex,
  };
}

function putFrame(
  context: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  frame: VideoSpriteRgbaFrame,
  x: number,
  y: number,
): void {
  context.putImageData(new ImageData(frame.data, frame.width, frame.height), x, y);
}

async function encodeFrame(frame: VideoSpriteRgbaFrame): Promise<Buffer> {
  const canvas = createCanvas(frame.width, frame.height);
  putFrame(canvas.getContext('2d'), frame, 0, 0);
  return canvas.encode('png');
}

async function composeSheet(frames: VideoSpriteRgbaFrame[], columns: number): Promise<{
  bytes: Buffer;
  width: number;
  height: number;
  columns: number;
  rows: number;
}> {
  const boundedColumns = Math.max(1, Math.min(columns, frames.length));
  const rows = Math.ceil(frames.length / boundedColumns);
  const frameWidth = frames[0]?.width ?? VIDEO_SPRITE_FRAME_WIDTH;
  const frameHeight = frames[0]?.height ?? VIDEO_SPRITE_FRAME_HEIGHT;
  const canvas = createCanvas(boundedColumns * frameWidth, rows * frameHeight);
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  frames.forEach((frame, index) => {
    putFrame(
      context,
      frame,
      (index % boundedColumns) * frameWidth,
      Math.floor(index / boundedColumns) * frameHeight,
    );
  });
  return {
    bytes: await canvas.encode('png'),
    width: canvas.width,
    height: canvas.height,
    columns: boundedColumns,
    rows,
  };
}

function resizeVideoSpriteFrame(
  frame: VideoSpriteRgbaFrame,
  width: number,
  height: number,
): VideoSpriteRgbaFrame {
  const source = createCanvas(frame.width, frame.height);
  putFrame(source.getContext('2d'), frame, 0, 0);
  const target = createCanvas(width, height);
  const context = target.getContext('2d');
  context.clearRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height);
  return {
    width,
    height,
    data: new Uint8ClampedArray(context.getImageData(0, 0, width, height).data),
    sourceIndex: frame.sourceIndex,
  };
}

async function composeContactSheet(frames: VideoSpriteRgbaFrame[]): Promise<{
  bytes: Buffer;
  width: number;
  height: number;
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
}> {
  const columns = Math.min(8, frames.length);
  const rows = Math.ceil(frames.length / columns);
  const cellWidth = VIDEO_SPRITE_FRAME_WIDTH / 2;
  const cellHeight = VIDEO_SPRITE_FRAME_HEIGHT / 2;
  const canvas = createCanvas(columns * cellWidth, rows * cellHeight);
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  for (const [index, frame] of frames.entries()) {
    const frameCanvas = createCanvas(frame.width, frame.height);
    putFrame(frameCanvas.getContext('2d'), frame, 0, 0);
    context.drawImage(
      frameCanvas,
      (index % columns) * cellWidth,
      Math.floor(index / columns) * cellHeight,
      cellWidth,
      cellHeight,
    );
  }
  return {
    bytes: await canvas.encode('png'),
    width: canvas.width,
    height: canvas.height,
    columns,
    rows,
    cellWidth,
    cellHeight,
  };
}

function verifyLineageHashes(
  request: VideoSpriteCompileRequest,
  videoSha256: string,
  canonicalSha256: string,
): void {
  if (request.lineage?.videoSha256 && request.lineage.videoSha256 !== videoSha256) {
    throw new VideoSpriteCompileError('video_hash_mismatch', 'Submitted video bytes do not match lineage.videoSha256.', 409);
  }
  if (request.lineage?.canonicalSha256 && request.lineage.canonicalSha256 !== canonicalSha256) {
    throw new VideoSpriteCompileError('canonical_hash_mismatch', 'Canonical bytes do not match lineage.canonicalSha256.', 409);
  }
}

export type VideoSpriteCompileResult = VideoSpriteCompileResponse;

export async function compileVideoSprite(
  body: unknown,
  options: { mediaAdapter?: VideoSpriteMediaAdapter } = {},
): Promise<VideoSpriteCompileResult> {
  const request = parseVideoSpriteCompileRequest(body);
  const videoBytes = decodeVideoBytes(request);
  const canonicalBytes = decodeCanonicalBytes(request);
  const videoSha256 = sha256(videoBytes);
  const canonicalSha256 = sha256(canonicalBytes);
  verifyLineageHashes(request, videoSha256, canonicalSha256);
  const media = await (options.mediaAdapter ?? createFfmpegVideoSpriteMediaAdapter())
    .extract(videoBytes, canonicalBytes);
  return compileExtractedVideoSprite(request, media, videoSha256, canonicalSha256);
}

export async function compileExtractedVideoSprite(
  request: VideoSpriteCompileRequest,
  media: VideoSpriteExtractedMedia,
  videoSha256: string,
  canonicalSha256: string,
): Promise<VideoSpriteCompileResult> {
  const automaticSelectionPolicy = request.automaticSelectionPolicy ??
    DEFAULT_VIDEO_SPRITE_AUTOMATIC_SELECTION_POLICY;
  const [canonical, ...videoFrames] = await Promise.all([
    decodeNormalizedPng(media.canonicalPng, null),
    ...media.videoFramePngs.map((bytes, index) => decodeNormalizedPng(bytes, index)),
  ]);
  let compiled: VideoSpriteCoreCompileResult;
  try {
    compiled = compileVideoSpriteFrames(
      request.action,
      canonical,
      videoFrames,
      request.selectedVideoIndices,
      automaticSelectionPolicy,
    );
  } catch (error) {
    throw new VideoSpriteCompileError(
      'frame_compilation_failed',
      error instanceof Error ? error.message : 'Video frame compilation failed.',
    );
  }
  const archivalMedia = await media.extractArchival(compiled.selectedVideoIndices);
  const archivalCanonical = await decodeNormalizedPng(
    archivalMedia.canonicalPng,
    null,
    VIDEO_SPRITE_RAW_FRAME_WIDTH,
    VIDEO_SPRITE_RAW_FRAME_HEIGHT,
  );
  const archivalVideoFrames = await Promise.all(archivalMedia.selectedVideoFramePngs.map((bytes, index) => (
    decodeNormalizedPng(
      bytes,
      compiled.selectedVideoIndices[index],
      VIDEO_SPRITE_RAW_FRAME_WIDTH,
      VIDEO_SPRITE_RAW_FRAME_HEIGHT,
    )
  )));
  const archivalSources = compiled.profile.sequenceFormat === 'loop'
    ? archivalVideoFrames
    : [archivalCanonical, ...archivalVideoFrames];
  if (archivalSources.length !== compiled.uniqueFrames.length) {
    throw new VideoSpriteCompileError(
      'archival_source_count_mismatch',
      'Archival source count does not match the deterministic unique-frame contract.',
    );
  }
  const archivalUniqueFrames = archivalSources.map((frame, index) => {
    const translation = compiled.translations[index];
    return translateVideoSpriteFrame(frame, translation.dx * 4, translation.dy * 4);
  });
  const runtimeCanonical = resizeVideoSpriteFrame(
    archivalCanonical,
    VIDEO_SPRITE_FRAME_WIDTH,
    VIDEO_SPRITE_FRAME_HEIGHT,
  );
  const runtimeRegistrationSources = archivalSources.map((frame) => (
    resizeVideoSpriteFrame(frame, VIDEO_SPRITE_FRAME_WIDTH, VIDEO_SPRITE_FRAME_HEIGHT)
  ));
  const runtimeUniqueFrames = archivalUniqueFrames.map((frame) => (
    resizeVideoSpriteFrame(frame, VIDEO_SPRITE_FRAME_WIDTH, VIDEO_SPRITE_FRAME_HEIGHT)
  ));
  const emittedEvaluation = evaluateVideoSpriteSequence(
    compiled.profile,
    runtimeCanonical,
    runtimeUniqueFrames,
    compiled.translations,
    runtimeRegistrationSources,
  );
  compiled = {
    ...compiled,
    uniqueFrames: runtimeUniqueFrames,
    playbackFrames: compiled.playback.map((index) => runtimeUniqueFrames[index]),
    ...emittedEvaluation,
  };
  const runtimePlaybackFrames = compiled.playback.map((index) => runtimeUniqueFrames[index]);
  const [runtimeSheet, rawSheet, uniqueSheet, contactSheet, uniqueFramePngs] = await Promise.all([
    composeSheet(runtimePlaybackFrames, 8),
    composeSheet(archivalUniqueFrames, 4),
    composeSheet(runtimeUniqueFrames, 8),
    composeContactSheet(videoFrames),
    Promise.all(archivalUniqueFrames.map(encodeFrame)),
  ]);
  assertArtifactSize('Runtime sprite sheet', runtimeSheet.bytes, MAX_PERSISTED_SPRITE_BYTES);
  assertArtifactSize('Raw unique-frame sheet', rawSheet.bytes, MAX_PERSISTED_SPRITE_BYTES);
  assertArtifactSize('Runtime unique-frame sheet', uniqueSheet.bytes, MAX_PERSISTED_SPRITE_BYTES);
  assertArtifactSize('All-frames contact sheet', contactSheet.bytes, MAX_PERSISTED_SPRITE_BYTES);
  for (const bytes of uniqueFramePngs) {
    assertArtifactSize('Raw unique frame', bytes, MAX_PERSISTED_SPRITE_BYTES);
  }
  const profile = VIDEO_SPRITE_ACTION_PROFILES[request.action];
  const decisionPolicySha256 = sha256(canonicalJson({
    policyVersion: VIDEO_SPRITE_POLICY_VERSION,
    actionProfile: profile,
    gates: VIDEO_SPRITE_GATE_POLICY,
  }));
  const reportWithoutHash = {
    schema: VIDEO_SPRITE_REPORT_SCHEMA,
    schemaVersion: 1 as const,
    compilerVersion: VIDEO_SPRITE_COMPILER_VERSION,
    policyVersion: VIDEO_SPRITE_POLICY_VERSION,
    decisionPolicySha256,
    animationFormat: VIDEO_SPRITE_ANIMATION_FORMAT,
    processingVersion: VIDEO_SPRITE_PROCESSING_VERSION,
    action: request.action,
    expectedFacing: request.expectedFacing,
    lineage: request.lineage ?? {},
    inputs: {
      videoSha256,
      videoSizeBytes: media.probe.sizeBytes,
      canonicalSha256,
      canonicalSizeBytes: Buffer.from(request.canonicalFrameBase64, 'base64').byteLength,
      probe: media.probe,
    },
    contract: {
      sequenceFormat: profile.sequenceFormat,
      frameSourceContract: profile.sequenceFormat === 'loop'
        ? 'video-raw-only'
        : 'canonical-f0-plus-video',
      uniqueFrameCount: profile.uniqueFrameCount,
      playbackFrameCount: compiled.playback.length,
      playback: compiled.playback,
      frameWidth: VIDEO_SPRITE_FRAME_WIDTH,
      frameHeight: VIDEO_SPRITE_FRAME_HEIGHT,
      runtimeColumns: 8,
      allowStatic: profile.allowStatic,
    },
    extraction: {
      toolchain: media.toolchain,
      pixelCleanup: 'transparent-rgb-zero+translucent-green-despill-v1',
      decodedFrameCount: videoFrames.length,
      selectedVideoIndices: compiled.selectedVideoIndices,
      selectionAlgorithm: request.selectedVideoIndices
        ? 'operator-selected-indices-v1'
        : automaticSelectionPolicy,
      operatorAdjustmentApplied: Boolean(request.selectedVideoIndices),
      selectedTimeMs: compiled.selectedVideoIndices.map((index) => (
        Math.round(index * 1000 / media.toolchain.sampleFps)
      )),
      frameTranslations: compiled.translations,
      registrationAlgorithm: 'alpha-root-safe-clamped-integer-v2',
      canonicalDerivedF0: profile.sequenceFormat !== 'loop',
      normalizedFramePngSha256: media.videoFramePngs.map((bytes) => sha256(bytes)),
      uniqueFrameArtifacts: uniqueFramePngs.map((bytes, uniqueIndex) => ({
        uniqueIndex,
        sourceVideoIndex: profile.sequenceFormat === 'loop'
          ? compiled.selectedVideoIndices[uniqueIndex]
          : uniqueIndex === 0 ? null : compiled.selectedVideoIndices[uniqueIndex - 1],
        pngSha256: sha256(bytes),
        runtimePixelSha256: compiled.selectedMetrics[uniqueIndex].pixelSha256,
        archivalPngSha256: sha256(bytes),
        sizeBytes: bytes.byteLength,
      })),
    },
    metrics: {
      sourceFrames: compiled.sourceMetrics,
      sourceTransitions: compiled.sourceTransitions,
      selectedFrames: compiled.selectedMetrics,
      selectedTransitions: compiled.selectedTransitions,
      sequence: compiled.sequenceMetrics,
    },
    gates: compiled.gates,
    decision: {
      outcome: compiled.decision,
      reasonCodes: compiled.reasonCodes,
      semanticPromotionApproved: false as const,
    },
    manualReviewLimitations: [
      'identity_equivalence',
      'anatomy_and_limb_correctness',
      'action_semantics',
      'absolute_facing_requires_approved_canonical',
      'legal_or_likeness_clearance',
    ],
    artifacts: {
      runtimeSheet: {
        sha256: sha256(runtimeSheet.bytes),
        sizeBytes: runtimeSheet.bytes.byteLength,
        width: runtimeSheet.width,
        height: runtimeSheet.height,
        columns: runtimeSheet.columns,
        rows: runtimeSheet.rows,
      },
      uniqueFramesSheet: {
        sha256: sha256(uniqueSheet.bytes),
        sizeBytes: uniqueSheet.bytes.byteLength,
        width: uniqueSheet.width,
        height: uniqueSheet.height,
        columns: uniqueSheet.columns,
        rows: uniqueSheet.rows,
      },
      rawUniqueFramesSheet: {
        sha256: sha256(rawSheet.bytes),
        sizeBytes: rawSheet.bytes.byteLength,
        width: rawSheet.width,
        height: rawSheet.height,
        columns: rawSheet.columns,
        rows: rawSheet.rows,
        frameWidth: VIDEO_SPRITE_RAW_FRAME_WIDTH,
        frameHeight: VIDEO_SPRITE_RAW_FRAME_HEIGHT,
        frameCount: archivalUniqueFrames.length,
      },
      allFramesContactSheet: {
        sha256: sha256(contactSheet.bytes),
        sizeBytes: contactSheet.bytes.byteLength,
        width: contactSheet.width,
        height: contactSheet.height,
        columns: contactSheet.columns,
        rows: contactSheet.rows,
        cellWidth: contactSheet.cellWidth,
        cellHeight: contactSheet.cellHeight,
      },
    },
  };
  const report = {
    ...reportWithoutHash,
    reportSha256: sha256(canonicalJson(reportWithoutHash)),
  };
  assertArtifactSize(
    'Compiler report',
    Buffer.from(canonicalJson(report)),
    MAX_REPORT_BYTES,
  );
  return {
    schemaVersion: 1,
    animationFormat: VIDEO_SPRITE_ANIMATION_FORMAT,
    processingVersion: VIDEO_SPRITE_PROCESSING_VERSION,
    frameW: VIDEO_SPRITE_FRAME_WIDTH,
    frameH: VIDEO_SPRITE_FRAME_HEIGHT,
    frameCount: compiled.playback.length,
    spriteBase64: runtimeSheet.bytes.toString('base64'),
    rawBase64: rawSheet.bytes.toString('base64'),
    rawFrameW: VIDEO_SPRITE_RAW_FRAME_WIDTH,
    rawFrameH: VIDEO_SPRITE_RAW_FRAME_HEIGHT,
    rawFrameCount: archivalUniqueFrames.length,
    allFramesContactSheetBase64: contactSheet.bytes.toString('base64'),
    uniqueFramesSheetBase64: uniqueSheet.bytes.toString('base64'),
    report,
  };
}

export const videoSpriteCanonicalJson = canonicalJson;
