import { describe, expect, it } from 'vitest';
import { createAuraFirstRunChart } from './AuraFirstRunChart.ts';
import { createAuraChart } from './AuraChart.ts';
import { DEFAULT_AURA_TRACK } from './AuraTracks.ts';

describe('first-run Aura chart', () => {
  const chart = createAuraFirstRunChart(1234, DEFAULT_AURA_TRACK, 4);
  const perRound = (round: number) => chart.turns.filter((turn) => turn.round === round);
  it('ramps up gently: 8, 8 then 16 notes, never half-beats', () => {
    expect([0, 1, 2].map((round) => perRound(round)[0].notes.length)).toEqual([8, 8, 16]);
    expect(chart.notes.every((note) => Number.isInteger(note.beat))).toBe(true);
    // 64 notes against 120 in the easiest shared chart.
    expect(chart.notes.length).toBeLessThanOrEqual(createAuraChart(1234, 'lowkey', DEFAULT_AURA_TRACK).notes.length * 0.55);
  });
  it('starts on the two middle lanes only', () => {
    expect(new Set(perRound(0)[0].notes.map((note) => note.lane))).toEqual(new Set([1, 2]));
  });
  it('gives P1 and P2 the identical phrase in every round, and different phrases across rounds', () => {
    for (const round of [0, 1, 2]) {
      const [p1, p2] = perRound(round);
      expect(p2.notes.map((n) => [n.beat, n.lane])).toEqual(p1.notes.map((n) => [n.beat, n.lane]));
    }
    expect(perRound(1)[0].notes.map((n) => n.lane)).not.toEqual(perRound(2)[0].notes.slice(0, 8).map((n) => n.lane));
  });
  it('is deterministic per seed and keeps the shared chart untouched', () => {
    expect(createAuraFirstRunChart(1234, DEFAULT_AURA_TRACK, 4)).toEqual(chart);
    expect(createAuraChart(1234, 'viral', DEFAULT_AURA_TRACK)).toEqual(createAuraChart(1234, 'viral', DEFAULT_AURA_TRACK, 8));
  });
});
