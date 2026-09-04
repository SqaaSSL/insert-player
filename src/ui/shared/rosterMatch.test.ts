import { describe, expect, it } from 'vitest';
import {
  createAsyncEpochGuard,
  isCpuRosterSlot,
  personalityAfterFighterAssignment,
  rosterLoadPresentation,
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
    expect(isCpuRosterSlot('rush', 'p1')).toBe(false);
    expect(isCpuRosterSlot('rush', 'p2')).toBe(true);
    expect(isCpuRosterSlot('aura', 'p1')).toBe(false);
    expect(isCpuRosterSlot('aura', 'p2')).toBe(true);
    expect(isCpuRosterSlot('aura-vs', 'p2')).toBe(false);
    expect(isCpuRosterSlot('aura-watch', 'p1')).toBe(true);
    expect(isCpuRosterSlot('aura-watch', 'p2')).toBe(true);
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
    expect(shouldBlockTouchVersus('rush', true)).toBe(false);
    expect(shouldBlockTouchVersus('rush', false)).toBe(false);
    expect(shouldBlockTouchVersus('cpu', true)).toBe(false);
    expect(shouldBlockTouchVersus('aura-vs', true)).toBe(true);
    expect(shouldBlockTouchVersus('aura', true)).toBe(false);
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

  it('renders official fighters without waiting for IndexedDB', () => {
    expect(rosterLoadPresentation({
      officialState: 'ready',
      localState: 'loading',
      officialCount: 4,
      ownedCount: 0,
    })).toEqual({
      loaded: true,
      retryAvailable: false,
      message: '4 official challengers ready · Checking your fighters…',
    });
  });

  it('offers a retry after local storage fails while keeping globals ready', () => {
    expect(rosterLoadPresentation({
      officialState: 'ready',
      localState: 'unavailable',
      officialCount: 4,
      ownedCount: 0,
    })).toEqual({
      loaded: true,
      retryAvailable: true,
      message: '4 official challengers ready · Saved fighters need a retry',
    });
  });

  it('clears the retry state when a late local recovery succeeds', () => {
    expect(rosterLoadPresentation({
      officialState: 'ready',
      localState: 'ready',
      officialCount: 4,
      ownedCount: 1,
    })).toEqual({
      loaded: true,
      retryAvailable: false,
      message: '4 official challengers ready',
    });
  });
});
