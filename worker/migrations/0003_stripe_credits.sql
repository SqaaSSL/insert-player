ALTER TABLE credit_ledger ADD COLUMN stripe_session_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_stripe_session ON credit_ledger(stripe_session_id);

CREATE TABLE IF NOT EXISTS checkout_sessions (
  id TEXT PRIMARY KEY,
  stripe_session_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id TEXT NOT NULL,
  credits INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_user ON checkout_sessions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
