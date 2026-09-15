export const SPRITE_ANIMATION_FORMATS = ['legacy', 'video-dense-v1', 'template-atlas-v1'] as const;

export type SpriteAnimationFormat = typeof SPRITE_ANIMATION_FORMATS[number];

export const DEFAULT_SPRITE_ANIMATION_FORMAT: SpriteAnimationFormat = 'legacy';
export const VIDEO_DENSE_SPRITE_ANIMATION_FORMAT: SpriteAnimationFormat = 'video-dense-v1';
/** Flattened authored playback, canonical canvas and root. Never infer ping-pong. */
export const TEMPLATE_ATLAS_SPRITE_ANIMATION_FORMAT: SpriteAnimationFormat = 'template-atlas-v1';
export const TEMPLATE_ATLAS_ORIGIN_Y = 1884 / 2048;

export function normalizeSpriteAnimationFormat(value: unknown): SpriteAnimationFormat {
  if (value === TEMPLATE_ATLAS_SPRITE_ANIMATION_FORMAT) return TEMPLATE_ATLAS_SPRITE_ANIMATION_FORMAT;
  return value === VIDEO_DENSE_SPRITE_ANIMATION_FORMAT
    ? VIDEO_DENSE_SPRITE_ANIMATION_FORMAT
    : DEFAULT_SPRITE_ANIMATION_FORMAT;
}
