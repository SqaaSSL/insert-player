import { describe, expect, it } from 'vitest';
import {
  createAsyncEpochGuard,
  isCpuRosterSlot,
  personalityAfterFighterAssignment,
  shouldBlockTouchVersus,
} from './rosterMatch';

describe('roster match helpers', () => {
  it('shows personality controls only for CPU-controlled slots', () => {
    expect(isCpuRosterSlot('watch', 'p1')).toBe(true);
    expect(isCpuRosterSlot('watch', 'p2')).toBe(true);
    expect(isCpuRosterSlot('cpu', 'p1')).toBe(false);
    expect(isCpuRosterSlot('cpu', 'p2')).toBe(true);
    expect(isCpuRosterSlot('vs', 'p1')).toBe(false);
    expect(isCpuRosterSlot('vs', 'p2')).toBe(false);
  });

  it('keeps an explicit CPU personality when the fighter changes', () => {
    expect(personalityAfterFighterAssignment({
      current: 'balanced',
      fighterDefault: 'showboat',
      isCpu: true,
      wasExplicitlyChosen: true,
    })).toBe('balanced');
    expect(personalityAfterFighterAssignment({
      current: 'balanced',
      fighterDefault: 'showboat',
      isCpu: true,
      wasExplicitlyChosen: false,
    })).toBe('showboat');
  });

  it('blocks local Versus only for coarse-pointer layouts', () => {
    expect(shouldBlockTouchVersus('vs', true)).toBe(true);
    expect(shouldBlockTouchVersus('vs', false)).toBe(false);
    expect(shouldBlockTouchVersus('cpu', true)).toBe(false);
  });

  it('invalidates an async launch after cancel or unmount', () => {
    const guard = createAsyncEpochGuard();
    guard.mount();
    const first = guard.begin();
    expect(guard.isCurrent(first)).toBe(true);
    guard.cancel();
    expect(guard.isCurrent(first)).toBe(false);

    const second = guard.begin();
    expect(guard.isCurrent(second)).toBe(true);
    guard.unmount();
    expect(guard.isCurrent(second)).toBe(false);
  });
});
