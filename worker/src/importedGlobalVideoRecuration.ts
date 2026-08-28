import { hashString } from './auth';
import { persistGeneratedSprite } from './generatedAssets';
import { readJsonBody } from './requestBody';
import { createBoundedByteStream } from './streamLimits';
import type {
  AuthContext,
  Env,
  SourceVersion,
  SpriteVersion,
} from './types';
import {
  VIDEO_SPRITE_ACTIONS,
  type VideoSpriteAction,
  type VideoSpriteCompileResponse,
} from '../../src/services/VideoSpriteCompileContract';
import {
  canonicalJson,
  PIXCLI_VIDEO_MODEL,
  PIXCLI_VIDEO_PROVIDER_ENDPOINT,
  projectCompilerReport,
} from './videoSpriteGeneration';
import {
  EXPECTED_WORKER_SHA_HEADER,
  requireReviewedProductionWorkerPin,
} from './reviewedDeploymentPin';

const MAX_BODY_BYTES = 32 * 1024;
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_COMPILER_RESPONSE_BYTES = 96 * 1024 * 1024;
const CLAIM_STALE_MINUTES = 15;
const ANIMATION_FORMAT = 'video-dense-v1';

type LegacyCanonicalKind = 'side_raw' | 'upright_raw' | 'crouch_raw';

interface CurrentGlobalRow {
  fighter_id: string;
  owner_user_id: string;
  fighter_quality_tier: 'rookie' | 'contender' | 'champion';
  public_flag: number;
  side_view_raw_blob_key: string | null;
  upright_view_raw_blob_key: string | null;
  crouch_view_raw_blob_key: string | null;
  arcade_slug: string;
  arcade_status: 'draft' | 'active' | 'retired';
  sprite_id: string;
  animation_name: VideoSpriteAction;
  sprite_quality_tier: 'rookie' | 'contender' | 'champion';
  blob_key: string;
  raw_blob_key: string | null;
  content_hash: string | null;
  raw_content_hash: string | null;
  frame_w: number;
  frame_h: number;
  frame_count: number;
  animation_format: string;
  processing_version: number;
}

interface ImportedRecurationProposalRow {
  id: string;
  fighter_id: string;
  owner_user_id: string;
  action: VideoSpriteAction;
  expected_worker_sha: string;
  worker_version_id: string;
  worker_version_tag: string;
  source_url: string;
  source_video_blob_key: string;
  source_video_sha256: string;
  source_video_size_bytes: number;
  source_provider: 'fal';
  provider_model: typeof PIXCLI_VIDEO_MODEL;
  provider_endpoint: typeof PIXCLI_VIDEO_PROVIDER_ENDPOINT;
  pixcli_job_id: string;
  provider_request_id: string;
  prompt_sha256: string;
  provider_request_audit_sha256: string;
  provider_response_sha256: string;
  canonical_kind: LegacyCanonicalKind;
  canonical_version_id: string;
  canonical_blob_key: string;
  canonical_sha256: string;
  from_sprite_id: string;
  from_sprite_version_id: string;
  from_processed_blob_key: string;
  from_processed_sha256: string;
  from_raw_blob_key: string;
  from_raw_sha256: string;
  from_frame_w: number;
  from_frame_h: number;
  from_frame_count: number;
  from_animation_format: 'video-dense-v1';
  from_processing_version: number;
  target_sprite_version_id: string;
  target_processed_blob_key: string;
  target_processed_sha256: string;
  target_raw_blob_key: string;
  target_raw_sha256: string;
  target_frame_w: 192;
  target_frame_h: 256;
  target_frame_count: number;
  target_raw_frame_w: 768;
  target_raw_frame_h: 1024;
  target_raw_frame_count: number;
  source_frame_count: number;
  target_animation_format: 'video-dense-v1';
  target_processing_version: 6;
  compiler_outcome: 'technical_pass' | 'needs_review' | 'reject';
  report_sha256: string;
  report_content_sha256: string;
  selected_indices_json: string;
  playback_json: string;
  translations_json: string;
  contact_sheet_blob_key: string;
  contact_sheet_sha256: string;
  unique_sheet_blob_key: string;
  unique_sheet_sha256: string;
  report_blob_key: string;
  evidence_blob_key: string;
  evidence_sha256: string;
  created_at: string;
}

interface StageBody {
  action: VideoSpriteAction;
  current: {
    spriteId: string;
    spriteVersionId: string;
    processedSha256: string;
    rawSha256: string;
    frameWidth: number;
    frameHeight: number;
    frameCount: number;
    animationFormat: 'video-dense-v1';
    processingVersion: number;
  };
  canonical: {
    kind: LegacyCanonicalKind;
    sha256: string;
  };
  source: {
    url: string;
    sha256: string;
    sizeBytes: number;
    provider: 'fal';
    modelId: typeof PIXCLI_VIDEO_MODEL;
    providerEndpoint: typeof PIXCLI_VIDEO_PROVIDER_ENDPOINT;
    pixcliJobId: string;
    providerRequestId: string;
    promptSha256: string;
    providerRequestAuditSha256: string;
    providerResponseSha256: string;
  };
  selectedVideoIndices: number[];
}

