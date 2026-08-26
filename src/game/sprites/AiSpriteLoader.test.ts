import { describe, expect, it, vi } from 'vitest';
import { FighterState } from '../constants.ts';

vi.mock('phaser', () => ({ default: {} }));
vi.mock('../../services/SpriteCache.ts', () => ({ getAllSpritesForHash: vi.fn() }));

import { calculateAtlasFrameTransform, selectSourceFramesForAtlas } from './AiSpriteLoader.ts';
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

  it('keeps one common canvas transform across dense standing, crouch, and low attacks', () => {
    const contentBoxes = [
      { x: 110, y: 90, w: 540, h: 880 },
      { x: 120, y: 410, w: 530, h: 550 },
      { x: 70, y: 430, w: 650, h: 500 },
    ];
    const transforms = contentBoxes.map((contentBox) => calculateAtlasFrameTransform(
      768,
      1024,
      contentBox,
      'video-dense-v1',
    ));

    expect(new Set(transforms.map((transform) => JSON.stringify(transform))).size).toBe(1);
    expect(transforms[0]).toEqual({
      source: { x: 0, y: 0, w: 768, h: 1024 },
      destination: { x: 0, y: 0, w: 192, h: 256 },
    });
    expect(calculateAtlasFrameTransform(768, 1024, contentBoxes[1], 'legacy'))
      .not.toEqual(transforms[1]);
  });
});
