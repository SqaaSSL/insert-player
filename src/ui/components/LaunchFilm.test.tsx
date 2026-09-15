import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LaunchFilm, LAUNCH_FILM } from './LaunchFilm.tsx';
import { GameLandingPage } from '../pages/GameLandingPage.tsx';
import { PlayPage } from '../pages/PlayPage.tsx';

vi.mock('./AuraEntryPreview.tsx', () => ({ AuraEntryPreview: () => <div>Aura preview</div> }));
vi.mock('./CombatEntryPreview.tsx', () => ({ CombatEntryPreview: () => <div>Combat preview</div> }));

describe('three-game landing film', () => {
  it('offers native, captioned, user-initiated playback with no initial video download', () => {
    const html = renderToStaticMarkup(<LaunchFilm />);
    expect(html).toContain('preload="none"');
    expect(html).toContain('controls=""');
    expect(html).toContain('playsInline=""');
    expect(html).toContain('kind="captions"');
    expect(html).not.toMatch(/autoPlay|loop=|muted=/);
    expect(html).toContain(LAUNCH_FILM);
  });

  it.each(['aura', 'fight', 'rush'] as const)('places the film directly below the %s game selector', mode => {
    const html = renderToStaticMarkup(<GameLandingPage mode={mode} onPlay={vi.fn()} onCreate={vi.fn()}
      onExplore={vi.fn()} onOpenCharacters={vi.fn()} onOpenCredits={vi.fn()} />);
    expect(html).toContain(LAUNCH_FILM);
    expect(html.match(/launch-film-title"/g)).toHaveLength(2);
    expect(html.indexOf('product-entry__hero')).toBeLessThan(html.indexOf('product-entry__film'));
    expect(html).toMatch(/<nav class="product-entry__other-games"[\s\S]*?<\/nav><section class="product-entry__film"/);
  });

  it('places the same film below the game list on Play and returning-player home', () => {
    const html = renderToStaticMarkup(<PlayPage onPlay={vi.fn()} onExplore={vi.fn()}
      onOpenCharacters={vi.fn()} onOpenChallenges={vi.fn()} lastGame="aura" />);
    expect(html).toContain(LAUNCH_FILM);
    expect(html).toMatch(/<section class="product-entry__game-list"[\s\S]*?<\/section><section class="product-entry__film"/);
    expect(html.indexOf('product-entry__film')).toBeLessThan(html.indexOf('product-entry__collection'));
  });
});
