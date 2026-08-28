-- Provider-free recuration for active imported/legacy Arcade globals that predate
-- generation-job Video review lineage. A proposal is immutable review evidence. A
-- transition is the transaction boundary: BEFORE validates the exact current/full
-- version tuple and AFTER moves the current sprite pointer atomically.
CREATE TABLE imported_global_video_recurations (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN (
    'idle', 'walk', 'high_punch', 'high_kick', 'low_punch', 'low_kick',
    'jump', 'crouch', 'hit', 'ko', 'victory'
  )),
  expected_worker_sha TEXT NOT NULL CHECK (length(expected_worker_sha) = 40),
  worker_version_id TEXT NOT NULL CHECK (length(worker_version_id) BETWEEN 1 AND 200),
  worker_version_tag TEXT NOT NULL CHECK (length(worker_version_tag) BETWEEN 1 AND 200),

  -- Provenance only: stage permanently archives the exact MP4 and later operations
  -- never read the ephemeral public URL.
  source_url TEXT NOT NULL CHECK (length(source_url) BETWEEN 12 AND 2048),
  source_video_blob_key TEXT NOT NULL,
  source_video_sha256 TEXT NOT NULL CHECK (length(source_video_sha256) = 64),
  source_video_size_bytes INTEGER NOT NULL CHECK (
    source_video_size_bytes BETWEEN 12 AND 16777216
  ),
  source_provider TEXT NOT NULL CHECK (source_provider = 'fal'),
  provider_model TEXT NOT NULL CHECK (provider_model = 'grok-imagine-i2v-pinned'),
  provider_endpoint TEXT NOT NULL CHECK (
    provider_endpoint = 'xai/grok-imagine-video/v1.5/image-to-video'
  ),
  pixcli_job_id TEXT NOT NULL CHECK (length(pixcli_job_id) = 32),
  provider_request_id TEXT NOT NULL CHECK (length(provider_request_id) BETWEEN 8 AND 200),
  prompt_sha256 TEXT NOT NULL CHECK (length(prompt_sha256) = 64),
  provider_request_audit_sha256 TEXT NOT NULL CHECK (length(provider_request_audit_sha256) = 64),
  provider_response_sha256 TEXT NOT NULL CHECK (length(provider_response_sha256) = 64),

  -- Legacy imports can have used upright_raw where modern policy maps to side_raw.
  canonical_kind TEXT NOT NULL CHECK (
    canonical_kind IN ('side_raw', 'upright_raw', 'crouch_raw')
  ),
  canonical_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
  canonical_blob_key TEXT NOT NULL,
  canonical_sha256 TEXT NOT NULL CHECK (length(canonical_sha256) = 64),

  from_sprite_id TEXT NOT NULL,
  from_sprite_version_id TEXT NOT NULL REFERENCES sprite_versions(id) ON DELETE CASCADE,
  from_processed_blob_key TEXT NOT NULL,
  from_processed_sha256 TEXT NOT NULL CHECK (length(from_processed_sha256) = 64),
  from_raw_blob_key TEXT NOT NULL,
  from_raw_sha256 TEXT NOT NULL CHECK (length(from_raw_sha256) = 64),
  from_frame_w INTEGER NOT NULL CHECK (from_frame_w = 192),
  from_frame_h INTEGER NOT NULL CHECK (from_frame_h = 256),
  from_frame_count INTEGER NOT NULL CHECK (from_frame_count BETWEEN 2 AND 64),
  from_animation_format TEXT NOT NULL CHECK (from_animation_format = 'video-dense-v1'),
  from_processing_version INTEGER NOT NULL CHECK (from_processing_version BETWEEN 0 AND 100),

  target_sprite_version_id TEXT NOT NULL REFERENCES sprite_versions(id) ON DELETE CASCADE,
  target_processed_blob_key TEXT NOT NULL,
  target_processed_sha256 TEXT NOT NULL CHECK (length(target_processed_sha256) = 64),
  target_raw_blob_key TEXT NOT NULL,
  target_raw_sha256 TEXT NOT NULL CHECK (length(target_raw_sha256) = 64),
  target_frame_w INTEGER NOT NULL CHECK (target_frame_w = 192),
  target_frame_h INTEGER NOT NULL CHECK (target_frame_h = 256),
  target_frame_count INTEGER NOT NULL CHECK (target_frame_count BETWEEN 2 AND 64),
  target_raw_frame_w INTEGER NOT NULL CHECK (target_raw_frame_w = 768),
  target_raw_frame_h INTEGER NOT NULL CHECK (target_raw_frame_h = 1024),
  target_raw_frame_count INTEGER NOT NULL CHECK (target_raw_frame_count BETWEEN 2 AND 12),
  source_frame_count INTEGER NOT NULL CHECK (source_frame_count BETWEEN 2 AND 144),
  target_animation_format TEXT NOT NULL CHECK (target_animation_format = 'video-dense-v1'),
  target_processing_version INTEGER NOT NULL CHECK (target_processing_version = 6),
  compiler_outcome TEXT NOT NULL CHECK (compiler_outcome IN (
    'technical_pass', 'needs_review', 'reject'
  )),
  report_sha256 TEXT NOT NULL CHECK (length(report_sha256) = 64),
  report_content_sha256 TEXT NOT NULL CHECK (length(report_content_sha256) = 64),
  selected_indices_json TEXT NOT NULL CHECK (json_valid(selected_indices_json)),
  playback_json TEXT NOT NULL CHECK (json_valid(playback_json)),
  translations_json TEXT NOT NULL CHECK (json_valid(translations_json)),

  contact_sheet_blob_key TEXT NOT NULL,
  contact_sheet_sha256 TEXT NOT NULL CHECK (length(contact_sheet_sha256) = 64),
  unique_sheet_blob_key TEXT NOT NULL,
  unique_sheet_sha256 TEXT NOT NULL CHECK (length(unique_sheet_sha256) = 64),
  report_blob_key TEXT NOT NULL,
  evidence_blob_key TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256) = 64),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (target_sprite_version_id <> from_sprite_version_id),
  CHECK (target_processed_sha256 <> from_processed_sha256),
  CHECK (target_raw_sha256 <> from_raw_sha256),
  UNIQUE(id, fighter_id, action)
);

