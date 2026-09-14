import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HomePage } from './HomePage.tsx';

const callbacks = {
  onCreateFighter: vi.fn(),
  onCreateStage: vi.fn(),
  onOpenArcade: vi.fn(),
  onOpenCoopRush: vi.fn(),
  onOpenAuraCpu: vi.fn(),
  onOpenAuraPlayer: vi.fn(),
  onOpenAuraOnline: vi.fn(),
  onOpenAuraWatch: vi.fn(),
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
  it('shows the current Champion quote for a previously saved retired offer', () => {
    const markup = renderToStaticMarkup(
      <HomePage authStatus="signed-in" authSessionKey="account" walletOnly creationPurchaseIntent={{
        tier: 'champion', creationPackage: 'aura', returnTo: 'aura', source: 'landing', createdAt: Date.now(),
      }} {...callbacks} />,
    );
    expect(markup).toContain('Aura moves · Champion');
    expect(markup).toContain('6 credits required');
    expect(markup).not.toContain('10 credits required');
    expect(markup).not.toContain('Contender');
  });

  it('presents Fight, Rush, and Aura as sibling games backed by one roster', () => {
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
    expect(markup).toContain('Play Aura');
    expect(markup).toContain('home-mode__launch--fight');
    expect(markup).toContain('home-mode__launch--rush');
    expect(markup).toContain('home-mode__launch--aura');
    expect(markup.match(/home-mode__footer/g)).toHaveLength(3);
    expect(markup).toContain('Player + CPU');
    expect(markup).toContain('Combat moves for Fight and Rush; Aura moves for Aura');
    expect(markup).not.toContain('Co-op Rush');
  });
});
