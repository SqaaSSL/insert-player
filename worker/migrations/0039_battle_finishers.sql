-- Paid battle media is owned, durable, and private until explicitly published.
-- Tombstones survive account deletion until maintenance confirms R2 removal.
CREATE TABLE battle_media (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT,
  client_battle_id TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  still_sha256 TEXT NOT NULL,
  storage_prefix TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing','ready','revoked')),
  cleanup_at TEXT,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  recording_type TEXT CHECK (recording_type IN ('video/mp4','video/webm')),
  recording_sha256 TEXT,
  recording_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id, client_battle_id)
);
CREATE INDEX idx_battle_media_owner ON battle_media(owner_user_id, created_at DESC);
CREATE TABLE battle_finisher_jobs (
  id TEXT PRIMARY KEY,
  battle_id TEXT NOT NULL REFERENCES battle_media(id) ON DELETE CASCADE,
  owner_user_id TEXT,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','submitting','generating','ready','failed')),
  credit_state TEXT NOT NULL CHECK (credit_state IN ('reserved','spent','refunded')),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  provider_attempt_id TEXT,
  provider_request_id TEXT,
  provider_status_url TEXT,
  provider_response_url TEXT,
  provider_cost_cents INTEGER NOT NULL DEFAULT 20,
  provider_audit_json TEXT,
  video_sha256 TEXT,
  video_bytes INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id, request_id)
);
CREATE INDEX idx_battle_finisher_jobs_battle ON battle_finisher_jobs(battle_id, created_at DESC);
CREATE UNIQUE INDEX idx_battle_finisher_active ON battle_finisher_jobs(battle_id)
  WHERE status IN ('queued','submitting','generating','ready');
