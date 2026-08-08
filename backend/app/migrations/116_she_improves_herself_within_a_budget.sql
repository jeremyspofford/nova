-- Migration 116: the standing-goal lane, the spend ceiling, and the eval floor.
--
-- ROADMAP #47, rails 2/3/4. Spec: docs/plans/autonomous-improvement.md, which
-- records Jeremy lifting the operator-merge lock on 2026-08-07 in his own
-- words: "that needs to be a continuous ongoing process that I don't even
-- think about or approve."
--
-- Removing an approval does not remove a control; it moves the control from a
-- human to a line of code. Three of those lines land here as schema, because
-- each has to survive a restart and be legible to somebody reading the
-- database six months from now.
--
--   1. action_runs.lane   — WHICH authority started this run, forever.
--   2. spend_ledger       — what the loop has cost today, and a ceiling row
--                           that `spend.may_start` refuses against.
--   3. coding_sessions.eval_*  — "green" now has to include "did not get
--                           worse at being Nova", recorded per commit.
--
-- And the capability is GRANTED the only way a standing approval can be:
-- a proposed goal carrying the new `improve_self` verb plus the consent card
-- that activates it. Nothing runs until he clicks it. A migration that
-- activated the goal itself would be this file granting his approval on his
-- behalf, which is the one thing the whole design exists to prevent.


-- ── 1. the second claim lane ────────────────────────────────────────────────
--
-- `action_worker.claim_next` requires `rec.decided_by = 'operator'` and that
-- check STAYS. This column adds a lane beside it rather than widening it, so
-- an operator-approved run and a goal-authorised one are distinguishable in
-- the audit trail forever — and revoking the goal stops the loop without
-- touching the code that runs approved work.
--
-- DEFAULT 'operator' is the safe direction: every row that already exists,
-- and every row written by code that has not heard of this column, claims
-- through the lane that requires a human.
ALTER TABLE action_runs
  ADD COLUMN IF NOT EXISTS lane text NOT NULL DEFAULT 'operator';
ALTER TABLE action_runs
  ADD COLUMN IF NOT EXISTS goal_id uuid REFERENCES goals(id) ON DELETE SET NULL;

