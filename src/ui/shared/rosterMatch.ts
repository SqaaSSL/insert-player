import type { FighterPersonalityId } from '../../game/match/MatchConfig.ts';

export type RosterMode = 'watch' | 'cpu' | 'vs';
export type RosterSlot = 'p1' | 'p2';

export function isCpuRosterSlot(mode: RosterMode, slot: RosterSlot): boolean {
  return mode === 'watch' || (mode === 'cpu' && slot === 'p2');
}

export function personalityAfterFighterAssignment({
  current,
  fighterDefault,
  isCpu,
  wasExplicitlyChosen,
}: {
  current: FighterPersonalityId;
  fighterDefault: FighterPersonalityId | null;
  isCpu: boolean;
  wasExplicitlyChosen: boolean;
}): FighterPersonalityId {
  if (!isCpu || wasExplicitlyChosen || !fighterDefault) return current;
  return fighterDefault;
}

export function shouldBlockTouchVersus(mode: RosterMode, hasCoarsePointer: boolean): boolean {
  return mode === 'vs' && hasCoarsePointer;
}

export interface AsyncEpochGuard {
  mount: () => void;
  begin: () => number;
  cancel: () => void;
  unmount: () => void;
  isCurrent: (epoch: number) => boolean;
}

export function createAsyncEpochGuard(): AsyncEpochGuard {
  let currentEpoch = 0;
  let mounted = false;
  return {
    mount() {
      mounted = true;
      currentEpoch += 1;
    },
    begin() {
      currentEpoch += 1;
      return currentEpoch;
    },
    cancel() {
      currentEpoch += 1;
    },
    unmount() {
      mounted = false;
      currentEpoch += 1;
    },
    isCurrent(epoch) {
      return mounted && currentEpoch === epoch;
    },
  };
}
