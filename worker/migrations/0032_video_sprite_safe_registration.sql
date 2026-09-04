-- Processing version 6 clamps deterministic root registration before it can crop an otherwise
-- complete source pose. Existing immutable version-5 reviews remain valid and readable.
DROP TRIGGER video_sprite_candidate_revisions_immutable;

ALTER TABLE video_sprite_candidate_revisions
  RENAME TO video_sprite_candidate_revisions_v5;

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
FROM video_sprite_candidate_revisions_v5;

DROP TABLE video_sprite_candidate_revisions_v5;

CREATE TRIGGER video_sprite_candidate_revisions_immutable
BEFORE UPDATE ON video_sprite_candidate_revisions
BEGIN
  SELECT RAISE(ABORT, 'video sprite candidate revisions are immutable');
END;
