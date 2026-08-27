import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CloudFighter, CloudSprite } from '../../services/CloudFighters.ts';
import { arcadeFighterPhotoHash } from '../../services/CloudFighters.ts';
import type { CachedMeta } from '../../services/SpriteCache.ts';
import {
  buildGalleryFighterSections,
  GalleryFighterList,
} from './GalleryFighterList.tsx';

function cloudSprite(animationName: string): CloudSprite {
  return {
    animationName,
    qualityTier: 'champion',
    url: `https://example.com/${animationName}.png`,
    rawUrl: null,
    frameWidth: 192,
    frameHeight: 256,
    frameCount: 4,
    processingVersion: 1,
  };
}

function arcadeFighter(id: string, slug: string, name: string, animations = ['idle']): CloudFighter {
  return {
    id,
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
    name,
    qualityTier: 'champion',
    public: true,
    sources: {},
    sprites: animations.map(cloudSprite),
  };
}

function cachedMeta(photoHash: string, characterName: string): CachedMeta {
  return {
    photoHash,
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
    characterName,
    qualityTier: 'champion',
    status: 'ready',
    animationsReady: ['idle', 'walk'],
    createdAt: Date.UTC(2026, 7, 27),
    updatedAt: Date.UTC(2026, 7, 27),
  };
}

const globals = [
  arcadeFighter('trump-id', 'donald-trump', 'Donald Trump', ['idle', 'idle', 'walk']),
  arcadeFighter('elon-id', 'elon-musk', 'Elon Musk', ['idle', 'walk', 'victory']),
  arcadeFighter('rosalia-id', 'rosalia', 'Rosalía', ['idle', 'victory']),
  arcadeFighter('lamine-id', 'lamine-yamal', 'Lamine Yamal', ['idle', 'high_kick']),
];

