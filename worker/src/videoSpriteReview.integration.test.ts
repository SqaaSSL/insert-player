import { Miniflare } from 'miniflare';
import { describe, expect, it, vi } from 'vitest';
import {
  VIDEO_SPRITE_ACTIONS,
  type VideoSpriteAction,
  type VideoSpriteCompileResponse,
} from '../../src/services/VideoSpriteCompileContract';
import { hashString } from './auth';
import { canonicalJson, PIXCLI_VIDEO_MODEL, videoAction } from './videoSpriteGeneration';
import {
  adjustVideoSpriteReview,
  approveVideoSpriteReview,
  getVideoSpriteReview,
  getVideoSpriteReviewAsset,
  rejectVideoSpriteReview,
} from './videoSpriteReview';
import { activateReviewedVideoArcadeFighter } from './reviewedArcadeActivation';
import type { AuthContext, Env } from './types';

const USER_ID = 'video-review-user';
const FIGHTER_ID = 'f'.repeat(32);
const RUN_ID = 'a'.repeat(32);
const AUTH = { userId: USER_ID } as AuthContext;

const SCHEMA = `
  CREATE TABLE fighters (
    id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, quality_tier TEXT NOT NULL,
    public_flag INTEGER NOT NULL DEFAULT 0,
    side_view_blob_key TEXT, side_view_raw_blob_key TEXT,
    upright_view_blob_key TEXT, upright_view_raw_blob_key TEXT,
    crouch_view_blob_key TEXT, crouch_view_raw_blob_key TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE source_versions (
    id TEXT PRIMARY KEY, fighter_id TEXT NOT NULL, kind TEXT NOT NULL,
    blob_key TEXT NOT NULL, content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE arcade_fighters (
    fighter_id TEXT PRIMARY KEY, status TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE sprite_versions (
    id TEXT PRIMARY KEY, fighter_id TEXT NOT NULL, animation_name TEXT NOT NULL,
    quality_tier TEXT NOT NULL, blob_key TEXT NOT NULL, raw_blob_key TEXT,
    frame_w INTEGER NOT NULL, frame_h INTEGER NOT NULL, frame_count INTEGER NOT NULL,
    processing_version INTEGER NOT NULL, content_hash TEXT, raw_content_hash TEXT,
    animation_format TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX sprite_version_content ON sprite_versions (
    fighter_id, animation_name, quality_tier, animation_format, frame_w, frame_h,
    frame_count, processing_version, content_hash, COALESCE(raw_content_hash, '')
  );
  CREATE TABLE sprites (
    id TEXT PRIMARY KEY, fighter_id TEXT NOT NULL, animation_name TEXT NOT NULL,
    quality_tier TEXT NOT NULL, blob_key TEXT NOT NULL, raw_blob_key TEXT,
    frame_w INTEGER NOT NULL, frame_h INTEGER NOT NULL, frame_count INTEGER NOT NULL,
    processing_version INTEGER NOT NULL, content_hash TEXT, raw_content_hash TEXT,
    animation_format TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(fighter_id, animation_name, quality_tier)
  );
  CREATE TABLE generation_artifact_runs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, fighter_id TEXT NOT NULL,
    tier TEXT NOT NULL, creation_flow TEXT NOT NULL, operation TEXT NOT NULL,
    target_kind TEXT, target_name TEXT, root_job_id TEXT NOT NULL,
    source_manifest_json TEXT, status TEXT NOT NULL, failure_stage TEXT,
    completed_at TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE generation_jobs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, fighter_id TEXT NOT NULL,
    charge_id TEXT NOT NULL, provider_session_id TEXT NOT NULL, tier TEXT NOT NULL,
    creation_flow TEXT NOT NULL, operation TEXT NOT NULL, target_kind TEXT, target_name TEXT,
    artifact_run_id TEXT NOT NULL, resumed_from_job_id TEXT, status TEXT NOT NULL,
    review_status TEXT NOT NULL, stage TEXT NOT NULL, failure_stage TEXT,
    error_code TEXT, error_message TEXT,
    progress_current INTEGER NOT NULL, progress_total INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE generation_artifact_checkpoints (
    run_id TEXT NOT NULL, artifact_kind TEXT NOT NULL, artifact_name TEXT NOT NULL,
    stage_index INTEGER NOT NULL, tier TEXT NOT NULL, status TEXT NOT NULL,
    clean_version_id TEXT NOT NULL, raw_version_id TEXT, clean_blob_key TEXT NOT NULL,
    raw_blob_key TEXT, clean_content_hash TEXT, raw_content_hash TEXT,
    frame_w INTEGER, frame_h INTEGER, frame_count INTEGER, processing_version INTEGER,
    animation_format TEXT NOT NULL, completed_by_job_id TEXT NOT NULL,
    verified_at TEXT, PRIMARY KEY(run_id, artifact_kind, artifact_name)
  );
  CREATE TABLE video_sprite_candidates (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL, fighter_id TEXT NOT NULL, action TEXT NOT NULL,
    sequence_order INTEGER NOT NULL, status TEXT NOT NULL, current_revision INTEGER NOT NULL,
    approved_revision INTEGER, adjustment_claim_token TEXT, adjustment_claim_revision INTEGER,
    adjustment_claim_indices_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), reviewed_at TEXT,
    reviewed_by_user_id TEXT, review_reason TEXT, UNIQUE(run_id, action)
  );
  CREATE UNIQUE INDEX one_pending_video_review ON video_sprite_candidates(run_id)
    WHERE status = 'awaiting_review';
  CREATE TABLE video_sprite_candidate_revisions (
    candidate_id TEXT NOT NULL, revision INTEGER NOT NULL, compiler_outcome TEXT NOT NULL,
    semantic_promotion_approved INTEGER NOT NULL DEFAULT 0, sprite_version_id TEXT NOT NULL,
    provider_model TEXT NOT NULL, pixcli_job_id TEXT NOT NULL, provider_request_id TEXT NOT NULL,
    prompt_sha256 TEXT NOT NULL, canonical_blob_key TEXT NOT NULL, canonical_sha256 TEXT NOT NULL,
    provider_audit_blob_key TEXT NOT NULL, provider_audit_sha256 TEXT NOT NULL,
    video_blob_key TEXT NOT NULL, video_sha256 TEXT NOT NULL, video_size_bytes INTEGER NOT NULL,
    processed_blob_key TEXT NOT NULL, processed_sha256 TEXT NOT NULL,
    raw_blob_key TEXT NOT NULL, raw_sha256 TEXT NOT NULL,
    contact_sheet_blob_key TEXT NOT NULL, contact_sheet_sha256 TEXT NOT NULL,
    unique_sheet_blob_key TEXT NOT NULL, unique_sheet_sha256 TEXT NOT NULL,
    report_blob_key TEXT NOT NULL, report_sha256 TEXT NOT NULL,
    report_content_sha256 TEXT NOT NULL, frame_w INTEGER NOT NULL, frame_h INTEGER NOT NULL,
    frame_count INTEGER NOT NULL, raw_frame_w INTEGER NOT NULL, raw_frame_h INTEGER NOT NULL,
    raw_frame_count INTEGER NOT NULL, source_frame_count INTEGER NOT NULL,
    animation_format TEXT NOT NULL, processing_version INTEGER NOT NULL,
    selected_indices_json TEXT NOT NULL, playback_json TEXT NOT NULL,
    translations_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(candidate_id, revision)
  );
  CREATE TABLE provider_cost_events (job_id TEXT, artifact_run_id TEXT, job_outcome TEXT);
  CREATE TABLE generation_job_events (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL,
    detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function hexId(value: number): string {
  return value.toString(16).padStart(32, '0');
}

function buffer(label: string): ArrayBuffer {
  const bytes = new TextEncoder().encode('sealed:' + label);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function mp4(label: string): ArrayBuffer {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode(label).slice(0, 4), 0);
  bytes.set(new TextEncoder().encode('ftyp'), 4);
  bytes.set(new TextEncoder().encode(label).slice(0, 24), 8);
  return bytes.buffer;
}

interface Harness { mf: Miniflare; db: D1Database; bucket: R2Bucket; env: Env }
interface ReviewSeed {
  action: VideoSpriteAction; candidateId: string; jobId: string;
  reportSha256: string; runtimeKey: string; runtimeBytes: ArrayBuffer;
  canonicalKey: string; canonicalBytes: ArrayBuffer;
}

async function createHarness(): Promise<Harness> {
  const unique = crypto.randomUUID();
  const mf = new Miniflare({ workers: [{ config: {
    type: 'worker', name: 'review-' + unique, compatibilityDate: '2026-08-22',
    manifest: { mainModule: 'index.js', modules: { 'index.js': {
      type: 'esm', contents: 'export default { fetch() { return new Response("ok"); } };',
    } } },
    env: {
      DB: { type: 'd1', id: 'review-db-' + unique },
      SPRITES: { type: 'r2', name: 'review-assets-' + unique },
    },
  } }] });
  const db = await mf.getD1Database('DB');
  const bucket = await mf.getR2Bucket('SPRITES') as unknown as R2Bucket;
  await db.batch(SCHEMA.split(';').map((part) => part.trim()).filter(Boolean)
    .map((statement) => db.prepare(statement)));
  await db.prepare(`INSERT INTO fighters (id, owner_user_id, quality_tier)
    VALUES (?, ?, 'contender')`).bind(FIGHTER_ID, USER_ID).run();
  await db.prepare(`INSERT INTO arcade_fighters (fighter_id, status)
    VALUES (?, 'draft')`).bind(FIGHTER_ID).run();
  return { mf, db, bucket, env: { DB: db, SPRITES: bucket } as Env };
}

async function put(
  bucket: R2Bucket, key: string, bytes: ArrayBuffer, hash: string,
  metadata: Record<string, string> = {},
): Promise<void> {
  await bucket.put(key, bytes, { customMetadata: {
    contentSha256: hash, contentHash: hash, ...metadata,
  } });
}

async function seedReviews(
  target: Harness,
  approvedCount: number,
  operation: 'fighter_generation' | 'fighter_retry_animation' = 'fighter_generation',
  actionLimit?: number,
): Promise<ReviewSeed[]> {
  const allActions: VideoSpriteAction[] = operation === 'fighter_retry_animation'
    ? ['idle'] : [...VIDEO_SPRITE_ACTIONS];
  const actions = allActions.slice(0, actionLimit ?? allActions.length);
  const sourceKinds = [
    'side', 'side_raw', 'upright', 'upright_raw', 'crouch', 'crouch_raw',
  ] as const;
  type SourceKind = typeof sourceKinds[number];
  const sourceSeed: Record<SourceKind, string> = {
    side: '1', side_raw: '2', upright: '3', upright_raw: '4', crouch: '5', crouch_raw: '6',
  };
  const sourceBytes = Object.fromEntries(sourceKinds.map((kind) => [
    kind, buffer(`reviewed-source:${kind}`),
  ])) as Record<SourceKind, ArrayBuffer>;
  const sourceHashes = Object.fromEntries(await Promise.all(sourceKinds.map(async (kind) => [
    kind, await hashString(sourceBytes[kind]),
  ]))) as Record<SourceKind, string>;
  const sourceIdentity = (kind: SourceKind) => ({
    versionId: sourceSeed[kind].repeat(32),
    blobKey: `source/${kind}`,
    contentSha256: sourceHashes[kind],
  });
  const sealedSources = {
    side: { processed: sourceIdentity('side'), raw: sourceIdentity('side_raw') },
    upright: { processed: sourceIdentity('upright'), raw: sourceIdentity('upright_raw') },
    crouch: { processed: sourceIdentity('crouch'), raw: sourceIdentity('crouch_raw') },
  };
  const sourceManifest = JSON.stringify({
    side: sealedSources.side.processed.blobKey, sideRaw: sealedSources.side.raw.blobKey,
    upright: sealedSources.upright.processed.blobKey,
    uprightRaw: sealedSources.upright.raw.blobKey,
    crouch: sealedSources.crouch.processed.blobKey,
    crouchRaw: sealedSources.crouch.raw.blobKey,
    reviewedCanonicalSources: {
      schemaVersion: 1, mode: 'reviewed-current-v1',
      fighterId: FIGHTER_ID, ownerUserId: USER_ID,
      sources: sealedSources,
    },
  });
  await target.db.prepare(`INSERT INTO generation_artifact_runs (
    id, user_id, fighter_id, tier, creation_flow, operation, target_kind, target_name,
    root_job_id, source_manifest_json, status
  ) VALUES (?, ?, ?, 'champion', 'video', ?, ?, ?, ?, ?, 'partial')`).bind(
    RUN_ID, USER_ID, FIGHTER_ID, operation,
    operation === 'fighter_retry_animation' ? 'animation' : null,
    operation === 'fighter_retry_animation' ? 'idle' : null,
    hexId(0x100), sourceManifest,
  ).run();
  await Promise.all(sourceKinds.map((kind) => put(
    target.bucket,
    sourceIdentity(kind).blobKey,
    sourceBytes[kind],
    sourceHashes[kind],
  )));
  await target.db.batch([
    ...sourceKinds.map((kind) => target.db.prepare(`INSERT INTO source_versions (
      id, fighter_id, kind, blob_key, content_hash
    ) VALUES (?, ?, ?, ?, ?)`).bind(
      sourceIdentity(kind).versionId,
      FIGHTER_ID,
      kind,
      sourceIdentity(kind).blobKey,
      sourceHashes[kind],
    )),
    target.db.prepare(`UPDATE fighters SET
      side_view_blob_key = ?, side_view_raw_blob_key = ?,
      upright_view_blob_key = ?, upright_view_raw_blob_key = ?,
      crouch_view_blob_key = ?, crouch_view_raw_blob_key = ?
      WHERE id = ? AND owner_user_id = ?`).bind(
      sealedSources.side.processed.blobKey,
      sealedSources.side.raw.blobKey,
      sealedSources.upright.processed.blobKey,
      sealedSources.upright.raw.blobKey,
      sealedSources.crouch.processed.blobKey,
      sealedSources.crouch.raw.blobKey,
      FIGHTER_ID,
      USER_ID,
    ),
  ]);
  const reviews: ReviewSeed[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    const jobId = hexId(0x100 + index);
    const candidateId = hexId(0x500 + index);
    const approved = index < approvedCount;
    await target.db.prepare(`INSERT INTO generation_jobs (
      id, user_id, fighter_id, charge_id, provider_session_id, tier, creation_flow,
      operation, target_kind, target_name, artifact_run_id, resumed_from_job_id, status,
      review_status, stage, progress_current, progress_total
    ) VALUES (?, ?, ?, ?, ?, 'champion', 'video', ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?)`)
      .bind(
        jobId, USER_ID, FIGHTER_ID, 'charge-' + index, 'session-' + index, operation,
        operation === 'fighter_retry_animation' ? 'animation' : null,
        operation === 'fighter_retry_animation' ? action : null, RUN_ID,
        index ? hexId(0x100 + index - 1) : null,
        approved ? 'approved' : 'awaiting_review',
        approved ? 'review:approved' : 'awaiting_review', index + 3,
        operation === 'fighter_retry_animation' ? 1 : 14,
      ).run();
    const canonicalName = videoAction(action).canonical;
    const canonicalKind = `${canonicalName}_raw` as const;
    const values = {
      runtime: buffer(action + ':runtime'), raw: buffer(action + ':raw'),
      contact: buffer(action + ':contact'), unique: buffer(action + ':unique'),
      report: buffer(action + ':report'), canonical: sourceBytes[canonicalKind],
      audit: buffer(action + ':audit'), video: mp4(action + ':video'),
    };
    const hashes = Object.fromEntries(await Promise.all(Object.entries(values)
      .map(async ([name, value]) => [name, await hashString(value)]))) as Record<string, string>;
    const prefix = 'review/' + candidateId;
    const keys = {
      ...Object.fromEntries(Object.keys(values).map((name) => [name, prefix + '/' + name])),
      canonical: sealedSources[canonicalName].raw.blobKey,
    } as Record<keyof typeof values, string>;
    await Promise.all(Object.entries(values).map(([name, value]) => put(
      target.bucket, keys[name as keyof typeof values], value, hashes[name],
      name === 'runtime' ? {
        animationName: action, animationFormat: 'video-dense-v1', qualityTier: 'champion',
      } : name === 'raw' ? {
        animationName: action, animationFormat: 'video-dense-v1', qualityTier: 'champion', raw: 'true',
      } : {},
    )));
    const versionId = 'version-' + candidateId;
    const reportSha256 = await hashString('semantic:' + candidateId);
    await target.db.batch([
      target.db.prepare(`INSERT INTO sprite_versions (
        id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
        frame_w, frame_h, frame_count, processing_version, content_hash,
        raw_content_hash, animation_format
      ) VALUES (?, ?, ?, 'champion', ?, ?, 192, 256, 8, 5, ?, ?, 'video-dense-v1')`)
        .bind(versionId, FIGHTER_ID, action, keys.runtime, keys.raw, hashes.runtime, hashes.raw),
      target.db.prepare(`INSERT INTO video_sprite_candidates (
        id, run_id, job_id, user_id, fighter_id, action, sequence_order,
        status, current_revision, approved_revision, reviewed_at, reviewed_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
        .bind(candidateId, RUN_ID, jobId, USER_ID, FIGHTER_ID, action,
          VIDEO_SPRITE_ACTIONS.indexOf(action), approved ? 'approved' : 'awaiting_review',
          approved ? 1 : null, approved ? '2026-08-27 00:00:00' : null,
          approved ? USER_ID : null),
      target.db.prepare(`INSERT INTO video_sprite_candidate_revisions (
        candidate_id, revision, compiler_outcome, sprite_version_id, provider_model,
        pixcli_job_id, provider_request_id, prompt_sha256, canonical_blob_key,
        canonical_sha256, provider_audit_blob_key, provider_audit_sha256, video_blob_key,
        video_sha256, video_size_bytes, processed_blob_key, processed_sha256,
        raw_blob_key, raw_sha256, contact_sheet_blob_key, contact_sheet_sha256,
        unique_sheet_blob_key, unique_sheet_sha256, report_blob_key, report_sha256,
        report_content_sha256, frame_w, frame_h, frame_count, raw_frame_w, raw_frame_h,
        raw_frame_count, source_frame_count, animation_format, processing_version,
        selected_indices_json, playback_json, translations_json
      ) VALUES (?, 1, 'technical_pass', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, 192, 256, 8, 768, 1024, 8, 10, 'video-dense-v1', 5, ?, ?, ?)`)
        .bind(
          candidateId, versionId, PIXCLI_VIDEO_MODEL, hexId(0x800 + index),
          'provider-request-' + index, '1'.repeat(64), keys.canonical, hashes.canonical,
          keys.audit, hashes.audit, keys.video, hashes.video, values.video.byteLength,
          keys.runtime, hashes.runtime, keys.raw, hashes.raw, keys.contact, hashes.contact,
          keys.unique, hashes.unique, keys.report, reportSha256, hashes.report,
          JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7]), JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7]),
          JSON.stringify(Array.from({ length: 8 }, () => ({ dx: 0, dy: 0 }))),
        ),
    ]);
    if (approved) await target.db.prepare(`INSERT INTO generation_artifact_checkpoints (
      run_id, artifact_kind, artifact_name, stage_index, tier, status, clean_version_id,
      clean_blob_key, raw_blob_key, clean_content_hash, raw_content_hash, frame_w, frame_h,
      frame_count, processing_version, animation_format, completed_by_job_id
    ) VALUES (?, 'sprite', ?, ?, 'champion', 'approved', ?, ?, ?, ?, ?, 192, 256, 8, 5,
      'video-dense-v1', ?)`)
      .bind(RUN_ID, action, operation === 'fighter_generation' ? index + 4 : 1,
        versionId, keys.runtime, keys.raw, hashes.runtime, hashes.raw, jobId).run();
    reviews.push({ action, candidateId, jobId, reportSha256,
      runtimeKey: keys.runtime, runtimeBytes: values.runtime,
      canonicalKey: keys.canonical, canonicalBytes: values.canonical });
  }
  if (operation === 'fighter_generation') for (const [index, source] of ['side', 'upright', 'crouch'].entries()) {
    const sealed = sealedSources[source as keyof typeof sealedSources];
    await target.db.prepare(`INSERT INTO generation_artifact_checkpoints (
      run_id, artifact_kind, artifact_name, stage_index, tier, status, clean_version_id,
      raw_version_id, clean_blob_key, raw_blob_key, clean_content_hash, raw_content_hash,
      animation_format, completed_by_job_id
    ) VALUES (?, 'source', ?, ?, 'champion', 'approved', ?, ?, ?, ?, ?, ?, 'legacy', ?)`)
      .bind(RUN_ID, source, index + 1, sealed.processed.versionId, sealed.raw.versionId,
        sealed.processed.blobKey, sealed.raw.blobKey, sealed.processed.contentSha256,
        sealed.raw.contentSha256, reviews[0].jobId).run();
  }
  return reviews;
}

