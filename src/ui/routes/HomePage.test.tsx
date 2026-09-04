import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HomePage } from './HomePage.tsx';

const callbacks = {
  onCreateFighter: vi.fn(),
  onCreateStage: vi.fn(),
  onOpenArcade: vi.fn(),
  onOpenCoopRush: vi.fn(),
  onNavigateLegal: vi.fn(),
  onOpenGallery: vi.fn(),
  onOpenCommunity: vi.fn(),
  onOpenWatchMode: vi.fn(),
  onOpenVsCpu: vi.fn(),
  onOpenVsPlayer: vi.fn(),
  onOpenOnlineVersus: vi.fn(),
  onOpenModeration: vi.fn(),
};

describe('HomePage game modes', () => {
  it('presents Fight and Rush as sibling games backed by one roster', () => {
    const markup = renderToStaticMarkup(
      <HomePage authStatus="local" authSessionKey="local" {...callbacks} />,
    );

    expect(markup).toContain('Choose Game');
    expect(markup).toContain('Same fighters, same cabinet');
    expect(markup).toContain('Core game');
    expect(markup).toContain('Early access');
    expect(markup).toContain('Play Fight');
    expect(markup).toContain('Play Rush Beta');
    expect(markup).toContain('Stage Scout');
    expect(markup).toContain('home-mode__launch--fight');
    expect(markup).toContain('home-mode__launch--rush');
    expect(markup.match(/home-mode__footer/g)).toHaveLength(2);
    expect(markup).toContain('Player + CPU');
    expect(markup).toContain('Your fighters work in Fight and Rush');
    expect(markup).not.toContain('Co-op Rush');
  });
});
