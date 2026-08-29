import { describe, expect, it } from 'vitest';
import type { CloudFighter } from '../../services/CloudFighters.ts';
import type { CachedMeta } from '../../services/SpriteCache.ts';
import { buildRosterFighterSections } from './RosterPage.tsx';

function fighter(id: string, slug: string, name: string): CloudFighter {
  return {
    id,
    name,
    qualityTier: 'champion',
    public: true,
    sources: {},
    sprites: [],
    arcade: {
      slug,
      rank: 1,
      challengerLine: 'Ready to fight',
      defaultPersonality: 'balanced',
      reference: {
        kind: 'generated',
        sourceUrl: null,
        license: 'Internal',
        credit: 'Insert Player',
      },
    },
  };
}

function meta(photoHash: string, cloudFighterId: string | null, name = photoHash): CachedMeta {
  return {
    photoHash,
    cloudFighterId,
    version: 1,
    originalPhotoBlob: null,
    sideViewBlob: null,
    sideViewRawBlob: null,
    uprightViewBlob: null,
    uprightViewRawBlob: null,
    sideViewCleanBlob: null,
    crouchViewBlob: null,
    crouchViewRawBlob: null,
    crouchViewCleanBlob: null,
    noBgBlob: null,
    characterName: name,
    qualityTier: 'champion',
    status: 'ready',
    animationsReady: ['idle'],
    createdAt: 1,
    updatedAt: 1,
  };
}

const globals = [
  fighter('trump-id', 'donald-trump', 'Donald Trump'),
  fighter('elon-id', 'elon-musk', 'Elon Musk'),
  fighter('rosalia-v2-id', 'rosalia-v2', 'Rosalía'),
  fighter('lamine-id', 'lamine-yamal', 'Lamine Yamal'),
];

describe('RosterPage fighter sections', () => {
  it('shows four globals once and counts only the genuine personal fighter as yours', () => {
    const privateBackingRows = globals.map((item) => (
      meta(`private-${item.id}`, item.id, `${item.name} private seed`)
    ));
    const publicCaches = globals.map((item) => (
      meta(`arcade:${item.arcade?.slug}:${item.id}`, item.id, item.name)
    ));
    const personal = meta('personal-photo', 'personal-id', 'Local Hero');

    const sections = buildRosterFighterSections(
      [...privateBackingRows, ...publicCaches, personal],
      globals,
    );

    expect(sections.official).toHaveLength(4);
    expect(sections.owned).toHaveLength(1);
    expect(sections.owned[0]?.name).toBe('Local Hero');
    expect(sections.all).toHaveLength(5);
    expect(sections.all.filter((entry) => entry.name === 'Elon Musk')).toHaveLength(1);
  });

  it('keeps one read-only official fallback offline and hides its private duplicate', () => {
    const current = meta('arcade:elon-musk:elon-id', 'elon-id', 'Elon Musk');
    const legacy = meta('arcade:elon-musk', 'elon-id', 'Old Elon cache');
    const privateBacking = meta('private-elon-photo', 'elon-id', 'Editable Elon seed');
    const sections = buildRosterFighterSections([legacy, privateBacking, current], [], true);

    expect(sections.official).toHaveLength(1);
    expect(sections.official[0]).toMatchObject({
      kind: 'arcade',
      name: 'Elon Musk',
      photoHash: current.photoHash,
    });
    expect(sections.owned).toEqual([]);
    expect(sections.all).toHaveLength(1);
  });

  it('does not revive a stale cached global after a successful empty roster response', () => {
    const staleGlobal = meta('arcade:retired-fighter:retired-id', 'retired-id', 'Retired Fighter');
    const stalePrivateBacking = meta('private-retired-photo', 'retired-id', 'Retired private seed');
    const sections = buildRosterFighterSections([staleGlobal, stalePrivateBacking], []);

    expect(sections.official).toEqual([]);
    expect(sections.owned).toEqual([]);
    expect(sections.all).toEqual([]);
  });
});
