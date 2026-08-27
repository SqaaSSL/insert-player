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
  playerIndex: 0 | 1;
  playerLabel: string;
  title: string;
}

function ControlButton({
  action,
  className,
  label,
  playerIndex,
  playerLabel,
  title,
}: ControlButtonProps) {
  const setPressed = (active: boolean) => {
    setVirtualInputAction(playerIndex, action, active);
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
      aria-label={`${title}, ${playerLabel}`}
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

export function MobileFightControls({
  playerIndex = 0,
  playerLabel = 'player 1',
}: {
  playerIndex?: 0 | 1;
  playerLabel?: string;
}) {
  useEffect(() => {
    const releaseAll = () => resetVirtualInput(playerIndex);
    window.addEventListener('blur', releaseAll);
    window.addEventListener('pagehide', releaseAll);
    return () => {
      window.removeEventListener('blur', releaseAll);
      window.removeEventListener('pagehide', releaseAll);
      releaseAll();
    };
  }, [playerIndex]);

  return (
    <div className="mobile-fight-controls" aria-label={`${playerLabel} controls`}>
      <div className="mobile-fight-controls__dpad" role="group" aria-label="Movement">
        <ControlButton action="up" className="is-up" label="↑" playerIndex={playerIndex} playerLabel={playerLabel} title="Jump" />
        <ControlButton action="left" className="is-left" label="←" playerIndex={playerIndex} playerLabel={playerLabel} title="Move left" />
        <ControlButton action="down" className="is-down" label="↓" playerIndex={playerIndex} playerLabel={playerLabel} title="Crouch" />
        <ControlButton action="right" className="is-right" label="→" playerIndex={playerIndex} playerLabel={playerLabel} title="Move right" />
      </div>
      <div className="mobile-fight-controls__actions" role="group" aria-label="Attacks">
        <ControlButton action="fireball" className="is-fireball" label="F" playerIndex={playerIndex} playerLabel={playerLabel} title="Fireball" />
        <ControlButton action="uppercut" className="is-uppercut" label="U" playerIndex={playerIndex} playerLabel={playerLabel} title="Uppercut" />
        <ControlButton action="punch" className="is-punch" label="P" playerIndex={playerIndex} playerLabel={playerLabel} title="Punch" />
        <ControlButton action="kick" className="is-kick" label="K" playerIndex={playerIndex} playerLabel={playerLabel} title="Kick" />
      </div>
    </div>
  );
}
