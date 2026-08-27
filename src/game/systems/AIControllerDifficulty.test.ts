import { describe, expect, it } from 'vitest';
import { AIController } from './AIController.ts';
import { SeededRng } from '../utils/SeededRng.ts';
import { getFighterPersonality } from '../match/MatchConfig.ts';
import type { Fighter } from '../fighters/Fighter.ts';
import { MAX_HEALTH } from '../constants.ts';

function stubFighter(x: number): Fighter {
  return {
    x,
    health: MAX_HEALTH,
    stateFrame: 0,
    facingRight: x < 512,
    isInAttack: () => false,
    getAttackData: () => null,
    isGrounded: () => true,
    getBodyWidth: () => 60,
    getAttackRange: () => 90,
    getMaxMeleeRange: () => 100,
    forceState: () => {},
  } as unknown as Fighter;
}

function collectInputs(difficulty: number | undefined, frames: number, seed = 1234): string[] {
  const controller = difficulty === undefined
    ? new AIController(new SeededRng(seed), getFighterPersonality('brawler'))
    : new AIController(new SeededRng(seed), getFighterPersonality('brawler'), difficulty);
  const self = stubFighter(400);
  const opponent = stubFighter(460);
  const inputs: string[] = [];
  for (let i = 0; i < frames; i++) {
    inputs.push(JSON.stringify(controller.getInput(self, opponent)));
  }
  return inputs;
}

function attackFrames(inputs: string[]): number {
  return inputs.filter((raw) => {
    const input = JSON.parse(raw) as Record<string, boolean>;
    return input.punch || input.kick;
  }).length;
}

describe('AIController difficulty', () => {
  it('is deterministic for a given seed and difficulty', () => {
    expect(collectInputs(0.4, 600)).toEqual(collectInputs(0.4, 600));
  });

  it('at difficulty 1 behaves byte-identically to the legacy constructor', () => {
    expect(collectInputs(1, 600)).toEqual(collectInputs(undefined, 600));
  });

  it('attacks less at low difficulty than at full strength', () => {
    const low = attackFrames(collectInputs(0.25, 2400));
    const high = attackFrames(collectInputs(1, 2400));
    expect(high).toBeGreaterThan(0);
    expect(low).toBeLessThan(high);
  });

  it('clamps out-of-range difficulty values', () => {
    expect(collectInputs(5, 300)).toEqual(collectInputs(1, 300));
    expect(attackFrames(collectInputs(-2, 2400))).toBe(attackFrames(collectInputs(0, 2400)));
  });
});
