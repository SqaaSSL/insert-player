export type AuraDifficultyId = 'lowkey' | 'viral' | 'untouchable';

export interface AuraDifficulty {
  id: AuraDifficultyId;
  label: string;
  blurb: string;
  /** Additional half-beat notes inserted into each sixteen-beat phrase. */
  offbeatNotes: number;
  perfectWindowMs: number;
  greatWindowMs: number;
  goodWindowMs: number;
  cpuPerfectChance: number;
  cpuGreatChance: number;
  cpuGoodChance: number;
}

/** Measured from Neon Arena's onset grid. Keep the chart locked to the track. */
export const AURA_BPM = 154.267723880597;
export const AURA_BEAT_MS = 60_000 / AURA_BPM;
export const AURA_MUSIC_BEAT_OFFSET_MS = 174;
export const AURA_TURN_BEATS = 20;
export const AURA_TURN_COUNT_IN_BEATS = 2;
export const AURA_PHRASE_BEATS = 16;
export const AURA_INITIAL_COUNT_IN_BEATS = 8;
export const AURA_FINISH_BEATS = 4;

export const AURA_DIFFICULTIES: readonly AuraDifficulty[] = [
  {
    id: 'lowkey',
    label: 'LOWKEY',
    blurb: 'Wide timing windows. The CPU still knows how to pose.',
    offbeatNotes: 2,
    perfectWindowMs: 72,
    greatWindowMs: 122,
    goodWindowMs: 178,
    cpuPerfectChance: 0.38,
    cpuGreatChance: 0.34,
    cpuGoodChance: 0.2,
  },
  {
    id: 'viral',
    label: 'VIRAL',
    blurb: 'Fast, fair, and difficult enough to expose NPC behaviour.',
    offbeatNotes: 6,
    perfectWindowMs: 56,
    greatWindowMs: 98,
    goodWindowMs: 148,
    cpuPerfectChance: 0.55,
    cpuGreatChance: 0.31,
    cpuGoodChance: 0.09,
  },
  {
    id: 'untouchable',
    label: 'UNTOUCHABLE',
    blurb: 'Dense patterns, strict timing, and a deeply disrespectful CPU.',
    offbeatNotes: 10,
    perfectWindowMs: 42,
    greatWindowMs: 78,
    goodWindowMs: 118,
    cpuPerfectChance: 0.76,
    cpuGreatChance: 0.18,
    cpuGoodChance: 0.04,
  },
] as const;

export function getAuraDifficulty(id?: AuraDifficultyId | null): AuraDifficulty {
  return AURA_DIFFICULTIES.find((entry) => entry.id === id) ?? AURA_DIFFICULTIES[1];
}
