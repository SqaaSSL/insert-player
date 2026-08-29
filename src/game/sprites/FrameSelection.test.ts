import { describe, expect, it } from 'vitest';
import { ATTACKS, FighterState } from '../constants.ts';
import { selectSourceFrameIndex } from './FrameSelection.ts';

function selectedIndices(
  state: FighterState,
  targetFrameCount: number,
  sourceFrameCount: number,
  isDirectAnimation = true,
): number[] {
  return Array.from(
    { length: targetFrameCount },
    (_, frameIndex) => selectSourceFrameIndex(
      state,
      isDirectAnimation,
      frameIndex,
      targetFrameCount,
      sourceFrameCount,
    ),
  );
}

describe('sprite frame selection', () => {
  it('puts HIGH_KICK impact in the active runtime slot and keeps recovery', () => {
    expect(selectedIndices(FighterState.HIGH_KICK, 4, 7)).toEqual([0, 3, 4, 6]);

    const attack = ATTACKS[FighterState.HIGH_KICK];
    const visualSlotDuration = Math.floor(
      (attack.startup + attack.active + attack.recovery) / 4,
    );
    expect(visualSlotDuration).toBe(6);
    expect(attack.startup).toBeGreaterThanOrEqual(visualSlotDuration);
    expect(attack.startup + attack.active).toBeLessThanOrEqual(visualSlotDuration * 2);
  });

  it.each([
    FighterState.HIGH_PUNCH,
    FighterState.LOW_PUNCH,
    FighterState.LOW_KICK,
  ])('preserves the impact midpoint for %s', (state) => {
    expect(selectedIndices(state, 3, 7)).toEqual([0, 3, 6]);
  });

  it('keeps direct one-to-one attack assets unchanged', () => {
    expect(selectedIndices(FighterState.HIGH_KICK, 4, 4)).toEqual([0, 1, 2, 3]);
  });

  it('retains the existing fallback for unexpected non-attack assets', () => {
    expect(selectedIndices(FighterState.HIT_STUN, 4, 7)).toEqual([0, 2, 4, 6]);
  });

  it('does not apply a direct attack profile to a fallback-filled state', () => {
    expect(selectedIndices(FighterState.HIGH_KICK, 4, 7, false)).toEqual([0, 2, 4, 6]);
  });

  it('retains looping sampling for idle and walk assets', () => {
    expect(selectedIndices(FighterState.IDLE, 4, 8)).toEqual([0, 2, 4, 6]);
    expect(selectedIndices(FighterState.WALK_FORWARD, 6, 16)).toEqual([0, 2, 5, 8, 10, 13]);
  });
});
