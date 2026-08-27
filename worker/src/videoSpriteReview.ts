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
  videoAction,
  type VideoSpriteCandidateReportProjection,
} from './videoSpriteGeneration';
import { parseSealedReviewedCanonicalSources } from './reviewedCanonicalSources';
import { validateOptionalReviewedProductionWorkerPin } from './reviewedDeploymentPin';

const MAX_REVIEW_BODY_BYTES = 16 * 1024;
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const MAX_AUDIT_BYTES = 1024 * 1024;
const MAX_COMPILER_RESPONSE_BYTES = 96 * 1024 * 1024;
const MAX_REVIEWED_CANONICAL_SOURCE_BYTES = 12 * 1024 * 1024;

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
  job_stage: string;
  job_target_kind: string | null;
  job_resumed_from_job_id: string | null;
  tier: 'champion';
  operation: GenerationJob['operation'];
  target_name: string | null;
  run_operation: GenerationJob['operation'];
  run_target_kind: string | null;
  run_target_name: string | null;
  run_status: string;
  run_completed_at: string | null;
  run_source_manifest_json: string | null;
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
      job.stage AS job_stage,
      job.target_kind AS job_target_kind,
      job.resumed_from_job_id AS job_resumed_from_job_id,
      job.tier,
      job.operation,
      job.target_name,
      run.operation AS run_operation,
      run.target_kind AS run_target_kind,
      run.target_name AS run_target_name,
      run.status AS run_status,
      run.completed_at AS run_completed_at,
      run.source_manifest_json AS run_source_manifest_json,
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

function digestHex(digest: ArrayBuffer): string {
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function hashReviewedCanonicalObject(object: R2ObjectBody): Promise<string> {
  if (object.size > MAX_REVIEWED_CANONICAL_SOURCE_BYTES) {
    throw new Error('Video review canonical source exceeds its integrity size limit');
  }
  if (typeof DigestStream === 'undefined') {
    const bytes = await object.arrayBuffer();
    if (
      bytes.byteLength !== object.size ||
      bytes.byteLength > MAX_REVIEWED_CANONICAL_SOURCE_BYTES
    ) {
      throw new Error('Video review canonical source size failed integrity validation');
    }
    return hashString(bytes);
  }

  const digestStream = new DigestStream('SHA-256');
  const writer = digestStream.getWriter();
  const reader = object.body.getReader();
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REVIEWED_CANONICAL_SOURCE_BYTES) {
        throw new Error('Video review canonical source exceeds its integrity size limit');
      }
      await writer.write(value);
    }
    await writer.close();
    if (totalBytes !== object.size) {
      throw new Error('Video review canonical source size failed integrity validation');
    }
    return digestHex(await digestStream.digest);
  } catch (error) {
    await Promise.allSettled([reader.cancel(error), writer.abort(error)]);
    void digestStream.digest.catch(() => undefined);
    throw error;
  }
}

