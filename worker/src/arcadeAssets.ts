import type { Env } from './types';

const PLAYABLE_ANIMATION_NAMES = [
  'idle',
  'walk',
  'high_punch',
  'low_punch',
  'high_kick',
  'low_kick',
  'jump',
  'crouch',
  'hit',
  'ko',
  'victory',
] as const;

interface ArcadeSourcePointers {
  original_blob_key: string | null;
  side_view_blob_key: string | null;
  side_view_raw_blob_key: string | null;
  upright_view_blob_key: string | null;
  upright_view_raw_blob_key: string | null;
  crouch_view_blob_key: string | null;
  crouch_view_raw_blob_key: string | null;
}

interface ArcadeSpritePointers {
  animation_name: string;
  blob_key: string;
  raw_blob_key: string | null;
}

export interface ArcadeAssetIntegrity {
  ready: boolean;
  animationCount: number;
  missingAssets: string[];
}

export async function inspectArcadeAssetIntegrity(
  env: Env,
  fighterId: string,
): Promise<ArcadeAssetIntegrity> {
  const fighter = await env.DB.prepare(`
    SELECT
      original_blob_key,
      side_view_blob_key,
      side_view_raw_blob_key,
      upright_view_blob_key,
      upright_view_raw_blob_key,
      crouch_view_blob_key,
      crouch_view_raw_blob_key
    FROM fighters
    WHERE id = ?
    LIMIT 1
  `).bind(fighterId).first<ArcadeSourcePointers>();

  if (!fighter) {
    return { ready: false, animationCount: 0, missingAssets: ['fighter'] };
  }

  const sourcePointers = [
    ['source:original', fighter.original_blob_key],
    ['source:side', fighter.side_view_blob_key],
    ['source:side:raw', fighter.side_view_raw_blob_key],
    ['source:upright', fighter.upright_view_blob_key],
    ['source:upright:raw', fighter.upright_view_raw_blob_key],
    ['source:crouch', fighter.crouch_view_blob_key],
    ['source:crouch:raw', fighter.crouch_view_raw_blob_key],
  ] as const;

  const placeholders = PLAYABLE_ANIMATION_NAMES.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`
    SELECT animation_name, blob_key, raw_blob_key
    FROM sprites
    WHERE fighter_id = ?
      AND quality_tier = 'champion'
      AND animation_name IN (${placeholders})
  `).bind(fighterId, ...PLAYABLE_ANIMATION_NAMES).all<ArcadeSpritePointers>();
  const sprites = new Map((results ?? []).map((sprite) => [sprite.animation_name, sprite]));

  const missingAssets: string[] = [];
  const objectPointers: Array<{ label: string; key: string }> = [];
  for (const [label, key] of sourcePointers) {
    if (!key) missingAssets.push(label);
    else objectPointers.push({ label, key });
  }

  for (const animationName of PLAYABLE_ANIMATION_NAMES) {
    const sprite = sprites.get(animationName);
    if (!sprite) {
      missingAssets.push(`sprite:${animationName}`);
      continue;
    }
    if (!sprite.blob_key) missingAssets.push(`sprite:${animationName}`);
    else objectPointers.push({ label: `sprite:${animationName}`, key: sprite.blob_key });
    if (!sprite.raw_blob_key) missingAssets.push(`sprite:${animationName}:raw`);
    else objectPointers.push({ label: `sprite:${animationName}:raw`, key: sprite.raw_blob_key });
  }

  const objectResults = await Promise.all(objectPointers.map(async ({ label, key }) => ({
    label,
    exists: Boolean(await env.SPRITES.head(key)),
  })));
  for (const result of objectResults) {
    if (!result.exists) missingAssets.push(result.label);
  }

  return {
    ready: missingAssets.length === 0,
    animationCount: sprites.size,
    missingAssets,
  };
}
