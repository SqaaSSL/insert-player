-- Crew invitations can be shared as one-time links instead of requiring an
-- email address. Legacy Clerk email invitations remain valid while links
-- become the default onboarding channel.
ALTER TABLE crew_referrals
  ADD COLUMN invite_channel TEXT NOT NULL DEFAULT 'email'
    CHECK (invite_channel IN ('email', 'link'));

-- Existing Insert Player accounts may join a Crew through a link, but only an
-- account created from the referral can unlock the inviter's bonus Rookie.
ALTER TABLE crew_referrals
  ADD COLUMN reward_eligible INTEGER NOT NULL DEFAULT 1
    CHECK (reward_eligible IN (0, 1));

CREATE INDEX idx_crew_referrals_pending_links
  ON crew_referrals(inviter_user_id, clerk_organization_id, invite_channel, status, created_at DESC);
