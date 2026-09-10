import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AURA_CHALLENGE_ASSETS } from './AuraChallengeAssets.ts';
import { prepareAuraChallengeMusic, createAuraChallengeMusicUrl, isVerifiedAuraChallengeMusicUrl, revokeAuraChallengeMusicUrl } from './AuraChallengeMedia.ts';
import { createAuraChallenge, createAuraChallengeRoutine } from './AuraChallenge.ts';
import { DEFAULT_AURA_TRACK } from './AuraTracks.ts';

const publicRoot = new URL('../../../public/', import.meta.url);
function bytes(url) { return new Uint8Array(readFileSync(new URL(url.slice(1), publicRoot))); }
function challenge(stage = 'insert-player-arena') { return createAuraChallenge(createAuraChallengeRoutine(1234, 'viral', DEFAULT_AURA_TRACK.id, stage), 'Player', 500); }
afterEach(() => vi.unstubAllGlobals());

describe('pinned public challenge media', () => {
  it('pins every installed track and stage to exact bytes; replacements require a new challenge revision', () => {
    for (const asset of Object.values(AURA_CHALLENGE_ASSETS)) {
      expect(createHash('sha256').update(bytes(asset.url)).digest('hex'), asset.url).toBe(asset.sha256);
    }
  });

  it.each(['aura-plaza-v3', 'aura-plaza-v2', 'aura-plaza', 'insert-player-arena'])('returns verified song bytes and verifies the %s stage', async (stageId) => {
    const fetcher = vi.fn(async (url) => new Response(bytes(url)));
    vi.stubGlobal('fetch', fetcher);
    const result = await prepareAuraChallengeMusic(challenge(stageId), new AbortController().signal);
    const expected = AURA_CHALLENGE_ASSETS[`track:${DEFAULT_AURA_TRACK.id}`];
    expect(result.type).toBe('audio/mpeg');
    expect(createHash('sha256').update(new Uint8Array(await result.arrayBuffer())).digest('hex')).toBe(expected.sha256);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([expected.url, AURA_CHALLENGE_ASSETS[`stage:${stageId}`].url]);
  });

  it('grants recording only to URLs created from the exact verified song blob and revokes that grant', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => new Response(bytes(url))));
    const music = await prepareAuraChallengeMusic(challenge(), new AbortController().signal);
    const unregistered = URL.createObjectURL(music);
    const arbitrary = URL.createObjectURL(new Blob(['private audio']));
    const verified = createAuraChallengeMusicUrl(music);
    expect(isVerifiedAuraChallengeMusicUrl(verified)).toBe(true);
    expect(isVerifiedAuraChallengeMusicUrl(unregistered)).toBe(false);
    expect(isVerifiedAuraChallengeMusicUrl(arbitrary)).toBe(false);
    expect(isVerifiedAuraChallengeMusicUrl('https://external.example/private.mp3')).toBe(false);
    expect(() => createAuraChallengeMusicUrl(new Blob([music]))).toThrow('not been verified');
    revokeAuraChallengeMusicUrl(verified);
    expect(isVerifiedAuraChallengeMusicUrl(verified)).toBe(false);
    URL.revokeObjectURL(unregistered);
    URL.revokeObjectURL(arbitrary);
  });

  it('refuses changed song bytes rather than scoring against different music', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(url.endsWith('.mp3') ? 'changed audio' : bytes(url))));
    await expect(prepareAuraChallengeMusic(challenge(), new AbortController().signal)).rejects.toThrow('media has changed');
  });

  it('bounds downloads even if an asset server returns an oversized body', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(url.endsWith('.mp3') ? new Uint8Array(8_000_001) : bytes(url))));
    await expect(prepareAuraChallengeMusic(challenge(), new AbortController().signal)).rejects.toThrow('exceeded its limit');
  });
});
