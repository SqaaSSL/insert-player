import Phaser from 'phaser';

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
    return this.readKeys(this.keys1);
  }

  readPlayer2(): FighterInput {
    return this.readKeys(this.keys2);
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
}
