CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  workflow_instance_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
  charge_id TEXT NOT NULL REFERENCES generation_charges(id) ON DELETE RESTRICT,
  provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id) ON DELETE RESTRICT,
  tier TEXT NOT NULL CHECK (tier IN ('rookie', 'contender', 'champion')),
  operation TEXT NOT NULL CHECK (operation IN ('fighter_generation', 'fighter_upgrade')),
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
  UNIQUE(provider_session_id)
);

CREATE INDEX IF NOT EXISTS idx_generation_jobs_user
  ON generation_jobs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generation_jobs_fighter
  ON generation_jobs(fighter_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generation_jobs_status
  ON generation_jobs(status, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_jobs_active_fighter
  ON generation_jobs(fighter_id)
  WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS generation_job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_generation_job_events_job
  ON generation_job_events(job_id, created_at ASC);

CREATE TABLE IF NOT EXISTS provider_request_cache (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_provider_request_cache_job
  ON provider_request_cache(job_id, created_at ASC);
