-- Crews are Clerk Organizations. Insert Player keeps only the minimum
-- authorization and referral state required to share playable derivatives.
CREATE TABLE fighter_group_grants (
  fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
  clerk_organization_id TEXT NOT NULL
    CHECK (
      length(clerk_organization_id) BETWEEN 1 AND 128
      AND clerk_organization_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  granted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (fighter_id, clerk_organization_id)
);

CREATE INDEX idx_fighter_group_grants_organization
  ON fighter_group_grants(clerk_organization_id, created_at DESC);

CREATE INDEX idx_fighter_group_grants_grantor
  ON fighter_group_grants(granted_by_user_id, clerk_organization_id);

-- Raw invited email addresses stay in Clerk. D1 stores a domain-separated
-- HMAC so eligibility and velocity checks remain possible without duplicating
-- the address in Insert Player storage.
CREATE TABLE crew_referrals (
  id TEXT PRIMARY KEY,
  clerk_invitation_id TEXT UNIQUE,
  clerk_organization_id TEXT NOT NULL,
  inviter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  invited_email_hmac TEXT NOT NULL,
  oauth_identity_hmac TEXT UNIQUE,
  crew_name TEXT NOT NULL,
  inviter_display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'qualified', 'rewarded', 'capped', 'revoked', 'rejected', 'expired')),
  accepted_at TEXT,
  qualified_at TEXT,
  rewarded_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_crew_referrals_inviter
  ON crew_referrals(inviter_user_id, created_at DESC);

CREATE INDEX idx_crew_referrals_email
  ON crew_referrals(invited_email_hmac, status, created_at DESC);

CREATE INDEX idx_crew_referrals_organization
  ON crew_referrals(clerk_organization_id, status, created_at DESC);

CREATE UNIQUE INDEX idx_crew_referrals_rewarded_invitee
  ON crew_referrals(invitee_user_id)
  WHERE invitee_user_id IS NOT NULL AND status IN ('qualified', 'rewarded', 'capped');

CREATE TABLE fighter_entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('referral_rookie')),
  status TEXT NOT NULL DEFAULT 'unused'
    CHECK (status IN ('unused', 'reserved', 'consumed', 'revoked')),
  source_referral_id TEXT NOT NULL UNIQUE REFERENCES crew_referrals(id) ON DELETE CASCADE,
  reserved_charge_id TEXT UNIQUE,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_fighter_entitlements_available
  ON fighter_entitlements(user_id, kind, status, created_at ASC);

ALTER TABLE generation_charges
  ADD COLUMN entitlement_id TEXT REFERENCES fighter_entitlements(id) ON DELETE SET NULL;

CREATE INDEX idx_generation_charges_entitlement
  ON generation_charges(entitlement_id, status);
