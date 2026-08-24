import {
  promoteGeneratedSourceVersion,
  promoteGeneratedSpriteVersion,
  type GeneratedSourceKind,
  type PersistedGeneratedAsset,
  type PersistedGeneratedSprite,
} from './generatedAssets';
import type {
  Env,
  GenerationArtifactCheckpoint,
  GenerationArtifactRun,
  GenerationJob,
  GenerationJobOperation,
} from './types';

export interface GenerationStageDefinition {
  key: string;
  artifactKind: 'source' | 'sprite';
  artifactName: string;
  index: number;
}

const SOURCE_NAMES = ['side', 'upright', 'crouch'] as const;
export const GENERATION_ANIMATION_NAMES = [
  'idle',
  'walk',
  'high_punch',
  'high_kick',
  'low_punch',
  'low_kick',
  'jump',
  'crouch',
  'hit',
  'ko',
  'victory',
] as const;

export class GenerationCheckpointIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationCheckpointIntegrityError';
  }
}

function stage(kind: 'source' | 'sprite', name: string, index: number): GenerationStageDefinition {
  return { key: `${kind}:${name}`, artifactKind: kind, artifactName: name, index };
}

export function generationStagesForOperation(
  operation: GenerationJobOperation,
  targetName: string | null = null,
): GenerationStageDefinition[] {
  if (operation === 'fighter_generation') {
    return [
      ...SOURCE_NAMES.map((name, index) => stage('source', name, index + 1)),
      ...GENERATION_ANIMATION_NAMES.map((name, index) => stage('sprite', name, index + 4)),
    ];
  }
  if (operation === 'fighter_upgrade') {
    return GENERATION_ANIMATION_NAMES.map((name, index) => stage('sprite', name, index + 1));
  }
  if (!targetName) return [];
  return [stage(operation === 'fighter_retry_source' ? 'source' : 'sprite', targetName, 1)];
}

export function pendingGenerationStages(
  operation: GenerationJobOperation,
  targetName: string | null,
  completedStageKeys: Iterable<string>,
): GenerationStageDefinition[] {
  const completed = new Set(completedStageKeys);
  return generationStagesForOperation(operation, targetName).filter((entry) => !completed.has(entry.key));
}

export function requireArtifactRunId(job: GenerationJob): string {
  if (!job.artifact_run_id) {
    throw new GenerationCheckpointIntegrityError('Generation job has no durable artifact run');
  }
  return job.artifact_run_id;
}

export async function loadArtifactRun(env: Env, job: GenerationJob): Promise<GenerationArtifactRun> {
  const run = await env.DB.prepare(`
    SELECT *
    FROM generation_artifact_runs
    WHERE id = ? AND user_id = ? AND fighter_id = ?
    LIMIT 1
  `).bind(requireArtifactRunId(job), job.user_id, job.fighter_id).first<GenerationArtifactRun>();
  if (!run) throw new GenerationCheckpointIntegrityError('Durable generation run is unavailable');
  if (run.tier !== job.tier || run.operation !== job.operation) {
    throw new GenerationCheckpointIntegrityError('Generation job does not match its durable artifact run');
  }
  return run;
}

export async function listArtifactCheckpoints(
  env: Env,
  runId: string,
): Promise<GenerationArtifactCheckpoint[]> {
  const { results } = await env.DB.prepare(`
    SELECT *
    FROM generation_artifact_checkpoints
    WHERE run_id = ?
    ORDER BY stage_index ASC
  `).bind(runId).all<GenerationArtifactCheckpoint>();
  return results ?? [];
}

export async function artifactProgress(
  env: Env,
  run: Pick<GenerationArtifactRun, 'id' | 'operation' | 'target_name'>,
): Promise<{
  completedStages: string[];
  pendingStages: string[];
  preservedArtifactCount: number;
}> {
  const checkpoints = await listArtifactCheckpoints(env, run.id);
  const completedStages = checkpoints
    .filter((checkpoint) => checkpoint.status === 'approved')
    .map((checkpoint) => `${checkpoint.artifact_kind}:${checkpoint.artifact_name}`);
  return {
    completedStages,
    pendingStages: pendingGenerationStages(run.operation, run.target_name, completedStages)
      .map((entry) => entry.key),
    preservedArtifactCount: completedStages.length,
  };
}

async function loadCheckpoint(
  env: Env,
  runId: string,
  artifactKind: 'source' | 'sprite',
  artifactName: string,
): Promise<GenerationArtifactCheckpoint | null> {
  return env.DB.prepare(`
    SELECT *
    FROM generation_artifact_checkpoints
    WHERE run_id = ? AND artifact_kind = ? AND artifact_name = ?
    LIMIT 1
  `).bind(runId, artifactKind, artifactName).first<GenerationArtifactCheckpoint>();
}

