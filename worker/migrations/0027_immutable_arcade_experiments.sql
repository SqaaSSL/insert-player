CREATE TABLE arcade_generation_experiments (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 128),
  schema_version INTEGER NOT NULL,
  matrix_sha256 TEXT NOT NULL CHECK (length(matrix_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('complete', 'incomplete')),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  index_content_hash TEXT NOT NULL CHECK (length(index_content_hash) = 64),
  slot_count INTEGER NOT NULL CHECK (slot_count > 0),
  artifact_count INTEGER NOT NULL CHECK (artifact_count > 0),
  state_blob_key TEXT NOT NULL UNIQUE,
  state_content_hash TEXT NOT NULL CHECK (length(state_content_hash) = 64),
  state_size_bytes INTEGER NOT NULL CHECK (state_size_bytes > 0),
  manifest_blob_key TEXT NOT NULL UNIQUE,
  manifest_content_hash TEXT NOT NULL CHECK (length(manifest_content_hash) = 64),
  manifest_size_bytes INTEGER NOT NULL CHECK (manifest_size_bytes > 0),
  github_repository TEXT NOT NULL,
  github_run_id INTEGER NOT NULL CHECK (github_run_id > 0),
  source_created_at TEXT,
  source_completed_at TEXT,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE arcade_generation_experiment_slots (
  experiment_id TEXT NOT NULL REFERENCES arcade_generation_experiments(id) ON DELETE RESTRICT,
  slot_key TEXT NOT NULL,
  fighter_slug TEXT NOT NULL,
  fighter_name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider_endpoint TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  prompt_sha256 TEXT NOT NULL CHECK (length(prompt_sha256) = 64),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'submission_rejected')),
  pixcli_job_id TEXT,
  provider_request_id TEXT,
  pixcli_cost_estimate INTEGER CHECK (pixcli_cost_estimate IS NULL OR pixcli_cost_estimate >= 0),
  image_content_hash TEXT CHECK (image_content_hash IS NULL OR length(image_content_hash) = 64),
  completed_at TEXT,
  PRIMARY KEY (experiment_id, slot_key)
);

CREATE TABLE arcade_generation_experiment_artifacts (
  experiment_id TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK (
    artifact_kind IN ('provider_request', 'provider_response', 'image', 'job_failure')
  ),
  blob_key TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  pixcli_asset_hash TEXT,
  provider_request_id TEXT,
  archived_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (experiment_id, slot_key, artifact_kind),
  FOREIGN KEY (experiment_id, slot_key)
    REFERENCES arcade_generation_experiment_slots(experiment_id, slot_key)
    ON DELETE RESTRICT
);

CREATE INDEX idx_arcade_generation_experiment_slots_fighter
  ON arcade_generation_experiment_slots(fighter_slug, experiment_id);

CREATE INDEX idx_arcade_generation_experiment_artifacts_hash
  ON arcade_generation_experiment_artifacts(content_sha256);

CREATE TRIGGER arcade_generation_experiments_immutable_update
BEFORE UPDATE ON arcade_generation_experiments
BEGIN
  SELECT RAISE(ABORT, 'arcade generation experiments are immutable');
END;

CREATE TRIGGER arcade_generation_experiments_immutable_delete
BEFORE DELETE ON arcade_generation_experiments
BEGIN
  SELECT RAISE(ABORT, 'arcade generation experiments are immutable');
END;

CREATE TRIGGER arcade_generation_experiment_slots_immutable_update
BEFORE UPDATE ON arcade_generation_experiment_slots
BEGIN
  SELECT RAISE(ABORT, 'arcade generation experiment slots are immutable');
END;

CREATE TRIGGER arcade_generation_experiment_slots_immutable_delete
BEFORE DELETE ON arcade_generation_experiment_slots
BEGIN
  SELECT RAISE(ABORT, 'arcade generation experiment slots are immutable');
END;

CREATE TRIGGER arcade_generation_experiment_artifacts_immutable_update
BEFORE UPDATE ON arcade_generation_experiment_artifacts
BEGIN
  SELECT RAISE(ABORT, 'arcade generation experiment artifacts are immutable');
END;

CREATE TRIGGER arcade_generation_experiment_artifacts_immutable_delete
BEFORE DELETE ON arcade_generation_experiment_artifacts
BEGIN
  SELECT RAISE(ABORT, 'arcade generation experiment artifacts are immutable');
END;
