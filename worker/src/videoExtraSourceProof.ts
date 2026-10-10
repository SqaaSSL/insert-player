import { hashString } from './auth';
import {
  parseSealedReviewedCanonicalSources,
  REVIEWED_CANONICAL_SOURCE_MODE,
  reviewedCanonicalHashesFromSealed,
  ReviewedCanonicalSourceError,
  validateReviewedCanonicalSourcesCurrent,
  type ReviewedCanonicalSourceHashes,
  type ReviewedCanonicalSourceName,
  type SealedReviewedCanonicalSources,
} from './reviewedCanonicalSources';
import { sealedVideoRosterImportFor, type SealedVideoRosterImport } from './sealedVideoRosterImports';
import type { Env } from './types';
import { canonicalJson } from './videoSpriteGeneration';
import { VIDEO_SPRITE_ACTIONS } from '../../src/services/VideoSpriteCompileContract';

/**
 * Proof that an official Champion's six live canonical source PNGs are the
 * exact bytes its approved Video set was generated from. Approval is permanent:
 * the proof is derived from production records (approved review candidates and
 * their run's source checkpoints, provider-free recurations of those sprites,
 * or a sealed hash-pinned roster import), never from an expiring artifact.
 *
 * Every one of the 11 live sprites must trace back to an approved origin, every
 * origin must record the same six SHA-256 values, and the live source pointers
 * and R2 bytes must hash to exactly those values. Anything else fails closed.
 */
export const VIDEO_EXTRA_SOURCE_PROOF_KIND = 'approved-video-sources-v1' as const;

const SOURCE_NAMES: readonly ReviewedCanonicalSourceName[] = ['side', 'upright', 'crouch'];
const MAX_LINEAGE_HOPS = 8;

export class VideoExtraSourceProofError extends Error {
  constructor(message: string, readonly detail: Record<string, unknown> = {}, readonly status = 409) {
    super(message);
    this.name = 'VideoExtraSourceProofError';
  }
}

export type VideoExtraSourceProofOrigin =
  | {
      kind: 'reviewed-video-run';
      runId: string;
      rootJobId: string;
      runStatus: string;
      recordedBy: 'sealed-manifest' | 'source-checkpoints';
      sourceHashes: ReviewedCanonicalSourceHashes;
    }
  | {
      kind: 'sealed-roster-import';
      bundleId: string;
      sourceHashes: ReviewedCanonicalSourceHashes;
    };

export interface VideoExtraSourceProofLineage {
  action: string;
  spriteVersionId: string;
  processedSha256: string;
  rawSha256: string | null;
  processingVersion: number;
  /** runId or bundleId of the approved origin. */
  origin: string;
  originSpriteVersionId: string;
  candidateId: string | null;
  jobId: string | null;
  revision: number | null;
  /** Provider-free recurations between the approved origin and the live sprite. */
  recurationProposalIds: string[];
}

export interface VideoExtraSourceProof {
  schemaVersion: 1;
  kind: typeof VIDEO_EXTRA_SOURCE_PROOF_KIND;
  fighterId: string;
  ownerUserId: string;
  canonicalSourceMode: typeof REVIEWED_CANONICAL_SOURCE_MODE;
  canonicalSourceHashes: ReviewedCanonicalSourceHashes;
  sources: SealedReviewedCanonicalSources['sources'];
  origins: VideoExtraSourceProofOrigin[];
  lineage: VideoExtraSourceProofLineage[];
}

export interface ProvenVideoExtraSources {
  proof: VideoExtraSourceProof;
  proofSha256: string;
  reviewedCanonicalSources: SealedReviewedCanonicalSources;
}

interface CurrentVersionRow {
  id: string;
  content_hash: string;
  raw_content_hash: string | null;
  processing_version: number;
}

interface ApprovedCandidateRow {
  candidate_id: string;
  job_id: string;
  approved_revision: number;
  run_id: string;
  run_user_id: string;
  run_fighter_id: string;
  run_status: string;
  root_job_id: string;
  run_creation_flow: string;
  run_operation: string;
  run_target_kind: string | null;
  run_tier: string;
  source_manifest_json: string | null;
  job_review_status: string;
}

