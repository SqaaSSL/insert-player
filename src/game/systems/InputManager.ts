import Phaser from 'phaser';
import { consumeVirtualInput, type VirtualInputSnapshot } from './VirtualInput.ts';

export interface FighterInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  guard: boolean;
  punch: boolean;
  kick: boolean;
  fireball: boolean;
  uppercut: boolean;
}

export const EMPTY_INPUT: FighterInput = {
  left: false,
  right: false,
  up: false,
  down: false,
  guard: false,
  punch: false,
  kick: false,
  fireball: false,
  uppercut: false,
};

export class InputManager {
  private scene: Phaser.Scene;
  private keys1!: Record<string, Phaser.Input.Keyboard.Key>;
  private keys2!: Record<string, Phaser.Input.Keyboard.Key>;
  private gamepadButtons: [Set<number>, Set<number>] = [new Set(), new Set()];

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
    };
  }

  readPlayer1(): FighterInput {
    return this.readPlayer(0, this.keys1);
  }

  readPlayer2(): FighterInput {
    return this.readPlayer(1, this.keys2);
  }

  private readPlayer(playerIndex: 0 | 1, keys: Record<string, Phaser.Input.Keyboard.Key>): FighterInput {
    return this.mergeInputs(
      this.readKeys(keys),
      this.readGamepad(playerIndex),
      consumeVirtualInput(playerIndex),
    );
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
      guard: isPressed(4) || isPressed(5) || isPressed(6) || isPressed(7),
      punch: justPressed(0),
      kick: justPressed(1),
      fireball: justPressed(2),
      uppercut: justPressed(3),
    };
  }

  private mergeInputs(...inputs: Array<FighterInput | VirtualInputSnapshot>): FighterInput {
    return {
      left: inputs.some((input) => input.left),
      right: inputs.some((input) => input.right),
      up: inputs.some((input) => input.up),
      down: inputs.some((input) => input.down),
      guard: inputs.some((input) => input.guard),
      punch: inputs.some((input) => input.punch),
      kick: inputs.some((input) => input.kick),
      fireball: inputs.some((input) => input.fireball),
      uppercut: inputs.some((input) => input.uppercut),
    };
  }
}
