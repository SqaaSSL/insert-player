import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AuraRosterButton, GameLandingPage } from './GameLandingPage.tsx';
import { PlayPage } from './PlayPage.tsx';
vi.mock('../components/AuraEntryPreview.tsx', () => ({ AuraEntryPreview: () => <div>Aura preview</div> }));
vi.mock('../components/CombatEntryPreview.tsx', () => ({ CombatEntryPreview: () => <div>Combat preview</div> }));

describe('ready Aura character discovery', () => {
  it.each(['aura', 'fight', 'rush'] as const)('quotes the same complete character on the %s entry', (mode) => {
    const html = renderToStaticMarkup(<GameLandingPage mode={mode} onPlay={vi.fn()} onCreate={vi.fn()} onExplore={vi.fn()}
      onOpenCharacters={vi.fn()} onOpenCredits={vi.fn()} />);
    expect(html).toContain('All 20 animations, compact detail');
    expect(html).toContain('All 20 animations, more detail per move');
    expect(html).toContain('2 credits');
    expect(html).toContain('11 credits');
    expect(html).toContain('Sign in to check your included first Rookie');
    expect(html).not.toContain('6 credits');
    expect(html).not.toContain('Six dedicated performance moves');
    expect(html).not.toContain('separate pack');
  });
  it('keeps one-tap free play first and adds a separate character choice on the Aura landing', () => {
    const html = renderToStaticMarkup(<GameLandingPage mode="aura" onPlay={vi.fn()} onCreate={vi.fn()} onExplore={vi.fn()}
      onChooseCharacter={vi.fn()} onOpenCharacters={vi.fn()} onOpenCredits={vi.fn()} />);
    expect(html.indexOf('Play Aura')).toBeLessThan(html.indexOf('Choose a character'));
    expect(html).toContain('Free · no account');
    expect(html).toContain('Trump · Rosalía · Lamine');
    expect(html).toContain('Create my Rookie Aura');
    expect(html).not.toContain('<select');
  });
  it('makes the same ready roster discoverable from Play without replacing quickplay', () => {
    const html = renderToStaticMarkup(<PlayPage onPlay={vi.fn()} onExplore={vi.fn()} onChooseCharacter={vi.fn()}
      onOpenCharacters={vi.fn()} onOpenChallenges={vi.fn()} />);
    expect(html.indexOf('Play Aura')).toBeLessThan(html.indexOf('Choose a character'));
    expect(html).toContain('My characters');
    expect(html).toContain('Explore Fight');
  });
  it('does not advertise Aura characters on Fight or Rush entries', () => {
    for (const mode of ['fight', 'rush'] as const) {
      const html = renderToStaticMarkup(<GameLandingPage mode={mode} onPlay={vi.fn()} onCreate={vi.fn()} onExplore={vi.fn()}
        onChooseCharacter={vi.fn()} onOpenCharacters={vi.fn()} onOpenCredits={vi.fn()} />);
      expect(html).not.toContain('Choose a character');
      expect(html).not.toContain('Rosalía');
    }
  });
  it('hands character selection to the supplied roster navigation callback', () => {
    const choose = vi.fn();
    const tree = AuraRosterButton({ onChoose: choose });
    tree.props.children[0].props.onClick();
    expect(choose).toHaveBeenCalledOnce();
  });
});
