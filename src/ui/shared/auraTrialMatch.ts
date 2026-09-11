import type { MatchSceneData } from '../../game/match/MatchConfig.ts';
import { DEFAULT_AURA_STAGE_ID } from '../../game/match/StageConfig.ts';

/** First play uses only the reviewed Aura bundles shipped with the game. */
export function buildAuraTrialMatch(seed: number): MatchSceneData {
  return {
    gameMode: 'aura',
    experience: 'trial',
    auraTrialPreset: 'trump-lamine',
    vsAI: true,
    cpuVsCpu: false,
    p1Name: 'DONALD TRUMP',
    p2Name: 'LAMINE YAMAL',
    stageId: DEFAULT_AURA_STAGE_ID,
    roundsToWin: 1,
    p2Difficulty: 0.25,
    auraDifficulty: 'lowkey',
    seed,
  };
}
