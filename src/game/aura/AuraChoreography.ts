import {
  AURA_ROUTINE_ANIMATION_NAMES,
  createAuraPerformanceRoutine,
  type AuraPerformanceRoutine,
} from './AuraPerformance.ts';

/** Three chosen gestures within one round, in performance order. */
export type AuraRoundSelection = AuraPerformanceRoutine;

/** All nine positions: three rounds, each containing three gestures. */
export type AuraMatchSelection = readonly [AuraRoundSelection, AuraRoundSelection, AuraRoundSelection];

/** A null player slot keeps the legacy seeded routine within each round. */
export type AuraSelectedRoutines = readonly [AuraMatchSelection | null, AuraMatchSelection | null];

export function isAuraPerformanceRoutine(value: unknown): value is AuraPerformanceRoutine {
  return Array.isArray(value) && value.length === 3
    && [0, 1, 2].every(index => AURA_ROUTINE_ANIMATION_NAMES.includes(value[index]));
}

export function isAuraMatchSelection(value: unknown): value is AuraMatchSelection {
  return Array.isArray(value) && value.length === 3
    && [0, 1, 2].every(index => isAuraPerformanceRoutine(value[index]));
}

export function isAuraSelectedRoutines(value: unknown): value is AuraSelectedRoutines {
  return Array.isArray(value) && value.length === 2
    && [0, 1].every(index => value[index] === null || isAuraMatchSelection(value[index]));
}

/** Copy valid slots independently so one malformed selection cannot affect its rival. */
export function normalizeAuraSelectedRoutines(value: unknown): AuraSelectedRoutines {
  const slot = (index: number): AuraMatchSelection | null => {
    const routine: unknown = Array.isArray(value) && value.length === 2 ? value[index] : null;
    return isAuraMatchSelection(routine) ? [[...routine[0]], [...routine[1]], [...routine[2]]] : null;
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
  return isAuraMatchSelection(selected)
    ? selected[Math.min(2, Math.max(0, Math.floor(round)))]
    : createAuraPerformanceRoutine(seed, round);
}
