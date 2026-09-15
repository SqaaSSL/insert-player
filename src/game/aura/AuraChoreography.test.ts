import { describe, expect, it } from 'vitest';
import { auraPerformanceAtBeat, createAuraPerformanceRoutine } from './AuraPerformance.ts';
import {
  isAuraPerformanceRoutine, isAuraSelectedRoutines, normalizeAuraSelectedRoutines,
  resolveAuraPerformanceRoutine, type AuraSelectedRoutines,
} from './AuraChoreography.ts';

const repeated = ['aura_six_seven', 'aura_floor_worm', 'aura_six_seven'] as const;

describe('chosen Aura choreography', () => {
  it('assigns one chosen move to each round, keeping it throughout that round and allowing repeats', () => {
    const selections: AuraSelectedRoutines = [repeated, ['aura_glide', 'aura_mog_check', 'aura_floor_worm']];
    for (const slot of [0, 1] as const) {
      for (const round of [0, 1, 2]) {
        const routine = resolveAuraPerformanceRoutine(67, round, slot, selections);
        expect([0, 0.5, 5, 6, 10, 11, 15.5, 16].map(beat => auraPerformanceAtBeat(routine, beat)))
          .toEqual(Array(8).fill(selections[slot]![round]));
      }
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
    input[0]![0] = 'aura_floor_worm';
    expect(copy).toEqual([repeated, null]);
  });
});
