import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LandingPage } from './LandingPage.tsx';

const callbacks = {
  onPlayTrial: vi.fn(async () => {}),
  onCreateFighter: vi.fn(),
  onOpenArcade: vi.fn(),
  onOpenWatchMode: vi.fn(),
};

describe('LandingPage onboarding offer', () => {
  it('leads with the playable demo and explains the anonymous Rookie check', () => {
    const markup = renderToStaticMarkup(
      <LandingPage authStatus="signed-out" billingProfile={null} billingProfileChecked {...callbacks} />,
    );

    expect(markup).toContain('Play a free round');
    expect(markup).toContain('Playable demo · no account, upload, or credits');
    expect(markup).toContain('Free Rookie · human check at creation');
    expect(markup).toContain('Create your fighter');
    expect(markup).toContain('aria-label="Pause gameplay preview"');
  });

  it('only calls the Rookie pass available after checking a signed-in account', () => {
    const markup = renderToStaticMarkup(
      <LandingPage
        authStatus="signed-in"
        billingProfile={{ creditsBalance: 0, freeRookieGenerationsUsed: 0, planTier: 'free' }}
        billingProfileChecked
        {...callbacks}
      />,
    );

    expect(markup).toContain('Free Rookie pass · 1 available');
    expect(markup).not.toContain('human check at creation');
  });

  it('separates the Rookie price from the signed-in credit balance after the pass is used', () => {
    const markup = renderToStaticMarkup(
      <LandingPage
        authStatus="signed-in"
        billingProfile={{ creditsBalance: 11, freeRookieGenerationsUsed: 1, planTier: 'free' }}
        billingProfileChecked
        {...callbacks}
      />,
    );

    expect(markup).toContain('Rookie · 2 credits · 11 available');
    expect(markup).not.toContain('Free Rookie pass · 1 available');
  });

  it('does not claim an entitlement while the signed-in account is still loading', () => {
    const markup = renderToStaticMarkup(
      <LandingPage authStatus="signed-in" billingProfile={null} billingProfileChecked={false} {...callbacks} />,
    );

    expect(markup).toContain('Checking your Rookie pass…');
    expect(markup).not.toContain('Free Rookie pass · 1 available');
  });

  it('falls back to neutral copy when the account check is unavailable', () => {
    const markup = renderToStaticMarkup(
      <LandingPage authStatus="signed-in" billingProfile={null} billingProfileChecked {...callbacks} />,
    );

    expect(markup).toContain('Rookie · pass verified at creation');
    expect(markup).not.toContain('Checking your Rookie pass…');
  });
});
