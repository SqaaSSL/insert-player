import { describe, expect, it, vi } from 'vitest';
import { FighterState } from '../constants.ts';

vi.mock('phaser', () => ({ default: {} }));
vi.mock('../../services/SpriteCache.ts', () => ({ getAllSpritesForHash: vi.fn() }));

import {
  calculateAtlasFrameTransform,
  calculateDensePresentationProfile,
  mapPresentationProfilesByResolvedAnimation,
  measureAlphaBBox,
  measureDenseFramePresentation,
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
    expect(calculateAtlasFrameTransform(
      768,
      1024,
      null,
      'video-dense-v1',
      384,
      512,
    )).toEqual({
      source: { x: 0, y: 0, w: 768, h: 1024 },
      destination: { x: 0, y: 0, w: 384, h: 512 },
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

  it('measures the compiler-compatible opaque foot root from the bottom silhouette band', () => {
    const pixels = new Uint8ClampedArray(10 * 10 * 4);
    pixels[(2 * 10 + 4) * 4 + 3] = 255;
    pixels[(3 * 10 + 4) * 4 + 3] = 255;
    pixels[(8 * 10 + 3) * 4 + 3] = 128;
    pixels[(8 * 10 + 7) * 4 + 3] = 255;

    const measurement = measureDenseFramePresentation(pixels, 10, 10);

    expect(measurement?.bounds).toEqual({ x: 3, y: 2, w: 5, h: 7 });
    expect(measurement?.root.x).toBeCloseTo((3 * 128 + 7 * 255) / (128 + 255));
    expect(measurement?.root.y).toBe(8);
  });

  it('anchors differently framed actions to the same gameplay root without atlas recentering', () => {
    const standingRoot = { x: 80, y: 239 };
    const wideRoot = { x: 123, y: 228 };
    const standing = calculateDensePresentationProfile(192, 256, [{
      bounds: { x: 55, y: 35, w: 82, h: 205 },
      root: standingRoot,
    }]);
    const wide = calculateDensePresentationProfile(192, 256, [{
      bounds: { x: 18, y: 52, w: 158, h: 177 },
      root: wideRoot,
    }]);

    for (const [profile, root] of [[standing, standingRoot], [wide, wideRoot]] as const) {
      const projectedRootX = (root.x - profile.originX * 192) * profile.scale;
      const projectedRootY = profile.offsetY + (root.y - profile.originY * 256) * profile.scale;
      expect(projectedRootX).toBeCloseTo(0);
      expect(projectedRootY).toBeCloseTo(-6);
    }
    expect(standing.originX).not.toBe(wide.originX);
  });

  it('uses the width-limited union scale once for a wide action', () => {
    const profile = calculateDensePresentationProfile(192, 256, [{
      bounds: { x: 20, y: 70, w: 152, h: 100 },
      root: { x: 96, y: 169 },
    }]);

    // Four-percent canvas margins turn the union into 168x120. Width is the
    // limiting axis: min(192/168, 256/120) = 8/7.
    expect(profile.scale).toBeCloseTo(8 / 7);
  });

  it('normalizes upright actions from their opening pose instead of later vertical motion', () => {
    const profile = calculateDensePresentationProfile(192, 256, [
      {
        bounds: { x: 55, y: 50, w: 82, h: 180 },
        root: { x: 96, y: 229 },
      },
      {
        bounds: { x: 50, y: 5, w: 92, h: 230 },
        root: { x: 96, y: 234 },
      },
    ], FighterState.VICTORY);

    expect(profile.scale).toBeCloseTo((256 * 0.90) / 180);
  });

  it('uses median standing height for looping actions', () => {
    const profile = calculateDensePresentationProfile(192, 256, [
      {
        bounds: { x: 55, y: 50, w: 82, h: 180 },
        root: { x: 96, y: 229 },
      },
      {
        bounds: { x: 55, y: 40, w: 82, h: 200 },
        root: { x: 96, y: 239 },
      },
      {
        bounds: { x: 55, y: 30, w: 82, h: 220 },
        root: { x: 96, y: 249 },
      },
    ], FighterState.IDLE);

    expect(profile.scale).toBeCloseTo((256 * 0.90) / 200);
  });

  it('keeps low attacks at a crouched target height', () => {
    const profile = calculateDensePresentationProfile(192, 256, [{
      bounds: { x: 55, y: 80, w: 82, h: 150 },
      root: { x: 96, y: 229 },
    }], FighterState.LOW_PUNCH);

    expect(profile.scale).toBeCloseTo((256 * 0.75) / 150);
  });

  it('caps extreme enlargement from an unexpectedly tiny silhouette', () => {
    const profile = calculateDensePresentationProfile(192, 256, [{
      bounds: { x: 86, y: 108, w: 20, h: 20 },
      root: { x: 96, y: 127 },
    }]);

    expect(profile.scale).toBe(1.5);
  });

  it('falls back to the unchanged presentation when no runtime frame is measurable', () => {
    expect(calculateDensePresentationProfile(192, 256, [null, null])).toEqual({
      scale: 1,
      originX: 0.5,
      originY: 1,
      offsetY: 0,
    });
  });

  it('reuses one source-action profile for direct and fallback states', () => {
    const punchProfile = { scale: 1.25, originX: 0.42, originY: 1, offsetY: 9 };
    const crouchProfile = { scale: 1.31, originX: 0.46, originY: 1, offsetY: 12 };
    const koProfile = { scale: 1.08, originX: 0.39, originY: 1, offsetY: 7 };
    const resolved = new Map<FighterState, string>([
      [FighterState.HIGH_PUNCH, 'high_punch'],
      [FighterState.FIREBALL, 'high_punch'],
      [FighterState.UPPERCUT, 'high_punch'],
      [FighterState.CROUCH, 'crouch'],
      [FighterState.BLOCK, 'crouch'],
      [FighterState.KNOCKDOWN, 'ko'],
      [FighterState.DEFEAT, 'ko'],
      [FighterState.IDLE, 'idle'],
    ]);
    const profiles = mapPresentationProfilesByResolvedAnimation(
      Object.values(FighterState),
      resolved,
      new Map([
        ['high_punch', punchProfile],
        ['crouch', crouchProfile],
        ['ko', koProfile],
      ]),
    );

    expect(profiles[FighterState.HIGH_PUNCH]).toBe(punchProfile);
    expect(profiles[FighterState.FIREBALL]).toBe(punchProfile);
    expect(profiles[FighterState.UPPERCUT]).toBe(punchProfile);
    expect(profiles[FighterState.CROUCH]).toBe(crouchProfile);
    expect(profiles[FighterState.BLOCK]).toBe(crouchProfile);
    expect(profiles[FighterState.KNOCKDOWN]).toBe(koProfile);
    expect(profiles[FighterState.DEFEAT]).toBe(koProfile);
    expect(profiles[FighterState.IDLE]).toBeUndefined();
  });
});
