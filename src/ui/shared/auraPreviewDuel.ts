import { AuraBattle, type AuraGrade, type AuraJudgement } from '../../game/aura/AuraBattle.ts';
import {
  auraNoteTravelProgress, auraTurnAt, createAuraChart,
  type AuraChart, type AuraLane, type AuraSlot,
} from '../../game/aura/AuraChart.ts';
import { AURA_DEFAULT_LANE_KEYS, AURA_NOTE_TRAVEL_BEATS, getAuraDifficulty } from '../../game/aura/AuraConfig.ts';
import { AURA_SCORE_CUE } from '../../game/aura/AuraScoreCue.ts';

export const AURA_PREVIEW_MOVES = [
  { id: 'one-leg', animation: 'aura_one_leg', label: 'One-leg hop', durationMs: 1250 },
  { id: 'six-seven', animation: 'aura_six_seven', label: '6–7', durationMs: 1050 },
  { id: 'floor-worm', animation: 'aura_floor_worm', label: 'Floor worm', durationMs: 1700 },
] as const;
export const AURA_PREVIEW_PERFORMERS = [
  { subject: 'donald-trump', name: 'Trump' },
  { subject: 'template-zero', name: 'Nova' },
] as const;
export const AURA_PREVIEW_KEYS = AURA_DEFAULT_LANE_KEYS;

const originalChart = createAuraChart(0x50524556, 'lowkey');
const PREVIEW_PHRASE_BEATS = 4;
export const AURA_PREVIEW_TURN_MS = (AURA_NOTE_TRAVEL_BEATS + PREVIEW_PHRASE_BEATS) * originalChart.beatMs;
export const AURA_PREVIEW_RESULT_MS = 3200;
const DUEL_MS = AURA_PREVIEW_MOVES.length * 2 * AURA_PREVIEW_TURN_MS;
export const AURA_PREVIEW_CYCLE_MS = DUEL_MS + AURA_PREVIEW_RESULT_MS;

/** Four-beat excerpts of the real seeded phrases, with their real four-beat approach. */
export const AURA_PREVIEW_CHART: Readonly<AuraChart> = (() => {
  const turns = originalChart.turns.map((turn) => {
    const startMs = turn.index * AURA_PREVIEW_TURN_MS;
    const firstNoteMs = startMs + originalChart.noteTravelMs;
    return {
      ...turn, startMs, firstNoteMs, endMs: (turn.index + 1) * AURA_PREVIEW_TURN_MS,
      notes: turn.notes.filter((note) => note.beat < PREVIEW_PHRASE_BEATS)
        .map((note) => ({ ...note, atMs: firstNoteMs + note.beat * originalChart.beatMs })),
    };
  });
  return { ...originalChart, firstTurnMs: 0, beatOffsetMs: 0, durationMs: AURA_PREVIEW_CYCLE_MS, turns, notes: turns.flatMap((turn) => turn.notes) };
})();
/** First successful hit is still lit and upcoming notes remain visible. */
export const AURA_PREVIEW_STILL_MS = AURA_PREVIEW_CHART.turns[0].firstNoteMs + 120;

type HitGrade = Extract<AuraGrade, 'perfect' | 'great' | 'good'>;
interface DemoEvent extends AuraJudgement {
  atMs: number;
  turnIndex: number;
  hitIndex: number;
  scores: readonly [number, number];
  combos: readonly [number, number];
}

/** Actual timed inputs, not invented point increments. Nova has cleaner timing. */
const DEMO_EVENTS: readonly DemoEvent[] = (() => {
  const battle = new AuraBattle(AURA_PREVIEW_CHART);
  const difficulty = getAuraDifficulty(AURA_PREVIEW_CHART.difficulty);
  const greatOffset = (difficulty.perfectWindowMs + difficulty.greatWindowMs) / 2;
  const goodOffset = (difficulty.greatWindowMs + difficulty.goodWindowMs) / 2;
  const offsets = [[0, goodOffset, greatOffset, 0], [0, 0, greatOffset, 0]] as const;
  const inputs = AURA_PREVIEW_CHART.turns.flatMap((turn) => turn.notes.map((note, index) => ({
    note, hitIndex: index, atMs: note.atMs + offsets[note.slot][index % offsets[note.slot].length],
  }))).sort((a, b) => a.atMs - b.atMs);
  return inputs.map(({ note, hitIndex, atMs }) => {
    const judgement = battle.judgeInput(note.slot, note.lane, atMs);
    const p1 = battle.scoreFor(0);
    const p2 = battle.scoreFor(1);
    return { ...judgement, atMs, turnIndex: note.turnIndex, hitIndex, scores: [p1.score, p2.score] as const, combos: [p1.combo, p2.combo] as const };
  });
})();
const GAIN_PULSE_MS = 420;
const RECEPTOR_PULSE_MS = 220;
export const AURA_PREVIEW_GAIN_LIFETIME_MS = AURA_SCORE_CUE.durationMs;
const MOVE_HISTORY_LIFETIME_MS = 1800;

