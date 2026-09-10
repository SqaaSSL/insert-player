import {
  AURA_ANIMATION_NAMES,
  type AuraAnimationName,
  type AuraPackAnimationName,
} from '../../services/FighterAssetPacks.ts';
import { SeededRng } from '../utils/SeededRng.ts';

export interface AuraPerformanceDefinition {
  name: AuraAnimationName;
  label: string;
  durationMs: number;
  loop: boolean;
}

export const AURA_PERFORMANCE_DEFINITIONS: Readonly<Record<AuraAnimationName, AuraPerformanceDefinition>> = {
  aura_unbothered: {
    name: 'aura_unbothered',
    label: 'UNBOTHERED',
    durationMs: 1_600,
    loop: true,
  },
  aura_six_seven: {
    name: 'aura_six_seven',
    label: '6-7',
    durationMs: 1_050,
    loop: true,
  },
  aura_mog_check: {
    name: 'aura_mog_check',
    label: 'MOG CHECK',
    durationMs: 1_250,
    loop: true,
  },
  aura_glide: {
    name: 'aura_glide',
    label: 'GLIDE',
    durationMs: 1_400,
    loop: true,
  },
  aura_floor_worm: {
    name: 'aura_floor_worm',
    label: 'FLOOR WORM',
    durationMs: 1_700,
    loop: true,
  },
  aura_one_leg: {
    name: 'aura_one_leg',
    label: 'ONE-LEG HOP',
    durationMs: 1_250,
    loop: true,
  },
  aura_shrug: {
    name: 'aura_shrug',
    label: 'WHAT WAS THAT?',
    durationMs: 980,
    loop: true,
  },
};

export const AURA_ROUTINE_ANIMATION_NAMES = AURA_ANIMATION_NAMES.filter(
  (name): name is Exclude<AuraPackAnimationName, 'aura_unbothered'> => name !== 'aura_unbothered',
);

export type AuraRoutineAnimationName = typeof AURA_ROUTINE_ANIMATION_NAMES[number];
export type AuraPerformanceRoutine = readonly [
  AuraRoutineAnimationName,
  AuraRoutineAnimationName,
  AuraRoutineAnimationName,
];

/**
 * Both performers receive the same three phrases in a round, just as they
 * receive the same note chart. The visual routine is seeded independently
 * from scoring and never enters rollback state.
 */
export function createAuraPerformanceRoutine(seed: number, round: number): AuraPerformanceRoutine {
  const normalizedSeed = (seed >>> 0) || 0x41555241;
  const rng = new SeededRng((normalizedSeed ^ 0x504f5345 ^ Math.imul(round + 1, 0x9e3779b1)) >>> 0);
  const shuffled = [...AURA_ROUTINE_ANIMATION_NAMES];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = rng.nextInt(0, index);
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return [shuffled[0], shuffled[1], shuffled[2]];
}

/** Split the sixteen-beat challenge into three readable dance phrases. */
export function auraPerformanceAtBeat(
  routine: AuraPerformanceRoutine,
  beat: number,
): AuraRoutineAnimationName {
  const segment = Math.min(2, Math.max(0, Math.floor((Math.max(0, beat) * 3) / 16)));
  return routine[segment];
}
