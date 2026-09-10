import { AURA_TRACKS_GENERATED } from './aura-tracks.generated.ts';

/**
 * One entry per Aura track. `bpm` comes from scripts/measure-aura-track.mjs
 * and is reliable; `beatOffsetMs` (first beat from the start of the file) is
 * a measured starting point that should be confirmed by ear with the in-game
 * early/late meter, then pinned in AURA_TRACK_OVERRIDES.
 */
export interface AuraTrack {
  id: string;
  title: string;
  url: string;
  bpm: number;
  beatOffsetMs: number;
  durationMs?: number;
  /** Stage this track was written for; auto-pick prefers it on that stage. */
  stageId?: string;
  /** Fight/Rush battle theme kept only so Aura can run with an empty catalogue. */
  fallback?: boolean;
}

/** Hand-confirmed values win over whatever the measurement script writes. */
export const AURA_TRACK_OVERRIDES: Readonly<Record<string, Partial<Omit<AuraTrack, 'id'>>>> = {
  // The original 154.268 BPM / 174 ms constants drifted ~180 ms by the final
  // round; the comb-locked measurement (153.715 BPM) holds phase for 120 s.
  'neon-arena': { stageId: 'insert-player-arena', fallback: true },
};

const ALL_AURA_TRACKS: readonly AuraTrack[] = AURA_TRACKS_GENERATED.map((entry) => ({
  ...entry,
  ...AURA_TRACK_OVERRIDES[entry.id],
}));

/** The Aura draw pool: the generated catalogue, or the battle theme when it is empty. */
export const AURA_TRACKS: readonly AuraTrack[] = ALL_AURA_TRACKS.some((track) => !track.fallback)
  ? ALL_AURA_TRACKS.filter((track) => !track.fallback)
  : ALL_AURA_TRACKS;

export const DEFAULT_AURA_TRACK: AuraTrack = AURA_TRACKS[0];

export function getAuraTrack(id: string | null | undefined): AuraTrack | null {
  if (!id) return null;
  return ALL_AURA_TRACKS.find((track) => track.id === id) ?? null;
}

/** Deterministic pick so two netplay peers sharing a seed hear the same track. */
export function pickAuraTrackFromSeed(seed: number): AuraTrack {
  const index = (seed >>> 0) % AURA_TRACKS.length;
  return AURA_TRACKS[index] ?? DEFAULT_AURA_TRACK;
}

/** Seeded pick that prefers tracks written for the match's stage. */
export function pickAuraTrackForMatch(seed: number, stageId: string | null | undefined): AuraTrack {
  const pool = stageId ? AURA_TRACKS.filter((track) => track.stageId === stageId) : [];
  if (pool.length === 0) return pickAuraTrackFromSeed(seed);
  return pool[(seed >>> 0) % pool.length];
}

export function auraBeatMs(track: AuraTrack): number {
  return 60_000 / track.bpm;
}
