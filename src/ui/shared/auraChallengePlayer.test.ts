import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveSpriteCacheScope, getAllSpritesForHash, getCachedMeta } from '../../services/SpriteCache.ts';
import { AURA_ANIMATION_NAMES } from '../../services/FighterAssetPacks.ts';
import { PLAYABLE_ANIMATION_NAMES } from '../../services/PlayableFighterAssets.ts';
import { withPreferredAuraChallengePlayer } from './auraChallengePlayer.ts';
import { buildAuraChallengeMatch, createAuraChallenge, createAuraChallengeRoutine, encodeAuraChallenge } from '../../game/aura/AuraChallenge.ts';
import { DEFAULT_AURA_TRACK } from '../../game/aura/AuraTracks.ts';

vi.mock('../../services/SpriteCache.ts', () => ({
  getActiveSpriteCacheScope: vi.fn(), getAllSpritesForHash: vi.fn(), getCachedMeta: vi.fn(),
}));
const challenge = createAuraChallenge(createAuraChallengeRoutine(94, 'viral', DEFAULT_AURA_TRACK.id, 'insert-player-arena')!, 'Alex', 3_000);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getActiveSpriteCacheScope).mockReturnValue('user:recipient');
  vi.mocked(getCachedMeta).mockResolvedValue({ photoHash: 'recipient-private-photo', cloudFighterId: 'private-fighter', characterName: 'Recipient' } as never);
  vi.mocked(getAllSpritesForHash).mockResolvedValue(AURA_ANIMATION_NAMES.map(animationName => ({
    animationName, frameWidth: 192, frameHeight: 256, frameCount: 4, pngBlob: new Blob(['sprite']),
  })) as never);
});

describe('recipient-owned challenge performer', () => {
  it('can play immediately without reading a cache or signing in', async () => {
    const data = buildAuraChallengeMatch(challenge);
    await expect(withPreferredAuraChallengePlayer(data)).resolves.toEqual(data);
    expect(getCachedMeta).not.toHaveBeenCalled();
  });
  it('uses a complete local Aura pack without changing or leaking into the shared routine', async () => {
    const data = await withPreferredAuraChallengePlayer(buildAuraChallengeMatch(challenge), 'recipient-private-photo');
    expect(getCachedMeta).toHaveBeenCalledWith('recipient-private-photo', 'user:recipient');
    expect(data).toMatchObject({ p1Name: 'Recipient', p1PhotoHash: 'recipient-private-photo', p1CloudFighterId: 'private-fighter', auraChallenge: challenge });
    expect(data.seed).toBe(challenge.seed);
    const decoded = atob(encodeAuraChallenge(data.auraChallenge!).replace(/-/g, '+').replace(/_/g, '/'));
    expect(decoded).not.toContain('recipient-private-photo');
    expect(decoded).not.toContain('private-fighter');
  });
  it('refuses incomplete assets and in-flight account switches', async () => {
    vi.mocked(getAllSpritesForHash).mockResolvedValueOnce([]);
    await expect(withPreferredAuraChallengePlayer(buildAuraChallengeMatch(challenge), 'recipient-private-photo')).rejects.toThrow('not ready');
    vi.mocked(getActiveSpriteCacheScope).mockReturnValueOnce('user:recipient').mockReturnValueOnce('user:other');
    await expect(withPreferredAuraChallengePlayer(buildAuraChallengeMatch(challenge), 'recipient-private-photo')).rejects.toThrow('not ready');
  });
  it('places the recipient-owned identity on P2 when that is the original challenge timing', async () => {
    const second = { ...challenge, slot: 1 as const };
    const data = await withPreferredAuraChallengePlayer(buildAuraChallengeMatch(second), 'recipient-private-photo');
    expect(data).toMatchObject({ p1Name: 'BYTE', p2Name: 'Recipient', p2PhotoHash: 'recipient-private-photo', auraChallenge: second });
    expect(data.p1PhotoHash).toBeUndefined();
  });
  it('refuses an old Fight-only choice even when its combat pack is complete', async () => {
    vi.mocked(getAllSpritesForHash).mockResolvedValueOnce(PLAYABLE_ANIMATION_NAMES.map(animationName => ({
      animationName, frameWidth: 192, frameHeight: 256, frameCount: 4, pngBlob: new Blob(['sprite']),
    })) as never);
    await expect(withPreferredAuraChallengePlayer(buildAuraChallengeMatch(challenge), 'recipient-private-photo'))
      .rejects.toThrow('not ready');
  });
  it('accepts the official cached Trump with his bundled Aura performances', async () => {
    const photoHash = 'arcade:donald-trump:trump-id';
    vi.mocked(getCachedMeta).mockResolvedValueOnce({ photoHash, cloudFighterId: 'trump-id', cloudPublic: true,
      characterName: 'Donald Trump' } as never);
    vi.mocked(getAllSpritesForHash).mockResolvedValueOnce([]);
    await expect(withPreferredAuraChallengePlayer(buildAuraChallengeMatch(challenge), photoHash))
      .resolves.toMatchObject({ p1PhotoHash: photoHash, p1Name: 'Donald Trump' });
  });
});