async function requireReviewedCanonicalIntegrity(
  env: Env,
  row: OwnedReviewRow,
  object: R2ObjectBody,
): Promise<boolean> {
  const sealed = parseSealedReviewedCanonicalSources(row.run_source_manifest_json);
  if (!sealed) return false;
  if (sealed.fighterId !== row.fighter_id || sealed.ownerUserId !== row.user_id) {
    throw new Error('Video review canonical source manifest failed integrity validation');
  }

  const sourceName = videoAction(row.action).canonical;
  const source = sealed.sources[sourceName];
  if (
    row.canonical_blob_key !== source.raw.blobKey ||
    row.canonical_sha256 !== source.raw.contentSha256
  ) {
    throw new Error('Video review canonical source does not match its sealed action source');
  }

  const currentProcessedColumn = sourceName === 'side'
    ? 'side_view_blob_key'
    : 'crouch_view_blob_key';
  const currentRawColumn = sourceName === 'side'
    ? 'side_view_raw_blob_key'
    : 'crouch_view_raw_blob_key';
  const seal = await env.DB.prepare(`
    SELECT raw_source.id AS raw_version_id
    FROM generation_artifact_runs run
    JOIN fighters fighter
      ON fighter.id = run.fighter_id AND fighter.owner_user_id = run.user_id
    JOIN source_versions processed_source ON processed_source.id = ?
    JOIN source_versions raw_source ON raw_source.id = ?
    JOIN generation_artifact_checkpoints checkpoint
      ON checkpoint.run_id = run.id
      AND checkpoint.artifact_kind = 'source'
      AND checkpoint.artifact_name = ?
    WHERE run.id = ? AND run.user_id = ? AND run.fighter_id = ?
      AND run.source_manifest_json = ?
      AND fighter.${currentProcessedColumn} = ?
      AND fighter.${currentRawColumn} = ?
      AND processed_source.fighter_id = ? AND processed_source.kind = ?
      AND processed_source.blob_key = ? AND processed_source.content_hash = ?
      AND raw_source.fighter_id = ? AND raw_source.kind = ?
      AND raw_source.blob_key = ? AND raw_source.content_hash = ?
      AND checkpoint.stage_index = ? AND checkpoint.tier = 'champion'
      AND checkpoint.status = 'approved'
      AND checkpoint.clean_version_id = ? AND checkpoint.raw_version_id = ?
      AND checkpoint.clean_blob_key = ? AND checkpoint.raw_blob_key = ?
      AND checkpoint.clean_content_hash = ? AND checkpoint.raw_content_hash = ?
    LIMIT 1
  `).bind(
    source.processed.versionId,
    source.raw.versionId,
    sourceName,
    row.run_id,
    row.user_id,
    row.fighter_id,
    row.run_source_manifest_json,
    source.processed.blobKey,
    source.raw.blobKey,
    row.fighter_id,
    sourceName,
    source.processed.blobKey,
    source.processed.contentSha256,
    row.fighter_id,
    `${sourceName}_raw`,
    source.raw.blobKey,
    source.raw.contentSha256,
    sourceName === 'side' ? 1 : 3,
    source.processed.versionId,
    source.raw.versionId,
    source.processed.blobKey,
    source.raw.blobKey,
    source.processed.contentSha256,
    source.raw.contentSha256,
  ).first<{ raw_version_id: string }>();
  if (seal?.raw_version_id !== source.raw.versionId) {
    throw new Error('Video review canonical source seal failed integrity validation');
  }

  for (const metadataHash of [
    object.customMetadata?.contentSha256,
    object.customMetadata?.contentHash,
  ]) {
    if (metadataHash !== undefined && metadataHash !== row.canonical_sha256) {
      throw new Error('Video review canonical source metadata failed integrity validation');
    }
  }
  if (await hashReviewedCanonicalObject(object) !== row.canonical_sha256) {
    throw new Error('Video review canonical source failed integrity validation');
  }
  return true;
}

async function requireApprovalIntegrity(env: Env, row: OwnedReviewRow): Promise<CandidateSpriteVersionRow> {
  const objectBindings = [
    [row.processed_blob_key, row.processed_sha256],
    [row.raw_blob_key, row.raw_sha256],
    [row.contact_sheet_blob_key, row.contact_sheet_sha256],
    [row.unique_sheet_blob_key, row.unique_sheet_sha256],
    [row.report_blob_key, row.report_content_sha256],
    [row.provider_audit_blob_key, row.provider_audit_sha256],
    [row.video_blob_key, row.video_sha256],
  ] as const;
  const [objects, canonicalObject] = await Promise.all([
    Promise.all(objectBindings.map(([key]) => env.SPRITES.get(key))),
    env.SPRITES.get(row.canonical_blob_key),
  ]);
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
  if (!canonicalObject) throw new Error('Video review artifact is unavailable');
  const reviewedCanonical = await requireReviewedCanonicalIntegrity(env, row, canonicalObject);
  if (!reviewedCanonical) {
    const storedHash = canonicalObject.customMetadata?.contentSha256 ??
      canonicalObject.customMetadata?.contentHash;
    if (storedHash !== row.canonical_sha256) {
      throw new Error('Video review artifact metadata failed integrity validation');
    }
    if (await hashString(await canonicalObject.arrayBuffer()) !== row.canonical_sha256) {
      throw new Error('Video review artifact failed integrity validation');
    }
  }
  if (objects[6]!.size !== row.video_size_bytes) {
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
  request: Request,
  env: Env,
  auth: AuthContext,
  jobId: string,
): Promise<Response> {
  const deploymentPinFailure = validateOptionalReviewedProductionWorkerPin(request, env);
  if (deploymentPinFailure) return deploymentPinFailure;
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
  const deploymentPinFailure = validateOptionalReviewedProductionWorkerPin(request, env);
  if (deploymentPinFailure) return deploymentPinFailure;
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
  'Video review canonical source',
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

export interface ReviewedVideoActivationProvenance {
  schemaVersion: 1;
  fighterId: string;
  artifactRunId: string;
  finalJobId: string;
  approvedActionCount: number;
  finalAction: 'victory';
  animationFormat: 'video-dense-v1';
  currentSpritesVerified: true;
}

export class ReviewedVideoActivationError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = 'ReviewedVideoActivationError';
  }
}

