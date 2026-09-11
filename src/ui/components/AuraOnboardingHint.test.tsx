import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AuraOnboardingHint } from './AuraOnboardingHint.tsx';
import type { AuraOnboardingDetail } from '../../game/aura/AuraOnboarding.ts';

const detail: AuraOnboardingDetail = {
  token: 1, seed: 42, phase: 'practice', cue: 'controls', practiceLane: 2, completedLanes: 2,
  laneKeys: ['A', 'S', 'D', 'F'],
};

describe('Aura contextual instruction', () => {
  it('labels practice clearly and uses the actual next key and touch shape', () => {
    const markup = renderToStaticMarkup(<AuraOnboardingHint detail={detail} onSkip={vi.fn()} />);
    expect(markup).toContain('aria-label="Aura practice"');
    expect(markup).toContain('Practice <span>3/4</span>');
    expect(markup).toContain('Wait for the line');
    expect(markup).toContain('<kbd>D</kbd>');
    expect(markup).toContain('aria-label="tap square">■</span>');
    expect(markup).not.toContain('Warm-up');
    expect(markup).not.toContain('No points lost');
  });

  it('does not prompt an early hit and keeps skip available at every practice step', () => {
    const onSkip = vi.fn();
    for (const cue of ['controls', 'wait', 'hit'] as const) {
      const view = AuraOnboardingHint({ detail: { ...detail, cue }, onSkip })!;
      const markup = renderToStaticMarkup(view);
      expect(markup).toContain(cue === 'hit' ? 'Hit now' : 'Wait for the line');
      expect(markup).toContain('aria-label="Skip practice and start duel"');
      view.props.children[1].props.onClick();
    }
    expect(onSkip).toHaveBeenCalledTimes(3);
  });

  it('keeps a live duel tip to one message without repeating practice controls', () => {
    const markup = renderToStaticMarkup(<AuraOnboardingHint detail={{ ...detail, phase: 'battle', cue: 'score', practiceLane: null, completedLanes: 4, scoreDelta: 25 }} onSkip={vi.fn()} />);
    expect(markup).toContain('+25 Aura');
    expect(markup).not.toContain('<kbd>');
    expect(markup).not.toContain('Practice');
    expect(markup).not.toContain('That was you');
    expect(markup).toContain('Hide duel tips');
  });

  it('leaves the game clear between cues and once guidance has finished', () => {
    for (const state of [{ cue: null }, { phase: 'complete' }, { phase: 'skipped' }] as const) {
      expect(AuraOnboardingHint({ detail: { ...detail, ...state }, onSkip: vi.fn() })).toBeNull();
    }
  });
});