async function markCheckpointCorrupt(
  env: Env,
  checkpoint: GenerationArtifactCheckpoint,
  reason: string,
): Promise<never> {
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE generation_artifact_checkpoints
      SET status = 'corrupt', verified_at = datetime('now')
      WHERE run_id = ? AND artifact_kind = ? AND artifact_name = ?
    `).bind(checkpoint.run_id, checkpoint.artifact_kind, checkpoint.artifact_name),
    env.DB.prepare(`
      UPDATE generation_artifact_runs
      SET status = 'failed', failure_stage = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(`${checkpoint.artifact_kind}:${checkpoint.artifact_name}`, checkpoint.run_id),
  ]);
  throw new GenerationCheckpointIntegrityError(reason);
}

async function requireCheckpointObject(
  env: Env,
  checkpoint: GenerationArtifactCheckpoint,
  key: string | null,
  contentHash: string | null,
  label: string,
): Promise<void> {
  if (!key) return markCheckpointCorrupt(env, checkpoint, `${label} checkpoint has no immutable blob key`);
  const object = await env.SPRITES.head(key);
  if (!object) return markCheckpointCorrupt(env, checkpoint, `${label} checkpoint blob is missing from durable storage`);
  const storedHash = object.customMetadata?.contentHash;
  if (contentHash && storedHash && storedHash !== contentHash) {
    await markCheckpointCorrupt(env, checkpoint, `${label} checkpoint content hash does not match durable storage`);
  }
}

function parseMetadata<T>(checkpoint: GenerationArtifactCheckpoint): T | undefined {
  if (!checkpoint.metadata_json) return undefined;
  try {
    return JSON.parse(checkpoint.metadata_json) as T;
  } catch {
    return undefined;
  }
}

export async function reuseSourceCheckpoint<TMetadata = unknown>(
  env: Env,
  job: GenerationJob,
  sourceName: 'side' | 'upright' | 'crouch',
): Promise<{
  cleanKey: string;
  rawKey: string;
  cleanVersionId: string;
  rawVersionId: string;
  metadata?: TMetadata;
} | null> {
  const checkpoint = await loadCheckpoint(env, requireArtifactRunId(job), 'source', sourceName);
  if (!checkpoint) return null;
  if (checkpoint.status !== 'approved' || !checkpoint.raw_version_id || !checkpoint.raw_blob_key) {
    return markCheckpointCorrupt(env, checkpoint, `Checkpointed ${sourceName} source pair is incomplete`);
  }

  await requireCheckpointObject(env, checkpoint, checkpoint.clean_blob_key, checkpoint.clean_content_hash, `${sourceName} source`);
  await requireCheckpointObject(env, checkpoint, checkpoint.raw_blob_key, checkpoint.raw_content_hash, `${sourceName} raw source`);
  const clean = await promoteGeneratedSourceVersion(env, {
    userId: job.user_id,
    fighterId: job.fighter_id,
    kind: sourceName,
    versionId: checkpoint.clean_version_id,
  });
  const raw = await promoteGeneratedSourceVersion(env, {
    userId: job.user_id,
    fighterId: job.fighter_id,
    kind: `${sourceName}_raw` as GeneratedSourceKind,
    versionId: checkpoint.raw_version_id,
  });
  if (clean.blob_key !== checkpoint.clean_blob_key || raw.blob_key !== checkpoint.raw_blob_key) {
    return markCheckpointCorrupt(env, checkpoint, `Checkpointed ${sourceName} source versions changed identity`);
  }
  await env.DB.prepare(`
    UPDATE generation_artifact_checkpoints
    SET verified_at = datetime('now')
    WHERE run_id = ? AND artifact_kind = 'source' AND artifact_name = ?
  `).bind(checkpoint.run_id, sourceName).run();
  return {
    cleanKey: clean.blob_key,
    rawKey: raw.blob_key,
    cleanVersionId: clean.id,
    rawVersionId: raw.id,
    metadata: parseMetadata<TMetadata>(checkpoint),
  };
}

export async function reuseSpriteCheckpoint(
  env: Env,
  job: GenerationJob,
  animationName: string,
): Promise<{ animationName: string; versionId: string } | null> {
  const checkpoint = await loadCheckpoint(env, requireArtifactRunId(job), 'sprite', animationName);
  if (!checkpoint) return null;
  if (checkpoint.status !== 'approved') {
    return markCheckpointCorrupt(env, checkpoint, `Checkpointed ${animationName} sprite is not approved`);
  }

  await requireCheckpointObject(env, checkpoint, checkpoint.clean_blob_key, checkpoint.clean_content_hash, `${animationName} sprite`);
  if (checkpoint.raw_blob_key) {
    await requireCheckpointObject(env, checkpoint, checkpoint.raw_blob_key, checkpoint.raw_content_hash, `${animationName} raw sprite`);
  }
  const version = await promoteGeneratedSpriteVersion(env, {
    userId: job.user_id,
    fighterId: job.fighter_id,
    tier: job.tier,
    animationName,
    versionId: checkpoint.clean_version_id,
  });
  if (version.blob_key !== checkpoint.clean_blob_key || version.raw_blob_key !== checkpoint.raw_blob_key) {
    return markCheckpointCorrupt(env, checkpoint, `Checkpointed ${animationName} sprite version changed identity`);
  }
  await env.DB.prepare(`
    UPDATE generation_artifact_checkpoints
    SET verified_at = datetime('now')
    WHERE run_id = ? AND artifact_kind = 'sprite' AND artifact_name = ?
  `).bind(checkpoint.run_id, animationName).run();
  return { animationName, versionId: version.id };
}

