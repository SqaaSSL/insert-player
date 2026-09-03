import type { CloudFighter } from '../../services/CloudFighters.ts';
import { isTemplateOnlyFighterIdentity } from '../../services/PlayableFighterAssets.ts';
import type { CachedMeta } from '../../services/SpriteCache.ts';
import { isArcadeCachedMeta } from './fighterPreview.ts';

type RosterIdentityMeta = Pick<CachedMeta, 'photoHash' | 'cloudFighterId' | 'cloudManagement' | 'characterName'>;
type RosterIdentityFighter = Pick<CloudFighter, 'id'>;

/**
 * Arcade cache keys are intentionally public/sanitized. A matching cloud id
 * lets us also recognize an older private owner cache for the same fighter.
 */
export function arcadeRosterFighterIds(
  metas: RosterIdentityMeta[],
  arcadeFighters: RosterIdentityFighter[],
): Set<string> {
  const ids = new Set(arcadeFighters.map((fighter) => fighter.id));
  for (const meta of metas) {
    if (
      (isArcadeCachedMeta(meta) || meta.cloudManagement === 'arcade') &&
      meta.cloudFighterId
    ) {
      ids.add(meta.cloudFighterId);
    }
  }
  return ids;
}

export function isGlobalRosterMeta(
  meta: RosterIdentityMeta | null,
  arcadeFighterIds: ReadonlySet<string>,
): boolean {
  return Boolean(
    meta && (
      isArcadeCachedMeta(meta) || meta.cloudManagement === 'arcade' ||
      (meta.cloudFighterId && arcadeFighterIds.has(meta.cloudFighterId))
    )
  );
}

export interface MarkedArcadeManagedMetas {
  metas: CachedMeta[];
  changed: CachedMeta[];
}

export function markArcadeManagedMetas(
  metas: CachedMeta[],
  arcadeFighters: RosterIdentityFighter[],
): MarkedArcadeManagedMetas {
  const remoteIds = new Set(arcadeFighters.map((fighter) => fighter.id));
  const changed: CachedMeta[] = [];
  const marked = metas.map((meta) => {
    if (
      meta.cloudManagement === 'arcade' ||
      !meta.cloudFighterId ||
      !remoteIds.has(meta.cloudFighterId)
    ) {
      return meta;
    }
    const next = { ...meta, cloudManagement: 'arcade' as const };
    changed.push(next);
    return next;
  });
  return { metas: marked, changed };
}

export function ownedRosterMetas(
  metas: CachedMeta[],
  arcadeFighters: RosterIdentityFighter[],
): CachedMeta[] {
  const arcadeFighterIds = arcadeRosterFighterIds(metas, arcadeFighters);
  return metas.filter((meta) => (
    !isTemplateOnlyFighterIdentity({
      characterName: meta.characterName,
      photoHash: meta.photoHash,
    }) && !isGlobalRosterMeta(meta, arcadeFighterIds)
  ));
}

/**
 * Gallery keeps sanitized arcade:* caches for read-only previews, but removes
 * private owner caches that back the same official fighter.
 */
export function visibleGalleryMetas(
  metas: CachedMeta[],
  arcadeFighters: RosterIdentityFighter[],
): CachedMeta[] {
  const arcadeFighterIds = arcadeRosterFighterIds(metas, arcadeFighters);
  return metas.filter((meta) => (
    !isTemplateOnlyFighterIdentity({
      characterName: meta.characterName,
      photoHash: meta.photoHash,
    }) && (isArcadeCachedMeta(meta) || !isGlobalRosterMeta(meta, arcadeFighterIds))
  ));
}

export function galleryFighterIndexForSelection(
  metas: Array<Pick<CachedMeta, 'photoHash'>>,
  selectedPhotoHash: string | null,
  currentIndex: number,
): number {
  if (selectedPhotoHash) {
    const selectedIndex = metas.findIndex((meta) => meta.photoHash === selectedPhotoHash);
    if (selectedIndex >= 0) return selectedIndex;
  }
  return Math.min(currentIndex, Math.max(0, metas.length - 1));
}
