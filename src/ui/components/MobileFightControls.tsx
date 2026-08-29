import { useEffect, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  resetVirtualInput,
  setVirtualInputAction,
  type VirtualInputAction,
} from '../../game/systems/VirtualInput.ts';
import { HUD_STATE_EVENT } from '../../game/match/MatchConfig.ts';
import { VirtualJoystick } from './VirtualJoystick.tsx';

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
  const [superReady, setSuperReady] = useState(false);

  useEffect(() => {
    const onHudState = (event: WindowEventMap[typeof HUD_STATE_EVENT]) => {
      const meter = playerIndex === 0 ? event.detail.p1Meter : event.detail.p2Meter;
      setSuperReady(meter >= event.detail.meterMax);
    };
    window.addEventListener(HUD_STATE_EVENT, onHudState);
    return () => window.removeEventListener(HUD_STATE_EVENT, onHudState);
  }, [playerIndex]);

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
      <VirtualJoystick playerIndex={playerIndex} playerLabel={playerLabel} />
      <div className="mobile-fight-controls__actions" role="group" aria-label="Attacks">
        <ControlButton action="fireball" className="is-fireball" label="F" playerIndex={playerIndex} playerLabel={playerLabel} title="Fireball" />
        {superReady ? (
          <ControlButton action="super" className="is-super" label="S!" playerIndex={playerIndex} playerLabel={playerLabel} title="Super fireball" />
        ) : (
          <span className="mobile-fight-controls__slot" aria-hidden="true" />
        )}
        <ControlButton action="punch" className="is-punch" label="P" playerIndex={playerIndex} playerLabel={playerLabel} title="Punch" />
        <ControlButton action="kick" className="is-kick" label="K" playerIndex={playerIndex} playerLabel={playerLabel} title="Kick" />
        <ControlButton action="guard" className="is-guard" label="G" playerIndex={playerIndex} playerLabel={playerLabel} title="Guard (hold)" />
      </div>
    </div>
  );
}
