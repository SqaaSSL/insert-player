import { describe, expect, it } from 'vitest';
import { stripTrailingSlashes } from './url';

describe('URL normalization', () => {
  it('removes only trailing slash characters', () => {
    expect(stripTrailingSlashes('https://insertplayer.ai///')).toBe('https://insertplayer.ai');
    expect(stripTrailingSlashes('/fighters/new')).toBe('/fighters/new');
    expect(stripTrailingSlashes('////')).toBe('');
  });

  it('handles long untrusted suffixes with a linear scan', () => {
    expect(stripTrailingSlashes(`https://insertplayer.ai${'/'.repeat(100_000)}`))
      .toBe('https://insertplayer.ai');
  });
});
