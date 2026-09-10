import { describe, expect, it } from 'vitest';
import { createAuraChallenge, createAuraChallengeRoutine } from '../../game/aura/AuraChallenge.ts';
import { DEFAULT_AURA_TRACK } from '../../game/aura/AuraTracks.ts';
import { AURA_CHALLENGE_HISTORY_KEY, readAuraChallenges, rememberAuraChallenge } from './auraChallenges.ts';

function makeChallenge(seed = 10) {
  return createAuraChallenge(createAuraChallengeRoutine(seed, 'lowkey', DEFAULT_AURA_TRACK.id, 'insert-player-arena')!, 'Player', 1_000);
}
function store() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
}
describe('device-only challenge history', () => {
  it('remembers a challenge and its best attempt without duplicating it on retry', () => {
    const storage = store();
    const challenge = makeChallenge();
    rememberAuraChallenge(challenge, 'played', 800, storage, 100);
    rememberAuraChallenge(challenge, 'played', 1_200, storage, 101);
    rememberAuraChallenge(challenge, 'played', 500, storage, 102);
    expect(readAuraChallenges(storage)).toHaveLength(1);
    expect(readAuraChallenges(storage)[0]).toMatchObject({ bestScore: 1_200, updatedAt: 102 });
    expect(storage.getItem(AURA_CHALLENGE_HISTORY_KEY)).not.toMatch(/photoHash|cloudFighterId|video|https:/);
  });
  it('caps history, ignores corruption and keeps storage denial out of gameplay', () => {
    const storage = store();
    for (let seed = 1; seed <= 25; seed++) rememberAuraChallenge(makeChallenge(seed), 'created', undefined, storage, seed);
    expect(readAuraChallenges(storage)).toHaveLength(20);
    storage.setItem(AURA_CHALLENGE_HISTORY_KEY, '{broken');
    expect(readAuraChallenges(storage)).toEqual([]);
    const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    expect(() => rememberAuraChallenge(makeChallenge(), 'played', 500, denied)).not.toThrow();
    expect(readAuraChallenges(denied)).toEqual([]);
  });
});
