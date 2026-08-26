import { describe, expect, it, vi } from 'vitest';
import { FighterState } from '../constants.ts';

vi.mock('phaser', () => ({ default: {} }));

import {
  createSpriteLayout,
  getAnimationRuntimeProfile,
  getHighKickRuntimeProfile,
  getSpriteLayout,
  registerSpriteLayout,
} from './SpriteGenerator.ts';

describe('sprite layouts', () => {
  it('keeps the procedural high kick at four frames', () => {
    const layout = getSpriteLayout();

    expect(layout.frameCounts[FighterState.HIGH_KICK]).toBe(4);
    expect(layout.playbackModes[FighterState.HIGH_KICK]).toBeUndefined();
  });

  it('preserves legacy seven-frame assets as complete timelines', () => {
    expect(getHighKickRuntimeProfile(7)).toEqual({
      frameCount: 7,
      playbackMode: 'timeline',
      sourceFormat: 'timeline',
    });
  });

  it('preserves legacy frame targets for every non-video source', () => {
    expect(getAnimationRuntimeProfile(FighterState.IDLE, 8)).toMatchObject({
      frameCount: 4,
      playbackMode: 'timeline',
    });
    expect(getAnimationRuntimeProfile(FighterState.WALK_FORWARD, 16)).toMatchObject({
      frameCount: 6,
      playbackMode: 'timeline',
    });
    expect(getAnimationRuntimeProfile(FighterState.HIGH_PUNCH, 7)).toMatchObject({
      frameCount: 3,
      playbackMode: 'timeline',
    });
    expect(getAnimationRuntimeProfile(FighterState.KNOCKDOWN, 8)).toMatchObject({
      frameCount: 4,
      playbackMode: 'timeline',
    });
  });

  it('uses dense video timelines for loops, reactions, and terminal poses', () => {
    expect(getAnimationRuntimeProfile(FighterState.IDLE, 8, 'video-dense-v1')).toEqual({
      frameCount: 8,
      playbackMode: 'timeline',
      sourceFormat: 'timeline',
      durationTicks: 120,
    });
    expect(getAnimationRuntimeProfile(FighterState.WALK_FORWARD, 12, 'video-dense-v1')).toMatchObject({
      frameCount: 12,
      playbackMode: 'timeline',
      durationTicks: 90,
    });
    expect(getAnimationRuntimeProfile(FighterState.CROUCH, 6, 'video-dense-v1')).toMatchObject({
      frameCount: 6,
      playbackMode: 'timeline',
      durationTicks: 8,
    });
    expect(getAnimationRuntimeProfile(FighterState.KNOCKDOWN, 12, 'video-dense-v1')).toMatchObject({
      frameCount: 12,
      playbackMode: 'timeline',
      durationTicks: 30,
    });
  });

  it('derives attack recovery from every dense forward-only video source', () => {
    const cases = [
      [FighterState.HIGH_PUNCH, 6],
      [FighterState.LOW_PUNCH, 7],
      [FighterState.HIGH_KICK, 12],
      [FighterState.LOW_KICK, 9],
    ] as const;
    for (const [state, forwardFrames] of cases) {
      expect(getAnimationRuntimeProfile(state, forwardFrames, 'video-dense-v1')).toMatchObject({
        frameCount: forwardFrames,
        playbackMode: 'forward-ping-pong',
        sourceFormat: 'forward-keyframes',
      });
      expect(getAnimationRuntimeProfile(state, forwardFrames * 2 - 1, 'video-dense-v1')).toMatchObject({
        frameCount: forwardFrames,
        playbackMode: 'forward-ping-pong',
        sourceFormat: 'expanded-ping-pong',
      });
    }
  });

  it('requires the explicit video format outside the backwards-compatible high kick', () => {
    expect(getAnimationRuntimeProfile(FighterState.IDLE, 8, 'legacy').frameCount).toBe(4);
    expect(getAnimationRuntimeProfile(FighterState.WALK_FORWARD, 12, 'legacy').frameCount).toBe(6);
    expect(getAnimationRuntimeProfile(FighterState.HIGH_PUNCH, 6, 'legacy').frameCount).toBe(3);
    expect(getAnimationRuntimeProfile(FighterState.HIGH_KICK, 12, 'legacy').frameCount).toBe(12);
  });

  it('uses twelve forward frames for dense assets without duplicating atlas cells', () => {
    const profile = getHighKickRuntimeProfile(12);
    const layout = createSpriteLayout(
      { [FighterState.HIGH_KICK]: profile.frameCount },
      { [FighterState.HIGH_KICK]: profile.playbackMode },
    );

    expect(profile).toEqual({
      frameCount: 12,
      playbackMode: 'forward-ping-pong',
      sourceFormat: 'forward-keyframes',
    });
    expect(layout.frameCounts[FighterState.HIGH_KICK]).toBe(12);
    expect(layout.totalColumns).toBe(12);
  });

  it.each([13, 15, 17, 19, 21, 23])(
    'collapses an expanded %i-frame playback sheet back to its forward keyframes',
    (expandedFrameCount) => {
      expect(getHighKickRuntimeProfile(expandedFrameCount)).toEqual({
        frameCount: (expandedFrameCount + 1) / 2,
        playbackMode: 'forward-ping-pong',
        sourceFormat: 'expanded-ping-pong',
      });
    },
  );

  it('registers independent layouts for each fighter texture', () => {
    const legacy = createSpriteLayout({ [FighterState.HIGH_KICK]: 7 });
    const dense = createSpriteLayout(
      { [FighterState.HIGH_KICK]: 12 },
      { [FighterState.HIGH_KICK]: 'forward-ping-pong' },
    );

    registerSpriteLayout('test-legacy-fighter', legacy);
    registerSpriteLayout('test-dense-fighter', dense);

    expect(getSpriteLayout('test-legacy-fighter').frameCounts[FighterState.HIGH_KICK]).toBe(7);
    expect(getSpriteLayout('test-dense-fighter').frameCounts[FighterState.HIGH_KICK]).toBe(12);
  });
});
