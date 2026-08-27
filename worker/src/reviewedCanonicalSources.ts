import { hashString } from './auth';
import { recordSourceCheckpoint, requireArtifactRunId } from './generationArtifacts';
import type { Env, GenerationArtifactCheckpoint, GenerationJob, SourceVersion } from './types';

export const REVIEWED_CANONICAL_SOURCE_MODE = 'reviewed-current-v1' as const;

const MAX_REVIEWED_SOURCE_BYTES = 12 * 1024 * 1024;
const SOURCE_NAMES = ['side', 'upright', 'crouch'] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type ReviewedCanonicalSourceName = typeof SOURCE_NAMES[number];
type ReviewedCanonicalSourceKind = ReviewedCanonicalSourceName | `${ReviewedCanonicalSourceName}_raw`;

export interface ReviewedCanonicalSourceHashes {
  side: { processedSha256: string; rawSha256: string };
  upright: { processedSha256: string; rawSha256: string };
  crouch: { processedSha256: string; rawSha256: string };
}

export interface SealedReviewedCanonicalSourceIdentity {
  versionId: string;
  blobKey: string;
  contentSha256: string;
}

export interface SealedReviewedCanonicalSources {
  schemaVersion: 1;
  mode: typeof REVIEWED_CANONICAL_SOURCE_MODE;
  fighterId: string;
  ownerUserId: string;
  sources: Record<ReviewedCanonicalSourceName, {
    processed: SealedReviewedCanonicalSourceIdentity;
    raw: SealedReviewedCanonicalSourceIdentity;
  }>;
}

export interface GenerationSourceManifest {
  side: string | null;
  sideRaw: string | null;
  upright: string | null;
  uprightRaw: string | null;
  crouch: string | null;
  crouchRaw: string | null;
  reviewedCanonicalSources?: SealedReviewedCanonicalSources;
}

interface CurrentReviewedSourceKeysRow {
  owner_user_id: string;
  side_view_blob_key: string | null;
  side_view_raw_blob_key: string | null;
  upright_view_blob_key: string | null;
  upright_view_raw_blob_key: string | null;
  crouch_view_blob_key: string | null;
  crouch_view_raw_blob_key: string | null;
}

export class ReviewedCanonicalSourceError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = 'ReviewedCanonicalSourceError';
  }
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseHashPair(value: unknown): { processedSha256: string; rawSha256: string } | null {
  if (!isExactObject(value, ['processedSha256', 'rawSha256'])) return null;
  const processedSha256 = value.processedSha256;
  const rawSha256 = value.rawSha256;
  if (
    typeof processedSha256 !== 'string' || !SHA256_PATTERN.test(processedSha256) ||
    typeof rawSha256 !== 'string' || !SHA256_PATTERN.test(rawSha256)
  ) return null;
  return { processedSha256, rawSha256 };
}

export function parseReviewedCanonicalSourceRequest(
  mode: unknown,
  hashes: unknown,
): ReviewedCanonicalSourceHashes | null {
  if (mode === undefined && hashes === undefined) return null;
  if (mode !== REVIEWED_CANONICAL_SOURCE_MODE) {
    throw new ReviewedCanonicalSourceError('Unsupported canonical source mode', 400);
  }
  if (!isExactObject(hashes, SOURCE_NAMES)) {
    throw new ReviewedCanonicalSourceError('Exactly six reviewed canonical source hashes are required', 400);
  }
  const side = parseHashPair(hashes.side);
  const upright = parseHashPair(hashes.upright);
  const crouch = parseHashPair(hashes.crouch);
  if (!side || !upright || !crouch) {
    throw new ReviewedCanonicalSourceError('Reviewed canonical source hashes must be lowercase SHA-256 values', 400);
  }
  return { side, upright, crouch };
}

function sourceColumns(sourceName: ReviewedCanonicalSourceName): {
  processed: keyof CurrentReviewedSourceKeysRow;
  raw: keyof CurrentReviewedSourceKeysRow;
} {
  if (sourceName === 'side') {
    return { processed: 'side_view_blob_key', raw: 'side_view_raw_blob_key' };
  }
  if (sourceName === 'upright') {
    return { processed: 'upright_view_blob_key', raw: 'upright_view_raw_blob_key' };
  }
  return { processed: 'crouch_view_blob_key', raw: 'crouch_view_raw_blob_key' };
}

