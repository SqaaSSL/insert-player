import Phaser from 'phaser';
import { consumeVirtualInput } from './VirtualInput.ts';
import { EMPTY_INPUT, mergeInputs, type FighterInput } from '../sim/FighterInput.ts';
import { KEYBOARD_CONTROLS, type KeyboardControlMap } from './KeyboardControls.ts';

export { EMPTY_INPUT, type FighterInput };

interface PendingInput {
  /** Latest held state of directions/guard, sampled each render frame. */
  held: FighterInput;
  /** Button edges seen since the last tick consumed them. */
  presses: number;
}

const PRESS_PUNCH = 1;
const PRESS_KICK = 2;
const PRESS_FIREBALL = 4;
const PRESS_UPPERCUT = 8;
const PRESS_SUPER = 16;

type PlayerKeys = Record<keyof FighterInput, Phaser.Input.Keyboard.Key[]>;

/**
 * Samples keyboard, gamepad, and touch once per render frame (`poll`) and
 * hands the simulation one `FighterInput` per tick (`readPlayer*`). Button
 * edges accumulate between ticks, so a press is never dropped when a render
 * frame runs zero sim ticks and never doubled when it runs two — the local
 * input stream is exactly one sample per tick, which is what netplay sends.
 */
export class InputManager {
  private scene: Phaser.Scene;
  private keys1!: PlayerKeys;
  private keys2!: PlayerKeys;
  private gamepadButtons: [Set<number>, Set<number>] = [new Set(), new Set()];
  private pending: [PendingInput, PendingInput] = [
    { held: { ...EMPTY_INPUT }, presses: 0 },
    { held: { ...EMPTY_INPUT }, presses: 0 },
  ];

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.setupKeys();
  }

  private setupKeys(): void {
    const kb = this.scene.input.keyboard!;

    const bindControls = (controls: KeyboardControlMap): PlayerKeys => Object.fromEntries(
      Object.entries(controls).map(([action, binding]) => [
        action,
        [binding, ...(binding.aliases ?? [])].map(({ keyCode }) => kb.addKey(keyCode)),
      ]),
    ) as PlayerKeys;

    this.keys1 = bindControls(KEYBOARD_CONTROLS[0]);
    this.keys2 = bindControls(KEYBOARD_CONTROLS[1]);
  }

  /** Sample every device once. Call exactly once per render frame. */
  poll(): void {
    this.pollPlayer(0, this.keys1);
    this.pollPlayer(1, this.keys2);
  }

  /** Consume the input for the next sim tick. */
  readPlayer1(): FighterInput {
    return this.consume(0);
  }

  readPlayer2(): FighterInput {
    return this.consume(1);
  }

  /** Drop edges and held state (scene shutdown / phase resets). */
  reset(): void {
    for (const pending of this.pending) {
      pending.held = { ...EMPTY_INPUT };
      pending.presses = 0;
    }
    this.gamepadButtons = [new Set(), new Set()];
  }

  private pollPlayer(playerIndex: 0 | 1, keys: PlayerKeys): void {
    const sampled = mergeInputs(
      this.readKeys(keys),
      this.readGamepad(playerIndex),
      consumeVirtualInput(playerIndex),
    );
    const pending = this.pending[playerIndex];
    pending.held = {
      ...EMPTY_INPUT,
      left: sampled.left,
      right: sampled.right,
      up: sampled.up,
      down: sampled.down,
      guard: sampled.guard,
    };
    if (sampled.punch) pending.presses |= PRESS_PUNCH;
    if (sampled.kick) pending.presses |= PRESS_KICK;
    if (sampled.fireball) pending.presses |= PRESS_FIREBALL;
    if (sampled.uppercut) pending.presses |= PRESS_UPPERCUT;
    if (sampled.super) pending.presses |= PRESS_SUPER;
  }

  private consume(playerIndex: 0 | 1): FighterInput {
    const pending = this.pending[playerIndex];
    const presses = pending.presses;
    pending.presses = 0;
    return {
      ...pending.held,
      punch: (presses & PRESS_PUNCH) !== 0,
      kick: (presses & PRESS_KICK) !== 0,
      fireball: (presses & PRESS_FIREBALL) !== 0,
      uppercut: (presses & PRESS_UPPERCUT) !== 0,
      super: (presses & PRESS_SUPER) !== 0,
    };
  }

  private readKeys(keys: PlayerKeys): FighterInput {
    const held = (action: keyof FighterInput) => keys[action].some((key) => key.isDown);
    // Consume every alias edge before combining, so simultaneous aliases cannot
    // leave a stale JustDown pulse behind for the following render frame.
    const pressed = (action: keyof FighterInput) => keys[action]
      .map((key) => Phaser.Input.Keyboard.JustDown(key))
      .some(Boolean);
    return {
      left: held('left'),
      right: held('right'),
      up: held('up'),
      down: held('down'),
      guard: held('guard'),
      punch: pressed('punch'),
      kick: pressed('kick'),
      fireball: pressed('fireball'),
      uppercut: pressed('uppercut'),
      super: pressed('super'),
    };
  }

  private readGamepad(playerIndex: 0 | 1): FighterInput {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return EMPTY_INPUT;

    const pad = Array.from(navigator.getGamepads()).filter((item): item is Gamepad => Boolean(item))[playerIndex];
    if (!pad) {
      this.gamepadButtons[playerIndex].clear();
      return EMPTY_INPUT;
    }

    const axisX = pad.axes[0] ?? 0;
    const axisY = pad.axes[1] ?? 0;
    const isPressed = (buttonIndex: number) => Boolean(pad.buttons[buttonIndex]?.pressed);
    const currentButtons = new Set<number>();
    for (let index = 0; index < pad.buttons.length; index += 1) {
      if (isPressed(index)) currentButtons.add(index);
    }
    const previousButtons = this.gamepadButtons[playerIndex];
    const justPressed = (buttonIndex: number) => currentButtons.has(buttonIndex) && !previousButtons.has(buttonIndex);
    this.gamepadButtons[playerIndex] = currentButtons;

    return {
      left: axisX < -0.35 || isPressed(14),
      right: axisX > 0.35 || isPressed(15),
      up: axisY < -0.35 || isPressed(12),
      down: axisY > 0.35 || isPressed(13),
      guard: isPressed(4) || isPressed(5) || isPressed(6),
      punch: justPressed(0),
      kick: justPressed(1),
      fireball: justPressed(2),
      uppercut: justPressed(3),
      super: justPressed(7),
    };
  }
}
