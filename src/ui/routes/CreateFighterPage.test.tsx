import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateFighterPage } from './CreateFighterPage.tsx';

afterEach(() => vi.unstubAllGlobals());

function renderAuraEntry(search = '?package=aura&return=aura', authStatus: 'signed-out' | 'signed-in' = 'signed-out') {
  vi.stubGlobal('window', { location: { search } });
  return renderToStaticMarkup(<CreateFighterPage authStatus={authStatus} authSessionKey={authStatus} authSlot={<button>Sign in / Join</button>} onPlayTrial={() => {}} onBack={() => {}} onComplete={() => {}} />);
}

describe('Aura character creation entry', () => {
  it('starts with Rookie and asks only for the character, leaving quality in advanced options', () => {
    const markup = renderAuraEntry('?package=aura&return=aura', 'signed-in');
    expect(markup).toContain('Create your Aura character');
    expect(markup).toContain('One photo, six Aura moves');
    expect(markup).toContain('Quality options');
    expect(markup).toMatch(/name="fighter-quality-tier"[^>]*checked=""[^>]*value="rookie"/);
    expect(markup).not.toContain('Where do you want to play?');
    expect(markup).not.toContain('Fight + Rush');
    expect(markup).not.toContain('fighter-creation-flow');
  });

  it('requires sign-in without promising an anonymous free Aura generation', () => {
    const markup = renderAuraEntry();
    expect(markup).toContain('Sign in / Join');
    expect(markup).toContain('Play a free battle');
    expect(markup).toContain('First Rookie included if your account has not used it');
    expect(markup).toContain('After that, Rookie Aura costs 2 credits');
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toContain('Character name');
    expect(markup).not.toContain('Create Free Rookie');
    expect(markup).not.toContain('No credits charged');
  });
});
