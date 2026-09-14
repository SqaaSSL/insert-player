import { describe, expect, it } from 'vitest';
import { MatchStartGate } from './MatchStartGate.ts';

describe('MatchStartGate', () => {
  it('waits for one explicit start for each offline match', () => {
    const gate = new MatchStartGate();
    gate.reset({});
    const firstToken = gate.token;
    expect(gate.waiting).toBe(true);
    expect(gate.accept(undefined)).toBe(false);
    expect(gate.accept(firstToken)).toBe(true);
    expect(gate.waiting).toBe(false);
    expect(gate.accept(firstToken)).toBe(false);

    gate.reset({});
    expect(gate.token).not.toBe(firstToken);
    expect(gate.accept(firstToken)).toBe(false);
    expect(gate.waiting).toBe(true);
  });

  it('never reuses an old scene instance’s start token', () => {
    const previous = new MatchStartGate();
    const current = new MatchStartGate();
    previous.reset({});
    current.reset({});
    expect(current.accept(previous.token)).toBe(false);
    expect(current.waiting).toBe(true);
  });

  it.each([
    { cpuVsCpu: true },
    { online: { roomCode: 'ABCDEF', localSlot: 0 as const, matchSerial: 1, inputDelay: 2 } },
  ])('does not gate an already agreed or spectator match', (data) => {
    const gate = new MatchStartGate();
    gate.reset({});
    const previousToken = gate.token;
    gate.reset(data);
    expect(gate.waiting).toBe(false);
    expect(gate.token).toBeUndefined();
    expect(gate.accept(previousToken)).toBe(false);
  });
});
