import type { Env } from './types';
import { normalizeOptionalHttpsUrl, normalizePublicDisplayName } from './auth';

function normalizedPrivateProfile(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    display_name: normalizePublicDisplayName(row.display_name),
    avatar_url: normalizeOptionalHttpsUrl(row.avatar_url),
  };
}

function publicLeaderboardEntry(row: Record<string, unknown>, index: number): Record<string, unknown> {
  return {
    id: `rank:${index + 1}`,
    display_name: `Player ${index + 1}`,
    avatar_url: null,
    elo_rating: row.elo_rating,
    wins: row.wins,
    losses: row.losses,
    win_streak: row.win_streak,
    best_streak: row.best_streak,
    total_kos: row.total_kos,
    win_rate: row.win_rate,
  };
}

export async function ensureSystemUser(env: Env, id: string, displayName: string): Promise<void> {
  const normalizedDisplayName = normalizePublicDisplayName(displayName);
  await env.DB.prepare(`
    INSERT INTO users (id, display_name, avatar_url, oauth_provider, oauth_id)
    VALUES (?, ?, NULL, 'system', ?)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      updated_at = datetime('now')
  `).bind(id, normalizedDisplayName, id).run();
}

export async function getLeaderboard(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(`
    SELECT
      id,
      display_name,
      avatar_url,
      elo_rating,
      wins,
      losses,
      win_streak,
      best_streak,
      total_kos,
      CASE WHEN (wins + losses) > 0
        THEN ROUND(CAST(wins AS REAL) / (wins + losses) * 100, 1)
        ELSE 0
      END AS win_rate
    FROM users
    WHERE oauth_provider != 'system' AND (wins + losses) > 0
    ORDER BY wins DESC, win_rate DESC, elo_rating DESC, updated_at DESC
    LIMIT 100
  `).all<Record<string, unknown>>();

  return Response.json({
    leaderboard: results.map(publicLeaderboardEntry),
  });
}

export async function getPlayerStats(env: Env, userId: string): Promise<Response> {
  const user = await env.DB.prepare(
    'SELECT id, display_name, avatar_url, elo_rating, wins, losses, win_streak, best_streak, total_kos, created_at FROM users WHERE id = ?'
  ).bind(userId).first<Record<string, unknown>>();

  if (!user) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  const { results: recentMatches } = await env.DB.prepare(`
    SELECT m.*, 
      u1.display_name as p1_name, 
      u2.display_name as p2_name
    FROM matches m
    JOIN users u1 ON m.player1_id = u1.id
    JOIN users u2 ON m.player2_id = u2.id
    WHERE m.player1_id = ? OR m.player2_id = ?
    ORDER BY m.created_at DESC
    LIMIT 20
  `).bind(userId, userId).all<Record<string, unknown>>();

  return Response.json({
    player: normalizedPrivateProfile(user),
    recentMatches: recentMatches.map((match) => ({
      ...match,
      p1_name: normalizePublicDisplayName(match.p1_name),
      p2_name: normalizePublicDisplayName(match.p2_name),
    })),
  });
}

const K_FACTOR_NEW = 40;
const K_FACTOR_DEFAULT = 20;
const GAMES_THRESHOLD = 30;

async function updateUnrankedRecord(env: Env, winnerId: string, loserId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE users SET wins = wins + 1, win_streak = win_streak + 1, best_streak = MAX(best_streak, win_streak + 1), updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(winnerId),
    env.DB.prepare(
      'UPDATE users SET losses = losses + 1, win_streak = 0, updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(loserId),
  ]);
}

export function calculateElo(
  winnerRating: number,
  loserRating: number,
  winnerGames: number,
  loserGames: number
): { winnerNew: number; loserNew: number } {
  const kWinner = winnerGames < GAMES_THRESHOLD ? K_FACTOR_NEW : K_FACTOR_DEFAULT;
  const kLoser = loserGames < GAMES_THRESHOLD ? K_FACTOR_NEW : K_FACTOR_DEFAULT;

  const expectedWinner = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
  const expectedLoser = 1 - expectedWinner;

  return {
    winnerNew: Math.round(winnerRating + kWinner * (1 - expectedWinner)),
    loserNew: Math.round(loserRating + kLoser * (0 - expectedLoser)),
  };
}

export async function reportMatchResult(
  env: Env,
  data: {
    matchId: string;
    player1Id: string;
    player2Id: string;
    winnerId: string;
    roundsP1: number;
    roundsP2: number;
    duration: number;
    p1CharId?: string;
    p2CharId?: string;
    p1FighterId?: string;
    p2FighterId?: string;
    isRanked: boolean;
  }
): Promise<Response> {
  const { matchId, player1Id, player2Id, winnerId, roundsP1, roundsP2, duration, p1CharId, p2CharId, p1FighterId, p2FighterId, isRanked } = data;

  await env.DB.prepare(`
    INSERT INTO matches (id, player1_id, player2_id, winner_id, rounds_won_p1, rounds_won_p2, duration_seconds, p1_character_id, p2_character_id, p1_fighter_id, p2_fighter_id, is_ranked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(matchId, player1Id, player2Id, winnerId, roundsP1, roundsP2, duration, p1CharId ?? null, p2CharId ?? null, p1FighterId ?? null, p2FighterId ?? null, isRanked ? 1 : 0).run();

  if (isRanked) {
    const winner = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(winnerId).first<any>();
    const loserId = winnerId === player1Id ? player2Id : player1Id;
    const loser = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(loserId).first<any>();

    if (winner && loser) {
      const { winnerNew, loserNew } = calculateElo(
        winner.elo_rating, loser.elo_rating,
        winner.wins + winner.losses, loser.wins + loser.losses
      );

      await env.DB.batch([
        env.DB.prepare(
          'UPDATE users SET elo_rating = ?, wins = wins + 1, win_streak = win_streak + 1, best_streak = MAX(best_streak, win_streak + 1), updated_at = datetime(\'now\') WHERE id = ?'
        ).bind(winnerNew, winnerId),
        env.DB.prepare(
          'UPDATE users SET elo_rating = ?, losses = losses + 1, win_streak = 0, updated_at = datetime(\'now\') WHERE id = ?'
        ).bind(loserNew, loserId),
      ]);
    }
  } else {
    const loserId = winnerId === player1Id ? player2Id : player1Id;
    await updateUnrankedRecord(env, winnerId, loserId);
  }

  return Response.json({ success: true });
}
