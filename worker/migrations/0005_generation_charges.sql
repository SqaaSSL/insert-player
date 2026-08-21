CREATE TABLE IF NOT EXISTS generation_charges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('rookie', 'contender', 'champion')),
  credit_cost INTEGER NOT NULL DEFAULT 0,
  free_quota_delta INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'committed', 'refunded')),
  reason TEXT NOT NULL,
  fighter_id TEXT REFERENCES fighters(id) ON DELETE SET NULL,
  ledger_id TEXT REFERENCES credit_ledger(id) ON DELETE SET NULL,
  refund_ledger_id TEXT REFERENCES credit_ledger(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_generation_charges_user ON generation_charges(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_charges_status ON generation_charges(status, expires_at);
