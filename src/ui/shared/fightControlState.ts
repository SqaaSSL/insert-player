import { EMPTY_INPUT, INPUT_FIELDS, inputsEqual, type FighterInput } from '../../game/sim/FighterInput.ts';
import { KEYBOARD_CONTROLS } from '../../game/systems/KeyboardControls.ts';

export type ControlDevice = 'keyboard' | 'gamepad' | 'touch';
export type ControlMode = 'fight' | 'rush';
export type ControlAction = keyof FighterInput;

export interface PlayerControlState {
  device: 'keyboard' | 'gamepad';
  held: Readonly<FighterInput>;
}

export interface FightControlState {
  device: ControlDevice;
  players: readonly [PlayerControlState, PlayerControlState];
}

export interface ControlGamepad {
  axes: readonly number[];
  buttons: readonly { pressed: boolean }[];
}

/** Held indicators mirror InputManager's standard gamepad mapping, not its attack edges. */
export function gamepadHeldControls(pad: ControlGamepad | null | undefined): FighterInput {
  if (!pad) return { ...EMPTY_INPUT };
  const pressed = (button: number) => Boolean(pad.buttons[button]?.pressed);
  return {
    left: (pad.axes[0] ?? 0) < -0.35 || pressed(14),
    right: (pad.axes[0] ?? 0) > 0.35 || pressed(15),
    up: (pad.axes[1] ?? 0) < -0.35 || pressed(12),
    down: (pad.axes[1] ?? 0) > 0.35 || pressed(13),
    guard: pressed(4) || pressed(5) || pressed(6),
    punch: pressed(0),
    kick: pressed(1),
    fireball: pressed(2),
    uppercut: pressed(3),
    super: pressed(7),
  };
}

function gamepadActivityMask(pad: ControlGamepad | null | undefined): number {
  if (!pad) return 0;
  let mask = 0;
  for (const button of [0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 15]) {
    if (pad.buttons[button]?.pressed) mask |= 1 << button;
  }
  if ((pad.axes[0] ?? 0) < -0.35) mask |= 1 << 16;
  if ((pad.axes[0] ?? 0) > 0.35) mask |= 1 << 17;
  if ((pad.axes[1] ?? 0) < -0.35) mask |= 1 << 18;
  if ((pad.axes[1] ?? 0) > 0.35) mask |= 1 << 19;
  return mask;
}

function keyboardHeldControls(heldKeys: ReadonlySet<number>, player: 0 | 1, mode: ControlMode): FighterInput {
  const held = { ...EMPTY_INPUT };
  for (const action of INPUT_FIELDS) {
    const binding = KEYBOARD_CONTROLS[player][action];
    held[action] = heldKeys.has(binding.keyCode)
      || Boolean(binding.aliases?.some((alias) => heldKeys.has(alias.keyCode)));
  }
  // RushScene also accepts Space for the local P1 jump; Fight does not.
  if (mode === 'rush' && player === 0 && heldKeys.has(32)) held.uppercut = true;
  return held;
}

function playerForKey(keyCode: number, mode: ControlMode, twoPlayers: boolean): 0 | 1 | null {
  if (mode === 'rush' && keyCode === 32) return 0;
  for (const player of (twoPlayers ? [0, 1] : [0]) as (0 | 1)[]) {
    if (Object.values(KEYBOARD_CONTROLS[player]).some((binding) => binding.keyCode === keyCode
      || binding.aliases?.some((alias) => alias.keyCode === keyCode))) return player;
  }
  return null;
}

/** Pure visual state. It never consumes gameplay input or writes to the virtual-input bridge. */
export function createFightControlTracker(
  mode: ControlMode,
  twoPlayers: boolean,
  defaultDevice: 'keyboard' | 'touch' = 'keyboard',
) {
  const heldKeys = new Set<number>();
  let padHeld: [FighterInput, FighterInput] = [{ ...EMPTY_INPUT }, { ...EMPTY_INPUT }];
  let padActivity: [number, number] = [0, 0];
  const devices: ['keyboard' | 'gamepad', 'keyboard' | 'gamepad'] = ['keyboard', 'keyboard'];
  let device: ControlDevice = defaultDevice;
  let snapshot: FightControlState = {
    device,
    players: [{ device: 'keyboard', held: EMPTY_INPUT }, { device: 'keyboard', held: EMPTY_INPUT }],
  };

  const update = () => {
    const players = ([0, 1] as const).map((player) => ({
      device: devices[player],
      held: devices[player] === 'gamepad'
        ? padHeld[player]
        : keyboardHeldControls(heldKeys, player, mode),
    })) as [PlayerControlState, PlayerControlState];
    if (snapshot.device === device && players.every((player, index) =>
      player.device === snapshot.players[index].device && inputsEqual(player.held, snapshot.players[index].held),
    )) return;
    snapshot = { device, players };
  };

  return {
    getSnapshot: () => snapshot,
    keyDown(keyCode: number) {
      const player = playerForKey(keyCode, mode, twoPlayers);
      if (player === null || heldKeys.has(keyCode)) return;
      heldKeys.add(keyCode);
      device = 'keyboard';
      devices[player] = 'keyboard';
      update();
    },
    keyUp(keyCode: number) {
      if (heldKeys.delete(keyCode)) update();
    },
    touch() {
      device = 'touch';
      update();
    },
    gamepads(pads: readonly (ControlGamepad | null)[]) {
      // InputManager assigns players after removing empty browser gamepad slots.
      const connected = pads.filter((pad): pad is ControlGamepad => Boolean(pad));
      const next: [FighterInput, FighterInput] = [
        gamepadHeldControls(connected[0]),
        gamepadHeldControls(twoPlayers ? connected[1] : undefined),
      ];
      const nextActivity: [number, number] = [gamepadActivityMask(connected[0]), gamepadActivityMask(twoPlayers ? connected[1] : undefined)];
      for (const player of (twoPlayers ? [0, 1] : [0]) as (0 | 1)[]) {
        // Distinguish physical aliases: pressing RB while LB is held is new
        // controller activity even though both map to the same guard action.
        const newPress = (nextActivity[player] & ~padActivity[player]) !== 0;
        if (newPress) {
          device = 'gamepad';
          devices[player] = 'gamepad';
        } else if (!connected[player] && devices[player] === 'gamepad') {
          devices[player] = 'keyboard';
        }
      }
      if (device === 'gamepad' && !devices.includes('gamepad')) device = defaultDevice;
      padHeld = next;
      padActivity = nextActivity;
      update();
    },
    reset() {
      heldKeys.clear();
      padHeld = [{ ...EMPTY_INPUT }, { ...EMPTY_INPUT }];
      padActivity = [0, 0];
      update();
    },
  };
}

/** KeyCode matches Phaser, with a code fallback for synthetic/browser events that omit it. */
export function controlKeyCode(event: Pick<KeyboardEvent, 'keyCode' | 'code'>): number {
  if (event.keyCode) return event.keyCode;
  if (/^Key[A-Z]$/.test(event.code)) return event.code.charCodeAt(3);
  if (/^Numpad[0-9]$/.test(event.code)) return 96 + Number(event.code.slice(-1));
  return ({ Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 } as Record<string, number>)[event.code] ?? 0;
}

export function isEditableControlTarget(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return typeof element?.closest === 'function' && Boolean(element.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
  ));
}
