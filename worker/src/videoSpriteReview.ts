import { generateId, hashString } from './auth';
import { persistGeneratedSprite } from './generatedAssets';
import { assertArtifactRunComplete } from './generationArtifacts';
import { createBoundedByteStream } from './streamLimits';
import { readJsonBody } from './requestBody';
import type { AuthContext, Env, GenerationJob } from './types';
import {
  VIDEO_SPRITE_ACTIONS,
  type VideoSpriteAction,
  type VideoSpriteCompileResponse,
} from '../../src/services/VideoSpriteCompileContract';
import {
  canonicalJson,
  PIXCLI_VIDEO_MODEL,
  projectCompilerReport,
  type VideoSpriteCandidateReportProjection,
} from './videoSpriteGeneration';

const MAX_REVIEW_BODY_BYTES = 16 * 1024;
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const MAX_AUDIT_BYTES = 1024 * 1024;
const MAX_COMPILER_RESPONSE_BYTES = 96 * 1024 * 1024;

export type VideoSpriteCandidateStatus = 'awaiting_review' | 'approved' | 'rejected';

export interface VideoSpriteCandidateRow {
  id: string;
  run_id: string;
  job_id: string;
  user_id: string;
  fighter_id: string;
  action: VideoSpriteAction;
  sequence_order: number;
  status: VideoSpriteCandidateStatus;
  current_revision: number;
  approved_revision: number | null;
  adjustment_claim_token: string | null;
  adjustment_claim_revision: number | null;
  adjustment_claim_indices_json: string | null;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by_user_id: string | null;
  review_reason: string | null;
}

export interface VideoSpriteCandidateRevisionRow {
  candidate_id: string;
  revision: number;
  compiler_outcome: 'technical_pass' | 'needs_review' | 'reject';
  semantic_promotion_approved: 0;
  sprite_version_id: string;
  provider_model: typeof PIXCLI_VIDEO_MODEL;
  pixcli_job_id: string;
  provider_request_id: string;
  prompt_sha256: string;
  canonical_blob_key: string;
  canonical_sha256: string;
  provider_audit_blob_key: string;
  provider_audit_sha256: string;
  video_blob_key: string;
  video_sha256: string;
  video_size_bytes: number;
  processed_blob_key: string;
  processed_sha256: string;
  raw_blob_key: string;
  raw_sha256: string;
  contact_sheet_blob_key: string;
  contact_sheet_sha256: string;
  unique_sheet_blob_key: string;
  unique_sheet_sha256: string;
  report_blob_key: string;
  report_sha256: string;
  report_content_sha256: string;
  frame_w: 192;
  frame_h: 256;
  frame_count: number;
  raw_frame_w: 768;
  raw_frame_h: 1024;
  raw_frame_count: number;
  source_frame_count: number;
  animation_format: 'video-dense-v1';
  processing_version: 5;
  selected_indices_json: string;
  playback_json: string;
  translations_json: string;
  created_at: string;
}

interface OwnedReviewRow extends VideoSpriteCandidateRow, VideoSpriteCandidateRevisionRow {
  job_status: string;
  job_review_status: string;
  tier: 'champion';
  operation: GenerationJob['operation'];
  target_name: string | null;
  run_operation: GenerationJob['operation'];
  run_target_name: string | null;
  run_status: string;
  approved_action_count: number;
  successor_job_id: string | null;
}

