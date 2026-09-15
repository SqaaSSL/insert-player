import { describe, expect, it } from 'vitest';
import { auraPerformanceAtBeat, createAuraPerformanceRoutine } from './AuraPerformance.ts';
import {
  isAuraPerformanceRoutine, isAuraSelectedRoutines, normalizeAuraSelectedRoutines,
  resolveAuraPerformanceRoutine, type AuraSelectedRoutines,
} from './AuraChoreography.ts';

const repeated = ['aura_six_seven', 'aura_six_seven', 'aura_one_leg'] as const;

describe('chosen Aura choreography', () => {
  it('plays the chosen order, including repeats, for the same player in every round', () => {
    const selections: AuraSelectedRoutines = [repeated, ['aura_glide', 'aura_mog_check', 'aura_floor_worm']];
    for (const round of [0, 1, 2, 3]) {
      const routine = resolveAuraPerformanceRoutine(67, round, 0, selections);
      expect([0, 6, 11].map(beat => auraPerformanceAtBeat(routine, beat))).toEqual(repeated);
      expect(resolveAuraPerformanceRoutine(67, round, 1, selections)).toEqual(selections[1]);
    }
  });

  it('retains the exact seeded per-round fallback for CPU and legacy matches', () => {
    for (const round of [0, 1, 2]) {
      const expected = createAuraPerformanceRoutine(67, round);
      expect(resolveAuraPerformanceRoutine(67, round, 0)).toEqual(expected);
      expect(resolveAuraPerformanceRoutine(67, round, 1, [repeated, null])).toEqual(expected);
    }
  });

  it.each([null, [], ['aura_glide'], ['aura_glide', 'aura_glide', 'aura_shrug'],
    ['aura_unbothered', 'aura_glide', 'aura_one_leg'], ['aura_glide', 'aura_glide', 'unknown'],
    ['aura_glide', 'aura_glide', 'aura_glide', 'aura_glide'], Array(3)].map(value => [value]))('refuses malformed or non-playable phrases: %j', value => {
    expect(isAuraPerformanceRoutine(value)).toBe(false);
    expect(isAuraSelectedRoutines([value, repeated])).toBe(value === null);
  });

  it('validates the pair and copies only complete valid slots, without deduplicating', () => {
    expect(isAuraPerformanceRoutine(repeated)).toBe(true);
    expect(isAuraSelectedRoutines([null, repeated])).toBe(true);
    expect(isAuraSelectedRoutines([null, null])).toBe(true);
    expect(isAuraSelectedRoutines([repeated])).toBe(false);
    expect(isAuraSelectedRoutines(Array(2))).toBe(false);
    expect(normalizeAuraSelectedRoutines([['unknown'], repeated])).toEqual([null, repeated]);
    expect(normalizeAuraSelectedRoutines([repeated])).toEqual([null, null]);
    const input = [[...repeated], null];
    const copy = normalizeAuraSelectedRoutines(input);
    input[0]![0] = 'aura_one_leg';
    expect(copy).toEqual([repeated, null]);
  });
});
