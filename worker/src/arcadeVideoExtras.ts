import { generateId, hashString } from './auth';
import { createAdminGenerationAuthorization, generationJobRequest } from './arcadeGeneration';
import { createGenerationJob } from './generationJobs';
import { CURRENT_LEGAL_VERSION, parseGenerationLegalAttestation } from './legal';
import { readJsonBody } from './requestBody';
import {
  parseReviewedCanonicalSourceRequest,
  parseSealedReviewedCanonicalSources,
  ReviewedCanonicalSourceError,
  reviewedCanonicalHashesFromSealed,
} from './reviewedCanonicalSources';
import { requireReviewedProductionWorkerPin } from './reviewedDeploymentPin';
import type { AuthContext, Env } from './types';
import { canonicalJson } from './videoSpriteGeneration';
import {
  proveVideoExtraSources,
  VideoExtraSourceProofError,
  videoExtraSourceProofResponse,
  type ProvenVideoExtraSources,
} from './videoExtraSourceProof';
import {
  VIDEO_SPRITE_ACTIONS,
  VIDEO_SPRITE_ANIMATION_FORMAT,
  VIDEO_SPRITE_FRAME_HEIGHT,
  VIDEO_SPRITE_FRAME_WIDTH,
  VIDEO_SPRITE_PROCESSING_VERSION,
  isVideoSpriteExtraAction,
  type VideoSpriteExtraAction,
} from '../../src/services/VideoSpriteCompileContract';
import { STUDIO_CURATED_VIDEO_POLICY } from '../../src/services/VideoGenerationPolicy';

/**
 * Review-gated extra special moves (fireball, uppercut) for an existing
 * official Champion whose 11 actions already come from a reviewed Video run.
 *
 *   proof    -> read-only: the six live canonical source PNGs must be the exact
 *               SHA-256 bytes the approved Video set was generated from
 *   start    -> re-derives that proof, records it durably, then one
 *               fighter_retry_animation Video job from those sources; its single
 *               candidate waits at awaiting_review
 *   review   -> the existing inspect / approve / adjust / reject endpoints
 *               (approval does NOT publish an extra move)
 *   activate -> publishes ONLY the approved sprite version for that one move
 *   rollback -> unpublishes that exact version; it can be activated again
 *
 * The fighter's other animations are never read for writing or replaced.
 */

const MAX_BODY_BYTES = 8 * 1024;
/** One 2 s PixCLI clip is ~33 cents; uploads/status calls are free. */
const EXTRA_MOVE_PROVIDER_LIMITS = { calls: 12, costCents: 100 } as const;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

interface ExtraFighterRow {
  id: string;
  owner_user_id: string;
  quality_tier: string;
  arcade_status: 'draft' | 'active' | 'retired';
}

async function loadOfficialChampion(env: Env, auth: AuthContext, fighterId: string): Promise<ExtraFighterRow | null> {
  return env.DB.prepare(`
    SELECT f.id, f.owner_user_id, f.quality_tier, af.status AS arcade_status
    FROM fighters f
    JOIN arcade_fighters af ON af.fighter_id = f.id
    WHERE f.id = ? AND f.owner_user_id = ?
    LIMIT 1
  `).bind(fighterId, auth.userId).first<ExtraFighterRow>();
}

/**
 * video-dense-v1 processing versions whose runtime contract is identical:
 * 192x256 runtime / 768x1024 HQ cells, 24 fps sampling, the same per-action
 * sequence formats and root-at-feet origin. v6 only clamps root registration
 * so a wide pose is never cropped (migration 0032); reviewed activation and
 * the seed script already accept a mixed v5/v6 set. A v6 extra therefore
 * renders consistently next to v5 sheets. Legacy sheets stay excluded.
 */
export const EXTRA_COMPATIBLE_VIDEO_PROCESSING_VERSIONS = [5, VIDEO_SPRITE_PROCESSING_VERSION] as const;

