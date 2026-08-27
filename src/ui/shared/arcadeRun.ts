import type { MatchSceneData, FighterPersonalityId } from '../../game/match/MatchConfig.ts';
import { resolveRosterStageThemeId } from '../../game/match/StageConfig.ts';

export const ARCADE_RUN_STORAGE_KEY = 'ai-street-fighter:arcade-run';
export const ARCADE_RUN_CONTINUES = 3;

export interface ArcadeRunPlayer {
  key: string;
  photoHash: string;
  cloudFighterId: string | null;
  name: string;
  personalityId: FighterPersonalityId;
}

export interface ArcadeRunRung {
  slug: string | null;
  fighterId: string | null;
  photoHash: string;
  name: string;
  personalityId: FighterPersonalityId;
  challengerLine: string | null;
}

export interface ArcadeRunState {
  ownerScope: string;
  player: ArcadeRunPlayer;
  rungs: ArcadeRunRung[];
  currentRung: number;
  continuesLeft: number;
  continuesUsed: number;
  startedAt: number;
}

/**
 * Difficulty curve for rung `index` of `total`: eases from 0.25 up to 1.0 so
 * the first challengers are forgiving and the boss plays at full strength.
 */
export function rungDifficulty(index: number, total: number): number {
  if (total <= 1) return 1;
  const t = Math.max(0, Math.min(1, index / (total - 1)));
  return Math.round((0.25 + 0.75 * t) * 100) / 100;
}

export function createArcadeRun(
  player: ArcadeRunPlayer,
  rungs: ArcadeRunRung[],
  ownerScope: string,
  startedAt: number,
): ArcadeRunState {
  if (rungs.length === 0) {
    throw new Error('Arcade run requires at least one challenger');
  }
  return {
    ownerScope,
    player,
    rungs,
    currentRung: 0,
    continuesLeft: ARCADE_RUN_CONTINUES,
    continuesUsed: 0,
    startedAt,
  };
}

export function currentRung(run: ArcadeRunState): ArcadeRunRung {
  return run.rungs[Math.min(run.currentRung, run.rungs.length - 1)];
}

export function isFinalRung(run: ArcadeRunState): boolean {
  return run.currentRung >= run.rungs.length - 1;
}

export function advanceArcadeRun(run: ArcadeRunState): ArcadeRunState {
  return { ...run, currentRung: Math.min(run.currentRung + 1, run.rungs.length - 1) };
}

export function spendArcadeContinue(run: ArcadeRunState): ArcadeRunState | null {
  if (run.continuesLeft <= 0) return null;
  return {
    ...run,
    continuesLeft: run.continuesLeft - 1,
    continuesUsed: run.continuesUsed + 1,
  };
}

/**
 * Match payload for the run's current rung. `continuesUsed` feeds `remix`
 * so a continue replays the same challenger with a fresh seed instead of a
 * frame-identical rematch.
 */
export function buildRungMatchData(run: ArcadeRunState): MatchSceneData {
  const rung = currentRung(run);
  return {
    stageId: resolveRosterStageThemeId({
      manualStageId: null,
      hasCustomPhotoStage: false,
      p2ArcadeSlug: rung.slug,
    }),
    vsAI: true,
    cpuVsCpu: false,
    p1PhotoHash: run.player.photoHash,
    p2PhotoHash: rung.photoHash,
    p1CloudFighterId: run.player.cloudFighterId,
    p2CloudFighterId: rung.fighterId,
    p1Name: run.player.name,
    p2Name: rung.name,
    p1PersonalityId: run.player.personalityId,
    p2PersonalityId: rung.personalityId,
    remix: run.continuesUsed,
    p2Difficulty: rungDifficulty(run.currentRung, run.rungs.length),
  };
}

function isValidRun(value: unknown): value is ArcadeRunState {
  if (!value || typeof value !== 'object') return false;
  const run = value as Partial<ArcadeRunState>;
  return Boolean(
    typeof run.ownerScope === 'string' &&
    run.player && typeof run.player.photoHash === 'string' &&
    Array.isArray(run.rungs) && run.rungs.length > 0 &&
    typeof run.currentRung === 'number' &&
    typeof run.continuesLeft === 'number' &&
    typeof run.continuesUsed === 'number',
  );
}

export function readArcadeRun(ownerScope: string): ArcadeRunState | null {
  try {
    const raw = window.sessionStorage.getItem(ARCADE_RUN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidRun(parsed)) return null;
    // A run belongs to the account that started it; never resume another
    // owner's ladder after a shared-browser account switch.
    if (parsed.ownerScope !== ownerScope) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeArcadeRun(run: ArcadeRunState): void {
  try {
    window.sessionStorage.setItem(ARCADE_RUN_STORAGE_KEY, JSON.stringify(run));
  } catch {
    // Storage unavailable: the run simply won't survive a reload.
  }
}

export function clearArcadeRun(): void {
  try {
    window.sessionStorage.removeItem(ARCADE_RUN_STORAGE_KEY);
  } catch {
    // Ignore.
  }
}
