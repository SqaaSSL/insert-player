import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FirstRunPage } from './FirstRunPage.tsx';
import { PlayPage, nextMissionTitle } from './PlayPage.tsx';
import { TrialGameChoice } from '../components/TrialGameChoice.tsx';

function find(predicate: (node: any) => boolean, node: any): any {
  if (node == null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) return node.map((child) => find(predicate, child ?? null)).find(Boolean);
  return predicate(node) ? node : find(predicate, node.props?.children ?? null);
}

describe('first run entry', () => {
  it('offers Aura and Fight demos as equals with a way to skip straight to creation', () => {
    const markup = renderToStaticMarkup(
      <FirstRunPage onPlay={() => {}} onSkip={() => {}} onExplore={() => {}} onSignIn={() => {}} />,
    );
    expect(markup).toContain('Step 1 · Pick your game');
    expect(markup).toContain('Try Aura');
    expect(markup).toContain('Try Fight');
    expect(markup).not.toContain('Try Rush');
    expect(markup.indexOf('Try Aura')).toBeLessThan(markup.indexOf('Try Fight'));
    expect(markup).toContain('Skip the demo · Create my character');
    expect(markup).toContain('No account needed');
    expect(markup).toContain('Already a player? Sign in');
    // Both games show real gameplay before their button, in the same card layout.
    expect(markup.match(/trial-game-choice__option"/g)).toHaveLength(2);
    expect(markup.match(/trial-game-choice__preview"/g)).toHaveLength(2);
    // The only primary buttons are the two demos; nothing else competes above the fold.
    expect(markup.match(/asf-btn--primary/g)).toHaveLength(2);
  });

  it('wires the demo choice to play and the skip link to creation', () => {
    const onPlay = vi.fn();
    const onSkip = vi.fn();
    const onExplore = vi.fn();
    const tree = FirstRunPage({ onPlay, onSkip, onExplore });
    const choice = find((node) => node.type === TrialGameChoice, tree);
    expect(choice.props.onPlay).toBe(onPlay);
    expect(choice.props.onSkip).toBe(onSkip);
    expect(choice.props.showPreviews).toBe(true);
    const meetFight = find((node) => node.type === 'button' && node.props.children === 'Explore Fight →', tree);
    meetFight.props.onClick();
    expect(onExplore).toHaveBeenCalledWith('fight');
    expect(find((node) => node.props?.children === 'Already a player? Sign in', tree)).toBeUndefined();
  });

  it('keeps the compact choice without previews or skip for embedded use', () => {
    const markup = renderToStaticMarkup(<TrialGameChoice onPlay={() => {}} />);
    expect(markup).toContain('Try Aura');
    expect(markup).toContain('Try Fight');
    expect(markup).not.toContain('trial-game-choice__preview');
    expect(markup).not.toContain('Skip the demo');
  });
});

describe('Play page', () => {
  const props = { onPlay: () => {}, onExplore: () => {}, onOpenCharacters: () => {}, onOpenChallenges: () => {}, onChooseCharacter: () => {} };

  it('shows Aura and Fight as two equal cards and keeps Rush below', () => {
    const markup = renderToStaticMarkup(<PlayPage {...props} />);
    const aura = markup.indexOf('product-entry__duo-card--aura');
    const fight = markup.indexOf('product-entry__duo-card--fight');
    const rush = markup.indexOf('product-entry__game-row');
    expect(aura).toBeGreaterThan(-1);
    expect(fight).toBeGreaterThan(aura);
    expect(rush).toBeGreaterThan(fight);
    expect(markup).toContain('Play Aura');
    expect(markup).toContain('Play Fight');
    expect(markup).toContain('Play Rush');
    expect(markup).toContain('Explore Aura →');
    expect(markup).toContain('Explore Fight →');
  });

  it('names the next mission without assuming the debut game', () => {
    expect(nextMissionTitle({ fighter: null, debutComplete: false, recommendedStep: 'create' })).toBe('Create your own Rookie');
    expect(nextMissionTitle({ fighter: { id: 'f', photoHash: 'p', name: 'N' } as any, debutComplete: false, recommendedStep: 'debut' })).toBe('Make your debut');
    expect(nextMissionTitle({ fighter: { id: 'f', photoHash: 'p', name: 'N' } as any, debutComplete: true, recommendedStep: 'invite' })).toBe('Bring in Player Two');
    const markup = renderToStaticMarkup(<PlayPage {...props} onContinueOnboarding={() => {}}
      onboardingStatus={{ complete: false, fighter: { id: 'f', photoHash: 'p', name: 'N' }, debutComplete: false, recommendedStep: 'debut' } as any} />);
    expect(markup).toContain('Make your debut');
    expect(markup).not.toContain('Aura debut');
  });
});
