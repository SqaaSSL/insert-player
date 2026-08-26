import { describe, expect, it, vi } from 'vitest';
import { FighterState } from '../constants.ts';

vi.mock('phaser', () => ({ default: {} }));
vi.mock('../../services/SpriteCache.ts', () => ({ getAllSpritesForHash: vi.fn() }));

import { selectSourceFramesForAtlas } from './AiSpriteLoader.ts';
import { getHighKickRuntimeProfile } from './SpriteGenerator.ts';

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
});
