import { describe, expect, it } from 'vitest';
import { auraPerformanceAtBeat, createAuraPerformanceRoutine } from './AuraPerformance.ts';
import {
  isAuraPerformanceRoutine, isAuraMatchSelection, isAuraSelectedRoutines, normalizeAuraSelectedRoutines,
  resolveAuraPerformanceRoutine, type AuraSelectedRoutines,
} from './AuraChoreography.ts';

const repeated = ['aura_six_seven', 'aura_floor_worm', 'aura_six_seven'] as const;
const selected = [repeated, ['aura_glide', 'aura_one_leg', 'aura_mog_check'],
  ['aura_floor_worm', 'aura_six_seven', 'aura_glide']] as const;

describe('chosen Aura choreography', () => {
  it('plays all nine chosen positions in order, including repeats, across the three rounds', () => {
    const selections: AuraSelectedRoutines = [selected, [selected[2], repeated, selected[1]]];
    for (const slot of [0, 1] as const) {
      for (const round of [0, 1, 2]) {
        const routine = resolveAuraPerformanceRoutine(67, round, slot, selections);
        const expected = selections[slot]![round];
        expect([0, 0.5, 5, 6, 10, 11, 15.5, 16].map(beat => auraPerformanceAtBeat(routine, beat)))
          .toEqual([expected[0], expected[0], expected[0], expected[1], expected[1], expected[2], expected[2], expected[2]]);
      }
      expect([0, 1, 2].flatMap(round => [0, 6, 11]
        .map(beat => auraPerformanceAtBeat(resolveAuraPerformanceRoutine(67, round, slot, selections), beat))))
        .toEqual(selections[slot]!.flat());
    }
  });

  it('retains the exact seeded per-round fallback for CPU and legacy matches', () => {
    for (const round of [0, 1, 2]) {
      const expected = createAuraPerformanceRoutine(67, round);
      expect(resolveAuraPerformanceRoutine(67, round, 0)).toEqual(expected);
      expect(resolveAuraPerformanceRoutine(67, round, 1, [selected, null])).toEqual(expected);
    }
  });

  it.each([null, [], ['aura_glide'], ['aura_glide', 'aura_glide', 'aura_shrug'],
    ['aura_unbothered', 'aura_glide', 'aura_one_leg'], ['aura_glide', 'aura_glide', 'unknown'],
    ['aura_glide', 'aura_glide', 'aura_glide', 'aura_glide'], Array(3)].map(value => [value]))('refuses malformed or non-playable phrases: %j', value => {
    expect(isAuraPerformanceRoutine(value)).toBe(false);
    expect(isAuraSelectedRoutines([value, selected])).toBe(value === null);
  });

  it.each([repeated, selected.flat(), [repeated], [repeated, repeated],
    [repeated, repeated, ['aura_shrug', 'aura_glide', 'aura_one_leg']],
    [repeated, Array(3), repeated], Array(3)].map(value => [value]))('rejects incomplete or flat match selections: %j', value => {
    expect(isAuraMatchSelection(value)).toBe(false);
    expect(isAuraSelectedRoutines([value, null])).toBe(false);
    expect(normalizeAuraSelectedRoutines([value, selected])).toEqual([null, selected]);
  });

  it('validates the pair and copies only complete valid slots, without deduplicating', () => {
    expect(isAuraPerformanceRoutine(repeated)).toBe(true);
    expect(isAuraMatchSelection(selected)).toBe(true);
    expect(isAuraSelectedRoutines([null, selected])).toBe(true);
    expect(isAuraSelectedRoutines([null, null])).toBe(true);
    expect(isAuraSelectedRoutines([selected])).toBe(false);
    expect(isAuraSelectedRoutines(Array(2))).toBe(false);
    expect(normalizeAuraSelectedRoutines([['unknown'], selected])).toEqual([null, selected]);
    expect(normalizeAuraSelectedRoutines([selected])).toEqual([null, null]);
    const input = [selected.map(round => [...round]), null];
    const copy = normalizeAuraSelectedRoutines(input);
    input[0]![0][0] = 'aura_floor_worm';
    input[0]![1][1] = 'aura_six_seven';
    expect(copy).toEqual([selected, null]);
  });
});