function assertCheckpointIdentity(
  checkpoint: GenerationArtifactCheckpoint | null,
  expected: {
    cleanVersionId: string;
    rawVersionId: string | null;
    cleanBlobKey: string;
    rawBlobKey: string | null;
  },
  label: string,
): asserts checkpoint is GenerationArtifactCheckpoint {
  if (
    !checkpoint ||
    checkpoint.status !== 'approved' ||
    checkpoint.clean_version_id !== expected.cleanVersionId ||
    checkpoint.raw_version_id !== expected.rawVersionId ||
    checkpoint.clean_blob_key !== expected.cleanBlobKey ||
    checkpoint.raw_blob_key !== expected.rawBlobKey
  ) {
    throw new GenerationCheckpointIntegrityError(`${label} checkpoint conflicts with an immutable archived version`);
  }
}

export async function recordSourceCheckpoint(
  env: Env,
  job: GenerationJob,
  params: {
    sourceName: 'side' | 'upright' | 'crouch';
    stageIndex: number;
    clean: PersistedGeneratedAsset;
    raw: PersistedGeneratedAsset;
    metadata?: unknown;
  },
): Promise<void> {
  const runId = requireArtifactRunId(job);
  await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO generation_artifact_checkpoints (
        run_id, artifact_kind, artifact_name, stage_index, tier,
        clean_version_id, raw_version_id, clean_blob_key, raw_blob_key,
        clean_content_hash, raw_content_hash, metadata_json, completed_by_job_id
      ) VALUES (?, 'source', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      runId,
      params.sourceName,
      params.stageIndex,
      job.tier,
      params.clean.versionId,
      params.raw.versionId,
      params.clean.blobKey,
      params.raw.blobKey,
      params.clean.contentHash,
      params.raw.contentHash,
      params.metadata === undefined ? null : JSON.stringify(params.metadata),
      job.id,
    ),
    env.DB.prepare(`
      UPDATE generation_artifact_runs
      SET status = 'active', failure_stage = NULL, updated_at = datetime('now')
      WHERE id = ? AND status IN ('active', 'partial')
    `).bind(runId),
  ]);
  const checkpoint = await loadCheckpoint(env, runId, 'source', params.sourceName);
  assertCheckpointIdentity(checkpoint, {
    cleanVersionId: params.clean.versionId,
    rawVersionId: params.raw.versionId,
    cleanBlobKey: params.clean.blobKey,
    rawBlobKey: params.raw.blobKey,
  }, `${params.sourceName} source`);
}

export async function recordSpriteCheckpoint(
  env: Env,
  job: GenerationJob,
  params: {
    animationName: string;
    stageIndex: number;
    sprite: PersistedGeneratedSprite;
    processingVersion: number;
  },
): Promise<void> {
  const runId = requireArtifactRunId(job);
  await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO generation_artifact_checkpoints (
        run_id, artifact_kind, artifact_name, stage_index, tier,
        clean_version_id, clean_blob_key, raw_blob_key,
        clean_content_hash, raw_content_hash,
        frame_w, frame_h, frame_count, processing_version, completed_by_job_id
      ) VALUES (?, 'sprite', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      runId,
      params.animationName,
      params.stageIndex,
      job.tier,
      params.sprite.versionId,
      params.sprite.blobKey,
      params.sprite.rawBlobKey,
      params.sprite.contentHash,
      params.sprite.rawContentHash,
      params.sprite.frameWidth,
      params.sprite.frameHeight,
      params.sprite.frameCount,
      params.processingVersion,
      job.id,
    ),
    env.DB.prepare(`
      UPDATE generation_artifact_runs
      SET status = 'active', failure_stage = NULL, updated_at = datetime('now')
      WHERE id = ? AND status IN ('active', 'partial')
    `).bind(runId),
  ]);
  const checkpoint = await loadCheckpoint(env, runId, 'sprite', params.animationName);
  assertCheckpointIdentity(checkpoint, {
    cleanVersionId: params.sprite.versionId,
    rawVersionId: null,
    cleanBlobKey: params.sprite.blobKey,
    rawBlobKey: params.sprite.rawBlobKey,
  }, `${params.animationName} sprite`);
}

export async function assertArtifactRunComplete(env: Env, job: GenerationJob): Promise<void> {
  const run = await loadArtifactRun(env, job);
  const progress = await artifactProgress(env, run);
  if (progress.pendingStages.length > 0) {
    throw new GenerationCheckpointIntegrityError(
      `Generation cannot complete with pending durable stages: ${progress.pendingStages.join(', ')}`,
    );
  }
}
