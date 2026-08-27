import { describe, expect, it } from 'vitest';
import type { CloudFighter } from '../../services/CloudFighters.ts';
import {
  markOwnedCommunityFighters,
  resolveFeaturedCommunityFighter,
} from './communityState.ts';

function fighter(id: string): CloudFighter {
  return {
    id,
    name: `Fighter ${id}`,
    qualityTier: 'rookie',
    public: true,
    sources: {},
    sprites: [],
  };
}

describe('community route state', () => {
  it('never substitutes the first fighter for an invalid shared id', () => {
    const fighters = markOwnedCommunityFighters([fighter('one'), fighter('two')], new Set());
    expect(resolveFeaturedCommunityFighter(fighters, 'missing')).toBeNull();
    expect(resolveFeaturedCommunityFighter(fighters, null)?.id).toBe('one');
  });

  it('marks ownership using private roster ids without exposing owner identity', () => {
    const fighters = markOwnedCommunityFighters(
      [fighter('owned'), fighter('public')],
      new Set(['owned']),
    );
    expect(fighters.map(({ id, isOwned }) => ({ id, isOwned }))).toEqual([
      { id: 'owned', isOwned: true },
      { id: 'public', isOwned: false },
    ]);
  });
});
