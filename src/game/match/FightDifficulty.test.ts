import { describe, expect, it } from 'vitest';
import { getFightDifficulty, getFightDifficultyForStrength } from './FightDifficulty.ts';

describe('FightDifficulty', () => {
  it('maps readable presets to the existing universal AI strength', () => {
    expect(getFightDifficulty('rookie').strength).toBe(0.45);
    expect(getFightDifficulty('champion').strength).toBe(1);
    expect(getFightDifficultyForStrength(0.78).id).toBe('arcade');
    expect(getFightDifficultyForStrength(undefined).id).toBe('champion');
  });
});
