import { describe, expect, it } from 'vitest';
import { ATTACKS, FighterState } from '../constants.ts';
import { getActionAnimationFrame } from './AnimationFrameMapping.ts';

const HIGH_KICK = ATTACKS[FighterState.HIGH_KICK];
const HIGH_KICK_DURATION = HIGH_KICK.startup + HIGH_KICK.active + HIGH_KICK.recovery;

function highKickFrames(frameCount: number, playbackMode: 'timeline' | 'forward-ping-pong'): number[] {
  return Array.from({ length: HIGH_KICK_DURATION }, (_, stateFrame) =>
    getActionAnimationFrame({
      stateFrame,
      frameCount,
      totalDuration: HIGH_KICK_DURATION,
      playbackMode,
      attack: HIGH_KICK,
    }),
  );
}

describe('action animation frame mapping', () => {
  it('keeps the complete legacy seven-frame high-kick timeline', () => {
    const frames = highKickFrames(7, 'timeline');

    expect(new Set(frames)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]));
    expect(frames[0]).toBe(0);
    expect(frames.at(-1)).toBe(6);
  });

  it('shows every dense frame and reaches peak on the last active tick', () => {
    const frames = highKickFrames(12, 'forward-ping-pong');
    const lastActiveTick = HIGH_KICK.startup + HIGH_KICK.active - 1;

    expect(new Set(frames)).toEqual(new Set(Array.from({ length: 12 }, (_, index) => index)));
    expect(frames[lastActiveTick]).toBe(11);
    expect(frames[lastActiveTick + 1]).toBe(10);
    expect(frames.at(-1)).toBe(0);
  });

  it('clamps visual mapping without extending the attack', () => {
    expect(getActionAnimationFrame({
      stateFrame: HIGH_KICK_DURATION + 20,
      frameCount: 12,
      totalDuration: HIGH_KICK_DURATION,
      playbackMode: 'forward-ping-pong',
      attack: HIGH_KICK,
    })).toBe(0);
  });
});
