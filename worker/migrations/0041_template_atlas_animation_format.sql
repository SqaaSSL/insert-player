-- Add atlas playback without rebuilding sprites/versions or deleting history.
-- Their old columns keep original constraints and values as pre-migration
-- evidence. They are not live mirrors: new writes use animation_format only.
-- Apply this migration atomically through the normal D1 migration transaction.
-- Recreate the three 0033 triggers verbatim: ALTER COLUMN RENAME would otherwise
-- rewrite their bindings to the historical column, silently bypassing live state.
DROP TRIGGER imported_global_video_recurations_exact_binding;
DROP TRIGGER imported_global_video_recuration_transition_exact_binding;
DROP TRIGGER imported_global_video_recuration_transition_apply;

ALTER TABLE sprites
RENAME COLUMN animation_format TO animation_format_before_atlas;

ALTER TABLE sprites
ADD COLUMN animation_format TEXT NOT NULL DEFAULT 'legacy'
CHECK (animation_format IN ('legacy', 'video-dense-v1', 'template-atlas-v1'));

UPDATE sprites
SET animation_format = animation_format_before_atlas;

ALTER TABLE sprite_versions
RENAME COLUMN animation_format TO animation_format_before_atlas;

ALTER TABLE sprite_versions
ADD COLUMN animation_format TEXT NOT NULL DEFAULT 'legacy'
CHECK (animation_format IN ('legacy', 'video-dense-v1', 'template-atlas-v1'));

UPDATE sprite_versions
SET animation_format = animation_format_before_atlas;

-- Checkpoints are a leaf table (no incoming FK, view or trigger dependency).
-- Rebuild only this leaf to widen stage_index: the old required column has no
-- default, so simply renaming it would break inserts from every Worker version.
-- Copy every column and PK exactly before replacing the old table. The run FK
-- and all other checks/defaults remain unchanged; 64 permits future package
-- ordering without clamping the 20-animation + source ordinals.
CREATE TABLE generation_artifact_checkpoints_atlas (
  run_id TEXT NOT NULL REFERENCES generation_artifact_runs(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('source', 'sprite')),
  artifact_name TEXT NOT NULL CHECK (length(artifact_name) BETWEEN 2 AND 64),
  stage_index INTEGER NOT NULL CHECK (stage_index BETWEEN 1 AND 64),
  tier TEXT NOT NULL CHECK (tier IN ('rookie', 'contender', 'champion')),
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'corrupt')),
  clean_version_id TEXT NOT NULL,
  raw_version_id TEXT,
  clean_blob_key TEXT NOT NULL,
  raw_blob_key TEXT,
  clean_content_hash TEXT,
  raw_content_hash TEXT,
  frame_w INTEGER,
  frame_h INTEGER,
  frame_count INTEGER,
  processing_version INTEGER,
  metadata_json TEXT,
  completed_by_job_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at TEXT,
  animation_format TEXT NOT NULL DEFAULT 'legacy'
    CHECK (animation_format IN ('legacy', 'video-dense-v1', 'template-atlas-v1')),
  PRIMARY KEY (run_id, artifact_kind, artifact_name)
);

INSERT INTO generation_artifact_checkpoints_atlas (
  run_id, artifact_kind, artifact_name, stage_index, tier, status,
  clean_version_id, raw_version_id, clean_blob_key, raw_blob_key,
  clean_content_hash, raw_content_hash, frame_w, frame_h, frame_count,
  processing_version, metadata_json, completed_by_job_id, created_at,
  verified_at, animation_format
)
SELECT run_id, artifact_kind, artifact_name, stage_index, tier, status,
  clean_version_id, raw_version_id, clean_blob_key, raw_blob_key,
  clean_content_hash, raw_content_hash, frame_w, frame_h, frame_count,
  processing_version, metadata_json, completed_by_job_id, created_at,
  verified_at, animation_format
FROM generation_artifact_checkpoints;

DROP TABLE generation_artifact_checkpoints;
ALTER TABLE generation_artifact_checkpoints_atlas
RENAME TO generation_artifact_checkpoints;

CREATE INDEX idx_generation_artifact_checkpoints_run
ON generation_artifact_checkpoints(run_id, stage_index ASC);

-- Preserve the same content uniqueness contract, now against the live column.
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

