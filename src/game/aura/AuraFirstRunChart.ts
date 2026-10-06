import { SeededRng } from '../utils/SeededRng.ts';
import {
  AURA_FINISH_BEATS,
  AURA_NOTE_TRAVEL_BEATS,
  AURA_PHRASE_BEATS,
  AURA_ROUNDS,
  AURA_TURN_BEATS,
  AURA_TURN_COUNT_IN_BEATS,
} from './AuraConfig.ts';
import { auraBeatMs, type AuraTrack } from './AuraTracks.ts';
import type { AuraChart, AuraLane, AuraNote, AuraSlot, AuraTurn } from './AuraChart.ts';

/**
 * A gentle chart for a player's very first Aura duels (the demo and the
 * onboarding debut). Same song, same 3 call-and-response rounds, and P1 and
 * P2 still play exactly the same phrase inside each round. It ramps up:
 *   round 1: a note every other beat, on the two middle lanes;
 *   round 2: a note every other beat, any lane;
 *   round 3: a note on every beat, any lane; never half-beats.
 * It lives outside the files that challenge links fingerprint, so shared
 * challenges and their links are unaffected.
 */
export const AURA_FIRST_RUN_DIFFICULTY = 'lowkey' as const;

function nextLane(rng: SeededRng, previous: AuraLane | null, lanes: readonly AuraLane[]): AuraLane {
  const choices = previous === null ? lanes : lanes.filter((lane) => lane !== previous);
  return choices[rng.nextInt(0, choices.length - 1)];
}

function firstRunRoundBeats(round: number): number[] {
  const step = round < 2 ? 2 : 1;
  return Array.from({ length: Math.ceil(AURA_PHRASE_BEATS / step) }, (_, index) => index * step);
}

export function createAuraFirstRunChart(seed: number, track: AuraTrack, countInBeats: number): AuraChart {
  const normalizedSeed = (seed >>> 0) || 0x41555241;
  const rng = new SeededRng(normalizedSeed ^ 0x46495253);
  const beatMs = auraBeatMs(track);
  const countIn = Number.isInteger(countInBeats) && countInBeats >= 4 ? countInBeats : 8;
  const firstTurnMs = track.beatOffsetMs + countIn * beatMs;
  const turns: AuraTurn[] = [];
  for (let round = 0; round < AURA_ROUNDS; round += 1) {
    const lanes: readonly AuraLane[] = round === 0 ? [1, 2] : [0, 1, 2, 3];
    let previous: AuraLane | null = null;
    const pattern = firstRunRoundBeats(round).map((beat) => {
      const lane = nextLane(rng, previous, lanes);
      previous = lane;
      return { beat, lane };
    });
    for (let response = 0; response < 2; response += 1) {
      const index = round * 2 + response;
      const slot = response as AuraSlot;
      const startMs = firstTurnMs + index * AURA_TURN_BEATS * beatMs;
      const firstNoteMs = startMs + AURA_TURN_COUNT_IN_BEATS * beatMs;
      const notes = pattern.map((entry, noteIndex): AuraNote => ({
        id: `r${round}-s${slot}-n${noteIndex}`,
        turnIndex: index, slot, lane: entry.lane, beat: entry.beat,
        atMs: firstNoteMs + entry.beat * beatMs,
      }));
      turns.push({ index, round, slot, startMs, firstNoteMs, endMs: startMs + AURA_TURN_BEATS * beatMs, notes });
    }
  }
  const notes = turns.flatMap((turn) => turn.notes);
  return {
    seed: normalizedSeed,
    difficulty: AURA_FIRST_RUN_DIFFICULTY,
    trackId: track.id,
    bpm: track.bpm,
    beatMs,
    beatOffsetMs: track.beatOffsetMs,
    noteTravelMs: AURA_NOTE_TRAVEL_BEATS * beatMs,
    firstTurnMs,
    durationMs: (turns.at(-1)?.endMs ?? firstTurnMs) + AURA_FINISH_BEATS * beatMs,
    turns,
    notes,
  };
}
