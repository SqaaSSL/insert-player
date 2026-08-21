CREATE TABLE IF NOT EXISTS provider_cost_events (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES provider_sessions(id) ON DELETE SET NULL,
  charge_id TEXT REFERENCES generation_charges(id) ON DELETE SET NULL,
  tier TEXT NOT NULL CHECK (tier IN ('rookie', 'contender', 'champion')),
  purpose TEXT NOT NULL CHECK (purpose IN (
    'fighter_generation',
    'fighter_retry',
    'fighter_upgrade',
    'stage_background',
    'intro_video'
  )),
  billing_operation TEXT CHECK (billing_operation IS NULL OR billing_operation IN (
    'fighter_generation',
    'fighter_upgrade',
    'fighter_retry_animation',
    'fighter_retry_source'
  )),
  provider TEXT NOT NULL CHECK (provider IN ('gemini', 'ludo', 'freepik', 'runway', 'fal')),
  model_path TEXT NOT NULL CHECK (length(model_path) BETWEEN 1 AND 512),
  estimated_cost_cents INTEGER NOT NULL CHECK (estimated_cost_cents > 0),
  outcome TEXT NOT NULL DEFAULT 'reserved' CHECK (outcome IN ('reserved', 'succeeded', 'failed')),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finalized_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_provider_cost_events_created
  ON provider_cost_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_provider_cost_events_operation
  ON provider_cost_events(billing_operation, outcome, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_provider_cost_events_charge
  ON provider_cost_events(charge_id, created_at ASC)
  WHERE charge_id IS NOT NULL;
