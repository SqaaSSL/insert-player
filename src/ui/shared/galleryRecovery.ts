import type { GenerationJob } from '../../services/GenerationJobs.ts';

type GalleryRecoveryJob = Pick<
  GenerationJob,
  'fighterId' | 'operation' | 'status' | 'resumable'
>;

export function activeGalleryRecoveryJobs<T extends GalleryRecoveryJob>(jobs: T[]): T[] {
  return jobs.filter((job) => job.status === 'queued' || job.status === 'running');
}

export function resumableGalleryRecoveryJobs<T extends GalleryRecoveryJob>(jobs: T[]): T[] {
  return jobs.filter((job) => (
    (job.status === 'failed' || job.status === 'cancelled') && job.resumable
  ));
}

export function recoverableFighterGenerationIds(
  jobs: GalleryRecoveryJob[],
): string[] {
  return [...new Set(
    jobs
      .filter((job) => job.operation === 'fighter_generation')
      .map((job) => job.fighterId),
  )];
}
