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
  useMemo: (factory: () => unknown, deps: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index];
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return previous.value;
    const value = factory(); hooks.slots[index] = { value, deps }; return value;
  },
  useRef: (initial: any) => {
    const index = hooks.cursor++;
    return hooks.slots[index] ??= { current: initial };
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index];
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    const slot = { deps, setup: effect, cleanup: undefined as void | (() => void) };
    hooks.slots[index] = slot;
    hooks.effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect(); });
  },
}));
vi.mock('../../game/createGame.ts', () => ({ createGame: runtime.create }));
vi.mock('../../services/DebugLog.ts', () => ({ debugInfo: vi.fn(), debugWarn: vi.fn() }));
vi.mock('../../services/MatchReporting.ts', () => ({ reportMatchCompletion: vi.fn() }));

import { AURA_CAPTURE_EVENT } from '../../game/aura/AuraCapture.ts';
import { BATTLE_CAPTURE_EVENT } from '../../game/match/BattleCapture.ts';
import { GamePage } from './GamePage.tsx';
import { FightLoadingCurtain } from '../components/FightLoadingCurtain.tsx';
import { AuraBattleResults } from '../components/AuraBattleResults.tsx';
import { AuraOnboardingHint } from '../components/AuraOnboardingHint.tsx';
import { AuraStartReady } from '../components/AuraStartReady.tsx';
import { AuraRoutineEditor } from '../components/AuraRoutineEditor.tsx';
import { CombatStartReady } from '../components/CombatStartReady.tsx';
import { FightControlsHint } from '../components/FightControlsHint.tsx';
import { MATCH_START_EVENT, AURA_REMATCH_CONFIG_EVENT, NET_STATE_EVENT } from '../../game/match/MatchConfig.ts';
import { setActiveOnlineSession } from '../../game/net/onlineSession.ts';
import { AURA_ONBOARDING_EVENT } from '../../game/aura/AuraOnboarding.ts';
import { AURA_STARTUP_EVENT, AURA_STARTUP_READY_EVENT } from '../../game/aura/AuraStartup.ts';
import { AURA_BATTLE_COMPLETE_EVENT, AURA_INPUT_EVENT, MATCH_ACTIONS_VISIBILITY_EVENT } from '../../game/match/MatchConfig.ts';
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
const startup = (phase: 'awaiting-input' | 'preparing' | 'versus' | 'countdown' | 'playing', count: number | null = null, token = 1, seed = 17,
  instrumentVisible = phase === 'countdown' || phase === 'playing') => {
  viewport.dispatchEvent(new CustomEvent(AURA_STARTUP_EVENT, {
    detail: { token, seed, phase, count, instrumentVisible, remainingMs: count === null ? 0 : count * 1000 },
  })); flush();
};
const advance = (ms: number) => { vi.advanceTimersByTime(ms); flush(); };
const mockOnlineSession = () => {
  const transport = {
    onControl: vi.fn().mockReturnValue(vi.fn()),
    onState: vi.fn(listener => { listener({ phase: 'connected', peerPresent: true }); return vi.fn(); }),
    sendControl: vi.fn(), close: vi.fn(),
  };
  setActiveOnlineSession({ transport } as any);
  return transport;
};
const mount = async (sceneKey = 'AuraScene', data = {}) => {
  if ('online' in data) mockOnlineSession();
  props.launchTarget = { sceneKey, data };
  flush();
  await vi.dynamicImportSettled();
};
const finishOpening = () => {
  const aura = props.launchTarget.sceneKey === 'AuraScene';
  advance(aura ? 600 : 1100);
  expect(curtain()?.props.phase).toBe('opening');
  advance(aura ? 300 : 720);
};

