import { describe, expect, it } from 'vitest';
import { MatchSimulation } from './MatchSimulation.ts';
import { EMPTY_INPUT } from './FighterInput.ts';

const base = { seed: 7, vsAI: false, cpuVsCpu: false, p1Name: 'P1', p2Name: 'P2' };
function runApart(config: typeof base & { maxSeparation?: number }) {
  const sim = new MatchSimulation(config);
  const left = { ...EMPTY_INPUT, left: true }, right = { ...EMPTY_INPUT, right: true };
  for (let tick = 0; tick < 900; tick += 1) sim.step(left, right);
  const snapshot = sim.snapshot();
  return Math.abs(snapshot.p1.x - snapshot.p2.x);
}

describe('MatchSimulation max separation', () => {
  it('keeps walking-apart fighters within the camera width', () => {
    expect(runApart({ ...base, maxSeparation: 420 })).toBeLessThanOrEqual(420);
  });
  it('leaves the whole stage open when omitted', () => {
    expect(runApart(base)).toBeGreaterThan(700);
  });
});
