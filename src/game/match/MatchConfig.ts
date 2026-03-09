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
  p1Name?: string;
  p2Name?: string;
  p1PersonalityId?: FighterPersonalityId;
  p2PersonalityId?: FighterPersonalityId;
  stageId?: StageThemeId;
  remix?: number;
}

export const FIGHTER_PERSONALITIES: FighterPersonality[] = [
  {
    id: 'balanced',
    label: 'BALANCED',
    blurb: 'Steady reads and low-risk pressure.',
    aggression: 0.52,
    patience: 0.55,
    flair: 0.35,
    zoning: 0.4,
    reversal: 0.45,
    tempo: 0.5,
  },
  {
    id: 'brawler',
    label: 'BRAWLER',
    blurb: 'Walks forward and tries to overwhelm.',
    aggression: 0.92,
    patience: 0.2,
    flair: 0.35,
    zoning: 0.1,
    reversal: 0.25,
    tempo: 0.88,
  },
  {
    id: 'counter',
    label: 'COUNTER',
    blurb: 'Blocks, baits, and punishes hard.',
    aggression: 0.42,
    patience: 0.88,
    flair: 0.12,
    zoning: 0.3,
    reversal: 0.92,
    tempo: 0.32,
  },
  {
    id: 'zoner',
    label: 'ZONER',
    blurb: 'Keeps space and wins with timing.',
    aggression: 0.3,
    patience: 0.76,
    flair: 0.22,
    zoning: 0.96,
    reversal: 0.42,
    tempo: 0.4,
  },
  {
    id: 'showboat',
    label: 'SHOWBOAT',
    blurb: 'Jump-ins, risky swings, big moments.',
    aggression: 0.72,
    patience: 0.22,
    flair: 0.98,
    zoning: 0.22,
    reversal: 0.25,
    tempo: 0.72,
  },
];

export function getFighterPersonality(id?: FighterPersonalityId | null): FighterPersonality {
  return FIGHTER_PERSONALITIES.find((entry) => entry.id === id) ?? FIGHTER_PERSONALITIES[0];
}

export function getDefaultPersonalityId(slotIndex: number): FighterPersonalityId {
  return slotIndex === 0 ? 'brawler' : 'counter';
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
    data.stageId ?? 'auto',
    String(remix),
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