CREATE INDEX idx_imported_global_video_recurations_fighter_action
  ON imported_global_video_recurations(fighter_id, action, created_at DESC);

CREATE TABLE imported_global_video_recuration_transitions (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),
  proposal_id TEXT NOT NULL,
  fighter_id TEXT NOT NULL,
  action TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('promote', 'rollback')),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_sprite_version_id TEXT NOT NULL REFERENCES sprite_versions(id) ON DELETE CASCADE,
  from_processed_sha256 TEXT NOT NULL CHECK (length(from_processed_sha256) = 64),
  from_raw_sha256 TEXT NOT NULL CHECK (length(from_raw_sha256) = 64),
  to_sprite_version_id TEXT NOT NULL REFERENCES sprite_versions(id) ON DELETE CASCADE,
  to_processed_sha256 TEXT NOT NULL CHECK (length(to_processed_sha256) = 64),
  to_raw_sha256 TEXT NOT NULL CHECK (length(to_raw_sha256) = 64),
  expected_worker_sha TEXT NOT NULL CHECK (length(expected_worker_sha) = 40),
  visual_review_accepted INTEGER NOT NULL CHECK (visual_review_accepted IN (0, 1)),
  needs_review_accepted INTEGER NOT NULL CHECK (needs_review_accepted IN (0, 1)),
  rollback_of_transition_id TEXT REFERENCES imported_global_video_recuration_transitions(id)
    ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (proposal_id, fighter_id, action)
    REFERENCES imported_global_video_recurations(id, fighter_id, action) ON DELETE CASCADE,
  CHECK (
    (operation = 'promote' AND rollback_of_transition_id IS NULL)
    OR (operation = 'rollback' AND rollback_of_transition_id IS NOT NULL)
  ),
  UNIQUE(proposal_id, operation),
  UNIQUE(rollback_of_transition_id)
);

CREATE INDEX idx_imported_global_video_recuration_transitions_fighter
  ON imported_global_video_recuration_transitions(fighter_id, action, created_at DESC);

-- Only this short-lived mutable lease serializes expensive stage work.
CREATE TABLE imported_global_video_recuration_claims (
  fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  claim_token TEXT NOT NULL CHECK (length(claim_token) = 64),
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_expires_at TEXT NOT NULL,
  PRIMARY KEY(fighter_id, action),
  CHECK (lease_expires_at > claimed_at)
);

CREATE TRIGGER imported_global_video_recurations_immutable_update
BEFORE UPDATE ON imported_global_video_recurations
BEGIN
  SELECT RAISE(ABORT, 'imported global video recuration proposals are immutable');
END;

-- The proposal itself is a final CAS after compilation, so a durable proposal can
-- never be committed against a current sprite/canonical that changed mid-stage.
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

CREATE TRIGGER imported_global_video_recuration_transitions_immutable_update
BEFORE UPDATE ON imported_global_video_recuration_transitions
BEGIN
  SELECT RAISE(ABORT, 'imported global video recuration transitions are immutable');
END;

-- Exact source/current/target/ownership checks happen before the ledger row exists.
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

-- This transition INSERT and its pointer update are one SQLite statement. Any
-- constraint/RAISE rolls both ledger and pointer back.
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
