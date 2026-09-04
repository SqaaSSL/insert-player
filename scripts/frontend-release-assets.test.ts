import { describe, expect, it } from 'vitest';
import {
  chunkFrontendReleaseAssets,
  collectFrontendReleaseAssetPaths,
  expectedMediaContentType,
  waitForLiveMediaAsset,
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

  it('waits through the previous Pages fallback before accepting live media', async () => {
    const responses = [
      new Response('<!doctype html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      new Response(null, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': '19284007' },
      }),
    ];
    const retries = [];

    await expect(
      waitForLiveMediaAsset({
        url: 'https://insertplayer.ai/assets/launch.mp4',
        expectedType: 'video/mp4',
        fetchImpl: async () => responses.shift(),
        sleep: async () => {},
        maxAttempts: 2,
        onRetry: (result) => retries.push(result),
      }),
    ).resolves.toMatchObject({
      status: 200,
      actualType: 'video/mp4',
      contentLength: 19284007,
      attempt: 2,
    });
    expect(retries).toEqual([
      expect.objectContaining({ status: 200, actualType: 'text/html', attempt: 1 }),
    ]);
  });

  it('fails closed when media never reaches the expected content type', async () => {
    await expect(
      waitForLiveMediaAsset({
        url: 'https://insertplayer.ai/assets/launch.mp4',
        expectedType: 'video/mp4',
        fetchImpl: async () => new Response('<!doctype html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
        sleep: async () => {},
        maxAttempts: 2,
      }),
    ).rejects.toThrow('status=200 type=text/html bytes=unspecified');
  });
});