export interface PersistVideoCandidateInput {
  job: GenerationJob;
  action: VideoSpriteAction;
  sequenceOrder: number;
  pixcliJobId: string;
  providerRequestId: string;
  promptSha256: string;
  canonical: { blobKey: string; sha256: string; bytes: ArrayBuffer };
  providerAudit: { sha256: string; bytes: ArrayBuffer };
  video: { sha256: string; bytes: ArrayBuffer };
  compileResponse: VideoSpriteCompileResponse;
  projection: VideoSpriteCandidateReportProjection;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function isAction(value: unknown): value is VideoSpriteAction {
  return typeof value === 'string' && VIDEO_SPRITE_ACTIONS.includes(value as VideoSpriteAction);
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

async function putPrivateObject(
  env: Env,
  key: string,
  bytes: ArrayBuffer,
  contentType: string,
  sha256: string,
): Promise<void> {
  const existing = await env.SPRITES.head(key);
  if (existing) {
    if (existing.customMetadata?.contentSha256 !== sha256 || existing.size !== bytes.byteLength) {
      throw new Error('Private candidate object conflicts with an existing immutable key');
    }
    return;
  }
  await env.SPRITES.put(key, bytes, {
    httpMetadata: { contentType },
    customMetadata: { contentSha256: sha256, privateReview: 'true' },
  });
}

function revisionKeyPrefix(input: {
  userId: string;
  fighterId: string;
  candidateId: string;
  revision: number;
}): string {
  return `users/${input.userId}/fighters/${input.fighterId}/video-candidates/${input.candidateId}/revisions/${input.revision}`;
}

async function ownedReview(
  env: Env,
  userId: string,
  jobId: string,
  expected?: { candidateId: string; revision: number; reportSha256: string },
): Promise<OwnedReviewRow | null> {
  const row = await env.DB.prepare(`
    SELECT
      candidate.*,
      revision.*,
      job.status AS job_status,
      job.review_status AS job_review_status,
      job.tier,
      job.operation,
      job.target_name,
      run.operation AS run_operation,
      run.target_name AS run_target_name,
      run.status AS run_status,
      (SELECT COUNT(*) FROM video_sprite_candidates approved
        WHERE approved.run_id = candidate.run_id AND approved.status = 'approved') AS approved_action_count,
      successor.id AS successor_job_id
    FROM video_sprite_candidates candidate
    JOIN video_sprite_candidate_revisions revision
      ON revision.candidate_id = candidate.id
      AND revision.revision = candidate.current_revision
    JOIN generation_jobs job ON job.id = candidate.job_id
    JOIN generation_artifact_runs run ON run.id = candidate.run_id
    LEFT JOIN generation_jobs successor ON successor.resumed_from_job_id = candidate.job_id
    WHERE candidate.job_id = ? AND candidate.user_id = ?
      AND job.creation_flow = 'video' AND job.operation = 'fighter_generation'
      AND run.creation_flow = 'video' AND run.operation = 'fighter_generation'
    LIMIT 1
  `).bind(jobId, userId).first<OwnedReviewRow>();
  if (!row) return null;
  if (expected && (
    row.id !== expected.candidateId ||
    row.current_revision !== expected.revision ||
    row.report_sha256 !== expected.reportSha256
  )) return null;
  return row;
}

function reviewBinding(body: Record<string, unknown>): {
  candidateId: string;
  revision: number;
  reportSha256: string;
} | null {
  const candidateId = typeof body.candidateId === 'string' ? body.candidateId : '';
  const revision = Number(body.revision);
  const reportSha256 = typeof body.reportSha256 === 'string' ? body.reportSha256 : '';
  return /^[a-f0-9]{32}$/.test(candidateId) && Number.isInteger(revision) &&
    revision >= 1 && revision <= 100 && /^[a-f0-9]{64}$/.test(reportSha256)
    ? { candidateId, revision, reportSha256 }
    : null;
}

function serializeReview(row: OwnedReviewRow) {
  const suffix = `/api/generation-jobs/${row.job_id}/video-review/assets`;
  return {
    jobId: row.job_id,
    artifactRunId: row.run_id,
    candidateId: row.id,
    action: row.action,
    sequenceOrder: row.sequence_order,
    status: row.status,
    revision: row.current_revision,
    reportSha256: row.report_sha256,
    technicalOutcome: row.compiler_outcome,
    semanticPromotionApproved: false,
    selectedVideoIndices: JSON.parse(row.selected_indices_json) as number[],
    pendingAdjustmentIndices: row.adjustment_claim_indices_json
      ? JSON.parse(row.adjustment_claim_indices_json) as number[] : null,
    frameCount: row.frame_count,
    rawFrameCount: row.raw_frame_count,
    sourceFrameCount: row.source_frame_count,
    animationFormat: row.animation_format,
    processingVersion: row.processing_version,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    continuationAvailable: row.status === 'approved' && row.run_status === 'partial' &&
      !row.successor_job_id && row.approved_action_count < VIDEO_SPRITE_ACTIONS.length,
    continuationOperation: 'fighter_generation',
    restartOperation: row.status === 'rejected' || row.run_status === 'failed'
      ? 'fighter_generation' : null,
    fullRunRestartRequired: row.status === 'rejected' || row.run_status === 'failed',
    assets: {
      runtime: `${suffix}/runtime?revision=${row.current_revision}`,
      raw: `${suffix}/raw?revision=${row.current_revision}`,
      contactSheet: `${suffix}/contact-sheet?revision=${row.current_revision}`,
      uniqueSheet: `${suffix}/unique-sheet?revision=${row.current_revision}`,
      report: `${suffix}/report?revision=${row.current_revision}`,
      video: `${suffix}/video?revision=${row.current_revision}`,
    },
  };
}

async function persistRevisionObjects(
  env: Env,
  params: {
    job: GenerationJob;
    candidateId: string;
    revision: number;
    action: VideoSpriteAction;
    response: VideoSpriteCompileResponse;
    projection: VideoSpriteCandidateReportProjection;
  },
) {
  const prefix = revisionKeyPrefix({
    userId: params.job.user_id,
    fighterId: params.job.fighter_id,
    candidateId: params.candidateId,
    revision: params.revision,
  });
  const processedKey = `${prefix}/runtime-${params.projection.hashes.processed}.png`;
  const rawKey = `${prefix}/raw-${params.projection.hashes.raw}.png`;
  const contactSheetKey = `${prefix}/contact-${params.projection.hashes.contactSheet}.png`;
  const uniqueSheetKey = `${prefix}/unique-${params.projection.hashes.uniqueSheet}.png`;
  const reportKey = `${prefix}/report-${params.projection.reportSha256}.json`;
  await Promise.all([
    putPrivateObject(env, processedKey, params.projection.processedBytes, 'image/png', params.projection.hashes.processed),
    putPrivateObject(env, rawKey, params.projection.rawBytes, 'image/png', params.projection.hashes.raw),
    putPrivateObject(env, contactSheetKey, params.projection.contactSheetBytes, 'image/png', params.projection.hashes.contactSheet),
    putPrivateObject(env, uniqueSheetKey, params.projection.uniqueSheetBytes, 'image/png', params.projection.hashes.uniqueSheet),
    putPrivateObject(
      env,
      reportKey,
      params.projection.reportBytes,
      'application/json',
      params.projection.reportContentSha256,
    ),
  ]);
  const sprite = await persistGeneratedSprite(env, {
    jobId: params.job.id,
    userId: params.job.user_id,
    fighterId: params.job.fighter_id,
    tier: params.job.tier,
    animationName: params.action,
    bytes: params.projection.processedBytes,
    rawBytes: params.projection.rawBytes,
    frameWidth: params.response.frameW,
    frameHeight: params.response.frameH,
    frameCount: params.response.frameCount,
    processingVersion: params.response.processingVersion,
    animationFormat: params.response.animationFormat,
    setCurrent: false,
  });
  return { sprite, processedKey, rawKey, contactSheetKey, uniqueSheetKey, reportKey };
}

export async function persistInitialVideoSpriteCandidate(
  env: Env,
  input: PersistVideoCandidateInput,
): Promise<{ candidateId: string; revision: number }> {
  if (
    input.job.creation_flow !== 'video' || input.job.operation !== 'fighter_generation' ||
    input.job.tier !== 'champion' ||
    !input.job.artifact_run_id || !isAction(input.action) ||
    input.sequenceOrder !== VIDEO_SPRITE_ACTIONS.indexOf(input.action) ||
    input.video.bytes.byteLength < 12 || input.video.bytes.byteLength > MAX_VIDEO_BYTES ||
    input.providerAudit.bytes.byteLength < 2 || input.providerAudit.bytes.byteLength > MAX_AUDIT_BYTES
  ) throw new Error('Video candidate persistence contract is invalid');
  if (
    !/^[a-f0-9]{32}$/.test(input.pixcliJobId) ||
    input.providerRequestId.length < 8 || input.providerRequestId.length > 200 ||
    !/^[a-f0-9]{64}$/.test(input.promptSha256) ||
    await hashString(input.canonical.bytes) !== input.canonical.sha256 ||
    await hashString(input.providerAudit.bytes) !== input.providerAudit.sha256 ||
    await hashString(input.video.bytes) !== input.video.sha256 ||
    await hashString(input.projection.processedBytes) !== input.projection.hashes.processed ||
    await hashString(input.projection.rawBytes) !== input.projection.hashes.raw ||
    await hashString(input.projection.contactSheetBytes) !== input.projection.hashes.contactSheet ||
    await hashString(input.projection.uniqueSheetBytes) !== input.projection.hashes.uniqueSheet ||
    await hashString(input.projection.reportBytes) !== input.projection.reportContentSha256
  ) throw new Error('Video candidate bytes do not match their sealed hashes');
  const videoHeader = new Uint8Array(input.video.bytes, 0, Math.min(12, input.video.bytes.byteLength));
  if (videoHeader.byteLength < 12 || String.fromCharCode(...videoHeader.slice(4, 8)) !== 'ftyp') {
    throw new Error('Video candidate is not a supported MP4');
  }
  const canonicalObject = await env.SPRITES.get(input.canonical.blobKey);
  if (!canonicalObject) throw new Error('Video candidate canonical object is unavailable');
  const canonicalObjectBytes = await canonicalObject.arrayBuffer();
  if (
    canonicalObjectBytes.byteLength !== input.canonical.bytes.byteLength ||
    await hashString(canonicalObjectBytes) !== input.canonical.sha256
  ) throw new Error('Video candidate canonical object failed integrity validation');
  const candidateId = (await hashString(`${input.job.id}:video-candidate:${input.action}`)).slice(0, 32);
  const existing = await env.DB.prepare(`
    SELECT candidate.id, candidate.current_revision, revision.report_sha256
    FROM video_sprite_candidates candidate
    JOIN video_sprite_candidate_revisions revision
      ON revision.candidate_id = candidate.id AND revision.revision = candidate.current_revision
    WHERE candidate.job_id = ?
  `).bind(input.job.id).first<{ id: string; current_revision: number; report_sha256: string }>();
  if (existing) {
    if (existing.id !== candidateId || existing.current_revision !== 1 ||
      existing.report_sha256 !== input.projection.reportSha256) {
      throw new Error('Generation job already owns a different immutable video candidate');
    }
    return { candidateId, revision: 1 };
  }
  const basePrefix = `users/${input.job.user_id}/fighters/${input.job.fighter_id}/video-candidates/${candidateId}`;
  const auditKey = `${basePrefix}/provider-audit-${input.providerAudit.sha256}.json`;
  const videoKey = `${basePrefix}/source-${input.video.sha256}.mp4`;
  await Promise.all([
    putPrivateObject(env, auditKey, input.providerAudit.bytes, 'application/json', input.providerAudit.sha256),
    putPrivateObject(env, videoKey, input.video.bytes, 'video/mp4', input.video.sha256),
  ]);
  const objects = await persistRevisionObjects(env, {
    job: input.job,
    candidateId,
    revision: 1,
    action: input.action,
    response: input.compileResponse,
    projection: input.projection,
  });
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO video_sprite_candidates (
        id, run_id, job_id, user_id, fighter_id, action, sequence_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      candidateId, input.job.artifact_run_id, input.job.id, input.job.user_id,
      input.job.fighter_id, input.action, input.sequenceOrder,
    ),
    env.DB.prepare(`
      INSERT INTO video_sprite_candidate_revisions (
        candidate_id, revision, compiler_outcome, sprite_version_id,
        provider_model, pixcli_job_id, provider_request_id, prompt_sha256,
        canonical_blob_key, canonical_sha256, provider_audit_blob_key, provider_audit_sha256,
        video_blob_key, video_sha256, video_size_bytes,
        processed_blob_key, processed_sha256, raw_blob_key, raw_sha256,
        contact_sheet_blob_key, contact_sheet_sha256, unique_sheet_blob_key, unique_sheet_sha256,
        report_blob_key, report_sha256, report_content_sha256, frame_w, frame_h, frame_count,
        raw_frame_w, raw_frame_h, raw_frame_count, source_frame_count, animation_format, processing_version,
        selected_indices_json, playback_json, translations_json
      ) VALUES (
        ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).bind(
      candidateId, input.projection.outcome, objects.sprite.versionId,
      PIXCLI_VIDEO_MODEL, input.pixcliJobId, input.providerRequestId, input.promptSha256,
      input.canonical.blobKey, input.canonical.sha256, auditKey, input.providerAudit.sha256,
      videoKey, input.video.sha256, input.video.bytes.byteLength,
      objects.processedKey, input.projection.hashes.processed,
      objects.rawKey, input.projection.hashes.raw,
      objects.contactSheetKey, input.projection.hashes.contactSheet,
      objects.uniqueSheetKey, input.projection.hashes.uniqueSheet,
      objects.reportKey, input.projection.reportSha256, input.projection.reportContentSha256,
      input.compileResponse.frameW, input.compileResponse.frameH, input.compileResponse.frameCount,
      input.compileResponse.rawFrameW, input.compileResponse.rawFrameH, input.compileResponse.rawFrameCount,
      input.projection.sourceFrameCount,
      input.compileResponse.animationFormat, input.compileResponse.processingVersion,
      JSON.stringify(input.projection.selectedIndices), JSON.stringify(input.projection.playback),
      JSON.stringify(input.projection.translations),
    ),
  ]);
  return { candidateId, revision: 1 };
}

interface CandidateSpriteVersionRow {
  id: string;
  fighter_id: string;
  animation_name: string;
  quality_tier: string;
  blob_key: string;
  raw_blob_key: string | null;
  content_hash: string;
  raw_content_hash: string | null;
  frame_w: number;
  frame_h: number;
  frame_count: number;
  animation_format: string;
  processing_version: number;
}

async function requireApprovalIntegrity(env: Env, row: OwnedReviewRow): Promise<CandidateSpriteVersionRow> {
  const objectBindings = [
    [row.processed_blob_key, row.processed_sha256],
    [row.raw_blob_key, row.raw_sha256],
    [row.contact_sheet_blob_key, row.contact_sheet_sha256],
    [row.unique_sheet_blob_key, row.unique_sheet_sha256],
    [row.report_blob_key, row.report_content_sha256],
    [row.canonical_blob_key, row.canonical_sha256],
    [row.provider_audit_blob_key, row.provider_audit_sha256],
    [row.video_blob_key, row.video_sha256],
  ] as const;
  const objects = await Promise.all(objectBindings.map(([key]) => env.SPRITES.get(key)));
  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index];
    if (!object) throw new Error('Video review artifact is unavailable');
    const expectedHash = objectBindings[index][1];
    const storedHash = object.customMetadata?.contentSha256 ?? object.customMetadata?.contentHash;
    if (storedHash !== expectedHash) {
      throw new Error('Video review artifact metadata failed integrity validation');
    }
    if (await hashString(await object.arrayBuffer()) !== expectedHash) {
      throw new Error('Video review artifact failed integrity validation');
    }
  }
  if (objects[7]!.size !== row.video_size_bytes) {
    throw new Error('Video review source size changed');
  }
  const version = await env.DB.prepare(`
    SELECT * FROM sprite_versions
    WHERE id = ? AND fighter_id = ? AND animation_name = ? AND quality_tier = ?
    LIMIT 1
  `).bind(row.sprite_version_id, row.fighter_id, row.action, row.tier)
    .first<CandidateSpriteVersionRow>();
  if (
    !version || version.content_hash !== row.processed_sha256 ||
    version.raw_content_hash !== row.raw_sha256 ||
    version.frame_w !== row.frame_w || version.frame_h !== row.frame_h ||
    version.frame_count !== row.frame_count || version.animation_format !== row.animation_format ||
    version.processing_version !== row.processing_version
  ) throw new Error('Private sprite version does not match the sealed candidate revision');
  const [runtime, raw] = await Promise.all([
    env.SPRITES.get(version.blob_key),
    version.raw_blob_key ? env.SPRITES.get(version.raw_blob_key) : Promise.resolve(null),
  ]);
  if (!runtime || !raw || await hashString(await runtime.arrayBuffer()) !== row.processed_sha256 ||
    await hashString(await raw.arrayBuffer()) !== row.raw_sha256) {
    throw new Error('Private sprite version artifacts failed integrity validation');
  }
  if (
    runtime.customMetadata?.contentHash !== row.processed_sha256 ||
    raw.customMetadata?.contentHash !== row.raw_sha256 ||
    runtime.customMetadata?.animationName !== row.action ||
    raw.customMetadata?.animationName !== row.action ||
    runtime.customMetadata?.animationFormat !== row.animation_format ||
    raw.customMetadata?.animationFormat !== row.animation_format ||
    runtime.customMetadata?.qualityTier !== row.tier ||
    raw.customMetadata?.qualityTier !== row.tier ||
    raw.customMetadata?.raw !== 'true'
  ) throw new Error('Private sprite version metadata failed integrity validation');
  return version;
}

export async function getVideoSpriteReview(
  env: Env,
  auth: AuthContext,
  jobId: string,
): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(jobId)) return json({ error: 'Video review not found' }, 404);
  let row = await ownedReview(env, auth.userId, jobId);
  if (!row) return json({ error: 'Video review not found' }, 404);
  if (
    row.status === 'approved' && row.run_status === 'partial' &&
    row.approved_action_count === VIDEO_SPRITE_ACTIONS.length
  ) {
    const terminalFailure = await reconcileApprovedVideoRun(env, row);
    row = await ownedReview(env, auth.userId, jobId);
    if (!row) return json({ error: 'Finalized video review could not be reloaded' }, 500);
    return json(terminalFailure ? {
      finalizationError: terminalFailure,
      review: serializeReview(row),
    } : { review: serializeReview(row) });
  }
  return json({ review: serializeReview(row) });
}

export async function approveVideoSpriteReview(
  request: Request,
  env: Env,
  auth: AuthContext,
  jobId: string,
): Promise<Response> {
  const body = await readJsonBody<Record<string, unknown>>(request, MAX_REVIEW_BODY_BYTES);
  const binding = reviewBinding(body);
  if (!binding) return json({ error: 'Exact candidate revision binding is required' }, 400);
  const row = await ownedReview(env, auth.userId, jobId, binding);
  if (!row) return json({ error: 'Video review revision changed; reload before approving' }, 409);
  if (row.status === 'approved') {
    const terminalFailure = await reconcileApprovedVideoRun(env, row);
    const replay = await ownedReview(env, auth.userId, jobId);
    return replay
      ? json(terminalFailure ? { error: terminalFailure, review: serializeReview(replay) } : {
          review: serializeReview(replay),
        }, terminalFailure ? 409 : 200)
      : json({ error: 'Approved review could not be reloaded' }, 500);
  }
  if (row.status !== 'awaiting_review' || row.job_status !== 'succeeded' ||
    row.job_review_status !== 'awaiting_review' || row.adjustment_claim_token !== null) {
    return json({ error: 'Video review is not awaiting approval' }, 409);
  }
  if (row.compiler_outcome === 'reject') {
    return json({ error: 'A technically rejected revision cannot be promoted; adjust or reject it' }, 422);
  }
  try {
    await requireApprovalIntegrity(env, row);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Video review integrity failed' }, 409);
  }
  const checkpointStage = row.sequence_order + 4;
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE video_sprite_candidates
      SET status = 'approved', approved_revision = current_revision,
          reviewed_at = datetime('now'), reviewed_by_user_id = ?, review_reason = NULL
      WHERE id = ? AND user_id = ? AND status = 'awaiting_review'
        AND current_revision = ?
        AND adjustment_claim_token IS NULL
        AND EXISTS (
          SELECT 1 FROM video_sprite_candidate_revisions revision
          WHERE revision.candidate_id = video_sprite_candidates.id
            AND revision.revision = ? AND revision.report_sha256 = ?
            AND revision.compiler_outcome <> 'reject'
        )
    `).bind(auth.userId, row.id, auth.userId, row.current_revision, row.current_revision, row.report_sha256),
    env.DB.prepare(`
      INSERT INTO sprites (
        id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
        content_hash, raw_content_hash, frame_w, frame_h, frame_count,
        processing_version, animation_format
      )
      SELECT ?, version.fighter_id, version.animation_name, version.quality_tier,
        version.blob_key, version.raw_blob_key, version.content_hash, version.raw_content_hash,
        version.frame_w, version.frame_h, version.frame_count, version.processing_version,
        version.animation_format
      FROM sprite_versions version
      JOIN video_sprite_candidate_revisions revision ON revision.sprite_version_id = version.id
      JOIN video_sprite_candidates candidate ON candidate.id = revision.candidate_id
      WHERE candidate.id = ? AND candidate.status = 'approved'
        AND candidate.approved_revision = ? AND revision.revision = ?
        AND revision.report_sha256 = ?
      ON CONFLICT(fighter_id, animation_name, quality_tier) DO UPDATE SET
        blob_key = excluded.blob_key, raw_blob_key = excluded.raw_blob_key,
        content_hash = excluded.content_hash, raw_content_hash = excluded.raw_content_hash,
        frame_w = excluded.frame_w, frame_h = excluded.frame_h,
        frame_count = excluded.frame_count, processing_version = excluded.processing_version,
        animation_format = excluded.animation_format, created_at = datetime('now')
    `).bind(generateId(), row.id, row.current_revision, row.current_revision, row.report_sha256),
    env.DB.prepare(`
      INSERT OR IGNORE INTO generation_artifact_checkpoints (
        run_id, artifact_kind, artifact_name, stage_index, tier, status,
        clean_version_id, clean_blob_key, raw_blob_key, clean_content_hash, raw_content_hash,
        frame_w, frame_h, frame_count, animation_format, processing_version,
        completed_by_job_id, verified_at
      )
      SELECT candidate.run_id, 'sprite', candidate.action, ?,
        job.tier, 'approved', revision.sprite_version_id,
        version.blob_key, version.raw_blob_key,
        version.content_hash, version.raw_content_hash,
        revision.frame_w, revision.frame_h, revision.frame_count,
        revision.animation_format, revision.processing_version, candidate.job_id, datetime('now')
      FROM video_sprite_candidates candidate
      JOIN video_sprite_candidate_revisions revision
        ON revision.candidate_id = candidate.id AND revision.revision = candidate.approved_revision
      JOIN generation_jobs job ON job.id = candidate.job_id
      JOIN sprite_versions version ON version.id = revision.sprite_version_id
      WHERE candidate.id = ? AND candidate.status = 'approved'
        AND candidate.approved_revision = ? AND revision.report_sha256 = ?
    `).bind(
      checkpointStage, row.id, row.current_revision, row.report_sha256,
    ),
    env.DB.prepare(`
      UPDATE generation_jobs
      SET review_status = 'approved', stage = 'review:approved',
          progress_current = MIN(progress_total, (
            SELECT COUNT(*) FROM generation_artifact_checkpoints checkpoint
            WHERE checkpoint.run_id = ? AND checkpoint.status = 'approved'
          )),
          updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND status = 'succeeded'
        AND review_status = 'awaiting_review'
        AND EXISTS (
          SELECT 1 FROM video_sprite_candidates candidate
          WHERE candidate.id = ? AND candidate.status = 'approved'
            AND candidate.approved_revision = ?
        )
    `).bind(row.run_id, jobId, auth.userId, row.id, row.current_revision),
    env.DB.prepare(`
      UPDATE provider_cost_events
      SET job_outcome = 'succeeded'
      WHERE job_id = ? AND job_outcome = 'succeeded_partial'
        AND EXISTS (
          SELECT 1 FROM video_sprite_candidates candidate
          WHERE candidate.id = ? AND candidate.status = 'approved'
            AND candidate.approved_revision = ?
        )
    `).bind(jobId, row.id, row.current_revision),
    env.DB.prepare(`
      UPDATE generation_artifact_runs
      SET status = 'partial', completed_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND status = 'partial'
        AND EXISTS (
          SELECT 1 FROM video_sprite_candidates candidate
          WHERE candidate.id = ? AND candidate.status = 'approved'
            AND candidate.approved_revision = ?
        )
    `).bind(
      row.run_id,
      auth.userId,
      row.id,
      row.current_revision,
    ),
    env.DB.prepare(`
      INSERT OR IGNORE INTO generation_job_events (id, job_id, stage, status, detail)
      SELECT ?, ?, 'review:approved', 'succeeded', ?
      WHERE EXISTS (
        SELECT 1 FROM video_sprite_candidates
        WHERE id = ? AND status = 'approved' AND approved_revision = ?
      )
    `).bind(
      `${row.id}:r${row.current_revision}:approved`,
      jobId,
      `${row.action} revision ${row.current_revision} approved`,
      row.id,
      row.current_revision,
    ),
  ]);
  if ((results[0].meta.changes ?? 0) !== 1) {
    const replay = await ownedReview(env, auth.userId, jobId, binding);
    if (replay?.status === 'approved') {
      const terminalFailure = await reconcileApprovedVideoRun(env, replay);
      const finalizedReplay = await ownedReview(env, auth.userId, jobId);
      return finalizedReplay
        ? json(terminalFailure ? { error: terminalFailure, review: serializeReview(finalizedReplay) } : {
            review: serializeReview(finalizedReplay),
          }, terminalFailure ? 409 : 200)
        : json({ error: 'Approved review could not be reloaded' }, 500);
    }
    return json({ error: 'Video review changed concurrently; reload before approving' }, 409);
  }
  const approved = await ownedReview(env, auth.userId, jobId);
  if (!approved) return json({ error: 'Approved review could not be reloaded' }, 500);
  const terminalFailure = await reconcileApprovedVideoRun(env, approved);
  const finalized = await ownedReview(env, auth.userId, jobId);
  if (!finalized) return json({ error: 'Approved review could not be finalized' }, 500);
  return json(terminalFailure ? { error: terminalFailure, review: serializeReview(finalized) } : {
    review: serializeReview(finalized),
  }, terminalFailure ? 409 : 200);
}

