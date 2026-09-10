import { useEffect, useState } from 'react';
import { getCachedMeta } from '../../services/SpriteCache.ts';

export type FighterPortraitPreference = 'fight' | 'upright';
type PortraitMeta = Pick<NonNullable<Awaited<ReturnType<typeof getCachedMeta>>>,
  'sideViewCleanBlob' | 'sideViewBlob' | 'uprightViewBlob' | 'originalPhotoBlob'>;

export function selectFighterPortrait(meta: PortraitMeta | null, preference: FighterPortraitPreference = 'fight'): Blob | null {
  if (!meta) return null;
  // Aura must not expose an original photo or silently substitute a side pose.
  if (preference === 'upright') return meta.uprightViewBlob ?? null;
  return meta.sideViewCleanBlob ?? meta.sideViewBlob ?? meta.uprightViewBlob ?? meta.originalPhotoBlob ?? null;
}

/** Resolves a fighter's cached portrait blob (clean side view preferred,
 * falling back to raw side, upright, then the original photo) into an
 * object URL for DOM fight chrome. */
export function useFighterPortrait(
  photoHash: string | null,
  refreshKey = 0,
  preference: FighterPortraitPreference = 'fight',
): string | null {
  const [portrait, setPortrait] = useState<{
    photoHash: string; refreshKey: number; preference: FighterPortraitPreference; url: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setPortrait(null);
    if (!photoHash) return;
    void getCachedMeta(photoHash)
      .then((meta) => {
        if (cancelled || !meta) return;
        const blob = selectFighterPortrait(meta, preference);
        objectUrl = blob ? URL.createObjectURL(blob) : null;
        setPortrait({ photoHash, refreshKey, preference, url: objectUrl });
      })
      .catch(() => {
        /* portraits are decorative; missing cache entries render initials */
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [photoHash, refreshKey, preference]);

  // Do not expose the old policy/hash's URL for even one render before effects.
  return portrait?.photoHash === photoHash && portrait?.refreshKey === refreshKey
    && portrait.preference === preference ? portrait.url : null;
}
