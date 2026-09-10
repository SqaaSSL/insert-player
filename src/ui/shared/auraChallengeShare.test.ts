import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuraChallengeMatch, createAuraChallenge, createAuraChallengeRoutine, decodeAuraChallenge,
} from '../../game/aura/AuraChallenge.ts';
import { DEFAULT_AURA_TRACK } from '../../game/aura/AuraTracks.ts';
import { auraChallengeShareData, shareAuraChallenge } from './auraChallengeShare.ts';

const routine = createAuraChallengeRoutine(34, 'lowkey', DEFAULT_AURA_TRACK.id, 'aura-plaza')!;

afterEach(() => vi.unstubAllGlobals());

describe('Aura social challenge payload', () => {
  it.each([0, 1] as const)('keeps the exact routine and performer timing for slot %s in a stable public URL', slot => {
    const challenge = createAuraChallenge(routine, 'Alex', 1_000, slot);
    const data = auraChallengeShareData(challenge, 'https://insertplayer.ai/game?player=private-photo');
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
    expect(auraChallengeShareData(challenge, 'https://insertplayer.ai/').url).toBe(data.url);
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
