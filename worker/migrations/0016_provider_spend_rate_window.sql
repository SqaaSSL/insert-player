CREATE TABLE IF NOT EXISTS provider_spend_reservations (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model_path TEXT NOT NULL,
  estimated_cost_cents INTEGER NOT NULL CHECK (estimated_cost_cents > 0),
  created_at_epoch INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_spend_reservations_window
ON provider_spend_reservations(provider, created_at_epoch);