-- Exact 0033 trigger bodies; only their temporary removal above is new.
CREATE TRIGGER imported_global_video_recurations_exact_binding
BEFORE INSERT ON imported_global_video_recurations
BEGIN
  SELECT RAISE(ABORT, 'imported recuration requires active public Champion admin owner')
  WHERE NOT EXISTS (
    SELECT 1 FROM fighters fighter
    JOIN arcade_fighters arcade ON arcade.fighter_id = fighter.id
    JOIN users owner ON owner.id = fighter.owner_user_id
    WHERE fighter.id = NEW.fighter_id
      AND fighter.owner_user_id = NEW.owner_user_id
      AND fighter.public_flag = 1 AND fighter.quality_tier = 'champion'
      AND arcade.status = 'active' AND owner.plan_tier = 'admin'
  );

  SELECT RAISE(ABORT, 'imported recuration current sprite binding changed')
  WHERE NOT EXISTS (
    SELECT 1 FROM sprites current
    JOIN sprite_versions source_version ON source_version.id = NEW.from_sprite_version_id
    WHERE current.id = NEW.from_sprite_id
      AND current.fighter_id = NEW.fighter_id AND current.animation_name = NEW.action
      AND current.quality_tier = 'champion'
      AND current.blob_key = NEW.from_processed_blob_key
      AND current.raw_blob_key = NEW.from_raw_blob_key
      AND current.content_hash = NEW.from_processed_sha256
      AND current.raw_content_hash = NEW.from_raw_sha256
      AND current.frame_w = NEW.from_frame_w AND current.frame_h = NEW.from_frame_h
      AND current.frame_count = NEW.from_frame_count
      AND current.animation_format = NEW.from_animation_format
      AND current.processing_version = NEW.from_processing_version
      AND source_version.fighter_id = NEW.fighter_id
      AND source_version.animation_name = NEW.action
      AND source_version.quality_tier = 'champion'
      AND source_version.blob_key = NEW.from_processed_blob_key
      AND source_version.raw_blob_key = NEW.from_raw_blob_key
      AND source_version.content_hash = NEW.from_processed_sha256
      AND source_version.raw_content_hash = NEW.from_raw_sha256
      AND source_version.frame_w = NEW.from_frame_w
      AND source_version.frame_h = NEW.from_frame_h
      AND source_version.frame_count = NEW.from_frame_count
      AND source_version.animation_format = NEW.from_animation_format
      AND source_version.processing_version = NEW.from_processing_version
  );

  SELECT RAISE(ABORT, 'imported recuration active canonical binding changed')
  WHERE NOT EXISTS (
    SELECT 1 FROM source_versions canonical
    JOIN fighters fighter ON fighter.id = canonical.fighter_id
    WHERE canonical.id = NEW.canonical_version_id
      AND canonical.fighter_id = NEW.fighter_id
      AND canonical.kind = NEW.canonical_kind
      AND canonical.blob_key = NEW.canonical_blob_key
      AND canonical.content_hash = NEW.canonical_sha256
      AND (
        (NEW.canonical_kind = 'side_raw'
          AND fighter.side_view_raw_blob_key = NEW.canonical_blob_key)
        OR (NEW.canonical_kind = 'upright_raw'
          AND fighter.upright_view_raw_blob_key = NEW.canonical_blob_key)
        OR (NEW.canonical_kind = 'crouch_raw'
          AND fighter.crouch_view_raw_blob_key = NEW.canonical_blob_key)
      )
  );

  SELECT RAISE(ABORT, 'imported recuration target sprite version changed')
  WHERE NOT EXISTS (
    SELECT 1 FROM sprite_versions target
    WHERE target.id = NEW.target_sprite_version_id
      AND target.fighter_id = NEW.fighter_id AND target.animation_name = NEW.action
      AND target.quality_tier = 'champion'
      AND target.blob_key = NEW.target_processed_blob_key
      AND target.raw_blob_key = NEW.target_raw_blob_key
      AND target.content_hash = NEW.target_processed_sha256
      AND target.raw_content_hash = NEW.target_raw_sha256
      AND target.frame_w = NEW.target_frame_w AND target.frame_h = NEW.target_frame_h
      AND target.frame_count = NEW.target_frame_count
      AND target.animation_format = NEW.target_animation_format
      AND target.processing_version = NEW.target_processing_version
  );
END;

