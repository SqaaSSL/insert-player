-- First-party client crash reports. Operational data only: bounded error
-- text and pipeline debug tail, no photos, no fighter content, no raw IPs.
-- Rows are purged by scheduled maintenance after 30 days.
CREATE TABLE client_errors (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  clerk_user_id TEXT,
  route TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  debug_tail TEXT,
  app_context TEXT,
  user_agent TEXT
);

CREATE INDEX idx_client_errors_created_at ON client_errors (created_at);
