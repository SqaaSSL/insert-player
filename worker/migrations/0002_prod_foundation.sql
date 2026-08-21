-- One-time migration for prototype databases that already ran 0001 before
-- Clerk/fighter-storage existed. Do not re-run after it succeeds.
ALTER TABLE users ADD COLUMN clerk_user_id TEXT;
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN plan_tier TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN credits_balance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN free_rookie_generations_used INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_clerk ON users(clerk_user_id);

CREATE TABLE IF NOT EXISTS fighters (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Fighter',
  photo_hash TEXT NOT NULL,
  quality_tier TEXT NOT NULL DEFAULT 'contender' CHECK (quality_tier IN ('rookie', 'contender', 'champion')),
  public_flag INTEGER NOT NULL DEFAULT 0,
  original_blob_key TEXT,
  side_view_blob_key TEXT,
  side_view_raw_blob_key TEXT,
  upright_view_blob_key TEXT,
  upright_view_raw_blob_key TEXT,
  crouch_view_blob_key TEXT,
  crouch_view_raw_blob_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner_user_id, photo_hash)
);

CREATE INDEX IF NOT EXISTS idx_fighters_owner ON fighters(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_fighters_hash ON fighters(photo_hash);
CREATE INDEX IF NOT EXISTS idx_fighters_public ON fighters(public_flag, updated_at DESC);

CREATE TABLE IF NOT EXISTS sprites (
  id TEXT PRIMARY KEY,
  fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
  animation_name TEXT NOT NULL,
  quality_tier TEXT NOT NULL CHECK (quality_tier IN ('rookie', 'contender', 'champion')),
  blob_key TEXT NOT NULL,
  raw_blob_key TEXT,
  frame_w INTEGER NOT NULL,
  frame_h INTEGER NOT NULL,
  frame_count INTEGER NOT NULL,
  processing_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(fighter_id, animation_name, quality_tier)
);

CREATE INDEX IF NOT EXISTS idx_sprites_fighter ON sprites(fighter_id);
CREATE INDEX IF NOT EXISTS idx_sprites_tier ON sprites(fighter_id, quality_tier);

CREATE TABLE IF NOT EXISTS intros (
  id TEXT PRIMARY KEY,
  fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  model TEXT,
  prompt TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(fighter_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_intros_fighter ON intros(fighter_id);

CREATE TABLE IF NOT EXISTS stages (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'Stage',
  kind TEXT NOT NULL DEFAULT 'photo' CHECK (kind IN ('generated', 'photo', 'photo-direct')),
  blob_key TEXT NOT NULL,
  public_flag INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stages_owner ON stages(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_stages_public ON stages(public_flag, updated_at DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  fighter_id TEXT REFERENCES fighters(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger(user_id, created_at DESC);

ALTER TABLE matches ADD COLUMN p1_fighter_id TEXT REFERENCES fighters(id);
ALTER TABLE matches ADD COLUMN p2_fighter_id TEXT REFERENCES fighters(id);
