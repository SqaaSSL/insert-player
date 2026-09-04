import { describe, expect, it } from 'vitest';
import {
  buildMatchSeed,
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

describe('buildMatchSeed', () => {
  const legacyMatch = {
    vsAI: true,
    cpuVsCpu: false,
    p1Name: 'Nova',
    p2Name: 'Byte',
    stageId: 'insert-player-arena' as const,
  };

  it('preserves existing Fight and Rush seed identities', () => {
    const legacySeed = buildMatchSeed(legacyMatch);
    expect(buildMatchSeed({ ...legacyMatch, gameMode: 'fight' })).toBe(legacySeed);
    expect(buildMatchSeed({ ...legacyMatch, gameMode: 'rush' })).toBe(legacySeed);
  });

  it('isolates Aura charts and their difficulty from existing modes', () => {
    const fightSeed = buildMatchSeed({ ...legacyMatch, gameMode: 'fight' });
    const viralSeed = buildMatchSeed({ ...legacyMatch, gameMode: 'aura', auraDifficulty: 'viral' });
    const lowkeySeed = buildMatchSeed({ ...legacyMatch, gameMode: 'aura', auraDifficulty: 'lowkey' });

    expect(viralSeed).not.toBe(fightSeed);
    expect(lowkeySeed).not.toBe(viralSeed);
  });
});
