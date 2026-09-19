-- Anonymous daily sums only. No individual event rows, account identifiers,
-- cookies, IPs, referrers or campaign strings are stored in this table.
CREATE TABLE product_event_daily (
  day TEXT NOT NULL CHECK (length(day) = 10),
  event_name TEXT NOT NULL,
  channel TEXT NOT NULL,
  source TEXT NOT NULL,
  game TEXT NOT NULL,
  tier TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  duration_count INTEGER NOT NULL DEFAULT 0 CHECK (duration_count >= 0),
  duration_ms_total INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms_total >= 0),
  PRIMARY KEY (day, event_name, channel, source, game, tier)
);
