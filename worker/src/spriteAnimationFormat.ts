export const SPRITE_ANIMATION_FORMATS = ['legacy', 'video-dense-v1'] as const;

export type SpriteAnimationFormat = typeof SPRITE_ANIMATION_FORMATS[number];

export const DEFAULT_SPRITE_ANIMATION_FORMAT: SpriteAnimationFormat = 'legacy';

export function isSpriteAnimationFormat(value: unknown): value is SpriteAnimationFormat {
  return typeof value === 'string' && SPRITE_ANIMATION_FORMATS.includes(value as SpriteAnimationFormat);
}

export function normalizeSpriteAnimationFormat(value: unknown): SpriteAnimationFormat {
  return isSpriteAnimationFormat(value) ? value : DEFAULT_SPRITE_ANIMATION_FORMAT;
}
