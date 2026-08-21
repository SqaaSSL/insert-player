CREATE TABLE IF NOT EXISTS provider_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  rate_limit_key TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('rookie', 'contender', 'champion')),
  purpose TEXT NOT NULL CHECK (purpose IN ('fighter_generation', 'fighter_retry', 'fighter_upgrade', 'stage_background', 'intro_video')),
  charge_id TEXT REFERENCES generation_charges(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  provider_calls_used INTEGER NOT NULL DEFAULT 0,
  provider_call_limit INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_provider_sessions_user ON provider_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_sessions_charge ON provider_sessions(charge_id);
CREATE INDEX IF NOT EXISTS idx_provider_sessions_status ON provider_sessions(status, expires_at);
