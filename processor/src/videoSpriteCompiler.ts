import { createHash } from 'node:crypto';
import { ImageData, createCanvas, loadImage } from '@napi-rs/canvas';
import {
  VIDEO_SPRITE_ACTION_PROFILES,
  VIDEO_SPRITE_ANIMATION_FORMAT,
  VIDEO_SPRITE_COMPILER_VERSION,
  VIDEO_SPRITE_FRAME_HEIGHT,
  VIDEO_SPRITE_FRAME_WIDTH,
  VIDEO_SPRITE_POLICY_VERSION,
  VIDEO_SPRITE_PROCESSING_VERSION,
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

async function decodeNormalizedPng(bytes: Buffer, sourceIndex: number | null): Promise<VideoSpriteRgbaFrame> {
  let image;
  try {
    image = await loadImage(bytes);
  } catch {
    throw new VideoSpriteCompileError('invalid_normalized_frame', 'A normalized media frame is not a valid PNG.');
  }
  if (image.width !== VIDEO_SPRITE_FRAME_WIDTH || image.height !== VIDEO_SPRITE_FRAME_HEIGHT) {
    throw new VideoSpriteCompileError(
      'invalid_normalized_dimensions',
      `Normalized frames must be ${VIDEO_SPRITE_FRAME_WIDTH}x${VIDEO_SPRITE_FRAME_HEIGHT}.`,
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
  const canvas = createCanvas(boundedColumns * VIDEO_SPRITE_FRAME_WIDTH, rows * VIDEO_SPRITE_FRAME_HEIGHT);
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  frames.forEach((frame, index) => {
    putFrame(
      context,
      frame,
      (index % boundedColumns) * VIDEO_SPRITE_FRAME_WIDTH,
      Math.floor(index / boundedColumns) * VIDEO_SPRITE_FRAME_HEIGHT,
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
  const [canonical, ...videoFrames] = await Promise.all([
    decodeNormalizedPng(media.canonicalPng, null),
    ...media.videoFramePngs.map((bytes, index) => decodeNormalizedPng(bytes, index)),
  ]);
  let compiled;
  try {
    compiled = compileVideoSpriteFrames(request.action, canonical, videoFrames);
  } catch (error) {
    throw new VideoSpriteCompileError(
      'frame_compilation_failed',
      error instanceof Error ? error.message : 'Video frame compilation failed.',
    );
  }
  const [runtimeSheet, uniqueSheet, contactSheet, uniqueFramePngs] = await Promise.all([
    composeSheet(compiled.playbackFrames, 8),
    composeSheet(compiled.uniqueFrames, 8),
    composeContactSheet(videoFrames),
    Promise.all(compiled.uniqueFrames.map(encodeFrame)),
  ]);
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
      selectionAlgorithm: 'cumulative-motion-quantiles-v1',
      selectedTimeMs: compiled.selectedVideoIndices.map((index) => (
        Math.round(index * 1000 / media.toolchain.sampleFps)
      )),
      frameTranslations: compiled.translations,
      registrationAlgorithm: 'alpha-root-integer-v1',
      canonicalDerivedF0: true,
      normalizedFramePngSha256: media.videoFramePngs.map((bytes) => sha256(bytes)),
      uniqueFrameArtifacts: uniqueFramePngs.map((bytes, uniqueIndex) => ({
        uniqueIndex,
        sourceVideoIndex: uniqueIndex === 0 ? null : compiled.selectedVideoIndices[uniqueIndex - 1],
        pngSha256: sha256(bytes),
        pixelSha256: compiled.selectedMetrics[uniqueIndex].pixelSha256,
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
  return {
    schemaVersion: 1,
    animationFormat: VIDEO_SPRITE_ANIMATION_FORMAT,
    processingVersion: VIDEO_SPRITE_PROCESSING_VERSION,
    frameW: VIDEO_SPRITE_FRAME_WIDTH,
    frameH: VIDEO_SPRITE_FRAME_HEIGHT,
    frameCount: compiled.playback.length,
    spriteBase64: runtimeSheet.bytes.toString('base64'),
    allFramesContactSheetBase64: contactSheet.bytes.toString('base64'),
    uniqueFramesSheetBase64: uniqueSheet.bytes.toString('base64'),
    report,
  };
}

export const videoSpriteCanonicalJson = canonicalJson;
