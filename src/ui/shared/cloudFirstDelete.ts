import type { CloudSyncResult } from '../../services/CloudFighters.ts';

export async function deleteFighterCacheAfterCloudConfirmation(
  photoHash: string,
  cloudDelete: CloudSyncResult | null,
  deleteCache: (photoHash: string) => Promise<unknown>,
): Promise<void> {
  if (cloudDelete && cloudDelete.status !== 'synced') {
    throw new Error(
      cloudDelete.message ?? 'Cloud delete could not be confirmed. The local fighter was preserved.',
    );
  }
  await deleteCache(photoHash);
}
