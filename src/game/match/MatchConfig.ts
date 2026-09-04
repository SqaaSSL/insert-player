import type { StageThemeId } from './StageConfig.ts';
import type { RushRunRank } from '../brawl/RushRunScore.ts';
import type { RushCompanionOrder, RushDifficultyId } from '../brawl/RushConfig.ts';
import type { AuraDifficultyId } from '../aura/AuraConfig.ts';
import type { AuraLane } from '../aura/AuraChart.ts';
import type { AuraPlayerScore } from '../aura/AuraBattle.ts';
import { ROUNDS_TO_WIN } from '../constants.ts';

export type MatchExperience = 'standard' | 'trial';

export const MIN_MATCH_ROUNDS_TO_WIN = 1;
export const MAX_MATCH_ROUNDS_TO_WIN = 5;

export function isValidMatchExperience(value: unknown): value is MatchExperience {
  return value === 'standard' || value === 'trial';
}

export function isValidMatchRoundsToWin(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_MATCH_ROUNDS_TO_WIN &&
    value <= MAX_MATCH_ROUNDS_TO_WIN
  );
}

export function resolveMatchRoundsToWin(
  value: unknown,
  fallback = ROUNDS_TO_WIN,
): number {
  if (isValidMatchRoundsToWin(value)) return value;
  return isValidMatchRoundsToWin(fallback) ? fallback : ROUNDS_TO_WIN;
}

export type FighterPersonalityId =
  | 'balanced'
  | 'brawler'
  | 'counter'
  | 'zoner'
  | 'showboat';

export interface FighterPersonality {
  id: FighterPersonalityId;
  label: string;
  blurb: string;
  aggression: number;
  patience: number;
  flair: number;
  zoning: number;
  reversal: number;
  tempo: number;
}

export interface MatchSceneData {
  /** Product context for this match. Omitted means a normal, reportable match. */
  experience?: MatchExperience;
  /** Number of round wins needed. Omitted preserves the normal best-of-three match. */
  roundsToWin?: number;
  /** Both modes share the cabinet, roster, fighters, and visual identity. */
  gameMode?: 'fight' | 'rush' | 'aura';
  vsAI?: boolean;
  cpuVsCpu?: boolean;
  p1PhotoHash?: string;
  p2PhotoHash?: string;
  p1CloudFighterId?: string | null;
  p2CloudFighterId?: string | null;
  p1Name?: string;
  p2Name?: string;
  p1PersonalityId?: FighterPersonalityId;
  p2PersonalityId?: FighterPersonalityId;
  stageId?: StageThemeId;
  customStageKey?: string;
  customStageLabel?: string;
  remix?: number;
  /** Arcade-ladder AI strength for the P2 CPU, 0..1. Omitted = full strength. */
  p2Difficulty?: number;
  /** Shared Rush ruleset tuning. It never changes fighter-generation assets. */
  rushDifficulty?: RushDifficultyId;
  /** Live tactical posture for the local CPU partner. */
  rushCompanionOrder?: RushCompanionOrder;
  /** Rhythm density, timing windows, and CPU precision for Aura Battle. */
  auraDifficulty?: AuraDifficultyId;
  /**
   * Explicit simulation seed (uint32). When present it wins over the derived
   * match-identity hash, so two machines can agree on one seed for netplay
   * or replays regardless of local cache identities.
   */
  seed?: number;
  /** Present for an online versus match; the live transport is in `onlineSession.ts`. */
  online?: OnlineMatchInfo;
}

export type MatchRestartFormat = Pick<MatchSceneData, 'experience' | 'roundsToWin'>;

/** Preserve only explicit, valid format overrides when Phaser restarts a match. */
export function matchRestartFormat(data: MatchRestartFormat): MatchRestartFormat {
  return {
    ...(isValidMatchExperience(data.experience) ? { experience: data.experience } : {}),
    ...(isValidMatchRoundsToWin(data.roundsToWin) ? { roundsToWin: data.roundsToWin } : {}),
  };
}

/**
 * Trial results use React-owned calls to action. Let Enter and Space reach the
 * focused DOM button instead of having Phaser prevent their browser defaults.
 */
export function shouldCaptureMatchIntroKeys(experience: MatchExperience): boolean {
  return experience !== 'trial';
}

export interface OnlineMatchInfo {
  roomCode: string;
  /** Fighter slot the local player controls: 0 = host / P1, 1 = guest / P2. */
  localSlot: 0 | 1;
  /** Room match serial allocated by the host; makes result reports idempotent. */
  matchSerial: number;
  inputDelay: number;
}