interface TransitionBody {
  proposalId: string;
  fromProcessedSha256: string;
  fromRawSha256: string;
  toProcessedSha256: string;
  toRawSha256: string;
  visualReviewAccepted: boolean;
  acceptNeedsReview: boolean;
  promoteTransitionId: string | null;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function exactKeys(value: unknown, expected: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function exactSha(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function exactId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

function parseFalSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' || url.username || url.password || url.hash || url.search ||
      (url.port && url.port !== '443') || !url.pathname ||
      !(url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media'))
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseStageBody(value: unknown): StageBody | null {
  if (!exactKeys(value, ['action', 'current', 'canonical', 'source', 'selectedVideoIndices'])) {
    return null;
  }
  const action = value.action;
  const current = value.current;
  const canonical = value.canonical;
  const source = value.source;
  const selected = value.selectedVideoIndices;
  if (
    typeof action !== 'string' || !VIDEO_SPRITE_ACTIONS.includes(action as VideoSpriteAction) ||
    !exactKeys(current, [
      'spriteId', 'spriteVersionId', 'processedSha256', 'rawSha256', 'frameWidth',
      'frameHeight', 'frameCount', 'animationFormat', 'processingVersion',
    ]) ||
    typeof current.spriteId !== 'string' || current.spriteId.length < 1 || current.spriteId.length > 200 ||
    typeof current.spriteVersionId !== 'string' || current.spriteVersionId.length < 1 ||
    current.spriteVersionId.length > 200 || !exactSha(current.processedSha256) ||
    !exactSha(current.rawSha256) || current.frameWidth !== 192 || current.frameHeight !== 256 ||
    !Number.isSafeInteger(current.frameCount) || Number(current.frameCount) < 2 ||
    Number(current.frameCount) > 64 || current.animationFormat !== ANIMATION_FORMAT ||
    !Number.isSafeInteger(current.processingVersion) || Number(current.processingVersion) < 0 ||
    Number(current.processingVersion) > 100 ||
    !exactKeys(canonical, ['kind', 'sha256']) ||
    !['side_raw', 'upright_raw', 'crouch_raw'].includes(String(canonical.kind)) ||
    !exactSha(canonical.sha256) ||
    !exactKeys(source, [
      'url', 'sha256', 'sizeBytes', 'provider', 'modelId', 'providerEndpoint',
      'pixcliJobId', 'providerRequestId', 'promptSha256',
      'providerRequestAuditSha256', 'providerResponseSha256',
    ]) || !parseFalSourceUrl(source.url) || !exactSha(source.sha256) ||
    !Number.isSafeInteger(source.sizeBytes) || Number(source.sizeBytes) < 12 ||
    Number(source.sizeBytes) > MAX_VIDEO_BYTES || source.provider !== 'fal' ||
    source.modelId !== PIXCLI_VIDEO_MODEL || source.providerEndpoint !== PIXCLI_VIDEO_PROVIDER_ENDPOINT ||
    !exactId(source.pixcliJobId) || typeof source.providerRequestId !== 'string' ||
    source.providerRequestId.length < 8 || source.providerRequestId.length > 200 ||
    !exactSha(source.promptSha256) || !exactSha(source.providerRequestAuditSha256) ||
    !exactSha(source.providerResponseSha256) || !Array.isArray(selected) ||
    selected.length < 2 || selected.length > 12 ||
    !selected.every((entry, index) => Number.isSafeInteger(entry) && entry >= 0 &&
      (index === 0 || entry > selected[index - 1]))
  ) return null;
  return value as unknown as StageBody;
}

function parseTransitionBody(
  value: unknown,
  operation: 'promote' | 'rollback',
): TransitionBody | null {
  const expected = [
    'proposalId', 'fromProcessedSha256', 'fromRawSha256', 'toProcessedSha256',
    'toRawSha256', 'visualReviewAccepted', 'acceptNeedsReview',
  ];
  if (operation === 'rollback') expected.push('promoteTransitionId');
  if (!exactKeys(value, expected)) return null;
  if (
    !exactId(value.proposalId) || !exactSha(value.fromProcessedSha256) ||
    !exactSha(value.fromRawSha256) || !exactSha(value.toProcessedSha256) ||
    !exactSha(value.toRawSha256) || typeof value.visualReviewAccepted !== 'boolean' ||
    typeof value.acceptNeedsReview !== 'boolean' ||
    (operation === 'rollback' && !exactSha(value.promoteTransitionId))
  ) return null;
  return {
    ...(value as unknown as Omit<TransitionBody, 'promoteTransitionId'>),
    promoteTransitionId: operation === 'rollback' ? String(value.promoteTransitionId) : null,
  };
}

function requiredWorkerPin(request: Request, env: Env): { sha: string; id: string; tag: string } | Response {
  if (env.ENVIRONMENT !== 'production') {
    return json({ error: 'Imported global Video recuration is production-only' }, 403);
  }
  const failure = requireReviewedProductionWorkerPin(request, env);
  if (failure) return failure;
  const sha = request.headers.get(EXPECTED_WORKER_SHA_HEADER)?.trim() ?? '';
  const id = env.WORKER_VERSION_METADATA?.id?.trim() ?? '';
  const tag = env.WORKER_VERSION_METADATA?.tag?.trim() ?? '';
  if (!/^[a-f0-9]{40}$/.test(sha) || !id || !new RegExp(`^prod-${sha}-[1-9][0-9]*$`).test(tag)) {
    return json({ error: 'The exact deployed production Worker identity is required' }, 409);
  }
  return { sha, id, tag };
}

async function currentActiveGlobal(
  env: Env,
  auth: AuthContext,
  fighterId: string,
  action: VideoSpriteAction,
): Promise<CurrentGlobalRow | null> {
  return env.DB.prepare(`
    SELECT
      fighter.id AS fighter_id,
      fighter.owner_user_id AS owner_user_id,
      fighter.quality_tier AS fighter_quality_tier,
      fighter.public_flag AS public_flag,
      fighter.side_view_raw_blob_key AS side_view_raw_blob_key,
      fighter.upright_view_raw_blob_key AS upright_view_raw_blob_key,
      fighter.crouch_view_raw_blob_key AS crouch_view_raw_blob_key,
      arcade.slug AS arcade_slug,
      arcade.status AS arcade_status,
      sprite.id AS sprite_id,
      sprite.animation_name AS animation_name,
      sprite.quality_tier AS sprite_quality_tier,
      sprite.blob_key AS blob_key,
      sprite.raw_blob_key AS raw_blob_key,
      sprite.content_hash AS content_hash,
      sprite.raw_content_hash AS raw_content_hash,
      sprite.frame_w AS frame_w,
      sprite.frame_h AS frame_h,
      sprite.frame_count AS frame_count,
      sprite.animation_format AS animation_format,
      sprite.processing_version AS processing_version
    FROM fighters fighter
    JOIN arcade_fighters arcade ON arcade.fighter_id = fighter.id
    JOIN sprites sprite ON sprite.fighter_id = fighter.id
      AND sprite.animation_name = ? AND sprite.quality_tier = 'champion'
    WHERE fighter.id = ? AND fighter.owner_user_id = ?
    LIMIT 1
  `).bind(action, fighterId, auth.userId).first<CurrentGlobalRow>();
}

function activeGlobalFailure(row: CurrentGlobalRow | null): Response | null {
  if (!row) return json({ error: 'Imported Arcade global not found' }, 404);
  if (
    row.arcade_status !== 'active' || row.public_flag !== 1 ||
    row.fighter_quality_tier !== 'champion' || row.sprite_quality_tier !== 'champion' ||
    row.raw_blob_key === null || row.content_hash === null ||
    row.raw_content_hash === null || row.animation_format !== ANIMATION_FORMAT ||
    row.frame_w !== 192 || row.frame_h !== 256
  ) return json({ error: 'Imported recuration requires an active public Champion Arcade global' }, 409);
  return null;
}

async function exactCurrentVersion(env: Env, row: CurrentGlobalRow): Promise<SpriteVersion | null> {
  const { results } = await env.DB.prepare(`
    SELECT * FROM sprite_versions
    WHERE fighter_id = ? AND animation_name = ? AND quality_tier = 'champion'
      AND blob_key = ? AND raw_blob_key = ? AND content_hash = ? AND raw_content_hash = ?
      AND frame_w = ? AND frame_h = ? AND frame_count = ?
      AND animation_format = ? AND processing_version = ?
    ORDER BY created_at DESC
    LIMIT 2
  `).bind(
    row.fighter_id,
    row.animation_name,
    row.blob_key,
    row.raw_blob_key,
    row.content_hash,
    row.raw_content_hash,
    row.frame_w,
    row.frame_h,
    row.frame_count,
    row.animation_format,
    row.processing_version,
  ).all<SpriteVersion>();
  return results.length === 1 ? results[0] : null;
}

async function activeCanonical(
  env: Env,
  row: CurrentGlobalRow,
  kind: LegacyCanonicalKind,
  expectedSha256: string,
): Promise<SourceVersion | null> {
  const blobKey = kind === 'side_raw'
    ? row.side_view_raw_blob_key
    : kind === 'upright_raw'
      ? row.upright_view_raw_blob_key
      : row.crouch_view_raw_blob_key;
  if (!blobKey) return null;
  const { results } = await env.DB.prepare(`
    SELECT * FROM source_versions
    WHERE fighter_id = ? AND kind = ? AND blob_key = ? AND content_hash = ?
    ORDER BY created_at DESC
    LIMIT 2
  `).bind(row.fighter_id, kind, blobKey, expectedSha256).all<SourceVersion>();
  return results.length === 1 ? results[0] : null;
}

async function exactObjectBytes(
  env: Env,
  key: string,
  expectedSha256: string,
  maximumBytes: number,
): Promise<ArrayBuffer> {
  const object = await env.SPRITES.get(key);
  if (!object || object.size < 1 || object.size > maximumBytes) {
    throw new Error('A sealed recuration object is unavailable or oversized');
  }
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== object.size || await hashString(bytes) !== expectedSha256) {
    throw new Error('A sealed recuration object failed exact byte integrity');
  }
  return bytes;
}

async function verifyCurrentBytes(env: Env, row: CurrentGlobalRow): Promise<void> {
  await Promise.all([
    exactObjectBytes(env, row.blob_key, row.content_hash!, MAX_PNG_BYTES),
    exactObjectBytes(env, row.raw_blob_key!, row.raw_content_hash!, MAX_PNG_BYTES),
  ]);
}

async function fetchExactFalVideo(url: string, expectedSha256: string, expectedSize: number): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'video/mp4' },
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) throw new Error(`Public fal source returned HTTP ${response.status}`);
  const contentType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'video/mp4') throw new Error('Public fal source did not return video/mp4');
  const declaredSize = Number(response.headers.get('Content-Length') ?? 0);
  if (declaredSize && declaredSize !== expectedSize) {
    throw new Error('Public fal source Content-Length changed from its sealed evidence');
  }
  const bytes = await new Response(
    createBoundedByteStream(response.body, MAX_VIDEO_BYTES),
  ).arrayBuffer();
  const header = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength));
  if (
    bytes.byteLength !== expectedSize || await hashString(bytes) !== expectedSha256 ||
    header.byteLength < 12 || String.fromCharCode(...header.slice(4, 8)) !== 'ftyp'
  ) throw new Error('Public fal source bytes do not match the exact sealed MP4');
  return bytes;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let output = '';
  for (let offset = 0; offset < bytes.length; offset += 24_576) {
    const chunk = bytes.subarray(offset, Math.min(offset + 24_576, bytes.length));
    let binary = '';
    for (const byte of chunk) binary += String.fromCharCode(byte);
    output += btoa(binary);
  }
  return output;
}

