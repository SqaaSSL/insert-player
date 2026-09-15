import { describe, expect, it, vi } from 'vitest';
vi.mock('phaser', () => ({ default: {} }));
import { FighterState } from '../constants';
import { getAnimationRuntimeProfile } from './SpriteGenerator';
import { calculateAtlasFrameTransform, selectSourceFramesForAtlas } from './AiSpriteLoader';
import { calibrateTemplateAuraAtlas, type AuraAtlasGeometry } from '../aura/AuraPoseCalibration';

describe('authored template atlas runtime', () => {
  it('preserves high kick extension holds and every authored recovery frame', () => {
    const frames = [0, 1, 2, 3, 4, 5, 6, 6, 7, 8, 8, 8, 7, 6, 6, 5, 4, 3, 2, 1, 0];
    const profile = getAnimationRuntimeProfile(FighterState.HIGH_KICK, frames.length, 'template-atlas-v1');
    expect(profile).toEqual({ frameCount: 21, playbackMode: 'timeline', sourceFormat: 'timeline' });
    expect(selectSourceFramesForAtlas(FighterState.HIGH_KICK, frames, 21, profile, { animationFormat: 'template-atlas-v1' })).toEqual(frames);
    expect(() => selectSourceFramesForAtlas(FighterState.HIGH_KICK, frames, 12, profile, { animationFormat: 'template-atlas-v1' })).toThrow();
  });
  it('uses a uniform full-canvas transform regardless of occupied body bounds', () => {
    const standing = calculateAtlasFrameTransform(768, 1024, { x: 260, y: 100, w: 240, h: 850 }, 'template-atlas-v1');
    const floor = calculateAtlasFrameTransform(768, 1024, { x: 30, y: 700, w: 680, h: 220 }, 'template-atlas-v1');
    expect(standing).toEqual(floor);
    expect(standing.source).toEqual({ x: 0, y: 0, w: 768, h: 1024 });
  });
  it('shares the combat idle registration across standing, crouched and airborne Aura frames', () => {
    const idle: AuraAtlasGeometry = { name: 'idle', contentHash: 'fixture', frameWidth: 384, frameHeight: 512, frameCount: 2,
      bounds: [{ x: 110, y: 90, width: 100, height: 380 }, { x: 110, y: 92, width: 100, height: 378 }] };
    const action: AuraAtlasGeometry = { ...idle, name: 'aura_floor_worm', frameWidth: 768, frameHeight: 1024, frameCount: 3,
      bounds: [{ x: 20, y: 800, width: 710, height: 140 }, { x: 230, y: 400, width: 220, height: 500 }, { x: 210, y: 100, width: 250, height: 700 }] };
    const profile = calibrateTemplateAuraAtlas(action, idle);
    expect(profile.referenceBodyHeight).toBe(379 * 2);
    expect(profile.frames.map(frame => frame.scale)).toEqual([1, 1, 1]);
    expect(profile.frames.map(frame => frame.originY)).toEqual([1884 / 2048, 1884 / 2048, 1884 / 2048]);
    expect(profile.frames.map(frame => frame.offsetY)).toEqual([2, 2, 2]);
    expect(profile.frames.map(frame => frame.sourceFrame)).toEqual([0, 1, 2]);
  });
});
