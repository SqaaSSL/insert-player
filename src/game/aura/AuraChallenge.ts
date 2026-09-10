import battleSource from './AuraBattle.ts?raw';
import chartSource from './AuraChart.ts?raw';
import configSource from './AuraConfig.ts?raw';
import rngSource from '../utils/SeededRng.ts?raw';
import clockSource from './AuraMusicClock.ts?raw';
import performanceSource from './AuraPerformance.ts?raw';
import { AuraBattle } from './AuraBattle.ts';
import { createAuraChart } from './AuraChart.ts';
import { getAuraTrack } from './AuraTracks.ts';
import type { AuraDifficultyId } from './AuraConfig.ts';
import { AURA_CHALLENGE_ASSETS } from './AuraChallengeAssets.ts';
import { STAGE_THEMES, type StageThemeId } from '../match/StageConfig.ts';
import type { MatchSceneData } from '../match/MatchConfig.ts';

export const AURA_CHALLENGE_VERSION = 1;
export const AURA_CHALLENGE_MAX_TOKEN_LENGTH = 2_048;
export const AURA_CHALLENGE_MAX_NAME_LENGTH = 32;

/** Compatibility checksum, NOT a signature or score verification. Source-based
 * revisioning deliberately rejects links after even conservative rules edits.
 * A seed alone cannot guarantee the same chart in a future release. */
