import { apiFetch } from './ApiClient';

export interface LeaderboardEntry {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  eloRating: number;
  wins: number;
  losses: number;
  winStreak: number;
  bestStreak: number;
  totalKos: number;
  winRate: number;
}

export interface RecentMatch {
  id: string;
  player1Id: string;
  player2Id: string;
  winnerId: string | null;
  player1Name: string;
  player2Name: string;
  roundsWonP1: number;
  roundsWonP2: number;
  durationSeconds: number;
  createdAt: string;
  isRanked: boolean;
}

export interface PlayerStats {
  player: LeaderboardEntry & { createdAt: string };
  recentMatches: RecentMatch[];
}

interface RawLeaderboardEntry {
  id?: string;
  display_name?: string;
  avatar_url?: string | null;
  elo_rating?: number;
  wins?: number;
  losses?: number;
  win_streak?: number;
  best_streak?: number;
  total_kos?: number;
  win_rate?: number;
  created_at?: string;
}

interface RawRecentMatch {
  id?: string;
  player1_id?: string;
  player2_id?: string;
  winner_id?: string | null;
  p1_name?: string;
  p2_name?: string;
  rounds_won_p1?: number;
  rounds_won_p2?: number;
  duration_seconds?: number;
  created_at?: string;
  is_ranked?: number;
}

function isLocalDevWithoutApi(): boolean {
  return !String(import.meta.env.VITE_API_BASE_URL ?? '').trim() && import.meta.env.DEV;
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeEntry(raw: RawLeaderboardEntry): LeaderboardEntry {
  const wins = numberValue(raw.wins);
  const losses = numberValue(raw.losses);
  const winRate = raw.win_rate === undefined
    ? (wins + losses > 0 ? Math.round((wins / (wins + losses)) * 1000) / 10 : 0)
    : numberValue(raw.win_rate);
  return {
    id: String(raw.id ?? ''),
    displayName: String(raw.display_name ?? 'Player'),
    avatarUrl: raw.avatar_url ?? null,
    eloRating: numberValue(raw.elo_rating),
    wins,
    losses,
    winStreak: numberValue(raw.win_streak),
    bestStreak: numberValue(raw.best_streak),
    totalKos: numberValue(raw.total_kos),
    winRate,
  };
}

function normalizeMatch(raw: RawRecentMatch): RecentMatch {
  return {
    id: String(raw.id ?? ''),
    player1Id: String(raw.player1_id ?? ''),
    player2Id: String(raw.player2_id ?? ''),
    winnerId: raw.winner_id ?? null,
    player1Name: String(raw.p1_name ?? 'Player 1'),
    player2Name: String(raw.p2_name ?? 'Player 2'),
    roundsWonP1: numberValue(raw.rounds_won_p1),
    roundsWonP2: numberValue(raw.rounds_won_p2),
    durationSeconds: numberValue(raw.duration_seconds),
    createdAt: String(raw.created_at ?? ''),
    isRanked: raw.is_ranked === 1,
  };
}

export async function getLeaderboard(limit = 5): Promise<LeaderboardEntry[]> {
  if (isLocalDevWithoutApi()) return [];

  try {
    const res = await apiFetch('/api/leaderboard');
    if (!res.ok) return [];
    const json = await res.json() as { leaderboard?: RawLeaderboardEntry[] };
    return (json.leaderboard ?? []).map(normalizeEntry).filter((entry) => entry.id).slice(0, limit);
  } catch {
    return [];
  }
}

export async function getMyStats(): Promise<PlayerStats | null> {
  if (isLocalDevWithoutApi()) return null;

  try {
    const res = await apiFetch('/api/stats');
    if (res.status === 401 || res.status === 503) return null;
    if (!res.ok) return null;
    const json = await res.json() as {
      player?: RawLeaderboardEntry;
      recentMatches?: RawRecentMatch[];
    };
    if (!json.player?.id) return null;
    return {
      player: {
        ...normalizeEntry(json.player),
        createdAt: String(json.player.created_at ?? ''),
      },
      recentMatches: (json.recentMatches ?? []).map(normalizeMatch).filter((match) => match.id),
    };
  } catch {
    return null;
  }
}
