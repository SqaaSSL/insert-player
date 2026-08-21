CREATE TABLE IF NOT EXISTS clerk_webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clerk_webhook_events_processed
  ON clerk_webhook_events(processed_at DESC);

-- Hashing the Clerk subject prevents a recently issued JWT from recreating a
-- deleted account without retaining the user's Clerk identifier in clear text.
CREATE TABLE IF NOT EXISTS clerk_user_tombstones (
  subject_hash TEXT PRIMARY KEY,
  webhook_event_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clerk_user_tombstones_deleted
  ON clerk_user_tombstones(deleted_at DESC);
