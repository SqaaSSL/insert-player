PRAGMA defer_foreign_keys = ON;

DROP TABLE IF EXISTS migration_0023_generation_idle_guard;

CREATE TABLE migration_0023_generation_idle_guard (
  idle INTEGER NOT NULL CHECK (idle = 1)
);

INSERT INTO migration_0023_generation_idle_guard (idle)
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM generation_jobs WHERE status IN ('queued', 'running')
  ) THEN 0
  ELSE 1
END;

DROP TABLE migration_0023_generation_idle_guard;

CREATE TABLE generation_artifact_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('rookie', 'contender', 'champion')),
  operation TEXT NOT NULL CHECK (operation IN (
    'fighter_generation',
    'fighter_upgrade',
    'fighter_retry_animation',
    'fighter_retry_source'
  )),
  target_kind TEXT CHECK (target_kind IS NULL OR target_kind IN ('animation', 'source')),
  target_name TEXT CHECK (target_name IS NULL OR length(target_name) BETWEEN 1 AND 64),
  root_job_id TEXT NOT NULL,
  original_charge_id TEXT REFERENCES generation_charges(id) ON DELETE SET NULL,
  original_blob_key TEXT,
  source_manifest_json TEXT,
  generation_prompt TEXT,
  pipeline_version INTEGER NOT NULL DEFAULT 1 CHECK (pipeline_version >= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'partial', 'succeeded', 'failed', 'superseded'
  )),
  failure_stage TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  CHECK (
    (operation IN ('fighter_generation', 'fighter_upgrade') AND target_kind IS NULL AND target_name IS NULL)
    OR (operation = 'fighter_retry_animation' AND target_kind = 'animation' AND target_name IS NOT NULL)
    OR (operation = 'fighter_retry_source' AND target_kind = 'source' AND target_name IS NOT NULL)
  )
);

CREATE INDEX idx_generation_artifact_runs_fighter
  ON generation_artifact_runs(fighter_id, created_at DESC);

CREATE INDEX idx_generation_artifact_runs_resume
  ON generation_artifact_runs(user_id, fighter_id, tier, operation, status, updated_at DESC);

INSERT INTO generation_artifact_runs (
  id, user_id, fighter_id, tier, operation, target_kind, target_name,
  root_job_id, original_charge_id, original_blob_key, source_manifest_json,
  generation_prompt, status, failure_stage, created_at, updated_at, completed_at
)
SELECT
  gj.id,
  gj.user_id,
  gj.fighter_id,
  gj.tier,
  gj.operation,
  gj.target_kind,
  gj.target_name,
  gj.id,
  gj.charge_id,
  f.original_blob_key,
  json_object(
    'side', f.side_view_blob_key,
    'sideRaw', f.side_view_raw_blob_key,
    'upright', f.upright_view_blob_key,
    'uprightRaw', f.upright_view_raw_blob_key,
    'crouch', f.crouch_view_blob_key,
    'crouchRaw', f.crouch_view_raw_blob_key
  ),
  af.generation_prompt,
  CASE
    WHEN gj.status = 'succeeded' THEN 'succeeded'
    WHEN gj.status IN ('queued', 'running') THEN 'active'
    WHEN gc.status = 'committed' THEN 'partial'
    ELSE 'failed'
  END,
  CASE
    WHEN gj.status NOT IN ('failed', 'cancelled') THEN NULL
    WHEN lower(COALESCE(gj.error_message, '')) LIKE '%low_punch%' THEN 'sprite:low_punch'
    WHEN lower(COALESCE(gj.error_message, '')) LIKE '%low_kick%' THEN 'sprite:low_kick'
    WHEN lower(COALESCE(gj.error_message, '')) LIKE '%high_punch%' THEN 'sprite:high_punch'
    WHEN lower(COALESCE(gj.error_message, '')) LIKE '%high_kick%' THEN 'sprite:high_kick'
    WHEN gj.stage LIKE 'source:%'
      OR gj.stage LIKE 'sprite:%'
      OR gj.stage LIKE 'job:%'
      OR gj.stage LIKE 'workflow:%' THEN gj.stage
    WHEN gj.operation = 'fighter_generation' THEN CASE gj.progress_current
      WHEN 0 THEN 'source:side'
      WHEN 1 THEN 'source:upright'
      WHEN 2 THEN 'source:crouch'
      WHEN 3 THEN 'sprite:idle'
      WHEN 4 THEN 'sprite:walk'
      WHEN 5 THEN 'sprite:high_punch'
      WHEN 6 THEN 'sprite:high_kick'
      WHEN 7 THEN 'sprite:low_punch'
      WHEN 8 THEN 'sprite:low_kick'
      WHEN 9 THEN 'sprite:jump'
      WHEN 10 THEN 'sprite:crouch'
      WHEN 11 THEN 'sprite:hit'
      WHEN 12 THEN 'sprite:ko'
      WHEN 13 THEN 'sprite:victory'
      ELSE gj.stage
    END
    WHEN gj.operation = 'fighter_upgrade' THEN CASE gj.progress_current
      WHEN 0 THEN 'sprite:idle'
      WHEN 1 THEN 'sprite:walk'
      WHEN 2 THEN 'sprite:high_punch'
      WHEN 3 THEN 'sprite:high_kick'
      WHEN 4 THEN 'sprite:low_punch'
      WHEN 5 THEN 'sprite:low_kick'
      WHEN 6 THEN 'sprite:jump'
      WHEN 7 THEN 'sprite:crouch'
      WHEN 8 THEN 'sprite:hit'
      WHEN 9 THEN 'sprite:ko'
      WHEN 10 THEN 'sprite:victory'
      ELSE gj.stage
    END
    WHEN gj.operation = 'fighter_retry_animation' AND gj.target_name IS NOT NULL
      THEN 'sprite:' || gj.target_name
    WHEN gj.operation = 'fighter_retry_source' AND gj.target_name IS NOT NULL
      THEN 'source:' || gj.target_name
    ELSE gj.stage
  END,
  gj.created_at,
  gj.updated_at,
  CASE WHEN gj.status = 'succeeded' THEN gj.finished_at ELSE NULL END
