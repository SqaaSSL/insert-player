import {
  VIDEO_SPRITE_ACTIONS,
  VIDEO_SPRITE_COMPILE_SCHEMA_VERSION,
  type VideoSpriteAction,
  type VideoSpriteCompileRequest,
  type VideoSpriteLineage,
} from '../../src/services/VideoSpriteCompileContract.ts';

export * from '../../src/services/VideoSpriteCompileContract.ts';

export class VideoSpriteCompileError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 422) {
    super(message);
    this.name = 'VideoSpriteCompileError';
    this.code = code;
    this.status = status;
  }
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const MAX_CANONICAL_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

export function decodeStrictBase64(value: unknown, label: string, maxBytes: number): Buffer {
  if (!boundedString(value, Math.ceil(maxBytes / 3) * 4 + 4) || !BASE64_PATTERN.test(value)) {
    throw new VideoSpriteCompileError('invalid_base64', `${label} must be canonical base64.`, 400);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new VideoSpriteCompileError('invalid_media_size', `${label} exceeds its byte limit.`, 400);
  }
  return bytes;
}

function parseLineage(value: unknown): VideoSpriteLineage | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new VideoSpriteCompileError('invalid_lineage', 'lineage must be an object.', 400);
  }
  const lineage: VideoSpriteLineage = {};
  const stringFields = [
    'jobId', 'runId', 'fighterId', 'provider', 'modelId', 'providerRequestId',
  ] as const;
  for (const field of stringFields) {
    const fieldValue = value[field];
    if (fieldValue === undefined) continue;
    if (!boundedString(fieldValue, 200) || !/^[a-zA-Z0-9._:/-]+$/.test(fieldValue)) {
      throw new VideoSpriteCompileError('invalid_lineage', `lineage.${field} is invalid.`, 400);
    }
    lineage[field] = fieldValue;
  }
  for (const field of ['promptSha256', 'videoSha256', 'canonicalSha256'] as const) {
    const fieldValue = value[field];
    if (fieldValue === undefined) continue;
    if (typeof fieldValue !== 'string' || !SHA256_PATTERN.test(fieldValue)) {
      throw new VideoSpriteCompileError('invalid_lineage', `lineage.${field} must be a lowercase SHA-256.`, 400);
    }
    lineage[field] = fieldValue;
  }
  return lineage;
}

export function parseVideoSpriteCompileRequest(value: unknown): VideoSpriteCompileRequest {
  if (!isRecord(value)) {
    throw new VideoSpriteCompileError('invalid_request', 'Video sprite request must be an object.', 400);
  }
  if (value.schemaVersion !== VIDEO_SPRITE_COMPILE_SCHEMA_VERSION) {
    throw new VideoSpriteCompileError('unsupported_schema', 'Unsupported video sprite request schema.', 400);
  }
  if (typeof value.action !== 'string' || !VIDEO_SPRITE_ACTIONS.includes(value.action as VideoSpriteAction)) {
    throw new VideoSpriteCompileError('invalid_action', 'Unsupported video sprite action.', 400);
  }
  const expectedFacing = value.expectedFacing ?? 'right';
  if (expectedFacing !== 'left' && expectedFacing !== 'right') {
    throw new VideoSpriteCompileError('invalid_facing', 'expectedFacing must be left or right.', 400);
  }
  // Decode here to fail before invoking media tools. The compiler decodes once more only
  // after the validated request crosses the internal service boundary.
  decodeStrictBase64(value.videoBase64, 'videoBase64', MAX_VIDEO_BYTES);
  decodeStrictBase64(value.canonicalFrameBase64, 'canonicalFrameBase64', MAX_CANONICAL_BYTES);
  return {
    schemaVersion: VIDEO_SPRITE_COMPILE_SCHEMA_VERSION,
    action: value.action as VideoSpriteAction,
    expectedFacing,
    videoBase64: value.videoBase64 as string,
    canonicalFrameBase64: value.canonicalFrameBase64 as string,
    lineage: parseLineage(value.lineage),
  };
}

export function decodeVideoBytes(request: VideoSpriteCompileRequest): Buffer {
  const bytes = decodeStrictBase64(request.videoBase64, 'videoBase64', MAX_VIDEO_BYTES);
  if (bytes.byteLength < 12 || bytes.subarray(4, 12).toString('ascii').indexOf('ftyp') < 0) {
    throw new VideoSpriteCompileError('invalid_video_container', 'videoBase64 is not an MP4 container.', 400);
  }
  return bytes;
}

export function decodeCanonicalBytes(request: VideoSpriteCompileRequest): Buffer {
  return decodeStrictBase64(request.canonicalFrameBase64, 'canonicalFrameBase64', MAX_CANONICAL_BYTES);
}
