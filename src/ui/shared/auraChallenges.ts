import { decodeAuraChallenge, encodeAuraChallenge, type AuraChallenge } from '../../game/aura/AuraChallenge.ts';

export const AURA_CHALLENGE_HISTORY_KEY = 'insert-player:aura-challenges:v1';
export const AURA_CHALLENGE_HISTORY_LIMIT = 20;
export interface AuraChallengeHistoryEntry {
  token: string;
  kind: 'created' | 'played';
  updatedAt: number;
  bestScore?: number;
}

function deviceStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

export function readAuraChallenges(storage: Pick<Storage, 'getItem'> | null = deviceStorage()): AuraChallengeHistoryEntry[] {
  try {
    const raw = storage?.getItem(AURA_CHALLENGE_HISTORY_KEY);
    if (!raw || raw.length > 100_000) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.slice(0, AURA_CHALLENGE_HISTORY_LIMIT).filter((entry): entry is AuraChallengeHistoryEntry => (
      entry && typeof entry === 'object' && (entry.kind === 'created' || entry.kind === 'played')
      && Number.isSafeInteger(entry.updatedAt) && entry.updatedAt > 0
      && (entry.bestScore === undefined || (Number.isSafeInteger(entry.bestScore) && entry.bestScore >= 0 && entry.bestScore <= 200_000))
      && typeof entry.token === 'string' && decodeAuraChallenge(entry.token).ok
    )).map(entry => ({ token: entry.token, kind: entry.kind, updatedAt: entry.updatedAt,
      ...(entry.bestScore === undefined ? {} : { bestScore: entry.bestScore }) }));
  } catch { return []; }
}

/** Device-only convenience, with the same allowlisted public payload as the
 * link. Storage denial never prevents playing, sharing or finishing a match. */
export function rememberAuraChallenge(
  challenge: AuraChallenge,
  kind: AuraChallengeHistoryEntry['kind'],
  score?: number,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = deviceStorage(),
  now = Date.now(),
): void {
  try {
    const token = encodeAuraChallenge(challenge);
    const current = readAuraChallenges(storage);
    const previous = current.find(entry => entry.token === token);
    const bestScore = Number.isSafeInteger(score) && score! >= 0 && score! <= 200_000
      ? Math.max(previous?.bestScore ?? 0, score!) : previous?.bestScore;
    const entry: AuraChallengeHistoryEntry = { token, kind, updatedAt: now,
      ...(bestScore === undefined ? {} : { bestScore }) };
    storage?.setItem(AURA_CHALLENGE_HISTORY_KEY, JSON.stringify(
      [entry, ...current.filter(item => item.token !== token)].slice(0, AURA_CHALLENGE_HISTORY_LIMIT),
    ));
  } catch { /* A private/blocked browser can still play and share. */ }
}