/** The 11 published actions must already be reviewed video-dense-v1 sprites, so the extra matches them. */
export async function hasCompleteReviewedVideoSet(env: Env, fighterId: string): Promise<boolean> {
  const placeholders = VIDEO_SPRITE_ACTIONS.map(() => '?').join(', ');
  const versions = EXTRA_COMPATIBLE_VIDEO_PROCESSING_VERSIONS.map(() => '?').join(', ');
  const row = await env.DB.prepare(`
    SELECT COUNT(DISTINCT animation_name) AS n FROM sprites
    WHERE fighter_id = ? AND quality_tier = 'champion'
      AND animation_format = ? AND processing_version IN (${versions})
      AND frame_w = ? AND frame_h = ?
      AND animation_name IN (${placeholders})
  `).bind(
    fighterId, VIDEO_SPRITE_ANIMATION_FORMAT, ...EXTRA_COMPATIBLE_VIDEO_PROCESSING_VERSIONS,
    VIDEO_SPRITE_FRAME_WIDTH, VIDEO_SPRITE_FRAME_HEIGHT, ...VIDEO_SPRITE_ACTIONS,
  ).first<{ n: number }>();
  return (row?.n ?? 0) === VIDEO_SPRITE_ACTIONS.length;
}

export async function startAdminArcadeVideoExtraGeneration(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
  animationName: string,
): Promise<Response> {
  if (auth.user.plan_tier !== 'admin') return json({ error: 'Admin access required' }, 403);
  if (!/^[a-f0-9]{32}$/.test(fighterId)) return json({ error: 'A valid fighterId is required' }, 400);
  if (!isVideoSpriteExtraAction(animationName)) {
    return json({ error: 'A supported extra Video move is required (fireball or uppercut)' }, 400);
  }
  const pinFailure = requireReviewedProductionWorkerPin(request, env);
  if (pinFailure) return pinFailure;
  const body = await readJsonBody<{
    legal?: unknown;
    canonicalSourceMode?: unknown;
    canonicalSourceHashes?: unknown;
    expectedSourceProofSha256?: unknown;
  }>(request, MAX_BODY_BYTES);
  const legal = parseGenerationLegalAttestation(body.legal);
  if (!legal) {
    return json({ error: 'Current generation consent is required', legalVersion: CURRENT_LEGAL_VERSION }, 428);
  }
  let reviewedRequest;
  try {
    reviewedRequest = parseReviewedCanonicalSourceRequest(body.canonicalSourceMode, body.canonicalSourceHashes);
  } catch (error) {
    if (error instanceof ReviewedCanonicalSourceError) return json({ error: error.message }, error.status);
    throw error;
  }
  const expectedProofSha256 = body.expectedSourceProofSha256;
  if (
    expectedProofSha256 !== undefined &&
    (typeof expectedProofSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedProofSha256))
  ) {
    return json({ error: 'expectedSourceProofSha256 must be a lowercase SHA-256' }, 400);
  }

  const fighter = await loadOfficialChampion(env, auth, fighterId);
  if (!fighter) return json({ error: 'Official Arcade fighter not found' }, 404);
  if (fighter.arcade_status === 'retired') return json({ error: 'Retired Arcade fighters cannot start generation' }, 409);
  if (fighter.quality_tier !== 'champion') return json({ error: 'Extra Video moves are for Champion fighters' }, 409);
  if (!await hasCompleteReviewedVideoSet(env, fighterId)) {
    return json({
      error: 'The fighter needs its 11 reviewed video-dense-v1 (processing v5 or v6) Champion actions before an extra move',
      code: 'video_extra_requires_reviewed_video_set',
    }, 409);
  }
  const published = await env.DB.prepare(`
    SELECT id FROM sprites WHERE fighter_id = ? AND animation_name = ? AND quality_tier = 'champion' LIMIT 1
  `).bind(fighterId, animationName).first<{ id: string }>();
  if (published) {
    return json({
      error: `${animationName} is already published; roll it back before generating a replacement`,
      code: 'video_extra_already_published',
    }, 409);
  }
  const active = await env.DB.prepare(`
    SELECT id FROM generation_jobs WHERE fighter_id = ? AND status IN ('queued', 'running')
    ORDER BY created_at DESC LIMIT 1
  `).bind(fighterId).first<{ id: string }>();
  if (active) return json({ error: 'Another generation job is already active for this fighter', jobId: active.id }, 409);

  // Fail closed before any charge, job or provider call: the live sources must be
  // byte-identical to the approved Video sources recorded in production.
  let proven: ProvenVideoExtraSources;
  try {
    proven = await proveVideoExtraSources(env, fighterId, auth.userId);
  } catch (error) {
    if (error instanceof VideoExtraSourceProofError) return sourceProofFailure(error);
    throw error;
  }
  if (
    reviewedRequest &&
    canonicalJson(reviewedRequest) !== canonicalJson(proven.proof.canonicalSourceHashes)
  ) {
    return json({
      error: 'The supplied canonical source hashes are not the approved Video sources',
      code: 'video_extra_source_proof_failed',
    }, 409);
  }
  if (expectedProofSha256 !== undefined && expectedProofSha256 !== proven.proofSha256) {
    return json({
      error: 'The approved-source proof changed since it was inspected',
      code: 'video_extra_source_proof_changed',
      proofSha256: proven.proofSha256,
    }, 409);
  }

  // A job that failed before producing a candidate continues its own run.
  const partial = await env.DB.prepare(`
    SELECT gj.id AS job_id, gj.artifact_run_id AS run_id
    FROM generation_jobs gj
    JOIN generation_artifact_runs run ON run.id = gj.artifact_run_id
    WHERE gj.fighter_id = ? AND gj.user_id = ?
      AND gj.status IN ('failed', 'cancelled')
      AND gj.creation_flow = 'video' AND run.creation_flow = 'video'
      AND run.status = 'partial' AND run.tier = 'champion'
      AND run.operation = 'fighter_retry_animation'
      AND run.target_kind = 'animation' AND run.target_name = ?
      AND NOT EXISTS (SELECT 1 FROM video_sprite_candidates c WHERE c.run_id = run.id)
    ORDER BY gj.created_at DESC
    LIMIT 1
  `).bind(fighterId, auth.userId, animationName).first<{ job_id: string; run_id: string }>();

  const authorization = await createAdminGenerationAuthorization(env, auth, fighterId, {
    chargeReason: 'fighter_retry_animation',
    purpose: 'fighter_retry',
    operation: 'fighter_retry_animation',
    creationFlow: 'video',
    legal,
    providerLimits: { ...EXTRA_MOVE_PROVIDER_LIMITS },
    continuation: partial ? { runId: partial.run_id, fromJobId: partial.job_id } : undefined,
  });
  const response = await createGenerationJob(generationJobRequest(
    request,
    fighterId,
    authorization.purchaseId,
    authorization.providerSessionId,
    { kind: 'animation', name: animationName },
    'video',
  ), env, auth, {
    reviewedCanonicalSources: proven.reviewedCanonicalSources,
    videoGenerationPolicy: STUDIO_CURATED_VIDEO_POLICY,
    beforeWorkflowStart: (jobId, runId) => recordVideoExtraSourceProof(
      env, jobId, runId, auth.userId, animationName, proven,
    ),
  });
  if (!response.ok) return response;
  const created = await response.json<{ job?: { id?: unknown } }>();
  return json({
    ...created,
    sourceProof: { proofSha256: proven.proofSha256, kind: proven.proof.kind },
  }, response.status);
}

