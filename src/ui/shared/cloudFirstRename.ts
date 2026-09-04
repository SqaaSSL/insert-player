interface CloudFirstRenameTarget {
  photoHash: string;
  cloudFighterId?: string | null;
}

interface CloudFirstRenameDependencies {
  renameCloud: (fighterId: string, name: string) => Promise<unknown | null>;
  renameCache: (photoHash: string, name: string) => Promise<unknown | null>;
}

export class CloudFirstRenameCacheError extends Error {
  readonly cloudRenamed = true;

  constructor(cause: unknown) {
    super('The cloud name was updated, but the local preview cache could not be renamed.', { cause });
    this.name = 'CloudFirstRenameCacheError';
  }
}

export async function renameFighterCloudFirst(
  fighter: CloudFirstRenameTarget,
  name: string,
  dependencies: CloudFirstRenameDependencies,
): Promise<{ cloudRenamed: boolean }> {
  if (fighter.cloudFighterId) {
    const updated = await dependencies.renameCloud(fighter.cloudFighterId, name);
    if (!updated) {
      throw new Error('The cloud rename could not be confirmed. Your fighter name was not changed.');
    }
  }

  try {
    await dependencies.renameCache(fighter.photoHash, name);
  } catch (error) {
    if (fighter.cloudFighterId) throw new CloudFirstRenameCacheError(error);
    throw error;
  }
  return { cloudRenamed: Boolean(fighter.cloudFighterId) };
}
