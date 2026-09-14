import { describe, expect, it } from 'vitest';
import type { CachedMeta } from '../../services/SpriteCache.ts';
import {
  defaultSourceForMeta,
  isArcadeCachedMeta,
  tierLabel,
} from './fighterPreview.ts';

function metaWithHash(photoHash: string): Pick<CachedMeta, 'photoHash'> {
  return { photoHash };
}

describe('Arcade preview sources', () => {
  it('recognizes only synthetic Arcade cache records', () => {
    expect(isArcadeCachedMeta(metaWithHash('arcade:donald-trump'))).toBe(true);
    expect(isArcadeCachedMeta(metaWithHash('fighter-hash'))).toBe(false);
    expect(isArcadeCachedMeta(null)).toBe(false);
  });

  it('defaults Arcade globals to their public side view', () => {
    expect(defaultSourceForMeta(metaWithHash('arcade:donald-trump'))).toBe('side');
    expect(defaultSourceForMeta(metaWithHash('fighter-hash'))).toBe('original');
    expect(defaultSourceForMeta(null)).toBe('original');
  });
});

describe('quality labels across saved character versions', () => {
  it('shows the same Champion label for both refined storage IDs', () => {
    expect(tierLabel('rookie')).toBe('Rookie');
    expect(tierLabel('contender')).toBe('Champion');
    expect(tierLabel('champion')).toBe('Champion');
    expect(tierLabel(null)).toBe('Champion');
    expect(tierLabel('future')).toBe('Future');
  });
});