const TERMINAL_REVIEW_INTEGRITY_MESSAGES = [
  'Video review artifact is unavailable',
  'Video review artifact metadata failed integrity validation',
  'Video review artifact failed integrity validation',
  'Video review source size changed',
  'Private sprite version does not match the sealed candidate revision',
  'Private sprite version artifacts failed integrity validation',
  'Private sprite version metadata failed integrity validation',
  'Approved video run does not contain the exact required action set',
  'Approved video run revision lineage changed before finalization',
  'Approved video checkpoint no longer matches its sealed sprite version',
  'Generation cannot complete with pending durable stages:',
  'Approved video run could not be finalized atomically',
];

async function reconcileApprovedVideoRun(env: Env, row: OwnedReviewRow): Promise<string | null> {
  try {
    await reconcileApprovedVideoRunUnchecked(env, row);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!TERMINAL_REVIEW_INTEGRITY_MESSAGES.some((prefix) => message.startsWith(prefix))) throw error;
    const bounded = message.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    const terminalCandidate = await env.DB.prepare(`
      SELECT job_id FROM video_sprite_candidates
      WHERE run_id = ? AND status = 'approved'
      ORDER BY sequence_order DESC
      LIMIT 1
    `).bind(row.run_id).first<{ job_id: string }>();
    const terminalJobId = terminalCandidate?.job_id ?? row.job_id;
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE generation_artifact_runs
        SET status = 'failed', failure_stage = 'review:integrity',
            completed_at = NULL, updated_at = datetime('now')
        WHERE id = ? AND user_id = ? AND fighter_id = ? AND status = 'partial'
      `).bind(row.run_id, row.user_id, row.fighter_id),
      env.DB.prepare(`
        UPDATE generation_jobs
        SET stage = 'review:restart_required', failure_stage = 'review:integrity',
            error_code = 'video_review_integrity_failed', error_message = ?,
            updated_at = datetime('now')
        WHERE id = ? AND user_id = ? AND status = 'succeeded' AND review_status = 'approved'
          AND EXISTS (
            SELECT 1 FROM generation_artifact_runs run
            WHERE run.id = ? AND run.status = 'failed'
          )
      `).bind(bounded, terminalJobId, row.user_id, row.run_id),
      env.DB.prepare(`
        UPDATE provider_cost_events
        SET job_outcome = 'failed_partial'
        WHERE artifact_run_id = ? AND job_outcome = 'succeeded_partial'
          AND EXISTS (
            SELECT 1 FROM generation_artifact_runs run
            WHERE run.id = ? AND run.status = 'failed'
          )
      `).bind(row.run_id, row.run_id),
      env.DB.prepare(`
        INSERT OR IGNORE INTO generation_job_events (id, job_id, stage, status, detail)
        SELECT ?, ?, 'review:restart_required', 'failed', ?
        WHERE EXISTS (
          SELECT 1 FROM generation_artifact_runs run
          WHERE run.id = ? AND run.status = 'failed'
        )
      `).bind(`${terminalJobId}:video-integrity-failed`, terminalJobId, bounded, row.run_id),
    ]);
    const terminal = await env.DB.prepare(`
      SELECT status FROM generation_artifact_runs WHERE id = ? AND user_id = ?
    `).bind(row.run_id, row.user_id).first<{ status: string }>();
    if (terminal?.status === 'succeeded') return null;
    if (terminal?.status === 'failed') return bounded;
    throw new Error('Video review integrity failure could not be terminalized atomically');
  }
}

async function reconcileApprovedVideoRunUnchecked(env: Env, row: OwnedReviewRow): Promise<void> {
  if (row.status !== 'approved' || row.run_status === 'succeeded') return;
  const { results } = await env.DB.prepare(`
    SELECT action FROM video_sprite_candidates WHERE run_id = ? AND status = 'approved'
  `).bind(row.run_id).all<{ action: VideoSpriteAction }>();
  const approved = new Set((results ?? []).map((entry) => entry.action));
  const complete = VIDEO_SPRITE_ACTIONS.every((action) => approved.has(action));
  if (!complete) return;
  const { results: approvedCandidates } = await env.DB.prepare(`
    SELECT job_id, action
    FROM video_sprite_candidates
    WHERE run_id = ? AND status = 'approved'
    ORDER BY sequence_order ASC
  `).bind(row.run_id).all<{ job_id: string; action: VideoSpriteAction }>();
  const expectedActions = [...VIDEO_SPRITE_ACTIONS];
  if (
    approvedCandidates.length !== expectedActions.length ||
    approvedCandidates.some((candidate, index) => candidate.action !== expectedActions[index])
  ) throw new Error('Approved video run does not contain the exact required action set');
  const terminalJobId = approvedCandidates.at(-1)?.job_id;
  if (!terminalJobId) throw new Error('Approved video run does not contain the exact required action set');

  const verified: Array<{ review: OwnedReviewRow; version: CandidateSpriteVersionRow }> = [];
  for (const candidate of approvedCandidates) {
    const review = await ownedReview(env, row.user_id, candidate.job_id);
    if (!review || review.run_id !== row.run_id || review.status !== 'approved' ||
      review.approved_revision !== review.current_revision || review.action !== candidate.action) {
      throw new Error('Approved video run revision lineage changed before finalization');
    }
    const version = await requireApprovalIntegrity(env, review);
    const checkpoint = await env.DB.prepare(`
      SELECT clean_version_id, clean_blob_key, raw_blob_key,
        clean_content_hash, raw_content_hash, frame_w, frame_h, frame_count,
        animation_format, processing_version, status
      FROM generation_artifact_checkpoints
      WHERE run_id = ? AND artifact_kind = 'sprite' AND artifact_name = ?
      LIMIT 1
    `).bind(row.run_id, candidate.action).first<{
      clean_version_id: string;
      clean_blob_key: string;
      raw_blob_key: string | null;
      clean_content_hash: string | null;
      raw_content_hash: string | null;
      frame_w: number | null;
      frame_h: number | null;
      frame_count: number | null;
      animation_format: string;
      processing_version: number | null;
      status: string;
    }>();
    if (
      !checkpoint || checkpoint.status !== 'approved' ||
      checkpoint.clean_version_id !== version.id ||
      checkpoint.clean_blob_key !== version.blob_key ||
      checkpoint.raw_blob_key !== version.raw_blob_key ||
      checkpoint.clean_content_hash !== version.content_hash ||
      checkpoint.raw_content_hash !== version.raw_content_hash ||
      checkpoint.frame_w !== version.frame_w || checkpoint.frame_h !== version.frame_h ||
      checkpoint.frame_count !== version.frame_count ||
      checkpoint.animation_format !== version.animation_format ||
      checkpoint.processing_version !== version.processing_version
    ) throw new Error('Approved video checkpoint no longer matches its sealed sprite version');
    verified.push({ review, version });
  }
  const job = await env.DB.prepare('SELECT * FROM generation_jobs WHERE id = ? AND user_id = ?')
    .bind(terminalJobId, row.user_id).first<GenerationJob>();
  if (!job) throw new Error('Approved generation job could not be reloaded');
  await assertArtifactRunComplete(env, job);
  const promoteStatements = verified.map(({ review, version }) => env.DB.prepare(`
    INSERT INTO sprites (
      id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
      content_hash, raw_content_hash, frame_w, frame_h, frame_count,
      processing_version, animation_format
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM generation_artifact_runs run
      WHERE run.id = ? AND run.user_id = ? AND run.fighter_id = ? AND run.status = 'succeeded'
    )
    ON CONFLICT(fighter_id, animation_name, quality_tier) DO UPDATE SET
      blob_key = excluded.blob_key, raw_blob_key = excluded.raw_blob_key,
      content_hash = excluded.content_hash, raw_content_hash = excluded.raw_content_hash,
      frame_w = excluded.frame_w, frame_h = excluded.frame_h,
      frame_count = excluded.frame_count, processing_version = excluded.processing_version,
      animation_format = excluded.animation_format, created_at = datetime('now')
  `).bind(
    generateId(), review.fighter_id, review.action, review.tier,
    version.blob_key, version.raw_blob_key, version.content_hash, version.raw_content_hash,
    version.frame_w, version.frame_h, version.frame_count,
    version.processing_version, version.animation_format,
    row.run_id, row.user_id, row.fighter_id,
  ));
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE generation_artifact_runs
      SET status = 'succeeded', failure_stage = NULL,
          completed_at = COALESCE(completed_at, datetime('now')), updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND fighter_id = ? AND status = 'partial'
    `).bind(row.run_id, row.user_id, row.fighter_id),
    ...promoteStatements,
    env.DB.prepare(`
      UPDATE fighters
      SET quality_tier = 'champion', updated_at = datetime('now')
      WHERE id = ? AND owner_user_id = ?
        AND EXISTS (
          SELECT 1 FROM generation_artifact_runs run
          WHERE run.id = ? AND run.status = 'succeeded'
        )
    `).bind(row.fighter_id, row.user_id, row.run_id),
    env.DB.prepare(`
      UPDATE generation_jobs
      SET stage = 'complete', progress_current = progress_total,
          updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND status = 'succeeded'
        AND review_status = 'approved'
        AND EXISTS (
          SELECT 1 FROM generation_artifact_runs run
          WHERE run.id = ? AND run.status = 'succeeded'
        )
    `).bind(terminalJobId, row.user_id, row.run_id),
    env.DB.prepare(`
      UPDATE provider_cost_events
      SET job_outcome = 'succeeded'
      WHERE artifact_run_id = ? AND job_outcome = 'succeeded_partial'
        AND EXISTS (
          SELECT 1 FROM generation_artifact_runs run
          WHERE run.id = ? AND run.status = 'succeeded'
        )
    `).bind(row.run_id, row.run_id),
    env.DB.prepare(`
      INSERT OR IGNORE INTO generation_job_events (id, job_id, stage, status, detail)
      SELECT ?, ?, 'complete', 'succeeded', 'All review-gated video actions are approved'
      WHERE EXISTS (
        SELECT 1 FROM generation_artifact_runs run
        WHERE run.id = ? AND run.status = 'succeeded'
      )
    `).bind(`${terminalJobId}:video-complete`, terminalJobId, row.run_id),
  ]);
  const finalized = await env.DB.prepare(`
    SELECT status FROM generation_artifact_runs WHERE id = ? AND user_id = ?
  `).bind(row.run_id, row.user_id).first<{ status: string }>();
  if (finalized?.status !== 'succeeded') {
    throw new Error('Approved video run could not be finalized atomically');
  }
}

