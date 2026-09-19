import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AuraBattleCompleteDetail } from '../../game/match/MatchConfig.ts';
import { AuraBattleResults } from './AuraBattleResults.tsx';

const score = { score: 1000, combo: 1, bestCombo: 1, perfect: 1, great: 0, good: 0, misses: 0, mashes: 0 };
const summary: AuraBattleCompleteDetail = {
  winnerSlot: 'p1', p1Name: 'Player', p2Name: 'Rival', p1Score: score, p2Score: score,
  p1Rank: 'A', p2Rank: 'B', durationSeconds: 45, difficulty: 'viral', stageId: 'aura-plaza', stageLabel: 'Aura Plaza',
};
const baseProps = { summary, onRetry: vi.fn(), onExit: vi.fn(), finisher: <button>Fatality · 1 credit</button> };

describe('Aura result next mission', () => {
  it('puts the included Rookie mission before paid finishers after a trial', () => {
    const markup = renderToStaticMarkup(<AuraBattleResults {...baseProps} trial onCreatePlayer={vi.fn()} />);
    expect(markup.indexOf('Create My Free Rookie')).toBeLessThan(markup.indexOf('Fatality'));
  });

  it('keeps the Crew mission first with a visible retry if the debut has not synced', () => {
    const markup = renderToStaticMarkup(<AuraBattleResults {...baseProps} onBuildCrew={vi.fn()}
      debutSaveState="error" onRetryDebut={vi.fn()} />);
    expect(markup.indexOf('Build My Crew')).toBeLessThan(markup.indexOf('Fatality'));
    expect(markup).toContain('Your debut has not synced yet.');
    expect(markup).toContain('Retry saving debut');
    expect(markup).toContain('role="status"');
  });

  it('shows saving progress without advertising a retry while the save is pending', () => {
    const markup = renderToStaticMarkup(<AuraBattleResults {...baseProps} onBuildCrew={vi.fn()}
      debutSaveState="saving" onRetryDebut={vi.fn()} />);
    expect(markup).toContain('Saving your debut...');
    expect(markup).not.toContain('Retry saving debut');
    expect(markup).toContain('Build My Crew');
  });
});
