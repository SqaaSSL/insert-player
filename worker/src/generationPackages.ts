import { generationPackageAnimationNames, parseGenerationPackage, quoteGenerationPackage, type GenerationPackage } from '../../src/services/GenerationPackages';
import type { Env, QualityTier } from './types';

export interface StoredGenerationPackage {
  creation_package?: GenerationPackage;
  expansion_only?: number;
  animation_plan_json?: string | null;
}

/** The authorization owns the immutable plan. Never derive it from client job parameters. */
export function storedGenerationAnimationNames(value: StoredGenerationPackage): readonly string[] {
  const pack = parseGenerationPackage(value.creation_package);
  if (!pack) throw new Error('Invalid generation package');
  const allowed = generationPackageAnimationNames(pack);
  if (!value.animation_plan_json) {
    if (value.expansion_only) throw new Error('Expansion requires an immutable animation plan');
    return allowed;
  }
  const plan: unknown = JSON.parse(value.animation_plan_json);
  if (!Array.isArray(plan) || plan.length === 0 || new Set(plan).size !== plan.length ||
      plan.some((name) => typeof name !== 'string' || !allowed.includes(name))) {
    throw new Error('Invalid authorized animation plan');
  }
  if (!value.expansion_only && plan.length !== allowed.length) throw new Error('Incomplete generation package authorization');
  return plan;
}

/** Only owned, usable, same-or-better-quality immutable assets reduce an expansion. */
export async function quoteOwnedPackageExpansion(env: Env, userId: string, fighterId: string, tier: QualityTier, pack: GenerationPackage) {
  const { results } = await env.DB.prepare(`
    SELECT s.animation_name, s.quality_tier, s.blob_key, s.raw_blob_key
    FROM sprites s JOIN fighters f ON f.id = s.fighter_id
    WHERE f.id = ? AND f.owner_user_id = ? AND s.frame_w > 0 AND s.frame_h > 0 AND s.frame_count > 0
      AND s.content_hash IS NOT NULL AND s.raw_blob_key IS NOT NULL
  `).bind(fighterId, userId).all<{ animation_name: string; quality_tier: QualityTier; blob_key: string; raw_blob_key: string }>();
  const rank = { rookie: 1, contender: 2, champion: 3 };
  const available: string[] = [];
  for (const sprite of results ?? []) {
    if (rank[sprite.quality_tier] < rank[tier]) continue;
    if (await env.SPRITES.head(sprite.blob_key) && await env.SPRITES.head(sprite.raw_blob_key)) available.push(sprite.animation_name);
  }
  return quoteGenerationPackage(tier, pack, { expansion: true, existingAnimations: available });
}
