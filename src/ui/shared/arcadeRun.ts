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

function arcadeSlugFromPhotoHash(photoHash: string): string | null {
  if (!photoHash.startsWith('arcade:')) return null;
  const slug = photoHash.slice('arcade:'.length).split(':', 1)[0]?.trim();
  return slug || null;
}

function sameFighter(player: ArcadeRunPlayer, rung: ArcadeRunRung): boolean {
  if (player.cloudFighterId && rung.fighterId === player.cloudFighterId) return true;
  if (player.photoHash === rung.photoHash) return true;
  const playerSlug = arcadeSlugFromPhotoHash(player.photoHash);
  return Boolean(playerSlug && rung.slug && playerSlug === rung.slug);
}

function rungIdentityKeys(rung: ArcadeRunRung): string[] {
  return [
    rung.fighterId ? `id:${rung.fighterId}` : null,
    rung.photoHash ? `hash:${rung.photoHash}` : null,
    rung.slug ? `slug:${rung.slug}` : null,
  ].filter((key): key is string => Boolean(key));
}

/**
 * Enforces the ladder identity invariant at its domain boundary: the player
 * never appears as a challenger and repeated versions of one global appear
 * only once. The first reviewed roster occurrence wins, preserving rank order.
 */
export function sanitizeArcadeRunRungs(
  player: ArcadeRunPlayer,
  rungs: ArcadeRunRung[],
): ArcadeRunRung[] {
  const seen = new Set<string>();
  const sanitized: ArcadeRunRung[] = [];
  for (const rung of rungs) {
    if (sameFighter(player, rung)) continue;
    const identityKeys = rungIdentityKeys(rung);
    if (identityKeys.some((key) => seen.has(key))) continue;
    sanitized.push(rung);
    identityKeys.forEach((key) => seen.add(key));
  }
  return sanitized;
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
  const sanitizedRungs = sanitizeArcadeRunRungs(player, rungs);
  if (sanitizedRungs.length === 0) {
    throw new Error('Arcade run requires at least one challenger');
  }
  return {
    ownerScope,
    player,
    rungs: sanitizedRungs,
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

export function isMatchForArcadeRun(data: MatchSceneData, run: ArcadeRunState): boolean {
  const rung = currentRung(run);
  return Boolean(
    data.experience !== 'trial' &&
    data.vsAI &&
    !data.cpuVsCpu &&
    data.p1PhotoHash === run.player.photoHash &&
    data.p2PhotoHash === rung.photoHash,
  );
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

function normalizeStoredRun(run: ArcadeRunState): ArcadeRunState | null {
  const sanitizedRungs = sanitizeArcadeRunRungs(run.player, run.rungs);
  if (sanitizedRungs.length === 0) return null;
  if (sanitizedRungs.length === run.rungs.length) {
    return {
      ...run,
      currentRung: Math.min(Math.max(0, Math.trunc(run.currentRung)), run.rungs.length - 1),
    };
  }

  const originalCurrent = Math.min(Math.max(0, Math.trunc(run.currentRung)), run.rungs.length - 1);
  // Count retained challengers through the old cursor. If the current legacy
  // rung was removed, this lands on the next valid challenger when one exists.
  const retainedThroughCurrent = sanitizeArcadeRunRungs(
    run.player,
    run.rungs.slice(0, originalCurrent + 1),
  ).length;
  const oldCurrentRung = run.rungs[originalCurrent];
  const currentWasRetained = sanitizedRungs.includes(oldCurrentRung);
  const migratedCursor = currentWasRetained
    ? retainedThroughCurrent - 1
    : retainedThroughCurrent;
  const currentRung = Math.min(Math.max(0, migratedCursor), sanitizedRungs.length - 1);
  return { ...run, rungs: sanitizedRungs, currentRung };
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
    const normalized = normalizeStoredRun(parsed);
    if (!normalized) {
      window.sessionStorage.removeItem(ARCADE_RUN_STORAGE_KEY);
      return null;
    }
    if (
      normalized.rungs.length !== parsed.rungs.length
      || normalized.currentRung !== parsed.currentRung
    ) {
      window.sessionStorage.setItem(ARCADE_RUN_STORAGE_KEY, JSON.stringify(normalized));
    }
    return normalized;
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
