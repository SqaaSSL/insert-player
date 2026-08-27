import { describe, expect, it } from 'vitest';
import type { CachedMeta } from '../../services/SpriteCache.ts';
import {
  defaultSourceForMeta,
  isArcadeCachedMeta,
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
