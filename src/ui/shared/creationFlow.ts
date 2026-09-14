import {
  generationCreationFlowOrDefault,
  type GenerationCreationFlow,
} from '../../services/GenerationCreationFlow.ts';
import type { GenerationJob } from '../../services/GenerationJobs.ts';

export type CreationFlow = GenerationCreationFlow;

export function creationFlowForResume(value: unknown): CreationFlow {
  return generationCreationFlowOrDefault(value);
}

export function assertCreationFlowAcknowledged(
  requested: CreationFlow,
  acknowledged: unknown,
): void {
  if (acknowledged !== undefined && acknowledged !== null && acknowledged !== requested) {
    throw new Error('The server confirmed a different creation flow; no generation job was started');
  }
  if (requested === 'video' && acknowledged !== 'video') {
    throw new Error('Video creation is not enabled on this server; no generation job was started');
  }
}

type VideoRosterJobState = Pick<
  GenerationJob,
  'creationFlow' | 'operation' | 'status' | 'reviewStatus' | 'resumable' | 'fullRunRestartRequired'
>;

export function isVideoReviewOrRestartJob(job: VideoRosterJobState): boolean {
  return job.creationFlow === 'video' && job.operation === 'fighter_generation' && (
    job.fullRunRestartRequired || (
      job.status === 'succeeded' && (
        job.reviewStatus === 'awaiting_review' ||
        job.reviewStatus === 'rejected' ||
        (job.reviewStatus === 'approved' && job.resumable)
      )
    )
  );
}

/** Archived terminal runs stay in the gallery without trapping new character creation. */
export function isRecoverableVideoReviewJob(job: VideoRosterJobState): boolean {
  return isVideoReviewOrRestartJob(job) && !job.fullRunRestartRequired && job.reviewStatus !== 'rejected';
}

export function isVideoResumableJob(job: VideoRosterJobState): boolean {
  return job.creationFlow === 'video' && job.operation === 'fighter_generation' &&
    (job.status === 'failed' || job.status === 'cancelled') && job.resumable;
}

export function videoReviewJobNeedsConsent(
  job: Pick<GenerationJob, 'fullRunRestartRequired' | 'reviewStatus' | 'resumable'> | null,
): boolean {
  return Boolean(job && !job.fullRunRestartRequired && job.reviewStatus === 'approved' && job.resumable);
}

export function videoReviewDecisionNeedsConsent(
  review: { status: string; continuationAvailable: boolean } | null,
  fullRunRestartRequired = false,
): boolean {
  return !fullRunRestartRequired && Boolean(review && review.status === 'approved' && review.continuationAvailable);
}

export function durableRecoveryFailureNeedsRetry(
  recoveryLookupCompleted: boolean,
  recoverableJobFound: boolean,
): boolean {
  return recoveryLookupCompleted && recoverableJobFound;
}
