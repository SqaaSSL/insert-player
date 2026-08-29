import { describe, expect, it } from 'vitest';
import {
  chunkFrontendReleaseAssets,
  collectFrontendReleaseAssetPaths,
  expectedMediaContentType,
} from './frontend-release-assets.mjs';

describe('frontend release assets', () => {
  it('collects the entry bundle and referenced public assets without duplicates', () => {
    expect(
      collectFrontendReleaseAssetPaths({
        entryAssetPath: '/assets/index-current.js',
        sourceTexts: [
          'const film="/assets/insert-player-launch-f57aa4fb.mp4";',
          'url(/assets/landing-transformation.webp) /assets/index-current.js',
        ],
      }),
    ).toEqual([
      '/assets/index-current.js',
      '/assets/insert-player-launch-f57aa4fb.mp4',
      '/assets/landing-transformation.webp',
    ]);
  });

  it('chunks exact purge URLs across both live origins', () => {
    expect(
      chunkFrontendReleaseAssets(
        ['/assets/a.mp4', '/assets/b.webp', '/assets/c.js'],
        ['https://insertplayer.ai', 'https://www.insertplayer.ai'],
        4,
      ),
    ).toEqual([
      [
        'https://insertplayer.ai/assets/a.mp4',
        'https://www.insertplayer.ai/assets/a.mp4',
        'https://insertplayer.ai/assets/b.webp',
        'https://www.insertplayer.ai/assets/b.webp',
      ],
      [
        'https://insertplayer.ai/assets/c.js',
        'https://www.insertplayer.ai/assets/c.js',
      ],
    ]);
  });

  it('identifies media assets that need MIME verification', () => {
    expect(expectedMediaContentType('/assets/launch.mp4')).toBe('video/mp4');
    expect(expectedMediaContentType('/assets/fight.webm')).toBe('video/webm');
    expect(expectedMediaContentType('/assets/app.js')).toBeNull();
  });
});
