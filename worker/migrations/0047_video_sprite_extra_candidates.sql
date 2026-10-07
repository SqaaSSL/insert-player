-- Review-gated extra special moves (fireball, uppercut) persist one candidate at
-- sequence 11/12 of their own single-move run. 0031 only admitted the eleven base
-- actions, so the candidate envelope is rebuilt with the wider action set. Every
-- existing candidate and immutable revision is copied unchanged.
--
-- Order matters under D1's always-on foreign keys: the child revisions table is
-- moved aside first and the parent last, and the aside tables are dropped child
-- first, so no ON DELETE CASCADE ever fires against copied rows.
DROP TRIGGER video_sprite_candidate_revisions_immutable;
DROP INDEX idx_video_sprite_candidates_run;
DROP INDEX idx_video_sprite_candidates_one_pending_run;
DROP INDEX idx_video_sprite_candidates_one_approved_action;

ALTER TABLE video_sprite_candidate_revisions
  RENAME TO video_sprite_candidate_revisions_base;

ALTER TABLE video_sprite_candidates
  RENAME TO video_sprite_candidates_base;

CREATE TABLE video_sprite_candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES generation_artifact_runs(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE REFERENCES generation_jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN (
    'idle', 'walk', 'high_punch', 'high_kick', 'low_punch', 'low_kick',
    'jump', 'crouch', 'hit', 'ko', 'victory', 'fireball', 'uppercut'
  )),
  sequence_order INTEGER NOT NULL CHECK (sequence_order BETWEEN 0 AND 12),
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
  -- The base actions keep their fixed order; an extra move is always its own order.
  CHECK (
    (action = 'fireball' AND sequence_order = 11) OR
    (action = 'uppercut' AND sequence_order = 12) OR
    (action NOT IN ('fireball', 'uppercut') AND sequence_order BETWEEN 0 AND 10)
  ),
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

INSERT INTO video_sprite_candidates (
  id, run_id, job_id, user_id, fighter_id, action, sequence_order, status,
  current_revision, approved_revision, adjustment_claim_token,
  adjustment_claim_revision, adjustment_claim_indices_json, created_at,
  reviewed_at, reviewed_by_user_id, review_reason
)
SELECT
  id, run_id, job_id, user_id, fighter_id, action, sequence_order, status,
  current_revision, approved_revision, adjustment_claim_token,
  adjustment_claim_revision, adjustment_claim_indices_json, created_at,
  reviewed_at, reviewed_by_user_id, review_reason
FROM video_sprite_candidates_base;

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
  processing_version INTEGER NOT NULL CHECK (processing_version IN (5, 6)),
  selected_indices_json TEXT NOT NULL CHECK (json_valid(selected_indices_json)),
  playback_json TEXT NOT NULL CHECK (json_valid(playback_json)),
  translations_json TEXT NOT NULL CHECK (json_valid(translations_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(candidate_id, revision)
);

INSERT INTO video_sprite_candidate_revisions (
  candidate_id, revision, compiler_outcome, semantic_promotion_approved,
  sprite_version_id, provider_model, pixcli_job_id, provider_request_id,
  prompt_sha256, canonical_blob_key, canonical_sha256,
  provider_audit_blob_key, provider_audit_sha256,
  video_blob_key, video_sha256, video_size_bytes,
  processed_blob_key, processed_sha256, raw_blob_key, raw_sha256,
  contact_sheet_blob_key, contact_sheet_sha256,
  unique_sheet_blob_key, unique_sheet_sha256,
  report_blob_key, report_sha256, report_content_sha256,
  frame_w, frame_h, frame_count, raw_frame_w, raw_frame_h, raw_frame_count,
  source_frame_count, animation_format, processing_version,
  selected_indices_json, playback_json, translations_json, created_at
)
SELECT
  candidate_id, revision, compiler_outcome, semantic_promotion_approved,
  sprite_version_id, provider_model, pixcli_job_id, provider_request_id,
  prompt_sha256, canonical_blob_key, canonical_sha256,
  provider_audit_blob_key, provider_audit_sha256,
  video_blob_key, video_sha256, video_size_bytes,
  processed_blob_key, processed_sha256, raw_blob_key, raw_sha256,
  contact_sheet_blob_key, contact_sheet_sha256,
  unique_sheet_blob_key, unique_sheet_sha256,
  report_blob_key, report_sha256, report_content_sha256,
  frame_w, frame_h, frame_count, raw_frame_w, raw_frame_h, raw_frame_count,
  source_frame_count, animation_format, processing_version,
  selected_indices_json, playback_json, translations_json, created_at
FROM video_sprite_candidate_revisions_base;

DROP TABLE video_sprite_candidate_revisions_base;
DROP TABLE video_sprite_candidates_base;

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

-- Durable audit for every extra-move start: the six live canonical source hashes
-- and the approved run(s) or sealed import they were proven against. The extra
-- move can be activated only while its job keeps this exact proof.
CREATE TABLE video_extra_source_proofs (
  job_id TEXT PRIMARY KEY REFERENCES generation_jobs(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES generation_artifact_runs(id) ON DELETE CASCADE,
  fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('fireball', 'uppercut')),
  proof_json TEXT NOT NULL CHECK (json_valid(proof_json)),
  proof_sha256 TEXT NOT NULL CHECK (length(proof_sha256) = 64),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_video_extra_source_proofs_fighter
  ON video_extra_source_proofs(fighter_id, action, created_at DESC);

CREATE TRIGGER video_extra_source_proofs_immutable
BEFORE UPDATE ON video_extra_source_proofs
BEGIN
  SELECT RAISE(ABORT, 'video extra source proofs are immutable');
END;
