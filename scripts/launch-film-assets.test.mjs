import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

describe('versioned landing film assets', () => {
  it('ships the video, poster and captions referenced by the component', () => {
    const source = readFileSync(new URL('src/ui/components/LaunchFilm.tsx', root), 'utf8');
    for (const [path] of source.matchAll(/\/assets\/[^'"\s]+/g)) {
      expect(existsSync(new URL(`public${path}`, root)), path).toBe(true);
    }
    const video = readFileSync(new URL('public/assets/insert-player-launch-aura-v25.mp4', root));
    expect(video.subarray(4, 8).toString()).toBe('ftyp');
    expect(video.byteLength).toBeLessThan(12 * 1024 * 1024);
    const captions = readFileSync(new URL('public/assets/insert-player-launch-aura-v25-en.vtt', root), 'utf8');
    expect(captions).toMatch(/^WEBVTT/);
    expect(captions).toContain('00:23.050');
    expect(captions).toContain('CPU ally in Rush');
    expect(captions).toContain('Start farming Aura');
    expect(captions).not.toMatch(/ridiculous|absurd|silly/i);
    expect(captions).toContain('Challenge your friends');
    const qa = JSON.parse(readFileSync(new URL('videos/insert-player-launch/provenance/aura-launch-v25-qa.json', root)));
    expect(qa.sha256).toBe(createHash('sha256').update(video).digest('hex'));
    expect(qa.duration).toBeCloseTo(27.7, 1);
    expect(qa.width).toBe(1920);
    expect(qa.height).toBe(1080);
    expect(qa.truePeakDb).toBeLessThan(0);
    expect(captions).toBe(readFileSync(new URL('videos/insert-player-launch/provenance/aura-launch-v25-en.vtt', root), 'utf8'));
  });

  it('gives Aura more screen time and replaces both dropped-frame Fight excerpts', () => {
    const base = 'videos/insert-player-launch/provenance/';
    const old = JSON.parse(readFileSync(new URL(`${base}aura-launch-v19-cuts.json`, root)));
    const next = JSON.parse(readFileSync(new URL(`${base}aura-launch-v21-cuts.json`, root)));
    const auraTime = data => data.cuts.filter(c => c.game === 'aura').reduce((total, c) => total + c.duration, 0);
    expect(auraTime(next)).toBeCloseTo(19.9);
    expect(auraTime(next) - auraTime(old)).toBeCloseTo(5.5);
    expect(next.fightCapture.fps).toBe(30);
    expect(next.cuts.filter(c => c.game === 'fight' && !c.retained)).toHaveLength(2);
    expect(next.cuts.filter(c => c.game === 'fight' && !c.retained).every(c => c.source.includes('trump-v21/master.mp4'))).toBe(true);
    const cues = JSON.parse(readFileSync(new URL(`${base}aura-launch-v21-cues.json`, root)));
    expect(cues.duration).toBe(40.15);
    expect(cues.auraBlock).toEqual([16.65, 35.15]);
    expect(cues.cues.every((c, i, all) => c.at + c.range[1] - c.range[0] <= (all[i + 1]?.at ?? cues.duration))).toBe(true);
  });
});
