-- A Crew receives one immutable shared stage. A reservation is created before
-- an included AI forge starts, so concurrent admins cannot mint extra stages.
CREATE TABLE crew_stages (
  clerk_organization_id TEXT PRIMARY KEY
    CHECK (
      length(clerk_organization_id) BETWEEN 1 AND 128
      AND clerk_organization_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  id TEXT NOT NULL UNIQUE
    CHECK (length(id) = 32 AND id NOT GLOB '*[^a-f0-9]*'),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  generation_charge_id TEXT UNIQUE REFERENCES generation_charges(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'ready')),
  label TEXT NOT NULL DEFAULT 'CREW STAGE',
  kind TEXT CHECK (kind IS NULL OR kind IN ('photo', 'photo-direct')),
  blob_key TEXT,
  content_hash TEXT
    CHECK (content_hash IS NULL OR (length(content_hash) = 64 AND content_hash NOT GLOB '*[^a-f0-9]*')),
  source_json TEXT CHECK (source_json IS NULL OR json_valid(source_json)),
  reservation_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (status = 'reserved' AND blob_key IS NULL AND content_hash IS NULL)
    OR
    (status = 'ready' AND blob_key IS NOT NULL AND content_hash IS NOT NULL AND kind IS NOT NULL)
  )
);

CREATE INDEX idx_crew_stages_creator
  ON crew_stages(created_by_user_id, created_at DESC);

CREATE INDEX idx_crew_stages_charge
  ON crew_stages(generation_charge_id)
  WHERE generation_charge_id IS NOT NULL;
