import { describe, expect, it } from 'vitest';
import { sourceGenerationStrategy } from './sourceGenerationPolicy';

describe('sourceGenerationStrategy', () => {
  it('uses text only for the first official source pose', () => {
    expect(sourceGenerationStrategy('repose', 'official prompt')).toBe('official-text-side');
    expect(sourceGenerationStrategy('upright', 'official prompt')).toBe('official-reference-upright');
    expect(sourceGenerationStrategy('crouch', 'official prompt')).toBe('official-reference-crouch');
  });

  it('keeps user-created source generation reference-guided', () => {
    expect(sourceGenerationStrategy('repose', undefined)).toBe('reference-photo');
    expect(sourceGenerationStrategy('upright', '   ')).toBe('reference-photo');
    expect(sourceGenerationStrategy('crouch', undefined)).toBe('reference-photo');
  });
});
