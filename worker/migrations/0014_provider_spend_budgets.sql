ALTER TABLE provider_sessions
ADD COLUMN provider_cost_used_cents INTEGER NOT NULL DEFAULT 0
CHECK (provider_cost_used_cents >= 0);

ALTER TABLE provider_sessions
ADD COLUMN provider_cost_limit_cents INTEGER NOT NULL DEFAULT 0
CHECK (provider_cost_limit_cents >= 0);

CREATE TABLE IF NOT EXISTS provider_spend_months (
  period TEXT PRIMARY KEY,
  estimated_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (estimated_cost_cents >= 0),
  provider_calls INTEGER NOT NULL DEFAULT 0 CHECK (provider_calls >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

UPDATE provider_sessions
SET provider_cost_limit_cents = CASE
  WHEN purpose IN ('fighter_generation', 'fighter_upgrade') AND tier = 'rookie' THEN 300
  WHEN purpose IN ('fighter_generation', 'fighter_upgrade') AND tier = 'contender' THEN 1000
  WHEN purpose IN ('fighter_generation', 'fighter_upgrade') AND tier = 'champion' THEN 1800
  WHEN purpose = 'fighter_retry' AND tier = 'rookie' THEN 50
  WHEN purpose = 'fighter_retry' AND tier = 'contender' THEN 300
  WHEN purpose = 'fighter_retry' AND tier = 'champion' THEN 500
  WHEN purpose = 'stage_background' THEN 50
  WHEN purpose = 'intro_video' THEN 300
  ELSE provider_cost_limit_cents
END
WHERE provider_cost_limit_cents = 0;
