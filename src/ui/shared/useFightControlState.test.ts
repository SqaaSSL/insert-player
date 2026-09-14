import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { EMPTY_INPUT } from '../../game/sim/FighterInput.ts';
import { type FightControlState } from './fightControlState.ts';
import { observeFightControlState } from './useFightControlState.ts';

let viewport: EventTarget;
let documentTarget: EventTarget & { hidden: boolean; activeElement: EventTarget | null };
let state: FightControlState;
let stop: (() => void) | undefined;
let frames: Map<number, FrameRequestCallback>;
let gamepads: (Gamepad | null)[];
let updates: Mock<(next: FightControlState) => void>;

function key(type: 'keydown' | 'keyup', keyCode: number, extra: Record<string, unknown> = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { keyCode, code: '', ...extra });
  viewport.dispatchEvent(event);
  return event;
}

function tick() {
  const current = [...frames.values()];
  frames.clear();
  for (const callback of current) callback(0);
}

beforeEach(() => {
  frames = new Map();
  gamepads = [];
  let frameId = 0;
  viewport = Object.assign(new EventTarget(), {
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  documentTarget = Object.assign(new EventTarget(), { hidden: false, activeElement: null });
  vi.stubGlobal('window', viewport);
  vi.stubGlobal('document', documentTarget);
  vi.stubGlobal('navigator', { getGamepads: () => gamepads });
  updates = vi.fn((next: FightControlState) => { state = next; });
  stop = observeFightControlState('rush', true, updates);
});

afterEach(() => { stop?.(); vi.unstubAllGlobals(); });

describe('passive arcade panel input listeners', () => {
  it('observes presses without preventing gameplay events and releases each action', () => {
    const gameplay = vi.fn();
    viewport.addEventListener('keydown', gameplay);
    const event = key('keydown', 74);
    key('keydown', 32);
    expect(event.defaultPrevented).toBe(false);
    expect(gameplay).toHaveBeenCalledTimes(2);
    expect(state.players[0].held).toEqual({ ...EMPTY_INPUT, punch: true, uppercut: true });
    key('keyup', 74);
    expect(state.players[0].held.punch).toBe(false);
  });

  it('clears all lights on blur and ignores held gamepads until focus returns', () => {
    key('keydown', 74);
    viewport.dispatchEvent(new Event('blur'));
    expect(state.players[0].held).toEqual(EMPTY_INPUT);
    key('keydown', 75);
    gamepads = [{ axes: [0, 0], buttons: [{ pressed: true }] } as unknown as Gamepad];
    tick();
    expect(state.players[0].held).toEqual(EMPTY_INPUT);
    viewport.dispatchEvent(new Event('focus'));
    tick();
    expect(state.players[0].held.punch).toBe(true);
  });

  it('clears hidden-page lights and never highlights keys while the page is hidden', () => {
    key('keydown', 71);
    documentTarget.hidden = true;
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(state.players[0].held).toEqual(EMPTY_INPUT);
    key('keydown', 74);
    expect(state.players[0].held).toEqual(EMPTY_INPUT);
  });

  it('ignores editable fields, composition and browser shortcut modifiers', () => {
    const editable = Object.assign(new EventTarget(), { closest: () => ({}) });
    documentTarget.activeElement = editable;
    key('keydown', 74);
    expect(state.players[0].held).toEqual(EMPTY_INPUT);
    documentTarget.activeElement = null;
    for (const extra of [{ isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) key('keydown', 74, extra);
    expect(state.players[0].held).toEqual(EMPTY_INPUT);
    key('keydown', 74);
    documentTarget.activeElement = editable;
    const focus = new Event('focusin');
    Object.defineProperty(focus, 'target', { value: editable });
    documentTarget.dispatchEvent(focus);
    expect(state.players[0].held).toEqual(EMPTY_INPUT);
  });

  it('releases keys even if focus moved into an editable field before keyup', () => {
    key('keydown', 74);
    documentTarget.activeElement = Object.assign(new EventTarget(), { closest: () => ({}) });
    key('keyup', 74);
    expect(state.players[0].held).toEqual(EMPTY_INPUT);
  });

  it('switches to touch on a touch pointer without intercepting the pointer event', () => {
    const pointer = Object.assign(new Event('pointerdown', { cancelable: true }), { pointerType: 'touch' });
    viewport.dispatchEvent(pointer);
    expect(state.device).toBe('touch');
    expect(pointer.defaultPrevented).toBe(false);
  });

  it('publishes gamepad changes at frame speed without rendering unchanged frames', () => {
    tick();
    expect(updates).toHaveBeenCalledTimes(1);
    gamepads = [{ axes: [0.6, 0], buttons: [] } as unknown as Gamepad];
    tick();
    expect(state.players[0].held.right).toBe(true);
    const count = updates.mock.calls.length;
    tick();
    expect(updates).toHaveBeenCalledTimes(count);
    gamepads = [];
    tick();
    expect(state.players[0].held).toEqual(EMPTY_INPUT);
  });

  it('removes listeners and the animation frame when the panel unmounts', () => {
    stop?.();
    stop = undefined;
    expect(frames.size).toBe(0);
    key('keydown', 74);
    viewport.dispatchEvent(new Event('blur'));
    expect(updates).toHaveBeenCalledTimes(1);
  });
});
