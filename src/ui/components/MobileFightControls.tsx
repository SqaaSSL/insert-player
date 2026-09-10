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
  disabled?: boolean;
}

function ControlButton({
  action,
  className,
  label,
  playerIndex,
  playerLabel,
  title,
  disabled = false,
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
      disabled={disabled}
      onBlur={() => setPressed(false)}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onPointerCancel={onPointerRelease}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerRelease}
      onLostPointerCapture={() => setPressed(false)}
    >
      <span>{label}</span>
      {disabled ? <small>Charge meter</small> : action === 'guard' ? <small>Hold</small> : null}
    </button>
  );
}

export function MobileFightControls({
  mode = 'fight',
  playerIndex = 0,
  playerLabel = 'player 1',
  hudPlayerIndex = playerIndex,
}: {
  mode?: 'fight' | 'rush';
  playerIndex?: 0 | 1;
  playerLabel?: string;
  hudPlayerIndex?: 0 | 1;
}) {
  const [superReady, setSuperReady] = useState(false);

  useEffect(() => {
    const onHudState = (event: WindowEventMap[typeof HUD_STATE_EVENT]) => {
      const meter = hudPlayerIndex === 0 ? event.detail.p1Meter : event.detail.p2Meter;
      setSuperReady(meter >= event.detail.meterMax);
    };
    window.addEventListener(HUD_STATE_EVENT, onHudState);
    return () => window.removeEventListener(HUD_STATE_EVENT, onHudState);
  }, [hudPlayerIndex]);

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
      <VirtualJoystick mode={mode} playerIndex={playerIndex} playerLabel={playerLabel} />
      <div className="mobile-fight-controls__actions" role="group" aria-label="Attacks">
        <ControlButton action="punch" className="is-punch" label="Punch" playerIndex={playerIndex} playerLabel={playerLabel} title="Punch" />
        <ControlButton action="kick" className="is-kick" label="Kick" playerIndex={playerIndex} playerLabel={playerLabel} title="Kick" />
        <ControlButton action="fireball" className="is-fireball" label="Fireball" playerIndex={playerIndex} playerLabel={playerLabel} title="Fireball" />
        <ControlButton
          action="uppercut"
          className={mode === 'rush' ? 'is-jump' : 'is-uppercut'}
          label={mode === 'rush' ? 'Jump' : 'Uppercut'}
          playerIndex={playerIndex}
          playerLabel={playerLabel}
          title={mode === 'rush' ? 'Jump' : 'Uppercut'}
        />
        <ControlButton action="super" className="is-super" label="Super" playerIndex={playerIndex} playerLabel={playerLabel} title="Super fireball" disabled={mode === 'fight' && !superReady} />
        <ControlButton action="guard" className="is-guard" label="Guard" playerIndex={playerIndex} playerLabel={playerLabel} title="Guard (hold)" />
      </div>
    </div>
  );
}
