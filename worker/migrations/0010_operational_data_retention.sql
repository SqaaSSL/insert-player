ALTER TABLE stripe_events
  ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;

-- Stripe event ids remain the idempotency key. Historical full webhook bodies
-- are not needed for credit accounting and may contain customer PII.
UPDATE stripe_events SET payload = '{"legacy":true}';

CREATE INDEX IF NOT EXISTS idx_stripe_events_user
  ON stripe_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stripe_events_created
  ON stripe_events(created_at);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_status_updated
  ON checkout_sessions(status, updated_at);
