import type { FighterInput } from '../sim/FighterInput.ts';

export interface KeyboardKey {
  readonly keyCode: number;
  readonly label: string;
}

export interface KeyboardBinding extends KeyboardKey {
  readonly aliases?: readonly KeyboardKey[];
}

export type KeyboardControlMap = Readonly<Record<keyof FighterInput, KeyboardBinding>>;

/** Shared by keyboard input and the on-screen legend; importing it never loads Phaser. */
export const KEYBOARD_CONTROLS: readonly [KeyboardControlMap, KeyboardControlMap] = [
  {
    left: { keyCode: 65, label: 'A' },
    right: { keyCode: 68, label: 'D' },
    up: { keyCode: 87, label: 'W' },
    down: { keyCode: 83, label: 'S' },
    guard: { keyCode: 76, label: 'L', aliases: [{ keyCode: 71, label: 'G' }] },
    punch: { keyCode: 74, label: 'J' },
    kick: { keyCode: 75, label: 'K' },
    fireball: { keyCode: 85, label: 'U' },
    uppercut: { keyCode: 73, label: 'I' },
    super: { keyCode: 79, label: 'O' },
  },
  {
    left: { keyCode: 37, label: '←' },
    right: { keyCode: 39, label: '→' },
    up: { keyCode: 38, label: '↑' },
    down: { keyCode: 40, label: '↓' },
    guard: { keyCode: 96, label: 'Num 0' },
    punch: { keyCode: 100, label: 'Num 4' },
    kick: { keyCode: 97, label: 'Num 1' },
    fireball: { keyCode: 101, label: 'Num 5' },
    uppercut: { keyCode: 98, label: 'Num 2' },
    super: { keyCode: 102, label: 'Num 6' },
  },
];
