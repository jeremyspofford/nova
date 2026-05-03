-- Migration 076: add 'auto' to review_policy CHECK constraint
--
-- Existing values are review-frequency policies (top-only, all, cost-above-N,
-- scopes-sensitive). 'auto' is the additional value meaning "skip the spec
-- approval gate entirely; let cortex transition straight to building."
-- Used for autonomous flows (e.g. CI triage) where the human-in-the-loop
-- gate is the per-call MUTATE approval through the capability platform's
-- consent gate, not a per-goal spec review.
--
-- Idempotent via constraint guard.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'goals_review_policy_check'
      AND conrelid = 'goals'::regclass
  ) THEN
    ALTER TABLE goals DROP CONSTRAINT goals_review_policy_check;
  END IF;

  ALTER TABLE goals
    ADD CONSTRAINT goals_review_policy_check
    CHECK (review_policy = ANY (ARRAY[
      'top-only', 'all', 'cost-above-2', 'cost-above-5',
      'scopes-sensitive', 'auto'
    ]));
END $$;
