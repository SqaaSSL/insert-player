-- Existing charges, runs and fighters retain the complete combat contract.
ALTER TABLE generation_charges ADD COLUMN creation_package TEXT NOT NULL DEFAULT 'complete' CHECK (creation_package IN ('complete', 'aura'));
ALTER TABLE generation_charges ADD COLUMN expansion_only INTEGER NOT NULL DEFAULT 0 CHECK (expansion_only IN (0, 1));
ALTER TABLE generation_charges ADD COLUMN animation_plan_json TEXT;
ALTER TABLE generation_jobs ADD COLUMN creation_package TEXT NOT NULL DEFAULT 'complete' CHECK (creation_package IN ('complete', 'aura'));
ALTER TABLE generation_jobs ADD COLUMN expansion_only INTEGER NOT NULL DEFAULT 0 CHECK (expansion_only IN (0, 1));
ALTER TABLE generation_jobs ADD COLUMN animation_plan_json TEXT;
ALTER TABLE generation_artifact_runs ADD COLUMN creation_package TEXT NOT NULL DEFAULT 'complete' CHECK (creation_package IN ('complete', 'aura'));
ALTER TABLE generation_artifact_runs ADD COLUMN expansion_only INTEGER NOT NULL DEFAULT 0 CHECK (expansion_only IN (0, 1));
ALTER TABLE generation_artifact_runs ADD COLUMN animation_plan_json TEXT;