describe('GalleryFighterList', () => {
  it('renders all four remote globals once even when only Trump is cached', () => {
    const trumpMeta = cachedMeta(arcadeFighterPhotoHash(globals[0]), 'Donald Trump');
    const ownedMeta = cachedMeta('owned-photo-hash', 'Local Hero');
    const sections = buildGalleryFighterSections([trumpMeta, ownedMeta], globals);

    expect(sections.globals).toHaveLength(4);
    expect(sections.globals[0]).toMatchObject({
      photoHash: 'arcade:donald-trump:trump-id',
      cachedMeta: trumpMeta,
    });
    expect(sections.owned).toEqual([ownedMeta]);

    const markup = renderToStaticMarkup(
      <GalleryFighterList
        metas={[trumpMeta, ownedMeta]}
        arcadeFighters={globals}
        selectedPhotoHash={trumpMeta.photoHash}
        loadingArcadeId={null}
        onSelectMeta={vi.fn()}
        onSelectArcade={vi.fn()}
        arcadeState="ready"
      />,
    );

    expect(markup).toContain('aria-label="4 global fighters"');
    expect(markup).toContain('Donald Trump');
    expect(markup).toContain('Elon Musk');
    expect(markup).toContain('Rosalía');
    expect(markup).toContain('Lamine Yamal');
    expect(markup.match(/Donald Trump/g)).toHaveLength(1);
    expect(markup).toContain('Champion · 2 anims · Ready locally');
    expect(markup.match(/Load on select/g)).toHaveLength(3);
  });

  it('keeps owned fighters in a separate counted group and excludes cached globals', () => {
    const trumpMeta = cachedMeta(arcadeFighterPhotoHash(globals[0]), 'Donald Trump cached copy');
    const ownedMeta = cachedMeta('owned-photo-hash', 'Local Hero');
    const markup = renderToStaticMarkup(
      <GalleryFighterList
        metas={[trumpMeta, ownedMeta]}
        arcadeFighters={globals}
        selectedPhotoHash={ownedMeta.photoHash}
        loadingArcadeId={null}
        onSelectMeta={vi.fn()}
        onSelectArcade={vi.fn()}
        arcadeState="ready"
      />,
    );

    expect(markup.indexOf('Global roster')).toBeLessThan(markup.indexOf('Your fighters'));
    expect(markup).toContain('aria-label="1 owned fighter"');
    expect(markup).toContain('Local Hero');
    expect(markup).not.toContain('Donald Trump cached copy');
  });

  it('does not expose an official private backing row as an owned fighter', () => {
    const privateElon = {
      ...cachedMeta('private-elon-photo-hash', 'Editable Elon seed'),
      cloudFighterId: 'elon-id',
    };
    const ownedMeta = cachedMeta('owned-photo-hash', 'Local Hero');
    const sections = buildGalleryFighterSections([privateElon, ownedMeta], globals);

    expect(sections.globals).toHaveLength(4);
    expect(sections.globals.find(({ fighter }) => fighter?.id === 'elon-id')?.cachedMeta).toBeNull();
    expect(sections.owned).toEqual([ownedMeta]);

    const markup = renderToStaticMarkup(
      <GalleryFighterList
        metas={[privateElon, ownedMeta]}
        arcadeFighters={globals}
        selectedPhotoHash={ownedMeta.photoHash}
        loadingArcadeId={null}
        onSelectMeta={vi.fn()}
        onSelectArcade={vi.fn()}
        arcadeState="ready"
      />,
    );

    expect(markup).not.toContain('Editable Elon seed');
    expect(markup).toContain('aria-label="1 owned fighter"');
  });

  it('matches legacy arcade cache keys without duplicating them as personal fighters', () => {
    const legacyElon = cachedMeta('arcade:elon-musk', 'Legacy Elon cache');
    const sections = buildGalleryFighterSections([legacyElon], globals);

    expect(sections.globals).toHaveLength(4);
    expect(sections.globals.find(({ fighter }) => fighter?.id === 'elon-id')?.cachedMeta).toBe(legacyElon);
    expect(sections.owned).toEqual([]);
  });

  it('announces loading and unavailable global-roster states honestly', () => {
    const loadingMarkup = renderToStaticMarkup(
      <GalleryFighterList
        metas={[]}
        arcadeFighters={[]}
        selectedPhotoHash={null}
        loadingArcadeId={null}
        onSelectMeta={vi.fn()}
        onSelectArcade={vi.fn()}
        arcadeState="loading"
      />,
    );
    const unavailableMarkup = renderToStaticMarkup(
      <GalleryFighterList
        metas={[]}
        arcadeFighters={[]}
        selectedPhotoHash={null}
        loadingArcadeId={null}
        onSelectMeta={vi.fn()}
        onSelectArcade={vi.fn()}
        arcadeState="unavailable"
      />,
    );

    expect(loadingMarkup).toContain('aria-busy="true"');
    expect(loadingMarkup).toContain('role="status">Loading global roster…</p>');
    expect(unavailableMarkup).toContain('role="alert">Global roster unavailable. Your fighters are still available.</p>');
  });

  it('keeps cached globals usable when the global-roster request is unavailable', () => {
    const savedTrump = cachedMeta('arcade:donald-trump:trump-id', 'Donald Trump');
    const markup = renderToStaticMarkup(
      <GalleryFighterList
        metas={[savedTrump]}
        arcadeFighters={[]}
        selectedPhotoHash={savedTrump.photoHash}
        loadingArcadeId={null}
        onSelectMeta={vi.fn()}
        onSelectArcade={vi.fn()}
        arcadeState="unavailable"
      />,
    );

    expect(markup).toContain('aria-label="1 global fighter"');
    expect(markup).toContain('Global roster unavailable. Showing saved globals.');
    expect(markup).toContain('Donald Trump');
    expect(markup).toContain('Champion · 2 anims · Saved offline');
    expect(markup).not.toContain('aria-label="1 owned fighter"');
  });

  it('deduplicates current and legacy cache keys while offline', () => {
    const current = cachedMeta('arcade:elon-musk:elon-id', 'Elon Musk');
    const legacy = cachedMeta('arcade:elon-musk', 'Old Elon cache');
    const sections = buildGalleryFighterSections([legacy, current], [], true);

    expect(sections.globals).toHaveLength(1);
    expect(sections.globals[0].cachedMeta).toBe(current);
    expect(sections.owned).toEqual([]);
  });

  it('marks the fighter being downloaded as loading and disables selection', () => {
    const markup = renderToStaticMarkup(
      <GalleryFighterList
        metas={[]}
        arcadeFighters={globals}
        selectedPhotoHash={null}
        loadingArcadeId="elon-id"
        onSelectMeta={vi.fn()}
        onSelectArcade={vi.fn()}
        arcadeState="ready"
      />,
    );

    expect(markup).toMatch(/<button[^>]+aria-busy="true"[^>]+disabled=""[^>]*>[^]*?Elon Musk[^]*?Loading…/);
  });
});
