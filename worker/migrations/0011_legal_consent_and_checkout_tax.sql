ALTER TABLE provider_sessions
  ADD COLUMN legal_version TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE provider_sessions
  ADD COLUMN age_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (age_confirmed IN (0, 1));
ALTER TABLE provider_sessions
  ADD COLUMN photo_rights_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (photo_rights_confirmed IN (0, 1));
ALTER TABLE provider_sessions
  ADD COLUMN ai_processing_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (ai_processing_confirmed IN (0, 1));
ALTER TABLE provider_sessions
  ADD COLUMN immediate_performance_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (immediate_performance_confirmed IN (0, 1));
ALTER TABLE provider_sessions
  ADD COLUMN withdrawal_loss_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (withdrawal_loss_acknowledged IN (0, 1));

ALTER TABLE users
  ADD COLUMN stripe_customer_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer
  ON users(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

ALTER TABLE checkout_sessions
  ADD COLUMN legal_version TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE checkout_sessions
  ADD COLUMN terms_accepted INTEGER NOT NULL DEFAULT 0 CHECK (terms_accepted IN (0, 1));
ALTER TABLE checkout_sessions
  ADD COLUMN immediate_delivery_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (immediate_delivery_confirmed IN (0, 1));
ALTER TABLE checkout_sessions
  ADD COLUMN withdrawal_loss_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (withdrawal_loss_acknowledged IN (0, 1));
ALTER TABLE checkout_sessions
  ADD COLUMN stripe_customer_id TEXT;

CREATE TABLE IF NOT EXISTS legal_acceptances (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  subject_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'fighter_generation',
    'fighter_retry',
    'fighter_upgrade',
    'stage_background',
    'intro_video',
    'credit_checkout'
  )),
  context_id TEXT NOT NULL,
  legal_version TEXT NOT NULL,
  age_confirmed INTEGER NOT NULL CHECK (age_confirmed IN (0, 1)),
  terms_accepted INTEGER NOT NULL CHECK (terms_accepted IN (0, 1)),
  photo_rights_confirmed INTEGER NOT NULL CHECK (photo_rights_confirmed IN (0, 1)),
  ai_processing_confirmed INTEGER NOT NULL CHECK (ai_processing_confirmed IN (0, 1)),
  immediate_performance_confirmed INTEGER NOT NULL CHECK (immediate_performance_confirmed IN (0, 1)),
  refund_policy_acknowledged INTEGER NOT NULL CHECK (refund_policy_acknowledged IN (0, 1)),
  immediate_delivery_confirmed INTEGER NOT NULL CHECK (immediate_delivery_confirmed IN (0, 1)),
  withdrawal_loss_acknowledged INTEGER NOT NULL CHECK (withdrawal_loss_acknowledged IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_legal_acceptances_context
  ON legal_acceptances(action, context_id);
CREATE INDEX IF NOT EXISTS idx_legal_acceptances_user
  ON legal_acceptances(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_legal_acceptances_subject
  ON legal_acceptances(subject_hash, created_at DESC);