interface SourceCheckpointRow {
  artifact_name: string;
  stage_index: number;
  tier: string;
  status: string;
  clean_version_id: string;
  raw_version_id: string | null;
  clean_blob_key: string;
  raw_blob_key: string | null;
  clean_content_hash: string | null;
  raw_content_hash: string | null;
}

async function currentSpriteVersions(env: Env, fighterId: string, action: string): Promise<CurrentVersionRow[]> {
  const { results } = await env.DB.prepare(`
    SELECT version.id, version.content_hash, version.raw_content_hash, version.processing_version
    FROM sprites current
    JOIN sprite_versions version
      ON version.fighter_id = current.fighter_id
      AND version.animation_name = current.animation_name
      AND version.quality_tier = current.quality_tier
      AND version.blob_key = current.blob_key
      AND version.content_hash = current.content_hash
      AND COALESCE(version.raw_blob_key, '') = COALESCE(current.raw_blob_key, '')
      AND COALESCE(version.raw_content_hash, '') = COALESCE(current.raw_content_hash, '')
      AND version.processing_version = current.processing_version
      AND version.animation_format = current.animation_format
    WHERE current.fighter_id = ? AND current.animation_name = ? AND current.quality_tier = 'champion'
    ORDER BY version.created_at ASC, version.id ASC
    LIMIT 4
  `).bind(fighterId, action).all<CurrentVersionRow>();
  return results ?? [];
}

async function approvedCandidateFor(
  env: Env,
  fighterId: string,
  ownerUserId: string,
  action: string,
  versionId: string,
): Promise<ApprovedCandidateRow | null> {
  return env.DB.prepare(`
    SELECT candidate.id AS candidate_id, candidate.job_id, candidate.approved_revision,
      run.id AS run_id, run.user_id AS run_user_id, run.fighter_id AS run_fighter_id,
      run.status AS run_status, run.root_job_id, run.creation_flow AS run_creation_flow,
      run.operation AS run_operation, run.target_kind AS run_target_kind, run.tier AS run_tier,
      run.source_manifest_json, job.review_status AS job_review_status
    FROM video_sprite_candidate_revisions revision
    JOIN video_sprite_candidates candidate
      ON candidate.id = revision.candidate_id AND candidate.approved_revision = revision.revision
    JOIN generation_artifact_runs run ON run.id = candidate.run_id
    JOIN generation_jobs job ON job.id = candidate.job_id
    WHERE revision.sprite_version_id = ? AND candidate.status = 'approved'
      AND candidate.fighter_id = ? AND candidate.user_id = ? AND candidate.action = ?
    ORDER BY candidate.reviewed_at DESC, candidate.id ASC
    LIMIT 1
  `).bind(versionId, fighterId, ownerUserId, action).first<ApprovedCandidateRow>();
}

async function recurationParent(
  env: Env,
  fighterId: string,
  action: string,
  versionId: string,
): Promise<{ proposal_id: string; from_sprite_version_id: string } | null> {
  return env.DB.prepare(`
    SELECT proposal_id, from_sprite_version_id
    FROM imported_global_video_recuration_transitions
    WHERE fighter_id = ? AND action = ? AND operation = 'promote' AND to_sprite_version_id = ?
    ORDER BY created_at DESC, id ASC
    LIMIT 1
  `).bind(fighterId, action, versionId).first<{ proposal_id: string; from_sprite_version_id: string }>();
}

async function versionHashes(env: Env, versionId: string): Promise<CurrentVersionRow | null> {
  return env.DB.prepare(`
    SELECT id, content_hash, raw_content_hash, processing_version
    FROM sprite_versions WHERE id = ? LIMIT 1
  `).bind(versionId).first<CurrentVersionRow>();
}

