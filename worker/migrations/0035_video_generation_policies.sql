-- Split Video product behavior without adding a public creation flow. Existing
-- Video runs keep the former prompt and motion-based cherry-picking contract;
-- only newly-created public runs opt into the guided self-service policy.
ALTER TABLE generation_artifact_runs
  ADD COLUMN video_generation_policy TEXT
  CHECK (
    video_generation_policy IS NULL OR
    video_generation_policy IN ('studio_curated_v1', 'self_service_v1')
  );

UPDATE generation_artifact_runs
SET video_generation_policy = 'studio_curated_v1'
WHERE creation_flow = 'video' AND video_generation_policy IS NULL;

CREATE INDEX idx_generation_artifact_runs_video_policy
  ON generation_artifact_runs(fighter_id, video_generation_policy, status, updated_at DESC)
  WHERE creation_flow = 'video';
