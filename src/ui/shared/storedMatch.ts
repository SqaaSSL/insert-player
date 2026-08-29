import {
  FIGHTER_PERSONALITIES,
  isValidMatchSeed,
  type FighterPersonalityId,
  type MatchSceneData,
} from '../../game/match/MatchConfig.ts';
import { STAGE_THEMES, type StageThemeId } from '../../game/match/StageConfig.ts';

const STORAGE_PREFIX = 'ai-street-fighter:last-match:v1:';
const LEGACY_STORAGE_KEY = 'ai-street-fighter:last-match';
const STORED_MATCH_VERSION = 1;
export const STORED_MATCH_TTL_MS = 6 * 60 * 60_000;

interface StoredMatchEnvelope {
  version: typeof STORED_MATCH_VERSION;
  authSessionKey: string;
  createdAt: number;
  data: MatchSceneData;
}

const personalityIds = new Set<FighterPersonalityId>(
  FIGHTER_PERSONALITIES.map((personality) => personality.id),
);
const stageIds = new Set<StageThemeId>(STAGE_THEMES.map((stage) => stage.id));

function validSessionKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function optionalText(value: unknown, maxLength: number): value is string | null | undefined {
  return value === undefined || value === null || (
    typeof value === 'string' && value.length > 0 && value.length <= maxLength
  );
}

export function storedMatchStorageKey(authSessionKey: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(authSessionKey)}`;
}

export function isValidStoredMatchData(value: unknown): value is MatchSceneData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (typeof data.vsAI !== 'boolean' || typeof data.cpuVsCpu !== 'boolean') return false;
  if (!optionalText(data.p1PhotoHash, 160) || !optionalText(data.p2PhotoHash, 160)) return false;
  if (!optionalText(data.p1CloudFighterId, 160) || !optionalText(data.p2CloudFighterId, 160)) return false;
  if (!optionalText(data.p1Name, 120) || !optionalText(data.p2Name, 120)) return false;
  if (!data.p1PhotoHash && !data.p1Name) return false;
  if (!data.p2PhotoHash && !data.p2Name) return false;
  if (data.p1PersonalityId !== undefined && !personalityIds.has(data.p1PersonalityId as FighterPersonalityId)) {
    return false;
  }
  if (data.p2PersonalityId !== undefined && !personalityIds.has(data.p2PersonalityId as FighterPersonalityId)) {
    return false;
  }
  if (data.stageId !== undefined && !stageIds.has(data.stageId as StageThemeId)) return false;
  if (!optionalText(data.customStageKey, 256) || !optionalText(data.customStageLabel, 120)) return false;
  if (data.remix !== undefined && (
    typeof data.remix !== 'number'
    || !Number.isSafeInteger(data.remix)
    || data.remix < 0
    || data.remix > 1_000
  )) return false;
  if (data.seed !== undefined && !isValidMatchSeed(data.seed)) return false;
  if (data.online !== undefined) {
    const online = data.online as Record<string, unknown> | null;
    if (!online || typeof online !== 'object') return false;
    if (typeof online.roomCode !== 'string' || !/^[A-Z2-9]{6}$/.test(online.roomCode)) return false;
    if (online.localSlot !== 0 && online.localSlot !== 1) return false;
    if (!Number.isSafeInteger(online.matchSerial) || (online.matchSerial as number) < 1) return false;
    if (!Number.isSafeInteger(online.inputDelay) || (online.inputDelay as number) < 0 || (online.inputDelay as number) > 10) return false;
  }
  return true;
}

export function parseStoredMatch(
  raw: string,
  authSessionKey: string,
  now = Date.now(),
): MatchSceneData | null {
  if (!validSessionKey(authSessionKey)) return null;
  try {
    const envelope = JSON.parse(raw) as Partial<StoredMatchEnvelope>;
    if (
      envelope.version !== STORED_MATCH_VERSION
      || envelope.authSessionKey !== authSessionKey
      || typeof envelope.createdAt !== 'number'
      || now - envelope.createdAt < -60_000
      || now - envelope.createdAt > STORED_MATCH_TTL_MS
      || !isValidStoredMatchData(envelope.data)
    ) {
      return null;
    }
    return envelope.data;
  } catch {
    return null;
  }
}

function browserSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStoredMatch(
  authSessionKey: string,
  storage: Storage | null = browserSessionStorage(),
  now = Date.now(),
): MatchSceneData | null {
  if (!storage || !validSessionKey(authSessionKey)) return null;
  try {
    storage.removeItem(LEGACY_STORAGE_KEY);
    const key = storedMatchStorageKey(authSessionKey);
    const raw = storage.getItem(key);
    if (!raw) return null;
    const match = parseStoredMatch(raw, authSessionKey, now);
    if (!match) storage.removeItem(key);
    return match;
  } catch {
    return null;
  }
}

export function writeStoredMatch(
  data: MatchSceneData | null,
  authSessionKey: string,
  storage: Storage | null = browserSessionStorage(),
  now = Date.now(),
): boolean {
  if (!storage || !validSessionKey(authSessionKey)) return false;
  const key = storedMatchStorageKey(authSessionKey);
  try {
    storage.removeItem(LEGACY_STORAGE_KEY);
    if (!data) {
      storage.removeItem(key);
      return true;
    }
    if (!isValidStoredMatchData(data)) return false;
    const envelope: StoredMatchEnvelope = {
      version: STORED_MATCH_VERSION,
      authSessionKey,
      createdAt: now,
      data,
    };
    storage.setItem(key, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}
