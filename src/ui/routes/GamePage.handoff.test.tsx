import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the component's actual effect handlers without adding a browser DOM
// dependency. Each flush commits the React element tree BEFORE running effects.
const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as (() => void)[], dirty: false }));
const runtime = vi.hoisted(() => ({ create: vi.fn(), destroy: vi.fn() }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: any) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { value: typeof initial === 'function' ? initial() : initial };
    return [hooks.slots[index].value, (update: any) => {
      const value = typeof update === 'function' ? update(hooks.slots[index].value) : update;
      if (!Object.is(value, hooks.slots[index].value)) { hooks.slots[index].value = value; hooks.dirty = true; }
    }];
  },
  useRef: (initial: any) => {
    const index = hooks.cursor++;
    return hooks.slots[index] ??= { current: initial };
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index];
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    const slot = { deps, cleanup: undefined as void | (() => void) };
    hooks.slots[index] = slot;
    hooks.effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect(); });
  },
}));
vi.mock('../../game/createGame.ts', () => ({ createGame: runtime.create }));
vi.mock('../../services/DebugLog.ts', () => ({ debugInfo: vi.fn(), debugWarn: vi.fn() }));
vi.mock('../../services/MatchReporting.ts', () => ({ reportMatchCompletion: vi.fn() }));

import { GamePage } from './GamePage.tsx';
import { FightLoadingCurtain } from '../components/FightLoadingCurtain.tsx';
import { AuraBattleResults } from '../components/AuraBattleResults.tsx';
import { AuraOnboardingHint } from '../components/AuraOnboardingHint.tsx';
import { AURA_ONBOARDING_EVENT } from '../../game/aura/AuraOnboarding.ts';
import { AURA_BATTLE_COMPLETE_EVENT, MATCH_ACTIONS_VISIBILITY_EVENT } from '../../game/match/MatchConfig.ts';
import { AuraControls } from '../components/AuraControls.tsx';
import { AURA_PRESENTATION_EVENT, AURA_PRESENTATION_START_EVENT, AURA_PRESENTATION_TURN_EVENT } from '../../game/aura/AuraPresentationEvents.ts';
import { RUNTIME_READY_EVENT } from '../../game/match/MatchConfig.ts';
import { AURA_PLAZA_ASSET_PATH, getStageTheme } from '../../game/match/StageConfig.ts';