interface ActivationCandidateRow {
  job_id: string;
  action: VideoSpriteAction;
  sequence_order: number;
}

interface ActivationCheckpointRow {
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
  completed_by_job_id: string;
}

interface ActivationCheckpointCountRow {
  total_count: number;
  approved_count: number;
  source_count: number;
  sprite_count: number;
}

async function requireCurrentVideoSpriteIntegrity(
  env: Env,
  review: OwnedReviewRow,
  version: CandidateSpriteVersionRow,
): Promise<void> {
  const current = await env.DB.prepare(`
    SELECT id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
      content_hash, raw_content_hash, frame_w, frame_h, frame_count,
      animation_format, processing_version
    FROM sprites
    WHERE fighter_id = ? AND animation_name = ? AND quality_tier = 'champion'
    LIMIT 1
  `).bind(review.fighter_id, review.action).first<CandidateSpriteVersionRow>();
  if (
    !current || current.fighter_id !== review.fighter_id || current.animation_name !== review.action ||
    current.quality_tier !== 'champion' || current.blob_key !== version.blob_key ||
    current.raw_blob_key !== version.raw_blob_key || current.content_hash !== version.content_hash ||
    current.raw_content_hash !== version.raw_content_hash || current.frame_w !== 192 ||
    current.frame_h !== 256 || current.frame_count !== version.frame_count ||
    current.animation_format !== 'video-dense-v1' || current.processing_version !== 5
  ) {
    throw new ReviewedVideoActivationError(
      `Current ${review.action} sprite no longer matches its approved Video revision`,
    );
  }
  const [runtime, raw] = await Promise.all([
    env.SPRITES.get(current.blob_key),
    current.raw_blob_key ? env.SPRITES.get(current.raw_blob_key) : Promise.resolve(null),
  ]);
  if (
    !runtime || !raw || await hashString(await runtime.arrayBuffer()) !== current.content_hash ||
    await hashString(await raw.arrayBuffer()) !== current.raw_content_hash ||
    runtime.customMetadata?.contentHash !== current.content_hash ||
    raw.customMetadata?.contentHash !== current.raw_content_hash ||
    runtime.customMetadata?.animationName !== review.action ||
    raw.customMetadata?.animationName !== review.action ||
    runtime.customMetadata?.animationFormat !== 'video-dense-v1' ||
    raw.customMetadata?.animationFormat !== 'video-dense-v1' ||
    runtime.customMetadata?.qualityTier !== 'champion' ||
    raw.customMetadata?.qualityTier !== 'champion' || raw.customMetadata?.raw !== 'true'
  ) {
    throw new ReviewedVideoActivationError(
      `Current ${review.action} sprite bytes failed approved Video integrity validation`,
    );
  }
}

