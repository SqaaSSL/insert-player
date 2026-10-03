-- The onboarding demo's fatality is free once per account (product decision 2026-10-03).
-- users.free_finishers_used mirrors free_rookie_generations_used; a job's free_grant
-- marks that it used the allowance, so a failure returns the allowance, not a credit.
ALTER TABLE users ADD COLUMN free_finishers_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE battle_finisher_jobs ADD COLUMN free_grant INTEGER NOT NULL DEFAULT 0 CHECK (free_grant IN (0, 1));