function fingerprint(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < value.length; i += 1) {
    a = Math.imul(a ^ value.charCodeAt(i), 0x01000193);
    b = Math.imul(b ^ value.charCodeAt(i), 0x85ebca6b);
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

export const AURA_CHALLENGE_RULES = `aura-1-${fingerprint([battleSource, chartSource, configSource, rngSource, clockSource, performanceSource].join('\n'))}`;

export interface AuraChallengeRoutine {
  version: typeof AURA_CHALLENGE_VERSION;
  rules: string;
  seed: number;
  difficulty: AuraDifficultyId;
  trackId: string;
  trackVersion: string;
  stageId: StageThemeId;
  stageVersion: string;
  chartId: string;
}

/** Only information the sender explicitly chooses to put in a public link.
 * The score is a social claim. It never authorizes ranked or account writes. */
export interface AuraChallenge extends AuraChallengeRoutine {
  name: string;
  score: number;
  slot: 0 | 1;
}

type ChallengeError = 'invalid' | 'incompatible';
export type AuraChallengeResult = { ok: true; challenge: AuraChallenge }
  | { ok: false; error: ChallengeError };
const ROUTINE_KEYS = ['version', 'rules', 'seed', 'difficulty', 'trackId', 'trackVersion', 'stageId', 'stageVersion', 'chartId'] as const;
const CHALLENGE_KEYS = [...ROUTINE_KEYS, 'name', 'score', 'slot'];

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function cleanAuraChallengeName(value: string): string {
  const cleaned = value.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return Array.from(cleaned).filter(char => {
    const point = char.codePointAt(0)!;
    return point < 0xd800 || point > 0xdfff;
  }).slice(0, AURA_CHALLENGE_MAX_NAME_LENGTH).join('');
}

export function createAuraChallengeRoutine(
  seed: number,
  difficulty: AuraDifficultyId,
  trackId: string,
  stageId: StageThemeId,
): AuraChallengeRoutine | null {
  if (!Number.isInteger(seed) || seed < 1 || seed > 0xffff_ffff
    || !['lowkey', 'viral', 'untouchable'].includes(difficulty)
    || typeof trackId !== 'string' || trackId.length > 64
    || typeof stageId !== 'string' || stageId.length > 64) return null;
  const track = getAuraTrack(trackId);
  const trackAsset = AURA_CHALLENGE_ASSETS[`track:${trackId}`];
  const stageAsset = AURA_CHALLENGE_ASSETS[`stage:${stageId}`];
  const stage = STAGE_THEMES.find((entry) => entry.id === stageId);
  if (!track || !trackAsset || track.url !== trackAsset.url || !stageAsset || stage?.assetPath !== stageAsset.url) return null;
  const chart = createAuraChart(seed, difficulty, track);
  return {
    version: AURA_CHALLENGE_VERSION, rules: AURA_CHALLENGE_RULES,
    seed, difficulty, trackId, trackVersion: trackAsset.sha256,
    stageId, stageVersion: stageAsset.sha256,
    chartId: fingerprint(JSON.stringify(chart)),
  };
}

export function isCompatibleAuraRoutine(value: unknown): value is AuraChallengeRoutine {
  if (!plainObject(value)) return false;
  const current = createAuraChallengeRoutine(value.seed as number, value.difficulty as AuraDifficultyId,
    value.trackId as string, value.stageId as StageThemeId);
  return current !== null && ROUTINE_KEYS.every(key => current[key] === value[key]);
}

export function maxAuraChallengeScore(routine: AuraChallengeRoutine, slot: 0 | 1 = 0): number {
  const track = getAuraTrack(routine.trackId)!;
  const chart = createAuraChart(routine.seed, routine.difficulty, track);
  const battle = new AuraBattle(chart);
  for (const note of chart.notes) if (note.slot === slot) battle.judgeNote(note.id, 'perfect');
  return battle.scoreFor(slot).score;
}

export function validateAuraChallenge(value: unknown): AuraChallengeResult {
  if (!plainObject(value) || Object.keys(value).length !== CHALLENGE_KEYS.length
    || Object.keys(value).some(key => !CHALLENGE_KEYS.includes(key as typeof CHALLENGE_KEYS[number]))
    || typeof value.name !== 'string' || !value.name || value.name !== cleanAuraChallengeName(value.name)
    || (value.slot !== 0 && value.slot !== 1)
    || !Number.isSafeInteger(value.score) || (value.score as number) < 0) return { ok: false, error: 'invalid' };
  if (!isCompatibleAuraRoutine(value)) return { ok: false, error: 'incompatible' };
  if ((value.score as number) > maxAuraChallengeScore(value, value.slot as 0 | 1)) return { ok: false, error: 'invalid' };
  // Build a fresh allowlisted object; never retain unknown input prototypes.
  const routine = createAuraChallengeRoutine(value.seed, value.difficulty, value.trackId, value.stageId)!;
  return { ok: true, challenge: { ...routine, name: value.name as string, score: value.score as number, slot: value.slot as 0 | 1 } };
}

export function createAuraChallenge(routine: AuraChallengeRoutine, name: string, score: number, slot: 0 | 1 = 0): AuraChallenge {
  const result = validateAuraChallenge({ ...routine, name: cleanAuraChallengeName(name), score, slot });
  if (!result.ok) throw new Error('This Aura result cannot be shared as a challenge.');
  return result.challenge;
}

export function encodeAuraChallenge(challenge: AuraChallenge): string {
  const result = validateAuraChallenge(challenge);
  if (!result.ok) throw new Error('Invalid Aura challenge');
  const bytes = new TextEncoder().encode(JSON.stringify(result.challenge));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (token.length > AURA_CHALLENGE_MAX_TOKEN_LENGTH) throw new Error('Aura challenge is too large');
  return token;
}

export function decodeAuraChallenge(token: string | null | undefined): AuraChallengeResult {
  if (!token || token.length > AURA_CHALLENGE_MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return { ok: false, error: 'invalid' };
  }
  try {
    const bytes = Uint8Array.from(atob(token.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return validateAuraChallenge(value);
  } catch { return { ok: false, error: 'invalid' }; }
}

export function auraChallengeUrl(challenge: AuraChallenge, origin: string): string {
  const url = new URL('/challenge', origin);
  url.searchParams.set('challenge', encodeAuraChallenge(challenge));
  return url.toString();
}

/** The recipient's character is local choice, independent of the sender's
 * private asset identity. Built-in performers make a link immediately playable. */
export function buildAuraChallengeMatch(challenge: AuraChallenge): MatchSceneData {
  const result = validateAuraChallenge(challenge);
  if (!result.ok) throw new Error('This Aura challenge is no longer compatible.');
  const safe = result.challenge;
  return {
    gameMode: 'aura', vsAI: true, cpuVsCpu: false,
    p1Name: safe.slot === 0 ? 'NOVA' : 'BYTE', p2Name: safe.slot === 1 ? 'NOVA' : 'BYTE',
    seed: safe.seed, auraDifficulty: safe.difficulty, auraTrackId: safe.trackId,
    stageId: safe.stageId, auraChallenge: safe,
  };
}

export function compareAuraChallenge(challenge: AuraChallenge, score: number): { outcome: 'won' | 'tied' | 'lost'; difference: number } {
  const difference = score - challenge.score;
  return { outcome: difference > 0 ? 'won' : difference === 0 ? 'tied' : 'lost', difference };
}

export function isValidAuraChallengeMatch(data: MatchSceneData): boolean {
  if (!data.auraChallenge) return false;
  const result = validateAuraChallenge(data.auraChallenge);
  if (!result.ok) return false;
  const challenge = result.challenge;
  return data.gameMode === 'aura' && data.vsAI === true && data.cpuVsCpu === false
    && !data.online && !data.customStageKey && !data.customStageLabel
    && data.seed === challenge.seed && data.auraTrackId === challenge.trackId
    && data.auraDifficulty === challenge.difficulty && data.stageId === challenge.stageId;
}
