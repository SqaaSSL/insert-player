import { getActiveSpriteCacheScope, getCachedMeta, getAllSpritesForHash } from '../../services/SpriteCache.ts';
import { resolveFighterModeReadiness } from '../../services/FighterAssetPacks.ts';
import type { MatchSceneData } from '../../game/match/MatchConfig.ts';

/** Recipient-owned choice only. Never called to resolve a sender identity, and
 * never serialized into a challenge token. No network or generation requests. */
export async function withPreferredAuraChallengePlayer(data: MatchSceneData, photoHash?: string | null): Promise<MatchSceneData> {
  if (!photoHash) return data;
  if (photoHash.length > 160) throw new Error('Your player could not be selected.');
  const ownerScope = getActiveSpriteCacheScope();
  const [meta, sprites] = await Promise.all([
    getCachedMeta(photoHash, ownerScope), getAllSpritesForHash(photoHash, ownerScope),
  ]);
  if (ownerScope !== getActiveSpriteCacheScope() || !meta
    || resolveFighterModeReadiness(sprites, 'aura', meta).kind === 'unavailable') {
    throw new Error('Your player is not ready on this device. Try again or use a ready performer.');
  }
  const selection = data.auraChallenge?.slot === 1
    ? { p2PhotoHash: meta.photoHash, p2CloudFighterId: meta.cloudFighterId ?? null, p2Name: meta.characterName || 'Player Two' }
    : { p1PhotoHash: meta.photoHash, p1CloudFighterId: meta.cloudFighterId ?? null, p1Name: meta.characterName || 'Player One' };
  return { ...data, ...selection };
}
