import { describe, expect, it, vi } from 'vitest';
import {
  CloudFirstRenameCacheError,
  renameFighterCloudFirst,
} from './cloudFirstRename.ts';

describe('renameFighterCloudFirst', () => {
  it('updates the source of truth before the browser cache', async () => {
    const order: string[] = [];
    await renameFighterCloudFirst({ photoHash: 'hash', cloudFighterId: 'cloud-id' }, 'Nova', {
      renameCloud: vi.fn(async () => { order.push('cloud'); return { id: 'cloud-id' }; }),
      renameCache: vi.fn(async () => { order.push('cache'); return {}; }),
    });

    expect(order).toEqual(['cloud', 'cache']);
  });

  it('does not mutate the cache when the cloud update is unavailable', async () => {
    const renameCache = vi.fn();
    await expect(renameFighterCloudFirst(
      { photoHash: 'hash', cloudFighterId: 'cloud-id' },
      'Nova',
      { renameCloud: vi.fn().mockResolvedValue(null), renameCache },
    )).rejects.toThrow('cloud rename could not be confirmed');
    expect(renameCache).not.toHaveBeenCalled();
  });

  it('still renames an unsynced fighter in the cache', async () => {
    const renameCloud = vi.fn();
    const renameCache = vi.fn().mockResolvedValue({});
    await renameFighterCloudFirst({ photoHash: 'hash' }, 'Nova', { renameCloud, renameCache });
    expect(renameCloud).not.toHaveBeenCalled();
    expect(renameCache).toHaveBeenCalledWith('hash', 'Nova');
  });

  it('reports when the cloud changed but the preview cache did not', async () => {
    await expect(renameFighterCloudFirst(
      { photoHash: 'hash', cloudFighterId: 'cloud-id' },
      'Nova',
      {
        renameCloud: vi.fn().mockResolvedValue({ id: 'cloud-id' }),
        renameCache: vi.fn().mockRejectedValue(new Error('IndexedDB unavailable')),
      },
    )).rejects.toBeInstanceOf(CloudFirstRenameCacheError);
  });
});
