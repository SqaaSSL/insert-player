import { useEffect, useState } from 'react';
import { getCachedMeta } from '../../services/SpriteCache.ts';
import { useObjectUrl } from './useObjectUrl.ts';

/** Resolves a fighter's cached portrait blob (clean side view preferred,
 * falling back to raw side, upright, then the original photo) into an
 * object URL for DOM fight chrome. */
export function useFighterPortrait(photoHash: string | null): string | null {
  const [blob, setBlob] = useState<Blob | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBlob(null);
    if (!photoHash) return;
    void getCachedMeta(photoHash)
      .then((meta) => {
        if (cancelled || !meta) return;
        setBlob(
          meta.sideViewCleanBlob ??
            meta.sideViewBlob ??
            meta.uprightViewBlob ??
            meta.originalPhotoBlob ??
            null,
        );
      })
      .catch(() => {
        /* portraits are decorative; missing cache entries render initials */
      });
    return () => {
      cancelled = true;
    };
  }, [photoHash]);

  return useObjectUrl(blob);
}