function sourceProofFailure(error: VideoExtraSourceProofError): Response {
  return json({
    error: error.message,
    code: 'video_extra_source_proof_failed',
    detail: error.detail,
  }, error.status);
}

async function recordVideoExtraSourceProof(
  env: Env,
  jobId: string,
  runId: string,
  ownerUserId: string,
  action: VideoSpriteExtraAction,
  proven: ProvenVideoExtraSources,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO video_extra_source_proofs (
      job_id, run_id, fighter_id, owner_user_id, action, proof_json, proof_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    jobId, runId, proven.proof.fighterId, ownerUserId, action,
    canonicalJson(proven.proof), proven.proofSha256,
  ).run();
}

interface StoredSourceProofRow {
  job_id: string;
  run_id: string;
  action: string;
  proof_json: string;
  proof_sha256: string;
  created_at: string;
}

async function storedVideoExtraSourceProof(
  env: Env,
  ownerUserId: string,
  fighterId: string,
  jobId: string,
): Promise<StoredSourceProofRow | null> {
  const row = await env.DB.prepare(`
    SELECT proof.job_id, proof.run_id, proof.action, proof.proof_json, proof.proof_sha256, proof.created_at
    FROM video_extra_source_proofs proof
    JOIN generation_jobs job ON job.id = proof.job_id AND job.artifact_run_id = proof.run_id
    WHERE proof.job_id = ? AND proof.owner_user_id = ? AND proof.fighter_id = ?
      AND job.user_id = ? AND job.fighter_id = ?
    LIMIT 1
  `).bind(jobId, ownerUserId, fighterId, ownerUserId, fighterId).first<StoredSourceProofRow>();
  if (!row || await hashString(row.proof_json) !== row.proof_sha256) return null;
  return row;
}

