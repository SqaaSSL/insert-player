import { describe, expect, it, vi } from 'vitest';
import { FighterState } from '../constants.ts';

vi.mock('phaser', () => ({ default: {} }));

import {
  composeSpritePresentation,
  createSpriteLayout,
  DEFAULT_SPRITE_PRESENTATION_PROFILE,
  getAnimationRuntimeProfile,
  getFacingSpriteOriginX,
  getHighKickRuntimeProfile,
  getSpriteLayout,
  getSpritePresentationProfile,
  registerSpriteLayout,
} from './SpriteGenerator.ts';

describe('sprite layouts', () => {
  it('keeps the procedural high kick at four frames', () => {
    const layout = getSpriteLayout();

    expect(layout.frameCounts[FighterState.HIGH_KICK]).toBe(4);
    expect(layout.playbackModes[FighterState.HIGH_KICK]).toBeUndefined();
    expect(getSpritePresentationProfile(layout, FighterState.HIGH_KICK)).toBe(
      DEFAULT_SPRITE_PRESENTATION_PROFILE,
    );
  });

  it('stores valid per-state presentation without changing legacy defaults', () => {
    const idlePresentation = {
      scale: 1.25,
      originX: 0.42,
      originY: 1,
      offsetY: 7,
    };
    const layout = createSpriteLayout({}, {}, {}, {
      [FighterState.IDLE]: idlePresentation,
      [FighterState.HIGH_KICK]: {
        scale: 0,
        originX: 0.5,
        originY: 1,
        offsetY: 0,
      },
    });

    expect(getSpritePresentationProfile(layout, FighterState.IDLE)).toEqual(idlePresentation);
    expect(layout.presentationProfiles[FighterState.IDLE]).not.toBe(idlePresentation);
    expect(getSpritePresentationProfile(layout, FighterState.HIGH_KICK)).toBe(
      DEFAULT_SPRITE_PRESENTATION_PROFILE,
    );
    expect(getSpritePresentationProfile(layout, FighterState.WALK_FORWARD)).toBe(
      DEFAULT_SPRITE_PRESENTATION_PROFILE,
    );
  });

  it('composes action presentation with stage scale and vertical offset', () => {
    expect(composeSpritePresentation(
      { scale: 1.25, originX: 0.42, originY: 1, offsetY: 6 },
      0.8,
      500,
      -12,
    )).toEqual({
      scale: 1,
      originX: 0.42,
      originY: 1,
      offsetY: 6,
      y: 492.8,
    });

    expect(composeSpritePresentation(
      DEFAULT_SPRITE_PRESENTATION_PROFILE,
      0.8,
      500,
      -12,
    )).toEqual({
      ...DEFAULT_SPRITE_PRESENTATION_PROFILE,
      scale: 0.8,
      y: 488,
    });
  });

  it('keeps an asymmetric source root at local x zero in both facings', () => {
    const frameWidth = 192;
    const sourceOriginX = 0.37;
    const sourceRootX = sourceOriginX * frameWidth;

    for (const flipped of [false, true]) {
      const displayedRootX = flipped ? frameWidth - sourceRootX : sourceRootX;
      const effectiveOriginX = getFacingSpriteOriginX(sourceOriginX, flipped);
      const renderedRootX = displayedRootX - effectiveOriginX * frameWidth;

      expect(renderedRootX).toBeCloseTo(0, 10);
    }
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
