import type { StageThemeId } from './StageConfig.ts';

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
}

export const MATCH_COMPLETE_EVENT = 'asf-match-complete';
export const MATCH_ACTION_EVENT = 'asf-match-action';
export const MATCH_ACTIONS_VISIBILITY_EVENT = 'asf-match-actions-visibility';
export const HUD_STATE_EVENT = 'asf-hud-state';
export const ANNOUNCE_EVENT = 'asf-announce';
export const INTRO_STATE_EVENT = 'asf-intro';

export type MatchAction = 'run_it_back' | 'remix' | 'menu';

export interface MatchCompletionDetail {
  winnerSlot: 'p1' | 'p2';
  roundsP1: number;
  roundsP2: number;
  durationSeconds: number;
  vsAI: boolean;
  cpuVsCpu: boolean;
  p1FighterId?: string | null;
  p2FighterId?: string | null;
  isRanked?: boolean;
}

export interface MatchActionDetail {
  action: MatchAction;
}

export interface MatchActionsVisibilityDetail {
  visible: boolean;
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

export function buildMatchSeed(data: MatchSceneData): number {
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