/**
 * GET /api/admin/arcade/:id/video-extra/source-proof           -> live proof (read-only)
 * GET /api/admin/arcade/:id/video-extra/source-proof?jobId=... -> the proof recorded at that job's start
 */
export async function getAdminArcadeVideoExtraSourceProof(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
): Promise<Response> {
  if (auth.user.plan_tier !== 'admin') return json({ error: 'Admin access required' }, 403);
  if (!/^[a-f0-9]{32}$/.test(fighterId)) return json({ error: 'A valid fighterId is required' }, 400);
  const fighter = await loadOfficialChampion(env, auth, fighterId);
  if (!fighter) return json({ error: 'Official Arcade fighter not found' }, 404);
  const jobId = new URL(request.url).searchParams.get('jobId');
  if (jobId !== null) {
    if (!/^[a-f0-9]{32}$/.test(jobId)) return json({ error: 'A valid jobId is required' }, 400);
    const stored = await storedVideoExtraSourceProof(env, auth.userId, fighterId, jobId);
    if (!stored) return json({ error: 'No intact approved-source proof is recorded for this job' }, 404);
    const proof = JSON.parse(stored.proof_json) as ProvenVideoExtraSources['proof'];
    return json({
      jobId: stored.job_id,
      artifactRunId: stored.run_id,
      action: stored.action,
      recordedAt: stored.created_at,
      proof,
      proofSha256: stored.proof_sha256,
      canonicalSourceMode: proof.canonicalSourceMode,
      canonicalSourceHashes: proof.canonicalSourceHashes,
    });
  }
  try {
    return json(videoExtraSourceProofResponse(await proveVideoExtraSources(env, fighterId, auth.userId)));
  } catch (error) {
    if (error instanceof VideoExtraSourceProofError) return sourceProofFailure(error);
    throw error;
  }
}

interface ApprovedExtraRow {
  job_id: string;
  job_status: string;
  review_status: string | null;
  creation_flow: string;
  operation: string;
  target_kind: string | null;
  target_name: string | null;
  tier: string;
  run_status: string;
  candidate_id: string;
  candidate_action: string;
  candidate_status: string;
  approved_revision: number | null;
  version_id: string;
  version_fighter_id: string;
  version_animation_name: string;
  version_quality_tier: string;
  blob_key: string;
  raw_blob_key: string | null;
  content_hash: string | null;
  raw_content_hash: string | null;
  frame_w: number | null;
  frame_h: number | null;
  frame_count: number | null;
  processing_version: number | null;
  animation_format: string;
}

