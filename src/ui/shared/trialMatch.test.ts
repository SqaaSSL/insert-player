import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudFighter } from '../../services/CloudFighters.ts';
import {
  TRIAL_OPPONENT_DIFFICULTY,
  buildTrialMatchData,
  createTrialMatchData,
  selectTrialFighters,
  trialAssetsBeforeDeadline,
} from './trialMatch.ts';

afterEach(() => vi.useRealTimers());

function fighter(
  id: string,
  slug: string,
  name: string,
  defaultPersonality: NonNullable<CloudFighter['arcade']>['defaultPersonality'] = 'balanced',
): CloudFighter {
  return {
    id,
    name,
    public: true,
    qualityTier: 'champion',
    sources: {},
    sprites: [],
    arcade: {
      slug,
      rank: 1,
      challengerLine: 'Ready.',
      defaultPersonality,
      reference: {
        kind: 'generated',
        sourceUrl: null,
        license: 'Test',
        credit: 'Test',
      },
    },
  };
}

describe('trialMatch', () => {
  const playerOne = fighter('player-id', 'player-one', 'Player One');
  const trump = fighter('trump-id', 'donald-trump', 'Donald Trump', 'showboat');
  const fallback = fighter('fallback-id', 'lamine-yamal', 'Lamine Yamal', 'counter');

  it('selects Player One and the preferred opponent without relying on roster order', () => {
    expect(selectTrialFighters([fallback, playerOne, trump])).toEqual({
      player: playerOne,
      opponent: trump,
    });
  });

  it('falls back to the first distinct Arcade fighter', () => {
    expect(selectTrialFighters([playerOne, fallback]).opponent).toBe(fallback);
  });

  it('keeps the trial playable with a sparse or unavailable cloud roster', () => {
    expect(selectTrialFighters([trump])).toEqual({ player: trump, opponent: null });
    expect(selectTrialFighters([])).toEqual({ player: null, opponent: null });
  });

  it('builds a low-difficulty branded match with stable cloud identities', () => {
    const data = buildTrialMatchData({ player: playerOne, opponent: trump });
    expect(data).toMatchObject({
      experience: 'trial',
      roundsToWin: 1,
      vsAI: true,
      cpuVsCpu: false,
      p1PhotoHash: 'arcade:player-one:player-id',
      p2PhotoHash: 'arcade:donald-trump:trump-id',
      p1CloudFighterId: 'player-id',
      p2CloudFighterId: 'trump-id',
      p1Name: 'Player One',
      p2Name: 'Donald Trump',
      p2PersonalityId: 'showboat',
      p2Difficulty: TRIAL_OPPONENT_DIFFICULTY,
      stageId: 'executive-rumble',
    });
  });

  it('rejects a mirror pair and composes selection plus match creation', () => {
    expect(() => buildTrialMatchData({ player: playerOne, opponent: playerOne })).toThrow(/distinct/i);
    expect(createTrialMatchData([trump, playerOne])).toEqual(
      buildTrialMatchData({ player: playerOne, opponent: trump }),
    );
  });

  it('builds an engine-only fallback without pretending it has cloud identities', () => {
    expect(buildTrialMatchData({ player: null, opponent: null })).toMatchObject({
      experience: 'trial',
      roundsToWin: 1,
      p1CloudFighterId: null,
      p2CloudFighterId: null,
      p1Name: 'Player One',
      p2Name: 'CPU Rival',
      p2Difficulty: TRIAL_OPPONENT_DIFFICULTY,
      stageId: 'insert-player-arena',
    });
  });

  it('does not hold the demo open for a stalled cloud download', async () => {
    vi.useFakeTimers();
    const result = trialAssetsBeforeDeadline(new Promise<string>(() => {}), 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toBeNull();
  });
});
