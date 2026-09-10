import { describe, expect, it } from 'vitest';
import type { MatchSceneData } from '../../game/match/MatchConfig';
import {
  parseStoredMatch,
  readStoredMatch,
  STORED_MATCH_TTL_MS,
  storedMatchStorageKey,
  writeStoredMatch,
} from './storedMatch';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const match: MatchSceneData = {
  experience: 'trial',
  roundsToWin: 1,
  vsAI: true,
  cpuVsCpu: false,
  p1PhotoHash: 'player-one',
  p2PhotoHash: 'arcade:donald-trump',
  p1Name: 'Player One',
  p2Name: 'Donald Trump',
  p2CloudFighterId: 'arcade-id',
  p2PersonalityId: 'showboat',
  stageId: 'executive-rumble',
};

describe('stored match', () => {
  it('round-trips only within the current auth session scope', () => {
    const storage = new MemoryStorage();
    expect(writeStoredMatch(match, 'user-a', storage, 1_000)).toBe(true);
    expect(readStoredMatch('user-a', storage, 1_001)).toEqual(match);
    expect(readStoredMatch('user-b', storage, 1_001)).toBeNull();
    expect(storage.getItem(storedMatchStorageKey('user-a'))).not.toBeNull();
  });

  it('keeps pre-trial match payloads valid with normal defaults', () => {
    const storage = new MemoryStorage();
    const standardMatch: MatchSceneData = { ...match };
    delete standardMatch.experience;
    delete standardMatch.roundsToWin;
    expect(writeStoredMatch(standardMatch, 'user-a', storage, 1_000)).toBe(true);
    expect(readStoredMatch('user-a', storage, 1_001)).toEqual(standardMatch);
  });

  it('round-trips the cooperative Rush mode without changing the Fight schema', () => {
    const storage = new MemoryStorage();
    const rushMatch: MatchSceneData = {
      ...match,
      gameMode: 'rush',
      vsAI: true,
      stageId: 'side-street',
    };
    expect(writeStoredMatch(rushMatch, 'user-a', storage, 1_000)).toBe(true);
    expect(readStoredMatch('user-a', storage, 1_001)).toEqual(rushMatch);
  });

  it.each(['aura-plaza-v3', 'aura-plaza-v2', 'aura-plaza', 'executive-rumble', 'insert-player-arena'] as const)(
    'restores an Aura Battle on %s without replacing its chosen stage', stageId => {
      const storage = new MemoryStorage();
      const auraMatch: MatchSceneData = {
        ...match,
        gameMode: 'aura',
        auraDifficulty: 'untouchable',
        stageId,
      };
      expect(writeStoredMatch(auraMatch, 'user-a', storage, 1_000)).toBe(true);
      expect(readStoredMatch('user-a', storage, 1_001)).toEqual(auraMatch);
    },
  );

  it.each(['fight', 'rush', undefined] as const)(
    'rejects the Aura-only stage for %s matches when writing and restoring', gameMode => {
      const storage = new MemoryStorage();
      for (const stageId of ['aura-plaza-v3', 'aura-plaza-v2', 'aura-plaza'] as const) {
        const wrongMode: MatchSceneData = { ...match, gameMode, stageId };
        expect(writeStoredMatch(wrongMode, 'user-a', storage, 1_000)).toBe(false);
        const raw = JSON.stringify({ version: 1, authSessionKey: 'user-a', createdAt: 1_000, data: wrongMode });
        expect(parseStoredMatch(raw, 'user-a', 1_001)).toBeNull();
      }
    },
  );

  it.each(['fight', 'aura', 'rush'] as const)(
    'preserves %s custom photo stage payloads without a built-in stage', gameMode => {
      const storage = new MemoryStorage();
      const customMatch: MatchSceneData = {
        ...match, gameMode, stageId: undefined, customStageKey: 'my-plaza', customStageLabel: 'My Plaza',
      };
      expect(writeStoredMatch(customMatch, 'user-a', storage, 1_000)).toBe(true);
      expect(readStoredMatch('user-a', storage, 1_001)).toEqual(customMatch);
    },
  );

  it('rejects a Fight backdrop for Rush while keeping authored Rush routes playable', () => {
    const storage = new MemoryStorage();
    expect(writeStoredMatch({ ...match, gameMode: 'rush' }, 'user-a', storage)).toBe(false);
    expect(writeStoredMatch({ ...match, gameMode: 'rush', stageId: 'la-jaula-304' }, 'user-a', storage)).toBe(true);
  });

  it('rejects expired, legacy, and malformed payloads', () => {
    const storage = new MemoryStorage();
    storage.setItem('ai-street-fighter:last-match', JSON.stringify(match));
    expect(readStoredMatch('user-a', storage, 1_000)).toBeNull();
    expect(storage.getItem('ai-street-fighter:last-match')).toBeNull();

    expect(writeStoredMatch(match, 'user-a', storage, 1_000)).toBe(true);
    expect(readStoredMatch('user-a', storage, 1_000 + STORED_MATCH_TTL_MS + 1)).toBeNull();
    expect(parseStoredMatch('{bad json', 'user-a')).toBeNull();
  });

  it('guards the shape before persisting or restoring it', () => {
    const storage = new MemoryStorage();
    expect(writeStoredMatch({ ...match, p1Name: '' }, 'user-a', storage)).toBe(false);
    expect(writeStoredMatch({ ...match, vsAI: undefined }, 'user-a', storage)).toBe(false);
    expect(writeStoredMatch({ ...match, stageId: 'dojo' }, 'user-a', storage)).toBe(false);
    expect(writeStoredMatch({ ...match, experience: 'demo' as never }, 'user-a', storage)).toBe(false);
    expect(writeStoredMatch({ ...match, roundsToWin: 0 }, 'user-a', storage)).toBe(false);
    expect(writeStoredMatch({ ...match, roundsToWin: 1.5 }, 'user-a', storage)).toBe(false);
    expect(writeStoredMatch({ ...match, roundsToWin: 6 }, 'user-a', storage)).toBe(false);
    expect(writeStoredMatch({ ...match, gameMode: 'race' } as unknown as MatchSceneData, 'user-a', storage)).toBe(false);
    expect(writeStoredMatch({ ...match, gameMode: 'aura', auraDifficulty: 'sleepy' } as unknown as MatchSceneData, 'user-a', storage)).toBe(false);

    const invalid = JSON.stringify({
      version: 1,
      authSessionKey: 'user-a',
      createdAt: 1_000,
      data: { ...match, stageId: 'unknown-stage' },
    });
    expect(parseStoredMatch(invalid, 'user-a', 1_001)).toBeNull();
  });
});
