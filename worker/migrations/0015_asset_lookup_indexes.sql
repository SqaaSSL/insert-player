-- Asset reads are on the hot path for cross-device roster sync and community play.
-- Keep owner reads namespace-only and make the three public lookup paths indexed.
CREATE INDEX IF NOT EXISTS idx_fighters_side_view_blob
ON fighters(side_view_blob_key)
WHERE side_view_blob_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fighters_upright_view_blob
ON fighters(upright_view_blob_key)
WHERE upright_view_blob_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fighters_crouch_view_blob
ON fighters(crouch_view_blob_key)
WHERE crouch_view_blob_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sprites_blob
ON sprites(blob_key);

CREATE INDEX IF NOT EXISTS idx_stages_blob
ON stages(blob_key);
