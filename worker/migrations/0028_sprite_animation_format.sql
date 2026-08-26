ALTER TABLE sprites
ADD COLUMN animation_format TEXT NOT NULL DEFAULT 'legacy'
CHECK (animation_format IN ('legacy', 'video-dense-v1'));

ALTER TABLE sprite_versions
ADD COLUMN animation_format TEXT NOT NULL DEFAULT 'legacy'
CHECK (animation_format IN ('legacy', 'video-dense-v1'));

ALTER TABLE generation_artifact_checkpoints
ADD COLUMN animation_format TEXT NOT NULL DEFAULT 'legacy'
CHECK (animation_format IN ('legacy', 'video-dense-v1'));

-- The same PNG bytes may intentionally be reclassified under a newer explicit
-- playback contract. Keep both immutable versions rather than mutating history.
DROP INDEX idx_sprite_versions_content;

CREATE UNIQUE INDEX idx_sprite_versions_content
ON sprite_versions (
  fighter_id,
  animation_name,
  quality_tier,
  animation_format,
  frame_w,
  frame_h,
  frame_count,
  processing_version,
  content_hash,
  COALESCE(raw_content_hash, '')
)
WHERE content_hash IS NOT NULL;