FROM generation_jobs gj
JOIN fighters f ON f.id = gj.fighter_id
JOIN generation_charges gc ON gc.id = gj.charge_id
LEFT JOIN arcade_fighters af ON af.fighter_id = gj.fighter_id;

ALTER TABLE generation_jobs
  ADD COLUMN artifact_run_id TEXT REFERENCES generation_artifact_runs(id) ON DELETE RESTRICT;

ALTER TABLE generation_jobs
  ADD COLUMN resumed_from_job_id TEXT;

ALTER TABLE generation_jobs
  ADD COLUMN failure_stage TEXT;

UPDATE generation_jobs
SET artifact_run_id = id,
    failure_stage = (
      SELECT failure_stage
      FROM generation_artifact_runs
      WHERE generation_artifact_runs.id = generation_jobs.id
    );

CREATE INDEX idx_generation_jobs_artifact_run
  ON generation_jobs(artifact_run_id, created_at ASC);

-- A migration is applied immediately before the new Worker is deployed. If the
-- previous Worker accepts a job in that short window, attach the durable run it
-- does not yet know how to create so the new Worker can resume it safely.
CREATE TRIGGER generation_jobs_attach_legacy_artifact_run
AFTER INSERT ON generation_jobs
WHEN NEW.artifact_run_id IS NULL
BEGIN
  INSERT INTO generation_artifact_runs (
    id, user_id, fighter_id, tier, operation, target_kind, target_name,
    root_job_id, original_charge_id, original_blob_key, source_manifest_json,
    generation_prompt, status, created_at, updated_at
  )
  SELECT
    NEW.id,
    NEW.user_id,
    NEW.fighter_id,
    NEW.tier,
    NEW.operation,
    NEW.target_kind,
    NEW.target_name,
    NEW.id,
    NEW.charge_id,
    fighter.original_blob_key,
    json_object(
      'side', fighter.side_view_blob_key,
      'sideRaw', fighter.side_view_raw_blob_key,
      'upright', fighter.upright_view_blob_key,
      'uprightRaw', fighter.upright_view_raw_blob_key,
      'crouch', fighter.crouch_view_blob_key,
      'crouchRaw', fighter.crouch_view_raw_blob_key
    ),
    arcade.generation_prompt,
    'active',
    NEW.created_at,
    NEW.updated_at
  FROM fighters fighter
  LEFT JOIN arcade_fighters arcade ON arcade.fighter_id = fighter.id
  WHERE fighter.id = NEW.fighter_id;

  UPDATE generation_jobs
  SET artifact_run_id = NEW.id
  WHERE id = NEW.id AND artifact_run_id IS NULL;
