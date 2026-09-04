import { describe, expect, it } from 'vitest';
import { fightResultShareCopy } from './FightResultShare.tsx';

describe('fightResultShareCopy', () => {
  it('describes an offline result without assuming which local player is the author', () => {
    expect(fightResultShareCopy({
      winnerSlot: 'p1', roundsP1: 2, roundsP2: 1, durationSeconds: 82,
      vsAI: false, cpuVsCpu: false,
    }, 'NOVA', 'BYTE')).toContain('NOVA beat BYTE 2-1');
  });

  it('uses the online local slot to describe a personal result', () => {
    expect(fightResultShareCopy({
      winnerSlot: 'p1', roundsP1: 2, roundsP2: 0, durationSeconds: 64,
      vsAI: false, cpuVsCpu: false,
      online: { roomCode: 'ABCD', localSlot: 1, matchSerial: 4, inputDelay: 3 },
    }, 'NOVA', 'BYTE')).toContain('I lost 0-2 as BYTE against NOVA');
  });

  it('puts the local player first in an online winning score', () => {
    expect(fightResultShareCopy({
      winnerSlot: 'p2', roundsP1: 1, roundsP2: 2, durationSeconds: 91,
      vsAI: false, cpuVsCpu: false,
      online: { roomCode: 'ABCD', localSlot: 1, matchSerial: 5, inputDelay: 3 },
    }, 'NOVA', 'BYTE')).toContain('I won 2-1 as BYTE against NOVA');
  });
});