describe('combat cabinet start', () => {
  it.each(['FightScene', 'RushScene'])('keeps controls visible and waits for Play on every %s match', async sceneKey => {
    const combatStarts: unknown[] = [];
    viewport.addEventListener(MATCH_START_EVENT, event => combatStarts.push((event as CustomEvent).detail));
    await mount(sceneKey, { vsAI: true });
    const ready = (startToken: number) => {
      viewport.dispatchEvent(new CustomEvent(RUNTIME_READY_EVENT, { detail: { sceneKey, startToken } })); flush();
    };
    expect(find(node => node.type === FightControlsHint)).toBeDefined();
    expect(find(node => node.type === FightControlsHint).props.disabled).toBe(true);
    ready(1); finishOpening(); advance(60_000);
    expect(find(node => node.type === FightControlsHint).props.disabled).toBe(false);
    expect(find(node => node.type === FightControlsHint).props.inputResetKey).toBe(1);
    expect(combatStarts).toEqual([]);
    const start = find(node => node.type === CombatStartReady).props.onStart;
    start(); start(); flush();
    expect(combatStarts).toEqual([{ sceneKey, startToken: 1 }]);
    expect(find(node => node.type === CombatStartReady)).toBeUndefined();
    expect(find(node => node.type === FightControlsHint)).toBeDefined();
    expect(find(node => node.type === FightControlsHint).props.inputResetKey).toBe(0);
    ready(1);
    expect(find(node => node.type === CombatStartReady)).toBeUndefined();
    ready(2);
    expect(find(node => node.type === CombatStartReady)).toBeDefined();
    start(); flush();
    expect(combatStarts).toHaveLength(1);
    find(node => node.type === CombatStartReady).props.onStart(); flush();
    expect(combatStarts).toHaveLength(2);
  });

  it.each([{ cpuVsCpu: true }, { online: { localSlot: 0 } }])('keeps automatic startup for spectators and online matches: %j', async data => {
    await mount('FightScene', data);
    viewport.dispatchEvent(new CustomEvent(RUNTIME_READY_EVENT, { detail: { sceneKey: 'FightScene', startToken: 1 } }));
    flush(); finishOpening();
    expect(find(node => node.type === CombatStartReady)).toBeUndefined();
  });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  hooks.slots = []; hooks.effects = []; hooks.dirty = false; hooks.cursor = 0;
  runtime.create.mockReset().mockReturnValue({ destroy: runtime.destroy }); runtime.destroy.mockReset();
  setActiveOnlineSession(null);
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
  it('finishes the short loading transition before handing over to the canvas intro', async () => {
    await mount(); emit('loading'); emit('ready');
    advance(599); expect(curtain().props.phase).toBe('loading'); expect(starts).toEqual([]);
    advance(1); expect(curtain().props.phase).toBe('opening');
    advance(299); expect(curtain().props.phase).toBe('opening'); expect(starts).toEqual([]);
    advance(1); expect(curtain()).toBeUndefined(); expect(starts).toEqual([{ token: 1, seed: 17 }]);
  });
  it('opens immediately after slow assets become ready instead of adding a fake loading hold', async () => {
    await mount(); emit('loading'); advance(4000); emit('ready');
    advance(0); expect(curtain().props.phase).toBe('opening'); expect(starts).toEqual([]);
    advance(299); expect(starts).toEqual([]);
    advance(1); expect(curtain()).toBeUndefined(); expect(starts).toHaveLength(1);
  });
  it('respects the reduced-motion opening before the canvas introduction', async () => {
    Object.assign(viewport, { matchMedia: (query: string) => ({ matches: query.includes('prefers-reduced-motion') }) });
    await mount(); emit('loading'); emit('ready');
    advance(599); expect(curtain().props.phase).toBe('loading');
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
    emit('ready', 2); advance(0);
    expect(curtain().props.phase).toBe('opening'); expect(starts).toHaveLength(1);
    advance(300);
    expect(starts).toEqual([{ token: 1, seed: 17 }, { token: 2, seed: 17 }]);
    expect(runtime.create).toHaveBeenCalledTimes(1);
  });
  it('an asset failure during opening cancels the pending start', async () => {
    await mount(); emit('loading'); emit('ready'); advance(600);
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
    expect(find(node => node.props?.className?.startsWith('game-shell')).props.className).toContain('is-portrait');
    viewport.innerWidth = 844; viewport.innerHeight = 390;
    viewport.dispatchEvent(new Event('resize')); flush();
    expect(find(node => node.props?.className?.startsWith('game-shell')).props.className).not.toContain('is-portrait');
    expect(runtime.create).toHaveBeenCalledTimes(1);
    expect(runtime.destroy).not.toHaveBeenCalled(); expect(starts).toHaveLength(1);
  });
  it('uses the active local performer and disables touch inputs while paused', async () => {
    await mount('AuraScene', { vsAI: false }); emit('loading'); emit('ready'); finishOpening();
    startup('playing');
    viewport.dispatchEvent(new CustomEvent(AURA_PRESENTATION_TURN_EVENT, { detail: { token: 1, seed: 17, playerIndex: 1 } })); flush();
    expect(find(node => node.type === AuraControls).props.playerIndex).toBe(1);
    find(node => node.props?.['aria-label'] === 'Pause').props.onClick(); flush();
    expect(find(node => node.type === AuraControls).props.disabled).toBe(true);
    expect(find(node => node.props?.['aria-label'] === 'Game paused')).toBeDefined();
  });
  it('locks solo touch pads during the rival turn and reopens them on the next human turn', async () => {
    await mount('AuraScene', { vsAI: true }); emit('loading', 1, 17, 0); emit('ready', 1, 17, 0); finishOpening();
    startup('playing');
    const turn = (playerIndex: 0 | 1, token = 1) => {
      viewport.dispatchEvent(new CustomEvent(AURA_PRESENTATION_TURN_EVENT, { detail: { token, seed: 17, playerIndex } })); flush();
    };
    turn(1);
    let controls = find(node => node.type === AuraControls);
    expect(controls.props.playerIndex).toBe(0);
    expect(controls.props.rivalTurn).toBe(true);
    expect(AuraControls(controls.props).props.children.every((button: any) => button.props.disabled)).toBe(true);
    turn(0, 99);
    expect(find(node => node.type === AuraControls).props.rivalTurn).toBe(true);
    turn(0);
    controls = find(node => node.type === AuraControls);
    expect(controls.props.rivalTurn).toBe(false);
    expect(AuraControls(controls.props).props.children.every((button: any) => !button.props.disabled)).toBe(true);
  });
  it('keeps touch pads out of the intro until the scene reveals the instrument, without hiding exit or pause', async () => {
    await mount('AuraScene', { vsAI: true }); emit('loading'); emit('ready'); finishOpening();
    expect(find(node => node.type === AuraControls)).toBeUndefined();
    for (const phase of ['preparing', 'versus'] as const) {
      startup(phase);
      expect(find(node => node.type === AuraControls)).toBeUndefined();
      expect(find(node => node.props?.className === 'aura-game-toolbar__back')).toBeDefined();
      expect(find(node => node.props?.['aria-label'] === 'Pause')).toBeDefined();
    }
    // The camera finishes while the same musical phase/count is still active.
    // Visibility must not be lost by the startup-event render deduplication.
    startup('versus', null, 1, 17, true);
    expect(find(node => node.type === AuraControls).props.disabled).toBe(true);
    startup('versus', null, 99, 17, false);
    expect(find(node => node.type === AuraControls)).toBeDefined();
    startup('countdown', 3, 1, 17, true);
    expect(find(node => node.type === AuraControls).props.disabled).toBe(false);
    startup('playing', null, 1, 17, false);
    expect(find(node => node.type === AuraControls)).toBeUndefined();
  });
  it('announces the current musical countdown and rejects signals from another lifecycle', async () => {
    await mount('AuraScene', { vsAI: true }); emit('loading'); emit('ready'); finishOpening();
    expect(find(node => node.type === AuraControls)).toBeUndefined();
    startup('countdown', 3);
    expect(find(node => node.props?.role === 'status' && node.props?.className === 'sr-only')?.props.children).toBe('Get ready. 3.');
    startup('playing', null, 99);
    expect(find(node => node.props?.role === 'status' && node.props?.className === 'sr-only')?.props.children).toBe('Get ready. 3.');
    expect(find(node => node.type === AuraControls).props.disabled).toBe(false);
    startup('playing', null);
    expect(find(node => node.type === AuraControls).props.disabled).toBe(false);
    emit('loading', 2);
    expect(find(node => node.props?.role === 'status' && node.props?.className === 'sr-only')).toBeUndefined();
    startup('playing', null);
    emit('ready', 2); finishOpening();
    expect(find(node => node.type === AuraControls)).toBeUndefined();
  });
  it.each([
    { mode: 'offline', data: { vsAI: true }, acceptsCountdown: true, slot: 0 },
    { mode: 'online', data: { online: { localSlot: 1 } }, acceptsCountdown: false, slot: 1 },
  ])('$mode touch controls respect the first note timing at the countdown boundary', async ({ data, acceptsCountdown, slot }) => {
    await mount('AuraScene', data); emit('loading'); emit('ready'); finishOpening();
    const input = vi.fn();
    viewport.addEventListener(AURA_INPUT_EVENT, input);
    const pressCircle = () => {
      const controls = find(node => node.type === AuraControls);
      if (!controls) return;
      AuraControls(controls.props).props.children[0].props.onPointerDown({ preventDefault: vi.fn() });
    };
    startup('awaiting-input'); pressCircle();
    expect(input).not.toHaveBeenCalled();
    startup('countdown', 1, 1, 17, acceptsCountdown); pressCircle();
    expect(input).toHaveBeenCalledTimes(acceptsCountdown ? 1 : 0);
    if (acceptsCountdown) expect(input.mock.calls[0][0].detail).toEqual({ lane: 0, playerIndex: slot });
    input.mockClear();
    startup('playing'); pressCircle();
    expect(input.mock.calls[0][0].detail).toEqual({ lane: 0, playerIndex: slot });
  });
  it('waits for an explicit practice choice and sends the current lifecycle identity', async () => {
    await mount('AuraScene', { gameMode: 'aura', vsAI: true, p1Name: 'Trump', p2Name: 'Rosalía' });
    emit('loading'); emit('ready'); finishOpening();
    const ready = vi.fn();
    viewport.addEventListener(AURA_STARTUP_READY_EVENT, ready);
    startup('awaiting-input');
    expect(ready).not.toHaveBeenCalled();
    expect(find(node => node.type === AuraControls)).toBeUndefined();
    expect(find(node => node.type === AuraOnboardingHint)).toBeUndefined();
    const choice = find(node => node.type === AuraStartReady);
    expect(choice.props).toMatchObject({ playerName: 'Trump', rivalName: 'Rosalía', practiceAvailable: true, practiceRecommended: true });
    expect(find(node => node.props?.['aria-label'] === 'Aura match controls')).toBeUndefined();
    expect(find(node => node.props?.role === 'status' && node.props?.className === 'sr-only')).toBeUndefined();
    choice.props.onStart(true);
    expect(ready.mock.calls[0][0].detail).toEqual({ token: 1, seed: 17, practice: true });
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
    emit('error');
    expect(curtain().props.phase).toBe('error');
    expect(find(node => node.type === AuraStartReady)).toBeUndefined();
  });
  it('lets a first-time player start the duel directly and remembers that explicit choice', async () => {
    await mount('AuraScene', { gameMode: 'aura', vsAI: true }); emit('loading'); emit('ready'); finishOpening();
    const ready = vi.fn();
    viewport.addEventListener(AURA_STARTUP_READY_EVENT, ready);
    startup('awaiting-input');
    find(node => node.type === AuraStartReady).props.onStart(false);
    expect(ready.mock.calls[0][0].detail).toEqual({ token: 1, seed: 17, practice: false });
    expect(window.localStorage.setItem).toHaveBeenCalledWith('ip:aura-first-battle:v1', 'done');
    expect(find(node => node.type === AuraOnboardingHint)).toBeUndefined();
  });
  it('allows a returning player to revisit practice without recommending it again', async () => {
    vi.mocked(window.localStorage.getItem).mockReturnValue('done');
    await mount('AuraScene', { gameMode: 'aura', vsAI: true }); emit('loading'); emit('ready'); finishOpening();
    expect(starts).toEqual([{ token: 1, seed: 17 }]);
    const ready = vi.fn();
    viewport.addEventListener(AURA_STARTUP_READY_EVENT, ready);
    startup('awaiting-input');
    const choice = find(node => node.type === AuraStartReady);
    expect(choice.props).toMatchObject({ practiceAvailable: true, practiceRecommended: false });
    choice.props.onStart(true);
    expect(ready.mock.calls[0][0].detail).toEqual({ token: 1, seed: 17, practice: true });
  });
  it('cannot start from a paused ready screen', async () => {
    await mount('AuraScene', { gameMode: 'aura', vsAI: true }); emit('loading'); emit('ready'); finishOpening();
    find(node => node.props?.['aria-label'] === 'Pause').props.onClick(); flush();
    startup('awaiting-input');
    const ready = vi.fn();
    viewport.addEventListener(AURA_STARTUP_READY_EVENT, ready);
    expect(find(node => node.type === AuraStartReady)).toBeUndefined();
    expect(find(node => node.props?.['aria-label'] === 'Game paused')).toBeDefined();
    expect(ready).not.toHaveBeenCalled();
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
  });
  it('lets the ready dialog leave through the normal Back action without starting the match', async () => {
    await mount('AuraScene', { gameMode: 'aura', vsAI: true }); emit('loading'); emit('ready'); finishOpening();
    startup('awaiting-input');
    const ready = vi.fn();
    viewport.addEventListener(AURA_STARTUP_READY_EVENT, ready);
    find(node => node.type === AuraStartReady).props.onExit();
    expect(props.onExit).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
  });
  it('keeps the authenticated local slot for online controls, irrespective of turn', async () => {
    await mount('AuraScene', { online: { localSlot: 1 } }); emit('loading'); emit('ready'); finishOpening();
    startup('playing');
    viewport.dispatchEvent(new CustomEvent(AURA_PRESENTATION_TURN_EVENT, { detail: { token: 1, seed: 17, playerIndex: 0 } })); flush();
    expect(find(node => node.type === AuraControls).props.playerIndex).toBe(1);
    expect(find(node => node.props?.['aria-label'] === 'Pause')).toBeUndefined();
    expect(starts).toEqual([{ token: 1, seed: 17 }]);
  });
  it('preserves a P2 challenge human through retries and changes to P1 on a fresh remix lifecycle', async () => {
    await mount('AuraScene', { vsAI: true, auraChallenge: { slot: 1 } });
    emit('loading', 1, 17, 1); emit('ready', 1, 17, 1); finishOpening();
    startup('playing');
    viewport.dispatchEvent(new CustomEvent(AURA_PRESENTATION_TURN_EVENT, { detail: { token: 1, seed: 17, playerIndex: 0 } })); flush();
    expect(find(node => node.type === AuraControls).props.playerIndex).toBe(1);
    emit('loading', 2, 17, 1); emit('ready', 2, 17, 1); finishOpening();
    startup('playing', null, 2);
    expect(find(node => node.type === AuraControls).props.playerIndex).toBe(1);
    emit('loading', 3, 18, 0); emit('ready', 3, 18, 0); finishOpening();
    startup('playing', null, 3, 18);
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
      startup('awaiting-input', null, token);
      expect(find(node => node.type === AuraStartReady).props).toMatchObject({ practiceAvailable: false, practiceRecommended: false });
    }
  });
  it('clears completed practice before the musical countdown without bringing back a tour', async () => {
    await mount('AuraScene', { gameMode: 'aura', vsAI: true, experience: 'trial' });
    emit('loading'); emit('ready'); finishOpening();
    const tip = { token: 1, seed: 17, phase: 'practice', cue: 'hit', practiceLane: 3, completedLanes: 3, laneKeys: ['D', 'F', 'J', 'K'] };
    viewport.dispatchEvent(new CustomEvent(AURA_ONBOARDING_EVENT, { detail: tip })); flush();
    expect(find(node => node.type === AuraControls).props.disabled).toBe(false);
    viewport.dispatchEvent(new CustomEvent(AURA_ONBOARDING_EVENT, { detail: { ...tip, phase: 'complete', cue: null, practiceLane: null, completedLanes: 4 } }));
    viewport.dispatchEvent(new CustomEvent(AURA_STARTUP_EVENT, { detail: { token: 1, seed: 17, phase: 'countdown', remainingMs: 3000, count: 3, instrumentVisible: true } })); flush();
    expect(find(node => node.type === AuraControls).props.disabled).toBe(false);
    expect(find(node => node.type === AuraOnboardingHint)).toBeUndefined();
    viewport.dispatchEvent(new CustomEvent(AURA_STARTUP_EVENT, { detail: { token: 1, seed: 17, phase: 'playing', remainingMs: 0, count: null, instrumentVisible: true } })); flush();
    expect(find(node => node.type === AuraControls).props.disabled).toBe(false);
    expect(find(node => node.type === AuraOnboardingHint)).toBeUndefined();
  });
  it('shows only the Aura result after a trial, with its Rookie creation action', async () => {
    vi.stubGlobal('localStorage', (viewport as any).localStorage);
    await mount('AuraScene', { gameMode: 'aura', vsAI: true, experience: 'trial' });
    emit('loading'); emit('ready'); finishOpening();
    viewport.dispatchEvent(new CustomEvent(AURA_BATTLE_COMPLETE_EVENT, { detail: { winnerSlot: 'p1' } }));
    viewport.dispatchEvent(new CustomEvent(MATCH_ACTIONS_VISIBILITY_EVENT, { detail: { visible: true } })); flush();
    expect(find(node => node.props?.['aria-label'] === 'Free round complete')).toBeUndefined();
    expect(find(node => node.type === AuraBattleResults)?.props).toMatchObject({ trial: true, onCreatePlayer: props.onCreateFighter });
    expect(localStorage.setItem).toHaveBeenCalledWith('asf:onboarding:trial-completed', expect.any(String));
  });

  it('shows debut saving, offers retry on failure and keeps the Crew mission available', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(undefined);
    props.onAuraDebutComplete = save;
    props.onContinueOnboarding = vi.fn();
    props.authSessionKey = 'account-a';
    await mount('AuraScene', { gameMode: 'aura', vsAI: true, experience: 'onboarding', p1CloudFighterId: 'rookie-id' });
    viewport.dispatchEvent(new CustomEvent(AURA_BATTLE_COMPLETE_EVENT, { detail: { winnerSlot: 'p1' } }));
    viewport.dispatchEvent(new CustomEvent(MATCH_ACTIONS_VISIBILITY_EVENT, { detail: { visible: true } })); flush();
    const result = () => find(node => node.type === AuraBattleResults).props;
    expect(result()).toMatchObject({ debutSaveState: 'saving', onBuildCrew: props.onContinueOnboarding });
    await Promise.resolve(); flush();
    expect(result().debutSaveState).toBe('error');
    result().onRetryDebut(); flush();
    expect(result().debutSaveState).toBe('saving');
    await Promise.resolve(); flush();
    expect(result().debutSaveState).toBe('saved');
    expect(save.mock.calls).toEqual([['rookie-id'], ['rookie-id']]);
  });

  it('ignores a late debut save after the account changes', async () => {
    let saved!: () => void;
    props.onAuraDebutComplete = vi.fn(() => new Promise<void>((resolve) => { saved = resolve; }));
    props.onContinueOnboarding = vi.fn();
    props.authSessionKey = 'account-a';
    await mount('AuraScene', { gameMode: 'aura', vsAI: true, experience: 'onboarding', p1CloudFighterId: 'rookie-id' });
    viewport.dispatchEvent(new CustomEvent(AURA_BATTLE_COMPLETE_EVENT, { detail: { winnerSlot: 'p1' } }));
    viewport.dispatchEvent(new CustomEvent(MATCH_ACTIONS_VISIBILITY_EVENT, { detail: { visible: true } })); flush();
    props.authSessionKey = 'account-b'; flush();
    saved(); await Promise.resolve(); flush();
    expect(find(node => node.type === AuraBattleResults).props.debutSaveState).toBe('idle');
  });
  it('rejects old final frames and late save/share responses after a rematch', async () => {
    await mount('AuraScene', { gameMode: 'aura', vsAI: true });
    const frame = (state: string, clientBattleId: string) => {
      viewport.dispatchEvent(new CustomEvent(BATTLE_CAPTURE_EVENT, { detail: { state, clientBattleId,
        capture: { clientBattleId, summary: { game: 'aura' }, stillBase64: 'data:image/jpeg;base64,/9j/AA==' } } })); flush();
    };
    frame('started', 'first'); frame('ready', 'first');
    viewport.dispatchEvent(new CustomEvent(AURA_BATTLE_COMPLETE_EVENT, { detail: { winnerSlot: 'p1' } }));
    viewport.dispatchEvent(new CustomEvent(MATCH_ACTIONS_VISIBILITY_EVENT, { detail: { visible: true } })); flush();
    const result = () => find(node => node.type === AuraBattleResults).props;
    const oldSave = result().finisher.props.onBattleChange;
    oldSave({ id: 'old-saved-battle' }); flush();
    expect(result().battle?.id).toBe('old-saved-battle');
    frame('started', 'second'); frame('ready', 'second');
    oldSave({ id: 'late-old-battle' }); frame('ready', 'first');
    expect(result().battle).toBeNull();
    expect(result().finisher.props.capture.clientBattleId).toBe('second');
    result().finisher.props.onBattleChange({ id: 'second-saved-battle' }); flush();
    expect(result().battle?.id).toBe('second-saved-battle');
  });
  it('keeps a visible Fatality offer while the frame prepares, explains capture failure, and ignores an old failure', async () => {
    await mount('AuraScene', { gameMode: 'aura', vsAI: true });
    const frame = (state: string, clientBattleId: string) => {
      viewport.dispatchEvent(new CustomEvent(BATTLE_CAPTURE_EVENT, { detail: { state, clientBattleId } })); flush();
    };
    frame('started', 'first');
    viewport.dispatchEvent(new CustomEvent(AURA_BATTLE_COMPLETE_EVENT, { detail: { winnerSlot: 'p1' } }));
    viewport.dispatchEvent(new CustomEvent(MATCH_ACTIONS_VISIBILITY_EVENT, { detail: { visible: true } })); flush();
    const offer = () => find(node => node.type === AuraBattleResults).props.finisher;
    expect(find(node => node.type === 'button', offer()).props).toMatchObject({ disabled: true, children: 'Fatality · 1 credit' });
    expect(find(node => node.type === 'p', offer()).props.children).toBe('Preparing your final frame…');
    frame('unavailable', 'first');
    expect(find(node => node.type === 'p', offer()).props.children).toContain('unavailable for this round');
    frame('started', 'second'); frame('unavailable', 'first');
    expect(find(node => node.type === 'p', offer()).props.children).toBe('Preparing your final frame…');
  });
  it('waits for the recording before enabling Fatality and then attaches the finished video', async () => {
    await mount('AuraScene', { gameMode: 'aura', vsAI: true });
    const clientBattleId = 'battle';
    viewport.dispatchEvent(new CustomEvent(BATTLE_CAPTURE_EVENT, { detail: { state: 'started', clientBattleId } })); flush();
    viewport.dispatchEvent(new CustomEvent(AURA_CAPTURE_EVENT, { detail: { id: 'video', state: 'preparing' } })); flush();
    viewport.dispatchEvent(new CustomEvent(AURA_CAPTURE_EVENT, { detail: { id: 'video', state: 'processing' } })); flush();
    viewport.dispatchEvent(new CustomEvent(BATTLE_CAPTURE_EVENT, { detail: { state: 'ready', clientBattleId,
      capture: { clientBattleId, summary: { game: 'aura', p1Name: 'Trump', p2Name: 'Lamine' }, stillBase64: 'data:image/jpeg;base64,/9j/AA==' } } }));
    viewport.dispatchEvent(new CustomEvent(AURA_BATTLE_COMPLETE_EVENT, { detail: { winnerSlot: 'p1' } }));
    viewport.dispatchEvent(new CustomEvent(MATCH_ACTIONS_VISIBILITY_EVENT, { detail: { visible: true } })); flush();
    const offer = () => find(node => node.type === AuraBattleResults).props.finisher;
    expect(find(node => node.type === 'button', offer()).props.disabled).toBe(true);
    expect(find(node => node.type === 'p', offer()).props.children).toBe('Preparing your match video…');
    viewport.dispatchEvent(new CustomEvent(AURA_CAPTURE_EVENT, { detail: { id: 'video', state: 'ready',
      video: { blob: new Blob(['recording'], { type: 'video/mp4' }), mimeType: 'video/mp4', hasAudio: true } } })); flush();
    expect(offer().props.capture.recording).toBeInstanceOf(File);
    expect(offer().props.capture.recording.name).toBe('Insert-Player-Trump-vs-Lamine.mp4');
  });
  it('unmount disposes timers so a pending opening never starts', async () => {
    await mount(); emit('loading'); emit('ready'); advance(600);
    for (const slot of hooks.slots) { slot?.cleanup?.(); if (slot) slot.cleanup = undefined; }
    vi.advanceTimersByTime(5000);
    expect(starts).toEqual([]); expect(runtime.destroy).toHaveBeenCalledExactlyOnceWith(true);
  });
});


