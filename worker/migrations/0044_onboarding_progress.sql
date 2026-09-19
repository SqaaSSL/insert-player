-- Progress belongs to the account, not to the route used to create a character.
CREATE TABLE user_onboarding_progress (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  trial_completed_at TEXT,
  debut_fighter_id TEXT REFERENCES fighters(id) ON DELETE SET NULL,
  debut_completed_at TEXT
);

-- A claimed link is not yet a successful Clerk membership. Only stamp after
-- membership creation/verification succeeds; historical claims stay unproven.
ALTER TABLE crew_referrals ADD COLUMN membership_confirmed_at TEXT;

-- Qualified referrals already passed the verified-account and completed-debut
-- checks. Preserve that known progress without inventing a fighter identifier.
INSERT INTO user_onboarding_progress (user_id, trial_completed_at, debut_completed_at)
SELECT invitee_user_id, MIN(qualified_at), MIN(qualified_at)
FROM crew_referrals
WHERE invitee_user_id IS NOT NULL AND qualified_at IS NOT NULL
  AND status IN ('qualified', 'rewarded', 'capped')
GROUP BY invitee_user_id;