let props: Parameters<typeof GamePage>[0];
let committed: ReactNode;
let viewport: EventTarget & { innerWidth: number; innerHeight: number };
let starts: unknown[];
const find = (predicate: (node: any) => boolean, node: any = committed): any => {
  if (!node) return undefined;
  if (Array.isArray(node)) return node.map(child => find(predicate, child ?? null)).find(Boolean);
  if (typeof node !== 'object') return undefined;
  if (predicate(node)) return node;
  return find(predicate, node.props?.children ?? null);
};
const curtain = () => find(node => node.type === FightLoadingCurtain);
const flush = () => {
  let renders = 0;
  do {
    if (++renders > 20) throw new Error('Unstable hook render loop');
    hooks.dirty = false; hooks.cursor = 0;
    committed = GamePage(props);
    const effects = hooks.effects.splice(0);
    for (const effect of effects) effect();
  } while (hooks.dirty);
};
const emit = (phase: 'loading' | 'ready' | 'error', token = 1, seed = 17, localControlledSlot?: 0 | 1) => {
  viewport.dispatchEvent(new CustomEvent(AURA_PRESENTATION_EVENT, { detail: { phase, token, seed, localControlledSlot } }));
  flush();
};
const advance = (ms: number) => { vi.advanceTimersByTime(ms); flush(); };
const mount = async (sceneKey = 'AuraScene', data = {}) => {
  props.launchTarget = { sceneKey, data };
  flush();
  await vi.dynamicImportSettled();
};
const finishOpening = () => {
  const aura = props.launchTarget.sceneKey === 'AuraScene';
  advance(aura ? 3000 : 1100);
  expect(curtain()?.props.phase).toBe('opening');
  advance(aura ? 1000 : 720);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  hooks.slots = []; hooks.effects = []; hooks.dirty = false; hooks.cursor = 0;
  runtime.create.mockReset().mockReturnValue({ destroy: runtime.destroy }); runtime.destroy.mockReset();
  viewport = Object.assign(new EventTarget(), {
    innerWidth: 390, innerHeight: 844,
    matchMedia: () => ({ matches: false }),
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    location: { search: '' },
    localStorage: { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn() },
  });
  vi.stubGlobal('window', viewport);
  vi.stubGlobal('screen', { orientation: { lock: vi.fn(), unlock: vi.fn() } });
  vi.stubGlobal('document', { fullscreenElement: null });
  props = { launchTarget: { sceneKey: 'AuraScene', data: {} }, onComplete: vi.fn(), onExit: vi.fn(), onCreateFighter: vi.fn(), onOpenArcade: vi.fn() };
  starts = [];
  viewport.addEventListener(AURA_PRESENTATION_START_EVENT, event => {
    // This catches starting from the hide timer before React's next commit.
    expect(curtain()).toBeUndefined();
    starts.push((event as CustomEvent).detail);
  });
});
afterEach(() => {
  for (const slot of hooks.slots) slot?.cleanup?.();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('GamePage Aura presentation handoff', () => {
  it('shows Aura Plaza for an unspecified stage, including a different-seed remix', async () => {
    await mount('AuraScene', { gameMode: 'aura', seed: 17 });
    expect(curtain().props).toMatchObject({ stageLabel: 'AURA PLAZA', stageImageUrl: AURA_PLAZA_ASSET_PATH });
    emit('loading', 1, 17); emit('ready', 1, 17); finishOpening();
    emit('loading', 2, 99);
    expect(curtain().props).toMatchObject({ stageLabel: 'AURA PLAZA', stageImageUrl: AURA_PLAZA_ASSET_PATH });
  });
  it.each([
    { data: { stageId: 'executive-rumble' }, label: 'EXECUTIVE RUMBLE' },
    { data: { stageId: 'executive-rumble', customStageKey: 'my-photo', customStageLabel: 'My photo' }, label: 'My photo' },
  ])('preserves the explicit stage and custom label while loading $label', async ({ data, label }) => {
    await mount('AuraScene', { gameMode: 'aura', seed: 17, ...data });
    expect(curtain().props).toMatchObject({
      stageLabel: label, stageImageUrl: getStageTheme('executive-rumble').assetPath,
    });
  });
  it('holds a cached face-off for three seconds and finishes the full opening before starting', async () => {
    await mount(); emit('loading'); emit('ready');
    advance(2999); expect(curtain().props.phase).toBe('loading'); expect(starts).toEqual([]);
    advance(1); expect(curtain().props.phase).toBe('opening');
    advance(999); expect(curtain().props.phase).toBe('opening'); expect(starts).toEqual([]);
    advance(1); expect(curtain()).toBeUndefined(); expect(starts).toEqual([{ token: 1, seed: 17 }]);
  });
  it('leaves time to see the fighters even when loading has already exceeded three seconds', async () => {
    await mount(); emit('loading'); advance(4000); emit('ready');
    advance(1499); expect(curtain().props.phase).toBe('loading'); expect(starts).toEqual([]);
    advance(1); expect(curtain().props.phase).toBe('opening');
    advance(999); expect(starts).toEqual([]);
    advance(1); expect(curtain()).toBeUndefined(); expect(starts).toHaveLength(1);
  });
  it('keeps the readable hold but uses the short opening for reduced motion', async () => {
    Object.assign(viewport, { matchMedia: (query: string) => ({ matches: query.includes('prefers-reduced-motion') }) });
    await mount(); emit('loading'); emit('ready');
    advance(2999); expect(curtain().props.phase).toBe('loading');
    advance(1); expect(curtain().props.phase).toBe('opening');
    advance(179); expect(starts).toEqual([]);
    advance(1); expect(curtain()).toBeUndefined(); expect(starts).toHaveLength(1);
  });
  it('ignores legacy ready and starts once only after the curtain is committed absent', async () => {
    await mount();
    viewport.dispatchEvent(new Event(RUNTIME_READY_EVENT)); advance(2000);
    expect(curtain().props.phase).toBe('loading'); expect(starts).toEqual([]);
    emit('ready'); advance(100); expect(starts).toEqual([]);
    emit('loading'); emit('ready'); finishOpening();
    expect(starts).toEqual([{ token: 1, seed: 17 }]);
    emit('ready'); flush(); advance(5000);
    expect(starts).toHaveLength(1);
  });
  it('reopens on a same-seed rematch and rejects old or mismatched signals', async () => {
    await mount(); emit('loading'); emit('ready'); finishOpening();
    emit('loading', 2); expect(curtain().props.phase).toBe('loading');
    emit('ready', 1); emit('ready', 2, 99); advance(2000);
    expect(curtain().props.phase).toBe('loading'); expect(starts).toHaveLength(1);
    emit('ready', 2); advance(1499); // Late readiness still gets a readable hold.
    expect(curtain().props.phase).toBe('loading'); expect(starts).toHaveLength(1);
    advance(1); expect(curtain().props.phase).toBe('opening'); advance(1000);
    expect(starts).toEqual([{ token: 1, seed: 17 }, { token: 2, seed: 17 }]);
    expect(runtime.create).toHaveBeenCalledTimes(1);
  });
  it('an asset failure during opening cancels the pending start', async () => {
    await mount(); emit('loading'); emit('ready'); advance(3000);
    emit('error'); advance(2000); emit('ready');
    expect(curtain().props.phase).toBe('error'); expect(starts).toEqual([]);
  });
  it('times out honestly and cannot be revived by late ready for the failed lifecycle', async () => {
    await mount(); emit('loading'); advance(30000);
    expect(curtain().props.phase).toBe('error');
    emit('ready'); advance(2000); expect(starts).toEqual([]);
    emit('loading', 2); emit('ready', 2); finishOpening();
    expect(starts).toEqual([{ token: 2, seed: 17 }]);
  });
  it('orientation changes only the shell and do not remount a live recording/match', async () => {
    await mount(); emit('loading'); emit('ready'); finishOpening();
    expect((committed as any).props.className).toContain('is-portrait');
    viewport.innerWidth = 844; viewport.innerHeight = 390;
    viewport.dispatchEvent(new Event('resize')); flush();
    expect((committed as any).props.className).not.toContain('is-portrait');
    expect(runtime.create).toHaveBeenCalledTimes(1);
    expect(runtime.destroy).not.toHaveBeenCalled(); expect(starts).toHaveLength(1);
  });
  it('uses the active local performer and disables touch inputs while paused', async () => {
    await mount('AuraScene', { vsAI: false }); emit('loading'); emit('ready'); finishOpening();
    viewport.dispatchEvent(new CustomEvent(AURA_PRESENTATION_TURN_EVENT, { detail: { token: 1, seed: 17, playerIndex: 1 } })); flush();
    expect(find(node => node.type === AuraControls).props.playerIndex).toBe(1);
    find(node => node.props?.['aria-label'] === 'Pause').props.onClick(); flush();
    expect(find(node => node.type === AuraControls).props.disabled).toBe(true);
    expect(find(node => node.props?.['aria-label'] === 'Game paused')).toBeDefined();
  });
  it('keeps the authenticated local slot for online controls, irrespective of turn', async () => {
    await mount('AuraScene', { online: { localSlot: 1 } }); emit('loading'); emit('ready'); finishOpening();
    viewport.dispatchEvent(new CustomEvent(AURA_PRESENTATION_TURN_EVENT, { detail: { token: 1, seed: 17, playerIndex: 0 } })); flush();
    expect(find(node => node.type === AuraControls).props.playerIndex).toBe(1);
    expect(find(node => node.props?.['aria-label'] === 'Pause')).toBeUndefined();
    expect(starts).toEqual([{ token: 1, seed: 17 }]);
  });
  it('preserves a P2 challenge human through retries and changes to P1 on a fresh remix lifecycle', async () => {
    await mount('AuraScene', { vsAI: true, auraChallenge: { slot: 1 } });
    emit('loading', 1, 17, 1); emit('ready', 1, 17, 1); finishOpening();
    viewport.dispatchEvent(new CustomEvent(AURA_PRESENTATION_TURN_EVENT, { detail: { token: 1, seed: 17, playerIndex: 0 } })); flush();
    expect(find(node => node.type === AuraControls).props.playerIndex).toBe(1);
    emit('loading', 2, 17, 1); emit('ready', 2, 17, 1); finishOpening();
    expect(find(node => node.type === AuraControls).props.playerIndex).toBe(1);
    emit('loading', 3, 18, 0); emit('ready', 3, 18, 0); finishOpening();
    expect(find(node => node.type === AuraControls).props.playerIndex).toBe(0);
    emit('loading', 2, 17, 1);
    expect(find(node => node.type === AuraControls).props.playerIndex).toBe(0);
  });
  it.each(['FightScene', 'RushScene'])('preserves the legacy ready handoff for %s', async sceneKey => {
    await mount(sceneKey); viewport.dispatchEvent(new Event(RUNTIME_READY_EVENT)); finishOpening();
    expect(curtain()).toBeUndefined(); expect(starts).toEqual([]);
  });
  it('guides the first solo battle, accepts only current tips and remembers explicit completion', async () => {
    await mount('AuraScene', { gameMode: 'aura', vsAI: true, experience: 'trial' });
    emit('loading'); emit('ready'); finishOpening();
    expect(starts).toEqual([{ token: 1, seed: 17, onboarding: true }]);
    const tip = { token: 1, seed: 17, phase: 'practice', cue: 'hit', practiceLane: 0, completedLanes: 0, laneKeys: ['D', 'F', 'J', 'K'] };
    viewport.dispatchEvent(new CustomEvent(AURA_ONBOARDING_EVENT, { detail: { ...tip, token: 99 } })); flush();
    expect(find(node => node.type === AuraOnboardingHint)).toBeUndefined();
    viewport.dispatchEvent(new CustomEvent(AURA_ONBOARDING_EVENT, { detail: tip })); flush();
    expect(find(node => node.type === AuraOnboardingHint).props.detail).toEqual(tip);
    expect(find(node => node.type === AuraControls).props.disabled).toBe(false);
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
    viewport.dispatchEvent(new CustomEvent(AURA_ONBOARDING_EVENT, { detail: { ...tip, phase: 'skipped', cue: null, practiceLane: null } })); flush();
    expect(find(node => node.type === AuraOnboardingHint)).toBeUndefined();
    expect(window.localStorage.setItem).toHaveBeenCalledWith('ip:aura-first-battle:v1', 'done');
    emit('loading', 2); emit('ready', 2); finishOpening();
    expect(starts[1]).toEqual({ token: 2, seed: 17 });
  });
  it('never adds practice to a challenge, spectator, local duel or online battle', async () => {
    for (const data of [{ auraChallenge: { slot: 0 } }, { cpuVsCpu: true }, { vsAI: false }, { online: { localSlot: 0 } }]) {
      await mount('AuraScene', { gameMode: 'aura', ...data });
      const token = starts.length + 1;
      emit('loading', token); emit('ready', token); finishOpening();
      expect(starts.at(-1)).toEqual({ token, seed: 17 });
    }
  });
  it('shows only the Aura result after a trial, with its Rookie creation action', async () => {
    await mount('AuraScene', { gameMode: 'aura', vsAI: true, experience: 'trial' });
    emit('loading'); emit('ready'); finishOpening();
    viewport.dispatchEvent(new CustomEvent(AURA_BATTLE_COMPLETE_EVENT, { detail: { winnerSlot: 'p1' } }));
    viewport.dispatchEvent(new CustomEvent(MATCH_ACTIONS_VISIBILITY_EVENT, { detail: { visible: true } })); flush();
    expect(find(node => node.props?.['aria-label'] === 'Free round complete')).toBeUndefined();
    expect(find(node => node.type === AuraBattleResults)?.props).toMatchObject({ trial: true, onCreatePlayer: props.onCreateFighter });
  });
  it('unmount disposes timers so a pending opening never starts', async () => {
    await mount(); emit('loading'); emit('ready'); advance(3000);
    for (const slot of hooks.slots) { slot?.cleanup?.(); if (slot) slot.cleanup = undefined; }
    vi.advanceTimersByTime(5000);
    expect(starts).toEqual([]); expect(runtime.destroy).toHaveBeenCalledExactlyOnceWith(true);
  });
});
