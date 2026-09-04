import { beforeEach, describe, expect, it } from 'vitest';
import {
  consumeVirtualInput,
  resetVirtualInput,
  setVirtualInputAction,
} from './VirtualInput.ts';

describe('virtual fight input', () => {
  beforeEach(() => resetVirtualInput());

  it('holds movement until the pointer releases', () => {
    setVirtualInputAction(0, 'left', true);
    expect(consumeVirtualInput(0).left).toBe(true);
    expect(consumeVirtualInput(0).left).toBe(true);

    setVirtualInputAction(0, 'left', false);
    expect(consumeVirtualInput(0).left).toBe(false);
  });

  it('emits one attack pulse while a button is held', () => {
    setVirtualInputAction(0, 'punch', true);
    expect(consumeVirtualInput(0).punch).toBe(true);
    expect(consumeVirtualInput(0).punch).toBe(false);

    setVirtualInputAction(0, 'punch', false);
    setVirtualInputAction(0, 'punch', true);
    expect(consumeVirtualInput(0).punch).toBe(true);
  });

  it('supports simultaneous direction and attack inputs', () => {
    setVirtualInputAction(0, 'right', true);
    setVirtualInputAction(0, 'kick', true);

    const snapshot = consumeVirtualInput(0);
    expect(snapshot.right).toBe(true);
    expect(snapshot.kick).toBe(true);
  });

  it('keeps player input isolated', () => {
    setVirtualInputAction(0, 'fireball', true);
    setVirtualInputAction(1, 'uppercut', true);

    expect(consumeVirtualInput(0)).toMatchObject({ fireball: true, uppercut: false });
    expect(consumeVirtualInput(1)).toMatchObject({ fireball: false, uppercut: true });
  });

  it('clears held and pending input on reset', () => {
    setVirtualInputAction(0, 'down', true);
    setVirtualInputAction(0, 'uppercut', true);
    resetVirtualInput(0);

    expect(consumeVirtualInput(0)).toEqual({
      left: false,
      right: false,
      up: false,
      down: false,
      guard: false,
      punch: false,
      kick: false,
      fireball: false,
      uppercut: false,
      super: false,
    });
  });
});