END;

-- Keep a job created by the previous Worker resumable if it finishes while a
-- deployment is rolling out. New Workers also write the richer state directly.
CREATE TRIGGER generation_jobs_sync_legacy_artifact_run
AFTER UPDATE OF status ON generation_jobs
WHEN NEW.artifact_run_id = NEW.id
BEGIN
  UPDATE generation_artifact_runs
  SET status = CASE
        WHEN NEW.status = 'succeeded' THEN 'succeeded'
        WHEN NEW.status IN ('failed', 'cancelled') THEN CASE
          WHEN EXISTS (
            SELECT 1 FROM generation_charges charge
            WHERE charge.id = NEW.charge_id AND charge.status = 'committed'
          ) THEN 'partial'
          ELSE 'failed'
        END
        ELSE 'active'
      END,
      failure_stage = CASE
        WHEN NEW.status NOT IN ('failed', 'cancelled') THEN NULL
        WHEN NEW.failure_stage IS NOT NULL THEN NEW.failure_stage
        WHEN lower(COALESCE(NEW.error_message, '')) LIKE '%low_punch%' THEN 'sprite:low_punch'
        WHEN lower(COALESCE(NEW.error_message, '')) LIKE '%low_kick%' THEN 'sprite:low_kick'
        WHEN lower(COALESCE(NEW.error_message, '')) LIKE '%high_punch%' THEN 'sprite:high_punch'
        WHEN lower(COALESCE(NEW.error_message, '')) LIKE '%high_kick%' THEN 'sprite:high_kick'
        ELSE NEW.stage
      END,
      completed_at = CASE
        WHEN NEW.status = 'succeeded' THEN COALESCE(NEW.finished_at, datetime('now'))
        ELSE NULL
      END,
      updated_at = NEW.updated_at
  WHERE id = NEW.artifact_run_id;
END;

ALTER TABLE generation_charges
  ADD COLUMN continuation_run_id TEXT REFERENCES generation_artifact_runs(id) ON DELETE SET NULL;

ALTER TABLE generation_charges
  ADD COLUMN resumed_from_job_id TEXT;

CREATE INDEX idx_generation_charges_continuation
  ON generation_charges(continuation_run_id, status, created_at DESC)
  WHERE continuation_run_id IS NOT NULL;

CREATE TABLE generation_artifact_checkpoints (
  run_id TEXT NOT NULL REFERENCES generation_artifact_runs(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('source', 'sprite')),
  artifact_name TEXT NOT NULL CHECK (length(artifact_name) BETWEEN 2 AND 64),
  stage_index INTEGER NOT NULL CHECK (stage_index BETWEEN 1 AND 14),
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
  PRIMARY KEY (run_id, artifact_kind, artifact_name)
);

CREATE INDEX idx_generation_artifact_checkpoints_run
  ON generation_artifact_checkpoints(run_id, stage_index ASC);

WITH source_events AS (
  SELECT
    e.job_id,
    e.created_at,
    gj.artifact_run_id AS run_id,
    gj.fighter_id,
    gj.tier,
    substr(e.stage, length('source:') + 1) AS source_name,
    CASE substr(e.stage, length('source:') + 1)
      WHEN 'side' THEN 1
      WHEN 'upright' THEN 2
      WHEN 'crouch' THEN 3
    END AS stage_index
  FROM generation_job_events e
  JOIN generation_jobs gj ON gj.id = e.job_id
  WHERE e.status = 'succeeded'
    AND e.stage IN ('source:side', 'source:upright', 'source:crouch')
)
INSERT OR IGNORE INTO generation_artifact_checkpoints (
  run_id, artifact_kind, artifact_name, stage_index, tier,
  clean_version_id, raw_version_id, clean_blob_key, raw_blob_key,
  clean_content_hash, raw_content_hash, completed_by_job_id, created_at
)
SELECT
  se.run_id,
  'source',
  se.source_name,
  se.stage_index,
  se.tier,
  clean.id,
  raw.id,
  clean.blob_key,
  raw.blob_key,
  clean.content_hash,
  raw.content_hash,
  se.job_id,
  se.created_at
