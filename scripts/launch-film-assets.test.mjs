import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

describe('versioned landing film assets', () => {
  it('ships the video, poster and captions referenced by the component', () => {
    const source = readFileSync(new URL('src/ui/components/LaunchFilm.tsx', root), 'utf8');
    for (const [path] of source.matchAll(/\/assets\/[^'"\s]+/g)) {
      expect(existsSync(new URL(`public${path}`, root)), path).toBe(true);
    }
    const video = readFileSync(new URL('public/assets/insert-player-launch-aura-v19.mp4', root));
    expect(video.subarray(4, 8).toString()).toBe('ftyp');
    expect(video.byteLength).toBeLessThan(12 * 1024 * 1024);
    const captions = readFileSync(new URL('public/assets/insert-player-launch-aura-v19-en.vtt', root), 'utf8');
    expect(captions).toMatch(/^WEBVTT/);
    expect(captions).toContain('00:30.950');
  });
});
