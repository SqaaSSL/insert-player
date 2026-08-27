import type { CloudFighter } from '../../services/CloudFighters.ts';
import { CACHE_VERSION, type CachedMeta } from '../../services/SpriteCache.ts';
import type { GenerationJob } from '../../services/GenerationJobs.ts';
import { visibleGalleryMetas } from './arcadeRosterIdentity.ts';
import { findCachedArcadeMeta } from './galleryArcadeRoster.ts';
import { isArcadeCachedMeta } from './fighterPreview.ts';
import {
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
  if (job.operation !== 'fighter_generation') return false;
  return job.status === 'queued' || job.status === 'running' ||
    isVideoReviewOrRestartJob(job) || (
      (job.status === 'failed' || job.status === 'cancelled') && job.resumable
    );
}

/**
 * Applies the one Gallery visibility contract used by initial load and refreshes.
 * Incomplete cached fighters remain discoverable only while a durable job still
 * has an action the user can monitor, review, restart, or resume. When Arcade's
 * response is authoritative, cached globals absent by both id and slug are
 * removed instead of surviving as unselectable ghosts.
 */
export function visibleGalleryMetasForJobs(
  metas: CachedMeta[],
  arcadeFighters: CloudFighter[],
  generationJobs: GalleryGenerationJob[],
  arcadeRosterAuthoritative = true,
): CachedMeta[] {
  const recoverableFighterIds = new Set(
    generationJobs.filter(keepsIncompleteFighterVisible).map((job) => job.fighterId),
  );
  const visible = visibleGalleryMetas(
    metas.filter((item) => item.version === CACHE_VERSION && (
      item.status === 'ready' || (
        Boolean(item.cloudFighterId) && recoverableFighterIds.has(item.cloudFighterId as string)
      )
    )),
    arcadeFighters,
  );
  if (!arcadeRosterAuthoritative) return visible;

  const representedArcadeHashes = new Set(
    arcadeFighters
      .map((fighter) => findCachedArcadeMeta(visible, fighter)?.photoHash ?? null)
      .filter((photoHash): photoHash is string => photoHash !== null),
  );
  return visible.filter((meta) => (
    !isArcadeCachedMeta(meta) || representedArcadeHashes.has(meta.photoHash)
  ));
}