async function recordedRunSources(
  env: Env,
  candidate: ApprovedCandidateRow,
  fighterId: string,
  ownerUserId: string,
): Promise<{ recordedBy: 'sealed-manifest' | 'source-checkpoints'; sourceHashes: ReviewedCanonicalSourceHashes }> {
  const { results } = await env.DB.prepare(`
    SELECT artifact_name, stage_index, tier, status, clean_version_id, raw_version_id,
      clean_blob_key, raw_blob_key, clean_content_hash, raw_content_hash
    FROM generation_artifact_checkpoints
    WHERE run_id = ? AND artifact_kind = 'source'
  `).bind(candidate.run_id).all<SourceCheckpointRow>();
  const checkpoints = new Map((results ?? []).map((row) => [row.artifact_name, row]));

  let sealed: SealedReviewedCanonicalSources | null;
  try {
    sealed = parseSealedReviewedCanonicalSources(candidate.source_manifest_json);
  } catch (error) {
    throw new VideoExtraSourceProofError(
      `Approved Video run ${candidate.run_id} has an invalid sealed source manifest`,
      { runId: candidate.run_id, reason: error instanceof Error ? error.message : 'invalid' },
    );
  }
  if (sealed && (sealed.fighterId !== fighterId || sealed.ownerUserId !== ownerUserId)) {
    throw new VideoExtraSourceProofError(
      `Approved Video run ${candidate.run_id} is sealed to another fighter or owner`,
      { runId: candidate.run_id },
    );
  }

  const sourceHashes = {} as ReviewedCanonicalSourceHashes;
  for (const [index, sourceName] of SOURCE_NAMES.entries()) {
    const checkpoint = checkpoints.get(sourceName);
    if (
      !checkpoint || checkpoint.status !== 'approved' || checkpoint.tier !== 'champion' ||
      checkpoint.stage_index !== index + 1 ||
      !checkpoint.clean_content_hash || !checkpoint.raw_content_hash
    ) {
      throw new VideoExtraSourceProofError(
        `Approved Video run ${candidate.run_id} does not record its ${sourceName} canonical source hashes`,
        { runId: candidate.run_id, source: sourceName },
      );
    }
    if (sealed) {
      const pair = sealed.sources[sourceName];
      if (
        checkpoint.clean_version_id !== pair.processed.versionId ||
        checkpoint.raw_version_id !== pair.raw.versionId ||
        checkpoint.clean_blob_key !== pair.processed.blobKey ||
        checkpoint.raw_blob_key !== pair.raw.blobKey ||
        checkpoint.clean_content_hash !== pair.processed.contentSha256 ||
        checkpoint.raw_content_hash !== pair.raw.contentSha256
      ) {
        throw new VideoExtraSourceProofError(
          `Approved Video run ${candidate.run_id} ${sourceName} checkpoint disagrees with its sealed manifest`,
          { runId: candidate.run_id, source: sourceName },
        );
      }
    }
    sourceHashes[sourceName] = {
      processedSha256: checkpoint.clean_content_hash,
      rawSha256: checkpoint.raw_content_hash,
    };
  }
  if (sealed && canonicalJson(sourceHashes) !== canonicalJson(reviewedCanonicalHashesFromSealed(sealed))) {
    throw new VideoExtraSourceProofError(
      `Approved Video run ${candidate.run_id} source checkpoints disagree with its sealed manifest`,
      { runId: candidate.run_id },
    );
  }
  return { recordedBy: sealed ? 'sealed-manifest' : 'source-checkpoints', sourceHashes };
}

