-- Clips are explicitly published, unlisted recordings. Capability secrets are
-- hashed; owner identity is never included in public metadata.
CREATE TABLE aura_clips (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  owner_user_id TEXT,
  challenge_token TEXT NOT NULL CHECK (length(challenge_token) BETWEEN 1 AND 2048),
  content_type TEXT NOT NULL CHECK (content_type IN ('video/mp4', 'video/webm')),
  has_poster INTEGER NOT NULL DEFAULT 0 CHECK (has_poster IN (0, 1)),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 16 AND 67108864),
  upload_token_hash TEXT NOT NULL CHECK (length(upload_token_hash) = 64),
  delete_token_hash TEXT NOT NULL CHECK (length(delete_token_hash) = 64),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'uploading', 'ready', 'revoked', 'failed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_aura_clips_expiry ON aura_clips(expires_at);
CREATE INDEX idx_aura_clips_owner ON aura_clips(owner_user_id);
