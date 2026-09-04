export const SPRITE_ANIMATION_FORMATS = ['legacy', 'video-dense-v1'] as const;

export type SpriteAnimationFormat = typeof SPRITE_ANIMATION_FORMATS[number];

export const DEFAULT_SPRITE_ANIMATION_FORMAT: SpriteAnimationFormat = 'legacy';
export const VIDEO_DENSE_SPRITE_ANIMATION_FORMAT: SpriteAnimationFormat = 'video-dense-v1';

export function normalizeSpriteAnimationFormat(value: unknown): SpriteAnimationFormat {
  return value === VIDEO_DENSE_SPRITE_ANIMATION_FORMAT
    ? VIDEO_DENSE_SPRITE_ANIMATION_FORMAT
    : DEFAULT_SPRITE_ANIMATION_FORMAT;
}