/** Live pointer hashes from D1 only, for a precise mismatch report before the byte check. */
async function livePointerHashes(
  env: Env,
  fighterId: string,
  ownerUserId: string,
): Promise<Record<string, string | null>> {
  const row = await env.DB.prepare(`
    SELECT
      (SELECT content_hash FROM source_versions WHERE fighter_id = f.id AND kind = 'side' AND blob_key = f.side_view_blob_key LIMIT 1) AS side,
      (SELECT content_hash FROM source_versions WHERE fighter_id = f.id AND kind = 'side_raw' AND blob_key = f.side_view_raw_blob_key LIMIT 1) AS side_raw,
      (SELECT content_hash FROM source_versions WHERE fighter_id = f.id AND kind = 'upright' AND blob_key = f.upright_view_blob_key LIMIT 1) AS upright,
      (SELECT content_hash FROM source_versions WHERE fighter_id = f.id AND kind = 'upright_raw' AND blob_key = f.upright_view_raw_blob_key LIMIT 1) AS upright_raw,
      (SELECT content_hash FROM source_versions WHERE fighter_id = f.id AND kind = 'crouch' AND blob_key = f.crouch_view_blob_key LIMIT 1) AS crouch,
      (SELECT content_hash FROM source_versions WHERE fighter_id = f.id AND kind = 'crouch_raw' AND blob_key = f.crouch_view_raw_blob_key LIMIT 1) AS crouch_raw
    FROM fighters f
    WHERE f.id = ? AND f.owner_user_id = ?
    LIMIT 1
  `).bind(fighterId, ownerUserId).first<Record<string, string | null>>();
  return row ?? {};
}

function sourceMismatches(
  recorded: ReviewedCanonicalSourceHashes,
  live: Record<string, string | null>,
): Array<{ source: string; recordedSha256: string; liveSha256: string | null }> {
  return SOURCE_NAMES.flatMap((sourceName) => [
    { source: sourceName, recordedSha256: recorded[sourceName].processedSha256, liveSha256: live[sourceName] ?? null },
    { source: `${sourceName}_raw`, recordedSha256: recorded[sourceName].rawSha256, liveSha256: live[`${sourceName}_raw`] ?? null },
  ]).filter((entry) => entry.recordedSha256 !== entry.liveSha256);
}