export async function rejectVideoSpriteReview(
  request: Request,
  env: Env,
  auth: AuthContext,
  jobId: string,
): Promise<Response> {
  const body = await readJsonBody<Record<string, unknown>>(request, MAX_REVIEW_BODY_BYTES);
  const binding = reviewBinding(body);
  if (!binding) return json({ error: 'Exact candidate revision binding is required' }, 400);
  const review = await ownedReview(env, auth.userId, jobId, binding);
  if (!review) return json({ error: 'Video review revision changed; reload before rejecting' }, 409);
  if (review.status === 'rejected') return json({ review: serializeReview(review) });
  if (
    review.status !== 'awaiting_review' || review.job_status !== 'succeeded' ||
    review.job_review_status !== 'awaiting_review' || review.adjustment_claim_token !== null
  ) return json({ error: 'Video review is not awaiting rejection' }, 409);
  const reason = typeof body.reason === 'string'
    ? body.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
    : '';
  const result = await env.DB.batch([
    env.DB.prepare(`
      UPDATE video_sprite_candidates
      SET status = 'rejected', reviewed_at = datetime('now'), reviewed_by_user_id = ?,
          review_reason = ?
      WHERE id = ? AND job_id = ? AND user_id = ? AND status = 'awaiting_review'
        AND current_revision = ?
        AND adjustment_claim_token IS NULL
        AND EXISTS (
          SELECT 1 FROM video_sprite_candidate_revisions revision
          WHERE revision.candidate_id = video_sprite_candidates.id
            AND revision.revision = ? AND revision.report_sha256 = ?
        )
        AND EXISTS (
          SELECT 1 FROM generation_jobs job
          WHERE job.id = video_sprite_candidates.job_id AND job.status = 'succeeded'
            AND job.review_status = 'awaiting_review'
        )
    `).bind(auth.userId, reason || null, binding.candidateId, jobId, auth.userId,
      binding.revision, binding.revision, binding.reportSha256),
    env.DB.prepare(`
      UPDATE generation_jobs
      SET review_status = 'rejected', stage = 'review:rejected',
          failure_stage = 'review:rejected', updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND status = 'succeeded'
        AND review_status = 'awaiting_review'
        AND EXISTS (
          SELECT 1 FROM video_sprite_candidates candidate
          JOIN video_sprite_candidate_revisions revision
            ON revision.candidate_id = candidate.id AND revision.revision = candidate.current_revision
          WHERE candidate.id = ? AND candidate.status = 'rejected'
            AND candidate.current_revision = ? AND revision.report_sha256 = ?
        )
    `).bind(jobId, auth.userId, binding.candidateId, binding.revision, binding.reportSha256),
    env.DB.prepare(`
      UPDATE generation_artifact_runs
      SET status = 'failed', failure_stage = 'review:rejected', updated_at = datetime('now')
      WHERE id = ? AND status = 'partial'
        AND EXISTS (
          SELECT 1 FROM video_sprite_candidates candidate
          WHERE candidate.id = ? AND candidate.status = 'rejected'
        )
    `).bind(review.run_id, binding.candidateId),
    env.DB.prepare(`
      UPDATE provider_cost_events
      SET job_outcome = 'failed_partial'
      WHERE job_id = ? AND job_outcome = 'succeeded_partial'
        AND EXISTS (
          SELECT 1 FROM video_sprite_candidates candidate
          WHERE candidate.id = ? AND candidate.status = 'rejected'
        )
    `).bind(jobId, binding.candidateId),
    env.DB.prepare(`
      INSERT OR IGNORE INTO generation_job_events (id, job_id, stage, status, detail)
      SELECT ?, ?, 'review:rejected', 'failed', ?
      WHERE EXISTS (
        SELECT 1 FROM video_sprite_candidates WHERE id = ? AND status = 'rejected'
      )
    `).bind(
      `${binding.candidateId}:r${binding.revision}:rejected`,
      jobId,
      reason || 'Video candidate rejected by its owner',
      binding.candidateId,
    ),
  ]);
  if ((result[0].meta.changes ?? 0) !== 1) {
    const replay = await ownedReview(env, auth.userId, jobId, binding);
    if (replay?.status === 'rejected') return json({ review: serializeReview(replay) });
    return json({ error: 'Video review changed concurrently; reload before rejecting' }, 409);
  }
  const rejected = await ownedReview(env, auth.userId, jobId);
  return rejected ? json({ review: serializeReview(rejected) }) : json({ error: 'Rejected review could not be reloaded' }, 500);
}