CREATE TRIGGER imported_global_video_recuration_transition_exact_binding
BEFORE INSERT ON imported_global_video_recuration_transitions
BEGIN
  SELECT RAISE(ABORT, 'imported recuration transition lost active admin-owner binding')
  WHERE NOT EXISTS (
    SELECT 1 FROM imported_global_video_recurations proposal
    JOIN fighters fighter ON fighter.id = proposal.fighter_id
    JOIN arcade_fighters arcade ON arcade.fighter_id = fighter.id
    JOIN users actor ON actor.id = NEW.actor_user_id
    WHERE proposal.id = NEW.proposal_id
      AND proposal.fighter_id = NEW.fighter_id AND proposal.action = NEW.action
      AND proposal.owner_user_id = NEW.actor_user_id
      AND (NEW.operation = 'rollback' OR proposal.expected_worker_sha = NEW.expected_worker_sha)
      AND fighter.owner_user_id = NEW.actor_user_id
      AND fighter.public_flag = 1 AND fighter.quality_tier = 'champion'
      AND arcade.status = 'active' AND actor.plan_tier = 'admin'
  );

  SELECT RAISE(ABORT, 'imported recuration transition lost active canonical binding')
  WHERE NEW.operation = 'promote' AND NOT EXISTS (
    SELECT 1 FROM imported_global_video_recurations proposal
    JOIN source_versions canonical ON canonical.id = proposal.canonical_version_id
    JOIN fighters fighter ON fighter.id = proposal.fighter_id
    WHERE proposal.id = NEW.proposal_id
      AND canonical.fighter_id = proposal.fighter_id
      AND canonical.kind = proposal.canonical_kind
      AND canonical.blob_key = proposal.canonical_blob_key
      AND canonical.content_hash = proposal.canonical_sha256
      AND (
        (proposal.canonical_kind = 'side_raw'
          AND fighter.side_view_raw_blob_key = proposal.canonical_blob_key)
        OR (proposal.canonical_kind = 'upright_raw'
          AND fighter.upright_view_raw_blob_key = proposal.canonical_blob_key)
        OR (proposal.canonical_kind = 'crouch_raw'
          AND fighter.crouch_view_raw_blob_key = proposal.canonical_blob_key)
      )
  );

  SELECT RAISE(ABORT, 'imported recuration immutable version lineage changed')
  WHERE NOT EXISTS (
    SELECT 1 FROM imported_global_video_recurations proposal
    JOIN sprite_versions original ON original.id = proposal.from_sprite_version_id
    JOIN sprite_versions target ON target.id = proposal.target_sprite_version_id
    WHERE proposal.id = NEW.proposal_id
      AND original.fighter_id = proposal.fighter_id
      AND original.animation_name = proposal.action AND original.quality_tier = 'champion'
      AND original.blob_key = proposal.from_processed_blob_key
      AND original.raw_blob_key = proposal.from_raw_blob_key
      AND original.content_hash = proposal.from_processed_sha256
      AND original.raw_content_hash = proposal.from_raw_sha256
      AND original.frame_w = proposal.from_frame_w AND original.frame_h = proposal.from_frame_h
      AND original.frame_count = proposal.from_frame_count
      AND original.animation_format = proposal.from_animation_format
      AND original.processing_version = proposal.from_processing_version
      AND target.fighter_id = proposal.fighter_id
      AND target.animation_name = proposal.action AND target.quality_tier = 'champion'
      AND target.blob_key = proposal.target_processed_blob_key
      AND target.raw_blob_key = proposal.target_raw_blob_key
      AND target.content_hash = proposal.target_processed_sha256
      AND target.raw_content_hash = proposal.target_raw_sha256
      AND target.frame_w = proposal.target_frame_w AND target.frame_h = proposal.target_frame_h
      AND target.frame_count = proposal.target_frame_count
      AND target.animation_format = proposal.target_animation_format
      AND target.processing_version = proposal.target_processing_version
  );

  SELECT RAISE(ABORT, 'imported recuration promote lost exact CAS binding')
  WHERE NEW.operation = 'promote' AND NOT EXISTS (
    SELECT 1 FROM imported_global_video_recurations proposal
    JOIN sprites current ON current.id = proposal.from_sprite_id
    WHERE proposal.id = NEW.proposal_id AND NEW.rollback_of_transition_id IS NULL
      AND NEW.from_sprite_version_id = proposal.from_sprite_version_id
      AND NEW.from_processed_sha256 = proposal.from_processed_sha256
      AND NEW.from_raw_sha256 = proposal.from_raw_sha256
      AND NEW.to_sprite_version_id = proposal.target_sprite_version_id
      AND NEW.to_processed_sha256 = proposal.target_processed_sha256
      AND NEW.to_raw_sha256 = proposal.target_raw_sha256
      AND NEW.visual_review_accepted = 1 AND proposal.compiler_outcome <> 'reject'
      AND ((proposal.compiler_outcome = 'needs_review' AND NEW.needs_review_accepted = 1)
        OR (proposal.compiler_outcome = 'technical_pass' AND NEW.needs_review_accepted = 0))
      AND current.fighter_id = proposal.fighter_id
      AND current.animation_name = proposal.action AND current.quality_tier = 'champion'
      AND current.blob_key = proposal.from_processed_blob_key
      AND current.raw_blob_key = proposal.from_raw_blob_key
      AND current.content_hash = proposal.from_processed_sha256
      AND current.raw_content_hash = proposal.from_raw_sha256
      AND current.frame_w = proposal.from_frame_w AND current.frame_h = proposal.from_frame_h
      AND current.frame_count = proposal.from_frame_count
      AND current.animation_format = proposal.from_animation_format
      AND current.processing_version = proposal.from_processing_version
      AND NOT EXISTS (SELECT 1 FROM imported_global_video_recuration_transitions prior
        WHERE prior.proposal_id = proposal.id)
  );

  SELECT RAISE(ABORT, 'imported recuration rollback lost exact promote/CAS binding')
  WHERE NEW.operation = 'rollback' AND NOT EXISTS (
    SELECT 1 FROM imported_global_video_recurations proposal
    JOIN imported_global_video_recuration_transitions promoted
      ON promoted.id = NEW.rollback_of_transition_id
    JOIN sprites current ON current.id = proposal.from_sprite_id
    WHERE proposal.id = NEW.proposal_id
      AND promoted.proposal_id = proposal.id AND promoted.operation = 'promote'
      AND promoted.fighter_id = proposal.fighter_id AND promoted.action = proposal.action
      AND promoted.expected_worker_sha = proposal.expected_worker_sha
      AND NEW.from_sprite_version_id = proposal.target_sprite_version_id
      AND NEW.from_processed_sha256 = proposal.target_processed_sha256
      AND NEW.from_raw_sha256 = proposal.target_raw_sha256
      AND NEW.to_sprite_version_id = proposal.from_sprite_version_id
      AND NEW.to_processed_sha256 = proposal.from_processed_sha256
      AND NEW.to_raw_sha256 = proposal.from_raw_sha256
      AND NEW.visual_review_accepted = 0 AND NEW.needs_review_accepted = 0
      AND current.fighter_id = proposal.fighter_id
      AND current.animation_name = proposal.action AND current.quality_tier = 'champion'
      AND current.blob_key = proposal.target_processed_blob_key
      AND current.raw_blob_key = proposal.target_raw_blob_key
      AND current.content_hash = proposal.target_processed_sha256
      AND current.raw_content_hash = proposal.target_raw_sha256
      AND current.frame_w = proposal.target_frame_w AND current.frame_h = proposal.target_frame_h
      AND current.frame_count = proposal.target_frame_count
      AND current.animation_format = proposal.target_animation_format
      AND current.processing_version = proposal.target_processing_version
      AND NOT EXISTS (SELECT 1 FROM imported_global_video_recuration_transitions rolled_back
        WHERE rolled_back.proposal_id = proposal.id AND rolled_back.operation = 'rollback')
  );
