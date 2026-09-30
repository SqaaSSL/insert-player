import type { GenerationJob } from '../../services/GenerationJobs.ts';

/** After this many paused runs of the same character, stop presenting "resume" as the only way forward. */
export const STUCK_GENERATION_ATTEMPTS = 3;

export interface PausedGenerationCopy {
  message: string;
  /** True when resuming alone is unlikely to help and the player should see other ways out. */
  stuck: boolean;
}

const REASONS: Record<string, string> = {
  template_atlas_qa_failed: 'Some of your moves did not come out right, so we held them back instead of giving you a broken character.',
  qa_rejected_output: 'Some of your moves did not come out right, so we held them back instead of giving you a broken character.',
  provider_content_blocked: 'Our image partner would not process this photo.',
  provider_daily_quota_exhausted: 'We are at capacity for today. Your character is saved and will continue later.',
};

/**
 * Plain-language copy for a paused character. Internal provider/QA strings stay
 * out of the UI: they belong in logs and support, not in front of a player.
 */
export function describePausedGeneration(
  job: Pick<GenerationJob, 'errorCode' | 'preservedArtifactCount'>,
  attemptsForCharacter: number,
): PausedGenerationCopy {
  const blocked = job.errorCode === 'provider_content_blocked';
  const stuck = blocked || attemptsForCharacter >= STUCK_GENERATION_ATTEMPTS;
  const reason = (job.errorCode && REASONS[job.errorCode]) ?? 'Your character paused before it was finished.';
  const saved = job.preservedArtifactCount > 0
    ? `${job.preservedArtifactCount} finished ${job.preservedArtifactCount === 1 ? 'step is' : 'steps are'} saved.`
    : 'Nothing is lost.';
  const next = blocked
    ? 'Try a different photo, or contact us if you think this is a mistake.'
    : stuck
      ? 'Trying again is free, but a different photo usually works better. You can also contact us.'
      : 'Trying again is free.';
  return { message: `${reason} ${saved} ${next}`, stuck };
}

/** How many paused runs this character has had, counting the one being shown. */
export function pausedAttemptsForCharacter(jobs: readonly GenerationJob[], fighterId: string): number {
  return jobs.filter(job => job.fighterId === fighterId && job.operation === 'fighter_generation'
    && (job.status === 'failed' || job.status === 'cancelled')).length;
}