describe('Optional Aura choreography', () => {
  const chosen = [[['aura_six_seven', 'aura_six_seven', 'aura_floor_worm'],
    ['aura_glide', 'aura_mog_check', 'aura_one_leg'], ['aura_floor_worm', 'aura_one_leg', 'aura_six_seven']], null];
  const ready = async (data: any = { vsAI: true, seed: 17 }) => {
    await mount('AuraScene', data);
    emit('loading'); emit('ready'); finishOpening(); startup('awaiting-input');
  };
  const openEditor = () => { find(node => node.type === AuraStartReady).props.onCustomize(); flush(); };
  const editor = () => find(node => node.type === AuraRoutineEditor);
  const readyView = () => find(node => node.type === AuraStartReady);
  const receiveStarts = () => {
    const received: any[] = [];
    viewport.addEventListener(AURA_STARTUP_READY_EVENT, event => received.push((event as CustomEvent).detail));
    return received;
  };

  it('goes directly to the ordinary start choice with predefined moves', async () => {
    const received = receiveStarts();
    await ready();
    expect(runtime.create).toHaveBeenCalledTimes(1);
    expect(editor()).toBeUndefined();
    expect(readyView().props.onCustomize).toBeTypeOf('function');
    readyView().props.onStart(false); flush();
    expect(received).toEqual([{ token: 1, seed: 17, practice: false }]);
    expect(runtime.create).toHaveBeenCalledTimes(1);
    expect(runtime.destroy).not.toHaveBeenCalled();
  });

  it.each([false, true])('saves all nine optional moves without restarting the runtime (online=%s)', async online => {
    const received = receiveStarts();
    await ready(online ? { online: { localSlot: 0 }, seed: 17 } : { vsAI: true, seed: 17 });
    openEditor();
    expect(readyView()).toBeUndefined();
    expect(find(node => node.props?.className?.startsWith('game-shell')).props.hidden).toBe(true);
    expect(runtime.destroy).not.toHaveBeenCalled();
    editor().props.onPlay(chosen); flush(); await vi.dynamicImportSettled();
    expect(received).toEqual([]);
    expect(editor()).toBeUndefined();
    expect(readyView()).toBeDefined();
    expect(runtime.create).toHaveBeenCalledTimes(1);
    openEditor();
    expect(editor().props.initialRoutines).toEqual(chosen);
    editor().props.onExit(); flush();
    readyView().props.onStart(false);
    expect(received).toEqual([{ token: 1, seed: 17, practice: false, auraRoutines: chosen }]);
    expect(props.launchTarget.data.auraRoutines).toBeUndefined();
  });

  it('cancels customization and starts with the unchanged default', async () => {
    const received = receiveStarts();
    await ready(); openEditor(); editor().props.onExit(); flush();
    expect(props.onExit).not.toHaveBeenCalled();
    expect(runtime.destroy).not.toHaveBeenCalled();
    readyView().props.onStart(false);
    expect(received[0].auraRoutines).toBeUndefined();
  });

  it('keeps the online session owned by the runtime when customization is cancelled', async () => {
    await ready({ online: { localSlot: 1 }, seed: 17 });
    const transport = mockOnlineSession();
    openEditor(); editor().props.onExit(); flush();
    expect(transport.sendControl).not.toHaveBeenCalled();
    expect(transport.close).not.toHaveBeenCalled();
    expect(runtime.destroy).not.toHaveBeenCalled();
    expect(props.onExit).not.toHaveBeenCalled();
  });

  it('blocks saving when the rival departs while the optional editor is open', async () => {
    await ready({ online: { localSlot: 0 }, seed: 17 }); openEditor();
    viewport.dispatchEvent(new CustomEvent(NET_STATE_EVENT, { detail: { abandoned: true } })); flush();
    expect(editor().props.error).toContain('Your rival left');
    editor().props.onPlay(chosen); flush();
    expect(editor()).toBeDefined();
    expect(runtime.create).toHaveBeenCalledTimes(1);
    editor().props.onExit(); flush();
    expect(readyView().props.error).toContain('Your rival left');
  });

  it('starts a different match directly without carrying over optional choices', async () => {
    const received = receiveStarts();
    await ready(); openEditor(); editor().props.onPlay(chosen); flush();
    props.launchTarget = { sceneKey: 'AuraScene', data: { vsAI: false, seed: 82 } };
    flush(); await vi.dynamicImportSettled();
    expect(editor()).toBeUndefined();
    expect(runtime.create).toHaveBeenCalledTimes(2);
    emit('loading', 2, 82); emit('ready', 2, 82); finishOpening(); startup('awaiting-input', null, 2, 82);
    readyView().props.onStart(false);
    expect(received[0]).toEqual({ token: 2, seed: 82, practice: false });
  });

  it.each([{ cpuVsCpu: true }, { auraChallenge: { slot: 0 } }])('preserves automatic or fixed choreography paths: %j', async data => {
    await ready(data);
    expect(editor()).toBeUndefined();
    expect(runtime.create).toHaveBeenCalledTimes(1);
    expect(readyView().props.onCustomize).toBeUndefined();
  });

  it('uses current rematch seed and choices and forgets a previous pending edit', async () => {
    const received = receiveStarts();
    await ready(); openEditor(); editor().props.onPlay(chosen); flush();
    emit('loading', 2, 902); emit('ready', 2, 902); finishOpening();
    const current = { seed: 902, vsAI: true, auraTrackId: 'new-track', p1Name: 'Current player', auraRoutines: chosen };
    viewport.dispatchEvent(new CustomEvent(AURA_REMATCH_CONFIG_EVENT, { detail: current })); flush();
    startup('awaiting-input', null, 2, 902); openEditor();
    expect(editor().props.data).toEqual(current);
    expect(editor().props.initialRoutines).toBeUndefined();
    editor().props.onExit(); flush(); readyView().props.onStart(false);
    expect(received[0]).toEqual({ token: 2, seed: 902, practice: false });
    expect(runtime.create).toHaveBeenCalledTimes(1);
  });

  it('can cancel results editing or save into the current rematch rather than the original song', async () => {
    await ready();
    const current = { seed: 902, vsAI: true, auraTrackId: 'new-track', p1Name: 'Current player', auraRoutines: chosen };
    viewport.dispatchEvent(new CustomEvent(AURA_REMATCH_CONFIG_EVENT, { detail: current }));
    viewport.dispatchEvent(new CustomEvent(AURA_BATTLE_COMPLETE_EVENT, { detail: { winnerSlot: 'p1' } }));
    viewport.dispatchEvent(new CustomEvent(MATCH_ACTIONS_VISIBILITY_EVENT, { detail: { visible: true } })); flush();
    find(node => node.type === AuraBattleResults).props.onEditRoutine(); flush();
    expect(runtime.destroy).not.toHaveBeenCalled();
    expect(editor().props.data).toEqual(current);
    editor().props.onExit(); flush();
    expect(find(node => node.type === AuraBattleResults)).toBeDefined();
    expect(props.onExit).not.toHaveBeenCalled();
    find(node => node.type === AuraBattleResults).props.onEditRoutine(); flush();
    editor().props.onPlay(chosen); flush(); await vi.dynamicImportSettled();
    expect(runtime.create).toHaveBeenCalledTimes(2);
    expect(runtime.destroy).toHaveBeenCalledTimes(1);
    expect(runtime.create.mock.calls[1][1].data).toMatchObject(current);
  });

  it('offers customization after a fixed challenge has been remixed into free play', async () => {
    await ready({ auraChallenge: { slot: 1 } });
    emit('loading', 2, 71); emit('ready', 2, 71); finishOpening();
    viewport.dispatchEvent(new CustomEvent(AURA_REMATCH_CONFIG_EVENT, { detail: { vsAI: true, seed: 71, p1Name: 'Swapped player' } })); flush();
    startup('awaiting-input', null, 2, 71); openEditor();
    expect(editor().props.data.p1Name).toBe('Swapped player');
  });

  it('does not carry an open editor into a different game or spectator match', async () => {
    await ready(); openEditor();
    props.launchTarget = { sceneKey: 'AuraScene', data: { seed: 19, cpuVsCpu: true } };
    flush(); await vi.dynamicImportSettled();
    expect(editor()).toBeUndefined();
    expect(runtime.create).toHaveBeenCalledTimes(2);
    props.launchTarget = { sceneKey: 'FightScene', data: { seed: 21 } };
    flush(); await vi.dynamicImportSettled();
    expect(editor()).toBeUndefined();
    expect(runtime.create).toHaveBeenCalledTimes(3);
  });
});