async function validateR2Identity(
  env: Env,
  identity: SealedReviewedCanonicalSourceIdentity,
  label: string,
  fullHash: boolean,
): Promise<void> {
  if (fullHash) {
    const object = await env.SPRITES.get(identity.blobKey);
    if (!object) throw new ReviewedCanonicalSourceError(`${label} is missing from durable storage`);
    if (object.size > MAX_REVIEWED_SOURCE_BYTES) {
      throw new ReviewedCanonicalSourceError(`${label} exceeds the reviewed source size limit`);
    }
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength > MAX_REVIEWED_SOURCE_BYTES || await hashString(bytes) !== identity.contentSha256) {
      throw new ReviewedCanonicalSourceError(`${label} bytes do not match the reviewed SHA-256`);
    }
    return;
  }
  const object = await env.SPRITES.head(identity.blobKey);
  if (!object) throw new ReviewedCanonicalSourceError(`${label} is missing from durable storage`);
  if (object.size > MAX_REVIEWED_SOURCE_BYTES) {
    throw new ReviewedCanonicalSourceError(`${label} exceeds the reviewed source size limit`);
  }
  const metadataHash = object.customMetadata?.contentHash;
  if (metadataHash && metadataHash !== identity.contentSha256) {
    throw new ReviewedCanonicalSourceError(`${label} metadata does not match the reviewed SHA-256`);
  }
}

async function loadExactSourceVersion(
  env: Env,
  fighterId: string,
  kind: ReviewedCanonicalSourceKind,
  blobKey: string,
  expectedHash: string,
): Promise<SealedReviewedCanonicalSourceIdentity> {
  const version = await env.DB.prepare(`
    SELECT id, fighter_id, kind, blob_key, content_hash, created_at
    FROM source_versions
    WHERE fighter_id = ? AND kind = ? AND blob_key = ?
    LIMIT 1
  `).bind(fighterId, kind, blobKey).first<SourceVersion>();
  if (
    !version || version.fighter_id !== fighterId || version.kind !== kind ||
    version.blob_key !== blobKey || version.content_hash !== expectedHash
  ) {
    throw new ReviewedCanonicalSourceError(`Current ${kind} source does not match the reviewed identity`);
  }
  return { versionId: version.id, blobKey: version.blob_key, contentSha256: expectedHash };
}

export async function validateReviewedCanonicalSourcesCurrent(
  env: Env,
  fighterId: string,
  ownerUserId: string,
  hashes: ReviewedCanonicalSourceHashes,
): Promise<SealedReviewedCanonicalSources> {
  const fighter = await env.DB.prepare(`
    SELECT owner_user_id,
      side_view_blob_key, side_view_raw_blob_key,
      upright_view_blob_key, upright_view_raw_blob_key,
      crouch_view_blob_key, crouch_view_raw_blob_key
    FROM fighters
    WHERE id = ? AND owner_user_id = ?
    LIMIT 1
  `).bind(fighterId, ownerUserId).first<CurrentReviewedSourceKeysRow>();
  if (!fighter || fighter.owner_user_id !== ownerUserId) {
    throw new ReviewedCanonicalSourceError('Reviewed canonical sources do not belong to this fighter');
  }

  const sources = {} as SealedReviewedCanonicalSources['sources'];
  for (const sourceName of SOURCE_NAMES) {
    const columns = sourceColumns(sourceName);
    const processedKey = fighter[columns.processed];
    const rawKey = fighter[columns.raw];
    if (typeof processedKey !== 'string' || typeof rawKey !== 'string') {
      throw new ReviewedCanonicalSourceError(`Current ${sourceName} source pair is incomplete`);
    }
    const processed = await loadExactSourceVersion(
      env, fighterId, sourceName, processedKey, hashes[sourceName].processedSha256,
    );
    const raw = await loadExactSourceVersion(
      env, fighterId, `${sourceName}_raw`, rawKey, hashes[sourceName].rawSha256,
    );
    await validateR2Identity(env, processed, `${sourceName} processed source`, true);
    await validateR2Identity(env, raw, `${sourceName} raw source`, true);
    sources[sourceName] = { processed, raw };
  }
  return {
    schemaVersion: 1,
    mode: REVIEWED_CANONICAL_SOURCE_MODE,
    fighterId,
    ownerUserId,
    sources,
  };
}

function parseIdentity(value: unknown): SealedReviewedCanonicalSourceIdentity | null {
  if (!isExactObject(value, ['versionId', 'blobKey', 'contentSha256'])) return null;
  if (
    typeof value.versionId !== 'string' || !/^[a-f0-9]{32}$/.test(value.versionId) ||
    typeof value.blobKey !== 'string' || value.blobKey.length < 1 || value.blobKey.length > 1024 ||
    typeof value.contentSha256 !== 'string' || !SHA256_PATTERN.test(value.contentSha256)
  ) return null;
  return {
    versionId: value.versionId,
    blobKey: value.blobKey,
    contentSha256: value.contentSha256,
  };
}

