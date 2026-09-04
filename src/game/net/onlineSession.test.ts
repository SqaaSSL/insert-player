import { describe, expect, it } from 'vitest';
import { isOnlineControlMessage } from './onlineSession.ts';

describe('online rematch control messages', () => {
  it('accepts a mutual-ready handshake and host-issued fresh match', () => {
    expect(isOnlineControlMessage({ t: 'rematch_ready', previousMatchSerial: 7 })).toBe(true);
    expect(isOnlineControlMessage({
      t: 'rematch_start', previousMatchSerial: 7, matchSerial: 8, seed: 0xffff_ffff,
    })).toBe(true);
  });

  it('rejects malformed or reused identifiers before they reach the scene', () => {
    expect(isOnlineControlMessage({ t: 'rematch_ready', previousMatchSerial: 0 })).toBe(false);
    expect(isOnlineControlMessage({
      t: 'rematch_start', previousMatchSerial: 7, matchSerial: 0, seed: -1,
    })).toBe(false);
    expect(isOnlineControlMessage({
      t: 'rematch_start', previousMatchSerial: 7, matchSerial: 7, seed: 42,
    })).toBe(false);
  });
});
