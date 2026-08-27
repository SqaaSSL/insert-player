PRAGMA defer_foreign_keys = ON;

DROP TRIGGER IF EXISTS provider_request_cache_reject_legacy_dispatch;
DROP INDEX IF EXISTS idx_provider_request_cache_job;
DROP INDEX IF EXISTS idx_provider_request_cache_run;
DROP INDEX IF EXISTS idx_provider_request_cache_pixcli_dispatch;

ALTER TABLE provider_request_cache RENAME TO provider_request_cache_legacy;

CREATE TABLE provider_request_cache (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL,
  artifact_run_id TEXT REFERENCES generation_artifact_runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN (
    'gemini', 'ludo', 'freepik', 'runway', 'fal', 'pixcli'
  )),
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
  id, job_id, artifact_run_id, provider, method, request_path, request_hash,
  request_key, status, response_blob_key, response_status,
  response_content_type, owner_attempt_id, error_message, created_at, updated_at
FROM provider_request_cache_legacy;

DROP TABLE provider_request_cache_legacy;

CREATE INDEX idx_provider_request_cache_job
  ON provider_request_cache(job_id, created_at ASC);

CREATE INDEX idx_provider_request_cache_run
  ON provider_request_cache(artifact_run_id, created_at ASC);

-- PixCLI's paid advanced submit is one semantic dispatch per durable run and
-- animation. Its caller may recreate multipart uploads or JSON with different
-- bytes after a restart; those changes must never create another paid job.
CREATE UNIQUE INDEX idx_provider_request_cache_pixcli_dispatch
  ON provider_request_cache(artifact_run_id, request_path, request_key)
  WHERE provider = 'pixcli'
    AND method = 'POST'
    AND request_path = '/proxy/pixcli/api/v1/video/advanced'
    AND request_key IS NOT NULL;

CREATE TRIGGER provider_request_cache_reject_legacy_dispatch
AFTER INSERT ON provider_request_cache
WHEN NEW.artifact_run_id IS NULL
BEGIN
  DELETE FROM provider_request_cache WHERE id = NEW.id;
END;

DROP INDEX IF EXISTS idx_provider_cost_events_created;
DROP INDEX IF EXISTS idx_provider_cost_events_operation;
DROP INDEX IF EXISTS idx_provider_cost_events_charge;
DROP INDEX IF EXISTS idx_provider_cost_events_job;
DROP INDEX IF EXISTS idx_provider_cost_events_run_stage;

ALTER TABLE provider_cost_events RENAME TO provider_cost_events_legacy;

CREATE TABLE provider_cost_events (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES provider_sessions(id) ON DELETE SET NULL,
  charge_id TEXT REFERENCES generation_charges(id) ON DELETE SET NULL,
  tier TEXT NOT NULL CHECK (tier IN ('rookie', 'contender', 'champion')),
  purpose TEXT NOT NULL CHECK (purpose IN (
    'fighter_generation',
    'fighter_retry',
    'fighter_upgrade',
    'stage_background',
    'intro_video'
  )),
  billing_operation TEXT CHECK (billing_operation IS NULL OR billing_operation IN (
    'fighter_generation',
    'fighter_upgrade',
    'fighter_retry_animation',
    'fighter_retry_source'
  )),
  provider TEXT NOT NULL CHECK (provider IN (
    'gemini', 'ludo', 'freepik', 'runway', 'fal', 'pixcli'
  )),
  model_path TEXT NOT NULL CHECK (length(model_path) BETWEEN 1 AND 512),
  estimated_cost_cents INTEGER NOT NULL CHECK (estimated_cost_cents >= 0),
  outcome TEXT NOT NULL DEFAULT 'reserved' CHECK (outcome IN (
    'reserved', 'succeeded', 'failed'
  )),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finalized_at TEXT,
  job_id TEXT,
  artifact_run_id TEXT,
  request_key TEXT,
  call_kind TEXT NOT NULL DEFAULT 'unclassified',
  stage TEXT,
  upstream_outcome TEXT NOT NULL DEFAULT 'pending',
  stage_outcome TEXT NOT NULL DEFAULT 'pending',
  job_outcome TEXT NOT NULL DEFAULT 'in_progress'
);

INSERT INTO provider_cost_events (
  id, session_id, charge_id, tier, purpose, billing_operation,
  provider, model_path, estimated_cost_cents, outcome, http_status,
  created_at, finalized_at, job_id, artifact_run_id, request_key,
  call_kind, stage, upstream_outcome, stage_outcome, job_outcome
)
SELECT
  id, session_id, charge_id, tier, purpose, billing_operation,
  provider, model_path, estimated_cost_cents, outcome, http_status,
  created_at, finalized_at, job_id, artifact_run_id, request_key,
  call_kind, stage, upstream_outcome, stage_outcome, job_outcome
FROM provider_cost_events_legacy;

DROP TABLE provider_cost_events_legacy;

CREATE INDEX idx_provider_cost_events_created
  ON provider_cost_events(created_at DESC);

CREATE INDEX idx_provider_cost_events_operation
  ON provider_cost_events(billing_operation, outcome, created_at DESC);

CREATE INDEX idx_provider_cost_events_charge
  ON provider_cost_events(charge_id, created_at ASC)
  WHERE charge_id IS NOT NULL;

CREATE INDEX idx_provider_cost_events_job
  ON provider_cost_events(job_id, created_at ASC)
  WHERE job_id IS NOT NULL;

CREATE INDEX idx_provider_cost_events_run_stage
  ON provider_cost_events(artifact_run_id, stage, created_at ASC)
  WHERE artifact_run_id IS NOT NULL;