async function callCompiler(
  env: Env,
  proposalId: string,
  body: Record<string, unknown>,
): Promise<VideoSpriteCompileResponse> {
  if (!env.IMAGE_PROCESSOR) throw new Error('Image processor binding is unavailable');
  const response = await env.IMAGE_PROCESSOR.getByName(proposalId).fetch(new Request(
    'http://image-processor/v1/compile-video-sprite',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  ));
  if (!response.ok || !response.body) {
    throw new Error(`Video compiler rejected imported recuration (${response.status})`);
  }
  const bytes = await new Response(
    createBoundedByteStream(response.body, MAX_COMPILER_RESPONSE_BYTES),
  ).arrayBuffer();
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as VideoSpriteCompileResponse;
  } catch {
    throw new Error('Video compiler returned invalid JSON');
  }
}

async function putImmutable(
  env: Env,
  key: string,
  bytes: ArrayBuffer,
  contentType: string,
  sha256: string,
): Promise<void> {
  const existing = await env.SPRITES.head(key);
  if (existing) {
    if (existing.size !== bytes.byteLength || existing.customMetadata?.contentSha256 !== sha256) {
      throw new Error('Immutable imported recuration object conflicts with existing bytes');
    }
    return;
  }
  await env.SPRITES.put(key, bytes, {
    httpMetadata: { contentType },
    customMetadata: { contentSha256: sha256, privateReview: 'true', providerCalled: 'false' },
  });
}

async function proposalById(
  env: Env,
  fighterId: string,
  ownerUserId: string,
  proposalId: string,
): Promise<ImportedRecurationProposalRow | null> {
  return env.DB.prepare(`
    SELECT * FROM imported_global_video_recurations
    WHERE id = ? AND fighter_id = ? AND owner_user_id = ?
    LIMIT 1
  `).bind(proposalId, fighterId, ownerUserId).first<ImportedRecurationProposalRow>();
}

function proposalAssets(row: ImportedRecurationProposalRow) {
  const prefix = `/api/admin/arcade/${row.fighter_id}/imported-video-recuration/${row.id}/assets`;
  return {
    runtime: `${prefix}/runtime`,
    raw: `${prefix}/raw`,
    contactSheet: `${prefix}/contact-sheet`,
    uniqueSheet: `${prefix}/unique-sheet`,
    report: `${prefix}/report`,
    video: `${prefix}/video`,
    canonical: `${prefix}/canonical`,
    evidence: `${prefix}/evidence`,
  };
}

