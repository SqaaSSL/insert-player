import { describe, expect, it } from 'vitest';
import { scoreRushRun } from './RushRunScore.ts';

describe('scoreRushRun', () => {
  it('rewards a fast, healthy clear with the top rank', () => {
    expect(scoreRushRun({
      completed: true,
      durationSeconds: 150,
      enemiesDefeated: 15,
      obstaclesDestroyed: 6,
      checkpointsCleared: 3,
      revives: 0,
      teamHealthRemaining: 180,
      teamMaxHealth: 200,
    })).toEqual({ score: 11_860, rank: 'S' });
  });

  it('gives a failed run credit for real route progress without a clear bonus', () => {
    const result = scoreRushRun({
      completed: false,
      durationSeconds: 260,
      enemiesDefeated: 8,
      obstaclesDestroyed: 3,
      checkpointsCleared: 1,
      revives: 1,
      teamHealthRemaining: 0,
      teamMaxHealth: 200,
    });

    expect(result).toEqual({ score: 3_125, rank: 'D' });
  });

  it('clamps malformed counters and health before calculating', () => {
    expect(scoreRushRun({
      completed: false,
      durationSeconds: Number.NaN,
      enemiesDefeated: -3,
      obstaclesDestroyed: -1,
      checkpointsCleared: 0,
      revives: 0,
      teamHealthRemaining: 500,
      teamMaxHealth: 200,
    })).toEqual({ score: 1_600, rank: 'D' });
  });
});
