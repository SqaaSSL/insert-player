-- The renderer choice is an additive, immutable part of a paid generation.
-- Existing clients and rows remain on the established image-sheet pipeline.
ALTER TABLE generation_charges
  ADD COLUMN creation_flow TEXT NOT NULL DEFAULT 'original'
  CHECK (creation_flow IN ('original', 'video'));

ALTER TABLE provider_sessions
  ADD COLUMN creation_flow TEXT NOT NULL DEFAULT 'original'
  CHECK (creation_flow IN ('original', 'video'));

ALTER TABLE generation_jobs
  ADD COLUMN creation_flow TEXT NOT NULL DEFAULT 'original'
  CHECK (creation_flow IN ('original', 'video'));

ALTER TABLE generation_artifact_runs
  ADD COLUMN creation_flow TEXT NOT NULL DEFAULT 'original'
  CHECK (creation_flow IN ('original', 'video'));
