import { useEffect, useState } from 'react';
import {
  controlKeyCode,
  createFightControlTracker,
  isEditableControlTarget,
  type ControlMode,
  type FightControlState,
} from './fightControlState.ts';

function defaultDevice(): 'keyboard' | 'touch' {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches ? 'touch' : 'keyboard';
}

/** Passive listeners: the simulation retains sole ownership of input consumption. */
export function observeFightControlState(
  mode: ControlMode,
  twoPlayers: boolean,
  onChange: (state: FightControlState) => void,
): () => void {
  const tracker = createFightControlTracker(mode, twoPlayers, defaultDevice());
  let lastSnapshot = tracker.getSnapshot();
  let focused = true;
  let frame = 0;
  const publish = () => {
    const snapshot = tracker.getSnapshot();
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      onChange(snapshot);
    }
  };
  const enabled = () => focused && !document.hidden && !isEditableControlTarget(document.activeElement);
  const clear = () => { tracker.reset(); publish(); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!enabled() || event.isComposing || event.altKey || event.ctrlKey || event.metaKey
      || isEditableControlTarget(event.target)) return;
    tracker.keyDown(controlKeyCode(event));
    publish();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    tracker.keyUp(controlKeyCode(event));
    publish();
  };
  const onPointer = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !enabled() || isEditableControlTarget(event.target)) return;
    tracker.touch();
    publish();
  };
  const onBlur = () => { focused = false; clear(); };
  const onFocus = () => { focused = true; };
  const onVisibility = () => { if (document.hidden) clear(); };
  const onFocusIn = (event: FocusEvent) => { if (isEditableControlTarget(event.target)) clear(); };
  const pollPads = () => {
    if (enabled()) {
      tracker.gamepads(Array.from(navigator.getGamepads?.() ?? []));
      publish();
    }
    frame = window.requestAnimationFrame(pollPads);
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('pointerdown', onPointer, { passive: true });
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  window.addEventListener('pagehide', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('focusin', onFocusIn);
  onChange(lastSnapshot);
  frame = window.requestAnimationFrame(pollPads);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('pointerdown', onPointer);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('pagehide', onBlur);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('focusin', onFocusIn);
    window.cancelAnimationFrame(frame);
  };
}

export function useFightControlState(mode: ControlMode, twoPlayers: boolean): FightControlState {
  const [state, setState] = useState(() => createFightControlTracker(mode, twoPlayers, defaultDevice()).getSnapshot());
  useEffect(() => observeFightControlState(mode, twoPlayers, setState), [mode, twoPlayers]);
  return state;
}
