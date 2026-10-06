import { describe, expect, it } from 'vitest';
import {
  VIDEO_SPRITE_ACTIONS,
  VIDEO_SPRITE_ACTION_PROFILES,
  VIDEO_SPRITE_COMPILABLE_ACTIONS,
  VIDEO_SPRITE_EXTRA_ACTIONS,
  isVideoSpriteExtraAction,
} from './VideoSpriteCompileContract';

describe('video sprite action contract', () => {
  it('keeps the full review-gated run at exactly the 11 ordered Champion actions', () => {
    expect(VIDEO_SPRITE_ACTIONS).toEqual([
      'idle', 'walk', 'high_punch', 'high_kick', 'low_punch', 'low_kick',
      'jump', 'crouch', 'hit', 'ko', 'victory',
    ]);
  });

  it('adds fireball and uppercut only as compilable extras after the full run', () => {
    expect(VIDEO_SPRITE_EXTRA_ACTIONS).toEqual(['fireball', 'uppercut']);
    expect(VIDEO_SPRITE_COMPILABLE_ACTIONS).toEqual([...VIDEO_SPRITE_ACTIONS, 'fireball', 'uppercut']);
    expect(isVideoSpriteExtraAction('fireball')).toBe(true);
    expect(isVideoSpriteExtraAction('high_punch')).toBe(false);
    expect(isVideoSpriteExtraAction(null)).toBe(false);
  });

  it('gives every compilable action a profile, the extras as held one-shot moves', () => {
    for (const action of VIDEO_SPRITE_COMPILABLE_ACTIONS) {
      expect(VIDEO_SPRITE_ACTION_PROFILES[action].action).toBe(action);
    }
    expect(VIDEO_SPRITE_ACTION_PROFILES.fireball).toMatchObject({
      sequenceFormat: 'timeline-hold', registration: 'root', allowStatic: false,
    });
    expect(VIDEO_SPRITE_ACTION_PROFILES.uppercut).toMatchObject({
      sequenceFormat: 'timeline-hold', registration: 'vertical-root', allowStatic: false,
    });
  });
});
