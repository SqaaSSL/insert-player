import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeVirtualInput, peekVirtualHeldInput, resetVirtualInput } from '../../game/systems/VirtualInput.ts';
import { createVirtualArcadeInput, observeVirtualArcadeInput } from './useVirtualArcadeInput.ts';

type Input = ReturnType<typeof createVirtualArcadeInput>;
let input: Input;
let stop: (() => void) | undefined;
let viewport: EventTarget;
let page: EventTarget & { hidden: boolean };

function target() {
  const captures = new Set<number>();
  return {
    setPointerCapture: (id: number) => captures.add(id),
    hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: (id: number) => captures.delete(id),
    getBoundingClientRect: () => ({ left: 100, top: 200, width: 100, height: 100 }),
    captures,
  } as unknown as HTMLElement & { captures: Set<number> };
}

function pointer(currentTarget: HTMLElement, pointerId = 1, x = 150, y = 250) {
  return {
    currentTarget, pointerId, clientX: x, clientY: y, button: 0,
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
  } as unknown as Parameters<NonNullable<Input['joystick']['onPointerDown']>>[0];
}

function key(currentTarget: HTMLElement, value = 'Enter') {
  return { currentTarget, key: value, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as Parameters<NonNullable<ReturnType<Input['button']>['onKeyDown']>>[0];
}

beforeEach(() => {
  resetVirtualInput();
  input = createVirtualArcadeInput();
  viewport = new EventTarget();
  page = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('window', viewport);
  vi.stubGlobal('document', page);
});

afterEach(() => { stop?.(); stop = undefined; input.reset(); vi.unstubAllGlobals(); });

describe('touch arcade input ownership', () => {
  it('holds movement and attack with independent fingers, preserving the gameplay attack edge', () => {
    const stick = target();
    const cap = target();
    input.joystick.onPointerDown?.(pointer(stick, 1, 190, 250));
    input.button('punch').onPointerDown?.(pointer(cap, 2));
    expect(stick.captures.has(1)).toBe(true);
    expect(cap.captures.has(2)).toBe(true);
    expect(peekVirtualHeldInput(0)).toMatchObject({ right: true, punch: true });
    expect(input.getSnapshot()).toMatchObject({ right: true, punch: true });
    input.button('punch').onPointerUp?.(pointer(cap, 2));
    expect(input.getSnapshot()).toMatchObject({ right: true, punch: false });
    expect(consumeVirtualInput(0)).toMatchObject({ right: true, punch: true });
    expect(consumeVirtualInput(0).punch).toBe(false);
    input.joystick.onPointerUp?.(pointer(stick, 1));
    expect(input.getSnapshot().right).toBe(false);
    expect(stick.captures.size).toBe(0);
  });

  it('allows a direction tap and joystick to own the same direction without releasing each other', () => {
    const stick = target();
    const arrow = target();
    input.joystick.onPointerDown?.(pointer(stick, 1, 110, 250));
    input.button('left').onPointerDown?.(pointer(arrow, 2));
    input.joystick.onPointerUp?.(pointer(stick, 1));
    expect(input.getSnapshot().left).toBe(true);
    input.button('left').onPointerCancel?.(pointer(arrow, 2));
    expect(peekVirtualHeldInput(0).left).toBe(false);
  });

  it('does not let an extra joystick finger steer or release the primary finger', () => {
    const stick = target();
    input.joystick.onPointerDown?.(pointer(stick, 1, 190, 250));
    input.joystick.onPointerDown?.(pointer(stick, 2, 110, 250));
    input.joystick.onPointerMove?.(pointer(stick, 2, 110, 250));
    input.joystick.onPointerUp?.(pointer(stick, 2));
    expect(input.getSnapshot()).toMatchObject({ right: true, left: false });
    input.joystick.onPointerMove?.(pointer(stick, 1, 110, 290));
    expect(input.getSnapshot()).toMatchObject({ right: false, left: true, down: true });
    input.joystick.onPointerMove?.(pointer(stick, 1, 150, 250));
    expect(input.getSnapshot()).toMatchObject({ left: false, down: false });
  });

  it('requires a deliberate upward drag to jump in Fight, while Rush uses normal screen axes', () => {
    const stick = target();
    input.joystick.onPointerDown?.(pointer(stick, 1, 175, 225));
    expect(input.getSnapshot()).toMatchObject({ right: true, up: false });
    input.joystick.onPointerMove?.(pointer(stick, 1, 175, 215));
    expect(input.getSnapshot()).toMatchObject({ right: true, up: true });
    input.reset();
    input = createVirtualArcadeInput(0, 'rush');
    input.joystick.onPointerDown?.(pointer(stick, 1, 175, 225));
    expect(input.getSnapshot()).toMatchObject({ right: true, up: true });
  });

  it('counts two fingers on an action separately and never repeats held attack edges', () => {
    const cap = target();
    input.button('kick').onPointerDown?.(pointer(cap, 1));
    expect(consumeVirtualInput(0).kick).toBe(true);
    input.button('kick').onPointerDown?.(pointer(cap, 2));
    input.button('kick').onPointerUp?.(pointer(cap, 1));
    expect(peekVirtualHeldInput(0).kick).toBe(true);
    expect(consumeVirtualInput(0).kick).toBe(false);
    input.button('kick').onLostPointerCapture?.(pointer(cap, 2));
    expect(peekVirtualHeldInput(0).kick).toBe(false);
  });

  it('supports accessible Enter/Space activation without one source releasing another', () => {
    const cap = target();
    const punch = input.button('punch');
    punch.onKeyDown?.(key(cap));
    punch.onKeyDown?.(key(cap));
    expect(consumeVirtualInput(0).punch).toBe(true);
    punch.onKeyDown?.(key(cap));
    expect(consumeVirtualInput(0).punch).toBe(false);
    punch.onPointerDown?.(pointer(cap, 1));
    punch.onKeyUp?.(key(cap));
    expect(input.getSnapshot().punch).toBe(true);
    punch.onPointerUp?.(pointer(cap, 1));
    punch.onKeyDown?.(key(cap, ' '));
    punch.onBlur?.({ currentTarget: cap } as unknown as Parameters<NonNullable<typeof punch.onBlur>>[0]);
    expect(input.getSnapshot().punch).toBe(false);
  });

  it('blocks disabled buttons and resets all input when the panel becomes disabled', () => {
    const cap = target();
    input.button('super', true).onPointerDown?.(pointer(cap));
    input.button('super', true).onKeyDown?.(key(cap));
    expect(peekVirtualHeldInput(0).super).toBe(false);
    input.button('kick').onPointerDown?.(pointer(cap));
    input.setDisabled(true);
    expect(peekVirtualHeldInput(0).kick).toBe(false);
    expect(consumeVirtualInput(0).kick).toBe(false);
    input.button('kick').onPointerDown?.(pointer(cap, 2));
    expect(input.getSnapshot().kick).toBe(false);
    input.setDisabled(false);
    input.button('kick').onPointerDown?.(pointer(cap, 2));
    expect(input.getSnapshot().kick).toBe(true);
  });

  it('targets the selected virtual player without affecting the other player', () => {
    input = createVirtualArcadeInput(1);
    input.button('guard').onPointerDown?.(pointer(target()));
    expect(peekVirtualHeldInput(0).guard).toBe(false);
    expect(peekVirtualHeldInput(1).guard).toBe(true);
    input.reset();
    expect(peekVirtualHeldInput(1).guard).toBe(false);
  });
});

describe('touch arcade interruption cleanup', () => {
  it.each(['blur', 'pagehide', 'visibilitychange', 'unmount'])('clears held inputs and queued attacks on %s', (cause) => {
    const stick = target();
    const cap = target();
    stop = observeVirtualArcadeInput(input);
    input.joystick.onPointerDown?.(pointer(stick, 1, 190, 250));
    input.button('punch').onPointerDown?.(pointer(cap, 2));
    if (cause === 'unmount') { stop(); stop = undefined; }
    else if (cause === 'visibilitychange') { page.hidden = true; page.dispatchEvent(new Event(cause)); }
    else viewport.dispatchEvent(new Event(cause));
    expect(input.getSnapshot()).toMatchObject({ right: false, punch: false });
    expect(consumeVirtualInput(0)).toMatchObject({ right: false, punch: false });
    expect(stick.captures.size + cap.captures.size).toBe(0);
  });

  it('releases a pointer outside the panel when capture is unavailable', () => {
    stop = observeVirtualArcadeInput(input);
    const cap = target();
    cap.setPointerCapture = () => { throw new Error('Capture unavailable'); };
    input.button('guard').onPointerDown?.(pointer(cap, 9));
    viewport.dispatchEvent(Object.assign(new Event('pointerup'), { pointerId: 9 }));
    expect(input.getSnapshot().guard).toBe(false);
  });
});
