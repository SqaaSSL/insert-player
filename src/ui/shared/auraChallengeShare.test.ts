import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuraChallengeMatch, createAuraChallenge, createAuraChallengeRoutine, decodeAuraChallenge,
} from '../../game/aura/AuraChallenge.ts';
import { DEFAULT_AURA_TRACK } from '../../game/aura/AuraTracks.ts';
import { auraChallengeShareData, auraChallengeShareUrl, shareAuraChallenge } from './auraChallengeShare.ts';

const routine = createAuraChallengeRoutine(34, 'lowkey', DEFAULT_AURA_TRACK.id, 'aura-plaza')!;

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Aura social challenge payload', () => {
  it('uses the deployed API origin by default when the environment configures it', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.insertplayer.ai');
    const challenge = createAuraChallenge(routine, 'Alex', 1_000, 1);
    const url = new URL(auraChallengeShareData(challenge, 'https://insertplayer.ai').url);
    expect(url.origin).toBe('https://api.insertplayer.ai');
    expect(url.pathname).toMatch(/^\/challenges\/aura\/[A-Za-z0-9_-]+$/);
    expect(decodeAuraChallenge(url.pathname.split('/').at(-1))).toEqual({ ok: true, challenge });
    expect(url.search).toBe('');
  });

  it('uses the configured public Worker preview and preserves the playable token exactly', () => {
    const challenge = createAuraChallenge(routine, 'Alex', 1_000, 1);
    const data = auraChallengeShareData(challenge, 'https://insertplayer.ai/private', 'https://api.insertplayer.ai/');
    const url = new URL(data.url);
    expect(url.origin).toBe('https://api.insertplayer.ai');
    expect(url.pathname).toMatch(/^\/challenges\/aura\/[A-Za-z0-9_-]+$/);
    expect(decodeAuraChallenge(url.pathname.split('/').at(-1))).toEqual({ ok: true, challenge });
    expect(url.search).toBe('');
    expect(data.title).toBe('1,000 AURA · Insert Player');
  });

  it.each(['', '/dev-api', 'http://localhost:8787', 'javascript:alert(1)', 'https://user:secret@api.insertplayer.ai',
    'https://api.insertplayer.ai?redirect=https://untrusted.example', 'https://api.insertplayer.ai#x', 'https://api.insertplayer.ai/private'])
    ('falls back to the local receiver for an unsuitable public API base %s', apiBase => {
      const challenge = createAuraChallenge(routine, 'Alex', 1_000);
      const url = new URL(auraChallengeShareUrl(challenge, 'http://localhost:4182/game?photo=private', apiBase));
      expect(url.origin).toBe('http://localhost:4182');
      expect(url.pathname).toBe('/challenge');
      expect([...url.searchParams.keys()]).toEqual(['challenge']);
      expect(decodeAuraChallenge(url.searchParams.get('challenge'))).toEqual({ ok: true, challenge });
    });

  it.each([0, 1] as const)('keeps the exact routine and performer timing for slot %s in a stable public URL', slot => {
    const challenge = createAuraChallenge(routine, 'Alex', 1_000, slot);
    const data = auraChallengeShareData(challenge, 'https://insertplayer.ai/game?player=private-photo', '');
    const link = new URL(data.url);
    expect(link.pathname).toBe('/challenge');
    expect(Array.from(link.searchParams.keys())).toEqual(['challenge']);
    expect(link.hash).toBe('');
    const decoded = decodeAuraChallenge(link.searchParams.get('challenge'));
    expect(decoded).toEqual({ ok: true, challenge });
    if (!decoded.ok) throw new Error('Expected a playable challenge');
    expect(buildAuraChallengeMatch(decoded.challenge)).toMatchObject({
      seed: routine.seed, auraDifficulty: routine.difficulty, auraTrackId: routine.trackId,
      stageId: routine.stageId, auraChallenge: { chartId: routine.chartId, slot },
    });
    expect(auraChallengeShareData(challenge, 'https://insertplayer.ai/', '').url).toBe(data.url);
    expect(JSON.stringify(data)).not.toContain('private-photo');
    expect(Object.keys(data)).toEqual(['title', 'text', 'url']);
  });

  it('describes a social score without implying that it is verified or ranked', () => {
    const data = auraChallengeShareData(createAuraChallenge(routine, 'Alex', 1_000), 'https://insertplayer.ai');
    expect(data.text).toContain('Alex set 1,000 AURA');
    expect(data.text).toContain('same song and routine free');
    expect(data.text).toContain('Friendly challenge, not a ranked score');
    expect(data).not.toHaveProperty('files');
  });
});

describe('Aura share handoff', () => {
  const data = auraChallengeShareData(createAuraChallenge(routine, 'Alex', 1_000), 'https://insertplayer.ai');

  it('calls native share during the click and does not copy after a successful handoff', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const copy = vi.fn().mockResolvedValue(true);
    const outcome = shareAuraChallenge(data, { share, copy });
    expect(share).toHaveBeenCalledExactlyOnceWith(data);
    await expect(outcome).resolves.toBe('shared');
    expect(copy).not.toHaveBeenCalled();
  });

  it('keeps cancellation distinct from errors and leaves clipboard untouched', async () => {
    const copy = vi.fn();
    await expect(shareAuraChallenge(data, {
      share: vi.fn().mockRejectedValue({ name: 'AbortError' }), copy,
    })).resolves.toBe('cancelled');
    expect(copy).not.toHaveBeenCalled();
  });

  it('falls back to the exact URL when native sharing fails', async () => {
    const copy = vi.fn().mockResolvedValue(true);
    await expect(shareAuraChallenge(data, { share: vi.fn().mockRejectedValue(new Error('Unavailable')), copy })).resolves.toBe('copied');
    expect(copy).toHaveBeenCalledExactlyOnceWith(data.url);
  });

  it('returns a manual-copy fallback when clipboard is denied or throws', async () => {
    await expect(shareAuraChallenge(data, { copy: vi.fn().mockResolvedValue(false) })).resolves.toBe('manual');
    await expect(shareAuraChallenge(data, { copy: vi.fn().mockRejectedValue(new Error('Denied')) })).resolves.toBe('manual');
  });

  it('still copies if the browser share API cannot be read', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { get share() { throw new Error('Blocked'); }, clipboard: { writeText } });
    await expect(shareAuraChallenge(data)).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledExactlyOnceWith(data.url);
  });
});
