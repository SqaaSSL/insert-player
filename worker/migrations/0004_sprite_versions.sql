CREATE TABLE IF NOT EXISTS sprite_versions (
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sprite_versions_fighter ON sprite_versions(fighter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sprite_versions_animation ON sprite_versions(fighter_id, animation_name, quality_tier, created_at DESC);
