import { describe, expect, it } from 'vitest';
import type { CloudFighter } from '../../services/CloudFighters.ts';
import { AURA_ANIMATION_NAMES } from '../../services/FighterAssetPacks.ts';
import { PLAYABLE_ANIMATION_NAMES } from '../../services/PlayableFighterAssets.ts';
import { buildRosterFighterSections } from './RosterPage.tsx';
import { isShareableEntry, officialOnlineOpponent } from './OnlineVersusPage.tsx';

function official(id: string, slug: string, animations: readonly string[]): CloudFighter {
  return {
    id, name: slug, public: true, qualityTier: 'champion', sources: {},
    sprites: animations.map((animationName) => ({ animationName })) as CloudFighter['sprites'],
    arcade: { slug, rank: 1, challengerLine: '', defaultPersonality: 'balanced',
      reference: { kind: 'generated', sourceUrl: null, license: 'Internal', credit: 'Insert Player' } },
  };
}

describe('online Aura selection', () => {
  it('includes actual Aura packs without shrug and the reviewed official bundles, excluding Fight-only rivals', () => {
    const roster = buildRosterFighterSections([], [
      official('trump', 'donald-trump', PLAYABLE_ANIMATION_NAMES),
      official('lamine', 'lamine-yamal', PLAYABLE_ANIMATION_NAMES),
      official('rosalia', 'rosalia-v2', PLAYABLE_ANIMATION_NAMES),
      official('elon', 'elon-musk', PLAYABLE_ANIMATION_NAMES),
      official('performer', 'performer', AURA_ANIMATION_NAMES),
    ]).all;
    expect(roster.filter((entry) => isShareableEntry(entry, 'aura')).map((entry) => entry.cloudFighterId))
      .toEqual(['trump', 'lamine', 'rosalia', 'performer']);
    expect(roster.filter((entry) => isShareableEntry(entry, 'fight')).map((entry) => entry.cloudFighterId))
      .toEqual(['trump', 'lamine', 'rosalia', 'elon']);
  });

  it('uses only the independently loaded official identity for a room opponent', () => {
    const trump = official('trump', 'donald-trump', PLAYABLE_ANIMATION_NAMES);
    const roster = buildRosterFighterSections([], [trump]).all;
    const roomManifest = { ...trump, arcade: undefined, public: false };
    expect(officialOnlineOpponent(roomManifest, roster)).toBe(trump);
    expect(officialOnlineOpponent({ ...trump, id: 'private-copy' }, roster)).toBeNull();
    expect(officialOnlineOpponent(trump, [])).toBeNull();
  });
});
