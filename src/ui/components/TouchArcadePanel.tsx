import { useEffect, useState } from 'react';
import { HUD_STATE_EVENT } from '../../game/match/MatchConfig.ts';
import type { VirtualInputAction } from '../../game/systems/VirtualInput.ts';
import type { PlayerControlState } from '../shared/fightControlState.ts';
import { useVirtualArcadeInput } from '../shared/useVirtualArcadeInput.ts';

export function TouchArcadePanel({ mode, playerLabel, state, disabled = false, hudPlayerIndex = 0, inputResetKey = 0 }: {
  mode: 'fight' | 'rush';
  playerLabel: string;
  state: PlayerControlState;
  disabled?: boolean;
  hudPlayerIndex?: 0 | 1;
  inputResetKey?: number;
}) {
  const input = useVirtualArcadeInput({ mode, playerIndex: 0, disabled, resetKey: inputResetKey });
  const [superReady, setSuperReady] = useState(false);
  useEffect(() => {
    setSuperReady(false);
    const onHud = (event: WindowEventMap[typeof HUD_STATE_EVENT]) => {
      const meter = hudPlayerIndex === 0 ? event.detail.p1Meter : event.detail.p2Meter;
      setSuperReady(meter >= event.detail.meterMax);
    };
    window.addEventListener(HUD_STATE_EVENT, onHud);
    return () => window.removeEventListener(HUD_STATE_EVENT, onHud);
  }, [hudPlayerIndex]);
  const held = (action: VirtualInputAction) => input.held[action] || state.held[action];
  const label = (action: VirtualInputAction): string => ({
    left: 'Left', right: 'Right', up: mode === 'fight' ? 'Jump' : 'Up',
    down: mode === 'fight' ? 'Crouch' : 'Down', punch: 'Punch', kick: 'Kick',
    fireball: 'Fireball', uppercut: mode === 'fight' ? 'Uppercut' : 'Jump', super: 'Super', guard: 'Guard',
  })[action];
  const actionButton = (action: VirtualInputAction) => {
    const charging = action === 'super' && mode === 'fight' && !superReady;
    return <button key={action} type="button"
      className={`fight-keys__button fight-keys__button--${action}`}
      data-action={action} data-active={held(action)} disabled={disabled || charging}
      aria-label={`${label(action)}, ${playerLabel}${charging ? ', needs a full meter' : ''}`}
      aria-pressed={held(action)} {...input.button(action, charging)}>
      <span className="fight-keys__cap"><span>{label(action)}</span></span>
      {action === 'super' || action === 'guard'
        ? <span className="fight-keys__action">{action === 'guard' ? 'Hold' : charging ? 'Charge' : 'Ready'}</span> : null}
    </button>;
  };
  return <div className="fight-keys__player fight-keys__player--touch" role="group" aria-label={`${playerLabel} touch controls`}>
    <span className="fight-keys__fasteners" aria-hidden="true"><i /><i /><i /><i /></span>
    <strong className="fight-keys__player-label">{playerLabel}</strong>
    <div className="fight-keys__deck">
      <div className="fight-keys__movement">
        <div className="fight-keys__stick" role="group" aria-label={mode === 'fight' ? 'Move, jump and crouch' : 'Move in all directions'}>
          {(['up', 'left', 'down', 'right'] as const).map(action => <button key={action} type="button"
            className={`fight-keys__direction fight-keys__direction--${action}`}
            data-action={action} data-active={held(action)} disabled={disabled}
            aria-label={`${label(action)}, ${playerLabel}`} aria-pressed={held(action)} {...input.button(action)}>
            <span aria-hidden="true">{({ up: '↑', left: '←', down: '↓', right: '→' })[action]}</span>
            {mode === 'fight' && (action === 'up' || action === 'down') ? <small>{label(action)}</small> : null}
          </button>)}
          <div className="fight-keys__touch-stick" aria-label="Drag joystick to move" {...input.joystick}>
            <span className="fight-keys__stick-base" aria-hidden="true" />
            <span className="fight-keys__stick-knob" aria-hidden="true"
              data-x={Number(held('right')) - Number(held('left'))}
              data-y={Number(held('down')) - Number(held('up'))}>
              <span className="fight-keys__stick-shaft" /><span className="fight-keys__stick-ball" />
            </span>
          </div>
        </div>
        <span className="fight-keys__movement-label">Drag or tap</span>
      </div>
      <div className="fight-keys__actions">
        <div className="fight-keys__primary" role="group" aria-label="Four action buttons">
          <div className="fight-keys__row">{(['fireball', 'uppercut'] as const).map(actionButton)}</div>
          <div className="fight-keys__row">{(['punch', 'kick'] as const).map(actionButton)}</div>
        </div>
        <div className="fight-keys__utility" role="group" aria-label="Super and guard">
          {(['super', 'guard'] as const).map(actionButton)}
        </div>
      </div>
    </div>
  </div>;
}