/** Only the latest actual judgement appears under the active score. A new
 * note replaces it, and a turn change clears the outgoing performer's cue. */
export function auraPreviewFloatingGainsAt(elapsedMs: number) {
  const now = (Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0) % AURA_PREVIEW_CYCLE_MS;
  const turn = auraTurnAt(AURA_PREVIEW_CHART, now);
  if (!turn || now >= DUEL_MS) return [];
  const event = DEMO_EVENTS.filter(event => event.turnIndex === turn.index && event.atMs <= now).at(-1);
  if (!event || event.scoreDelta === 0 || now - event.atMs >= AURA_PREVIEW_GAIN_LIFETIME_MS) return [];
  return [{ noteId: event.noteId!, slot: event.slot, scoreDelta: event.scoreDelta, ageMs: now - event.atMs }];
}

export interface AuraPreviewVisibleNote {
  id: string;
  lane: AuraLane;
  atMs: number;
  /** Same un-clamped projection as the game; >1 means a slightly late hit. */
  progress: number;
}
export interface AuraPreviewRecentHit {
  noteId: string;
  slot: AuraSlot;
  lane: AuraLane;
  grade: HitGrade;
  atMs: number;
  ageMs: number;
  offsetMs: number;
  scoreDelta: number;
  combo: number;
  feedbackLabel: 'PERFECT' | 'CLEAN' | 'GOOD';
}
export interface AuraPreviewDuelState {
  moveIndex: number;
  activeSlot: AuraSlot | null;
  turnElapsedMs: number;
  scores: readonly [number, number];
  combos: readonly [number, number];
  combo: number;
  comboLabel: string;
  /** Same clamped two-colour score balance as AuraScene. */
  balance: number;
  gain: number;
  scoreDelta: number;
  judgement: 'Perfect' | 'Great' | 'Good' | null;
  feedbackLabel: AuraPreviewRecentHit['feedbackLabel'] | null;
  recentHit: AuraPreviewRecentHit | null;
  /** Actual successful inputs still belonging to the visible move card. */
  moveInputs: readonly { noteId: string; lane: AuraLane; atMs: number }[];
  notes: readonly AuraPreviewVisibleNote[];
  receptors: readonly { lane: AuraLane; hit: boolean; grade: HitGrade | null }[];
  phase: 'count-in' | 'performing' | 'result';
  countIn: number | null;
  round: number;
  /** Index within the active turn; -1 before its first hit or during the result. */
  hitIndex: number;
  winner: AuraSlot | null;
  finished: boolean;
}

function feedbackFor(hit: DemoEvent): AuraPreviewRecentHit['feedbackLabel'] {
  return hit.grade === 'perfect' ? 'PERFECT' : hit.grade === 'great' ? 'CLEAN' : 'GOOD';
}

