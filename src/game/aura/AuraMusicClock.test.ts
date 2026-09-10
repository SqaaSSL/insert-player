import { describe, expect, it } from 'vitest';
import { AuraMusicClock } from './AuraMusicClock.ts';
import type { MusicClockSample } from '../systems/SoundManager.ts';

const playing = (positionMs: number, durationMs: number | null = null, loop = false): MusicClockSample =>
  ({ status: 'playing', positionMs, durationMs, loop });

describe('Aura music authority', () => {
  it('waits for autoplay unlock even after more than five seconds instead of scoring silent notes', () => {
    const clock = new AuraMusicClock();
    expect(clock.update(8_000, { status: 'waiting' })).toBe(0);
    expect(clock.update(8_020, playing(0))).toBe(0);
    expect(clock.update(8_520, playing(500))).toBe(500);
  });

  it('follows real audio when the difference from wall time exceeds five seconds', () => {
    const clock = new AuraMusicClock();
    expect(clock.update(100, playing(12_000))).toBe(12_000);
    expect(clock.update(30_000, playing(12_100))).toBe(12_100);
  });

  it('freezes through decoder stalls, paused media and resume latency', () => {
    const clock = new AuraMusicClock();
    expect(clock.update(1_000, playing(1_000))).toBe(1_000);
    expect(clock.update(9_000, playing(1_000))).toBe(1_000);
    expect(clock.update(12_000, { status: 'waiting' })).toBe(1_000);
    expect(clock.update(12_100, playing(1_100))).toBe(1_100);
  });

  it('unwraps the end of a looping track exactly once without moving the chart backwards', () => {
    const clock = new AuraMusicClock();
    expect(clock.update(9_900, playing(9_900, 10_000, true))).toBe(9_900);
    expect(clock.update(10_100, playing(100, 10_000, true))).toBe(10_100);
    expect(clock.update(10_100, playing(100, 10_000, true))).toBe(10_100);
    expect(clock.update(10_300, playing(300, 10_000, true))).toBe(10_300);
  });

  it('ignores arbitrary rewinds, invalid samples and unknown-duration resets, without replaying judgements', () => {
    const clock = new AuraMusicClock();
    expect(clock.update(6_000, playing(6_000))).toBe(6_000);
    for (const sample of [playing(500), playing(NaN), playing(Infinity), playing(-1), playing(0, null, true)]) {
      expect(clock.update(7_000, sample)).toBe(6_000);
    }
    expect(clock.update(NaN, playing(9_000))).toBe(6_000);
    expect(clock.update(8_000, playing(6_100))).toBe(6_100);
  });

  it('falls back continuously only when audio is absent or terminally unavailable, and resets per match', () => {
    const clock = new AuraMusicClock();
    expect(clock.update(1_000, playing(800))).toBe(800);
    expect(clock.update(1_200, { status: 'unavailable' })).toBe(1_000);
    clock.reset();
    expect(clock.timeMs).toBe(0);
    expect(clock.update(300, { status: 'unavailable' })).toBe(300);
  });
});