export async function verifyReviewedVideoRunForActivation(
  env: Env,
  auth: AuthContext,
  fighterId: string,
  finalJobId: string,
): Promise<ReviewedVideoActivationProvenance> {
  if (!/^[a-f0-9]{32}$/.test(fighterId) || !/^[a-f0-9]{32}$/.test(finalJobId)) {
    throw new ReviewedVideoActivationError('Exact fighter and final Video job ids are required', 400);
  }
  const final = await ownedReview(env, auth.userId, finalJobId);
  if (!final || final.fighter_id !== fighterId) {
    throw new ReviewedVideoActivationError('Completed reviewed Video run not found', 404);
  }
  const sealedSources = parseSealedReviewedCanonicalSources(final.run_source_manifest_json);
  if (
    !sealedSources || sealedSources.mode !== 'reviewed-current-v1' ||
    sealedSources.fighterId !== fighterId || sealedSources.ownerUserId !== auth.userId
  ) {
    throw new ReviewedVideoActivationError(
      'Completed Video run is not sealed to the reviewed-current-v1 canonical sources',
    );
  }
  if (
    final.action !== 'victory' || final.sequence_order !== VIDEO_SPRITE_ACTIONS.length - 1 ||
    final.job_id !== finalJobId || final.job_status !== 'succeeded' ||
    final.job_review_status !== 'approved' || final.job_stage !== 'complete' ||
    final.tier !== 'champion' || final.operation !== 'fighter_generation' ||
    final.job_target_kind !== null || final.target_name !== null ||
    final.run_operation !== 'fighter_generation' || final.run_target_kind !== null ||
    final.run_target_name !== null || final.run_status !== 'succeeded' ||
    !final.run_completed_at
  ) {
    throw new ReviewedVideoActivationError(
      'Final victory job is not the completed approved terminal Video job',
    );
  }

  const { results } = await env.DB.prepare(`
    SELECT job_id, action, sequence_order
    FROM video_sprite_candidates
    WHERE run_id = ?
    ORDER BY sequence_order ASC
  `).bind(final.run_id).all<ActivationCandidateRow>();
  const candidates = results ?? [];
  if (
    candidates.length !== VIDEO_SPRITE_ACTIONS.length ||
    candidates.some((candidate, index) => (
      candidate.action !== VIDEO_SPRITE_ACTIONS[index] || candidate.sequence_order !== index
    )) || candidates.at(-1)?.job_id !== finalJobId
  ) {
    throw new ReviewedVideoActivationError(
      'Completed reviewed Video run does not contain the exact eleven-action lineage',
    );
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const review = await ownedReview(env, auth.userId, candidate.job_id);
    if (
      !review || review.run_id !== final.run_id || review.fighter_id !== fighterId ||
      review.action !== candidate.action || review.sequence_order !== index ||
      review.status !== 'approved' || review.approved_revision !== review.current_revision ||
      !review.reviewed_at || !review.reviewed_by_user_id ||
      review.job_status !== 'succeeded' || review.job_review_status !== 'approved' ||
      review.tier !== 'champion' || review.operation !== 'fighter_generation' ||
      review.job_target_kind !== null || review.target_name !== null ||
      review.run_status !== 'succeeded' || review.run_id !== final.run_id ||
      review.animation_format !== 'video-dense-v1' || review.processing_version !== 5 ||
      review.frame_w !== 192 || review.frame_h !== 256 ||
      review.job_resumed_from_job_id !== (index === 0 ? null : candidates[index - 1].job_id)
    ) {
      throw new ReviewedVideoActivationError(
        `Approved ${candidate.action} Video lineage changed before activation`,
      );
    }
    let version: CandidateSpriteVersionRow;
    try {
      version = await requireApprovalIntegrity(env, review);
    } catch (error) {
      throw new ReviewedVideoActivationError(
        error instanceof Error ? error.message : `Approved ${candidate.action} Video integrity failed`,
      );
    }
    const checkpoint = await env.DB.prepare(`
      SELECT clean_version_id, clean_blob_key, raw_blob_key, clean_content_hash,
        raw_content_hash, frame_w, frame_h, frame_count, animation_format,
        processing_version, status, completed_by_job_id
      FROM generation_artifact_checkpoints
      WHERE run_id = ? AND artifact_kind = 'sprite' AND artifact_name = ?
      LIMIT 1
    `).bind(final.run_id, candidate.action).first<ActivationCheckpointRow>();
    if (
      !checkpoint || checkpoint.status !== 'approved' ||
      checkpoint.completed_by_job_id !== candidate.job_id ||
      checkpoint.clean_version_id !== version.id || checkpoint.clean_blob_key !== version.blob_key ||
      checkpoint.raw_blob_key !== version.raw_blob_key ||
      checkpoint.clean_content_hash !== version.content_hash ||
      checkpoint.raw_content_hash !== version.raw_content_hash ||
      checkpoint.frame_w !== 192 || checkpoint.frame_h !== 256 ||
      checkpoint.frame_count !== version.frame_count ||
      checkpoint.animation_format !== 'video-dense-v1' || checkpoint.processing_version !== 5
    ) {
      throw new ReviewedVideoActivationError(
        `Approved ${candidate.action} Video checkpoint changed before activation`,
      );
    }
    await requireCurrentVideoSpriteIntegrity(env, review, version);
  }

  for (const [index, sourceName] of ['side', 'upright', 'crouch'].entries()) {
    const sealed = sealedSources.sources[sourceName as keyof typeof sealedSources.sources];
    const checkpoint = await env.DB.prepare(`
      SELECT clean_version_id, raw_version_id, clean_blob_key, raw_blob_key,
        clean_content_hash, raw_content_hash, stage_index, tier, status
      FROM generation_artifact_checkpoints
      WHERE run_id = ? AND artifact_kind = 'source' AND artifact_name = ?
      LIMIT 1
    `).bind(final.run_id, sourceName).first<{
      clean_version_id: string;
      raw_version_id: string | null;
      clean_blob_key: string;
      raw_blob_key: string | null;
      clean_content_hash: string | null;
      raw_content_hash: string | null;
      stage_index: number;
      tier: string;
      status: string;
    }>();
    if (
      !checkpoint || checkpoint.status !== 'approved' || checkpoint.tier !== 'champion' ||
      checkpoint.stage_index !== index + 1 ||
      checkpoint.clean_version_id !== sealed.processed.versionId ||
      checkpoint.raw_version_id !== sealed.raw.versionId ||
      checkpoint.clean_blob_key !== sealed.processed.blobKey ||
      checkpoint.raw_blob_key !== sealed.raw.blobKey ||
      checkpoint.clean_content_hash !== sealed.processed.contentSha256 ||
      checkpoint.raw_content_hash !== sealed.raw.contentSha256
    ) {
      throw new ReviewedVideoActivationError(
        `Reviewed ${sourceName} canonical checkpoint changed before activation`,
      );
    }
  }

  const checkpointCounts = await env.DB.prepare(`
    SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
      SUM(CASE WHEN artifact_kind = 'source' AND artifact_name IN ('side', 'upright', 'crouch')
        THEN 1 ELSE 0 END) AS source_count,
      SUM(CASE WHEN artifact_kind = 'sprite' THEN 1 ELSE 0 END) AS sprite_count
    FROM generation_artifact_checkpoints
    WHERE run_id = ?
  `).bind(final.run_id).first<ActivationCheckpointCountRow>();
  if (
    !checkpointCounts || checkpointCounts.total_count !== 14 ||
    checkpointCounts.approved_count !== 14 || checkpointCounts.source_count !== 3 ||
    checkpointCounts.sprite_count !== VIDEO_SPRITE_ACTIONS.length
  ) {
    throw new ReviewedVideoActivationError(
      'Completed reviewed Video run does not contain exactly fourteen approved durable stages',
    );
  }

  return {
    schemaVersion: 1,
    fighterId,
    artifactRunId: final.run_id,
    finalJobId,
    approvedActionCount: VIDEO_SPRITE_ACTIONS.length,
    finalAction: 'victory',
    animationFormat: 'video-dense-v1',
    currentSpritesVerified: true,
  };
}

export async function rejectVideoSpriteReview(
  request: Request,
  env: Env,
  auth: AuthContext,
  jobId: string,
): Promise<Response> {
  const deploymentPinFailure = validateOptionalReviewedProductionWorkerPin(request, env);
  if (deploymentPinFailure) return deploymentPinFailure;
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
  const deploymentPinFailure = validateOptionalReviewedProductionWorkerPin(request, env);
  if (deploymentPinFailure) return deploymentPinFailure;
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
  const deploymentPinFailure = validateOptionalReviewedProductionWorkerPin(request, env);
  if (deploymentPinFailure) return deploymentPinFailure;
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
    'X-Content-SHA256': row.sha256,
    'X-Content-Type-Options': 'nosniff',
  });
  return new Response(object.body, { headers });
}
