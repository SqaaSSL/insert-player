-- Source videos of Champions whose sprites predate the review-gated pipeline.
-- video_sprite_candidates only admits PixCLI-audited runs, so a fighter imported
-- from a sealed bundle (Donald Trump, 2026-08) had no row pointing at the MP4s
-- its sprites were cut from. This registry records each archived take in R2 with
-- its digest, the take that feeds the live sprite, and where it came from.
-- Rows are immutable; a corrected take is a new row.
CREATE TABLE fighter_source_videos (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN (
    'idle', 'walk', 'high_punch', 'high_kick', 'low_punch', 'low_kick',
    'jump', 'crouch', 'hit', 'ko', 'victory', 'fireball', 'uppercut'
  )),
  take_label TEXT NOT NULL CHECK (length(take_label) BETWEEN 1 AND 40),
  role TEXT NOT NULL CHECK (role IN ('live_source', 'alternate_take')),
  sprite_version_id TEXT REFERENCES sprite_versions(id) ON DELETE SET NULL,
  provider_model TEXT NOT NULL CHECK (length(provider_model) BETWEEN 3 AND 120),
  video_blob_key TEXT NOT NULL UNIQUE,
  video_sha256 TEXT NOT NULL CHECK (length(video_sha256) = 64),
  video_size_bytes INTEGER NOT NULL CHECK (video_size_bytes BETWEEN 12 AND 16777216),
  video_width INTEGER NOT NULL CHECK (video_width > 0),
  video_height INTEGER NOT NULL CHECK (video_height > 0),
  video_frame_count INTEGER NOT NULL CHECK (video_frame_count BETWEEN 2 AND 1440),
  video_fps INTEGER NOT NULL CHECK (video_fps BETWEEN 1 AND 120),
  provenance_blob_key TEXT,
  source_note TEXT NOT NULL CHECK (length(source_note) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(fighter_id, action, take_label),
  CHECK (role = 'alternate_take' OR sprite_version_id IS NOT NULL)
);

CREATE INDEX idx_fighter_source_videos_fighter
  ON fighter_source_videos(fighter_id, action);

CREATE UNIQUE INDEX idx_fighter_source_videos_one_live_source
  ON fighter_source_videos(fighter_id, action)
  WHERE role = 'live_source';

CREATE TRIGGER fighter_source_videos_immutable
BEFORE UPDATE ON fighter_source_videos
BEGIN
  SELECT RAISE(ABORT, 'fighter_source_videos rows are immutable');
END;
