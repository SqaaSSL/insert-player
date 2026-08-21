ALTER TABLE checkout_sessions
  ADD COLUMN stripe_payment_intent_id TEXT;
ALTER TABLE checkout_sessions
  ADD COLUMN refunded_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunded_amount_cents >= 0);
ALTER TABLE checkout_sessions
  ADD COLUMN refunded_credits INTEGER NOT NULL DEFAULT 0 CHECK (refunded_credits >= 0);
ALTER TABLE checkout_sessions
  ADD COLUMN disputed_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (disputed_amount_cents >= 0);
ALTER TABLE checkout_sessions
  ADD COLUMN disputed_credits INTEGER NOT NULL DEFAULT 0 CHECK (disputed_credits >= 0);
ALTER TABLE checkout_sessions
  ADD COLUMN reversed_credits INTEGER NOT NULL DEFAULT 0 CHECK (reversed_credits >= 0);
ALTER TABLE checkout_sessions
  ADD COLUMN dispute_event_created INTEGER NOT NULL DEFAULT 0 CHECK (dispute_event_created >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_sessions_payment_intent
  ON checkout_sessions(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stripe_credit_adjustments (
  id TEXT PRIMARY KEY,
  stripe_event_id TEXT NOT NULL UNIQUE,
  checkout_session_id TEXT NOT NULL REFERENCES checkout_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('refund', 'dispute')),
  stripe_object_id TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  credits_delta INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stripe_credit_adjustments_checkout
  ON stripe_credit_adjustments(checkout_session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stripe_credit_adjustments_user
  ON stripe_credit_adjustments(user_id, created_at DESC);
