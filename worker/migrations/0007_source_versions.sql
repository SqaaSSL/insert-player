CREATE TABLE IF NOT EXISTS source_versions (
  id TEXT PRIMARY KEY,
  fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('original', 'side', 'side_raw', 'upright', 'upright_raw', 'crouch', 'crouch_raw')),
  blob_key TEXT NOT NULL,
  content_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_source_versions_fighter ON source_versions(fighter_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_source_versions_content
ON source_versions (
  fighter_id,
  kind,
  content_hash
)
WHERE content_hash IS NOT NULL;
