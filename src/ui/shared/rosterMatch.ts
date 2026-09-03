import type { FighterPersonalityId } from '../../game/match/MatchConfig.ts';

export type RosterMode = 'watch' | 'cpu' | 'vs' | 'rush';
export type RosterSlot = 'p1' | 'p2';
export type RosterSourceState = 'loading' | 'ready' | 'unavailable';

export interface RosterLoadPresentationInput {
  officialState: RosterSourceState;
  localState: RosterSourceState;
  officialCount: number;
  ownedCount: number;
  cloudSyncing?: boolean;
  cloudImported?: number;
  cloudUpdated?: number;
}

export interface RosterLoadPresentation {
  loaded: boolean;
  retryAvailable: boolean;
  message: string;
}

/**
 * Public Arcade and device storage are independent sources. In particular,
 * an IndexedDB timeout must never keep a successfully loaded public roster
 * behind the loading screen.
 */
export function rosterLoadPresentation({
  officialState,
  localState,
  officialCount,
  ownedCount,
  cloudSyncing = false,
  cloudImported = 0,
  cloudUpdated = 0,
}: RosterLoadPresentationInput): RosterLoadPresentation {
  const loaded = officialState !== 'loading' || (localState === 'ready' && ownedCount > 0);
  const retryAvailable = officialState === 'unavailable' || localState === 'unavailable';

  if (officialState === 'ready' && officialCount > 0) {
    const prefix = `${officialCount} official challenger${officialCount === 1 ? '' : 's'} ready`;
    if (localState === 'loading') return { loaded, retryAvailable, message: `${prefix} · Checking your fighters…` };
    if (localState === 'unavailable') return { loaded, retryAvailable, message: `${prefix} · Saved fighters need a retry` };
    if (cloudSyncing) return { loaded, retryAvailable, message: `${prefix} · Syncing your fighters…` };
    if (cloudImported > 0 || cloudUpdated > 0) {
      return {
        loaded,
        retryAvailable,
        message: `Cloud synced: ${cloudImported} imported, ${cloudUpdated} updated`,
      };
    }
    return { loaded, retryAvailable, message: prefix };
  }

  if (officialState === 'loading') {
    if (localState === 'ready' && ownedCount > 0) {
      return { loaded, retryAvailable, message: 'Your fighters are ready · Loading official challengers…' };
    }
    if (localState === 'unavailable') {
      return { loaded, retryAvailable, message: 'Loading official challengers… · Saved fighters need a retry' };
    }
    return { loaded, retryAvailable, message: 'Loading roster…' };
  }

  if (localState === 'ready' && ownedCount > 0) {
    return { loaded, retryAvailable, message: 'Official roster unavailable · Your fighters are ready' };
  }
  if (localState === 'loading') {
    return { loaded, retryAvailable, message: 'Official roster unavailable · Checking saved fighters…' };
  }
  return { loaded: true, retryAvailable, message: 'Roster sources unavailable. Retry when your connection is back.' };
}

export function isCpuRosterSlot(mode: RosterMode, slot: RosterSlot): boolean {
  return mode === 'watch' || ((mode === 'cpu' || mode === 'rush') && slot === 'p2');
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
