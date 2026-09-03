import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RushRunResults, formatRushDuration } from './RushRunResults.tsx';

describe('RushRunResults', () => {
  it('renders a complete cooperative run summary and all next actions', () => {
    const markup = renderToStaticMarkup(
      <RushRunResults
        summary={{
          outcome: 'won',
          stageId: 'side-street',
          stageLabel: 'SIDE STREET',
          durationSeconds: 154,
          score: 10_850,
          rank: 'A',
          enemiesDefeated: 15,
          obstaclesDestroyed: 4,
          checkpointsCleared: 3,
          revives: 1,
          damageTaken: 72,
          teamHealthRemaining: 128,
          teamMaxHealth: 200,
          difficulty: 'arcade',
        }}
        onRetry={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    expect(markup).toContain('ROUTE CLEARED');
    expect(markup).toContain('ARCADE RUN');
    expect(markup).toContain('10,850');
    expect(markup).toContain('2:34');
    expect(markup).toContain('WAVES');
    expect(markup).toContain('Run It Back');
    expect(markup).toContain('Share Result');
    expect(markup).toContain('Back To Arcade');
  });

  it('formats long and malformed durations safely', () => {
    expect(formatRushDuration(65)).toBe('1:05');
    expect(formatRushDuration(-4)).toBe('0:00');
  });
});
