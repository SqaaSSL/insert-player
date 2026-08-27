import { describe, expect, it, vi } from 'vitest';
import { FighterState } from '../constants.ts';

vi.mock('phaser', () => ({ default: {} }));
vi.mock('../../services/SpriteCache.ts', () => ({ getAllSpritesForHash: vi.fn() }));

import {
  calculateAtlasFrameTransform,
  measureAlphaBBox,
  selectSourceFramesForAtlas,
} from './AiSpriteLoader.ts';
import { getAnimationRuntimeProfile, getHighKickRuntimeProfile } from './SpriteGenerator.ts';

describe('AI sprite loader high-kick frame selection', () => {
  it('preserves every forward pose and the peak from an expanded 23-frame ping-pong', () => {
    const forwardPoses = Array.from({ length: 12 }, (_, index) => `pose-${index}`);
    const expandedPingPong = [
      ...forwardPoses,
      ...forwardPoses.slice(0, -1).reverse(),
    ];
    const profile = getHighKickRuntimeProfile(expandedPingPong.length);

    const atlasFrames = selectSourceFramesForAtlas(
      FighterState.HIGH_KICK,
      expandedPingPong,
      profile.frameCount,
      profile,
    );

    expect(atlasFrames).toEqual(forwardPoses);
    expect(new Set(atlasFrames)).toEqual(new Set(forwardPoses));
    expect(atlasFrames.at(-1)).toBe('pose-11');
  });

  it('keeps legacy seven-frame timelines unchanged', () => {
    const legacyFrames = Array.from({ length: 7 }, (_, index) => `legacy-${index}`);
    const profile = getHighKickRuntimeProfile(legacyFrames.length);

    expect(selectSourceFramesForAtlas(
      FighterState.HIGH_KICK,
      legacyFrames,
      profile.frameCount,
      profile,
    )).toEqual(legacyFrames);
  });

  it('preserves all forward poses for every expanded dense attack', () => {
    const cases = [
      [FighterState.HIGH_PUNCH, 6],
      [FighterState.LOW_PUNCH, 7],
      [FighterState.LOW_KICK, 9],
    ] as const;
    for (const [state, forwardFrameCount] of cases) {
      const forwardPoses = Array.from(
        { length: forwardFrameCount },
        (_, index) => `pose-${index}`,
      );
      const expandedPingPong = [
        ...forwardPoses,
        ...forwardPoses.slice(0, -1).reverse(),
      ];
      const profile = getAnimationRuntimeProfile(state, expandedPingPong.length, 'video-dense-v1');
      expect(selectSourceFramesForAtlas(
        state,
        expandedPingPong,
        profile.frameCount,
        profile,
      )).toEqual(forwardPoses);
    }
  });

  it('samples a twelve-frame dense crouch source down to six runtime poses', () => {
    const sourceFrames = Array.from({ length: 12 }, (_, index) => index);
    const profile = getAnimationRuntimeProfile(FighterState.CROUCH, sourceFrames.length, 'video-dense-v1');

    expect(selectSourceFramesForAtlas(
      FighterState.CROUCH,
      sourceFrames,
      profile.frameCount,
      profile,
    )).toEqual([0, 2, 4, 7, 9, 11]);
  });

  it('holds the final fallen pose when defeat falls back to a dense KO timeline', () => {
    const koFrames = Array.from({ length: 12 }, (_, index) => `ko-${index}`);
    const defeatProfile = getAnimationRuntimeProfile(FighterState.DEFEAT);

    expect(selectSourceFramesForAtlas(
      FighterState.DEFEAT,
      koFrames,
      defeatProfile.frameCount,
      defeatProfile,
      {
        sourceState: FighterState.KNOCKDOWN,
        animationFormat: 'video-dense-v1',
      },
    )).toEqual(['ko-11', 'ko-11']);
  });

  it('normalizes one animation union to the fighter cell and keeps it ground anchored', () => {
    expect(calculateAtlasFrameTransform(
      192,
      256,
      { x: 55, y: 35, w: 82, h: 205 },
    )).toEqual({
      source: { x: 55, y: 35, w: 82, h: 205 },
      destination: { x: 45, y: 0, w: 102, h: 256 },
    });
  });

  it('fits wide action unions without clipping and still anchors them to the floor', () => {
    const transform = calculateAtlasFrameTransform(
      192,
      256,
      { x: 18, y: 52, w: 158, h: 189 },
    );

    expect(transform.destination).toEqual({ x: 0, y: 26, w: 192, h: 230 });
    expect(transform.destination.x).toBeGreaterThanOrEqual(0);
    expect(transform.destination.y).toBeGreaterThanOrEqual(0);
    expect(transform.destination.x + transform.destination.w).toBeLessThanOrEqual(192);
    expect(transform.destination.y + transform.destination.h).toBe(256);
  });

  it('falls back to the full canvas when an animation has no measurable content', () => {
    expect(calculateAtlasFrameTransform(192, 256, null)).toEqual({
      source: { x: 0, y: 0, w: 192, h: 256 },
      destination: { x: 0, y: 0, w: 192, h: 256 },
    });
  });

  it('measures black fighter pixels by alpha and ignores translucent specks', () => {
    const pixels = new Uint8ClampedArray(4 * 4 * 4);
    pixels[(1 * 4 + 1) * 4 + 3] = 255;
    pixels[(2 * 4 + 2) * 4] = 240;
    pixels[(2 * 4 + 2) * 4 + 1] = 240;
    pixels[(2 * 4 + 2) * 4 + 2] = 240;
    pixels[(2 * 4 + 2) * 4 + 3] = 32;
    pixels[(3 * 4 + 3) * 4 + 3] = 31;

    expect(measureAlphaBBox(pixels, 4, 4)).toEqual({ x: 1, y: 1, w: 2, h: 2 });
    expect(measureAlphaBBox(new Uint8ClampedArray(4 * 4 * 4), 4, 4)).toBeNull();
  });
});
