import { useEffect, useState } from 'react';
import { KEYBOARD_CONTROLS } from '../../game/systems/KeyboardControls.ts';

type InputDevice = 'keyboard' | 'gamepad' | 'touch';

function initialDevice(): InputDevice {
  if (typeof window === 'undefined') return 'keyboard';
  if (Array.from(navigator.getGamepads?.() ?? []).some(Boolean)) return 'gamepad';
  return window.matchMedia?.('(pointer: coarse)').matches ? 'touch' : 'keyboard';
}

function useInputDevice(): InputDevice {
  const [device, setDevice] = useState(initialDevice);
  useEffect(() => {
    const onKey = () => setDevice('keyboard');
    const onPointer = (event: PointerEvent) => {
      if (event.pointerType === 'touch') setDevice('touch');
    };
    const onConnect = () => setDevice('gamepad');
    const onDisconnect = () => setDevice(initialDevice());
    const gamepadTimer = window.setInterval(() => {
      if (document.hidden) return;
      const active = Array.from(navigator.getGamepads?.() ?? []).some((pad) =>
        pad && (pad.buttons.some((button) => button.pressed) || pad.axes.some((axis) => Math.abs(axis) > 0.35)),
      );
      if (active) setDevice('gamepad');
    }, 200);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('gamepadconnected', onConnect);
    window.addEventListener('gamepaddisconnected', onDisconnect);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('gamepadconnected', onConnect);
      window.removeEventListener('gamepaddisconnected', onDisconnect);
      window.clearInterval(gamepadTimer);
    };
  }, []);
  return device;
}

function Binding({ keys, action }: { keys: string; action: string }) {
  return <span className="fight-keys__binding"><kbd>{keys}</kbd><span>{action}</span></span>;
}

function KeyboardLegend({ mode, playerIndex, playerLabel }: {
  mode: 'fight' | 'rush';
  playerIndex: 0 | 1;
  playerLabel: string;
}) {
  const keys = KEYBOARD_CONTROLS[playerIndex];
  const movement = playerIndex === 0 ? 'W A S D' : '↑ ← ↓ →';
  return (
    <div className="fight-keys__player" role="group" aria-label={`${playerLabel} keyboard controls`}>
      <strong className="fight-keys__player-label">{playerLabel}{playerIndex === 1 ? ' · Numpad' : ''}</strong>
      <div className="fight-keys__bindings">
        {mode === 'rush' ? <Binding keys={movement} action="Move" /> : (
          <>
            <Binding keys={`${keys.left.label} ${keys.right.label}`} action="Move" />
            <Binding keys={keys.up.label} action="Jump" />
            <Binding keys={keys.down.label} action="Crouch" />
          </>
        )}
        <Binding keys={keys.punch.label} action="Punch" />
        <Binding keys={keys.kick.label} action="Kick" />
        <Binding keys={keys.guard.label} action="Guard (hold)" />
        <Binding keys={keys.fireball.label} action="Fireball" />
        <Binding keys={mode === 'rush' && playerIndex === 0 ? `Space / ${keys.uppercut.label}` : keys.uppercut.label} action={mode === 'rush' ? 'Jump' : 'Uppercut'} />
        <Binding keys={keys.super.label} action={mode === 'rush' ? 'Super' : 'Super (full meter)'} />
      </div>
    </div>
  );
}

/** The essentials stay visible for the entire match, including rematches. */
export function FightControlsHint({
  mode = 'fight',
  twoPlayers = false,
  playerLabel = 'P1',
}: {
  mode?: 'fight' | 'rush';
  twoPlayers?: boolean;
  playerLabel?: string;
}) {
  const device = useInputDevice();
  return (
    <section className={`fight-keys fight-keys--${device}`} aria-label={`${mode === 'rush' ? 'Rush' : 'Fight'} controls`}>
      {device === 'touch' ? (
        <p className="fight-keys__tip">{mode === 'rush'
          ? 'Hold Guard near a fallen ally to revive.'
          : 'Drag up to jump. Down + Punch or Kick for a low attack.'}</p>
      ) : device === 'gamepad' ? (
        <div className="fight-keys__bindings" role="group" aria-label="Gamepad controls">
          <Binding keys="Stick / D-pad" action={mode === 'rush' ? 'Move' : 'Move · ↑ Jump · ↓ Crouch'} />
          <Binding keys="A / ×" action="Punch" />
          <Binding keys="B / ○" action="Kick" />
          <Binding keys="LB / L1" action="Guard (hold)" />
          <Binding keys="X / □" action="Fireball" />
          <Binding keys="Y / △" action={mode === 'rush' ? 'Jump' : 'Uppercut'} />
          <Binding keys="RT / R2" action={mode === 'rush' ? 'Super' : 'Super (full meter)'} />
        </div>
      ) : (
        <>
          <KeyboardLegend mode={mode} playerIndex={0} playerLabel={playerLabel} />
          {twoPlayers ? <KeyboardLegend mode={mode} playerIndex={1} playerLabel="P2" /> : null}
        </>
      )}
    </section>
  );
}
