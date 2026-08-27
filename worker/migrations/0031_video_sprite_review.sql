-- Human review is additive to the durable job state machine. A video job is
-- terminal (`succeeded`) while its private candidate waits for a reviewer.
ALTER TABLE generation_jobs
  ADD COLUMN review_status TEXT NOT NULL DEFAULT 'none'
  CHECK (review_status IN ('none', 'awaiting_review', 'approved', 'rejected'));

CREATE UNIQUE INDEX idx_generation_jobs_one_continuation_child
  ON generation_jobs(resumed_from_job_id)
  WHERE resumed_from_job_id IS NOT NULL AND creation_flow = 'video';

-- A video provider session/job may dispatch one and only one paid action. The
-- existing run+action cache key still handles retries of that exact action.
CREATE UNIQUE INDEX idx_provider_request_cache_one_video_dispatch_per_job
  ON provider_request_cache(job_id)
  WHERE provider = 'pixcli' AND method = 'POST'
    AND request_path = '/proxy/pixcli/api/v1/video/advanced';

-- One provider-backed candidate envelope belongs to exactly one generation
-- job. Re-curation creates immutable revisions below; it never creates another
-- provider candidate or calls the provider again.
CREATE TABLE video_sprite_candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES generation_artifact_runs(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE REFERENCES generation_jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN (
    'idle', 'walk', 'high_punch', 'high_kick', 'low_punch', 'low_kick',
    'jump', 'crouch', 'hit', 'ko', 'victory'
  )),
  sequence_order INTEGER NOT NULL CHECK (sequence_order BETWEEN 0 AND 10),
  status TEXT NOT NULL DEFAULT 'awaiting_review' CHECK (status IN (
    'awaiting_review', 'approved', 'rejected'
  )),
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision BETWEEN 1 AND 100),
  approved_revision INTEGER CHECK (approved_revision BETWEEN 1 AND 100),
  adjustment_claim_token TEXT CHECK (
    adjustment_claim_token IS NULL OR length(adjustment_claim_token) = 64
  ),
  adjustment_claim_revision INTEGER CHECK (
    adjustment_claim_revision IS NULL OR adjustment_claim_revision BETWEEN 1 AND 99
  ),
  adjustment_claim_indices_json TEXT CHECK (
    adjustment_claim_indices_json IS NULL OR json_valid(adjustment_claim_indices_json)
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  review_reason TEXT,
  UNIQUE(run_id, action),
  CHECK (
    (status = 'approved' AND approved_revision = current_revision) OR
    (status <> 'approved' AND approved_revision IS NULL)
  ),
  CHECK (
    (adjustment_claim_token IS NULL AND adjustment_claim_revision IS NULL AND
      adjustment_claim_indices_json IS NULL) OR
    (adjustment_claim_token IS NOT NULL AND adjustment_claim_revision = current_revision AND
      adjustment_claim_indices_json IS NOT NULL)
  )
);

-- Provider and compiler lineage is immutable per revision. The envelope above
-- points at the current proposal; approval binds exactly that revision and its
-- report SHA before promoting the private sprite version.
CREATE TABLE video_sprite_candidate_revisions (
  candidate_id TEXT NOT NULL REFERENCES video_sprite_candidates(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 100),
  compiler_outcome TEXT NOT NULL CHECK (compiler_outcome IN (
    'technical_pass', 'needs_review', 'reject'
  )),
  semantic_promotion_approved INTEGER NOT NULL DEFAULT 0
    CHECK (semantic_promotion_approved = 0),
  sprite_version_id TEXT NOT NULL REFERENCES sprite_versions(id) ON DELETE RESTRICT,
  provider_model TEXT NOT NULL CHECK (provider_model = 'grok-imagine-i2v-pinned'),
  pixcli_job_id TEXT NOT NULL CHECK (length(pixcli_job_id) = 32),
  provider_request_id TEXT NOT NULL CHECK (length(provider_request_id) BETWEEN 8 AND 200),
  prompt_sha256 TEXT NOT NULL CHECK (length(prompt_sha256) = 64),
  canonical_blob_key TEXT NOT NULL,
  canonical_sha256 TEXT NOT NULL CHECK (length(canonical_sha256) = 64),
  provider_audit_blob_key TEXT NOT NULL,
  provider_audit_sha256 TEXT NOT NULL CHECK (length(provider_audit_sha256) = 64),
  video_blob_key TEXT NOT NULL,
  video_sha256 TEXT NOT NULL CHECK (length(video_sha256) = 64),
  video_size_bytes INTEGER NOT NULL CHECK (video_size_bytes BETWEEN 12 AND 16777216),
  processed_blob_key TEXT NOT NULL,
  processed_sha256 TEXT NOT NULL CHECK (length(processed_sha256) = 64),
  raw_blob_key TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL CHECK (length(raw_sha256) = 64),
  contact_sheet_blob_key TEXT NOT NULL,
  contact_sheet_sha256 TEXT NOT NULL CHECK (length(contact_sheet_sha256) = 64),
  unique_sheet_blob_key TEXT NOT NULL,
  unique_sheet_sha256 TEXT NOT NULL CHECK (length(unique_sheet_sha256) = 64),
  report_blob_key TEXT NOT NULL,
  report_sha256 TEXT NOT NULL CHECK (length(report_sha256) = 64),
  report_content_sha256 TEXT NOT NULL CHECK (length(report_content_sha256) = 64),
  frame_w INTEGER NOT NULL CHECK (frame_w = 192),
  frame_h INTEGER NOT NULL CHECK (frame_h = 256),
  frame_count INTEGER NOT NULL CHECK (frame_count BETWEEN 2 AND 64),
  raw_frame_w INTEGER NOT NULL CHECK (raw_frame_w = 768),
  raw_frame_h INTEGER NOT NULL CHECK (raw_frame_h = 1024),
  raw_frame_count INTEGER NOT NULL CHECK (raw_frame_count BETWEEN 2 AND 12),
  source_frame_count INTEGER NOT NULL CHECK (source_frame_count BETWEEN 2 AND 144),
  animation_format TEXT NOT NULL CHECK (animation_format = 'video-dense-v1'),
  processing_version INTEGER NOT NULL CHECK (processing_version = 5),
  selected_indices_json TEXT NOT NULL CHECK (json_valid(selected_indices_json)),
  playback_json TEXT NOT NULL CHECK (json_valid(playback_json)),
  translations_json TEXT NOT NULL CHECK (json_valid(translations_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(candidate_id, revision)
);

CREATE INDEX idx_video_sprite_candidates_run
  ON video_sprite_candidates(run_id, sequence_order ASC);

CREATE UNIQUE INDEX idx_video_sprite_candidates_one_pending_run
  ON video_sprite_candidates(run_id)
  WHERE status = 'awaiting_review';

CREATE UNIQUE INDEX idx_video_sprite_candidates_one_approved_action
  ON video_sprite_candidates(run_id, action)
  WHERE status = 'approved';

CREATE TRIGGER video_sprite_candidate_revisions_immutable
BEFORE UPDATE ON video_sprite_candidate_revisions
BEGIN
  SELECT RAISE(ABORT, 'video sprite candidate revisions are immutable');
END;