END;

CREATE TRIGGER imported_global_video_recuration_transition_apply
AFTER INSERT ON imported_global_video_recuration_transitions
BEGIN
  INSERT INTO sprites (
    id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
    content_hash, raw_content_hash, frame_w, frame_h, frame_count,
    processing_version, animation_format, created_at
  )
  SELECT proposal.from_sprite_id, proposal.fighter_id, proposal.action, 'champion',
    target.blob_key, target.raw_blob_key, target.content_hash, target.raw_content_hash,
    target.frame_w, target.frame_h, target.frame_count,
    target.processing_version, target.animation_format, datetime('now')
  FROM imported_global_video_recurations proposal
  JOIN sprite_versions target ON target.id = NEW.to_sprite_version_id
  WHERE proposal.id = NEW.proposal_id
  ON CONFLICT(id) DO UPDATE SET
    blob_key = excluded.blob_key, raw_blob_key = excluded.raw_blob_key,
    content_hash = excluded.content_hash, raw_content_hash = excluded.raw_content_hash,
    frame_w = excluded.frame_w, frame_h = excluded.frame_h,
    frame_count = excluded.frame_count, processing_version = excluded.processing_version,
    animation_format = excluded.animation_format, created_at = excluded.created_at;

  UPDATE fighters SET updated_at = datetime('now') WHERE id = NEW.fighter_id;

  SELECT RAISE(ABORT, 'imported recuration atomic pointer update failed')
  WHERE NOT EXISTS (
    SELECT 1 FROM imported_global_video_recurations proposal
    JOIN sprite_versions target ON target.id = NEW.to_sprite_version_id
    JOIN sprites current ON current.id = proposal.from_sprite_id
    WHERE proposal.id = NEW.proposal_id
      AND current.fighter_id = NEW.fighter_id AND current.animation_name = NEW.action
      AND current.quality_tier = 'champion'
      AND current.blob_key = target.blob_key AND current.raw_blob_key = target.raw_blob_key
      AND current.content_hash = target.content_hash
      AND current.raw_content_hash = target.raw_content_hash
      AND current.frame_w = target.frame_w AND current.frame_h = target.frame_h
      AND current.frame_count = target.frame_count
      AND current.animation_format = target.animation_format
      AND current.processing_version = target.processing_version
  );
END;