FROM source_events se
JOIN source_versions clean ON clean.id = (
  SELECT candidate.id
  FROM source_versions candidate
  WHERE candidate.fighter_id = se.fighter_id
    AND candidate.kind = se.source_name
    AND datetime(candidate.created_at) <= datetime(se.created_at, '+5 seconds')
  ORDER BY datetime(candidate.created_at) DESC, candidate.rowid DESC
  LIMIT 1
)
JOIN source_versions raw ON raw.id = (
  SELECT candidate.id
  FROM source_versions candidate
  WHERE candidate.fighter_id = se.fighter_id
    AND candidate.kind = se.source_name || '_raw'
    AND datetime(candidate.created_at) <= datetime(se.created_at, '+5 seconds')
  ORDER BY datetime(candidate.created_at) DESC, candidate.rowid DESC
  LIMIT 1
);

WITH sprite_events AS (
  SELECT
    e.job_id,
    e.created_at,
    gj.artifact_run_id AS run_id,
    gj.fighter_id,
    gj.tier,
    substr(e.stage, length('sprite:') + 1) AS animation_name,
    CASE substr(e.stage, length('sprite:') + 1)
      WHEN 'idle' THEN CASE WHEN gj.operation = 'fighter_generation' THEN 4 ELSE 1 END
      WHEN 'walk' THEN CASE WHEN gj.operation = 'fighter_generation' THEN 5 ELSE 2 END
      WHEN 'high_punch' THEN CASE WHEN gj.operation = 'fighter_generation' THEN 6 ELSE 3 END
      WHEN 'high_kick' THEN CASE WHEN gj.operation = 'fighter_generation' THEN 7 ELSE 4 END
      WHEN 'low_punch' THEN CASE WHEN gj.operation = 'fighter_generation' THEN 8 ELSE 5 END
      WHEN 'low_kick' THEN CASE WHEN gj.operation = 'fighter_generation' THEN 9 ELSE 6 END
      WHEN 'jump' THEN CASE WHEN gj.operation = 'fighter_generation' THEN 10 ELSE 7 END
      WHEN 'crouch' THEN CASE WHEN gj.operation = 'fighter_generation' THEN 11 ELSE 8 END
      WHEN 'hit' THEN CASE WHEN gj.operation = 'fighter_generation' THEN 12 ELSE 9 END
      WHEN 'ko' THEN CASE WHEN gj.operation = 'fighter_generation' THEN 13 ELSE 10 END
      WHEN 'victory' THEN CASE WHEN gj.operation = 'fighter_generation' THEN 14 ELSE 11 END
    END AS stage_index
  FROM generation_job_events e
  JOIN generation_jobs gj ON gj.id = e.job_id
  WHERE e.status = 'succeeded'
    AND e.stage LIKE 'sprite:%'
)
INSERT OR IGNORE INTO generation_artifact_checkpoints (
  run_id, artifact_kind, artifact_name, stage_index, tier,
  clean_version_id, clean_blob_key, raw_blob_key,
  clean_content_hash, raw_content_hash,
  frame_w, frame_h, frame_count, processing_version,
  completed_by_job_id, created_at
)
SELECT
  se.run_id,
  'sprite',
  se.animation_name,
  se.stage_index,
  se.tier,
  version.id,
  version.blob_key,
  version.raw_blob_key,
  version.content_hash,
  version.raw_content_hash,
  version.frame_w,
  version.frame_h,
  version.frame_count,
  version.processing_version,
  se.job_id,
  se.created_at
FROM sprite_events se
JOIN sprite_versions version ON version.id = (
  SELECT candidate.id
  FROM sprite_versions candidate
  WHERE candidate.fighter_id = se.fighter_id
    AND candidate.animation_name = se.animation_name
    AND candidate.quality_tier = se.tier
    AND datetime(candidate.created_at) <= datetime(se.created_at, '+5 seconds')
  ORDER BY datetime(candidate.created_at) DESC, candidate.rowid DESC
  LIMIT 1
);

DROP INDEX IF EXISTS idx_provider_request_cache_job;
ALTER TABLE provider_request_cache RENAME TO provider_request_cache_legacy;