/** A seekable automatic demo of the game's chart projection, judgement and scoring. */
export function auraPreviewDuelAt(elapsedMs: number, startMoveIndex = 0): AuraPreviewDuelState {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const nowMs = elapsed % AURA_PREVIEW_CYCLE_MS;
  const moveCount = AURA_PREVIEW_MOVES.length;
  const requestedStart = Number.isFinite(startMoveIndex) ? Math.trunc(startMoveIndex) : 0;
  const start = ((requestedStart % moveCount) + moveCount) % moveCount;
  const turn = auraTurnAt(AURA_PREVIEW_CHART, nowMs);
  const finished = nowMs >= DUEL_MS;
  const reached = DEMO_EVENTS.filter((event) => event.atMs <= nowMs);
  const last = reached.at(-1);
  const scores = last?.scores ?? [0, 0] as const;
  const combos = last?.combos ?? [0, 0] as const;
  const total = scores[0] + scores[1];
  const balance = total === 0 ? 0.5 : Math.max(0.08, Math.min(0.92, scores[0] / total));
  const turnEvents = turn ? reached.filter((event) => event.turnIndex === turn.index) : [];
  const lastInTurn = turnEvents.at(-1);
  const showHit = lastInTurn && nowMs - lastInTurn.atMs < GAIN_PULSE_MS;
  const recentHit: AuraPreviewRecentHit | null = showHit ? {
    noteId: lastInTurn.noteId!, slot: lastInTurn.slot, lane: lastInTurn.lane,
    grade: lastInTurn.grade as HitGrade, atMs: lastInTurn.atMs, ageMs: nowMs - lastInTurn.atMs,
    offsetMs: lastInTurn.offsetMs, scoreDelta: lastInTurn.scoreDelta, combo: lastInTurn.combo,
    feedbackLabel: feedbackFor(lastInTurn),
  } : null;
  const successfulHits = finished ? [] : turnEvents.filter(event =>
    event.grade === 'perfect' || event.grade === 'great' || event.grade === 'good');
  const lastMoveHit = successfulHits.at(-1);
  let moveInputs: AuraPreviewDuelState['moveInputs'] = [];
  if (lastMoveHit && nowMs - lastMoveHit.atMs < MOVE_HISTORY_LIFETIME_MS) {
    // Like the real card, a long silence retires the preceding input trail.
    // Derive this from input times so a direct seek matches uninterrupted play.
    let trailStart = 0;
    successfulHits.forEach((hit, index) => {
      if (index > 0 && hit.atMs - successfulHits[index - 1].atMs >= MOVE_HISTORY_LIFETIME_MS) trailStart = index;
    });
    moveInputs = successfulHits.slice(trailStart).slice(-4)
      .map(({ noteId, lane, atMs }) => ({ noteId: noteId!, lane, atMs }));
  }
  const judgedIds = new Set(turnEvents.map((event) => event.noteId));
  const notes = turn?.notes.filter((note) => !judgedIds.has(note.id)).map((note) => ({
    id: note.id, lane: note.lane, atMs: note.atMs,
    progress: auraNoteTravelProgress(note.atMs, nowMs, AURA_PREVIEW_CHART.noteTravelMs),
  })).filter((note) => note.progress >= 0) ?? [];
  const receptors = ([0, 1, 2, 3] as const).map((lane) => {
    const hit = [...turnEvents].reverse().find((event) => event.lane === lane && nowMs - event.atMs < RECEPTOR_PULSE_MS);
    return { lane, hit: !!hit, grade: hit?.grade as HitGrade | undefined ?? null };
  });
  const combo = turn ? combos[turn.slot] : 0;
  const countIn = turn && nowMs < turn.firstNoteMs
    ? Math.max(1, Math.ceil((turn.firstNoteMs - nowMs) / AURA_PREVIEW_CHART.beatMs)) : null;
  return {
    moveIndex: (start + (turn?.round ?? moveCount - 1)) % moveCount,
    activeSlot: turn?.slot ?? null,
    turnElapsedMs: turn ? nowMs - turn.startMs : AURA_PREVIEW_TURN_MS,
    scores, combos, combo, comboLabel: `x${combo} FLOW`, balance,
    gain: recentHit?.scoreDelta ?? 0,
    scoreDelta: recentHit?.scoreDelta ?? 0,
    judgement: recentHit ? recentHit.grade === 'perfect' ? 'Perfect' : recentHit.grade === 'great' ? 'Great' : 'Good' : null,
    feedbackLabel: recentHit?.feedbackLabel ?? null,
    recentHit, moveInputs, notes, receptors,
    phase: finished ? 'result' : countIn !== null ? 'count-in' : 'performing', countIn,
    round: (turn?.round ?? moveCount - 1) + 1,
    hitIndex: lastInTurn?.hitIndex ?? -1,
    winner: finished && scores[0] !== scores[1] ? scores[0] > scores[1] ? 0 : 1 : null,
    finished,
  };
}
