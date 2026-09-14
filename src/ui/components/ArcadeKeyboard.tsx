import { KEYBOARD_CONTROLS } from '../../game/systems/KeyboardControls.ts';
import { type ControlAction, type ControlMode, type PlayerControlState } from '../shared/fightControlState.ts';

interface KeyboardKey {
  label: string;
  code?: number;
  size?: 'tab' | 'caps' | 'enter' | 'shift' | 'space' | 'modifier';
}

const letters = (text: string): KeyboardKey[] => [...text].map((label) => ({ label, code: label.charCodeAt(0) }));
const KEY_ROWS: readonly KeyboardKey[][] = [
  [{ label: 'tab', size: 'tab' }, ...letters('QWERTYUIOP'), { label: '[' }, { label: ']' }, { label: '\\' }],
  [{ label: 'caps', size: 'caps' }, ...letters('ASDFGHJKL'), { label: ';' }, { label: "'" }, { label: 'enter', size: 'enter' }],
  [{ label: 'shift', size: 'shift' }, ...letters('ZXCVBNM'), { label: ',' }, { label: '.' }, { label: '/' }, { label: 'shift', size: 'shift' }],
  [{ label: 'ctrl', size: 'modifier' }, { label: 'fn', size: 'modifier' }, { label: 'alt', size: 'modifier' }, { label: 'space', code: 32, size: 'space' }, { label: 'alt', size: 'modifier' }, { label: 'fn', size: 'modifier' }, { label: 'ctrl', size: 'modifier' }],
];

const NUMPAD_ROWS: readonly KeyboardKey[][] = [
  [{ label: 'num' }, { label: '/' }, { label: '*' }, { label: '−' }],
  [{ label: '7', code: 103 }, { label: '8', code: 104 }, { label: '9', code: 105 }, { label: '+' }],
  [{ label: '4', code: 100 }, { label: '5', code: 101 }, { label: '6', code: 102 }],
  [{ label: '1', code: 97 }, { label: '2', code: 98 }, { label: '3', code: 99 }],
  [{ label: '0', code: 96, size: 'caps' }, { label: '.' }, { label: 'enter', size: 'enter' }],
];

function actionLabel(action: ControlAction, mode: ControlMode): string {
  return {
    left: 'Left', right: 'Right', up: mode === 'rush' ? 'Up' : 'Jump', down: mode === 'rush' ? 'Down' : 'Crouch',
    punch: 'Punch', kick: 'Kick', guard: 'Guard', fireball: 'Fireball',
    uppercut: mode === 'rush' ? 'Jump' : 'Uppercut', super: 'Super',
  }[action];
}

/** The real key geography remains visible beneath the physical arcade controls. */
export function ArcadeKeyboard({ mode, playerIndex, playerLabel, state }: {
  mode: ControlMode;
  playerIndex: 0 | 1;
  playerLabel: string;
  state: PlayerControlState;
}) {
  const bindings = KEYBOARD_CONTROLS[playerIndex];
  const key = ({ label, code, size }: KeyboardKey, index = 0) => {
    const primary = (Object.keys(bindings) as ControlAction[]).find((action) => bindings[action].keyCode === code);
    const alias = (Object.keys(bindings) as ControlAction[]).find((action) => bindings[action].aliases?.some((binding) => binding.keyCode === code));
    const action = primary ?? alias ?? (mode === 'rush' && playerIndex === 0 && code === 32 ? 'uppercut' : undefined);
    const movement = action === 'up' || action === 'left' || action === 'down' || action === 'right';
    const arcade = primary && !movement;
    const active = action ? state.held[action] : false;
    const name = action ? actionLabel(action, mode) : undefined;
    const accessibleKey = primary ? bindings[primary].label : label === 'space' ? 'Space' : label;
    return (
      <span
        key={`${label}-${code ?? size ?? ''}-${index}`}
        className={`arcade-keyboard__key${size ? ` arcade-keyboard__key--${size}` : ''}${movement ? ' arcade-keyboard__key--movement' : ''}${arcade ? ' arcade-keyboard__key--arcade' : ''}${action && !primary ? ' arcade-keyboard__key--alias' : ''}`}
        data-key={label}
        data-action={action}
        data-active={active}
        role={action ? 'img' : undefined}
        aria-label={action ? `${name}: ${accessibleKey}${active ? ', pressed' : ''}` : undefined}
        aria-hidden={action ? undefined : true}
        title={action ? `${name} · ${accessibleKey}` : undefined}
      >
        {arcade ? (
          <span className={`fight-keys__button fight-keys__button--${action} arcade-keyboard__button`} data-active={active}>
            <span className="fight-keys__cap"><kbd>{label}</kbd></span>
            <span className="arcade-keyboard__action">{name}</span>
          </span>
        ) : <><kbd>{label}</kbd>{movement || (action && label !== 'space') ? <small>{name}</small> : null}{action && label === 'space' ? <small>Jump</small> : null}</>}
        {primary === 'up' ? (
          <span className="arcade-keyboard__joystick" aria-hidden="true">
            <span className="arcade-keyboard__stick-base" />
            <span className="arcade-keyboard__stick-knob" data-x={Number(state.held.right) - Number(state.held.left)} data-y={Number(state.held.down) - Number(state.held.up)}>
              <span className="arcade-keyboard__stick-shaft" />
              <span className="arcade-keyboard__stick-ball" />
            </span>
          </span>
        ) : null}
      </span>
    );
  };

  return (
    <div className={`arcade-keyboard${playerIndex === 1 ? ' arcade-keyboard--numpad' : ''}`} role="group" aria-label={`${playerLabel} keyboard controls`}>
      <span className="fight-keys__fasteners" aria-hidden="true"><i /><i /><i /><i /></span>
      <div className="arcade-keyboard__header"><strong>{playerLabel}</strong><span>{playerIndex === 0 ? 'WASD' : 'Arrows'} · Move</span><span>Keyboard arcade</span></div>
      {playerIndex === 0 ? <div className="arcade-keyboard__rows">
        {KEY_ROWS.map((row, index) => <div className={`arcade-keyboard__row arcade-keyboard__row--${index}`} key={index}>{row.map(key)}</div>)}
      </div> : <div className="arcade-keyboard__secondary">
        <div className="arcade-keyboard__arrows">
          <div className="arcade-keyboard__arrow-up">{key({ label: '↑', code: 38 })}</div>
          <div className="arcade-keyboard__row">{[{ label: '←', code: 37 }, { label: '↓', code: 40 }, { label: '→', code: 39 }].map(key)}</div>
        </div>
        <div className="arcade-keyboard__number-rows">{NUMPAD_ROWS.map((row, index) => <div className={`arcade-keyboard__row arcade-keyboard__number-row--${index}`} key={index}>{row.map(key)}</div>)}</div>
      </div>}
    </div>
  );
}