function parseSealedSourcePair(value: unknown): {
  processed: SealedReviewedCanonicalSourceIdentity;
  raw: SealedReviewedCanonicalSourceIdentity;
} | null {
  if (!isExactObject(value, ['processed', 'raw'])) return null;
  const processed = parseIdentity(value.processed);
  const raw = parseIdentity(value.raw);
  return processed && raw ? { processed, raw } : null;
}

export function parseSealedReviewedCanonicalSources(
  sourceManifestJson: string | null,
): SealedReviewedCanonicalSources | null {
  if (!sourceManifestJson) return null;
  let manifest: unknown;
  try {
    manifest = JSON.parse(sourceManifestJson);
  } catch {
    throw new ReviewedCanonicalSourceError('Durable generation source manifest is invalid');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new ReviewedCanonicalSourceError('Durable generation source manifest is invalid');
  }
  const reviewed = (manifest as Record<string, unknown>).reviewedCanonicalSources;
  if (reviewed === undefined) return null;
  if (!isExactObject(reviewed, ['schemaVersion', 'mode', 'fighterId', 'ownerUserId', 'sources'])) {
    throw new ReviewedCanonicalSourceError('Sealed reviewed canonical source manifest is invalid');
  }
  if (
    reviewed.schemaVersion !== 1 || reviewed.mode !== REVIEWED_CANONICAL_SOURCE_MODE ||
    typeof reviewed.fighterId !== 'string' || !/^[a-f0-9]{32}$/.test(reviewed.fighterId) ||
    typeof reviewed.ownerUserId !== 'string' || !reviewed.ownerUserId
  ) {
    throw new ReviewedCanonicalSourceError('Sealed reviewed canonical source manifest is invalid');
  }
  if (!isExactObject(reviewed.sources, SOURCE_NAMES)) {
    throw new ReviewedCanonicalSourceError('Sealed reviewed canonical source manifest is incomplete');
  }
  const side = parseSealedSourcePair(reviewed.sources.side);
  const upright = parseSealedSourcePair(reviewed.sources.upright);
  const crouch = parseSealedSourcePair(reviewed.sources.crouch);
  if (!side || !upright || !crouch) {
    throw new ReviewedCanonicalSourceError('Sealed reviewed canonical source identities are invalid');
  }
  const sealed: SealedReviewedCanonicalSources = {
    schemaVersion: 1,
    mode: REVIEWED_CANONICAL_SOURCE_MODE,
    fighterId: reviewed.fighterId,
    ownerUserId: reviewed.ownerUserId,
    sources: { side, upright, crouch },
  };
  const legacy = manifest as Record<string, unknown>;
  if (
    legacy.side !== side.processed.blobKey || legacy.sideRaw !== side.raw.blobKey ||
    legacy.upright !== upright.processed.blobKey || legacy.uprightRaw !== upright.raw.blobKey ||
    legacy.crouch !== crouch.processed.blobKey || legacy.crouchRaw !== crouch.raw.blobKey
  ) {
    throw new ReviewedCanonicalSourceError('Sealed reviewed sources conflict with the durable source keys');
  }
  return sealed;
}

export function reviewedCanonicalHashesFromSealed(
  sealed: SealedReviewedCanonicalSources,
): ReviewedCanonicalSourceHashes {
  return {
    side: {
      processedSha256: sealed.sources.side.processed.contentSha256,
      rawSha256: sealed.sources.side.raw.contentSha256,
    },
    upright: {
      processedSha256: sealed.sources.upright.processed.contentSha256,
      rawSha256: sealed.sources.upright.raw.contentSha256,
    },
    crouch: {
      processedSha256: sealed.sources.crouch.processed.contentSha256,
      rawSha256: sealed.sources.crouch.raw.contentSha256,
    },
  };
}

export function assertReviewedCanonicalRequestMatchesSealed(
  requested: ReviewedCanonicalSourceHashes,
  sealed: SealedReviewedCanonicalSources | null,
  fighterId: string,
  ownerUserId: string,
): asserts sealed is SealedReviewedCanonicalSources {
  if (!sealed || sealed.fighterId !== fighterId || sealed.ownerUserId !== ownerUserId) {
    throw new ReviewedCanonicalSourceError('This run is not sealed to the requested reviewed canonical sources');
  }
  if (JSON.stringify(requested) !== JSON.stringify(reviewedCanonicalHashesFromSealed(sealed))) {
    throw new ReviewedCanonicalSourceError('Reviewed canonical source hashes cannot change during a run');
  }
}

