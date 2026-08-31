-- Shareable online-versus invitations. The public URL contains only an
-- unguessable token; D1 keeps its SHA-256 hash and the immutable fighter
-- snapshot used by the social card.
CREATE TABLE versus_invitations (
  token_hash TEXT PRIMARY KEY
    CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  room_code TEXT NOT NULL CHECK (length(room_code) = 6),
  host_user_id TEXT NOT NULL,
  fighter_id TEXT NOT NULL,
  fighter_name TEXT NOT NULL,
  fighter_quality_tier TEXT NOT NULL
    CHECK (fighter_quality_tier IN ('rookie', 'contender', 'champion')),
  fighter_source_kind TEXT NOT NULL
    CHECK (fighter_source_kind IN ('side', 'upright', 'crouch', 'idle')),
  fighter_source_blob_key TEXT NOT NULL,
  template_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_versus_invitations_expiry
  ON versus_invitations(expires_at);

CREATE INDEX idx_versus_invitations_host_room
  ON versus_invitations(host_user_id, room_code, created_at DESC);
