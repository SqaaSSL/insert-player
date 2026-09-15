import {
  AURA_ROUTINE_ANIMATION_NAMES,
  createAuraPerformanceRoutine,
  type AuraPerformanceRoutine,
} from './AuraPerformance.ts';

/** One chosen gesture for each of the three rounds, in round order. */
export type AuraRoundSelection = AuraPerformanceRoutine;

/** A null player slot keeps the legacy seeded routine within each round. */
export type AuraSelectedRoutines = readonly [AuraRoundSelection | null, AuraRoundSelection | null];

export function isAuraPerformanceRoutine(value: unknown): value is AuraPerformanceRoutine {
  return Array.isArray(value) && value.length === 3
    && [0, 1, 2].every(index => AURA_ROUTINE_ANIMATION_NAMES.includes(value[index]));
}

export function isAuraSelectedRoutines(value: unknown): value is AuraSelectedRoutines {
  return Array.isArray(value) && value.length === 2
    && [0, 1].every(index => value[index] === null || isAuraPerformanceRoutine(value[index]));
}

/** Copy valid slots independently so one malformed selection cannot affect its rival. */
export function normalizeAuraSelectedRoutines(value: unknown): AuraSelectedRoutines {
  const slot = (index: number): AuraPerformanceRoutine | null => {
    const routine: unknown = Array.isArray(value) && value.length === 2 ? value[index] : null;
    return isAuraPerformanceRoutine(routine) ? [...routine] : null;
  };
  return [slot(0), slot(1)];
}

export function resolveAuraPerformanceRoutine(
  seed: number,
  round: number,
  slot: 0 | 1,
  selections?: AuraSelectedRoutines,
): AuraPerformanceRoutine {
  const selected = selections?.[slot];
  if (!isAuraPerformanceRoutine(selected)) return createAuraPerformanceRoutine(seed, round);
  const move = selected[Math.min(2, Math.max(0, Math.floor(round)))];
  // The presentation still uses three beat phrases. A chosen round keeps its
  // single move across all of them instead of switching the gesture mid-turn.
  return [move, move, move];
}
