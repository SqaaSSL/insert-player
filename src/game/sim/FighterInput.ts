/**
 * Per-tick input for one fighter. This is the ONLY thing the deterministic
 * match simulation consumes from the outside world, so it is intentionally a
 * flat, serializable struct: netplay ships it as a 10-bit mask (`packInput`),
 * replays store one per tick, and rollback re-feeds it after a misprediction.
 */
export interface FighterInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  guard: boolean;
  /** One-shot press (edge), not a held state. */
  punch: boolean;
  kick: boolean;
  fireball: boolean;
  uppercut: boolean;
  /** One-shot: spend a full super meter on a SUPER FIREBALL. */
  super: boolean;
}

export const EMPTY_INPUT: Readonly<FighterInput> = Object.freeze({
  left: false,
  right: false,
  up: false,
  down: false,
  guard: false,
  punch: false,
  kick: false,
  fireball: false,
  uppercut: false,
  super: false,
});

export const INPUT_FIELDS = [
  'left',
  'right',
  'up',
  'down',
  'guard',
  'punch',
  'kick',
  'fireball',
  'uppercut',
  'super',
] as const satisfies ReadonlyArray<keyof FighterInput>;

export const INPUT_BITS = INPUT_FIELDS.length;
export const INPUT_MASK = (1 << INPUT_BITS) - 1;

/** Encode an input as a 10-bit integer (bit i = INPUT_FIELDS[i]). */
export function packInput(input: FighterInput): number {
  let bits = 0;
  for (let i = 0; i < INPUT_FIELDS.length; i++) {
    if (input[INPUT_FIELDS[i]]) bits |= 1 << i;
  }
  return bits;
}

export function unpackInput(bits: number): FighterInput {
  const b = bits & INPUT_MASK;
  return {
    left: (b & 1) !== 0,
    right: (b & 2) !== 0,
    up: (b & 4) !== 0,
    down: (b & 8) !== 0,
    guard: (b & 16) !== 0,
    punch: (b & 32) !== 0,
    kick: (b & 64) !== 0,
    fireball: (b & 128) !== 0,
    uppercut: (b & 256) !== 0,
    super: (b & 512) !== 0,
  };
}

export function inputsEqual(a: FighterInput, b: FighterInput): boolean {
  return packInput(a) === packInput(b);
}

/** OR-merge several input sources (keyboard + gamepad + touch). */
export function mergeInputs(...inputs: FighterInput[]): FighterInput {
  let bits = 0;
  for (const input of inputs) bits |= packInput(input);
  return unpackInput(bits);
}
