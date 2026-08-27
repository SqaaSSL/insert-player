import { hashString } from './auth';
import {
  VIDEO_SPRITE_ACTION_PROFILES,
  VIDEO_SPRITE_ACTIONS,
  type VideoSpriteAction,
  type VideoSpriteCompileResponse,
} from '../../src/services/VideoSpriteCompileContract';

export const PIXCLI_VIDEO_MODEL = 'grok-imagine-i2v-pinned' as const;
export const PIXCLI_VIDEO_PROVIDER_ENDPOINT = 'xai/grok-imagine-video/v1.5/image-to-video' as const;
export const PIXCLI_VIDEO_DURATION_SECONDS = 2 as const;
export const PIXCLI_VIDEO_RESOLUTION = '720p' as const;
export const VIDEO_REVIEW_STATUS = 'awaiting_review' as const;

export interface VideoSpriteGenerationAction {
  action: VideoSpriteAction;
  motion: string;
  canonical: 'side' | 'crouch';
}

export const VIDEO_SPRITE_GENERATION_ACTIONS: readonly VideoSpriteGenerationAction[] = [
  {
    action: 'idle',
    canonical: 'side',
    motion: [
      'Hold the supplied fighting stance inside a locked sprite cell for the entire clip.',
      'A completely motionless result is valid and preferred over invented steps, punches, guard changes, or body turns.',
      'Do not perform any action and do not change the feet, hands, silhouette, or facing direction.',
    ].join(' '),
  },
  {
    action: 'walk',
    canonical: 'side',
    motion: 'Perform one seamless combat-ready forward walk cycle toward screen-right, the RIGHT EDGE OF IMAGE, positive X; keep both fists in the same guard and end immediately before the duplicated first pose.',
  },
  {
    action: 'high_punch',
    canonical: 'side',
    motion: 'From the exact supplied stance, wind up and extend one grounded high jab toward screen-right, the RIGHT EDGE OF IMAGE, positive X, ending at the strongest impact pose without retracting.',
  },
  {
    action: 'high_kick',
    canonical: 'side',
    motion: 'From the exact supplied stance, chamber and extend one grounded high roundhouse kick toward screen-right, the RIGHT EDGE OF IMAGE, positive X, ending at the strongest impact pose without retracting.',
  },
  {
    action: 'low_punch',
    canonical: 'crouch',
    motion: 'Remain in the supplied low crouch, wind up and extend one low jab toward screen-right, the RIGHT EDGE OF IMAGE, positive X, ending at the strongest impact pose without standing or retracting.',
  },
  {
    action: 'low_kick',
    canonical: 'crouch',
    motion: 'Remain low, chamber and extend one grounded sweep kick toward screen-right, the RIGHT EDGE OF IMAGE, positive X, ending at the strongest impact pose without standing or retracting.',
  },
  {
    action: 'jump',
    canonical: 'side',
    motion: 'Perform one complete in-place fighting-game jump: anticipation, lift-off, apex, descent, landing, and stable grounded recovery, without changing scale.',
  },
  {
    action: 'crouch',
    canonical: 'side',
    motion: 'Transition monotonically from the supplied standing guard into a deep compact crouch and hold the final crouched pose.',
  },
  {
    action: 'hit',
    canonical: 'side',
    motion: 'Perform one clear grounded hit reaction toward screen-left, the LEFT EDGE OF IMAGE, negative X, recoil, stagger, and settle back into a stable grounded recovery without falling.',
  },
  {
    action: 'ko',
    canonical: 'side',
    motion: [
      'Fall backward from the supplied stance into a fully knocked-out pose on the ground.',
      'The final torso, shoulder, and head must visibly contact the floor, with the body clearly lying down.',
      'Never kneel, sit upright, brace on a hand or elbow, remain supported, or finish in a recovery pose.',
      'End on the terminal lying pose and hold it.',
    ].join(' '),
  },
  {
    action: 'victory',
    canonical: 'side',
    motion: 'Perform one unmistakable arcade victory celebration, raise one or both arms, and settle into a proud stable champion hold while continuing to face screen-right, the RIGHT EDGE OF IMAGE, positive X.',
  },
] as const;

