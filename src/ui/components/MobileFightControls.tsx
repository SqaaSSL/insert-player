import { useEffect, type KeyboardEvent, type PointerEvent } from 'react';
import {
  resetVirtualInput,
  setVirtualInputAction,
  type VirtualInputAction,
} from '../../game/systems/VirtualInput.ts';

interface ControlButtonProps {
  action: VirtualInputAction;
  className: string;
  label: string;
  title: string;
}

function ControlButton({ action, className, label, title }: ControlButtonProps) {
  const setPressed = (active: boolean) => {
    setVirtualInputAction(0, action, active);
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setPressed(true);
  };

  const onPointerRelease = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPressed(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setPressed(true);
  };

  const onKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setPressed(false);
  };

  return (
    <button
      type="button"
      className={`mobile-fight-control ${className}`}
      aria-label={`${title}, player 1`}
      title={title}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onPointerCancel={onPointerRelease}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerRelease}
      onLostPointerCapture={() => setPressed(false)}
    >
      {label}
    </button>
  );
}

export function MobileFightControls() {
  useEffect(() => {
    const releaseAll = () => resetVirtualInput(0);
    window.addEventListener('blur', releaseAll);
    window.addEventListener('pagehide', releaseAll);
    return () => {
      window.removeEventListener('blur', releaseAll);
      window.removeEventListener('pagehide', releaseAll);
      releaseAll();
    };
  }, []);

  return (
    <div className="mobile-fight-controls" aria-label="Player 1 controls">
      <div className="mobile-fight-controls__dpad" role="group" aria-label="Movement">
        <ControlButton action="up" className="is-up" label="↑" title="Jump" />
        <ControlButton action="left" className="is-left" label="←" title="Move left" />
        <ControlButton action="down" className="is-down" label="↓" title="Crouch" />
        <ControlButton action="right" className="is-right" label="→" title="Move right" />
      </div>
      <div className="mobile-fight-controls__actions" role="group" aria-label="Attacks">
        <ControlButton action="fireball" className="is-fireball" label="F" title="Fireball" />
        <ControlButton action="uppercut" className="is-uppercut" label="U" title="Uppercut" />
        <ControlButton action="punch" className="is-punch" label="P" title="Punch" />
        <ControlButton action="kick" className="is-kick" label="K" title="Kick" />
      </div>
    </div>
  );
}
