import { SeededRng } from '../utils/SeededRng.ts';
import {
  AURA_BEAT_MS,
  AURA_BPM,
  AURA_FINISH_BEATS,
  AURA_INITIAL_COUNT_IN_BEATS,
  AURA_MUSIC_BEAT_OFFSET_MS,
  AURA_PHRASE_BEATS,
  AURA_TURN_BEATS,
  AURA_TURN_COUNT_IN_BEATS,
  getAuraDifficulty,
  type AuraDifficultyId,
} from './AuraConfig.ts';

export type AuraLane = 0 | 1 | 2 | 3;
export type AuraSlot = 0 | 1;

export interface AuraNote {
  id: string;
  turnIndex: number;
  slot: AuraSlot;
  lane: AuraLane;
  beat: number;
  atMs: number;
}

export interface AuraTurn {
  index: number;
  round: number;
  slot: AuraSlot;
  startMs: number;
  firstNoteMs: number;
  endMs: number;
  notes: AuraNote[];
}

export interface AuraChart {
  seed: number;
  difficulty: AuraDifficultyId;
  bpm: number;
  beatMs: number;
  firstTurnMs: number;
  durationMs: number;
  turns: AuraTurn[];
  notes: AuraNote[];
}

interface PatternNote {
  beat: number;
  lane: AuraLane;
}

function nextLane(rng: SeededRng, previous: AuraLane | null): AuraLane {
  let lane = rng.nextInt(0, 3) as AuraLane;
  if (previous !== null && lane === previous) {
    lane = ((previous + 1 + rng.nextInt(0, 2)) % 4) as AuraLane;
  }
  return lane;
}

function createRoundPattern(rng: SeededRng, offbeatNotes: number): PatternNote[] {
  const candidates = Array.from({ length: AURA_PHRASE_BEATS - 1 }, (_, index) => index + 0.5);
  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const swap = rng.nextInt(0, i);
    [candidates[i], candidates[swap]] = [candidates[swap], candidates[i]];
  }
  const beats = [
    ...Array.from({ length: AURA_PHRASE_BEATS }, (_, beat) => beat),
    ...candidates.slice(0, offbeatNotes),
  ].sort((a, b) => a - b);

  // Assign lanes only after every beat is known. This guarantees that an
  // inserted half-beat cannot accidentally create an unreadable same-rail
  // double with either of its neighbours.
  let previous: AuraLane | null = null;
  return beats.map((beat) => {
    const lane = nextLane(rng, previous);
    previous = lane;
    return { beat, lane };
  });
}

/**
 * Build two call-and-response rounds. P1 and P2 receive exactly the same
 * phrase inside each round, so procedural generation can be surprising
 * without ever deciding the winner.
 */
export function createAuraChart(
  seed: number,
  difficultyId: AuraDifficultyId = 'viral',
): AuraChart {
  const normalizedSeed = (seed >>> 0) || 0x41555241;
  const difficulty = getAuraDifficulty(difficultyId);
  const rng = new SeededRng(normalizedSeed ^ 0x41555241);
  const firstTurnMs = AURA_MUSIC_BEAT_OFFSET_MS + AURA_INITIAL_COUNT_IN_BEATS * AURA_BEAT_MS;
  const turns: AuraTurn[] = [];

  for (let round = 0; round < 2; round += 1) {
    const pattern = createRoundPattern(rng, difficulty.offbeatNotes + round * 2);
    for (let response = 0; response < 2; response += 1) {
      const index = round * 2 + response;
      const slot = response as AuraSlot;
      const startMs = firstTurnMs + index * AURA_TURN_BEATS * AURA_BEAT_MS;
      const firstNoteMs = startMs + AURA_TURN_COUNT_IN_BEATS * AURA_BEAT_MS;
      const notes = pattern.map((entry, noteIndex): AuraNote => ({
        id: `r${round}-s${slot}-n${noteIndex}`,
        turnIndex: index,
        slot,
        lane: entry.lane,
        beat: entry.beat,
        atMs: firstNoteMs + entry.beat * AURA_BEAT_MS,
      }));
      turns.push({
        index,
        round,
        slot,
        startMs,
        firstNoteMs,
        endMs: startMs + AURA_TURN_BEATS * AURA_BEAT_MS,
        notes,
      });
    }
  }

  const notes = turns.flatMap((turn) => turn.notes);
  const durationMs = (turns.at(-1)?.endMs ?? firstTurnMs) + AURA_FINISH_BEATS * AURA_BEAT_MS;
  return {
    seed: normalizedSeed,
    difficulty: difficulty.id,
    bpm: AURA_BPM,
    beatMs: AURA_BEAT_MS,
    firstTurnMs,
    durationMs,
    turns,
    notes,
  };
}

export function auraTurnAt(chart: AuraChart, nowMs: number): AuraTurn | null {
  return chart.turns.find((turn) => nowMs >= turn.startMs && nowMs < turn.endMs) ?? null;
}