const ACTION_BY_NAME = new Map(
  VIDEO_SPRITE_GENERATION_ACTIONS.map((entry) => [entry.action, entry]),
);

export function videoAction(action: VideoSpriteAction): VideoSpriteGenerationAction {
  const definition = ACTION_BY_NAME.get(action);
  if (!definition) throw new Error(`Unsupported video sprite action: ${action}`);
  return definition;
}

export function buildVideoSpritePrompt(
  action: VideoSpriteAction,
  generationPrompt?: string,
): string {
  const definition = videoAction(action);
  const identityBrief = generationPrompt?.replace(/\s+/g, ' ').trim().slice(0, 2_400);
  return [
    'Create one continuous two-second fighting-game sprite-source clip from IMAGE 1.',
    `The requested action is ${action.toUpperCase()}.`,
    definition.motion,
    'IMAGE 1 is the approved identity, face, hair, body, outfit, materials, rendering style, starting scale, floor line, and screen-right facing master.',
    identityBrief ? `Preserve this approved character brief: ${identityBrief}` : '',
    'Preserve exactly one connected adult fighter throughout. Never add, remove, duplicate, detach, or morph a head, face, torso, arm, hand, finger, leg, foot, person, prop, trail, or afterimage.',
    'Use a strict 2D orthographic side profile: nose points to the RIGHT EDGE OF IMAGE / positive X, back points to the LEFT EDGE / negative X, and the far shoulder and far hip remain mostly occluded. Never turn frontal, three-quarter, reverse yaw, or horizontally flip. Keep the full body inside the frame with generous transparent-safe margin. No crop, zoom, pan, cut, shake, scale change, perspective change, or camera turn.',
    'Keep a perfectly flat, uniform pure #00FF00 background with no floor, shadow, scenery, text, particles, motion blur, or lighting change.',
  ].filter(Boolean).join(' ');
}

export interface DeterministicMultipart {
  contentType: string;
  bytes: Uint8Array;
  boundary: string;
  filename: string;
}

export function deterministicCanonicalMultipart(
  canonicalBytes: Uint8Array,
  canonicalSha256: string,
  action: VideoSpriteAction,
): DeterministicMultipart {
  if (!/^[a-f0-9]{64}$/.test(canonicalSha256)) {
    throw new Error('Canonical SHA-256 is invalid.');
  }
  const boundary = `----insert-player-${canonicalSha256.slice(0, 32)}`;
  const filename = `canonical-${action}-${canonicalSha256.slice(0, 16)}.png`;
  const prefix = new TextEncoder().encode([
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    'Content-Type: image/png',
    '',
    '',
  ].join('\r\n'));
  const suffix = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const bytes = new Uint8Array(prefix.byteLength + canonicalBytes.byteLength + suffix.byteLength);
  bytes.set(prefix, 0);
  bytes.set(canonicalBytes, prefix.byteLength);
  bytes.set(suffix, prefix.byteLength + canonicalBytes.byteLength);
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    bytes,
    boundary,
    filename,
  };
}

export interface PixcliVideoPayload {
  prompt: string;
  model: typeof PIXCLI_VIDEO_MODEL;
  image: string;
  resolution: typeof PIXCLI_VIDEO_RESOLUTION;
  params: {
    duration: typeof PIXCLI_VIDEO_DURATION_SECONDS;
    resolution: typeof PIXCLI_VIDEO_RESOLUTION;
  };
  enrich_prompt: false;
  output_format: 'url';
  publish: false;
  publish_name: string;
}

