import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_INPUT, type FighterInput } from '../sim/FighterInput.ts';
import { KEYBOARD_CONTROLS } from './KeyboardControls.ts';
import { resetVirtualInput, setVirtualInputAction } from './VirtualInput.ts';

interface MockKey {
  isDown: boolean;
  justDown: boolean;
}

vi.mock('phaser', () => ({
  default: {
    Input: {
      Keyboard: {
        JustDown(key: MockKey) {
          const pressed = key.justDown;
          key.justDown = false;
          return pressed;
        },
      },
    },
  },
}));

import { InputManager } from './InputManager.ts';

function createInput() {
  const keys = new Map<number, MockKey>();
  const scene = {
    input: {
      keyboard: {
        addKey(keyCode: number) {
          if (!keys.has(keyCode)) keys.set(keyCode, { isDown: false, justDown: false });
          return keys.get(keyCode)!;
        },
      },
    },
  };
  const manager = new InputManager(scene as unknown as ConstructorParameters<typeof InputManager>[0]);
  return {
    manager,
    press(keyCode: number) {
      const key = keys.get(keyCode)!;
      if (!key.isDown) key.justDown = true;
      key.isDown = true;
    },
    release(keyCode: number) {
      keys.get(keyCode)!.isDown = false;
    },
  };
}

describe('keyboard fight input', () => {
  beforeEach(() => {
    resetVirtualInput();
    vi.stubGlobal('navigator', { getGamepads: () => [] });
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each<[number, keyof FighterInput]>([
    [74, 'punch'],
    [75, 'kick'],
    [85, 'fireball'],
    [73, 'uppercut'],
    [79, 'super'],
  ])('maps P1 key %i to only %s and emits one edge while held', (keyCode, action) => {
    const { manager, press } = createInput();
    press(keyCode);
    manager.poll();
    expect(manager.readPlayer1()).toEqual({ ...EMPTY_INPUT, [action]: true });
    manager.poll();
    expect(manager.readPlayer1()).toEqual(EMPTY_INPUT);
  });

  it('supports movement, a normal attack and guard together under both hands', () => {
    const { manager, press } = createInput();
    press(68); // D: right
    press(74); // J: punch
    press(76); // L: guard
    manager.poll();

    expect(manager.readPlayer1()).toEqual({ ...EMPTY_INPUT, right: true, punch: true, guard: true });
    expect(manager.readPlayer1()).toEqual({ ...EMPTY_INPUT, right: true, guard: true });
  });

  it('keeps G as an alternate held guard without triggering an attack', () => {
    const { manager, press, release } = createInput();
    press(71);
    press(76);
    manager.poll();
    expect(manager.readPlayer1()).toEqual({ ...EMPTY_INPUT, guard: true });

    release(76);
    manager.poll();
    expect(manager.readPlayer1()).toEqual({ ...EMPTY_INPUT, guard: true });

    release(71);
    manager.poll();
    expect(manager.readPlayer1()).toEqual(EMPTY_INPUT);
  });

  it('latches distinct attack edges across render frames without a simulation tick', () => {
    const { manager, press, release } = createInput();
    press(74);
    manager.poll();
    release(74);
    press(75);
    manager.poll();
    release(75);
    manager.poll();

    expect(manager.readPlayer1()).toEqual({ ...EMPTY_INPUT, punch: true, kick: true });
    expect(manager.readPlayer1()).toEqual(EMPTY_INPUT);
  });

  it('captures a press and release between polls and allows a new press on a later tick', () => {
    const { manager, press, release } = createInput();
    press(74);
    release(74);
    manager.poll();
    expect(manager.readPlayer1().punch).toBe(true);
    expect(manager.readPlayer1().punch).toBe(false);

    press(74);
    manager.poll();
    expect(manager.readPlayer1().punch).toBe(true);
  });

  it('keeps P2 arrow and numpad inputs isolated from P1, including simultaneous presses', () => {
    const { manager, press } = createInput();
    press(65); // P1 left
    press(75); // P1 kick
    press(39); // P2 right
    press(96); // P2 guard
    press(100); // P2 punch
    press(98); // P2 uppercut / Rush jump
    manager.poll();

    expect(manager.readPlayer1()).toEqual({ ...EMPTY_INPUT, left: true, kick: true });
    expect(manager.readPlayer2()).toEqual({ ...EMPTY_INPUT, right: true, guard: true, punch: true, uppercut: true });
    expect(manager.readPlayer2()).toEqual({ ...EMPTY_INPUT, right: true, guard: true });
  });

  it('merges keyboard and touch without duplicating their attack edges across ticks', () => {
    const { manager, press } = createInput();
    press(68);
    press(74);
    setVirtualInputAction(0, 'punch', true);
    setVirtualInputAction(0, 'fireball', true);
    manager.poll();

    expect(manager.readPlayer1()).toEqual({ ...EMPTY_INPUT, right: true, punch: true, fireball: true });
    expect(manager.readPlayer1()).toEqual({ ...EMPTY_INPUT, right: true });
    manager.poll();
    expect(manager.readPlayer1()).toEqual({ ...EMPTY_INPUT, right: true });
  });

  it('drops latched edges and sampled held input on reset', () => {
    const { manager, press } = createInput();
    press(68);
    press(74);
    press(100);
    manager.poll();
    manager.reset();

    expect(manager.readPlayer1()).toEqual(EMPTY_INPUT);
    expect(manager.readPlayer2()).toEqual(EMPTY_INPUT);
  });

  it('keeps legend bindings unique across both players, including aliases', () => {
    const keyCodes = KEYBOARD_CONTROLS.flatMap((controls) => Object.values(controls)
      .flatMap((binding) => [binding, ...(binding.aliases ?? [])])
      .map((key) => key.keyCode));

    expect(new Set(keyCodes).size).toBe(keyCodes.length);
    expect(KEYBOARD_CONTROLS[0].punch.label).toBe('J');
    expect(KEYBOARD_CONTROLS[0].kick.label).toBe('K');
    expect(KEYBOARD_CONTROLS[0].guard.label).toBe('L');
  });
});
