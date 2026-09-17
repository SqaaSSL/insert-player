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
    expect(markup).toContain('One photo, 20 animations for Aura, Fight and Rush');
    expect(markup).toContain('Quality options');
    expect(markup).toMatch(/name="fighter-quality-tier"[^>]*checked=""[^>]*value="rookie"/);
    expect(markup).not.toContain('Where do you want to play?');
    expect(markup).toContain('Aura + Fight + Rush');
    expect(markup).not.toContain('name="creation-package"');
    expect(markup).not.toContain('fighter-creation-flow');
  });

  it('offers exactly Rookie and Champion and replaces an old Champion link with the current quote', () => {
    const markup = renderAuraEntry('?package=aura&tier=champion', 'signed-in');
    expect(markup.match(/name="fighter-quality-tier"/g)).toHaveLength(2);
    expect(markup).toMatch(/name="fighter-quality-tier"[^>]*checked=""[^>]*value="contender"/);
    expect(markup).toContain('Champion');
    expect(markup).toContain('11 credits');
    expect(markup).not.toContain('6 credits');
    expect(markup).toContain('Checking your account credits and eligibility');
    expect(markup).not.toContain('10 credits');
    expect(markup).not.toContain('Contender');
    expect(markup).not.toContain('value="champion"');
    expect(markup).not.toContain('Gemini');
    expect(markup).not.toContain('Flash');
  });

  it('keeps new combat creation on its available flow without a retired third offer', () => {
    const markup = renderAuraEntry('?package=complete&tier=champion', 'signed-in');
    expect(markup.match(/name="fighter-quality-tier"/g)).toHaveLength(2);
    expect(markup).toMatch(/name="fighter-quality-tier"[^>]*checked=""[^>]*value="contender"/);
    expect(markup).not.toContain('fighter-creation-flow');
    expect(markup).toContain('11 credits');
    expect(markup).not.toContain('18 credits');
  });

  it('requires sign-in without promising an anonymous free Aura generation', () => {
    const markup = renderAuraEntry();
    expect(markup).toContain('Sign in / Join');
    expect(markup).toContain('Play a free battle');
    expect(markup).toContain('First Rookie included if your account has not used it');
    expect(markup).toContain('After that, Rookie costs 2 credits');
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toContain('Character name');
    expect(markup).not.toContain('Create Free Rookie');
    expect(markup).not.toContain('No credits charged');
  });

  it('asks about public figures before quality, credits and consent with no default answer', () => {
    const markup = renderAuraEntry('?tier=rookie&package=complete', 'signed-in');
    const question = markup.indexOf('Is this a famous person?');
    expect(question).toBeGreaterThan(markup.indexOf('Source Photo'));
    expect(question).toBeLessThan(markup.indexOf('Quality options'));
    expect(question).toBeLessThan(markup.indexOf('Process this photo only'));
    expect(markup.match(/name="fighter-public-figure"/g)).toHaveLength(2);
    expect(markup).not.toMatch(/name="fighter-public-figure"[^>]*checked/);
    expect(markup).toContain('Choose whether this is a famous person to continue');
    expect(markup).not.toContain('Famous people may not generate');
  });
});