export const MATCH_COMPLETE_EVENT = 'asf-match-complete';
export const MATCH_ACTION_EVENT = 'asf-match-action';
export const MATCH_ACTIONS_VISIBILITY_EVENT = 'asf-match-actions-visibility';
export const HUD_STATE_EVENT = 'asf-hud-state';
export const ANNOUNCE_EVENT = 'asf-announce';
export const INTRO_STATE_EVENT = 'asf-intro';
export const PAUSE_EVENT = 'asf-pause';
export const NET_STATE_EVENT = 'asf-net-state';
export const RUNTIME_READY_EVENT = 'asf-runtime-ready';
export const RUSH_RUN_COMPLETE_EVENT = 'asf-rush-run-complete';
export const RUSH_COMPANION_ORDER_EVENT = 'asf-rush-companion-order';
export const AURA_INPUT_EVENT = 'asf-aura-input';
export const AURA_BATTLE_COMPLETE_EVENT = 'asf-aura-battle-complete';
export const ONLINE_REMATCH_STATE_EVENT = 'asf-online-rematch-state';

export type MatchAction = 'run_it_back' | 'remix' | 'menu';

export interface MatchCompletionDetail {
  /** Trial completions are intentionally excluded from player history and W/L. */
  experience?: MatchExperience;
  winnerSlot: 'p1' | 'p2';
  roundsP1: number;
  roundsP2: number;
  durationSeconds: number;
  vsAI: boolean;
  cpuVsCpu: boolean;
  p1FighterId?: string | null;
  p2FighterId?: string | null;
  isRanked?: boolean;
  online?: OnlineMatchInfo;
}

export interface MatchActionDetail {
  action: MatchAction;
}

export interface MatchActionsVisibilityDetail {
  visible: boolean;
  /** Online actions require the live mutual-ready handshake. */
  online?: boolean;
}

export interface RuntimeReadyDetail {
  sceneKey: 'FightScene' | 'RushScene' | 'AuraScene';
  matchSeed?: number;
}

export interface RushRunCompleteDetail {
  outcome: 'won' | 'lost';
  stageId: StageThemeId;
  stageLabel: string;
  durationSeconds: number;
  score: number;
  rank: RushRunRank;
  enemiesDefeated: number;
  obstaclesDestroyed: number;
  checkpointsCleared: number;
  revives: number;
  damageTaken: number;
  teamHealthRemaining: number;
  teamMaxHealth: number;
  difficulty: RushDifficultyId;
}

export interface RushCompanionOrderDetail {
  order: RushCompanionOrder;
}

export interface AuraInputDetail {
  lane: AuraLane;
  playerIndex: 0 | 1;
}

export interface AuraBattleCompleteDetail {
  winnerSlot: 'p1' | 'p2' | 'draw';
  p1Name: string;
  p2Name: string;
  p1Score: AuraPlayerScore;
  p2Score: AuraPlayerScore;
  p1Rank: 'S' | 'A' | 'B' | 'C' | 'NPC';
  p2Rank: 'S' | 'A' | 'B' | 'C' | 'NPC';
  durationSeconds: number;
  difficulty: AuraDifficultyId;
  stageId: StageThemeId;
  stageLabel: string;
  online?: OnlineMatchInfo;
}

export interface OnlineRematchStateDetail {
  state: 'idle' | 'rival_ready' | 'waiting' | 'starting' | 'error';
  message?: string;
}

/** Netcode telemetry for the React overlay during an online match. */
export interface NetStateDetail {
  connected: boolean;
  peerPresent: boolean;
  path: 'none' | 'p2p' | 'relay';
  rttMs: number | null;
  rollbacks: number;
  stalled: boolean;
  desynced: boolean;
  /** Set when the opponent left; the match cannot continue. */
  abandoned: boolean;
}

/** Fight HUD snapshot for the React chrome; dispatched only when it changes. */
export interface HudStateDetail {
  visible: boolean;
  p1Health: number;
  p2Health: number;
  maxHealth: number;
  p1Meter: number;
  p2Meter: number;
  meterMax: number;
  timer: number;
  p1Wins: number;
  p2Wins: number;
  roundsToWin: number;
  p1Name: string;
  p2Name: string;
  p1Tag: string | null;
  p2Tag: string | null;
  p1PhotoHash: string | null;
  p2PhotoHash: string | null;
  matchLabel: string;
}

export interface PauseDetail {
  paused: boolean;
}

export type AnnounceKind = 'round' | 'fight' | 'ko' | 'double_ko' | 'draw' | 'wins';

export interface AnnounceDetail {
  kind: AnnounceKind;
  roundNumber?: number;
  winnerName?: string;
}

/** Versus-screen ("cortinilla") state for the React intro overlay. */
export interface IntroStateDetail {
  visible: boolean;
  p1Name: string;
  p2Name: string;
  p1Tag: string | null;
  p2Tag: string | null;
  p1PhotoHash: string | null;
  p2PhotoHash: string | null;
  stageLabel: string;
  matchLabel: string;
  roundNumber: number;
}

