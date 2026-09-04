import { describe, expect, it } from 'vitest';
import {
  auraPerformanceAtBeat,
  createAuraPerformanceRoutine,
} from './AuraPerformance.ts';

describe('Aura performance routine', () => {
  it('is deterministic, round-specific, and has no duplicate phrase in one turn', () => {
    const first = createAuraPerformanceRoutine(12345, 0);
    const repeated = createAuraPerformanceRoutine(12345, 0);
    const nextRound = createAuraPerformanceRoutine(12345, 1);

    expect(repeated).toEqual(first);
    expect(new Set(first).size).toBe(3);
    expect(nextRound).not.toEqual(first);
  });

  it('maps the challenge linearly onto three performance phrases', () => {
    const routine = ['aura_six_seven', 'aura_glide', 'aura_floor_worm'] as const;

    expect(auraPerformanceAtBeat(routine, 0)).toBe('aura_six_seven');
    expect(auraPerformanceAtBeat(routine, 5)).toBe('aura_six_seven');
    expect(auraPerformanceAtBeat(routine, 6)).toBe('aura_glide');
    expect(auraPerformanceAtBeat(routine, 10)).toBe('aura_glide');
    expect(auraPerformanceAtBeat(routine, 11)).toBe('aura_floor_worm');
    expect(auraPerformanceAtBeat(routine, 16)).toBe('aura_floor_worm');
  });
});
