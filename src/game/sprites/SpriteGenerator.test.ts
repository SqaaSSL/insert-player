import { describe, expect, it, vi } from 'vitest';
import { FighterState } from '../constants.ts';

vi.mock('phaser', () => ({ default: {} }));

import {
  createSpriteLayout,
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
