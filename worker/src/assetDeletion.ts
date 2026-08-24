import type { Env } from './types';

const DELETE_BATCH_SIZE = 1_000;
const MAX_ERROR_LENGTH = 500;

interface PendingAssetDeletionRow {
  id: string;
  blob_key: string;
}

export interface AssetDeletionDrainResult {
  deleted: number;
  pending: number;
}

function errorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.slice(0, MAX_ERROR_LENGTH);
}

export async function listFighterAssetKeys(
  env: Env,
  ownerUserId: string,
  fighterId: string,
): Promise<string[]> {
  const prefix = `users/${ownerUserId}/fighters/${fighterId}/`;
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.SPRITES.list({ prefix, cursor, limit: DELETE_BATCH_SIZE });
    keys.push(...page.objects.map((object) => object.key));
    if (!page.truncated) break;
    if (!page.cursor || page.cursor === cursor) {
      throw new Error('R2 fighter asset listing did not return a usable continuation cursor');
    }
    cursor = page.cursor;
  } while (true);
  return keys;
}

export async function drainFighterAssetDeletions(
  env: Env,
  options: { fighterId?: string; maxBatches?: number } = {},
): Promise<AssetDeletionDrainResult> {
  const maxBatches = Math.max(1, options.maxBatches ?? 5);
  let deleted = 0;
  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
    const query = options.fighterId
      ? `SELECT id, blob_key FROM fighter_asset_deletions
         WHERE fighter_id = ? ORDER BY created_at ASC LIMIT ?`
      : `SELECT id, blob_key FROM fighter_asset_deletions
         ORDER BY created_at ASC LIMIT ?`;
    const statement = env.DB.prepare(query);
    const { results } = options.fighterId
      ? await statement.bind(options.fighterId, DELETE_BATCH_SIZE).all<PendingAssetDeletionRow>()
      : await statement.bind(DELETE_BATCH_SIZE).all<PendingAssetDeletionRow>();
    const rows = results ?? [];
    if (rows.length === 0) return { deleted, pending: 0 };

    const ids = JSON.stringify(rows.map((row) => row.id));
    try {
      await env.SPRITES.delete(rows.map((row) => row.blob_key));
    } catch (error) {
      await env.DB.prepare(`
        UPDATE fighter_asset_deletions
        SET attempt_count = attempt_count + 1,
            last_error = ?,
            updated_at = datetime('now')
        WHERE id IN (SELECT value FROM json_each(?))
      `).bind(errorDetail(error), ids).run();
      return { deleted, pending: rows.length };
    }

    await env.DB.prepare(`
      DELETE FROM fighter_asset_deletions
      WHERE id IN (SELECT value FROM json_each(?))
    `).bind(ids).run();
    deleted += rows.length;
    if (rows.length < DELETE_BATCH_SIZE) return { deleted, pending: 0 };
  }

  const remaining = options.fighterId
    ? await env.DB.prepare(`
        SELECT COUNT(*) AS count FROM fighter_asset_deletions WHERE fighter_id = ?
      `).bind(options.fighterId).first<{ count: number }>()
    : await env.DB.prepare(`SELECT COUNT(*) AS count FROM fighter_asset_deletions`)
        .first<{ count: number }>();
  return { deleted, pending: Number(remaining?.count ?? 0) };
}
