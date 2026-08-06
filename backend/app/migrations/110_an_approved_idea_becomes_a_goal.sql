-- Migration 110: an approved idea becomes a goal, and goals become visible.
--
-- ROADMAP #34 phase I2 (spec → docs/plans/ideation-goals.md), re-scoped
-- against what actually exists. The spec was written 2026-07-24 and says "no
-- goals/ideation machinery exists anywhere in the code". That stopped being
-- true on 2026-07-29, when goal-scoped autonomy shipped a `goals` table.
--
-- ONE TABLE, NOT TWO. The spec's goal is a tracked piece of work; the existing
-- one is an authorisation scope. They are genuinely different ideas that
-- arrived under the same word, and the tempting move — a second table called
-- goals — is the worst of the options: every later reader would have to learn
-- which one a given `goal_id` meant. Extended instead, and the distinction is
-- carried by a column that already exists: `approved_verbs`. An EMPTY array
-- means "tracked intention, authorises nothing"; a non-empty one is a standing
-- pre-approval. Both are things the operator wants in one list.
--
-- WHY APPROVING AN IDEA MUST NOT PRE-AUTHORISE ANYTHING. The goal created here
-- is `status='proposed'` with no verbs and no action budget. Approving an idea
-- card means "yes, this is worth doing" — it is not "and you may now start
-- changing the system to do it". Autonomous pursuit is exclusively #36 stage 4
-- and it stays there. A seam that quietly turned a good idea into standing
-- write access would be the single worst thing in this lane.
--
-- `source_recommendation_id` is UNIQUE so a double-click, a re-approval after
-- `later`, or two clients racing cannot mint two goals for one card. That is
-- the same reasoning as `action_runs`' partial unique index, and the same
-- failure it prevents.

ALTER TABLE goals
    ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS created_by text,
    ADD COLUMN IF NOT EXISTS source_recommendation_id uuid
        REFERENCES recommendations(id) ON DELETE SET NULL;

-- Partial: many goals have no source card, and NULLs must not collide.
CREATE UNIQUE INDEX IF NOT EXISTS goals_source_recommendation_uniq
    ON goals (source_recommendation_id)
    WHERE source_recommendation_id IS NOT NULL;

COMMENT ON COLUMN goals.description IS
    'The work itself — what "done" looks like, notes, a markdown checklist. '
    'Free-form and operator-editable. Distinct from `target`, which is the '
    'checkable finish line a pre-authorising goal is scoped by.';

COMMENT ON COLUMN goals.approved_verbs IS
    'Verbs this goal pre-authorises. EMPTY means a tracked intention that '
    'authorises nothing — which is what an approved idea becomes. A non-empty '
    'array is a standing approval `goals.spend` draws down.';

COMMENT ON COLUMN goals.source_recommendation_id IS
    'The idea card the operator approved to create this. Unique, so one card '
    'can only ever produce one goal.';
