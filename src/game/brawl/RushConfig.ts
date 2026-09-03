export type RushDifficultyId = 'rookie' | 'arcade' | 'mayhem';

export interface RushDifficulty {
  id: RushDifficultyId;
  label: string;
  blurb: string;
  enemyHealth: number;
  enemyDamage: number;
  enemySpeed: number;
  enemyCooldown: number;
  projectileSpeed: number;
  checkpointRecovery: number;
}

export const RUSH_DIFFICULTIES: readonly RushDifficulty[] = [
  {
    id: 'rookie',
    label: 'ROOKIE',
    blurb: 'More recovery and wider openings.',
    enemyHealth: 0.82,
    enemyDamage: 0.76,
    enemySpeed: 0.92,
    enemyCooldown: 1.24,
    projectileSpeed: 0.88,
    checkpointRecovery: 24,
  },
  {
    id: 'arcade',
    label: 'ARCADE',
    blurb: 'The intended co-op challenge.',
    enemyHealth: 1,
    enemyDamage: 1.08,
    enemySpeed: 1.06,
    enemyCooldown: 0.9,
    projectileSpeed: 1.04,
    checkpointRecovery: 14,
  },
  {
    id: 'mayhem',
    label: 'MAYHEM',
    blurb: 'Relentless squads and scarce recovery.',
    enemyHealth: 1.24,
    enemyDamage: 1.34,
    enemySpeed: 1.14,
    enemyCooldown: 0.72,
    projectileSpeed: 1.16,
    checkpointRecovery: 8,
  },
];

export function getRushDifficulty(id?: RushDifficultyId | null): RushDifficulty {
  return RUSH_DIFFICULTIES.find((difficulty) => difficulty.id === id)
    ?? RUSH_DIFFICULTIES[1];
}

export type RushCompanionOrder = 'follow' | 'attack' | 'cover';

export const RUSH_COMPANION_ORDERS: ReadonlyArray<{
  id: RushCompanionOrder;
  label: string;
  shortLabel: string;
  blurb: string;
}> = [
  { id: 'follow', label: 'FOLLOW', shortLabel: 'FOLLOW', blurb: 'Stay close and react.' },
  { id: 'attack', label: 'PRESS', shortLabel: 'PRESS', blurb: 'Push the nearest threat.' },
  { id: 'cover', label: 'COVER', shortLabel: 'COVER', blurb: 'Protect, revive, recover.' },
];