function serializeProposal(row: ImportedRecurationProposalRow) {
  return {
    proposalId: row.id,
    fighterId: row.fighter_id,
    action: row.action,
    worker: {
      expectedSha: row.expected_worker_sha,
      versionId: row.worker_version_id,
      versionTag: row.worker_version_tag,
    },
    from: {
      spriteId: row.from_sprite_id,
      spriteVersionId: row.from_sprite_version_id,
      processedSha256: row.from_processed_sha256,
      rawSha256: row.from_raw_sha256,
      frameWidth: row.from_frame_w,
      frameHeight: row.from_frame_h,
      frameCount: row.from_frame_count,
      animationFormat: row.from_animation_format,
      processingVersion: row.from_processing_version,
    },
    to: {
      spriteVersionId: row.target_sprite_version_id,
      processedSha256: row.target_processed_sha256,
      rawSha256: row.target_raw_sha256,
      frameWidth: row.target_frame_w,
      frameHeight: row.target_frame_h,
      frameCount: row.target_frame_count,
      rawFrameWidth: row.target_raw_frame_w,
      rawFrameHeight: row.target_raw_frame_h,
      rawFrameCount: row.target_raw_frame_count,
      animationFormat: row.target_animation_format,
      processingVersion: row.target_processing_version,
      technicalOutcome: row.compiler_outcome,
      reportSha256: row.report_sha256,
      reportContentSha256: row.report_content_sha256,
      selectedVideoIndices: JSON.parse(row.selected_indices_json) as number[],
      playback: JSON.parse(row.playback_json) as number[],
    },
    source: {
      url: row.source_url,
      videoSha256: row.source_video_sha256,
      videoSizeBytes: row.source_video_size_bytes,
      provider: row.source_provider,
      modelId: row.provider_model,
      providerEndpoint: row.provider_endpoint,
      pixcliJobId: row.pixcli_job_id,
      providerRequestId: row.provider_request_id,
      promptSha256: row.prompt_sha256,
      providerRequestAuditSha256: row.provider_request_audit_sha256,
      providerResponseSha256: row.provider_response_sha256,
      canonicalKind: row.canonical_kind,
      canonicalVersionId: row.canonical_version_id,
      canonicalSha256: row.canonical_sha256,
    },
    evidenceSha256: row.evidence_sha256,
    createdAt: row.created_at,
    assets: proposalAssets(row),
  };
}

async function verifyProposalArtifacts(env: Env, row: ImportedRecurationProposalRow): Promise<void> {
  const targetVersion = await env.DB.prepare(`
    SELECT * FROM sprite_versions WHERE id = ? AND fighter_id = ? AND animation_name = ?
      AND quality_tier = 'champion' LIMIT 1
  `).bind(row.target_sprite_version_id, row.fighter_id, row.action).first<SpriteVersion>();
  if (
    !targetVersion || targetVersion.blob_key !== row.target_processed_blob_key ||
    targetVersion.raw_blob_key !== row.target_raw_blob_key ||
    targetVersion.content_hash !== row.target_processed_sha256 ||
    targetVersion.raw_content_hash !== row.target_raw_sha256 ||
    targetVersion.frame_w !== row.target_frame_w || targetVersion.frame_h !== row.target_frame_h ||
    targetVersion.frame_count !== row.target_frame_count ||
    targetVersion.animation_format !== row.target_animation_format ||
    targetVersion.processing_version !== row.target_processing_version
  ) throw new Error('Staged imported recuration sprite version changed');
  await Promise.all([
    exactObjectBytes(env, row.target_processed_blob_key, row.target_processed_sha256, MAX_PNG_BYTES),
    exactObjectBytes(env, row.target_raw_blob_key, row.target_raw_sha256, MAX_PNG_BYTES),
    exactObjectBytes(env, row.contact_sheet_blob_key, row.contact_sheet_sha256, MAX_PNG_BYTES),
    exactObjectBytes(env, row.unique_sheet_blob_key, row.unique_sheet_sha256, MAX_PNG_BYTES),
    exactObjectBytes(env, row.report_blob_key, row.report_content_sha256, 1024 * 1024),
    exactObjectBytes(env, row.evidence_blob_key, row.evidence_sha256, 1024 * 1024),
    exactObjectBytes(env, row.source_video_blob_key, row.source_video_sha256, MAX_VIDEO_BYTES),
    exactObjectBytes(env, row.canonical_blob_key, row.canonical_sha256, 12 * 1024 * 1024),
  ]);
}

function stageInputMatches(
  row: CurrentGlobalRow,
  version: SpriteVersion,
  canonical: SourceVersion,
  body: StageBody,
): boolean {
  return row.sprite_id === body.current.spriteId && version.id === body.current.spriteVersionId &&
    row.content_hash === body.current.processedSha256 && row.raw_content_hash === body.current.rawSha256 &&
    row.frame_w === body.current.frameWidth && row.frame_h === body.current.frameHeight &&
    row.frame_count === body.current.frameCount && row.animation_format === body.current.animationFormat &&
    row.processing_version === body.current.processingVersion && canonical.kind === body.canonical.kind &&
    canonical.content_hash === body.canonical.sha256;
}

async function releaseClaim(
  env: Env,
  fighterId: string,
  action: VideoSpriteAction,
  claimToken: string,
): Promise<void> {
  await env.DB.prepare(`
    DELETE FROM imported_global_video_recuration_claims
    WHERE fighter_id = ? AND action = ? AND claim_token = ?
  `).bind(fighterId, action, claimToken).run();
}

