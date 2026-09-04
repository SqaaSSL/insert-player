import { EMPTY_INPUT, type FighterInput } from '../sim/FighterInput.ts';

/**
 * Rush keeps Fight's network-safe input payload and adds one mode-local edge.
 * `uppercut` is also accepted as jump so keyboard K, numpad 2, controllers,
 * touch, and future remote input work before Rush gets its own bindings UI.
 */
export interface BrawlInput extends FighterInput {
  jump: boolean;
}

export type BrawlInputLike = FighterInput & Partial<Pick<BrawlInput, 'jump'>>;

export const EMPTY_BRAWL_INPUT: Readonly<BrawlInput> = Object.freeze({
  ...EMPTY_INPUT,
  jump: false,
});

export function normalizeBrawlInput(input: BrawlInputLike): BrawlInput {
  return {
    ...input,
    jump: input.jump === true || input.uppercut,
  };
}