function decision(review: ReviewSeed, extra: Record<string, unknown> = {}): Request {
  return new Request('https://api.insertplayer.ai/review/' + review.jobId, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidateId: review.candidateId, revision: 1,
      reportSha256: review.reportSha256, ...extra }),
  });
}

async function approvalMutationState(target: Harness, review: ReviewSeed): Promise<Record<string, unknown>> {
  const [candidate, job, sprites, spriteCheckpoints, events] = await Promise.all([
    target.db.prepare(`SELECT status, approved_revision, reviewed_at, reviewed_by_user_id
      FROM video_sprite_candidates WHERE id = ?`).bind(review.candidateId).first(),
    target.db.prepare(`SELECT review_status, stage FROM generation_jobs WHERE id = ?`)
      .bind(review.jobId).first(),
    target.db.prepare(`SELECT COUNT(*) AS count FROM sprites WHERE fighter_id = ?`)
      .bind(FIGHTER_ID).first(),
    target.db.prepare(`SELECT COUNT(*) AS count FROM generation_artifact_checkpoints
      WHERE run_id = ? AND artifact_kind = 'sprite'`).bind(RUN_ID).first(),
    target.db.prepare(`SELECT COUNT(*) AS count FROM generation_job_events WHERE job_id = ?`)
      .bind(review.jobId).first(),
  ]);
  return { candidate, job, sprites, spriteCheckpoints, events };
}

