-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  oauth_provider TEXT NOT NULL,
  oauth_id TEXT NOT NULL,
  elo_rating INTEGER NOT NULL DEFAULT 1200,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  win_streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  total_kos INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(oauth_provider, oauth_id)
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Characters table (cached sprite data per uploaded photo)
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Fighter',
  photo_hash TEXT NOT NULL,
  sprite_r2_key TEXT,
  intro_r2_key TEXT,
  side_view_r2_key TEXT,
  sprite_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, photo_hash)
);

CREATE INDEX IF NOT EXISTS idx_characters_user ON characters(user_id);
CREATE INDEX IF NOT EXISTS idx_characters_hash ON characters(photo_hash);

-- Matches table
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  player1_id TEXT NOT NULL REFERENCES users(id),
  player2_id TEXT NOT NULL REFERENCES users(id),
  winner_id TEXT REFERENCES users(id),
  p1_character_id TEXT REFERENCES characters(id),
  p2_character_id TEXT REFERENCES characters(id),
  rounds_won_p1 INTEGER NOT NULL DEFAULT 0,
  rounds_won_p2 INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER,
  is_ranked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_matches_p1 ON matches(player1_id);
CREATE INDEX IF NOT EXISTS idx_matches_p2 ON matches(player2_id);
CREATE INDEX IF NOT EXISTS idx_matches_created ON matches(created_at DESC);

-- Leaderboard view
CREATE VIEW IF NOT EXISTS leaderboard AS
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
ORDER BY elo_rating DESC
LIMIT 100;