/** Load and verify the exact approved revision of one extra-move job. */
export async function loadApprovedExtraMove(
  env: Env,
  userId: string,
  fighterId: string,
  jobId: string,
): Promise<{ row: ApprovedExtraRow; animation: VideoSpriteExtraAction } | { error: string; status: number }> {
  const row = await env.DB.prepare(`
    SELECT job.id AS job_id, job.status AS job_status, job.review_status, job.creation_flow,
      job.operation, job.target_kind, job.target_name, job.tier,
      run.status AS run_status,
      candidate.id AS candidate_id, candidate.action AS candidate_action,
      candidate.status AS candidate_status, candidate.approved_revision,
      version.id AS version_id, version.fighter_id AS version_fighter_id,
      version.animation_name AS version_animation_name, version.quality_tier AS version_quality_tier,
      version.blob_key, version.raw_blob_key, version.content_hash, version.raw_content_hash,
      version.frame_w, version.frame_h, version.frame_count, version.processing_version,
      version.animation_format
    FROM generation_jobs job
    JOIN generation_artifact_runs run ON run.id = job.artifact_run_id
    JOIN video_sprite_candidates candidate ON candidate.job_id = job.id
    JOIN video_sprite_candidate_revisions revision
      ON revision.candidate_id = candidate.id AND revision.revision = candidate.approved_revision
    JOIN sprite_versions version ON version.id = revision.sprite_version_id
    WHERE job.id = ? AND job.user_id = ? AND job.fighter_id = ?
    LIMIT 1
  `).bind(jobId, userId, fighterId).first<ApprovedExtraRow>();
  if (!row) return { error: 'Approved extra Video move not found', status: 404 };
  const animation = row.target_name;
  if (
    row.creation_flow !== 'video' || row.operation !== 'fighter_retry_animation' ||
    row.target_kind !== 'animation' || !isVideoSpriteExtraAction(animation) || row.tier !== 'champion'
  ) return { error: 'This job is not a review-gated extra Video move', status: 409 };
  if (
    row.job_status !== 'succeeded' || row.review_status !== 'approved' || row.run_status !== 'succeeded' ||
    row.candidate_status !== 'approved' || row.approved_revision === null || row.candidate_action !== animation
  ) return { error: 'The extra Video move is not approved yet', status: 409 };
  if (
    row.version_fighter_id !== fighterId || row.version_animation_name !== animation ||
    row.version_quality_tier !== 'champion' ||
    row.animation_format !== VIDEO_SPRITE_ANIMATION_FORMAT ||
    row.processing_version !== VIDEO_SPRITE_PROCESSING_VERSION ||
    row.frame_w !== VIDEO_SPRITE_FRAME_WIDTH || row.frame_h !== VIDEO_SPRITE_FRAME_HEIGHT ||
    !row.blob_key || !row.content_hash
  ) return { error: 'The approved sprite version does not match the reviewed Champion format', status: 409 };
  return { row, animation };
}

async function readJobId(request: Request): Promise<string | null> {
  const body = await readJsonBody<{ jobId?: unknown }>(request, MAX_BODY_BYTES);
  return typeof body.jobId === 'string' && /^[a-f0-9]{32}$/.test(body.jobId) ? body.jobId : null;
}

