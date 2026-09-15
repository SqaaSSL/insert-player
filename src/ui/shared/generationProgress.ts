import type { GenerationJob } from '../../services/GenerationJobs.ts';
import { animLabel } from './fighterPreview.ts';

/** Checkpoints are work completed by the server, never an elapsed-time estimate. */
export function generationProgress(job: GenerationJob) {
  const total = Number.isFinite(job.progressTotal) && job.progressTotal > 0
    ? Math.floor(job.progressTotal) : 0;
  const completed = Number.isFinite(job.progressCurrent)
    ? Math.max(0, Math.min(total, Math.floor(job.progressCurrent))) : 0;
  return { completed, total, fraction: total > 0 ? completed / total : null };
}

export function describeGenerationJob(job: GenerationJob): string {
  if (job.status === 'queued') return 'Queued safely in the cloud.';
  if (job.creationFlow === 'video' && job.status === 'succeeded') {
    if (job.reviewStatus === 'awaiting_review') return 'Video ready. Paused safely for your review.';
    if (job.reviewStatus === 'approved' && job.resumable) return 'Action approved. Continue when ready.';
    if (job.reviewStatus === 'rejected') return 'Video rejected. No additional action was generated.';
  }
  if (job.status === 'succeeded') return 'Moves saved. Downloading your playable character.';
  if (job.status === 'failed' || job.status === 'cancelled') {
    return job.errorMessage ?? 'Creation stopped. Your completed stages are preserved.';
  }
  if (job.stage === 'initializing') return 'Preparing your character.';
  const stageSaved = job.completedStages.includes(job.stage);
  if (job.stage === 'source:side') return stageSaved ? 'Your fighting reference is ready.' : 'Preparing your fighting reference.';
  if (job.stage === 'source:upright') return stageSaved ? 'Your standing reference is ready.' : 'Preparing your standing reference.';
  if (job.stage === 'source:crouch') return stageSaved ? 'Your crouching reference is ready.' : 'Preparing your crouching reference.';
  if (job.stage === 'atlas:prepare') return 'Creating your moves. This can take a moment.';
  if (/^atlas:.+:generating$/.test(job.stage)) return 'Creating your moves. This can take a moment.';
  if (/^atlas:.+:ready$/.test(job.stage)) return 'Move images received. Finishing the cutouts.';
  if (job.stage.startsWith('sprite:')) return stageSaved ? `${animLabel(job.stage.slice('sprite:'.length))} saved.`
    : `Finishing ${animLabel(job.stage.slice('sprite:'.length))}.`;
  if (job.stage === 'saving' || job.stage === 'complete') return 'Saving your character.';
  return 'Creating your character in the cloud.';
}

/** Only a new persisted preview checkpoint can trigger an incremental download. */
export function generationPreviewCheckpoint(job: GenerationJob): string | null {
  if (job.status !== 'running') return null;
  const checkpoints = job.completedStages.filter((stage) =>
    /^source:(side|upright|crouch)$/.test(stage) || /^sprite:/.test(stage));
  return checkpoints.length ? `${job.id}:${[...new Set(checkpoints)].sort().join('|')}` : null;
}