export async function proveVideoExtraSources(
  env: Env,
  fighterId: string,
  ownerUserId: string,
  sealedImport: SealedVideoRosterImport | null = sealedVideoRosterImportFor(fighterId),
): Promise<ProvenVideoExtraSources> {
  if (sealedImport && sealedImport.fighterId !== fighterId) sealedImport = null;
  const origins = new Map<string, VideoExtraSourceProofOrigin>();
  const lineage: VideoExtraSourceProofLineage[] = [];

  for (const action of VIDEO_SPRITE_ACTIONS) {
    const current = await currentSpriteVersions(env, fighterId, action);
    if (current.length === 0) {
      throw new VideoExtraSourceProofError(
        `The live ${action} sprite has no immutable sprite version`,
        { action },
      );
    }
    let resolved: VideoExtraSourceProofLineage | null = null;
    for (const live of current) {
      const recurationProposalIds: string[] = [];
      let version: CurrentVersionRow | null = live;
      for (let hop = 0; version && hop <= MAX_LINEAGE_HOPS && !resolved; hop += 1) {
        const candidate = await approvedCandidateFor(env, fighterId, ownerUserId, action, version.id);
        if (
          candidate && candidate.run_user_id === ownerUserId && candidate.run_fighter_id === fighterId &&
          candidate.run_creation_flow === 'video' && candidate.run_operation === 'fighter_generation' &&
          candidate.run_target_kind === null && candidate.run_tier === 'champion' &&
          candidate.job_review_status === 'approved'
        ) {
          if (!origins.has(candidate.run_id)) {
            const recorded = await recordedRunSources(env, candidate, fighterId, ownerUserId);
            origins.set(candidate.run_id, {
              kind: 'reviewed-video-run',
              runId: candidate.run_id,
              rootJobId: candidate.root_job_id,
              runStatus: candidate.run_status,
              ...recorded,
            });
          }
          resolved = {
            action,
            spriteVersionId: live.id,
            processedSha256: live.content_hash,
            rawSha256: live.raw_content_hash,
            processingVersion: live.processing_version,
            origin: candidate.run_id,
            originSpriteVersionId: version.id,
            candidateId: candidate.candidate_id,
            jobId: candidate.job_id,
            revision: candidate.approved_revision,
            recurationProposalIds,
          };
          break;
        }
        const pinned = sealedImport
          ? [sealedImport.sprites[action], ...(sealedImport.liveSuccessors?.[action] ?? [])].filter(Boolean)
          : [];
        if (
          sealedImport && pinned.some((pair) => (
            version!.content_hash === pair.processedSha256 && version!.raw_content_hash === pair.rawSha256
          ))
        ) {
          origins.set(sealedImport.bundleId, {
            kind: 'sealed-roster-import',
            bundleId: sealedImport.bundleId,
            sourceHashes: sealedImport.sourceHashes,
          });
          resolved = {
            action,
            spriteVersionId: live.id,
            processedSha256: live.content_hash,
            rawSha256: live.raw_content_hash,
            processingVersion: live.processing_version,
            origin: sealedImport.bundleId,
            originSpriteVersionId: version.id,
            candidateId: null,
            jobId: null,
            revision: null,
            recurationProposalIds,
          };
          break;
        }
        const parent = await recurationParent(env, fighterId, action, version.id);
        if (!parent || recurationProposalIds.includes(parent.proposal_id)) break;
        recurationProposalIds.push(parent.proposal_id);
        version = await versionHashes(env, parent.from_sprite_version_id);
      }
      if (resolved) break;
    }
    if (!resolved) {
      throw new VideoExtraSourceProofError(
        `The live ${action} sprite does not trace back to an approved reviewed Video run or sealed roster import`,
        { action, spriteVersionIds: current.map((row) => row.id) },
      );
    }
    lineage.push(resolved);
  }

  const originList = [...origins.values()].sort((left, right) => (
    (left.kind === 'reviewed-video-run' ? left.runId : left.bundleId)
      .localeCompare(right.kind === 'reviewed-video-run' ? right.runId : right.bundleId)
  ));
  const recorded = originList[0].sourceHashes;
  const disagreeing = originList.filter((origin) => canonicalJson(origin.sourceHashes) !== canonicalJson(recorded));
  if (disagreeing.length > 0) {
    throw new VideoExtraSourceProofError(
      'The approved origins of the live sprites were generated from different canonical sources',
      { origins: originList },
    );
  }

  const mismatches = sourceMismatches(recorded, await livePointerHashes(env, fighterId, ownerUserId));
  if (mismatches.length > 0) {
    throw new VideoExtraSourceProofError(
      'The live canonical sources are not the approved Video sources',
      { mismatches, origins: originList.map((origin) => (
        origin.kind === 'reviewed-video-run' ? origin.runId : origin.bundleId
      )) },
    );
  }
  let reviewedCanonicalSources: SealedReviewedCanonicalSources;
  try {
    // Re-hashes all six live R2 objects byte-for-byte against the recorded values.
    reviewedCanonicalSources = await validateReviewedCanonicalSourcesCurrent(env, fighterId, ownerUserId, recorded);
  } catch (error) {
    if (error instanceof ReviewedCanonicalSourceError) {
      throw new VideoExtraSourceProofError(
        `The live canonical sources are not the approved Video sources: ${error.message}`,
      );
    }
    throw error;
  }

  const proof: VideoExtraSourceProof = {
    schemaVersion: 1,
    kind: VIDEO_EXTRA_SOURCE_PROOF_KIND,
    fighterId,
    ownerUserId,
    canonicalSourceMode: REVIEWED_CANONICAL_SOURCE_MODE,
    canonicalSourceHashes: recorded,
    sources: reviewedCanonicalSources.sources,
    origins: originList,
    lineage,
  };
  return { proof, proofSha256: await hashString(canonicalJson(proof)), reviewedCanonicalSources };
}

export function videoExtraSourceProofResponse(proven: ProvenVideoExtraSources): Record<string, unknown> {
  return {
    proof: proven.proof,
    proofSha256: proven.proofSha256,
    canonicalSourceMode: proven.proof.canonicalSourceMode,
    canonicalSourceHashes: proven.proof.canonicalSourceHashes,
  };
}
