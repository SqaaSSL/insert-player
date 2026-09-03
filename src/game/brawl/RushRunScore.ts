export type RushRunRank = 'S' | 'A' | 'B' | 'C' | 'D';

export interface RushRunScoreInput {
  completed: boolean;
  durationSeconds: number;
  enemiesDefeated: number;
  obstaclesDestroyed: number;
  checkpointsCleared: number;
  revives: number;
  teamHealthRemaining: number;
  teamMaxHealth: number;
}

export interface RushRunScore {
  score: number;
  rank: RushRunRank;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Rush scoring rewards forward progress, using the route, and keeping the
 * team alive. It intentionally does not reward damage dealt so high-health
 * enemies cannot become score farms.
 */
export function scoreRushRun(input: RushRunScoreInput): RushRunScore {
  const durationSeconds = finiteNonNegative(input.durationSeconds);
  const enemiesDefeated = Math.floor(finiteNonNegative(input.enemiesDefeated));
  const obstaclesDestroyed = Math.floor(finiteNonNegative(input.obstaclesDestroyed));
  const checkpointsCleared = Math.floor(finiteNonNegative(input.checkpointsCleared));
  const revives = Math.floor(finiteNonNegative(input.revives));
  const maxHealth = finiteNonNegative(input.teamMaxHealth);
  const remainingHealth = Math.min(maxHealth, finiteNonNegative(input.teamHealthRemaining));
  const healthRatio = maxHealth > 0 ? remainingHealth / maxHealth : 0;

  const score = Math.round(
    enemiesDefeated * 150
      + obstaclesDestroyed * 225
      + checkpointsCleared * 900
      + revives * 350
      + healthRatio * 1_600
      + (input.completed ? 2_500 : 0)
      + (input.completed ? Math.max(0, 420 - durationSeconds) * 6 : 0),
  );

  const rank: RushRunRank = score >= 11_000
    ? 'S'
    : score >= 9_000
      ? 'A'
      : score >= 6_500
        ? 'B'
        : score >= 3_500
          ? 'C'
          : 'D';

  return { score, rank };
}
