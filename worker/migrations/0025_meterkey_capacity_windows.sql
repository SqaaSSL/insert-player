-- Daily limits are scoped to the upstream credential/project. Preserve the
-- historical direct-Google windows while giving Meterkey's distinct Google
-- BYOK transport an independent fail-closed capacity window.
CREATE TABLE IF NOT EXISTS provider_meterkey_capacity_windows (
  provider TEXT NOT NULL CHECK (provider = 'gemini'),
  model TEXT NOT NULL CHECK (model IN ('gemini-3-pro-image', 'gemini-3.1-flash-image')),
  reason TEXT NOT NULL CHECK (reason = 'daily_quota_exhausted'),
  retry_at_epoch INTEGER NOT NULL CHECK (retry_at_epoch > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, model)
);

CREATE INDEX IF NOT EXISTS idx_provider_meterkey_capacity_windows_retry
ON provider_meterkey_capacity_windows(retry_at_epoch);
