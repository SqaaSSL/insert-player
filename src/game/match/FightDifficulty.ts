export type FightDifficultyId = 'rookie' | 'arcade' | 'champion';

export interface FightDifficulty {
  id: FightDifficultyId;
  label: string;
  blurb: string;
  strength: number;
}

export const FIGHT_DIFFICULTIES: readonly FightDifficulty[] = [
  { id: 'rookie', label: 'ROOKIE', blurb: 'Longer reactions and more openings.', strength: 0.45 },
  { id: 'arcade', label: 'ARCADE', blurb: 'Sharp, fair cabinet pressure.', strength: 0.76 },
  { id: 'champion', label: 'CHAMPION', blurb: 'Full-strength reads and punishes.', strength: 1 },
];

export function getFightDifficulty(id?: FightDifficultyId | null): FightDifficulty {
  return FIGHT_DIFFICULTIES.find((difficulty) => difficulty.id === id)
    ?? FIGHT_DIFFICULTIES[2];
}

export function getFightDifficultyForStrength(strength?: number | null): FightDifficulty {
  if (strength === undefined || strength === null) return getFightDifficulty('champion');
  return [...FIGHT_DIFFICULTIES].sort(
    (a, b) => Math.abs(a.strength - strength) - Math.abs(b.strength - strength),
  )[0];
}
