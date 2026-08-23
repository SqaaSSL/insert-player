CREATE TABLE IF NOT EXISTS arcade_fighters (
  fighter_id TEXT PRIMARY KEY REFERENCES fighters(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  sort_order INTEGER NOT NULL CHECK (sort_order BETWEEN 1 AND 999),
  challenger_line TEXT NOT NULL CHECK (length(challenger_line) BETWEEN 1 AND 120),
  default_personality TEXT NOT NULL DEFAULT 'balanced' CHECK (default_personality IN (
    'balanced', 'brawler', 'counter', 'zoner', 'showboat'
  )),
  reference_kind TEXT NOT NULL CHECK (reference_kind IN ('generated', 'licensed')),
  reference_source_url TEXT,
  reference_license TEXT NOT NULL,
  reference_credit TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (reference_kind = 'generated' AND reference_source_url IS NULL)
    OR
    (reference_kind = 'licensed' AND reference_source_url LIKE 'https://%')
  )
);

CREATE INDEX IF NOT EXISTS idx_arcade_fighters_active
  ON arcade_fighters(status, sort_order, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_arcade_fighters_live_slug
  ON arcade_fighters(slug)
  WHERE status IN ('draft', 'active');