export async function activateAdminArcadeVideoExtra(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
): Promise<Response> {
  if (auth.user.plan_tier !== 'admin') return json({ error: 'Admin access required' }, 403);
  if (!/^[a-f0-9]{32}$/.test(fighterId)) return json({ error: 'A valid fighterId is required' }, 400);
  const pinFailure = requireReviewedProductionWorkerPin(request, env);
  if (pinFailure) return pinFailure;
  const jobId = await readJobId(request);
  if (!jobId) return json({ error: 'The exact reviewed extra Video job id is required' }, 400);
  const fighter = await loadOfficialChampion(env, auth, fighterId);
  if (!fighter) return json({ error: 'Official Arcade fighter not found' }, 404);
  if (fighter.arcade_status === 'retired') return json({ error: 'Retired Arcade fighters cannot be changed' }, 409);
  const loaded = await loadApprovedExtraMove(env, auth.userId, fighterId, jobId);
  if ('error' in loaded) return json({ error: loaded.error }, loaded.status);
  const { row, animation } = loaded;
  const sourceProof = await storedVideoExtraSourceProof(env, auth.userId, fighterId, jobId);
  const runSources = await env.DB.prepare(`
    SELECT run.source_manifest_json
    FROM generation_jobs job
    JOIN generation_artifact_runs run ON run.id = job.artifact_run_id
    WHERE job.id = ? AND job.user_id = ?
    LIMIT 1
  `).bind(jobId, auth.userId).first<{ source_manifest_json: string | null }>();
  let sealedRunSources;
  try {
    sealedRunSources = parseSealedReviewedCanonicalSources(runSources?.source_manifest_json ?? null);
  } catch {
    sealedRunSources = null;
  }
  if (
    !sourceProof || sourceProof.action !== animation || !sealedRunSources ||
    canonicalJson((JSON.parse(sourceProof.proof_json) as ProvenVideoExtraSources['proof']).canonicalSourceHashes) !==
      canonicalJson(reviewedCanonicalHashesFromSealed(sealedRunSources))
  ) {
    return json({
      error: 'This extra move has no intact approved-source proof bound to its run; it cannot be published',
      code: 'video_extra_source_proof_missing',
    }, 409);
  }
  const [clean, raw] = await Promise.all([
    env.SPRITES.head(row.blob_key),
    row.raw_blob_key ? env.SPRITES.head(row.raw_blob_key) : Promise.resolve(null),
  ]);
  if (!clean || (row.raw_blob_key && !raw)) {
    return json({ error: 'The approved extra move assets are unavailable' }, 409);
  }
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO sprites (
        id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
        content_hash, raw_content_hash, frame_w, frame_h, frame_count,
        processing_version, animation_format
      )
      SELECT ?, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
        content_hash, raw_content_hash, frame_w, frame_h, frame_count,
        processing_version, animation_format
      FROM sprite_versions WHERE id = ? AND fighter_id = ? AND animation_name = ?
      ON CONFLICT(fighter_id, animation_name, quality_tier) DO UPDATE SET
        blob_key = excluded.blob_key, raw_blob_key = excluded.raw_blob_key,
        content_hash = excluded.content_hash, raw_content_hash = excluded.raw_content_hash,
        frame_w = excluded.frame_w, frame_h = excluded.frame_h,
        frame_count = excluded.frame_count, processing_version = excluded.processing_version,
        animation_format = excluded.animation_format, created_at = datetime('now')
    `).bind(generateId(), row.version_id, fighterId, animation),
    env.DB.prepare(`UPDATE fighters SET updated_at = datetime('now') WHERE id = ? AND owner_user_id = ?`)
      .bind(fighterId, auth.userId),
    env.DB.prepare(`UPDATE arcade_fighters SET updated_at = datetime('now') WHERE fighter_id = ?`).bind(fighterId),
    env.DB.prepare(`
      INSERT OR IGNORE INTO generation_job_events (id, job_id, stage, status, detail)
      VALUES (?, ?, 'arcade:extra-activated', 'succeeded', ?)
    `).bind(`${jobId}:extra-activated:${row.version_id}`, jobId, `${animation} published from ${row.version_id}`),
  ]);
  const live = await env.DB.prepare(`
    SELECT blob_key, content_hash FROM sprites
    WHERE fighter_id = ? AND animation_name = ? AND quality_tier = 'champion' LIMIT 1
  `).bind(fighterId, animation).first<{ blob_key: string; content_hash: string | null }>();
  if (!live || live.blob_key !== row.blob_key || live.content_hash !== row.content_hash) {
    return json({ error: 'The extra move could not be published atomically' }, 500);
  }
  return json({
    fighterId, animation, jobId, spriteVersionId: row.version_id,
    sourceProofSha256: sourceProof.proof_sha256, published: true,
  });
}

export async function rollbackAdminArcadeVideoExtra(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
): Promise<Response> {
  if (auth.user.plan_tier !== 'admin') return json({ error: 'Admin access required' }, 403);
  if (!/^[a-f0-9]{32}$/.test(fighterId)) return json({ error: 'A valid fighterId is required' }, 400);
  const pinFailure = requireReviewedProductionWorkerPin(request, env);
  if (pinFailure) return pinFailure;
  const jobId = await readJobId(request);
  if (!jobId) return json({ error: 'The exact reviewed extra Video job id is required' }, 400);
  const fighter = await loadOfficialChampion(env, auth, fighterId);
  if (!fighter) return json({ error: 'Official Arcade fighter not found' }, 404);
  const loaded = await loadApprovedExtraMove(env, auth.userId, fighterId, jobId);
  if ('error' in loaded) return json({ error: loaded.error }, loaded.status);
  const { row, animation } = loaded;
  // Only the exact version this job published is removed; the version itself is kept.
  const result = await env.DB.prepare(`
    DELETE FROM sprites
    WHERE fighter_id = ? AND animation_name = ? AND quality_tier = 'champion'
      AND blob_key = ? AND content_hash = ?
  `).bind(fighterId, animation, row.blob_key, row.content_hash).run();
  if ((result.meta.changes ?? 0) > 0) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE fighters SET updated_at = datetime('now') WHERE id = ? AND owner_user_id = ?`)
        .bind(fighterId, auth.userId),
      env.DB.prepare(`UPDATE arcade_fighters SET updated_at = datetime('now') WHERE fighter_id = ?`).bind(fighterId),
    ]);
  }
  return json({ fighterId, animation, jobId, published: false, removed: (result.meta.changes ?? 0) > 0 });
}