CREATE TABLE provider_request_cache (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL,
  artifact_run_id TEXT REFERENCES generation_artifact_runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('gemini', 'ludo', 'freepik', 'runway', 'fal')),
  method TEXT NOT NULL,
  request_path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'succeeded', 'failed', 'uncertain'
  )),
  response_blob_key TEXT,
  response_status INTEGER,
  response_content_type TEXT,
  owner_attempt_id TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job_id, provider, method, request_path, request_hash),
  UNIQUE(artifact_run_id, provider, method, request_path, request_hash)
);

INSERT INTO provider_request_cache (
  id, job_id, artifact_run_id, provider, method, request_path, request_hash,
  request_key, status, response_blob_key, response_status,
  response_content_type, owner_attempt_id, error_message, created_at, updated_at
)
SELECT
  legacy.id,
  legacy.job_id,
  jobs.artifact_run_id,
  legacy.provider,
  legacy.method,
  legacy.request_path,
  legacy.request_hash,
  NULL,
  legacy.status,
  legacy.response_blob_key,
  legacy.response_status,
  legacy.response_content_type,
  legacy.owner_attempt_id,
  legacy.error_message,
  legacy.created_at,
  legacy.updated_at
FROM provider_request_cache_legacy legacy
JOIN generation_jobs jobs ON jobs.id = legacy.job_id;

DROP TABLE provider_request_cache_legacy;

CREATE INDEX idx_provider_request_cache_job
  ON provider_request_cache(job_id, created_at ASC);

CREATE INDEX idx_provider_request_cache_run
  ON provider_request_cache(artifact_run_id, created_at ASC);

-- The previous Worker omits artifact_run_id. Delete only those new cache
-- claims, making it return 503 before dispatch instead of risking a paid call
-- that the durable run cannot identify. Existing succeeded rows remain usable.
CREATE TRIGGER provider_request_cache_reject_legacy_dispatch
AFTER INSERT ON provider_request_cache
WHEN NEW.artifact_run_id IS NULL
BEGIN
  DELETE FROM provider_request_cache WHERE id = NEW.id;
END;

ALTER TABLE provider_cost_events ADD COLUMN job_id TEXT;
ALTER TABLE provider_cost_events ADD COLUMN artifact_run_id TEXT;
ALTER TABLE provider_cost_events ADD COLUMN request_key TEXT;
ALTER TABLE provider_cost_events ADD COLUMN call_kind TEXT NOT NULL DEFAULT 'unclassified';
ALTER TABLE provider_cost_events ADD COLUMN stage TEXT;
ALTER TABLE provider_cost_events ADD COLUMN upstream_outcome TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE provider_cost_events ADD COLUMN stage_outcome TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE provider_cost_events ADD COLUMN job_outcome TEXT NOT NULL DEFAULT 'in_progress';

UPDATE provider_cost_events
SET job_id = (
      SELECT gj.id
      FROM generation_jobs gj
      WHERE gj.provider_session_id = provider_cost_events.session_id
      LIMIT 1
    ),
    artifact_run_id = (
      SELECT gj.artifact_run_id
      FROM generation_jobs gj
      WHERE gj.provider_session_id = provider_cost_events.session_id
      LIMIT 1
    ),
    call_kind = CASE
      WHEN provider = 'fal' AND model_path LIKE '%birefnet%' THEN 'background_removal'
      WHEN provider = 'freepik' AND model_path LIKE '%remove-background%' THEN 'background_removal'
      ELSE 'unclassified'
    END,
    upstream_outcome = CASE outcome
      WHEN 'succeeded' THEN 'http_succeeded'
      WHEN 'failed' THEN 'http_failed'
      ELSE 'pending'
    END,
    job_outcome = COALESCE((
      SELECT CASE gj.status
        WHEN 'succeeded' THEN 'succeeded'
        WHEN 'failed' THEN CASE
          WHEN gj.progress_current > 0 THEN 'failed_partial'
          ELSE 'failed'
        END
        WHEN 'cancelled' THEN 'cancelled'
        ELSE 'in_progress'
      END
      FROM generation_jobs gj
      WHERE gj.provider_session_id = provider_cost_events.session_id
      LIMIT 1
    ), 'in_progress');

CREATE INDEX idx_provider_cost_events_job
  ON provider_cost_events(job_id, created_at ASC)
  WHERE job_id IS NOT NULL;

CREATE INDEX idx_provider_cost_events_run_stage
  ON provider_cost_events(artifact_run_id, stage, created_at ASC)
  WHERE artifact_run_id IS NOT NULL;
