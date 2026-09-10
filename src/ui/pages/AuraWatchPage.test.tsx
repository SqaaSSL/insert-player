import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AuraWatchContent, AuraWatchPage } from './AuraWatchPage.tsx';
import type { AuraClip } from '../../services/AuraClips.ts';
import { createAuraChallenge, createAuraChallengeRoutine, encodeAuraChallenge } from '../../game/aura/AuraChallenge.ts';
import { DEFAULT_AURA_TRACK } from '../../game/aura/AuraTracks.ts';
import { AuraChallengeComposer } from '../components/AuraChallengeComposer.tsx';
const routine = createAuraChallengeRoutine(34, 'lowkey', DEFAULT_AURA_TRACK.id, 'insert-player-arena')!;
const token = encodeAuraChallenge(createAuraChallenge(routine, 'Alex', 1200));
const id = 'a'.repeat(32);
const clip: AuraClip = { id, challengeToken: token, videoUrl: `https://api.insertplayer.ai/api/aura/clips/${id}/video`,
  downloadUrl: `https://api.insertplayer.ai/api/aura/clips/${id}/video?download=1`, shareUrl: `https://insertplayer.ai/watch/${id}`,
  ogImageUrl: 'https://api.insertplayer.ai/og.png', posterUrl: 'https://api.insertplayer.ai/real-intro.jpg', createdAt: '2026-09-11T00:00:00Z', expiresAt: '2026-10-11T00:00:00Z', contentType: 'video/mp4', byteLength: 123 };
const props = { clip, onPlay: vi.fn(), onExplore: vi.fn(), onRemoved: vi.fn(), onCreatePlayer: vi.fn() };

describe('Aura public watch page', () => {
  it('puts a real video before the score and challenge action, with downloads secondary', () => {
    const html = renderToStaticMarkup(<AuraWatchContent {...props} />);
    expect(html).toContain(`src="${clip.videoUrl}"`);
    expect(html).toContain(`poster="${clip.posterUrl}"`);
    expect(html).not.toContain(`poster="${clip.ogImageUrl}"`);
    expect(html).toContain('controls=""'); expect(html).toContain('playsInline=""');
    expect(html.indexOf('<video')).toBeLessThan(html.indexOf('<h1'));
    expect(html.indexOf('Play this challenge')).toBeLessThan(html.indexOf('Download video'));
    expect(html).toContain('Alex brought 1,200 Aura.');
    expect(html).toContain('No account or photo needed');
    expect(html).toContain('INSERT PLAYER');
    expect(html).toContain(`href="${clip.downloadUrl.replaceAll('&', '&amp;')}"`);
    expect(html).not.toContain('Remove my battle');
    expect(html).not.toContain('autoplay');
  });
  it('preserves watch/download even when a future gameplay update invalidates the routine', () => {
    const html = renderToStaticMarkup(<AuraWatchContent {...props} clip={{ ...clip, challengeToken: 'old-token' }} />);
    expect(html).toContain('<video');
    expect(html).toContain('Download video');
    expect(html).toContain('Play Aura free');
    expect(html).not.toContain('Play this challenge');
    expect(html).toContain('exact routine is no longer supported');
  });
  it('shows a loading state without inventing a match or broken video source', () => {
    const html = renderToStaticMarkup(<AuraWatchPage clipId={id} onPlay={vi.fn()} onExplore={vi.fn()} />);
    expect(html).toContain('Loading your Aura battle');
    expect(html).not.toContain('<video');
  });
  it('makes publication explicit with a local-only fallback, never uploads on render', () => {
    const file = new File(['video'], 'battle.mp4', { type: 'video/mp4' });
    const created = vi.fn();
    const html = renderToStaticMarkup(<AuraChallengeComposer recording={file} routine={routine} scores={[{ slot: 0, name: 'Alex', score: 1200 }]} onCreated={created} />);
    expect(html).toContain('Create battle link');
    expect(html).toContain('Anyone with the link can watch and download it for 30 days');
    expect(html.indexOf('Create battle link')).toBeLessThan(html.indexOf('Download video'));
    expect(html).toContain('Share challenge only');
    expect(html).not.toContain('Share video + link');
    expect(html).not.toContain('Your character, photos and match video are not attached');
    expect(created).not.toHaveBeenCalled();
  });
});