export function buildPixcliVideoPayload(
  action: VideoSpriteAction,
  canonicalAssetHash: string,
  prompt: string,
): PixcliVideoPayload {
  if (!/^[a-f0-9]{32}$/.test(canonicalAssetHash)) {
    throw new Error('PixCLI canonical asset hash is invalid.');
  }
  if (prompt.trim().length < 32 || prompt.length > 8_000) {
    throw new Error('PixCLI video prompt is outside the pinned bounds.');
  }
  return {
    prompt,
    model: PIXCLI_VIDEO_MODEL,
    image: canonicalAssetHash,
    resolution: PIXCLI_VIDEO_RESOLUTION,
    params: {
      duration: PIXCLI_VIDEO_DURATION_SECONDS,
      resolution: PIXCLI_VIDEO_RESOLUTION,
    },
    enrich_prompt: false,
    output_format: 'url',
    publish: false,
    publish_name: `ip-video-${action.replaceAll('_', '-')}`,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parsePixcliUpload(value: unknown): { assetHash: string } {
  const body = record(value);
  if (!body || typeof body.hash !== 'string' || !/^[a-f0-9]{32}$/.test(body.hash)) {
    throw new Error('PixCLI upload returned an invalid asset hash.');
  }
  return { assetHash: body.hash };
}

export function parsePixcliSubmission(value: unknown): { jobId: string; deduplicated: boolean } {
  const body = record(value);
  if (!body || typeof body.job_id !== 'string' || !/^[a-f0-9]{32}$/.test(body.job_id)) {
    throw new Error('PixCLI video submission returned an invalid job id.');
  }
  return { jobId: body.job_id, deduplicated: body.deduplicated === true };
}

export type PixcliTerminalStatus = 'completed' | 'completed_with_fallback' | 'failed';

export function pixcliJobStatus(value: unknown): string {
  const body = record(value);
  const status = body?.status;
  if (typeof status !== 'string' || !/^[a-z_]{2,40}$/.test(status)) {
    throw new Error('PixCLI job returned an invalid status.');
  }
  return status;
}

export interface ValidatedPixcliVideoAudit {
  providerRequestId: string;
  videoAssetHash: string;
  videoAssetUrl: string;
  videoMimeType: 'video/mp4';
  canonicalInputHash: string;
  providerRequestAssetHash: string;
  providerResponseAssetHash: string;
  assets: {
    providerRequest: ValidatedPixcliAsset;
    providerResponse: ValidatedPixcliAsset;
    video: ValidatedPixcliAsset;
  };
}

export interface ValidatedPixcliAsset {
  hash: string;
  contentSha256: string | null;
  sizeBytes: number;
  mimeType: 'application/json' | 'video/mp4';
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function validatePixcliAssetUrl(
  asset: Record<string, unknown>,
  pixcliOrigin: string,
): URL {
  let url: URL;
  let expectedOrigin: URL;
  try {
    url = new URL(asset.url as string);
    expectedOrigin = new URL(pixcliOrigin);
  } catch {
    throw new Error('PixCLI asset URL is invalid.');
  }
  if (
    typeof asset.hash !== 'string' || !/^[a-f0-9]{32}$/.test(asset.hash) ||
    url.protocol !== 'https:' ||
    url.origin !== expectedOrigin.origin ||
    url.username || url.password || url.search || url.hash ||
    url.pathname !== `/api/v1/assets/${asset.hash}`
  ) {
    throw new Error('PixCLI asset URL is outside the pinned asset allowlist.');
  }
  return url;
}

export async function validatePixcliVideoAudit(
  value: unknown,
  expected: {
    jobId: string;
    payload: PixcliVideoPayload;
    pixcliOrigin: string;
  },
): Promise<ValidatedPixcliVideoAudit> {
  const document = record(value);
  const job = record(document?.job);
  const input = record(document?.input);
  const providerRuns = Array.isArray(document?.provider_runs) ? document.provider_runs : [];
  const assets = Array.isArray(document?.assets) ? document.assets : [];
  if (
    job?.job_id !== expected.jobId ||
    job.status !== 'completed' ||
    job.type !== 'video' ||
    job.mode !== 'advanced' ||
    job.total_steps !== 1 ||
    job.current_step !== 0 ||
    job.cost !== 330000 ||
    providerRuns.length !== 1
  ) {
    throw new Error('PixCLI audit does not describe the completed requested job.');
  }
  const providerRun = record(providerRuns[0]);
  const providerRequestId = providerRun?.requestId ?? providerRun?.request_id;
  if (
    providerRun?.provider !== 'fal' ||
    (providerRun.modelId ?? providerRun.model_id) !== PIXCLI_VIDEO_MODEL ||
    typeof providerRequestId !== 'string' ||
    providerRequestId.length < 8 || providerRequestId.length > 200
  ) {
    throw new Error('PixCLI audit has an unexpected provider, model, or request id.');
  }
  const actualInputHash = await hashString(canonicalJson(input));
  const inputParams = record(input?.params);
  const imageUrl = typeof input?.image_url === 'string' ? input.image_url : '';
  const imageUrls = Array.isArray(input?.image_urls) ? input.image_urls : [];
  let resolvedImageUrl: URL;
  let expectedOrigin: URL;
  try {
    resolvedImageUrl = new URL(imageUrl);
    expectedOrigin = new URL(expected.pixcliOrigin);
  } catch {
    throw new Error('PixCLI audit input has an invalid resolved canonical URL.');
  }
  if (
    input?.model !== expected.payload.model ||
    input?.image !== expected.payload.image ||
    input?.prompt !== expected.payload.prompt ||
    input?.enriched_prompt !== expected.payload.prompt ||
    input?.enrich_prompt !== false ||
    input?.resolution !== expected.payload.resolution ||
    inputParams?.duration !== expected.payload.params.duration ||
    inputParams?.resolution !== expected.payload.params.resolution ||
    input?.output_format !== 'url' ||
    input?.publish !== false ||
    resolvedImageUrl.origin !== expectedOrigin.origin ||
    resolvedImageUrl.username || resolvedImageUrl.password ||
    resolvedImageUrl.pathname !== `/api/v1/assets/${expected.payload.image}` ||
    resolvedImageUrl.search || resolvedImageUrl.hash ||
    imageUrls.length !== 1 || imageUrls[0] !== resolvedImageUrl.toString()
  ) {
    throw new Error('PixCLI audit input differs from the pinned submitted payload.');
  }
  const normalizedAssets = assets.map((value) => {
    const asset = record(value);
    const metadata = record(asset?.metadata);
    if (!asset || !metadata) throw new Error('PixCLI audit contains an invalid asset.');
    validatePixcliAssetUrl(asset, expected.pixcliOrigin);
    if (
      !Number.isSafeInteger(asset.size_bytes) || Number(asset.size_bytes) < 2 ||
      Number(asset.size_bytes) > 16 * 1024 * 1024
    ) throw new Error('PixCLI audit asset is missing bounded content identity.');
    return { asset, metadata };
  });
  const videos = normalizedAssets.filter(({ asset }) => (
    typeof asset.mime_type === 'string' && asset.mime_type.startsWith('video/')
  ));
  if (
    normalizedAssets.length !== 3 ||
    videos.length !== 1 ||
    videos[0].asset.mime_type !== 'video/mp4' ||
    videos[0].metadata.model !== PIXCLI_VIDEO_MODEL ||
    videos[0].metadata.provider_request_id !== providerRequestId ||
    videos[0].metadata.prompt !== expected.payload.prompt
  ) {
    throw new Error('PixCLI audit must contain exactly one pinned MP4 asset.');
  }
  const providerRequestAssets = normalizedAssets.filter(({ asset, metadata }) => (
    asset.mime_type === 'application/json' &&
    metadata.artifact_kind === 'provider_request'
  ));
  const providerResponseAssets = normalizedAssets.filter(({ asset, metadata }) => (
    asset.mime_type === 'application/json' &&
    metadata.artifact_kind === 'provider_response'
  ));
  if (
    providerRequestAssets.length !== 1 || providerResponseAssets.length !== 1 ||
    providerRequestAssets[0].metadata.model !== PIXCLI_VIDEO_MODEL ||
    providerResponseAssets[0].metadata.model !== PIXCLI_VIDEO_MODEL ||
    providerResponseAssets[0].metadata.provider_request_id !== providerRequestId ||
    !/^[a-f0-9]{64}$/.test(String(providerRequestAssets[0].metadata.content_sha256 ?? '')) ||
    !/^[a-f0-9]{64}$/.test(String(providerResponseAssets[0].metadata.content_sha256 ?? ''))
  ) {
    throw new Error('PixCLI audit must contain one pinned provider request and response artifact.');
  }
  const video = videos[0].asset;
  const url = validatePixcliAssetUrl(video, expected.pixcliOrigin);
  const projectedAsset = (
    item: { asset: Record<string, unknown>; metadata: Record<string, unknown> },
    mimeType: 'application/json' | 'video/mp4',
  ): ValidatedPixcliAsset => ({
    hash: item.asset.hash as string,
    contentSha256: typeof item.metadata.content_sha256 === 'string'
      ? item.metadata.content_sha256
      : null,
    sizeBytes: item.asset.size_bytes as number,
    mimeType,
  });
  return {
    providerRequestId,
    videoAssetHash: video.hash as string,
    videoAssetUrl: url.toString(),
    videoMimeType: 'video/mp4',
    canonicalInputHash: actualInputHash,
    providerRequestAssetHash: providerRequestAssets[0].asset.hash as string,
    providerResponseAssetHash: providerResponseAssets[0].asset.hash as string,
    assets: {
      providerRequest: projectedAsset(providerRequestAssets[0], 'application/json'),
      providerResponse: projectedAsset(providerResponseAssets[0], 'application/json'),
      video: projectedAsset(videos[0], 'video/mp4'),
    },
  };
}

export function validatePixcliProviderRequestAudit(
  value: unknown,
  expected: {
    payload: PixcliVideoPayload;
    pixcliOrigin: string;
  },
): void {
  const document = record(value);
  const input = record(document?.input);
  let imageUrl: URL;
  let origin: URL;
  try {
    imageUrl = new URL(input?.image_url as string);
    origin = new URL(expected.pixcliOrigin);
  } catch {
    throw new Error('PixCLI provider request audit has an invalid canonical URL.');
  }
  if (
    canonicalJson(Object.keys(document ?? {}).sort()) !== canonicalJson([
      'fallback_policy', 'input', 'model', 'retry_policy',
    ]) ||
    document?.model !== PIXCLI_VIDEO_PROVIDER_ENDPOINT ||
    document?.retry_policy !== 'none' ||
    document?.fallback_policy !== 'none' ||
    input?.prompt !== expected.payload.prompt ||
    input?.duration !== PIXCLI_VIDEO_DURATION_SECONDS ||
    input?.resolution !== PIXCLI_VIDEO_RESOLUTION ||
    imageUrl.origin !== origin.origin ||
    imageUrl.pathname !== `/api/v1/assets/${expected.payload.image}` ||
    imageUrl.username || imageUrl.password || imageUrl.search || imageUrl.hash ||
    canonicalJson(Object.keys(input ?? {}).sort()) !== canonicalJson([
      'duration', 'image_url', 'prompt', 'resolution',
    ])
  ) {
    throw new Error('PixCLI provider request audit violates the pinned no-fallback endpoint contract.');
  }
}

export function validatePixcliProviderResponseAudit(
  value: unknown,
  expected: { sizeBytes: number },
): void {
  const document = record(value);
  const video = record(document?.video);
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(video?.url as string);
  } catch {
    throw new Error('PixCLI provider response has an invalid video descriptor.');
  }
  if (
    canonicalJson(Object.keys(document ?? {}).sort()) !== canonicalJson(['video']) ||
    canonicalJson(Object.keys(video ?? {}).sort()) !== canonicalJson([
      'content_type', 'duration', 'file_name', 'file_size', 'fps',
      'height', 'num_frames', 'url', 'width',
    ]) ||
    video?.content_type !== 'video/mp4' ||
    video?.file_size !== expected.sizeBytes ||
    typeof video?.file_name !== 'string' || video.file_name.length < 5 ||
    video.file_name.length > 160 || !/^[A-Za-z0-9._-]+\.mp4$/.test(video.file_name) ||
    !Number.isSafeInteger(video?.width) || Number(video?.width) < 256 || Number(video?.width) > 4096 ||
    !Number.isSafeInteger(video?.height) || Number(video?.height) < 256 || Number(video?.height) > 4096 ||
    typeof video?.fps !== 'number' || Number(video.fps) < 12 || Number(video.fps) > 60 ||
    typeof video?.duration !== 'number' || Number(video.duration) < 1.8 || Number(video.duration) > 2.3 ||
    !Number.isSafeInteger(video?.num_frames) || Number(video?.num_frames) < 24 || Number(video?.num_frames) > 144 ||
    sourceUrl.protocol !== 'https:' || sourceUrl.username || sourceUrl.password ||
    !(sourceUrl.hostname === 'fal.media' || sourceUrl.hostname.endsWith('.fal.media'))
  ) {
    throw new Error('PixCLI provider response violates the pinned MP4 descriptor contract.');
  }
}

export interface VideoSpriteCandidateArtifacts {
  processedKey: string;
  rawKey: string;
  contactSheetKey: string;
  uniqueSheetKey: string;
  reportKey: string;
}

export interface VideoSpriteCandidateReportProjection {
  outcome: 'technical_pass' | 'needs_review' | 'reject';
  reportSha256: string;
  reportContentSha256: string;
  selectedIndices: number[];
  playback: number[];
  translations: Array<{ dx: number; dy: number }>;
  sourceFrameCount: number;
  processedBytes: ArrayBuffer;
  rawBytes: ArrayBuffer;
  contactSheetBytes: ArrayBuffer;
  uniqueSheetBytes: ArrayBuffer;
  reportBytes: ArrayBuffer;
  hashes: {
    processed: string;
    raw: string;
    contactSheet: string;
    uniqueSheet: string;
  };
}

const MAX_COMPILER_PNG_BYTES = 32 * 1024 * 1024;
const MAX_COMPILER_REPORT_BYTES = 1024 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeCompilerPng(value: unknown, label: string): ArrayBuffer {
  if (typeof value !== 'string' || !value || !BASE64_PATTERN.test(value)) {
    throw new Error(`${label} is not canonical base64.`);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(`${label} is not valid base64.`);
  }
  if (binary.length < 24 || binary.length > MAX_COMPILER_PNG_BYTES) {
    throw new Error(`${label} is outside the persistence byte limit.`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, index) => bytes[index] === byte)) {
    throw new Error(`${label} is not a PNG.`);
  }
  return bytes.buffer;
}

function pngDimensions(bytes: ArrayBuffer): { width: number; height: number } {
  const view = new DataView(bytes);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export async function projectCompilerReport(
  response: VideoSpriteCompileResponse,
  expectedAction: VideoSpriteAction,
  expected: {
    facing: 'right';
    lineage: Record<string, string>;
    videoSizeBytes: number;
    canonicalSizeBytes: number;
    selectedVideoIndices?: number[];
    operatorAdjustmentApplied: boolean;
  },
): Promise<VideoSpriteCandidateReportProjection> {
  const report = response.report as Record<string, unknown>;
  const extraction = record(report.extraction);
  const contract = record(report.contract);
  const inputs = record(report.inputs);
  const lineage = record(report.lineage);
  const decision = record(report.decision);
  const selectedIndices = extraction?.selectedVideoIndices;
  const playback = contract?.playback;
  const translations = extraction?.frameTranslations;
  const artifacts = record(report.artifacts);
  const runtimeArtifact = record(artifacts?.runtimeSheet);
  const rawArtifact = record(artifacts?.rawUniqueFramesSheet);
  const contactArtifact = record(artifacts?.allFramesContactSheet);
  const uniqueArtifact = record(artifacts?.uniqueFramesSheet);
  const processedBytes = decodeCompilerPng(response.spriteBase64, 'spriteBase64');
  const rawBytes = decodeCompilerPng(response.rawBase64, 'rawBase64');
  const contactSheetBytes = decodeCompilerPng(
    response.allFramesContactSheetBase64,
    'allFramesContactSheetBase64',
  );
  const uniqueSheetBytes = decodeCompilerPng(
    response.uniqueFramesSheetBase64,
    'uniqueFramesSheetBase64',
  );
  const processedHash = await hashString(processedBytes);
  const rawHash = await hashString(rawBytes);
  const contactHash = await hashString(contactSheetBytes);
  const uniqueHash = await hashString(uniqueSheetBytes);
  if (
    response.schemaVersion !== 1 ||
    response.animationFormat !== 'video-dense-v1' ||
    response.processingVersion !== 5 ||
    response.frameW !== 192 || response.frameH !== 256 ||
    response.rawFrameW !== 768 || response.rawFrameH !== 1024 ||
    report.schema !== 'video-sprite-compile-report.v1' ||
    report.schemaVersion !== 1 ||
    report.action !== expectedAction ||
    report.expectedFacing !== 'right' ||
    report.animationFormat !== response.animationFormat ||
    report.processingVersion !== response.processingVersion ||
    !/^[a-f0-9]{64}$/.test(String(report.reportSha256 ?? '')) ||
    !['technical_pass', 'needs_review', 'reject'].includes(String(decision?.outcome ?? '')) ||
    decision?.semanticPromotionApproved !== false ||
    !Array.isArray(selectedIndices) || !selectedIndices.every(Number.isSafeInteger) ||
    !Array.isArray(playback) || !playback.every(Number.isSafeInteger) ||
    !Array.isArray(translations) || !translations.every((entry) => {
      const translation = record(entry);
      return Number.isSafeInteger(translation?.dx) && Number.isSafeInteger(translation?.dy);
    })
  ) {
    throw new Error('Video compiler returned an invalid review report projection.');
  }
  const profile = VIDEO_SPRITE_ACTION_PROFILES[expectedAction];
  const expectedCount = profile.sequenceFormat === 'loop'
    ? profile.uniqueFrameCount
    : profile.uniqueFrameCount - 1;
  const decodedFrameCount = Number(extraction?.decodedFrameCount);
  const expectedPlayback = Array.from({ length: profile.uniqueFrameCount }, (_, index) => index);
  if (profile.sequenceFormat === 'forward-ping-pong') {
    expectedPlayback.push(...expectedPlayback.slice(0, -1).reverse());
  }
  if (
    !VIDEO_SPRITE_ACTIONS.includes(expectedAction) ||
    selectedIndices.length !== expectedCount ||
    response.rawFrameCount !== profile.uniqueFrameCount ||
    playback.length !== response.frameCount ||
    translations.length !== response.rawFrameCount ||
    !Number.isSafeInteger(decodedFrameCount) || decodedFrameCount < expectedCount || decodedFrameCount > 144 ||
    selectedIndices.some((index, position) => (
      index < 0 || index >= decodedFrameCount ||
      (position > 0 && index <= selectedIndices[position - 1])
    )) ||
    playback.some((index) => index < 0 || index >= response.rawFrameCount)
    || canonicalJson(playback) !== canonicalJson(expectedPlayback)
    || contract?.sequenceFormat !== profile.sequenceFormat
    || contract?.frameSourceContract !== (
      profile.sequenceFormat === 'loop' ? 'video-raw-only' : 'canonical-f0-plus-video'
    )
    || contract?.uniqueFrameCount !== profile.uniqueFrameCount
    || contract?.playbackFrameCount !== expectedPlayback.length
    || contract?.frameWidth !== response.frameW || contract?.frameHeight !== response.frameH
    || contract?.allowStatic !== profile.allowStatic
    || extraction?.canonicalDerivedF0 !== (profile.sequenceFormat !== 'loop')
    || expected.facing !== 'right'
    || extraction?.operatorAdjustmentApplied !== expected.operatorAdjustmentApplied
    || extraction?.selectionAlgorithm !== (
      expected.operatorAdjustmentApplied
        ? 'operator-selected-indices-v1'
        : 'cumulative-motion-quantiles-v2'
    )
    || (expected.selectedVideoIndices !== undefined &&
      canonicalJson(selectedIndices) !== canonicalJson(expected.selectedVideoIndices))
  ) {
    throw new Error('Video compiler report does not match its action or artifact counts.');
  }
  const runtimeColumns = Math.min(8, response.frameCount);
  const rawColumns = Math.min(4, response.rawFrameCount);
  const expectedRuntimeDimensions = {
    width: runtimeColumns * response.frameW,
    height: Math.ceil(response.frameCount / runtimeColumns) * response.frameH,
  };
  const expectedRawDimensions = {
    width: rawColumns * response.rawFrameW,
    height: Math.ceil(response.rawFrameCount / rawColumns) * response.rawFrameH,
  };
  const runtimeDimensions = pngDimensions(processedBytes);
  const rawDimensions = pngDimensions(rawBytes);
  const contactDimensions = pngDimensions(contactSheetBytes);
  const uniqueDimensions = pngDimensions(uniqueSheetBytes);
  const contactColumns = Number(contactArtifact?.columns);
  const contactRows = Number(contactArtifact?.rows);
  const contactCellWidth = Number(contactArtifact?.cellWidth);
  const contactCellHeight = Number(contactArtifact?.cellHeight);
  const expectedUniqueDimensions = {
    width: Math.min(8, response.rawFrameCount) * response.frameW,
    height: Math.ceil(response.rawFrameCount / Math.min(8, response.rawFrameCount)) * response.frameH,
  };
  if (
    runtimeDimensions.width !== expectedRuntimeDimensions.width ||
    runtimeDimensions.height !== expectedRuntimeDimensions.height ||
    rawDimensions.width !== expectedRawDimensions.width ||
    rawDimensions.height !== expectedRawDimensions.height ||
    runtimeArtifact?.sha256 !== processedHash ||
    runtimeArtifact?.sizeBytes !== processedBytes.byteLength ||
    runtimeArtifact?.width !== runtimeDimensions.width ||
    runtimeArtifact?.height !== runtimeDimensions.height ||
    rawArtifact?.sha256 !== rawHash ||
    rawArtifact?.sizeBytes !== rawBytes.byteLength ||
    rawArtifact?.width !== rawDimensions.width ||
    rawArtifact?.height !== rawDimensions.height ||
    contactArtifact?.sha256 !== contactHash ||
    contactArtifact?.sizeBytes !== contactSheetBytes.byteLength ||
    contactArtifact?.width !== contactDimensions.width ||
    contactArtifact?.height !== contactDimensions.height ||
    !Number.isSafeInteger(contactColumns) || !Number.isSafeInteger(contactRows) ||
    !Number.isSafeInteger(contactCellWidth) || !Number.isSafeInteger(contactCellHeight) ||
    contactColumns !== Math.min(8, decodedFrameCount) ||
    contactRows !== Math.ceil(decodedFrameCount / Math.min(8, decodedFrameCount)) ||
    contactCellWidth !== 96 || contactCellHeight !== 128 ||
    contactDimensions.width !== contactColumns * contactCellWidth ||
    contactDimensions.height !== contactRows * contactCellHeight ||
    uniqueArtifact?.sha256 !== uniqueHash ||
    uniqueArtifact?.sizeBytes !== uniqueSheetBytes.byteLength ||
    uniqueArtifact?.width !== uniqueDimensions.width ||
    uniqueArtifact?.height !== uniqueDimensions.height ||
    uniqueDimensions.width !== expectedUniqueDimensions.width ||
    uniqueDimensions.height !== expectedUniqueDimensions.height ||
    (
      canonicalJson(lineage) !== canonicalJson(expected.lineage) ||
      inputs?.videoSha256 !== expected.lineage.videoSha256 ||
      inputs?.canonicalSha256 !== expected.lineage.canonicalSha256 ||
      inputs?.videoSizeBytes !== expected.videoSizeBytes ||
      inputs?.canonicalSizeBytes !== expected.canonicalSizeBytes
    )
  ) {
    throw new Error('Video compiler artifact hashes, sizes, or PNG dimensions do not match the report.');
  }
  const reportWithoutHash = { ...report };
  delete reportWithoutHash.reportSha256;
  const calculatedReportHash = await hashString(canonicalJson(reportWithoutHash));
  if (calculatedReportHash !== report.reportSha256) {
    throw new Error('Video compiler report hash is invalid.');
  }
  const encodedReport = new TextEncoder().encode(canonicalJson(report));
  const reportBytes = encodedReport.buffer.slice(
    encodedReport.byteOffset,
    encodedReport.byteOffset + encodedReport.byteLength,
  ) as ArrayBuffer;
  if (reportBytes.byteLength > MAX_COMPILER_REPORT_BYTES) {
    throw new Error('Video compiler report exceeds its persistence limit.');
  }
  const reportContentSha256 = await hashString(reportBytes);
  return {
    outcome: decision.outcome as VideoSpriteCandidateReportProjection['outcome'],
    reportSha256: report.reportSha256 as string,
    reportContentSha256,
    selectedIndices: selectedIndices as number[],
    playback: playback as number[],
    translations: translations as Array<{ dx: number; dy: number }>,
    sourceFrameCount: decodedFrameCount,
    processedBytes,
    rawBytes,
    contactSheetBytes,
    uniqueSheetBytes,
    reportBytes,
    hashes: {
      processed: processedHash,
      raw: rawHash,
      contactSheet: contactHash,
      uniqueSheet: uniqueHash,
    },
  };
}
