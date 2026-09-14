import { describe, expect, it } from 'vitest';
import { EMPTY_INPUT } from '../../game/sim/FighterInput.ts';
import { controlKeyCode, createFightControlTracker, gamepadHeldControls, type ControlGamepad } from './fightControlState.ts';

function pad(buttons: number[] = [], axes = [0, 0]): ControlGamepad {
  return { axes, buttons: Array.from({ length: 16 }, (_, index) => ({ pressed: buttons.includes(index) })) };
}

describe('arcade panel held-input state', () => {
  it('lights simultaneous movement and attacks until their individual keys release', () => {
    const tracker = createFightControlTracker('fight', false);
    tracker.keyDown(68);
    tracker.keyDown(74);
    tracker.keyDown(75);
    expect(tracker.getSnapshot().players[0].held).toEqual({ ...EMPTY_INPUT, right: true, punch: true, kick: true });
    tracker.keyUp(74);
    expect(tracker.getSnapshot().players[0].held).toEqual({ ...EMPTY_INPUT, right: true, kick: true });
    tracker.keyUp(68);
    tracker.keyUp(75);
    expect(tracker.getSnapshot().players[0].held).toEqual(EMPTY_INPUT);
  });

  it('keeps guard lit when one of L/G is still held and isolates player 2', () => {
    const tracker = createFightControlTracker('fight', true);
    tracker.keyDown(76);
    tracker.keyDown(71);
    tracker.keyDown(100);
    tracker.keyUp(76);
    expect(tracker.getSnapshot().players[0].held).toEqual({ ...EMPTY_INPUT, guard: true });
    expect(tracker.getSnapshot().players[1].held).toEqual({ ...EMPTY_INPUT, punch: true });
    tracker.keyUp(71);
    expect(tracker.getSnapshot().players[0].held).toEqual(EMPTY_INPUT);
  });

  it('lights the dedicated Rush jump for I or Space without lighting lane up', () => {
    const tracker = createFightControlTracker('rush', true);
    tracker.keyDown(32);
    tracker.keyDown(73);
    tracker.keyUp(73);
    expect(tracker.getSnapshot().players[0].held).toEqual({ ...EMPTY_INPUT, uppercut: true });
    expect(tracker.getSnapshot().players[1].held).toEqual(EMPTY_INPUT);
    tracker.keyUp(32);
    tracker.keyDown(87);
    expect(tracker.getSnapshot().players[0].held).toEqual({ ...EMPTY_INPUT, up: true });
    const fight = createFightControlTracker('fight', false);
    fight.keyDown(32);
    expect(fight.getSnapshot().players[0].held).toEqual(EMPTY_INPUT);
  });

  it('ignores unrelated keys, unused player 2 controls and keyboard auto-repeat', () => {
    const tracker = createFightControlTracker('fight', false);
    const initial = tracker.getSnapshot();
    tracker.keyDown(27);
    tracker.keyDown(100);
    expect(tracker.getSnapshot()).toBe(initial);
    tracker.keyDown(74);
    const pressed = tracker.getSnapshot();
    tracker.keyDown(74);
    expect(tracker.getSnapshot()).toBe(pressed);
  });

  it('matches standard pad actions, all three guard buttons, and the 0.35 axis threshold', () => {
    expect(gamepadHeldControls(pad([0, 1, 2, 3, 7], [0.36, -0.36]))).toEqual({
      ...EMPTY_INPUT, right: true, up: true, punch: true, kick: true, fireball: true, uppercut: true, super: true,
    });
    for (const guard of [4, 5, 6]) expect(gamepadHeldControls(pad([guard]))).toEqual({ ...EMPTY_INPUT, guard: true });
    expect(gamepadHeldControls(pad([], [0.35, -0.35]))).toEqual(EMPTY_INPUT);
    expect(gamepadHeldControls(pad([12, 13, 14, 15]))).toEqual({ ...EMPTY_INPUT, up: true, down: true, left: true, right: true });
  });

  it('switches on fresh device activity without a connected or held pad stealing the keyboard', () => {
    const tracker = createFightControlTracker('fight', false);
    tracker.gamepads([pad()]);
    expect(tracker.getSnapshot().device).toBe('keyboard');
    tracker.gamepads([pad([0])]);
    expect(tracker.getSnapshot().device).toBe('gamepad');
    tracker.keyDown(75);
    tracker.gamepads([pad([0])]);
    expect(tracker.getSnapshot().device).toBe('keyboard');
    expect(tracker.getSnapshot().players[0].held).toEqual({ ...EMPTY_INPUT, kick: true });
    tracker.gamepads([pad()]);
    tracker.gamepads([pad([1])]);
    expect(tracker.getSnapshot().device).toBe('gamepad');
    expect(tracker.getSnapshot().players[0].held).toEqual({ ...EMPTY_INPUT, kick: true });
  });

  it('keeps a keyboard player and a gamepad player separate, matching sparse browser pad assignment', () => {
    const tracker = createFightControlTracker('rush', true);
    tracker.keyDown(74);
    tracker.gamepads([null, pad(), null, pad([3])]);
    expect(tracker.getSnapshot().players[0]).toEqual({ device: 'keyboard', held: { ...EMPTY_INPUT, punch: true } });
    expect(tracker.getSnapshot().players[1]).toEqual({ device: 'gamepad', held: { ...EMPTY_INPUT, uppercut: true } });
    tracker.gamepads([null, pad(), null, pad()]);
    expect(tracker.getSnapshot().players[1].held).toEqual(EMPTY_INPUT);
  });

  it('recognizes fresh guard aliases and stick movement while their equivalent pad control is held', () => {
    const tracker = createFightControlTracker('fight', false);
    tracker.gamepads([pad([4, 15])]);
    tracker.keyDown(74);
    tracker.gamepads([pad([4, 5, 15])]);
    expect(tracker.getSnapshot().device).toBe('gamepad');
    tracker.keyDown(75);
    tracker.gamepads([pad([4, 5, 15], [0.6, 0])]);
    expect(tracker.getSnapshot().device).toBe('gamepad');
  });

  it('clears disconnected gamepads and falls back to the keyboard with no stuck lights', () => {
    const tracker = createFightControlTracker('fight', false);
    tracker.gamepads([pad([0])]);
    tracker.gamepads([]);
    expect(tracker.getSnapshot().device).toBe('keyboard');
    expect(tracker.getSnapshot().players[0].held).toEqual(EMPTY_INPUT);
  });

  it('does not rebuild snapshots on idle gamepad frames and resets held inputs', () => {
    const tracker = createFightControlTracker('fight', true);
    tracker.gamepads([pad([0]), pad()]);
    tracker.keyDown(100);
    const snapshot = tracker.getSnapshot();
    tracker.gamepads([pad([0]), pad()]);
    expect(tracker.getSnapshot()).toBe(snapshot);
    tracker.reset();
    expect(tracker.getSnapshot().players.every((player) => Object.values(player.held).every((held) => !held))).toBe(true);
  });

  it('shows touch controls until a relevant keyboard or gamepad action occurs', () => {
    const tracker = createFightControlTracker('fight', false, 'touch');
    tracker.keyDown(27);
    tracker.gamepads([pad()]);
    expect(tracker.getSnapshot().device).toBe('touch');
    tracker.keyDown(74);
    expect(tracker.getSnapshot().device).toBe('keyboard');
    tracker.touch();
    expect(tracker.getSnapshot().device).toBe('touch');
    tracker.gamepads([pad([0])]);
    expect(tracker.getSnapshot().device).toBe('gamepad');
  });

  it('uses the engine keyCode first and supports physical codes when keyCode is absent', () => {
    expect(controlKeyCode({ keyCode: 75, code: 'KeyJ' })).toBe(75);
    expect(controlKeyCode({ keyCode: 0, code: 'KeyJ' })).toBe(74);
    expect(controlKeyCode({ keyCode: 0, code: 'Numpad4' })).toBe(100);
    expect(controlKeyCode({ keyCode: 0, code: 'ArrowUp' })).toBe(38);
    expect(controlKeyCode({ keyCode: 0, code: 'Space' })).toBe(32);
  });
});
