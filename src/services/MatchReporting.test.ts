import { describe, expect, it } from 'vitest';
import type { MatchCompletionDetail } from '../game/match/MatchConfig';
import { shouldReportMatchCompletion } from './MatchReporting';

function detail(overrides: Partial<MatchCompletionDetail> = {}): MatchCompletionDetail {
  return {
    winnerSlot: 'p1',
    roundsP1: 2,
    roundsP2: 0,
    durationSeconds: 42,
    vsAI: true,
    cpuVsCpu: false,
    ...overrides,
  };
}

describe('match reporting', () => {
  it('does not report Attract Mode as a personal match', () => {
    expect(shouldReportMatchCompletion(detail({ cpuVsCpu: true }))).toBe(false);
  });

  it('does not report trial completions as personal matches', () => {
    expect(shouldReportMatchCompletion(detail({ experience: 'trial' }))).toBe(false);
  });

  it('keeps human matches reportable, including matches against the CPU', () => {
    expect(shouldReportMatchCompletion(detail())).toBe(true);
    expect(shouldReportMatchCompletion(detail({ experience: 'standard' }))).toBe(true);
    expect(shouldReportMatchCompletion(detail({ vsAI: false }))).toBe(true);
  });
});
