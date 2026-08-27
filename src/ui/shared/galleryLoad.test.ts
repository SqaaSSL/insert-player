import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CachedStageBackground } from '../../services/SpriteCache.ts';
import { loadGalleryCacheSnapshot } from './galleryLoad.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('Gallery cache loading', () => {
  it('keeps the successful cache half when the other half fails', async () => {
    const stages = [{ stageKey: 'stage-1' }] as CachedStageBackground[];
    const snapshot = await loadGalleryCacheSnapshot(
      () => Promise.reject(new Error('IndexedDB unavailable')),
      () => Promise.resolve(stages),
    );

    expect(snapshot).toMatchObject({
      metas: [],
      stages,
      metasAvailable: false,
      stagesAvailable: true,
    });
    expect(snapshot.metasError).toBeInstanceOf(Error);
    expect(snapshot.stagesError).toBeNull();
  });

  it('bounds a hung cache read so public and cloud state can continue', async () => {
    vi.useFakeTimers();
    const snapshotPromise = loadGalleryCacheSnapshot(
      () => new Promise(() => {}),
      () => Promise.resolve([]),
      50,
    );

    await vi.advanceTimersByTimeAsync(50);
    const snapshot = await snapshotPromise;

    expect(snapshot.metasAvailable).toBe(false);
    expect(snapshot.stagesAvailable).toBe(true);
    expect(snapshot.metasError).toEqual(expect.objectContaining({
      message: 'Local fighter storage timed out',
    }));
  });
});
