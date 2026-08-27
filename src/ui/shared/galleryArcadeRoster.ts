import {
  arcadeFighterPhotoHash,
  type CloudFighter,
} from '../../services/CloudFighters.ts';
import type { CachedMeta } from '../../services/SpriteCache.ts';
import { isArcadeCachedMeta } from './fighterPreview.ts';

export function cachedArcadeSlug(photoHash: string): string | null {
  if (!photoHash.startsWith('arcade:')) return null;
  const slug = photoHash.slice('arcade:'.length).split(':', 1)[0]?.trim();
  return slug || null;
}

export function findCachedArcadeMeta(
  metas: CachedMeta[],
  fighter: CloudFighter,
): CachedMeta | null {
  const exactPhotoHash = arcadeFighterPhotoHash(fighter);
  const slug = fighter.arcade?.slug ?? null;
  const arcadeMetas = metas.filter(isArcadeCachedMeta);
  return arcadeMetas.find((meta) => meta.photoHash === exactPhotoHash)
    ?? arcadeMetas.find((meta) => meta.cloudFighterId === fighter.id)
    ?? arcadeMetas.find((meta) => slug !== null && cachedArcadeSlug(meta.photoHash) === slug)
    ?? null;
}

interface EnsureGalleryArcadeFighterDependencies {
  download: (fighter: CloudFighter) => Promise<unknown>;
  getMeta: (photoHash: string) => Promise<CachedMeta | null>;
}

export interface EnsuredGalleryArcadeFighter {
  meta: CachedMeta;
  photoHash: string;
}

export async function ensureGalleryArcadeFighterReady(
  fighter: CloudFighter,
  dependencies: EnsureGalleryArcadeFighterDependencies,
): Promise<EnsuredGalleryArcadeFighter> {
  const photoHash = arcadeFighterPhotoHash(fighter);
  await dependencies.download(fighter);
  const downloadedMeta = await dependencies.getMeta(photoHash);
  if (downloadedMeta?.status !== 'ready') {
    throw new Error('the playable assets did not finish downloading');
  }
  return {
    meta: downloadedMeta,
    photoHash,
  };
}