export async function stageImportedGlobalVideoRecuration(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
): Promise<Response> {
  const pin = requiredWorkerPin(request, env);
  if (pin instanceof Response) return pin;
  if (auth.user.plan_tier !== 'admin') return json({ error: 'Admin access required' }, 403);
  if (!exactId(fighterId)) return json({ error: 'Imported Arcade global not found' }, 404);
  const body = parseStageBody(await readJsonBody<Record<string, unknown>>(request, MAX_BODY_BYTES));
  if (!body) return json({ error: 'Exact imported recuration source and current bindings are required' }, 400);
  const sourceUrl = parseFalSourceUrl(body.source.url)!;
  const row = await currentActiveGlobal(env, auth, fighterId, body.action);
  const globalFailure = activeGlobalFailure(row);
  if (globalFailure) return globalFailure;
  const [currentVersion, canonical] = await Promise.all([
    exactCurrentVersion(env, row!),
    activeCanonical(env, row!, body.canonical.kind, body.canonical.sha256),
  ]);
  if (!currentVersion || !canonical || !stageInputMatches(row!, currentVersion, canonical, body)) {
    return json({ error: 'Current sprite or active canonical binding changed before stage' }, 409);
  }
  try {
    await Promise.all([
      verifyCurrentBytes(env, row!),
      exactObjectBytes(env, canonical.blob_key, canonical.content_hash!, 12 * 1024 * 1024),
    ]);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Current bytes failed integrity' }, 409);
  }

  const proposalIdentity = {
    schema: 'imported-global-video-recuration.v1',
    fighterId,
    action: body.action,
    current: body.current,
    canonical: { ...body.canonical, versionId: canonical.id, blobKey: canonical.blob_key },
    source: { ...body.source, url: sourceUrl },
    selectedVideoIndices: body.selectedVideoIndices,
    expectedWorkerSha: pin.sha,
  };
  const proposalId = (await hashString(canonicalJson(proposalIdentity))).slice(0, 32);
  const existing = await proposalById(env, fighterId, auth.userId, proposalId);
  if (existing) {
    try {
      await verifyProposalArtifacts(env, existing);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Existing proposal failed integrity' }, 409);
    }
    return json({ proposal: serializeProposal(existing), providerCalls: 0 });
  }

  const claimToken = await hashString(canonicalJson({ proposalId, ownerUserId: auth.userId }));
  const claim = await env.DB.prepare(`
    INSERT INTO imported_global_video_recuration_claims (
      fighter_id, action, claim_token, claimed_at, lease_expires_at
    ) VALUES (?, ?, ?, datetime('now'), datetime('now', '+' || ? || ' minutes'))
    ON CONFLICT(fighter_id, action) DO UPDATE SET
      claim_token = excluded.claim_token,
      claimed_at = excluded.claimed_at,
      lease_expires_at = excluded.lease_expires_at
    WHERE imported_global_video_recuration_claims.lease_expires_at <= datetime('now')
  `).bind(fighterId, body.action, claimToken, CLAIM_STALE_MINUTES).run();
  if ((claim.meta.changes ?? 0) !== 1) {
    return json({ error: 'Another imported recuration stage is already running' }, 409);
  }

  try {
    const videoBytes = await fetchExactFalVideo(sourceUrl, body.source.sha256, body.source.sizeBytes);
    const canonicalBytes = await exactObjectBytes(
      env, canonical.blob_key, canonical.content_hash!, 12 * 1024 * 1024,
    );
    // The compiler contract calls these correlation fields jobId/runId. They are
    // deterministic local stage correlations, never represented as provider jobs.
    const stagePersistenceId = (await hashString(`${proposalId}:stage`)).slice(0, 32);
    const compilerCorrelation = {
      jobId: `imported-stage-${stagePersistenceId}`,
      runId: `imported-proposal-${proposalId}`,
      fighterId,
      provider: 'archived-fal-source-no-dispatch',
      modelId: PIXCLI_VIDEO_MODEL,
      providerRequestId: body.source.providerRequestId,
      promptSha256: body.source.promptSha256,
      videoSha256: body.source.sha256,
      canonicalSha256: canonical.content_hash!,
    };
    const compiled = await callCompiler(env, proposalId, {
      schemaVersion: 1,
      action: body.action,
      expectedFacing: 'right',
      videoBase64: arrayBufferToBase64(videoBytes),
      canonicalFrameBase64: arrayBufferToBase64(canonicalBytes),
      selectedVideoIndices: body.selectedVideoIndices,
      lineage: compilerCorrelation,
    });
    if (compiled.processingVersion !== 6) {
      throw new Error('Imported recuration requires compiler processing version 6');
    }
    const projection = await projectCompilerReport(compiled, body.action, {
      facing: 'right',
      lineage: compilerCorrelation,
      videoSizeBytes: videoBytes.byteLength,
      canonicalSizeBytes: canonicalBytes.byteLength,
      selectedVideoIndices: body.selectedVideoIndices,
      operatorAdjustmentApplied: true,
    });
    if (
      projection.hashes.processed === row!.content_hash ||
      projection.hashes.raw === row!.raw_content_hash
    ) throw new Error('Imported recuration did not produce a distinct exact target');
    const target = await persistGeneratedSprite(env, {
      jobId: stagePersistenceId,
      userId: auth.userId,
      fighterId,
      tier: 'champion',
      animationName: body.action,
      bytes: projection.processedBytes,
      rawBytes: projection.rawBytes,
      frameWidth: compiled.frameW,
      frameHeight: compiled.frameH,
      frameCount: compiled.frameCount,
      processingVersion: compiled.processingVersion,
      animationFormat: compiled.animationFormat,
      setCurrent: false,
    });
    if (!target.rawBlobKey || !target.rawContentHash) {
      throw new Error('Imported recuration target is missing its HQ raw sprite');
    }
    const prefix = `users/${auth.userId}/fighters/${fighterId}/imported-video-recurations/${proposalId}`;
    const keys = {
      video: `${prefix}/source-${body.source.sha256}.mp4`,
      contact: `${prefix}/contact-${projection.hashes.contactSheet}.png`,
      unique: `${prefix}/unique-${projection.hashes.uniqueSheet}.png`,
      report: `${prefix}/report-${projection.reportContentSha256}.json`,
      evidence: `${prefix}/evidence.json`,
    };
    const evidence = {
      schema: 'imported-global-video-recuration-evidence.v1',
      schemaVersion: 1,
      providerCalled: false,
      sourceAcquisition: 'approved_cdn_exact_hash',
      sourceArchivedPermanently: true,
      proposalId,
      fighter: { fighterId, slug: row!.arcade_slug, ownerUserId: auth.userId },
      action: body.action,
      worker: pin,
      current: {
        spriteId: row!.sprite_id,
        spriteVersionId: currentVersion.id,
        processedSha256: row!.content_hash,
        rawSha256: row!.raw_content_hash,
        processingVersion: row!.processing_version,
      },
      canonical: {
        kind: canonical.kind,
        versionId: canonical.id,
        blobKey: canonical.blob_key,
        sha256: canonical.content_hash,
      },
      source: { ...body.source, url: sourceUrl },
      compiler: {
        correlation: compilerCorrelation,
        processingVersion: compiled.processingVersion,
        reportSha256: projection.reportSha256,
        reportContentSha256: projection.reportContentSha256,
        selectedVideoIndices: projection.selectedIndices,
        playback: projection.playback,
        translations: projection.translations,
        technicalOutcome: projection.outcome,
      },
      target: {
        spriteVersionId: target.versionId,
        processedSha256: target.contentHash,
        rawSha256: target.rawContentHash,
      },
    };
    const encodedEvidence = new TextEncoder().encode(canonicalJson(evidence));
    const evidenceBytes = encodedEvidence.buffer.slice(
      encodedEvidence.byteOffset,
      encodedEvidence.byteOffset + encodedEvidence.byteLength,
    ) as ArrayBuffer;
    const evidenceSha256 = await hashString(evidenceBytes);
    await Promise.all([
      putImmutable(env, keys.video, videoBytes, 'video/mp4', body.source.sha256),
      putImmutable(env, keys.contact, projection.contactSheetBytes, 'image/png', projection.hashes.contactSheet),
      putImmutable(env, keys.unique, projection.uniqueSheetBytes, 'image/png', projection.hashes.uniqueSheet),
      putImmutable(env, keys.report, projection.reportBytes, 'application/json', projection.reportContentSha256),
      putImmutable(env, keys.evidence, evidenceBytes, 'application/json', evidenceSha256),
    ]);
    const inserted = await env.DB.prepare(`
      INSERT OR IGNORE INTO imported_global_video_recurations (
        id, fighter_id, owner_user_id, action,
        expected_worker_sha, worker_version_id, worker_version_tag,
        source_url, source_video_blob_key, source_video_sha256, source_video_size_bytes,
        source_provider, provider_model, provider_endpoint, pixcli_job_id,
        provider_request_id, prompt_sha256, provider_request_audit_sha256, provider_response_sha256,
        canonical_kind, canonical_version_id, canonical_blob_key, canonical_sha256,
        from_sprite_id, from_sprite_version_id, from_processed_blob_key, from_processed_sha256,
        from_raw_blob_key, from_raw_sha256, from_frame_w, from_frame_h, from_frame_count,
        from_animation_format, from_processing_version,
        target_sprite_version_id, target_processed_blob_key, target_processed_sha256,
        target_raw_blob_key, target_raw_sha256, target_frame_w, target_frame_h, target_frame_count,
        target_raw_frame_w, target_raw_frame_h, target_raw_frame_count, source_frame_count,
        target_animation_format, target_processing_version, compiler_outcome,
        report_sha256, report_content_sha256, selected_indices_json, playback_json, translations_json,
        contact_sheet_blob_key, contact_sheet_sha256, unique_sheet_blob_key, unique_sheet_sha256,
        report_blob_key, evidence_blob_key, evidence_sha256
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).bind(
      proposalId, fighterId, auth.userId, body.action,
      pin.sha, pin.id, pin.tag,
      sourceUrl, keys.video, body.source.sha256, body.source.sizeBytes,
      'fal', PIXCLI_VIDEO_MODEL, PIXCLI_VIDEO_PROVIDER_ENDPOINT, body.source.pixcliJobId,
      body.source.providerRequestId, body.source.promptSha256,
      body.source.providerRequestAuditSha256, body.source.providerResponseSha256,
      canonical.kind, canonical.id, canonical.blob_key, canonical.content_hash,
      row!.sprite_id, currentVersion.id, row!.blob_key, row!.content_hash,
      row!.raw_blob_key, row!.raw_content_hash, row!.frame_w, row!.frame_h, row!.frame_count,
      row!.animation_format, row!.processing_version,
      target.versionId, target.blobKey, target.contentHash,
      target.rawBlobKey, target.rawContentHash, compiled.frameW, compiled.frameH, compiled.frameCount,
      compiled.rawFrameW, compiled.rawFrameH, compiled.rawFrameCount, projection.sourceFrameCount,
      compiled.animationFormat, compiled.processingVersion, projection.outcome,
      projection.reportSha256, projection.reportContentSha256,
      JSON.stringify(projection.selectedIndices), JSON.stringify(projection.playback),
      JSON.stringify(projection.translations),
      keys.contact, projection.hashes.contactSheet, keys.unique, projection.hashes.uniqueSheet,
      keys.report, keys.evidence, evidenceSha256,
    ).run();
    const stored = await proposalById(env, fighterId, auth.userId, proposalId);
    if (!stored || ((inserted.meta.changes ?? 0) !== 1 && stored.target_processed_sha256 !== target.contentHash)) {
      throw new Error('Imported recuration proposal could not be committed exactly');
    }
    await verifyProposalArtifacts(env, stored);
    const unchanged = await currentActiveGlobal(env, auth, fighterId, body.action);
    if (
      !unchanged || unchanged.sprite_id !== row!.sprite_id ||
      unchanged.content_hash !== row!.content_hash ||
      unchanged.raw_content_hash !== row!.raw_content_hash ||
      unchanged.processing_version !== row!.processing_version
    ) throw new Error('Imported recuration stage changed the active sprite unexpectedly');
    return json({ proposal: serializeProposal(stored), providerCalls: 0 });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Imported recuration stage failed' }, 422);
  } finally {
    await releaseClaim(env, fighterId, body.action, claimToken);
  }
}

async function exactProposalVersion(
  env: Env,
  row: ImportedRecurationProposalRow,
  target: 'from' | 'to',
): Promise<SpriteVersion | null> {
  const versionId = target === 'from' ? row.from_sprite_version_id : row.target_sprite_version_id;
  return env.DB.prepare(`
    SELECT * FROM sprite_versions WHERE id = ? AND fighter_id = ? AND animation_name = ?
      AND quality_tier = 'champion' LIMIT 1
  `).bind(versionId, row.fighter_id, row.action).first<SpriteVersion>();
}

function versionMatchesProposal(
  version: SpriteVersion | null,
  row: ImportedRecurationProposalRow,
  target: 'from' | 'to',
): version is SpriteVersion {
  if (!version) return false;
  return target === 'from'
    ? version.blob_key === row.from_processed_blob_key && version.raw_blob_key === row.from_raw_blob_key &&
      version.content_hash === row.from_processed_sha256 && version.raw_content_hash === row.from_raw_sha256 &&
      version.frame_w === row.from_frame_w && version.frame_h === row.from_frame_h &&
      version.frame_count === row.from_frame_count && version.animation_format === row.from_animation_format &&
      version.processing_version === row.from_processing_version
    : version.blob_key === row.target_processed_blob_key && version.raw_blob_key === row.target_raw_blob_key &&
      version.content_hash === row.target_processed_sha256 && version.raw_content_hash === row.target_raw_sha256 &&
      version.frame_w === row.target_frame_w && version.frame_h === row.target_frame_h &&
      version.frame_count === row.target_frame_count && version.animation_format === row.target_animation_format &&
      version.processing_version === row.target_processing_version;
}

function currentMatchesVersion(row: CurrentGlobalRow, version: SpriteVersion): boolean {
  return row.sprite_id.length > 0 && row.blob_key === version.blob_key &&
    row.raw_blob_key === version.raw_blob_key &&
    row.content_hash === version.content_hash && row.raw_content_hash === version.raw_content_hash &&
    row.frame_w === version.frame_w && row.frame_h === version.frame_h && row.frame_count === version.frame_count &&
    row.animation_format === version.animation_format && row.processing_version === version.processing_version;
}

async function transitionEvent(
  env: Env,
  proposalId: string,
  operation: 'promote' | 'rollback',
): Promise<{ id: string; rollback_of_transition_id: string | null } | null> {
  return env.DB.prepare(`
    SELECT id, rollback_of_transition_id
    FROM imported_global_video_recuration_transitions
    WHERE proposal_id = ? AND operation = ? LIMIT 1
  `).bind(proposalId, operation).first<{
    id: string;
    rollback_of_transition_id: string | null;
  }>();
}

async function purgeArcadeRosterCache(request: Request): Promise<{
  localArcadeCachePurgeAttempted: boolean;
  localArcadeCacheEntryDeleted: boolean;
}> {
  try {
    if (typeof caches === 'undefined') {
      return { localArcadeCachePurgeAttempted: false, localArcadeCacheEntryDeleted: false };
    }
    const url = new URL('/api/arcade', request.url);
    return {
      localArcadeCachePurgeAttempted: true,
      localArcadeCacheEntryDeleted: await caches.default.delete(
        new Request(url, { method: 'GET' }),
      ),
    };
  } catch (error) {
    console.warn('Imported recuration could not purge the Arcade roster cache', error);
    return { localArcadeCachePurgeAttempted: true, localArcadeCacheEntryDeleted: false };
  }
}

async function transitionImportedGlobalVideoRecuration(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
  operation: 'promote' | 'rollback',
): Promise<Response> {
  const pin = requiredWorkerPin(request, env);
  if (pin instanceof Response) return pin;
  if (auth.user.plan_tier !== 'admin') return json({ error: 'Admin access required' }, 403);
  const body = parseTransitionBody(
    await readJsonBody<Record<string, unknown>>(request, MAX_BODY_BYTES),
    operation,
  );
  if (!body) return json({ error: 'Exact imported recuration transition binding is required' }, 400);
  const proposal = await proposalById(env, fighterId, auth.userId, body.proposalId);
  if (!proposal) return json({ error: 'Imported recuration proposal not found' }, 404);
  if (operation === 'promote' && proposal.expected_worker_sha !== pin.sha) {
    return json({ error: 'Proposal belongs to another exact Worker deployment' }, 409);
  }
  const row = await currentActiveGlobal(env, auth, fighterId, proposal.action);
  const globalFailure = activeGlobalFailure(row);
  if (globalFailure) return globalFailure;
  const [fromVersion, toVersion] = await Promise.all([
    exactProposalVersion(env, proposal, operation === 'promote' ? 'from' : 'to'),
    exactProposalVersion(env, proposal, operation === 'promote' ? 'to' : 'from'),
  ]);
  if (
    !versionMatchesProposal(fromVersion, proposal, operation === 'promote' ? 'from' : 'to') ||
    !versionMatchesProposal(toVersion, proposal, operation === 'promote' ? 'to' : 'from')
  ) return json({ error: 'Imported recuration sprite-version lineage changed' }, 409);
  const expected = {
    fromProcessed: fromVersion.content_hash!, fromRaw: fromVersion.raw_content_hash!,
    toProcessed: toVersion.content_hash!, toRaw: toVersion.raw_content_hash!,
  };
  if (
    body.fromProcessedSha256 !== expected.fromProcessed || body.fromRawSha256 !== expected.fromRaw ||
    body.toProcessedSha256 !== expected.toProcessed || body.toRawSha256 !== expected.toRaw
  ) return json({ error: 'Imported recuration from/to SHA binding changed' }, 409);
  if (operation === 'promote' && body.visualReviewAccepted !== true) {
    return json({ error: 'visualReviewAccepted=true is required before promotion' }, 422);
  }
  if (
    operation === 'promote' && proposal.compiler_outcome === 'needs_review' &&
    body.acceptNeedsReview !== true
  ) return json({ error: 'acceptNeedsReview=true is required for this compiler outcome' }, 422);
  if (operation === 'promote' && proposal.compiler_outcome === 'reject') {
    return json({ error: 'A technically rejected imported recuration cannot be promoted' }, 422);
  }
  if (
    operation === 'promote' && proposal.compiler_outcome === 'technical_pass' &&
    body.acceptNeedsReview !== false
  ) {
    return json({ error: 'acceptNeedsReview must be false for a technical pass' }, 422);
  }
  if (
    operation === 'rollback' &&
    (body.visualReviewAccepted !== false || body.acceptNeedsReview !== false)
  ) {
    return json({ error: 'Rollback acceptance flags must both be false' }, 422);
  }
  const [promoteEvent, rollbackEvent] = await Promise.all([
    transitionEvent(env, proposal.id, 'promote'),
    transitionEvent(env, proposal.id, 'rollback'),
  ]);
  if (operation === 'promote' && promoteEvent) {
    if (rollbackEvent) {
      return json({ error: 'This proposal was already promoted and rolled back; replay is forbidden' }, 409);
    }
    if (!currentMatchesVersion(row!, toVersion)) {
      return json({ error: 'This promote transition was already consumed' }, 409);
    }
    try {
      await Promise.all([verifyCurrentBytes(env, row!), verifyProposalArtifacts(env, proposal)]);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Current bytes failed integrity' }, 409);
    }
    const cachePurge = await purgeArcadeRosterCache(request);
    return json({
      operation,
      replayed: true,
      transitionId: promoteEvent.id,
      proposal: serializeProposal(proposal),
      current: { processedSha256: row!.content_hash, rawSha256: row!.raw_content_hash },
      ...cachePurge,
      providerCalls: 0,
    });
  }
  if (operation === 'rollback') {
    if (rollbackEvent) {
      if (
        rollbackEvent.rollback_of_transition_id !== body.promoteTransitionId ||
        !currentMatchesVersion(row!, toVersion)
      ) {
        return json({ error: 'This rollback transition was already consumed' }, 409);
      }
      try {
        await verifyCurrentBytes(env, row!);
      } catch (error) {
        return json({
          error: error instanceof Error ? error.message : 'Rollback replay bytes failed integrity',
        }, 409);
      }
      const cachePurge = await purgeArcadeRosterCache(request);
      return json({
        operation,
        replayed: true,
        transitionId: rollbackEvent.id,
        proposal: serializeProposal(proposal),
        current: { processedSha256: row!.content_hash, rawSha256: row!.raw_content_hash },
        ...cachePurge,
        providerCalls: 0,
      });
    }
    if (!promoteEvent || body.promoteTransitionId !== promoteEvent.id) {
      return json({ error: 'Rollback requires the exact preceding promote transition' }, 409);
    }
  }
  if (!currentMatchesVersion(row!, fromVersion)) {
    return json({ error: 'Active sprite changed before the exact CAS transition' }, 409);
  }
  try {
    const destinationIntegrity = [
      exactObjectBytes(env, toVersion.blob_key, toVersion.content_hash!, MAX_PNG_BYTES),
      exactObjectBytes(env, toVersion.raw_blob_key!, toVersion.raw_content_hash!, MAX_PNG_BYTES),
    ];
    await Promise.all(operation === 'promote'
      ? [verifyProposalArtifacts(env, proposal), verifyCurrentBytes(env, row!), ...destinationIntegrity]
      : destinationIntegrity);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Transition bytes failed integrity' }, 409);
  }
  const transitionId = await hashString(canonicalJson({
    proposalId: proposal.id,
    operation,
    actorUserId: auth.userId,
    expectedWorkerSha: pin.sha,
    rollbackOfTransitionId: body.promoteTransitionId,
    ...expected,
  }));
  try {
    // This is intentionally one SQLite statement. Migration triggers validate the
    // exact current/full version binding and apply the pointer in the same transaction.
    const result = await env.DB.prepare(`
      INSERT INTO imported_global_video_recuration_transitions (
        id, proposal_id, fighter_id, action, operation, actor_user_id,
        from_sprite_version_id, from_processed_sha256, from_raw_sha256,
        to_sprite_version_id, to_processed_sha256, to_raw_sha256,
        expected_worker_sha, visual_review_accepted, needs_review_accepted,
        rollback_of_transition_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      transitionId, proposal.id, fighterId, proposal.action, operation, auth.userId,
      fromVersion.id, fromVersion.content_hash, fromVersion.raw_content_hash,
      toVersion.id, toVersion.content_hash, toVersion.raw_content_hash,
      pin.sha, operation === 'promote' ? 1 : 0,
      operation === 'promote' && proposal.compiler_outcome === 'needs_review' ? 1 : 0,
      body.promoteTransitionId,
    ).run();
    // D1 may include AFTER-trigger writes in meta.changes; statement success plus
    // the post-read below is the authoritative invariant.
    if ((result.meta.changes ?? 0) < 1) {
      return json({ error: `Imported recuration ${operation} lost its exact CAS binding` }, 409);
    }
  } catch (error) {
    console.warn(`Imported recuration ${operation} CAS rejected`, error);
    return json({ error: `Imported recuration ${operation} lost its exact CAS binding` }, 409);
  }
  const current = await currentActiveGlobal(env, auth, fighterId, proposal.action);
  if (!current || !currentMatchesVersion(current, toVersion)) {
    return json({ error: `Imported recuration ${operation} could not be reloaded` }, 500);
  }
  const cachePurge = await purgeArcadeRosterCache(request);
  return json({
    operation,
    replayed: false,
    transitionId,
    proposal: serializeProposal(proposal),
    current: {
      processedSha256: current.content_hash,
      rawSha256: current.raw_content_hash,
      processingVersion: current.processing_version,
      frameCount: current.frame_count,
    },
    ...cachePurge,
    providerCalls: 0,
  });
}

export function promoteImportedGlobalVideoRecuration(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
): Promise<Response> {
  return transitionImportedGlobalVideoRecuration(request, env, auth, fighterId, 'promote');
}

export function rollbackImportedGlobalVideoRecuration(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
): Promise<Response> {
  return transitionImportedGlobalVideoRecuration(request, env, auth, fighterId, 'rollback');
}

export async function getImportedGlobalVideoRecurationAsset(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
  proposalId: string,
  kind: string,
): Promise<Response> {
  const pin = requiredWorkerPin(request, env);
  if (pin instanceof Response) return pin;
  if (auth.user.plan_tier !== 'admin') return json({ error: 'Admin access required' }, 403);
  if (!exactId(fighterId) || !exactId(proposalId)) return json({ error: 'Recuration asset not found' }, 404);
  const row = await proposalById(env, fighterId, auth.userId, proposalId);
  if (!row) return json({ error: 'Recuration asset not found' }, 404);
  const current = await currentActiveGlobal(env, auth, fighterId, row.action);
  const globalFailure = activeGlobalFailure(current);
  if (globalFailure) return globalFailure;
  const assets: Record<string, {
    key: string;
    sha256: string;
    contentType: string;
    maximumBytes: number;
  }> = {
    runtime: { key: row.target_processed_blob_key, sha256: row.target_processed_sha256, contentType: 'image/png', maximumBytes: MAX_PNG_BYTES },
    raw: { key: row.target_raw_blob_key, sha256: row.target_raw_sha256, contentType: 'image/png', maximumBytes: MAX_PNG_BYTES },
    'contact-sheet': { key: row.contact_sheet_blob_key, sha256: row.contact_sheet_sha256, contentType: 'image/png', maximumBytes: MAX_PNG_BYTES },
    'unique-sheet': { key: row.unique_sheet_blob_key, sha256: row.unique_sheet_sha256, contentType: 'image/png', maximumBytes: MAX_PNG_BYTES },
    report: { key: row.report_blob_key, sha256: row.report_content_sha256, contentType: 'application/json', maximumBytes: 1024 * 1024 },
    video: { key: row.source_video_blob_key, sha256: row.source_video_sha256, contentType: 'video/mp4', maximumBytes: MAX_VIDEO_BYTES },
    canonical: { key: row.canonical_blob_key, sha256: row.canonical_sha256, contentType: 'image/png', maximumBytes: 12 * 1024 * 1024 },
    evidence: { key: row.evidence_blob_key, sha256: row.evidence_sha256, contentType: 'application/json', maximumBytes: 1024 * 1024 },
  };
  const selected = assets[kind];
  if (!selected) return json({ error: 'Recuration asset not found' }, 404);
  let bytes: ArrayBuffer;
  try {
    bytes = await exactObjectBytes(env, selected.key, selected.sha256, selected.maximumBytes);
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : 'Recuration asset failed integrity',
    }, 410);
  }
  return new Response(bytes, { headers: {
    'Content-Type': selected.contentType,
    'Cache-Control': 'private, no-store',
    ETag: `"${selected.sha256}"`,
    'X-Content-SHA256': selected.sha256,
    'X-Content-Type-Options': 'nosniff',
  } });
}
