import Phaser from 'phaser';
import { consumeVirtualInput } from './VirtualInput.ts';
import { EMPTY_INPUT, mergeInputs, type FighterInput } from '../sim/FighterInput.ts';

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

/**
 * Samples keyboard, gamepad, and touch once per render frame (`poll`) and
 * hands the simulation one `FighterInput` per tick (`readPlayer*`). Button
 * edges accumulate between ticks, so a press is never dropped when a render
 * frame runs zero sim ticks and never doubled when it runs two — the local
 * input stream is exactly one sample per tick, which is what netplay sends.
 */
export class InputManager {
  private scene: Phaser.Scene;
  private keys1!: Record<string, Phaser.Input.Keyboard.Key>;
  private keys2!: Record<string, Phaser.Input.Keyboard.Key>;
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

    this.keys1 = {
      left: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      up: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      guard: kb.addKey(Phaser.Input.Keyboard.KeyCodes.G),
      punch: kb.addKey(Phaser.Input.Keyboard.KeyCodes.U),
      kick: kb.addKey(Phaser.Input.Keyboard.KeyCodes.J),
      fireball: kb.addKey(Phaser.Input.Keyboard.KeyCodes.I),
      uppercut: kb.addKey(Phaser.Input.Keyboard.KeyCodes.K),
      super: kb.addKey(Phaser.Input.Keyboard.KeyCodes.O),
    };

    this.keys2 = {
      left: kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT),
      right: kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT),
      up: kb.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
      down: kb.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
      guard: kb.addKey(Phaser.Input.Keyboard.KeyCodes.NUMPAD_ZERO),
      punch: kb.addKey(Phaser.Input.Keyboard.KeyCodes.NUMPAD_FOUR),
      kick: kb.addKey(Phaser.Input.Keyboard.KeyCodes.NUMPAD_ONE),
      fireball: kb.addKey(Phaser.Input.Keyboard.KeyCodes.NUMPAD_FIVE),
      uppercut: kb.addKey(Phaser.Input.Keyboard.KeyCodes.NUMPAD_TWO),
      super: kb.addKey(Phaser.Input.Keyboard.KeyCodes.NUMPAD_SIX),
    };
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

  private pollPlayer(playerIndex: 0 | 1, keys: Record<string, Phaser.Input.Keyboard.Key>): void {
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

  private readKeys(keys: Record<string, Phaser.Input.Keyboard.Key>): FighterInput {
    return {
      left: keys.left.isDown,
      right: keys.right.isDown,
      up: keys.up.isDown,
      down: keys.down.isDown,
      guard: keys.guard.isDown,
      punch: Phaser.Input.Keyboard.JustDown(keys.punch),
      kick: Phaser.Input.Keyboard.JustDown(keys.kick),
      fireball: Phaser.Input.Keyboard.JustDown(keys.fireball),
      uppercut: Phaser.Input.Keyboard.JustDown(keys.uppercut),
      super: Phaser.Input.Keyboard.JustDown(keys.super),
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
