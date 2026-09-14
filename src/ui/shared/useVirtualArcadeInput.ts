import { useEffect, useMemo, useSyncExternalStore, type HTMLAttributes, type PointerEvent as ReactPointerEvent } from 'react';
import {
  resetVirtualInput,
  setVirtualInputAction,
  type VirtualInputAction,
  type VirtualInputSnapshot,
} from '../../game/systems/VirtualInput.ts';

const ACTIONS: VirtualInputAction[] = ['left', 'right', 'up', 'down', 'guard', 'punch', 'kick', 'fireball', 'uppercut', 'super'];
const emptyHeld = (): VirtualInputSnapshot => Object.fromEntries(ACTIONS.map((action) => [action, false])) as unknown as VirtualInputSnapshot;
type Handlers = HTMLAttributes<HTMLElement>;
type Pointer = { target: HTMLElement; actions: Set<VirtualInputAction>; joystick: boolean };

/** Owns the footer's virtual input without reading or consuming gameplay edges. */
export function createVirtualArcadeInput(playerIndex: 0 | 1 = 0, mode: 'fight' | 'rush' = 'fight') {
  let disabled = false;
  let held = emptyHeld();
  const pointers = new Map<number, Pointer>();
  const keyboard = new Map<HTMLElement, Map<string, VirtualInputAction>>();
  const listeners = new Set<() => void>();

  const publish = () => {
    const next = emptyHeld();
    for (const pointer of pointers.values()) for (const action of pointer.actions) next[action] = true;
    for (const keys of keyboard.values()) for (const action of keys.values()) next[action] = true;
    if (ACTIONS.every((action) => next[action] === held[action])) return;
    for (const action of ACTIONS) if (next[action] !== held[action]) setVirtualInputAction(playerIndex, action, next[action]);
    held = next;
    listeners.forEach((listener) => listener());
  };

  const releasePointer = (pointerId: number) => {
    const pointer = pointers.get(pointerId);
    if (!pointer) return;
    pointers.delete(pointerId);
    // Delete ownership before releasing capture: lostpointercapture may fire immediately.
    try {
      if (pointer.target.hasPointerCapture?.(pointerId)) pointer.target.releasePointerCapture(pointerId);
    } catch { /* The browser may already have canceled this pointer. */ }
    publish();
  };

  const reset = () => {
    for (const pointerId of [...pointers.keys()]) releasePointer(pointerId);
    keyboard.clear();
    publish();
    // A backgrounded or removed control must not leave a queued attack for resume.
    resetVirtualInput(playerIndex);
  };

  const beginPointer = (event: ReactPointerEvent<HTMLElement>, actions: Set<VirtualInputAction>, joystick: boolean) => {
    if (disabled || event.button !== 0 || pointers.has(event.pointerId)) return;
    if (joystick && [...pointers.values()].some((pointer) => pointer.joystick)) return;
    event.preventDefault();
    event.stopPropagation();
    pointers.set(event.pointerId, { target: event.currentTarget, actions, joystick });
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Window release listeners provide a fallback. */ }
    publish();
  };

  const endPointer: Handlers['onPointerUp'] = (event) => {
    if (!pointers.has(event.pointerId)) return;
    event.preventDefault();
    releasePointer(event.pointerId);
  };

  const releaseHandlers: Handlers = {
    onPointerUp: endPointer,
    onPointerCancel: endPointer,
    onLostPointerCapture: (event) => releasePointer(event.pointerId),
    onContextMenu: (event) => event.preventDefault(),
  };

  const button = (action: VirtualInputAction, blocked = false): Handlers => ({
    ...releaseHandlers,
    onPointerDown: (event) => {
      if (!blocked) beginPointer(event, new Set([action]), false);
    },
    onKeyDown: (event) => {
      if (disabled || blocked || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      event.stopPropagation();
      const keys = keyboard.get(event.currentTarget) ?? new Map<string, VirtualInputAction>();
      keys.set(event.key, action);
      keyboard.set(event.currentTarget, keys);
      publish();
    },
    onKeyUp: (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      keyboard.get(event.currentTarget)?.delete(event.key);
      publish();
    },
    onBlur: (event) => { keyboard.delete(event.currentTarget); publish(); },
  });

  const directionsAt = (event: ReactPointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - (bounds.left + bounds.width / 2);
    const y = event.clientY - (bounds.top + bounds.height / 2);
    const deadZone = Math.max(6, Math.min(bounds.width, bounds.height) * 0.16);
    const upThreshold = mode === 'fight' ? Math.max(deadZone, Math.min(bounds.width, bounds.height) * 0.30) : deadZone;
    const actions = new Set<VirtualInputAction>();
    if (x < -deadZone) actions.add('left');
    if (x > deadZone) actions.add('right');
    if (y < -upThreshold) actions.add('up');
    if (y > deadZone) actions.add('down');
    return actions;
  };

  const joystick: Handlers = {
    ...releaseHandlers,
    onPointerDown: (event) => beginPointer(event, directionsAt(event), true),
    onPointerMove: (event) => {
      const pointer = pointers.get(event.pointerId);
      if (!pointer?.joystick || pointer.target !== event.currentTarget) return;
      event.preventDefault();
      pointer.actions = directionsAt(event);
      publish();
    },
  };

  return {
    button,
    joystick,
    releasePointer,
    reset,
    setDisabled: (value: boolean) => { disabled = value; if (value) reset(); },
    getSnapshot: () => held,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/** Also handles capture loss outside the panel and page lifecycle interruptions. */
export function observeVirtualArcadeInput(input: ReturnType<typeof createVirtualArcadeInput>): () => void {
  const onRelease = (event: PointerEvent) => input.releasePointer(event.pointerId);
  const onVisibility = () => { if (document.hidden) input.reset(); };
  window.addEventListener('pointerup', onRelease);
  window.addEventListener('pointercancel', onRelease);
  window.addEventListener('blur', input.reset);
  window.addEventListener('pagehide', input.reset);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    window.removeEventListener('pointerup', onRelease);
    window.removeEventListener('pointercancel', onRelease);
    window.removeEventListener('blur', input.reset);
    window.removeEventListener('pagehide', input.reset);
    document.removeEventListener('visibilitychange', onVisibility);
    input.reset();
  };
}

export function useVirtualArcadeInput({ playerIndex = 0, mode = 'fight', disabled = false, resetKey }: {
  playerIndex?: 0 | 1;
  mode?: 'fight' | 'rush';
  disabled?: boolean;
  resetKey?: unknown;
} = {}) {
  const input = useMemo(() => createVirtualArcadeInput(playerIndex, mode), [playerIndex, mode]);
  const held = useSyncExternalStore(input.subscribe, input.getSnapshot, input.getSnapshot);
  useEffect(() => observeVirtualArcadeInput(input), [input]);
  useEffect(() => input.setDisabled(disabled), [input, disabled]);
  useEffect(() => input.reset(), [input, resetKey]);
  return { held, button: input.button, joystick: input.joystick };
}
