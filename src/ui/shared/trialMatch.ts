import {
  arcadeFighterPhotoHash,
  type CloudFighter,
} from '../../services/CloudFighters.ts';
import type { MatchSceneData } from '../../game/match/MatchConfig.ts';
import { resolveRosterStageThemeId } from '../../game/match/StageConfig.ts';

export const TRIAL_PLAYER_SLUG = 'player-one';
export const TRIAL_PREFERRED_OPPONENT_SLUG = 'donald-trump';
export const TRIAL_OPPONENT_DIFFICULTY = 0.25;
export const TRIAL_CLOUD_ASSET_DEADLINE_MS = 3_000;
export const TRIAL_FALLBACK_PLAYER_NAME = 'Player One';
export const TRIAL_FALLBACK_OPPONENT_NAME = 'CPU Rival';
export const TRIAL_FALLBACK_STAGE_ID = 'insert-player-arena';

export interface TrialFighterPair {
  player: CloudFighter | null;
  opponent: CloudFighter | null;
}

export type TrialMatchData = MatchSceneData & {
  experience: 'trial';
  roundsToWin: 1;
};

/** Returns null rather than making the first playable action wait on cloud media. */
export function trialAssetsBeforeDeadline<T>(
  assets: Promise<T>,
  deadlineMs = TRIAL_CLOUD_ASSET_DEADLINE_MS,
): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(() => resolve(null), Math.max(0, deadlineMs));
    void assets.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      () => {
        globalThis.clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function isArcadeFighter(fighter: CloudFighter): boolean {
  return Boolean(fighter.public && fighter.arcade?.slug);
}

function isDifferentFighter(left: CloudFighter, right: CloudFighter): boolean {
  return left.id !== right.id && left.arcade?.slug !== right.arcade?.slug;
}

/**
 * Selects the stable branded trial pairing without relying on roster order.
 * A sparse or unavailable public roster degrades to the engine's built-in
 * fighters so the first playable action never depends on cloud inventory.
 */
export function selectTrialFighters(fighters: CloudFighter[]): TrialFighterPair {
  const arcadeFighters = fighters.filter(isArcadeFighter);
  if (arcadeFighters.length <= 1) {
    return { player: arcadeFighters[0] ?? null, opponent: null };
  }

  const player = arcadeFighters.find(
    (fighter) => fighter.arcade?.slug === TRIAL_PLAYER_SLUG,
  );
  if (player) {
    const opponent = arcadeFighters.find((fighter) => (
      fighter.arcade?.slug === TRIAL_PREFERRED_OPPONENT_SLUG
      && isDifferentFighter(player, fighter)
    )) ?? arcadeFighters.find((fighter) => isDifferentFighter(player, fighter));
    return { player, opponent: opponent ?? null };
  }

  const opponent = arcadeFighters.find(
    (fighter) => fighter.arcade?.slug === TRIAL_PREFERRED_OPPONENT_SLUG,
  ) ?? arcadeFighters[1];
  return {
    player: arcadeFighters.find((fighter) => isDifferentFighter(opponent, fighter)) ?? null,
    opponent,
  };
}

export function buildTrialMatchData({ player, opponent }: TrialFighterPair): TrialMatchData {
  if (
    (player && !isArcadeFighter(player))
    || (opponent && !isArcadeFighter(opponent))
    || (player && opponent && !isDifferentFighter(player, opponent))
  ) {
    throw new Error('Cloud trial fighters must be distinct active Arcade fighters.');
  }

  return {
    experience: 'trial',
    roundsToWin: 1,
    vsAI: true,
    cpuVsCpu: false,
    p1PhotoHash: player ? arcadeFighterPhotoHash(player) : undefined,
    p2PhotoHash: opponent ? arcadeFighterPhotoHash(opponent) : undefined,
    p1CloudFighterId: player?.id ?? null,
    p2CloudFighterId: opponent?.id ?? null,
    p1Name: player?.name ?? TRIAL_FALLBACK_PLAYER_NAME,
    p2Name: opponent?.name ?? TRIAL_FALLBACK_OPPONENT_NAME,
    p1PersonalityId: 'balanced',
    p2PersonalityId: opponent?.arcade?.defaultPersonality ?? 'balanced',
    stageId: resolveRosterStageThemeId({
      manualStageId: null,
      hasCustomPhotoStage: false,
      p1ArcadeSlug: player?.arcade?.slug,
      p2ArcadeSlug: opponent?.arcade?.slug,
    }) ?? TRIAL_FALLBACK_STAGE_ID,
    p2Difficulty: TRIAL_OPPONENT_DIFFICULTY,
  };
}

export function createTrialMatchData(fighters: CloudFighter[]): TrialMatchData {
  return buildTrialMatchData(selectTrialFighters(fighters));
}
