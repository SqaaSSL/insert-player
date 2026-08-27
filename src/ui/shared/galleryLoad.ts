import type {
  CachedMeta,
  CachedStageBackground,
} from '../../services/SpriteCache.ts';

export const GALLERY_CACHE_READ_TIMEOUT_MS = 3_000;

export interface GalleryCacheSnapshot {
  metas: CachedMeta[];
  stages: CachedStageBackground[];
  metasAvailable: boolean;
  stagesAvailable: boolean;
  metasError: unknown | null;
  stagesError: unknown | null;
}

export async function withGalleryTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = GALLERY_CACHE_READ_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = globalThis.setTimeout(() => {
          reject(new Error(`${label} timed out`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== null) globalThis.clearTimeout(timeout);
  }
}

export async function loadGalleryCacheSnapshot(
  loadMetas: () => Promise<CachedMeta[]>,
  loadStages: () => Promise<CachedStageBackground[]>,
  timeoutMs = GALLERY_CACHE_READ_TIMEOUT_MS,
): Promise<GalleryCacheSnapshot> {
  const [metasResult, stagesResult] = await Promise.allSettled([
    withGalleryTimeout(Promise.resolve().then(loadMetas), 'Local fighter storage', timeoutMs),
    withGalleryTimeout(Promise.resolve().then(loadStages), 'Local stage storage', timeoutMs),
  ]);

  return {
    metas: metasResult.status === 'fulfilled' ? metasResult.value : [],
    stages: stagesResult.status === 'fulfilled' ? stagesResult.value : [],
    metasAvailable: metasResult.status === 'fulfilled',
    stagesAvailable: stagesResult.status === 'fulfilled',
    metasError: metasResult.status === 'rejected' ? metasResult.reason : null,
    stagesError: stagesResult.status === 'rejected' ? stagesResult.reason : null,
  };
}
