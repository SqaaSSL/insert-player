import { describe, expect, it } from 'vitest';
import { AuraBattle } from '../../game/aura/AuraBattle.ts';
import { auraNoteTravelProgress, createAuraChart } from '../../game/aura/AuraChart.ts';
import {
  AURA_PREVIEW_CHART, AURA_PREVIEW_CYCLE_MS, AURA_PREVIEW_KEYS, AURA_PREVIEW_RESULT_MS,
  AURA_PREVIEW_STILL_MS, AURA_PREVIEW_TURN_MS, auraPreviewDuelAt,
} from './auraPreviewDuel.ts';

const chart = AURA_PREVIEW_CHART;
const firstTurn = chart.turns[0];
const first = firstTurn.notes[0];
const second = firstTurn.notes[1];
const duelEndMs = chart.turns.at(-1)!.endMs;

/** Scripted timings exercised through the public game engine as an independent oracle. */
function demoInputs() {
  const offsets = [[0, 150, 97, 0], [0, 0, 97, 0]];
  return chart.turns.flatMap((turn) => turn.notes.map((note, index) => ({
    note, atMs: note.atMs + offsets[note.slot][index % 4],
  }))).sort((a, b) => a.atMs - b.atMs);
}

describe('landing-page Aura duel using real gameplay rules', () => {
  it('gives both performers identical excerpts of the real seeded chart and a four-beat approach', () => {
    const original = createAuraChart(chart.seed, chart.difficulty);
    expect(chart.noteTravelMs).toBe(4 * chart.beatMs);
    expect(chart.firstTurnMs).toBe(0);
    expect(AURA_PREVIEW_KEYS).toEqual(['D', 'F', 'J', 'K']);
    for (let round = 0; round < 3; round++) {
      const p1 = chart.turns[round * 2];
      const p2 = chart.turns[round * 2 + 1];
      const phrase = original.turns[round * 2].notes.filter((note) => note.beat < 4)
        .map(({ lane, beat }) => ({ lane, beat }));
      expect(p1.notes.map(({ lane, beat }) => ({ lane, beat }))).toEqual(phrase);
      expect(p2.notes.map(({ lane, beat }) => ({ lane, beat }))).toEqual(phrase);
      expect(p1.firstNoteMs - p1.startMs).toBeCloseTo(chart.noteTravelMs);
      expect(p2.firstNoteMs - p2.startMs).toBeCloseTo(chart.noteTravelMs);
      expect(p1.endMs - p1.startMs).toBeCloseTo(AURA_PREVIEW_TURN_MS);
      expect(auraPreviewDuelAt(p1.startMs)).toMatchObject({ activeSlot: 0, round: round + 1 });
      expect(auraPreviewDuelAt(p2.startMs)).toMatchObject({ activeSlot: 1, round: round + 1 });
    }
  });

  it('approaches the receptor using the real projection and awards nothing before an input', () => {
    expect(auraPreviewDuelAt(0)).toMatchObject({ scores: [0, 0], phase: 'count-in', countIn: 4 });
    expect(auraPreviewDuelAt(0).notes.find((note) => note.id === first.id)?.progress).toBe(0);
    const midway = auraPreviewDuelAt(chart.noteTravelMs / 2);
    expect(midway.countIn).toBe(2);
    expect(midway.notes.find((note) => note.id === first.id)?.progress).toBe(0.5);
    expect(auraPreviewDuelAt(first.atMs - 0.01)).toMatchObject({ scores: [0, 0], gain: 0, hitIndex: -1 });
    const onTime = auraPreviewDuelAt(first.atMs);
    expect(onTime).toMatchObject({ scores: [1000, 0], scoreDelta: 1000, combo: 1, comboLabel: 'x1 FLOW', feedbackLabel: 'PERFECT', phase: 'performing', countIn: null });
    expect(onTime.notes.some((note) => note.id === first.id)).toBe(false);
    expect(onTime.receptors[first.lane]).toEqual({ lane: first.lane, hit: true, grade: 'perfect' });
    const late = auraPreviewDuelAt(second.atMs + 149);
    const unhit = late.notes.find((note) => note.id === second.id)!;
    expect(unhit.progress).toBe(auraNoteTravelProgress(second.atMs, second.atMs + 149, chart.noteTravelMs));
    expect(unhit.progress).toBeGreaterThan(1);
    expect(late.scores).toEqual([1000, 0]);
    expect(auraPreviewDuelAt(second.atMs + 150)).toMatchObject({ scores: [1375, 0], scoreDelta: 375, combo: 2, feedbackLabel: 'GOOD' });
  });

  it('matches every real AuraBattle score, grade and combo across seeks and skipped frames', () => {
    const battle = new AuraBattle(chart);
    for (const { note, atMs } of demoInputs()) {
      const before = auraPreviewDuelAt(atMs - 0.01);
      expect(before.scores).toEqual([battle.scoreFor(0).score, battle.scoreFor(1).score]);
      const judgement = battle.judgeInput(note.slot, note.lane, atMs);
      const state = auraPreviewDuelAt(atMs);
      expect(judgement.noteId).toBe(note.id);
      expect(['perfect', 'great', 'good']).toContain(judgement.grade);
      expect(state.scores).toEqual([battle.scoreFor(0).score, battle.scoreFor(1).score]);
      expect(state.combos).toEqual([battle.scoreFor(0).combo, battle.scoreFor(1).combo]);
      expect(state.recentHit).toMatchObject({ noteId: note.id, slot: note.slot, lane: note.lane, grade: judgement.grade, scoreDelta: judgement.scoreDelta, combo: judgement.combo });
      expect(auraPreviewDuelAt(atMs)).toEqual(state);
    }
    expect(auraPreviewDuelAt(duelEndMs).winner).toBe(battle.winner());
    expect(battle.winner()).toBe(1);
    expect(auraPreviewDuelAt(first.atMs).scores).toEqual([1000, 0]);
  });

  it('expires receptor and hit feedback without removing earned points', () => {
    expect(auraPreviewDuelAt(first.atMs + 219).receptors[first.lane].hit).toBe(true);
    expect(auraPreviewDuelAt(first.atMs + 220).receptors[first.lane].hit).toBe(false);
    const inputs = demoInputs();
    const isolated = inputs.find((input, index) => inputs[index + 1]?.atMs - input.atMs > 420
      && chart.turns[input.note.turnIndex].endMs - input.atMs > 420)!;
    const earned = auraPreviewDuelAt(isolated.atMs);
    expect(auraPreviewDuelAt(isolated.atMs + 419).gain).toBe(earned.gain);
    expect(auraPreviewDuelAt(isolated.atMs + 420)).toMatchObject({ scores: earned.scores, gain: 0, scoreDelta: 0, recentHit: null });
    expect(auraPreviewDuelAt(chart.turns[1].startMs)).toMatchObject({ activeSlot: 1, gain: 0, hitIndex: -1, combo: 0 });
  });

  it('uses the real score balance clamp and retains a readable reduced-motion frame', () => {
    expect(auraPreviewDuelAt(0).balance).toBe(0.5);
    expect(auraPreviewDuelAt(first.atMs).balance).toBe(0.92);
    const result = auraPreviewDuelAt(duelEndMs);
    expect(result.balance).toBeCloseTo(result.scores[0] / (result.scores[0] + result.scores[1]));
    const still = auraPreviewDuelAt(AURA_PREVIEW_STILL_MS);
    expect(still.notes.length).toBeGreaterThan(1);
    expect(still.recentHit?.grade).toBe('perfect');
    expect(still.receptors.some((receptor) => receptor.hit)).toBe(true);
    expect(still.scoreDelta).toBe(1000);
  });

  it('holds the result, removes highway events, and starts a fresh cycle', () => {
    expect(auraPreviewDuelAt(duelEndMs - 0.01).finished).toBe(false);
    const result = auraPreviewDuelAt(duelEndMs);
    expect(result).toMatchObject({ finished: true, phase: 'result', activeSlot: null, winner: 1, gain: 0, notes: [], countIn: null, hitIndex: -1 });
    expect(result.receptors.every((receptor) => !receptor.hit)).toBe(true);
    expect(auraPreviewDuelAt(AURA_PREVIEW_CYCLE_MS - 0.01)).toEqual(result);
    expect(AURA_PREVIEW_CYCLE_MS - duelEndMs).toBeCloseTo(AURA_PREVIEW_RESULT_MS);
    expect(auraPreviewDuelAt(AURA_PREVIEW_CYCLE_MS)).toEqual(auraPreviewDuelAt(0));
  });

  it('changes only the movement order when choosing the opening move', () => {
    expect(chart.turns.map((turn) => auraPreviewDuelAt(turn.startMs, 2).moveIndex)).toEqual([2, 2, 0, 0, 1, 1]);
    for (const time of [0, first.atMs, chart.turns[3].firstNoteMs, duelEndMs]) {
      const { moveIndex: _originalMove, ...original } = auraPreviewDuelAt(time);
      const { moveIndex: _selectedMove, ...selected } = auraPreviewDuelAt(time, 2);
      expect(selected).toEqual(original);
    }
  });

  it('safely normalizes invalid clocks and movement indexes', () => {
    for (const invalid of [-1, -Infinity, Infinity, NaN]) expect(auraPreviewDuelAt(invalid)).toEqual(auraPreviewDuelAt(0));
    for (const invalid of [-Infinity, Infinity, NaN]) expect(auraPreviewDuelAt(1280, invalid)).toEqual(auraPreviewDuelAt(1280, 0));
    expect(auraPreviewDuelAt(0, -1).moveIndex).toBe(2);
    expect(auraPreviewDuelAt(0, 7.9).moveIndex).toBe(1);
    const largeTime = auraPreviewDuelAt(Number.MAX_VALUE, Number.MAX_VALUE);
    expect(largeTime.moveIndex).toBeGreaterThanOrEqual(0);
    expect(largeTime.moveIndex).toBeLessThan(3);
    expect(largeTime.scores.every(Number.isFinite)).toBe(true);
  });
});
