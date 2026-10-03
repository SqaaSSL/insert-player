import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlayPage } from './PlayPage';

const noop = () => {};
const status = (debutComplete: boolean) => ({
  trialComplete: true, debutComplete, complete: false, recommendedStep: 'debut',
  fighter: { id: 'f1', photoHash: 'hash-1', name: 'Diego.AI' },
}) as never;

describe('PlayPage debut card', () => {
  it('names the player\'s own Rookie and offers both debut matches', () => {
    const markup = renderToStaticMarkup(<PlayPage onPlay={noop} onExplore={noop} onOpenCharacters={noop}
      onOpenChallenges={noop} onboardingStatus={status(false)} onContinueOnboarding={noop} onPlayDebut={noop} />);
    expect(markup).toContain('Diego.AI is ready');
    expect(markup).toContain('Debut in Aura');
    expect(markup).toContain('Debut in Fight');
  });

  it('falls back to the generic mission once the debut is done', () => {
    const markup = renderToStaticMarkup(<PlayPage onPlay={noop} onExplore={noop} onOpenCharacters={noop}
      onOpenChallenges={noop} onboardingStatus={status(true)} onContinueOnboarding={noop} onPlayDebut={noop} />);
    expect(markup).not.toContain('is ready');
    expect(markup).toContain('Continue My First Run');
  });
});