async function callCompiler(
  env: Env,
  jobId: string,
  body: Record<string, unknown>,
): Promise<VideoSpriteCompileResponse> {
  if (!env.IMAGE_PROCESSOR) throw new Error('Image processor binding is unavailable');
  const response = await env.IMAGE_PROCESSOR.getByName(jobId).fetch(new Request(
    'http://image-processor/v1/compile-video-sprite',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  ));
  if (!response.ok) throw new Error(`Video compiler rejected the adjustment (${response.status})`);
  if (!response.body) throw new Error('Video compiler returned an empty adjustment');
  const bytes = await new Response(createBoundedByteStream(response.body, MAX_COMPILER_RESPONSE_BYTES)).arrayBuffer();
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as VideoSpriteCompileResponse;
  } catch {
    throw new Error('Video compiler returned invalid JSON');
  }
}

export async function adjustVideoSpriteReview(
  request: Request,
  env: Env,
  auth: AuthContext,
  jobId: string,
): Promise<Response> {
  const body = await readJsonBody<Record<string, unknown>>(request, MAX_REVIEW_BODY_BYTES);
  const binding = reviewBinding(body);
  if (!binding || !Array.isArray(body.selectedVideoIndices) ||
    !body.selectedVideoIndices.every(Number.isSafeInteger)) {
    return json({ error: 'Exact revision binding and selectedVideoIndices are required' }, 400);
  }
  const row = await ownedReview(env, auth.userId, jobId, binding);
  if (!row) return json({ error: 'Video review revision changed; reload before adjusting' }, 409);
  if (
    row.status !== 'awaiting_review' || row.current_revision >= 100 ||
    row.job_status !== 'succeeded' || row.job_review_status !== 'awaiting_review'
  ) {
    return json({ error: 'Video review cannot be adjusted' }, 409);
  }
  const [videoObject, canonicalObject] = await Promise.all([
    env.SPRITES.get(row.video_blob_key),
    env.SPRITES.get(row.canonical_blob_key),
  ]);
  if (!videoObject || !canonicalObject) return json({ error: 'Private source media is unavailable' }, 410);
  const [videoBytes, canonicalBytes] = await Promise.all([
    videoObject.arrayBuffer(), canonicalObject.arrayBuffer(),
  ]);
  if (await hashString(videoBytes) !== row.video_sha256 ||
    await hashString(canonicalBytes) !== row.canonical_sha256) {
    return json({ error: 'Private source media failed integrity validation' }, 409);
  }
  let response: VideoSpriteCompileResponse;
  let projection: VideoSpriteCandidateReportProjection;
  try {
    response = await callCompiler(env, jobId, {
      schemaVersion: 1,
      action: row.action,
      expectedFacing: 'right',
      videoBase64: arrayBufferToBase64(videoBytes),
      canonicalFrameBase64: arrayBufferToBase64(canonicalBytes),
      selectedVideoIndices: body.selectedVideoIndices,
      lineage: {
        jobId,
        runId: row.run_id,
        fighterId: row.fighter_id,
        provider: 'fal',
        modelId: row.provider_model,
        providerRequestId: row.provider_request_id,
        promptSha256: row.prompt_sha256,
        videoSha256: row.video_sha256,
        canonicalSha256: row.canonical_sha256,
      },
    });
    projection = await projectCompilerReport(response, row.action, {
      facing: 'right',
      lineage: {
        jobId,
        runId: row.run_id,
        fighterId: row.fighter_id,
        provider: 'fal',
        modelId: row.provider_model,
        providerRequestId: row.provider_request_id,
        promptSha256: row.prompt_sha256,
        videoSha256: row.video_sha256,
        canonicalSha256: row.canonical_sha256,
      },
      videoSizeBytes: videoBytes.byteLength,
      canonicalSizeBytes: canonicalBytes.byteLength,
      selectedVideoIndices: body.selectedVideoIndices as number[],
      operatorAdjustmentApplied: true,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Video adjustment failed validation' }, 422);
  }
  const job = await env.DB.prepare('SELECT * FROM generation_jobs WHERE id = ? AND user_id = ?')
    .bind(jobId, auth.userId).first<GenerationJob>();
  if (!job) return json({ error: 'Generation job not found' }, 404);
  const nextRevision = row.current_revision + 1;
  const adjustmentClaimToken = await hashString(canonicalJson({
    candidateId: row.id,
    fromRevision: row.current_revision,
    selectedVideoIndices: body.selectedVideoIndices,
  }));
  const claim = await env.DB.prepare(`
    UPDATE video_sprite_candidates
    SET adjustment_claim_token = ?, adjustment_claim_revision = ?,
        adjustment_claim_indices_json = ?
    WHERE id = ? AND user_id = ? AND status = 'awaiting_review'
      AND current_revision = ?
      AND (
        adjustment_claim_token IS NULL OR
        (adjustment_claim_token = ? AND adjustment_claim_revision = ?
          AND adjustment_claim_indices_json = ?)
      )
      AND EXISTS (
        SELECT 1 FROM generation_jobs job
        WHERE job.id = video_sprite_candidates.job_id AND job.status = 'succeeded'
          AND job.review_status = 'awaiting_review'
      )
  `).bind(
    adjustmentClaimToken,
    row.current_revision,
    JSON.stringify(body.selectedVideoIndices),
    row.id,
    auth.userId,
    row.current_revision,
    adjustmentClaimToken,
    row.current_revision,
    JSON.stringify(body.selectedVideoIndices),
  ).run();
  if ((claim.meta.changes ?? 0) !== 1) {
    return json({ error: 'Another video adjustment is already being finalized; retry its exact selection' }, 409);
  }
  const objects = await persistRevisionObjects(env, {
    job,
    candidateId: row.id,
    revision: nextRevision,
    action: row.action,
    response,
    projection,
  });
  const result = await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO video_sprite_candidate_revisions (
        candidate_id, revision, compiler_outcome, sprite_version_id,
        provider_model, pixcli_job_id, provider_request_id, prompt_sha256,
        canonical_blob_key, canonical_sha256, provider_audit_blob_key, provider_audit_sha256,
        video_blob_key, video_sha256, video_size_bytes,
        processed_blob_key, processed_sha256, raw_blob_key, raw_sha256,
        contact_sheet_blob_key, contact_sheet_sha256, unique_sheet_blob_key, unique_sheet_sha256,
        report_blob_key, report_sha256, report_content_sha256, frame_w, frame_h, frame_count,
        raw_frame_w, raw_frame_h, raw_frame_count, source_frame_count, animation_format, processing_version,
        selected_indices_json, playback_json, translations_json
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM video_sprite_candidates candidate
        JOIN video_sprite_candidate_revisions current_revision
          ON current_revision.candidate_id = candidate.id
          AND current_revision.revision = candidate.current_revision
        WHERE candidate.id = ? AND candidate.user_id = ?
          AND candidate.status = 'awaiting_review' AND candidate.current_revision = ?
          AND current_revision.report_sha256 = ?
      )
    `).bind(
      row.id, nextRevision, projection.outcome, objects.sprite.versionId,
      row.provider_model, row.pixcli_job_id, row.provider_request_id, row.prompt_sha256,
      row.canonical_blob_key, row.canonical_sha256, row.provider_audit_blob_key, row.provider_audit_sha256,
      row.video_blob_key, row.video_sha256, row.video_size_bytes,
      objects.processedKey, projection.hashes.processed, objects.rawKey, projection.hashes.raw,
      objects.contactSheetKey, projection.hashes.contactSheet,
      objects.uniqueSheetKey, projection.hashes.uniqueSheet,
      objects.reportKey, projection.reportSha256, projection.reportContentSha256,
      response.frameW, response.frameH, response.frameCount,
      response.rawFrameW, response.rawFrameH, response.rawFrameCount,
      projection.sourceFrameCount,
      response.animationFormat, response.processingVersion,
      JSON.stringify(projection.selectedIndices), JSON.stringify(projection.playback),
      JSON.stringify(projection.translations),
      row.id, auth.userId, row.current_revision, row.report_sha256,
    ),
    env.DB.prepare(`
      UPDATE video_sprite_candidates
      SET current_revision = ?, reviewed_at = NULL, reviewed_by_user_id = NULL,
          review_reason = NULL, adjustment_claim_token = NULL,
          adjustment_claim_revision = NULL, adjustment_claim_indices_json = NULL
      WHERE id = ? AND user_id = ? AND status = 'awaiting_review'
        AND current_revision = ?
        AND adjustment_claim_token = ? AND adjustment_claim_revision = ?
        AND EXISTS (
          SELECT 1 FROM video_sprite_candidate_revisions current_revision
          WHERE current_revision.candidate_id = video_sprite_candidates.id
            AND current_revision.revision = ? AND current_revision.report_sha256 = ?
        )
        AND EXISTS (
          SELECT 1 FROM generation_jobs job
          WHERE job.id = video_sprite_candidates.job_id AND job.status = 'succeeded'
            AND job.review_status = 'awaiting_review'
        )
        AND EXISTS (
          SELECT 1 FROM video_sprite_candidate_revisions new_revision
          WHERE new_revision.candidate_id = video_sprite_candidates.id
            AND new_revision.revision = ? AND new_revision.report_sha256 = ?
        )
    `).bind(
      nextRevision,
      row.id,
      auth.userId,
      row.current_revision,
      adjustmentClaimToken,
      row.current_revision,
      row.current_revision,
      row.report_sha256,
      nextRevision,
      projection.reportSha256,
    ),
    env.DB.prepare(`
      INSERT OR IGNORE INTO generation_job_events (id, job_id, stage, status, detail)
      SELECT ?, ?, 'review:adjusted', 'succeeded', ?
      WHERE EXISTS (
        SELECT 1 FROM video_sprite_candidates candidate
        JOIN video_sprite_candidate_revisions revision
          ON revision.candidate_id = candidate.id AND revision.revision = candidate.current_revision
        WHERE candidate.id = ? AND candidate.current_revision = ?
          AND candidate.status = 'awaiting_review' AND revision.report_sha256 = ?
      )
    `).bind(
      `${row.id}:r${nextRevision}:adjusted`,
      jobId,
      `${row.action} re-curated without a provider call`,
      row.id,
      nextRevision,
      projection.reportSha256,
    ),
  ]);
  if ((result[1].meta.changes ?? 0) !== 1) {
    const replay = await ownedReview(env, auth.userId, jobId);
    if (
      replay?.status === 'awaiting_review' && replay.current_revision === nextRevision &&
      replay.report_sha256 === projection.reportSha256
    ) return json({ review: serializeReview(replay) });
    return json({ error: 'Video review changed concurrently; reload before adjusting' }, 409);
  }
  const adjusted = await ownedReview(env, auth.userId, jobId);
  return adjusted ? json({ review: serializeReview(adjusted) }) : json({ error: 'Adjusted review could not be reloaded' }, 500);
}

export async function getVideoSpriteReviewAsset(
  request: Request,
  env: Env,
  auth: AuthContext,
  jobId: string,
  kind: string,
): Promise<Response> {
  const revision = Number(new URL(request.url).searchParams.get('revision'));
  if (!/^[a-f0-9]{32}$/.test(jobId) || !Number.isInteger(revision) || revision < 1 || revision > 100) {
    return json({ error: 'Video review asset not found' }, 404);
  }
  const columns: Record<string, { key: string; hash: string; type: string }> = {
    runtime: { key: 'processed_blob_key', hash: 'processed_sha256', type: 'image/png' },
    raw: { key: 'raw_blob_key', hash: 'raw_sha256', type: 'image/png' },
    'contact-sheet': { key: 'contact_sheet_blob_key', hash: 'contact_sheet_sha256', type: 'image/png' },
    'unique-sheet': { key: 'unique_sheet_blob_key', hash: 'unique_sheet_sha256', type: 'image/png' },
    report: { key: 'report_blob_key', hash: 'report_content_sha256', type: 'application/json' },
    video: { key: 'video_blob_key', hash: 'video_sha256', type: 'video/mp4' },
  };
  const selected = columns[kind];
  if (!selected) return json({ error: 'Video review asset not found' }, 404);
  const row = await env.DB.prepare(`
    SELECT revision.${selected.key} AS blob_key, revision.${selected.hash} AS sha256
    FROM video_sprite_candidates candidate
    JOIN video_sprite_candidate_revisions revision ON revision.candidate_id = candidate.id
    WHERE candidate.job_id = ? AND candidate.user_id = ? AND revision.revision = ?
    LIMIT 1
  `).bind(jobId, auth.userId, revision).first<{ blob_key: string; sha256: string }>();
  if (!row) return json({ error: 'Video review asset not found' }, 404);
  const object = await env.SPRITES.get(row.blob_key);
  if (!object) return json({ error: 'Video review asset is unavailable' }, 410);
  const headers = new Headers({
    'Content-Type': selected.type,
    'Cache-Control': 'private, no-store',
    ETag: `"${row.sha256}"`,
    'X-Content-Type-Options': 'nosniff',
  });
  return new Response(object.body, { headers });
}
