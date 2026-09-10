import { describe, expect, it } from 'vitest';
import { AuraCrowdDynamics, type AuraCrowdFrame } from './AuraCrowdDynamics.ts';

function advance(crowd: AuraCrowdDynamics, durationMs: number): AuraCrowdFrame[] {
  const frames: AuraCrowdFrame[] = [];
  for (let elapsed = 0; elapsed < durationMs; elapsed += 100) {
    frames.push(crowd.update(Math.min(100, durationMs - elapsed)));
  }
  return frames;
}

function reachCheer(crowd: AuraCrowdDynamics): AuraCrowdFrame {
  crowd.setMix(1);
  for (let elapsed = 0; elapsed < 12_000; elapsed += 100) {
    const frame = crowd.update(100);
    if (frame.startCheer) return frame;
  }
  throw new Error('Sustained high heat did not earn a cheer');
}

describe('AuraCrowdDynamics', () => {
  it('starts silent and never builds energy from elapsed round progress alone', () => {
    const crowd = new AuraCrowdDynamics();
    crowd.setMix(0, 1);
    for (const frame of advance(crowd, 60_000)) {
      expect(frame.heat).toBe(0);
      expect(Object.values(frame.gains)).toEqual([0, 0, 0, 0]);
      expect(frame.startCheer || frame.startBoo || frame.cheerActive || frame.booActive).toBe(false);
    }
  });

  it('takes five seconds to approach heat and falls on a faster 1.7-second envelope', () => {
    const crowd = new AuraCrowdDynamics();
    crowd.setMix(1);
    const rise = advance(crowd, 5_000);
    expect(rise.at(-1)!.heat).toBeCloseTo(1 - Math.exp(-1), 10);
    expect(rise.every(frame => !frame.startCheer)).toBe(true);
    expect(rise[0].gains['room-a'] + rise[0].gains['room-b']).toBe(0);
    for (const frame of rise) {
      expect(frame.gains['room-a'] + frame.gains['room-b']).toBeLessThanOrEqual(0.034);
    }
    const peakHeat = rise.at(-1)!.heat;
    crowd.setMix(0);
    const fall = advance(crowd, 1_700);
    expect(fall.at(-1)!.heat).toBeCloseTo(peakHeat * Math.exp(-1), 10);
  });

  it('requires a sustained high threshold and fades a cheer out within 2.2 seconds', () => {
    const crowd = new AuraCrowdDynamics();
    crowd.setMix(1);
    expect(advance(crowd, 9_000).some(frame => frame.startCheer)).toBe(false);
    const start = crowd.update(100);
    expect(start.startCheer).toBe(true);
    expect(start.cheerActive).toBe(true);
    expect(start.gains.hype).toBe(0);
    const reaction = advance(crowd, 2_200);
    expect(reaction[0].gains.hype).toBeGreaterThan(0);
    expect(Math.max(...reaction.map(frame => frame.gains.hype))).toBeCloseTo(0.055, 10);
    expect(reaction.at(-2)!.gains.hype).toBeGreaterThan(0);
    expect(reaction.at(-1)!.gains.hype).toBe(0);
    expect(reaction.at(-1)!.cheerActive).toBe(false);
    expect(reaction.every(frame => !frame.startCheer)).toBe(true);
  });

  it('does not retrigger from sustained high heat or a brief dip after the cooldown', () => {
    const crowd = new AuraCrowdDynamics();
    reachCheer(crowd);
    expect(advance(crowd, 30_000).some(frame => frame.startCheer)).toBe(false);
    crowd.setMix(0);
    advance(crowd, 1_200);
    crowd.setMix(1);
    expect(advance(crowd, 40_000).some(frame => frame.startCheer)).toBe(false);
  });

  it('requires a low-heat rearm and the full 18-second cooldown before another cheer', () => {
    const crowd = new AuraCrowdDynamics();
    reachCheer(crowd);
    crowd.setMix(0);
    expect(advance(crowd, 4_000).some(frame => frame.startCheer)).toBe(false);
    crowd.setMix(1);
    expect(advance(crowd, 13_900).some(frame => frame.startCheer)).toBe(false);
    expect(crowd.update(100).startCheer).toBe(true);
    expect(advance(crowd, 30_000).some(frame => frame.startCheer)).toBe(false);
  });

  it('uses a short quiet boo envelope and ignores repeated negative punches during cooldown', () => {
    const crowd = new AuraCrowdDynamics();
    crowd.setMix(0, 0, 0.44);
    expect(crowd.update(100).startBoo).toBe(false);
    crowd.setMix(0, 0, 0.9);
    const start = crowd.update(100);
    expect(start.startBoo).toBe(true);
    expect(start.gains.negative).toBe(0);
    const frames: AuraCrowdFrame[] = [];
    for (let elapsed = 100; elapsed <= 9_900; elapsed += 100) {
      crowd.setMix(0, 0, 0.9);
      frames.push(crowd.update(100));
    }
    expect(Math.max(...frames.map(frame => frame.gains.negative))).toBeCloseTo(0.025, 10);
    expect(frames[5].gains.negative).toBeGreaterThan(frames[8].gains.negative);
    expect(frames[9].booActive).toBe(false);
    expect(frames[9].gains.negative).toBe(0);
    expect(frames.every(frame => !frame.startBoo)).toBe(true);
    crowd.setMix(0, 0, 0.9);
    expect(crowd.update(100).startBoo).toBe(true);
  });

  it('releases an active cheer after a negative reaction instead of cutting it off', () => {
    const crowd = new AuraCrowdDynamics();
    reachCheer(crowd);
    advance(crowd, 400);
    crowd.setMix(0, 0, 1);
    const boo = crowd.update(100);
    expect(boo.startBoo).toBe(true);
    expect(boo.cheerActive).toBe(true);
    expect(boo.gains.hype).toBeGreaterThan(0);
    const release = advance(crowd, 600);
    expect(release[0].gains.hype).toBeLessThan(boo.gains.hype);
    expect(release.at(-1)!.gains.hype).toBe(0);
  });

  it('never jumps an early cheer attack louder when a boo interrupts it', () => {
    const crowd = new AuraCrowdDynamics();
    reachCheer(crowd);
    const attacking = crowd.update(50);
    expect(attacking.gains.hype).toBeGreaterThan(0);
    crowd.setMix(0, 0, 1);
    const interrupted = crowd.update(16);
    expect(interrupted.startBoo).toBe(true);
    expect(interrupted.gains.hype).toBeGreaterThan(0);
    expect(interrupted.gains.hype).toBeLessThanOrEqual(attacking.gains.hype + 1e-12);
    const release = advance(crowd, 600);
    expect(release.every(frame => frame.gains.hype <= interrupted.gains.hype)).toBe(true);
    expect(release.at(-1)!.gains.hype).toBe(0);
  });

  it('never jumps an early boo attack louder when victory interrupts it', () => {
    const crowd = new AuraCrowdDynamics();
    crowd.setMix(0, 0, 1);
    expect(crowd.update(100).startBoo).toBe(true);
    const attacking = crowd.update(50);
    expect(attacking.gains.negative).toBeGreaterThan(0);
    crowd.peak();
    const interrupted = crowd.update(16);
    expect(interrupted.startCheer).toBe(true);
    expect(interrupted.gains.negative).toBeGreaterThan(0);
    expect(interrupted.gains.negative).toBeLessThanOrEqual(attacking.gains.negative + 1e-12);
    const release = advance(crowd, 400);
    expect(release.every(frame => frame.gains.negative <= interrupted.gains.negative)).toBe(true);
    expect(release.at(-1)!.gains.negative).toBe(0);
  });

  it('allows one bounded victory but never restarts or extends an already active cheer', () => {
    const crowd = new AuraCrowdDynamics();
    reachCheer(crowd);
    advance(crowd, 500);
    crowd.peak();
    expect(crowd.update(100).startCheer).toBe(false);
    const remainder = advance(crowd, 1_600);
    expect(remainder.at(-2)!.cheerActive).toBe(true);
    expect(remainder.at(-1)!.cheerActive).toBe(false);
    expect(remainder.at(-1)!.gains.hype).toBe(0);
    expect(advance(crowd, 30_000).some(frame => frame.startCheer)).toBe(false);
    crowd.peak();
    crowd.setMix(1, 1, 1);
    expect(advance(crowd, 30_000).some(frame => frame.startCheer || frame.startBoo)).toBe(false);
  });

  it('resets heat, pending reactions, cooldowns and the once-only victory state', () => {
    const crowd = new AuraCrowdDynamics();
    crowd.peak();
    expect(crowd.update(100).startCheer).toBe(true);
    advance(crowd, 500);
    crowd.reset();
    expect(crowd.update(100)).toEqual({
      heat: 0,
      gains: { 'room-a': 0, 'room-b': 0, hype: 0, negative: 0 },
      startCheer: false,
      startBoo: false,
      cheerActive: false,
      booActive: false,
    });
    crowd.peak();
    expect(crowd.update(100).startCheer).toBe(true);
    crowd.reset();
    crowd.setMix(0, 0, 1);
    crowd.reset();
    expect(crowd.update(100).startBoo).toBe(false);
    expect(reachCheer(crowd).startCheer).toBe(true);
  });

  it('sanitizes non-finite mix values and ignores invalid deltas without advancing the envelope', () => {
    const crowd = new AuraCrowdDynamics();
    crowd.setMix(1);
    advance(crowd, 1_000);
    const baseline = crowd.update(0);
    for (const delta of [NaN, Infinity, -Infinity, -100]) {
      expect(crowd.update(delta)).toEqual(baseline);
    }
    for (const value of [NaN, Infinity, -Infinity, -1, 2]) {
      crowd.setMix(value, value, value);
      const frame = crowd.update(100);
      expect(Number.isFinite(frame.heat)).toBe(true);
      expect(frame.heat).toBeGreaterThanOrEqual(0);
      expect(frame.heat).toBeLessThanOrEqual(1);
      for (const gain of Object.values(frame.gains)) {
        expect(Number.isFinite(gain)).toBe(true);
        expect(gain).toBeGreaterThanOrEqual(0);
        expect(gain).toBeLessThanOrEqual(0.07);
      }
    }
  });

  it('caps catch-up deltas at one frame rather than skipping through the reaction lifetime', () => {
    const normal = new AuraCrowdDynamics();
    const stalled = new AuraCrowdDynamics();
    normal.peak(); stalled.peak();
    expect(stalled.update(30_000)).toEqual(normal.update(100));
    expect(stalled.update(30_000)).toEqual(normal.update(100));
  });
});
