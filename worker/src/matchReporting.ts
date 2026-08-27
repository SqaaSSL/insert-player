import type { Env } from './types';

const MAX_MATCH_ID_LENGTH = 128;

function readOptionalMatchId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_MATCH_ID_LENGTH) return undefined;
  return /^[a-z0-9:_-]+$/i.test(trimmed) ? trimmed : undefined;
}

/**
 * Match history may reference either one of the caller's fighters or an
 * official Arcade challenger that is both published and currently active.
 * Public community fighters owned by somebody else are intentionally not
 * accepted here.
 */
export async function readMatchFighterId(
  env: Env,
  userId: string,
  value: unknown,
): Promise<string | undefined> {
  const fighterId = readOptionalMatchId(value);
  if (!fighterId) return undefined;

  const fighter = await env.DB.prepare(`
    SELECT f.id
    FROM fighters f
    LEFT JOIN arcade_fighters arcade ON arcade.fighter_id = f.id
    WHERE f.id = ?
      AND (
        f.owner_user_id = ?
        OR (f.public_flag = 1 AND arcade.status = 'active')
      )
    LIMIT 1
  `).bind(fighterId, userId).first<{ id: string }>();

  return fighter?.id;
}

export function isAttractModeMatchReport(body: Record<string, unknown>): boolean {
  return body.cpuVsCpu === true;
}
