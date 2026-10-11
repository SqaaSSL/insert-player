-- Headroom derivatives of a reviewed canonical RAW source, used only as IMAGE 1
-- for review-gated extra Video moves. A Champion whose reviewed side RAW fills
-- almost the whole frame (Elon Musk, Rosalía) leaves no room for an overhead
-- fist, so the extra move is generated from the same pixels scaled down about
-- the floor line and padded with the source's own chroma green.
--
-- The derivative never replaces the reviewed source: source proofs, sealed
-- manifests, fighters pointers and live sprites keep binding the original. A
-- candidate revision may record the derivative as its canonical only when a row
-- here ties that exact derived blob and digest to the sealed RAW version and
-- digest it was computed from. Rows are immutable.
CREATE TABLE canonical_headroom_derivatives (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('side', 'crouch')),
  source_raw_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE RESTRICT,
  source_raw_sha256 TEXT NOT NULL CHECK (length(source_raw_sha256) = 64),
  derived_blob_key TEXT NOT NULL UNIQUE,
  derived_sha256 TEXT NOT NULL CHECK (length(derived_sha256) = 64),
  transform_json TEXT NOT NULL CHECK (json_valid(transform_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(fighter_id, source_kind, source_raw_sha256),
  CHECK (derived_sha256 <> source_raw_sha256)
);

CREATE TRIGGER canonical_headroom_derivatives_immutable
BEFORE UPDATE ON canonical_headroom_derivatives
BEGIN
  SELECT RAISE(ABORT, 'canonical_headroom_derivatives rows are immutable');
END;