export function generationSourceManifest(
  legacy: Omit<GenerationSourceManifest, 'reviewedCanonicalSources'>,
  sealed?: SealedReviewedCanonicalSources,
): GenerationSourceManifest {
  if (!sealed) return legacy;
  return {
    side: sealed.sources.side.processed.blobKey,
    sideRaw: sealed.sources.side.raw.blobKey,
    upright: sealed.sources.upright.processed.blobKey,
    uprightRaw: sealed.sources.upright.raw.blobKey,
    crouch: sealed.sources.crouch.processed.blobKey,
    crouchRaw: sealed.sources.crouch.raw.blobKey,
    reviewedCanonicalSources: sealed,
  };
}

function assertCheckpointMatchesSealed(
  checkpoint: GenerationArtifactCheckpoint,
  sourceName: ReviewedCanonicalSourceName,
  sealed: SealedReviewedCanonicalSources,
): void {
  const source = sealed.sources[sourceName];
  if (
    checkpoint.status !== 'approved' || checkpoint.artifact_kind !== 'source' ||
    checkpoint.artifact_name !== sourceName || checkpoint.clean_version_id !== source.processed.versionId ||
    checkpoint.raw_version_id !== source.raw.versionId || checkpoint.clean_blob_key !== source.processed.blobKey ||
    checkpoint.raw_blob_key !== source.raw.blobKey || checkpoint.clean_content_hash !== source.processed.contentSha256 ||
    checkpoint.raw_content_hash !== source.raw.contentSha256
  ) {
    throw new ReviewedCanonicalSourceError(`${sourceName} checkpoint conflicts with the sealed reviewed sources`);
  }
}

export async function importReviewedCanonicalSourceCheckpoint(
  env: Env,
  job: GenerationJob,
  sealed: SealedReviewedCanonicalSources,
  sourceName: ReviewedCanonicalSourceName,
  stageIndex: number,
): Promise<{ cleanKey: string; rawKey: string }> {
  if (
    job.creation_flow !== 'video' || job.operation !== 'fighter_generation' ||
    sealed.fighterId !== job.fighter_id || sealed.ownerUserId !== job.user_id
  ) {
    throw new ReviewedCanonicalSourceError('Reviewed canonical sources do not match this Video job');
  }
  const runId = requireArtifactRunId(job);
  const checkpoint = await env.DB.prepare(`
    SELECT * FROM generation_artifact_checkpoints
    WHERE run_id = ? AND artifact_kind = 'source' AND artifact_name = ?
    LIMIT 1
  `).bind(runId, sourceName).first<GenerationArtifactCheckpoint>();
  const source = sealed.sources[sourceName];
  if (checkpoint) {
    assertCheckpointMatchesSealed(checkpoint, sourceName, sealed);
    await validateR2Identity(env, source.processed, `${sourceName} processed source`, true);
    await validateR2Identity(env, source.raw, `${sourceName} raw source`, true);
    return { cleanKey: source.processed.blobKey, rawKey: source.raw.blobKey };
  }

  const processed = await loadExactSourceVersion(
    env, job.fighter_id, sourceName, source.processed.blobKey, source.processed.contentSha256,
  );
  const raw = await loadExactSourceVersion(
    env, job.fighter_id, `${sourceName}_raw`, source.raw.blobKey, source.raw.contentSha256,
  );
  if (processed.versionId !== source.processed.versionId || raw.versionId !== source.raw.versionId) {
    throw new ReviewedCanonicalSourceError(`${sourceName} source versions changed identity before import`);
  }
  await validateR2Identity(env, source.processed, `${sourceName} processed source`, true);
  await validateR2Identity(env, source.raw, `${sourceName} raw source`, true);
  await recordSourceCheckpoint(env, job, {
    sourceName,
    stageIndex,
    clean: {
      versionId: source.processed.versionId,
      blobKey: source.processed.blobKey,
      contentHash: source.processed.contentSha256,
      reused: true,
    },
    raw: {
      versionId: source.raw.versionId,
      blobKey: source.raw.blobKey,
      contentHash: source.raw.contentSha256,
      reused: true,
    },
  });
  return { cleanKey: source.processed.blobKey, rawKey: source.raw.blobKey };
}
