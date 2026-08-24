CREATE TABLE fighter_asset_deletions (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  fighter_id TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('fighter_deleted', 'user_deleted', 'incident_reconcile')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(fighter_id, blob_key)
);

CREATE INDEX idx_fighter_asset_deletions_pending
  ON fighter_asset_deletions(updated_at ASC, fighter_id);

-- generation_jobs and generation_artifact_runs both cascade from fighters,
-- while jobs restrict deletion of their artifact run. Release that internal
-- reference first so fighter deletion can complete atomically in D1.
CREATE TRIGGER generation_jobs_release_artifact_run_before_fighter_delete
BEFORE DELETE ON fighters
BEGIN
  UPDATE generation_jobs
  SET artifact_run_id = NULL
  WHERE fighter_id = OLD.id;
END;
