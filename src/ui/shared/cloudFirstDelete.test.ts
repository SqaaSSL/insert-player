import { describe, expect, it, vi } from 'vitest';
import { deleteFighterCacheAfterCloudConfirmation } from './cloudFirstDelete.ts';

describe('deleteFighterCacheAfterCloudConfirmation', () => {
  it('deletes an unsynced fighter directly from the local cache', async () => {
    const deleteCache = vi.fn().mockResolvedValue(undefined);
    await deleteFighterCacheAfterCloudConfirmation('local-hash', null, deleteCache);
    expect(deleteCache).toHaveBeenCalledWith('local-hash');
  });

  it('deletes the local cache only after cloud deletion was confirmed', async () => {
    const deleteCache = vi.fn().mockResolvedValue(undefined);
    await deleteFighterCacheAfterCloudConfirmation(
      'synced-hash',
      { status: 'synced', fighterId: 'cloud-id' },
      deleteCache,
    );
    expect(deleteCache).toHaveBeenCalledWith('synced-hash');
  });

  it.each([
    { status: 'signed_out' as const, message: 'Sign in before deleting.' },
    { status: 'failed' as const, message: 'Cloud unavailable.', retryable: true },
  ])('preserves IndexedDB when cloud deletion returns $status', async (cloudDelete) => {
    const deleteCache = vi.fn();
    await expect(deleteFighterCacheAfterCloudConfirmation(
      'preserved-hash',
      cloudDelete,
      deleteCache,
    )).rejects.toThrow(cloudDelete.message);
    expect(deleteCache).not.toHaveBeenCalled();
  });
});
