ALTER TABLE sprites ADD COLUMN content_hash TEXT;
ALTER TABLE sprites ADD COLUMN raw_content_hash TEXT;

ALTER TABLE sprite_versions ADD COLUMN content_hash TEXT;
ALTER TABLE sprite_versions ADD COLUMN raw_content_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sprite_versions_content
ON sprite_versions (
  fighter_id,
  animation_name,
  quality_tier,
  content_hash,
  COALESCE(raw_content_hash, '')
)
WHERE content_hash IS NOT NULL;