async function expectApprovalIntegrityFailureWithoutWrites(
  target: Harness,
  review: ReviewSeed,
): Promise<void> {
  const before = await approvalMutationState(target, review);
  const response = await approveVideoSpriteReview(decision(review), target.env, AUTH, review.jobId);
  expect(response.status).toBe(409);
  expect(await approvalMutationState(target, review)).toEqual(before);
}

function png(width: number, height: number, marker: number): Uint8Array {
  const bytes = new Uint8Array(25);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = marker;
  return bytes;
}

async function adjustedResponse(params: {
  jobId: string; selected: number[]; canonicalSha: string; videoSha: string;
  canonicalSize: number; videoSize: number;
}): Promise<VideoSpriteCompileResponse> {
  const runtime = png(1536, 256, params.selected[0] ?? 1);
  const raw = png(3072, 2048, params.selected[1] ?? 2);
  const contact = png(768, 256, 3);
  const unique = png(1536, 256, 4);
  const hash = async (bytes: Uint8Array) => hashString(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const hashes = {
    runtime: await hash(runtime), raw: await hash(raw),
    contact: await hash(contact), unique: await hash(unique),
  };
  const lineage = {
    jobId: params.jobId, runId: RUN_ID, fighterId: FIGHTER_ID, provider: 'fal',
    modelId: PIXCLI_VIDEO_MODEL, providerRequestId: 'provider-request-0',
    promptSha256: '1'.repeat(64), videoSha256: params.videoSha,
    canonicalSha256: params.canonicalSha,
  };
  const reportWithoutHash = {
    schema: 'video-sprite-compile-report.v1', schemaVersion: 1,
    compilerVersion: '1.0.0', policyVersion: 'video-sprite-policy.v1',
    action: 'idle', expectedFacing: 'right', animationFormat: 'video-dense-v1',
    processingVersion: 5, lineage,
    inputs: {
      videoSha256: params.videoSha, canonicalSha256: params.canonicalSha,
      videoSizeBytes: params.videoSize, canonicalSizeBytes: params.canonicalSize,
    },
    extraction: {
      decodedFrameCount: 10, selectedVideoIndices: params.selected,
      frameTranslations: params.selected.map(() => ({ dx: 0, dy: 0 })),
      canonicalDerivedF0: false, operatorAdjustmentApplied: true,
      selectionAlgorithm: 'operator-selected-indices-v1',
    },
    contract: {
      sequenceFormat: 'loop', frameSourceContract: 'video-raw-only',
      uniqueFrameCount: 8, playbackFrameCount: 8, frameWidth: 192, frameHeight: 256,
      allowStatic: true, playback: [0, 1, 2, 3, 4, 5, 6, 7],
    },
    decision: { outcome: 'technical_pass', reasonCodes: [], semanticPromotionApproved: false },
    artifacts: {
      runtimeSheet: { sha256: hashes.runtime, sizeBytes: runtime.byteLength, width: 1536, height: 256 },
      rawUniqueFramesSheet: { sha256: hashes.raw, sizeBytes: raw.byteLength, width: 3072, height: 2048 },
      allFramesContactSheet: {
        sha256: hashes.contact, sizeBytes: contact.byteLength, width: 768, height: 256,
        columns: 8, rows: 2, cellWidth: 96, cellHeight: 128,
      },
      uniqueFramesSheet: { sha256: hashes.unique, sizeBytes: unique.byteLength, width: 1536, height: 256 },
    },
  };
  return {
    schemaVersion: 1, animationFormat: 'video-dense-v1', processingVersion: 5,
    frameW: 192, frameH: 256, frameCount: 8,
    spriteBase64: Buffer.from(runtime).toString('base64'),
    rawBase64: Buffer.from(raw).toString('base64'), rawFrameW: 768, rawFrameH: 1024,
    rawFrameCount: 8, allFramesContactSheetBase64: Buffer.from(contact).toString('base64'),
    uniqueFramesSheetBase64: Buffer.from(unique).toString('base64'),
    report: { ...reportWithoutHash, reportSha256: await hashString(canonicalJson(reportWithoutHash)) },
  } as unknown as VideoSpriteCompileResponse;
}

async function installAdjustmentProcessor(target: Harness, review: ReviewSeed): Promise<void> {
  const revision = await target.db.prepare(`SELECT canonical_sha256, canonical_blob_key,
    video_sha256, video_blob_key FROM video_sprite_candidate_revisions
    WHERE candidate_id = ? AND revision = 1`).bind(review.candidateId).first<{
      canonical_sha256: string; canonical_blob_key: string;
      video_sha256: string; video_blob_key: string;
    }>();
  if (!revision) throw new Error('missing seeded revision');
  const [canonical, video] = await Promise.all([
    target.bucket.head(revision.canonical_blob_key), target.bucket.head(revision.video_blob_key),
  ]);
  const fetch = vi.fn(async (request: Request) => {
    const body = await request.json() as { selectedVideoIndices: number[] };
    return Response.json(await adjustedResponse({
      jobId: review.jobId, selected: body.selectedVideoIndices,
      canonicalSha: revision.canonical_sha256, videoSha: revision.video_sha256,
      canonicalSize: canonical!.size, videoSize: video!.size,
    }));
  });
  target.env.IMAGE_PROCESSOR = { getByName: vi.fn(() => ({ fetch })) } as unknown as
    NonNullable<Env['IMAGE_PROCESSOR']>;
}

describe('video sprite review handlers', () => {
  it('validates every supplied production review pin while preserving unpinned browser review', async () => {
    const target = await createHarness();
    const exactSha = '1'.repeat(40);
    try {
      const review = (await seedReviews(target, 0, 'fighter_generation', 1))[0];
      target.env.ENVIRONMENT = 'production';
      target.env.WORKER_VERSION_METADATA = {
        id: 'video-review-worker',
        tag: `prod-${exactSha}-4`,
        timestamp: '2026-08-27T00:00:00Z',
      };
      const reviewUrl = `https://api.insertplayer.ai/api/generation-jobs/${review.jobId}/video-review`;
      const assetUrl = `${reviewUrl}/assets/report?revision=1`;

      expect((await getVideoSpriteReview(
        new Request(reviewUrl), target.env, AUTH, review.jobId,
      )).status).toBe(200);
      const unpinnedAsset = await getVideoSpriteReviewAsset(
        new Request(assetUrl), target.env, AUTH, review.jobId, 'report',
      );
      expect(unpinnedAsset.status).toBe(200);
      const unpinnedAssetSha256 = await hashString(await unpinnedAsset.arrayBuffer());
      expect(unpinnedAsset.headers.get('ETag')).toBe(`"${unpinnedAssetSha256}"`);
      expect(unpinnedAsset.headers.get('X-Content-SHA256')).toBe(unpinnedAssetSha256);

      const staleRead = new Request(reviewUrl, {
        headers: { 'X-Insert-Player-Expected-Worker-Sha': '2'.repeat(40) },
      });
      expect((await getVideoSpriteReview(
        staleRead, target.env, AUTH, review.jobId,
      )).status).toBe(409);
      const staleAsset = new Request(assetUrl, {
        headers: { 'X-Insert-Player-Expected-Worker-Sha': '2'.repeat(40) },
      });
      expect((await getVideoSpriteReviewAsset(
        staleAsset, target.env, AUTH, review.jobId, 'report',
      )).status).toBe(409);

      for (const handler of [
        approveVideoSpriteReview,
        rejectVideoSpriteReview,
        adjustVideoSpriteReview,
      ]) {
        const stale = decision(review, { selectedVideoIndices: [0, 1] });
        stale.headers.set('X-Insert-Player-Expected-Worker-Sha', '2'.repeat(40));
        expect((await handler(stale, target.env, AUTH, review.jobId)).status).toBe(409);
      }
      expect(await target.db.prepare(`SELECT status FROM video_sprite_candidates WHERE id = ?`)
        .bind(review.candidateId).first()).toEqual({ status: 'awaiting_review' });

      const exactRead = new Request(reviewUrl, {
        headers: { 'X-Insert-Player-Expected-Worker-Sha': exactSha },
      });
      expect((await getVideoSpriteReview(
        exactRead, target.env, AUTH, review.jobId,
      )).status).toBe(200);
      const exactAsset = new Request(assetUrl, {
        headers: { 'X-Insert-Player-Expected-Worker-Sha': exactSha },
      });
      expect((await getVideoSpriteReviewAsset(
        exactAsset, target.env, AUTH, review.jobId, 'report',
      )).status).toBe(200);
      expect((await approveVideoSpriteReview(
        decision(review), target.env, AUTH, review.jobId,
      )).status).toBe(200);
      const exactApproval = decision(review);
      exactApproval.headers.set('X-Insert-Player-Expected-Worker-Sha', exactSha);
      expect((await approveVideoSpriteReview(
        exactApproval, target.env, AUTH, review.jobId,
      )).status).toBe(200);
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('approves an exact metadata-less reviewed side_raw after validating every durable seal', async () => {
    const target = await createHarness();
    try {
      const review = (await seedReviews(target, 0, 'fighter_generation', 1))[0];
      await target.bucket.put(review.canonicalKey, review.canonicalBytes);

      const response = await approveVideoSpriteReview(decision(review), target.env, AUTH, review.jobId);

      expect(response.status).toBe(200);
      expect(await target.db.prepare(`SELECT status, approved_revision
        FROM video_sprite_candidates WHERE id = ?`).bind(review.candidateId).first())
        .toEqual({ status: 'approved', approved_revision: 1 });
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('approves an exact metadata-less reviewed crouch_raw for its mapped low action', async () => {
    const target = await createHarness();
    try {
      const reviews = await seedReviews(target, 4, 'fighter_generation', 5);
      const review = reviews.find(({ action }) => action === 'low_punch')!;
      await target.bucket.put(review.canonicalKey, review.canonicalBytes);

      const response = await approveVideoSpriteReview(decision(review), target.env, AUTH, review.jobId);

      expect(response.status).toBe(200);
      expect(await target.db.prepare(`SELECT status, approved_revision
        FROM video_sprite_candidates WHERE id = ?`).bind(review.candidateId).first())
        .toEqual({ status: 'approved', approved_revision: 1 });
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('rejects incorrect present canonical metadata even when another hash field is exact', async () => {
    const target = await createHarness();
    try {
      const review = (await seedReviews(target, 0, 'fighter_generation', 1))[0];
      await target.bucket.put(review.canonicalKey, review.canonicalBytes, { customMetadata: {
        contentSha256: await hashString(review.canonicalBytes),
        contentHash: '0'.repeat(64),
      } });
      await expectApprovalIntegrityFailureWithoutWrites(target, review);
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('rejects wrong metadata-less canonical bytes without approval side effects', async () => {
    const target = await createHarness();
    try {
      const review = (await seedReviews(target, 0, 'fighter_generation', 1))[0];
      await target.bucket.put(review.canonicalKey, buffer('tampered-reviewed-canonical'));
      await expectApprovalIntegrityFailureWithoutWrites(target, review);
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('keeps candidate-owned asset metadata mandatory', async () => {
    const target = await createHarness();
    try {
      const review = (await seedReviews(target, 0, 'fighter_generation', 1))[0];
      await target.bucket.put(review.runtimeKey, review.runtimeBytes);
      await expectApprovalIntegrityFailureWithoutWrites(target, review);
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('rejects a stale canonical current pointer without approval side effects', async () => {
    const target = await createHarness();
    try {
      const review = (await seedReviews(target, 0, 'fighter_generation', 1))[0];
      await target.db.prepare(`UPDATE fighters SET side_view_raw_blob_key = ? WHERE id = ?`)
        .bind('source/stale-side_raw', FIGHTER_ID).run();
      await expectApprovalIntegrityFailureWithoutWrites(target, review);
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('rejects a canonical version rebound to another fighter without approval side effects', async () => {
    const target = await createHarness();
    try {
      const review = (await seedReviews(target, 0, 'fighter_generation', 1))[0];
      await target.db.prepare(`UPDATE source_versions SET fighter_id = ? WHERE blob_key = ?`)
        .bind('e'.repeat(32), review.canonicalKey).run();
      await expectApprovalIntegrityFailureWithoutWrites(target, review);
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('rejects a source checkpoint that no longer matches the artifact-run manifest', async () => {
    const target = await createHarness();
    try {
      const review = (await seedReviews(target, 0, 'fighter_generation', 1))[0];
      await target.db.prepare(`UPDATE generation_artifact_checkpoints
        SET raw_content_hash = ?
        WHERE run_id = ? AND artifact_kind = 'source' AND artifact_name = 'side'`)
        .bind('0'.repeat(64), RUN_ID).run();
      await expectApprovalIntegrityFailureWithoutWrites(target, review);
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('rejects atomically and only offers a fresh full-run restart', async () => {
    const target = await createHarness();
    try {
      const review = (await seedReviews(target, 0, 'fighter_generation', 1))[0];
      const [first, replay] = await Promise.all([
        rejectVideoSpriteReview(decision(review, { reason: 'wrong motion' }), target.env, AUTH, review.jobId),
        rejectVideoSpriteReview(decision(review, { reason: 'wrong motion' }), target.env, AUTH, review.jobId),
      ]);
      expect([first.status, replay.status]).toEqual([200, 200]);
      const body = await first.json() as { review: Record<string, unknown> };
      expect(body.review).toMatchObject({
        status: 'rejected', fullRunRestartRequired: true,
        restartOperation: 'fighter_generation', continuationAvailable: false,
      });
      expect(body.review).not.toHaveProperty('retryAvailable');
      expect(body.review).not.toHaveProperty('retryOperation');
      expect(await target.db.prepare(`SELECT status, failure_stage
        FROM generation_artifact_runs WHERE id = ?`).bind(RUN_ID).first())
        .toEqual({ status: 'failed', failure_stage: 'review:rejected' });
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('handles concurrent final approval and re-promotes all 11 exact versions', async () => {
    const target = await createHarness();
    try {
      const reviews = await seedReviews(target, 10);
      const final = reviews.at(-1)!;
      const responses = await Promise.all([
        approveVideoSpriteReview(decision(final), target.env, AUTH, final.jobId),
        approveVideoSpriteReview(decision(final), target.env, AUTH, final.jobId),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      for (const response of responses) {
        const body = await response.json() as { review: { continuationAvailable: boolean } };
        expect(body.review.continuationAvailable).toBe(false);
      }
      expect(await target.db.prepare('SELECT status FROM generation_artifact_runs WHERE id = ?')
        .bind(RUN_ID).first()).toEqual({ status: 'succeeded' });
      expect(await target.db.prepare('SELECT quality_tier FROM fighters WHERE id = ?')
        .bind(FIGHTER_ID).first()).toEqual({ quality_tier: 'champion' });
      const current = await target.db.prepare(`SELECT animation_name, content_hash FROM sprites
        WHERE fighter_id = ? AND quality_tier = 'champion'`).bind(FIGHTER_ID)
        .all<{ animation_name: string; content_hash: string }>();
      expect(current.results).toHaveLength(11);
      for (const sprite of current.results ?? []) {
        const expected = reviews.find((review) => review.action === sprite.animation_name)!;
        expect(sprite.content_hash).toBe(await hashString(expected.runtimeBytes));
      }
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('activates a draft only through the exact completed reviewed Video provenance', async () => {
    const target = await createHarness();
    try {
      const reviews = await seedReviews(target, 10);
      const final = reviews.at(-1)!;
      expect((await approveVideoSpriteReview(
        decision(final), target.env, AUTH, final.jobId,
      )).status).toBe(200);
      const state = await target.db.prepare(`
        SELECT arcade.updated_at AS arcade_updated_at, fighter.updated_at AS fighter_updated_at
        FROM arcade_fighters arcade JOIN fighters fighter ON fighter.id = arcade.fighter_id
        WHERE arcade.fighter_id = ?
      `).bind(FIGHTER_ID).first<{
        arcade_updated_at: string; fighter_updated_at: string;
      }>();
      const response = await activateReviewedVideoArcadeFighter(new Request(
        `https://api.insertplayer.ai/api/admin/arcade/${FIGHTER_ID}/activate-reviewed-video`,
        {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            finalJobId: final.jobId,
            arcadeUpdatedAt: state!.arcade_updated_at,
            fighterUpdatedAt: state!.fighter_updated_at,
          }),
        },
      ), target.env, {
        ...AUTH, user: { plan_tier: 'admin' },
      } as AuthContext, FIGHTER_ID);
      const responseBody = await response.json();
      expect(response.status, JSON.stringify(responseBody)).toBe(200);
      expect(responseBody).toMatchObject({
        fighter: { fighterId: FIGHTER_ID, status: 'active', public: true },
        provenance: {
          artifactRunId: RUN_ID, finalJobId: final.jobId,
          approvedActionCount: 11, finalAction: 'victory',
          animationFormat: 'video-dense-v1', currentSpritesVerified: true,
        },
      });
      expect(await target.db.prepare(`SELECT status FROM arcade_fighters WHERE fighter_id = ?`)
        .bind(FIGHTER_ID).first()).toEqual({ status: 'active' });
      expect(await target.db.prepare(`SELECT public_flag FROM fighters WHERE id = ?`)
        .bind(FIGHTER_ID).first()).toEqual({ public_flag: 1 });
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('rejects a same-timestamp pointer mutation after validation but before the second seal', async () => {
    const target = await createHarness();
    try {
      const reviews = await seedReviews(target, 10);
      const final = reviews.at(-1)!;
      expect((await approveVideoSpriteReview(
        decision(final), target.env, AUTH, final.jobId,
      )).status).toBe(200);
      const state = await target.db.prepare(`
        SELECT arcade.updated_at AS arcade_updated_at, fighter.updated_at AS fighter_updated_at
        FROM arcade_fighters arcade JOIN fighters fighter ON fighter.id = arcade.fighter_id
        WHERE arcade.fighter_id = ?
      `).bind(FIGHTER_ID).first<{
        arcade_updated_at: string; fighter_updated_at: string;
      }>();
      const base = target.db;
      let sealReads = 0;
      target.env.DB = {
        prepare: (query: string) => {
          const statement = base.prepare(query);
          if (!query.trimStart().startsWith('SELECT json_array(')) return statement;
          const sealRead = ++sealReads;
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return {
                first: async <T>() => {
                  if (sealRead === 2) {
                    await base.prepare(`UPDATE sprites SET content_hash = ?
                      WHERE fighter_id = ? AND animation_name = 'idle'
                        AND quality_tier = 'champion'`)
                      .bind('0'.repeat(64), FIGHTER_ID).run();
                  }
                  return bound.first<T>();
                },
              } as unknown as D1PreparedStatement;
            },
          } as unknown as D1PreparedStatement;
        },
        batch: base.batch.bind(base),
      } as unknown as D1Database;
      const response = await activateReviewedVideoArcadeFighter(new Request(
        `https://api.insertplayer.ai/api/admin/arcade/${FIGHTER_ID}/activate-reviewed-video`,
        {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            finalJobId: final.jobId,
            arcadeUpdatedAt: state!.arcade_updated_at,
            fighterUpdatedAt: state!.fighter_updated_at,
          }),
        },
      ), target.env, {
        ...AUTH, user: { plan_tier: 'admin' },
      } as AuthContext, FIGHTER_ID);
      expect(response.status).toBe(409);
      expect(sealReads).toBe(2);
      expect(await base.prepare(`SELECT status FROM arcade_fighters WHERE fighter_id = ?`)
        .bind(FIGHTER_ID).first()).toEqual({ status: 'draft' });
      expect(await base.prepare(`SELECT public_flag, updated_at FROM fighters WHERE id = ?`)
        .bind(FIGHTER_ID).first()).toEqual({
          public_flag: 0,
          updated_at: state!.fighter_updated_at,
        });
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('loses the atomic activation CAS if a current pointer changes after the second seal', async () => {
    const target = await createHarness();
    try {
      const reviews = await seedReviews(target, 10);
      const final = reviews.at(-1)!;
      expect((await approveVideoSpriteReview(
        decision(final), target.env, AUTH, final.jobId,
      )).status).toBe(200);
      const state = await target.db.prepare(`
        SELECT arcade.updated_at AS arcade_updated_at, fighter.updated_at AS fighter_updated_at
        FROM arcade_fighters arcade JOIN fighters fighter ON fighter.id = arcade.fighter_id
        WHERE arcade.fighter_id = ?
      `).bind(FIGHTER_ID).first<{
        arcade_updated_at: string; fighter_updated_at: string;
      }>();
      const base = target.db;
      target.env.DB = {
        prepare: base.prepare.bind(base),
        batch: async (statements: D1PreparedStatement[]) => {
          await base.prepare(`UPDATE sprites SET content_hash = ?
            WHERE fighter_id = ? AND animation_name = 'idle' AND quality_tier = 'champion'`)
            .bind('0'.repeat(64), FIGHTER_ID).run();
          return base.batch(statements);
        },
      } as unknown as D1Database;
      const response = await activateReviewedVideoArcadeFighter(new Request(
        `https://api.insertplayer.ai/api/admin/arcade/${FIGHTER_ID}/activate-reviewed-video`,
        {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            finalJobId: final.jobId,
            arcadeUpdatedAt: state!.arcade_updated_at,
            fighterUpdatedAt: state!.fighter_updated_at,
          }),
        },
      ), target.env, {
        ...AUTH, user: { plan_tier: 'admin' },
      } as AuthContext, FIGHTER_ID);
      expect(response.status).toBe(409);
      expect(await base.prepare(`SELECT status FROM arcade_fighters WHERE fighter_id = ?`)
        .bind(FIGHTER_ID).first()).toEqual({ status: 'draft' });
      expect(await base.prepare(`SELECT public_flag FROM fighters WHERE id = ?`)
        .bind(FIGHTER_ID).first()).toEqual({ public_flag: 0 });
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('refuses final success when an earlier approved artifact is missing', async () => {
    const target = await createHarness();
    try {
      const reviews = await seedReviews(target, 10);
      const final = reviews.at(-1)!;
      await target.bucket.delete(reviews[0].runtimeKey);
      const response = await approveVideoSpriteReview(decision(final), target.env, AUTH, final.jobId);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        review: { status: 'approved', fullRunRestartRequired: true, continuationAvailable: false },
      });
      expect(await target.db.prepare('SELECT status FROM generation_artifact_runs WHERE id = ?')
        .bind(RUN_ID).first()).toEqual({ status: 'failed' });
      expect(await target.db.prepare('SELECT quality_tier FROM fighters WHERE id = ?')
        .bind(FIGHTER_ID).first()).toEqual({ quality_tier: 'contender' });
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('terminalizes a fully-approved run when an earlier crouch canonical seal is corrupt', async () => {
    const target = await createHarness();
    try {
      const reviews = await seedReviews(target, 10);
      const final = reviews.at(-1)!;
      await target.db.prepare(`UPDATE generation_artifact_checkpoints
        SET raw_content_hash = ?
        WHERE run_id = ? AND artifact_kind = 'source' AND artifact_name = 'crouch'`)
        .bind('0'.repeat(64), RUN_ID).run();

      const response = await approveVideoSpriteReview(decision(final), target.env, AUTH, final.jobId);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('canonical source seal failed integrity validation'),
        review: { status: 'approved', fullRunRestartRequired: true, continuationAvailable: false },
      });
      expect(await target.db.prepare(`SELECT status, failure_stage
        FROM generation_artifact_runs WHERE id = ?`).bind(RUN_ID).first()).toEqual({
        status: 'failed', failure_stage: 'review:integrity',
      });
      expect(await target.db.prepare(`SELECT stage, failure_stage, error_code
        FROM generation_jobs WHERE id = ?`).bind(final.jobId).first()).toEqual({
        stage: 'review:restart_required',
        failure_stage: 'review:integrity',
        error_code: 'video_review_integrity_failed',
      });
      expect((await target.db.prepare(`SELECT COUNT(*) AS count
        FROM video_sprite_candidates WHERE run_id = ? AND status = 'approved'`)
        .bind(RUN_ID).first<{ count: number }>())?.count).toBe(VIDEO_SPRITE_ACTIONS.length);
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('finishes an exact fully-approved run when GET recovers a post-approval crash', async () => {
    const target = await createHarness();
    try {
      const reviews = await seedReviews(target, VIDEO_SPRITE_ACTIONS.length);
      const first = reviews[0];
      const final = reviews.at(-1)!;
      const response = await getVideoSpriteReview(
        new Request(`https://api.insertplayer.ai/api/generation-jobs/${first.jobId}/video-review`),
        target.env,
        AUTH,
        first.jobId,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ review: {
        status: 'approved',
        continuationAvailable: false,
        fullRunRestartRequired: false,
      } });
      expect(await target.db.prepare(`SELECT status FROM generation_artifact_runs
        WHERE id = ?`).bind(RUN_ID).first()).toEqual({ status: 'succeeded' });
      expect(await target.db.prepare('SELECT quality_tier FROM fighters WHERE id = ?')
        .bind(FIGHTER_ID).first()).toEqual({ quality_tier: 'champion' });
      expect(await target.db.prepare(`SELECT stage FROM generation_jobs WHERE id = ?`)
        .bind(final.jobId).first()).toEqual({ stage: 'complete' });
      expect((await target.db.prepare(`SELECT COUNT(*) AS count FROM sprites
        WHERE fighter_id = ? AND quality_tier = 'champion'`).bind(FIGHTER_ID)
        .first<{ count: number }>())?.count).toBe(VIDEO_SPRITE_ACTIONS.length);
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('marks the leaf job restart-required when recovery from an older review finds corruption', async () => {
    const target = await createHarness();
    try {
      const reviews = await seedReviews(target, VIDEO_SPRITE_ACTIONS.length);
      const first = reviews[0];
      const final = reviews.at(-1)!;
      await target.bucket.delete(first.runtimeKey);
      const response = await getVideoSpriteReview(
        new Request(`https://api.insertplayer.ai/api/generation-jobs/${first.jobId}/video-review`),
        target.env,
        AUTH,
        first.jobId,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        finalizationError: expect.any(String),
        review: { status: 'approved', fullRunRestartRequired: true },
      });
      expect(await target.db.prepare(`SELECT status FROM generation_artifact_runs
        WHERE id = ?`).bind(RUN_ID).first()).toEqual({ status: 'failed' });
      expect(await target.db.prepare(`SELECT stage, error_code FROM generation_jobs
        WHERE id = ?`).bind(final.jobId).first()).toEqual({
        stage: 'review:restart_required', error_code: 'video_review_integrity_failed',
      });
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('does not apply final success side effects when the run loses the partial CAS', async () => {
    const target = await createHarness();
    try {
      const reviews = await seedReviews(target, 10);
      const final = reviews.at(-1)!;
      let batches = 0;
      const base = target.db;
      target.env.DB = {
        prepare: base.prepare.bind(base),
        batch: async (statements: D1PreparedStatement[]) => {
          batches += 1;
          if (batches === 2) {
            await base.prepare(`UPDATE generation_artifact_runs SET status = 'failed'
              WHERE id = ? AND status = 'partial'`).bind(RUN_ID).run();
          }
          return base.batch(statements);
        },
      } as unknown as D1Database;
      const response = await approveVideoSpriteReview(decision(final), target.env, AUTH, final.jobId);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        review: { fullRunRestartRequired: true, continuationAvailable: false },
      });
      expect(await base.prepare('SELECT quality_tier FROM fighters WHERE id = ?')
        .bind(FIGHTER_ID).first()).toEqual({ quality_tier: 'contender' });
      expect((await base.prepare(`SELECT COUNT(*) AS count FROM sprites WHERE fighter_id = ?`)
        .bind(FIGHTER_ID).first<{ count: number }>())?.count).toBe(1);
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('serializes concurrent adjustments and idempotently replays one revision', async () => {
    const target = await createHarness();
    try {
      const review = (await seedReviews(target, 0, 'fighter_generation', 1))[0];
      await installAdjustmentProcessor(target, review);
      const selected = [1, 2, 3, 4, 5, 6, 7, 9];
      const responses = await Promise.all([0, 1].map(() => adjustVideoSpriteReview(
        decision(review, { selectedVideoIndices: selected }), target.env, AUTH, review.jobId,
      )));
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(await target.db.prepare(`SELECT current_revision, adjustment_claim_token
        FROM video_sprite_candidates WHERE id = ?`).bind(review.candidateId).first())
        .toEqual({ current_revision: 2, adjustment_claim_token: null });
      expect((await target.db.prepare(`SELECT COUNT(*) AS count
        FROM video_sprite_candidate_revisions WHERE candidate_id = ?`)
        .bind(review.candidateId).first<{ count: number }>())?.count).toBe(2);
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('recovers an exact adjustment after a crash immediately after its durable claim', async () => {
    const target = await createHarness();
    try {
      const review = (await seedReviews(target, 0, 'fighter_generation', 1))[0];
      await installAdjustmentProcessor(target, review);
      const selectedVideoIndices = [1, 2, 3, 4, 5, 6, 7, 9];
      const claimToken = await hashString(canonicalJson({
        candidateId: review.candidateId,
        fromRevision: 1,
        selectedVideoIndices,
      }));
      await target.db.prepare(`UPDATE video_sprite_candidates
        SET adjustment_claim_token = ?, adjustment_claim_revision = 1,
            adjustment_claim_indices_json = ?
        WHERE id = ?`).bind(
        claimToken,
        JSON.stringify(selectedVideoIndices),
        review.candidateId,
      ).run();

      const pending = await getVideoSpriteReview(
        new Request(`https://api.insertplayer.ai/api/generation-jobs/${review.jobId}/video-review`),
        target.env,
        AUTH,
        review.jobId,
      );
      expect(await pending.json()).toMatchObject({ review: {
        revision: 1,
        pendingAdjustmentIndices: selectedVideoIndices,
      } });
      expect((await approveVideoSpriteReview(
        decision(review), target.env, AUTH, review.jobId,
      )).status).toBe(409);
      expect((await rejectVideoSpriteReview(
        decision(review), target.env, AUTH, review.jobId,
      )).status).toBe(409);

      const resumed = await adjustVideoSpriteReview(
        decision(review, { selectedVideoIndices }), target.env, AUTH, review.jobId,
      );
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toMatchObject({ review: {
        revision: 2,
        pendingAdjustmentIndices: null,
        selectedVideoIndices,
      } });
      expect((await target.db.prepare(`SELECT COUNT(*) AS count
        FROM video_sprite_candidate_revisions WHERE candidate_id = ?`)
        .bind(review.candidateId).first<{ count: number }>())?.count).toBe(2);
    } finally { await target.mf.dispose(); }
  }, 30_000);

  it('returns 409 for a different concurrent adjustment before creating orphan versions', async () => {
    const target = await createHarness();
    try {
      const review = (await seedReviews(target, 0, 'fighter_generation', 1))[0];
      await installAdjustmentProcessor(target, review);
      const selections = [
        [1, 2, 3, 4, 5, 6, 7, 9],
        [0, 1, 2, 3, 4, 5, 6, 8],
      ];
      const responses = await Promise.all(selections.map((selectedVideoIndices) => (
        adjustVideoSpriteReview(
          decision(review, { selectedVideoIndices }), target.env, AUTH, review.jobId,
        )
      )));
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      expect((await target.db.prepare(`SELECT COUNT(*) AS count FROM sprite_versions
        WHERE fighter_id = ? AND animation_name = 'idle'`).bind(FIGHTER_ID)
        .first<{ count: number }>())?.count).toBe(2);
      expect((await target.db.prepare(`SELECT COUNT(*) AS count
        FROM video_sprite_candidate_revisions WHERE candidate_id = ?`).bind(review.candidateId)
        .first<{ count: number }>())?.count).toBe(2);
    } finally { await target.mf.dispose(); }
  }, 30_000);
});
