import { describe, expect, it } from 'vitest';
import { buildAuraTrialMatch } from './auraTrialMatch.ts';
import { auraDemoPerformer } from '../../game/aura/AuraDemoPerformers.ts';
import { DEFAULT_AURA_STAGE_ID } from '../../game/match/StageConfig.ts';
import { parseStoredMatch, isValidStoredMatchData } from './storedMatch.ts';
import type { MatchSceneData } from '../../game/match/MatchConfig.ts';

describe('Aura first-play cast', () => {
  it('starts Trump versus Lamine with the existing easy rhythm rules and no cloud pack dependency', () => {
    const match = buildAuraTrialMatch(67);
    expect(match).toEqual({
      gameMode: 'aura', experience: 'trial', auraTrialPreset: 'trump-lamine',
      vsAI: true, cpuVsCpu: false, p1Name: 'DONALD TRUMP', p2Name: 'LAMINE YAMAL',
      stageId: DEFAULT_AURA_STAGE_ID, roundsToWin: 1, p2Difficulty: 0.25,
      auraDifficulty: 'lowkey', seed: 67,
    });
    expect(auraDemoPerformer(match, 0)).toEqual({ id: 'donald-trump', tint: 0xffffff });
    expect(auraDemoPerformer(match, 1)).toEqual({ id: 'lamine-yamal', tint: 0xffffff });
    expect(isValidStoredMatchData(match)).toBe(true);
  });

  it('restores the explicit cast on reload without depending on display names', () => {
    const match = buildAuraTrialMatch(123);
    const restored = parseStoredMatch(JSON.stringify({
      version: 1, authSessionKey: 'guest', createdAt: 1_000, data: match,
    }), 'guest', 1_001);
    expect(restored).toEqual(match);
    expect(auraDemoPerformer(restored!, 0)?.id).toBe('donald-trump');
    expect(auraDemoPerformer(restored!, 1)?.id).toBe('lamine-yamal');
    const { auraTrialPreset: _preset, ...namedMatch } = match;
    expect(auraDemoPerformer(namedMatch, 0)).toBeUndefined();
    expect(auraDemoPerformer(namedMatch, 1)).toBeUndefined();
  });

  it.each([
    { gameMode: 'fight' }, { experience: 'standard' }, { vsAI: false }, { cpuVsCpu: true },
    { p1PhotoHash: 'my-character' }, { p2PhotoHash: 'my-rival' },
    { p1CloudFighterId: 'pending-player' }, { p2CloudFighterId: 'pending-rival' },
    { online: { localSlot: 0 } }, { auraChallenge: {} }, { auraTrialPreset: 'unreviewed-cast' },
  ])('rejects the preset outside its isolated first-play context: %j', overrides => {
    const match = { ...buildAuraTrialMatch(67), ...overrides } as unknown as MatchSceneData;
    expect(isValidStoredMatchData(match)).toBe(false);
    expect(auraDemoPerformer(match, 0)).toBeUndefined();
    expect(auraDemoPerformer(match, 1)).toBeUndefined();
  });
});
