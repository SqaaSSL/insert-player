import { describe, expect, it } from 'vitest';
import { proxifyFalUrl } from './IntroVideoService';

describe('FAL response URL proxying', () => {
  it('proxies only the exact approved queue origin', () => {
    expect(proxifyFalUrl('https://queue.fal.run/fal-ai/model/requests/123?logs=1')).toBe(
      '/proxy/fal/fal-ai/model/requests/123?logs=1',
    );
    expect(proxifyFalUrl('/proxy/fal/fal-ai/model/requests/123')).toBe(
      '/proxy/fal/fal-ai/model/requests/123',
    );
  });

  it('does not proxy lookalike, credential, insecure, or malformed URLs', () => {
    const rejected = [
      'https://queue.fal.run.evil.example/requests/123',
      'https://queue.fal.run@evil.example/requests/123',
      'http://queue.fal.run/requests/123',
      'https://queue.fal.run:444/requests/123',
      '/proxy/fal-lookalike/requests/123',
      'not a URL',
    ];

    for (const url of rejected) {
      expect(proxifyFalUrl(url)).toBe(url);
    }
  });
});
