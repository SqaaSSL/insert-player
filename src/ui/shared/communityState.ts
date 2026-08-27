import type { CloudFighter } from '../../services/CloudFighters.ts';

export interface CommunityFighterView extends CloudFighter {
  isOwned: boolean;
}

export function markOwnedCommunityFighters(
  fighters: CloudFighter[],
  ownedFighterIds: ReadonlySet<string>,
): CommunityFighterView[] {
  return fighters.map((fighter) => ({
    ...fighter,
    isOwned: ownedFighterIds.has(fighter.id),
  }));
}

export function resolveFeaturedCommunityFighter(
  fighters: CommunityFighterView[],
  featuredId: string | null,
): CommunityFighterView | null {
  if (featuredId) return fighters.find((fighter) => fighter.id === featuredId) ?? null;
  return fighters[0] ?? null;
}