DO $$
BEGIN
  ALTER TABLE action_runs
    ADD CONSTRAINT action_runs_lane_known CHECK (lane IN ('operator', 'goal'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A goal-lane run with no goal is unrepresentable: it would claim under an
-- authority nothing can revoke. Written as a CHECK rather than a convention,
-- because a convention is a prompt.
DO $$
BEGIN
  ALTER TABLE action_runs
    ADD CONSTRAINT action_runs_goal_lane_has_goal
      CHECK (lane <> 'goal' OR goal_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ONE IMPROVEMENT RUN AT A TIME, enforced by the database rather than by a
-- check-then-insert that two schedulers could both pass. The sandbox is
-- already one-at-a-time (inference-control holds `_sandbox_lock`); this is
-- the same fact one layer up, and it is what stops a slow pass from being
-- lapped by the next heartbeat every thirty minutes.
CREATE UNIQUE INDEX IF NOT EXISTS action_runs_one_live_goal_run
  ON action_runs ((lane))
  WHERE lane = 'goal' AND status IN ('queued', 'running', 'blocked');

CREATE INDEX IF NOT EXISTS action_runs_goal_idx
  ON action_runs (goal_id) WHERE goal_id IS NOT NULL;


-- ── 2. the spend meter ──────────────────────────────────────────────────────
--
-- Each pass is a coding agent, an image build, a production-sized import and
-- four suites. Until now the only bounds were a 90-minute wall clock and the
-- goal's own action count; nothing counted tokens or money.
--
-- tokens_in / tokens_out are NULLABLE and `metered` says whether they mean
-- anything. That is the whole honesty of this table: the ACP protocol carries
-- a usage block but `coder/broker.py` does not aggregate it into its snapshot
-- yet, so most entries today are unmetered — and an unmetered pass recorded as
-- `0 tokens` would read as free. NULL cannot be summed into a reassuring
-- total; a zero can.
CREATE TABLE IF NOT EXISTS spend_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which budget this is charged to. 'improve' is the only spender today;
  -- the column exists so evals and ingestion can join without a migration.
  lane        text NOT NULL,
  -- What was bought: 'coding_session' | 'sandbox_check' | 'review'. The
  -- pass ceiling counts 'coding_session' rows, because that is what a "pass"
  -- is; the rest are the same pass's other costs.
  kind        text NOT NULL,
  model       text NOT NULL DEFAULT '',
  session_id  uuid,
  run_id      uuid,
  goal_id     uuid,
  tokens_in   bigint,
  tokens_out  bigint,
  usd         numeric(12,4),
  -- Derived at write time from whether usage figures actually arrived,
  -- never from whether the caller intended to supply them.
  metered     boolean NOT NULL DEFAULT false,
  detail      jsonb NOT NULL DEFAULT '{}',
  -- The day the ceiling is measured over, in the database's timezone, so two
  -- callers cannot disagree about where the day starts.
  day         date NOT NULL DEFAULT current_date,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spend_ledger_day_idx ON spend_ledger (lane, day);
CREATE INDEX IF NOT EXISTS spend_ledger_recent_idx
  ON spend_ledger (created_at DESC);

-- The ceiling lives in a row, not in a constant, so lowering it takes effect
-- on the next check rather than on the next deploy. `spend.ceilings()` reads
-- it live and REFUSES when the row is missing — "I could not read the limit"
-- and "the limit is fine" must not reach a caller as the same answer.
CREATE TABLE IF NOT EXISTS spend_ceilings (
  lane        text PRIMARY KEY,
  max_passes  integer NOT NULL,
  max_tokens  bigint  NOT NULL,
  max_usd     numeric(12,2) NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL DEFAULT 'migration'
);

-- Four passes a day. Chosen as the number that is obviously survivable rather
-- than as an estimate of what is right: a pass is tens of minutes, so four is
-- most of a working day of machine time, and the operator moving it up after
-- watching it is a better path than shipping a number nobody can defend.
INSERT INTO spend_ceilings (lane, max_passes, max_tokens, max_usd)
VALUES ('improve', 4, 2000000, 10.00)
ON CONFLICT (lane) DO NOTHING;


-- ── 3. the eval floor's verdict, per commit ─────────────────────────────────
--
-- The sandbox builds, boots, imports his data and runs the unit + e2e suites.
-- It never ran the eval suites, so a candidate could pass every test and still
-- be measurably worse at being Nova. These columns mirror `sandbox_*` and
-- `review_*` exactly, including the reason those are keyed to a commit: a
-- verdict that outlived the code it was about is worse than none.
--
-- `eval_status` values: 'ok' (at or above every floor), 'below' (a measured
-- regression), 'unmeasured' (the stage ran and could not reach a model). The
-- third is NOT a pass — `code_change` refuses an autonomous landing on it —
-- and it is not silence either, which is the point of recording it.
ALTER TABLE coding_sessions ADD COLUMN IF NOT EXISTS eval_status text;
ALTER TABLE coding_sessions ADD COLUMN IF NOT EXISTS eval_commit text;
ALTER TABLE coding_sessions ADD COLUMN IF NOT EXISTS eval_detail text;
ALTER TABLE coding_sessions ADD COLUMN IF NOT EXISTS eval_scores jsonb;
ALTER TABLE coding_sessions ADD COLUMN IF NOT EXISTS eval_at timestamptz;


-- ── 4. the grant: a proposed goal and the card that activates it ────────────
--
-- A tool is not a capability until an agent holds it, and a VERB is not a
-- standing approval until a goal carries it and the operator has said yes.
-- Everything above is inert without this row, and this row is inert until he
-- clicks the consent.
--
-- max_actions is the second bound beside the daily ceiling, and they measure
-- different things on purpose: the ceiling caps a DAY, this caps the whole
-- standing approval. 20 passes, and `goals.activate` stamps its own expiry
-- from the moment of the click (DEFAULT_TTL_HOURS, 72 hours today), after
-- which the loop goes quiet on its own and he is asked again — a forgotten
-- approval must not be a permanent one. The card below states the number the
-- code will actually use rather than a rounder one.
--
-- proposed_by IS NULL deliberately: this is a goal the SYSTEM is offering the
-- operator, not one an agent asked for, and `goals.spend` treats a NULL
-- proposer as spendable by any caller. The improvement lane spends it through
-- `goals.spend_standing`, which matches on the verb alone and is safe to do
-- precisely because `improve_self` names no tool that any agent can call.
INSERT INTO goals (title, target, approved_verbs, rationale, proposed_by,
                   max_actions, status)
SELECT
  'Improve yourself, continuously',
  'Each pass writes one change, proves it in the sandbox (build, boot, his '
  'real data, the unit suite, the browser suite and the eval floor), has a '
  'different model read it, and lands it on a nova/ branch. Nothing merges to '
  'main and nothing touches the files that enforce these boundaries — a '
  'change that does becomes a card for you.',
  ARRAY['improve_self']::text[],
  'ROADMAP #47. Approving this turns the self-improvement loop on: the '
  'heartbeat starts one pass at a time, up to the daily spend ceiling, until '
  'this goal runs out of actions, expires (72 hours from your click), or you '
  'close it. Closing it stops the loop immediately and needs no code change.',
  NULL,
  20,
  'proposed'
WHERE NOT EXISTS (
  SELECT 1 FROM goals
   WHERE 'improve_self' = ANY(approved_verbs)
     AND status IN ('proposed', 'active', 'paused'));

INSERT INTO consents (kind, subject, question, requested_by)
SELECT 'goal.activate', g.id::text,
  'Turn on the self-improvement loop?' || chr(10) || chr(10) ||
  'Approving this lets Nova, without asking again:' || chr(10) ||
  '  • start one coding pass at a time under this goal, on the heartbeat''s '
  'clock, and land the result on a nova/ branch in your repository' || chr(10)
  || chr(10) ||
  'What still refuses, mechanically, on every pass:' || chr(10) ||
  '  • a change touching the code that enforces the boundaries (consents, '
  'goals, scopes, the executors, migrations, compose, the sidecars, the '
  'tripwire itself) does NOT land — it becomes a card and waits for you' ||
  chr(10) ||
  '  • nothing merges to main and git-landing holds no push credential' ||
  chr(10) ||
  '  • the sandbox must be green on this exact commit, a different model must '
  'have read the diff, and the eval floor must have held' || chr(10) ||
  '  • at most 4 passes a day (the spend ceiling), 20 under this goal in '
  'total, and the approval itself expires 72 hours after you click' ||
  chr(10) || chr(10) ||
  'Closing the goal in Library → Goals stops the loop immediately.',
  'system'
  FROM goals g
 WHERE 'improve_self' = ANY(g.approved_verbs) AND g.status = 'proposed'
   AND NOT EXISTS (SELECT 1 FROM consents c
                    WHERE c.kind = 'goal.activate' AND c.subject = g.id::text);
