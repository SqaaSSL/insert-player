import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPRITE_ANIMATION_FORMAT,
  SPRITE_ANIMATION_FORMATS,
  isSpriteAnimationFormat,
  normalizeSpriteAnimationFormat,
} from './spriteAnimationFormat';

const workerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(workerRoot);

describe('sprite animation format contract', () => {
  it('defaults old or unknown metadata to legacy and accepts only explicit formats', () => {
    expect(DEFAULT_SPRITE_ANIMATION_FORMAT).toBe('legacy');
    expect(normalizeSpriteAnimationFormat(undefined)).toBe('legacy');
    expect(normalizeSpriteAnimationFormat('future-format')).toBe('legacy');
    expect(isSpriteAnimationFormat('video-dense-v1')).toBe(true);
    expect(isSpriteAnimationFormat('future-format')).toBe(false);
  });

  it('keeps frontend, Worker, and D1 enum values in parity', () => {
    const frontend = readFileSync(join(repositoryRoot, 'src/SpriteAnimationFormat.ts'), 'utf8');
    const migration = readFileSync(
      join(workerRoot, 'migrations/0028_sprite_animation_format.sql'),
      'utf8',
    );

    expect(SPRITE_ANIMATION_FORMATS).toEqual(['legacy', 'video-dense-v1']);
    for (const format of SPRITE_ANIMATION_FORMATS) {
      expect(frontend).toContain(`'${format}'`);
      expect(migration).toContain(`'${format}'`);
    }
    expect(migration.match(/animation_format IN \('legacy', 'video-dense-v1'\)/g))
      .toHaveLength(3);
  });
});