declare global {
  interface WindowEventMap {
    [MATCH_COMPLETE_EVENT]: CustomEvent<MatchCompletionDetail>;
    [MATCH_ACTION_EVENT]: CustomEvent<MatchActionDetail>;
    [MATCH_ACTIONS_VISIBILITY_EVENT]: CustomEvent<MatchActionsVisibilityDetail>;
    [HUD_STATE_EVENT]: CustomEvent<HudStateDetail>;
    [ANNOUNCE_EVENT]: CustomEvent<AnnounceDetail>;
    [INTRO_STATE_EVENT]: CustomEvent<IntroStateDetail>;
    [NET_STATE_EVENT]: CustomEvent<NetStateDetail>;
    [RUNTIME_READY_EVENT]: CustomEvent<RuntimeReadyDetail>;
    [RUSH_RUN_COMPLETE_EVENT]: CustomEvent<RushRunCompleteDetail>;
    [RUSH_COMPANION_ORDER_EVENT]: CustomEvent<RushCompanionOrderDetail>;
    [AURA_INPUT_EVENT]: CustomEvent<AuraInputDetail>;
    [AURA_BATTLE_COMPLETE_EVENT]: CustomEvent<AuraBattleCompleteDetail>;
    [ONLINE_REMATCH_STATE_EVENT]: CustomEvent<OnlineRematchStateDetail>;
    [PAUSE_EVENT]: CustomEvent<PauseDetail>;
  }
}

export const FIGHTER_PERSONALITIES: FighterPersonality[] = [
  {
    id: 'balanced',
    label: 'BALANCED',
    blurb: 'Steady reads and low-risk pressure.',
    aggression: 0.5,
    patience: 0.58,
    flair: 0.32,
    zoning: 0.45,
    reversal: 0.48,
    tempo: 0.5,
  },
  {
    id: 'brawler',
    label: 'BRAWLER',
    blurb: 'Walks forward and tries to overwhelm.',
    aggression: 0.78,
    patience: 0.28,
    flair: 0.32,
    zoning: 0.08,
    reversal: 0.22,
    tempo: 0.72,
  },
  {
    id: 'counter',
    label: 'COUNTER',
    blurb: 'Blocks, baits, and punishes hard.',
    aggression: 0.5,
    patience: 0.82,
    flair: 0.12,
    zoning: 0.28,
    reversal: 0.86,
    tempo: 0.44,
  },
  {
    id: 'zoner',
    label: 'ZONER',
    blurb: 'Keeps space and wins with timing.',
    aggression: 0.36,
    patience: 0.74,
    flair: 0.2,
    zoning: 0.92,
    reversal: 0.46,
    tempo: 0.48,
  },
  {
    id: 'showboat',
    label: 'SHOWBOAT',
    blurb: 'Jump-ins, risky swings, big moments.',
    aggression: 0.68,
    patience: 0.22,
    flair: 0.95,
    zoning: 0.18,
    reversal: 0.24,
    tempo: 0.68,
  },
];

export function getFighterPersonality(id?: FighterPersonalityId | null): FighterPersonality {
  return FIGHTER_PERSONALITIES.find((entry) => entry.id === id) ?? FIGHTER_PERSONALITIES[0];
}

export function getDefaultPersonalityId(slotIndex: number): FighterPersonalityId {
  return slotIndex === 0 ? 'balanced' : 'balanced';
}

export function nextFighterPersonalityId(current: FighterPersonalityId): FighterPersonalityId {
  const idx = FIGHTER_PERSONALITIES.findIndex((entry) => entry.id === current);
  const nextIdx = idx >= 0 ? (idx + 1) % FIGHTER_PERSONALITIES.length : 0;
  return FIGHTER_PERSONALITIES[nextIdx].id;
}

export function isValidMatchSeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

export function buildMatchSeed(data: MatchSceneData): number {
  if (isValidMatchSeed(data.seed)) {
    return data.seed === 0 ? 0x13579bdf : data.seed;
  }
  const remix = data.remix ?? 0;
  const parts = [
    'cinematic-match-v1',
    data.vsAI ? '1' : '0',
    data.cpuVsCpu ? '1' : '0',
    data.p1PhotoHash ?? data.p1Name ?? 'p1',
    data.p2PhotoHash ?? data.p2Name ?? 'p2',
    data.p1PersonalityId ?? getDefaultPersonalityId(0),
    data.p2PersonalityId ?? getDefaultPersonalityId(1),
    data.customStageKey ? 'photo-stage' : (data.stageId ?? 'auto'),
    data.customStageKey ?? 'stage:none',
    String(remix),
    data.p2Difficulty === undefined ? 'difficulty:default' : `difficulty:${data.p2Difficulty}`,
  ];
  if (data.gameMode === 'aura') {
    parts.push('game-mode:aura');
    parts.push(data.auraDifficulty === undefined
      ? 'aura-difficulty:default'
      : `aura-difficulty:${data.auraDifficulty}`);
  }
  if (data.experience !== undefined) parts.push(`experience:${data.experience}`);
  if (data.roundsToWin !== undefined) parts.push(`rounds-to-win:${data.roundsToWin}`);

  let hash = 0x811c9dc5;
  const text = parts.join('|');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  const normalized = hash >>> 0;
  return normalized === 0 ? 0x13579bdf : normalized;
}

export function getMatchLabel(remix = 0): string {
  return remix > 0 ? `REMIX ${remix}` : 'SIGNATURE MATCH';
}
