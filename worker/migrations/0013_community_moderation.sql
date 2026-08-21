CREATE TABLE IF NOT EXISTS community_reports (
  id TEXT PRIMARY KEY,
  fighter_id TEXT NOT NULL,
  fighter_owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  fighter_name TEXT NOT NULL,
  reporter_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (reason IN (
    'non_consensual_person',
    'sexual_content',
    'hate_or_harassment',
    'graphic_violence',
    'copyright_or_trademark',
    'personal_information',
    'spam',
    'other'
  )),
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open',
    'reviewing',
    'dismissed',
    'actioned'
  )),
  submission_count INTEGER NOT NULL DEFAULT 1 CHECK (submission_count >= 1),
  reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  moderation_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(fighter_id, reporter_user_id)
);

CREATE INDEX IF NOT EXISTS idx_community_reports_queue
  ON community_reports(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_reports_fighter
  ON community_reports(fighter_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_reports_reporter
  ON community_reports(reporter_user_id, updated_at DESC);
