PRAGMA defer_foreign_keys = ON;

DROP INDEX IF EXISTS idx_provider_request_cache_job;
DROP INDEX IF EXISTS idx_generation_job_events_job;
DROP INDEX IF EXISTS idx_generation_jobs_status;
DROP INDEX IF EXISTS idx_generation_jobs_fighter;
DROP INDEX IF EXISTS idx_generation_jobs_user;
DROP INDEX IF EXISTS idx_generation_jobs_active_fighter;

CREATE TABLE generation_jobs_v2 (
  id TEXT PRIMARY KEY,
  workflow_instance_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
  charge_id TEXT NOT NULL REFERENCES generation_charges(id) ON DELETE RESTRICT,
  provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id) ON DELETE RESTRICT,
  tier TEXT NOT NULL CHECK (tier IN ('rookie', 'contender', 'champion')),
  operation TEXT NOT NULL CHECK (operation IN (
    'fighter_generation',
    'fighter_upgrade',
    'fighter_retry_animation',
    'fighter_retry_source'
  )),
  target_kind TEXT CHECK (target_kind IS NULL OR target_kind IN ('animation', 'source')),
  target_name TEXT CHECK (target_name IS NULL OR length(target_name) BETWEEN 1 AND 64),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'running', 'succeeded', 'failed', 'cancelled'
  )),
  stage TEXT NOT NULL DEFAULT 'queued',
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 14,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(charge_id),
  UNIQUE(provider_session_id),
  CHECK (
    (operation IN ('fighter_generation', 'fighter_upgrade') AND target_kind IS NULL AND target_name IS NULL)
    OR (operation = 'fighter_retry_animation' AND target_kind = 'animation' AND target_name IS NOT NULL)
    OR (operation = 'fighter_retry_source' AND target_kind = 'source' AND target_name IS NOT NULL)
  )
);

INSERT INTO generation_jobs_v2 (
  id, workflow_instance_id, user_id, fighter_id, charge_id, provider_session_id,
  tier, operation, target_kind, target_name, status, stage, progress_current,
  progress_total, error_code, error_message, started_at, finished_at, created_at,
  updated_at
)
SELECT
  id, workflow_instance_id, user_id, fighter_id, charge_id, provider_session_id,
  tier, operation, NULL, NULL, status, stage, progress_current, progress_total,
  error_code, error_message, started_at, finished_at, created_at, updated_at
FROM generation_jobs;

CREATE TABLE generation_job_events_v2 (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES generation_jobs_v2(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO generation_job_events_v2 (id, job_id, stage, status, detail, created_at)
SELECT id, job_id, stage, status, detail, created_at
FROM generation_job_events;

CREATE TABLE provider_request_cache_v2 (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES generation_jobs_v2(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('gemini', 'ludo', 'freepik', 'runway', 'fal')),
  method TEXT NOT NULL,
  request_path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  response_blob_key TEXT,
  response_status INTEGER,
  response_content_type TEXT,
  owner_attempt_id TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job_id, provider, method, request_path, request_hash)
);

INSERT INTO provider_request_cache_v2 (
  id, job_id, provider, method, request_path, request_hash, status,
  response_blob_key, response_status, response_content_type, owner_attempt_id,
  error_message, created_at, updated_at
)
SELECT
  id, job_id, provider, method, request_path, request_hash, status,
  response_blob_key, response_status, response_content_type, owner_attempt_id,
  error_message, created_at, updated_at
FROM provider_request_cache;

DROP TABLE provider_request_cache;
DROP TABLE generation_job_events;
DROP TABLE generation_jobs;

ALTER TABLE generation_jobs_v2 RENAME TO generation_jobs;
ALTER TABLE generation_job_events_v2 RENAME TO generation_job_events;
ALTER TABLE provider_request_cache_v2 RENAME TO provider_request_cache;

CREATE INDEX idx_generation_jobs_user
  ON generation_jobs(user_id, created_at DESC);

CREATE INDEX idx_generation_jobs_fighter
  ON generation_jobs(fighter_id, created_at DESC);

CREATE INDEX idx_generation_jobs_status
  ON generation_jobs(status, updated_at);

CREATE UNIQUE INDEX idx_generation_jobs_active_fighter
  ON generation_jobs(fighter_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX idx_generation_job_events_job
  ON generation_job_events(job_id, created_at ASC);

CREATE INDEX idx_provider_request_cache_job
  ON provider_request_cache(job_id, created_at ASC);
