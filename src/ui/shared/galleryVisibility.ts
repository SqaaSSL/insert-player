import type { CloudFighter } from '../../services/CloudFighters.ts';
import { CACHE_VERSION, type CachedMeta } from '../../services/SpriteCache.ts';
import type { GenerationJob } from '../../services/GenerationJobs.ts';
import { visibleGalleryMetas } from './arcadeRosterIdentity.ts';
import {
  isVideoResumableJob,
  isVideoReviewOrRestartJob,
} from './creationFlow.ts';

type GalleryGenerationJob = Pick<
  GenerationJob,
  | 'fighterId'
  | 'creationFlow'
  | 'operation'
  | 'status'
  | 'reviewStatus'
  | 'resumable'
  | 'fullRunRestartRequired'
>;

function keepsIncompleteFighterVisible(job: GalleryGenerationJob): boolean {
  if (job.creationFlow !== 'video' || job.operation !== 'fighter_generation') return false;
  return job.status === 'queued' || job.status === 'running' ||
    isVideoReviewOrRestartJob(job) || isVideoResumableJob(job);
}

/**
 * Applies the one Gallery visibility contract used by initial load and refreshes.
 * Incomplete cached fighters remain discoverable only while a durable Video job
 * still has an action the user can monitor, review, restart, or resume.
 */
export function visibleGalleryMetasForJobs(
  metas: CachedMeta[],
  arcadeFighters: CloudFighter[],
  generationJobs: GalleryGenerationJob[],
): CachedMeta[] {
  const recoverableFighterIds = new Set(
    generationJobs.filter(keepsIncompleteFighterVisible).map((job) => job.fighterId),
  );
  return visibleGalleryMetas(
    metas.filter((item) => item.version === CACHE_VERSION && (
      item.status === 'ready' || (
        Boolean(item.cloudFighterId) && recoverableFighterIds.has(item.cloudFighterId as string)
      )
    )),
    arcadeFighters,
  );
}
