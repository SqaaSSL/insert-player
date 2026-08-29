import { describe, expect, it } from 'vitest';
import {
  matchRestartFormat,
  shouldCaptureMatchIntroKeys,
} from './MatchConfig.ts';

describe('matchRestartFormat', () => {
  it('preserves the one-round trial contract for Play Again', () => {
    expect(matchRestartFormat({ experience: 'trial', roundsToWin: 1 })).toEqual({
      experience: 'trial',
      roundsToWin: 1,
    });
  });

  it('keeps legacy normal rematches free of new seed-affecting overrides', () => {
    expect(matchRestartFormat({})).toEqual({});
  });

  it('preserves explicit custom standard formats', () => {
    expect(matchRestartFormat({ experience: 'standard', roundsToWin: 5 })).toEqual({
      experience: 'standard',
      roundsToWin: 5,
    });
  });
});

describe('shouldCaptureMatchIntroKeys', () => {
  it('lets the trial result CTA receive Enter and Space', () => {
    expect(shouldCaptureMatchIntroKeys('trial')).toBe(false);
  });

  it('preserves the original keyboard capture for standard matches', () => {
    expect(shouldCaptureMatchIntroKeys('standard')).toBe(true);
  });
});
