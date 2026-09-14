import { KEYBOARD_CONTROLS } from '../../game/systems/KeyboardControls.ts';
import { type ControlAction, type ControlMode, type PlayerControlState } from '../shared/fightControlState.ts';
import { useFightControlState } from '../shared/useFightControlState.ts';
import { useArcadeTouchLayout } from '../shared/useArcadeTouchLayout.ts';
import { TouchArcadePanel } from './TouchArcadePanel.tsx';
import { ArcadeKeyboard } from './ArcadeKeyboard.tsx';

const GAMEPAD_KEYS: Record<ControlAction, string> = {
  left: '←', right: '→', up: '↑', down: '↓',
  punch: 'A / ×', kick: 'B / ○', guard: 'LB / L1',
  fireball: 'X / □', uppercut: 'Y / △', super: 'RT / R2',
};

function labelFor(action: ControlAction, mode: ControlMode): string {
  return ({
    left: 'Left', right: 'Right', up: mode === 'rush' ? 'Up' : 'Jump', down: mode === 'rush' ? 'Down' : 'Crouch',
    punch: 'Punch', kick: 'Kick', guard: 'Guard', fireball: 'Fireball',
    uppercut: mode === 'rush' ? 'Jump' : 'Uppercut', super: 'Super',
  })[action];
}

function PlayerPanel({ mode, playerIndex, playerLabel, state }: {
  mode: ControlMode;
  playerIndex: 0 | 1;
  playerLabel: string;
  state: PlayerControlState;
}) {
  const keyboard = KEYBOARD_CONTROLS[playerIndex];
  const gamepad = state.device === 'gamepad';
  const keyFor = (action: ControlAction) => gamepad ? GAMEPAD_KEYS[action] : keyboard[action].label.replace('Num ', 'N');
  const keysFor = (action: ControlAction) => {
    if (gamepad) return action === 'guard' ? 'LB / L1, RB / R1, or LT / L2' : GAMEPAD_KEYS[action];
    const aliases = keyboard[action].aliases?.map((alias) => alias.label) ?? [];
    if (mode === 'rush' && playerIndex === 0 && action === 'uppercut') aliases.push('Space');
    return [keyboard[action].label, ...aliases].join(' or ');
  };
  const accessibleLabel = (action: ControlAction) => `${labelFor(action, mode)}: ${keysFor(action)}${state.held[action] ? ', pressed' : ''}`;
  const actionButton = (action: ControlAction) => (
    <span
      key={action}
      className={`fight-keys__button fight-keys__button--${action}`}
      data-action={action}
      data-active={state.held[action]}
      role="img"
      aria-label={accessibleLabel(action)}
      title={`${labelFor(action, mode)} · ${keysFor(action)}${action === 'super' && mode === 'fight' ? ' · Full meter' : ''}`}
    >
      <span className="fight-keys__cap"><kbd>{keyFor(action)}</kbd></span>
      <span className="fight-keys__action">{labelFor(action, mode)}</span>
    </span>
  );
  return (
    <div className={`fight-keys__player fight-keys__player--${state.device}`} role="group" aria-label={`${playerLabel} ${state.device} controls`}>
      <span className="fight-keys__fasteners" aria-hidden="true"><i /><i /><i /><i /></span>
      <strong className="fight-keys__player-label">{playerLabel}<span>{gamepad ? 'Controller' : playerIndex === 1 ? 'Numpad' : 'Keyboard'}</span></strong>
      <div className="fight-keys__deck">
        <div className="fight-keys__movement">
          <div className="fight-keys__stick" role="group" aria-label={mode === 'rush' ? 'Move in all directions' : 'Move, jump and crouch'}>
            {(['up', 'left', 'down', 'right'] as const).map((action) => (
              <span
                key={action}
                className={`fight-keys__direction fight-keys__direction--${action}`}
                data-action={action}
                data-active={state.held[action]}
                role="img"
                aria-label={accessibleLabel(action)}
                title={accessibleLabel(action)}
              >
                <kbd>{keyFor(action)}</kbd>
                {mode === 'fight' && (action === 'up' || action === 'down')
                  ? <small>{labelFor(action, mode)}</small> : null}
              </span>
            ))}
            <span className="fight-keys__stick-base" aria-hidden="true" />
            <span
              className="fight-keys__stick-knob"
              data-x={Number(state.held.right) - Number(state.held.left)}
              data-y={Number(state.held.down) - Number(state.held.up)}
              aria-hidden="true"
            >
              <span className="fight-keys__stick-shaft" />
              <span className="fight-keys__stick-ball" />
            </span>
          </div>
          <span className="fight-keys__movement-label">{gamepad ? 'Stick / D-pad' : 'Move'}</span>
        </div>
        <div className="fight-keys__actions">
          <div className="fight-keys__primary" role="group" aria-label="Four action buttons">
            <div className="fight-keys__row fight-keys__row--specials">{(['fireball', 'uppercut'] as const).map(actionButton)}</div>
            <div className="fight-keys__row fight-keys__row--main">{(['punch', 'kick'] as const).map(actionButton)}</div>
          </div>
          <div className="fight-keys__utility" role="group" aria-label="Super and guard">
            {(['super', 'guard'] as const).map(actionButton)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A persistent cabinet legend on desktop becomes the controls on touch screens. */
export function FightControlsHint({
  mode = 'fight',
  twoPlayers = false,
  playerLabel = 'P1',
  disabled = false,
  hudPlayerIndex = 0,
  inputResetKey = 0,
}: {
  mode?: 'fight' | 'rush';
  twoPlayers?: boolean;
  playerLabel?: string;
  disabled?: boolean;
  hudPlayerIndex?: 0 | 1;
  inputResetKey?: number;
}) {
  const state = useFightControlState(mode, twoPlayers);
  const compact = useArcadeTouchLayout();
  const touch = compact || state.device === 'touch';
  const keyboard = !touch && !twoPlayers && state.players[0].device === 'keyboard';
  return (
    <section className={`fight-keys fight-keys--${touch ? 'touch' : state.device}${twoPlayers ? ' fight-keys--two-players' : ''}`} aria-label={`${mode === 'rush' ? 'Rush' : 'Fight'} controls`}>
      {touch && !twoPlayers ? (
        <TouchArcadePanel mode={mode} playerLabel={playerLabel} state={state.players[0]}
          disabled={disabled} hudPlayerIndex={hudPlayerIndex} inputResetKey={inputResetKey} />
      ) : keyboard ? (
        <ArcadeKeyboard mode={mode} playerIndex={0} playerLabel={playerLabel} state={state.players[0]} />
      ) : (
        <div className="fight-keys__players">
          <PlayerPanel mode={mode} playerIndex={0} playerLabel={playerLabel} state={state.players[0]} />
          {twoPlayers ? <PlayerPanel mode={mode} playerIndex={1} playerLabel="P2" state={state.players[1]} /> : null}
        </div>
      )}
      <p className="fight-keys__tip">{mode === 'rush'
        ? 'Hold Guard near a fallen ally to revive.'
        : 'Hold Guard · ↓ + Punch or Kick = low attack.'}</p>
    </section>
  );
}
