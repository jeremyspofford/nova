-- Migration 127: a finished eval reaches the operator.
--
-- THE FAILURE (2026-08-07). Jeremy: "I ran a model eval test, haven't seen
-- any update." His run COMPLETED and he never found out:
--
--     585f78c7  22:42:14 -> 22:50:01  openrouter:~deepseek/deepseek-v4-flash
--               suite main, task_index 7 of 7, tasks_passed 2, resumes 0
--               status = 'failed'
--
-- Seven minutes forty-seven seconds of real tokens produced a real number —
-- the model scored 2 of 7 — and the only place it existed was a table nobody
-- was looking at. Two separate defects behind that one sentence.
--
-- 1. THE WORD 'failed' MEANS TWO DIFFERENT THINGS. That row and this one:
--
--        aee6d5a7  status = 'error', task_index 0 of 0
--                  detail.failure = 'no heartbeat for 90s'
--
--    are opposite outcomes — one is a completed measurement, the other is
--    the harness dying before the model was asked anything — and both
--    surfaced as failure. The fix is not a nicer word. `eval_runs.outcome()`
--    DERIVES the reading from what actually happened (how many tasks were
--    graded, out of how many), so a run that graded all seven is a
--    measurement whatever its score, and a run that graded none is not a
--    verdict on anybody. Nothing here maintains a list of statuses.
--
-- 2. NOTHING TOLD HIM IT FINISHED. An eval is ~8 minutes; he starts it and
--    walks away. So a run that reaches a terminal state now announces
--    itself through migration 125's path — notifications.record writes the
--    row, the transcript gets a role='notification' POINTER at it, and the
--    push carries the deep link — with the model, the suite, the score and
--    a link to the per-task detail in the body.
--
-- THE COLUMNS BELOW ARE THE LINE THAT REFUSES. Announcing is a side effect
-- in a process that can die halfway; without a recorded outcome the only
-- honest answer to "was he told?" would be a shrug, and the backlog sweep
-- would have nothing to work from. `announced_at` closes the step and
-- `announcement` says HOW it went — copied from notify.send's own result,
-- never asserted — and the CHECK makes a claim without an account of itself
-- impossible rather than discouraged.

ALTER TABLE eval_runs
    -- When the announce step CLOSED for this run — not "when the operator
    -- read it". A transport failure closes it too, with the failure written
    -- down; only an announce that never got as far as a notification row
    -- leaves this NULL, and that is what the backlog sweep retries.
    ADD COLUMN IF NOT EXISTS announced_at TIMESTAMPTZ,
    -- What happened, in notify.send's own words: notification_id, state,
    -- delivery_label, in_chat, deduped, confirmed. `confirmed` is
    -- notifications.confirmed() — state='opened' — and is the only key in
    -- here that means a person saw it.
    ADD COLUMN IF NOT EXISTS announcement JSONB;

COMMENT ON COLUMN eval_runs.announced_at IS
    'When the announce step closed (success OR recorded failure). NULL means '
    'it has not been attempted, or it died before a notification row existed '
    '— the backlog sweep in eval_runs._sweep retries exactly those.';
COMMENT ON COLUMN eval_runs.announcement IS
    'How the announcement went, copied from notify.send. `confirmed` (state '
    '= opened) is the only key that means a person saw it; `state` = '
    'accepted means a relay took the bytes and nothing more.';

-- A row that says it was announced must say how. This is the same shape as
-- migration 125's notifications_failed_has_reason, for the same reason: a
-- state that claims something has to carry the evidence for it, or the
-- claim is a fallback that reads as success.
-- `announcement IS NOT NULL` is not redundant, it is the whole constraint.
-- Written without it, a row with announced_at set and announcement NULL
-- evaluates to NULL rather than FALSE — and a CHECK only refuses FALSE, so
-- the one case this exists to catch was the one case it let through.
-- Measured: the suite's "nor with no account at all" check went red.
ALTER TABLE eval_runs DROP CONSTRAINT IF EXISTS eval_runs_announced_says_how;
ALTER TABLE eval_runs ADD CONSTRAINT eval_runs_announced_says_how
    CHECK (announced_at IS NULL
           OR (announcement IS NOT NULL
               AND jsonb_typeof(announcement) = 'object'
               AND announcement ? 'how'));

-- ...and a run still going has no result to announce. The announcement is of
-- an OUTCOME; a row that claimed one while it was still executing would be
-- announcing a score it had not finished earning.
ALTER TABLE eval_runs DROP CONSTRAINT IF EXISTS eval_runs_announced_is_terminal;
ALTER TABLE eval_runs ADD CONSTRAINT eval_runs_announced_is_terminal
    CHECK (announced_at IS NULL OR status <> 'running');

-- The backlog sweep's query: terminal, never announced. Partial index —
-- once the backfill below runs, almost nothing matches it.
CREATE INDEX IF NOT EXISTS eval_runs_unannounced
    ON eval_runs (finished_at)
    WHERE announced_at IS NULL AND status <> 'running';

-- ── the backfill closes history WITHOUT claiming it was delivered ────────
--
-- 250 rows predate this feature and none of them was ever announced. Two
-- wrong answers were available: leave them open, and the first sweep after
-- this migration buzzes the phone 250 times about evals from last week; or
-- write something that reads as "announced" and quietly lie about every one.
-- So the step is CLOSED and the record says exactly what happened — the
-- `how` line is the truth for these rows and reads as such in the panel and
-- in eval_results.
UPDATE eval_runs
   SET announced_at = now(),
       announcement = jsonb_build_object(
           'how', 'not announced — this run predates result notifications '
                  || '(migration 127); nobody was told at the time',
           'confirmed', false,
           'backfilled', true)
 WHERE status <> 'running'
   AND announced_at IS NULL;

-- ── grants ───────────────────────────────────────────────────────────────
--
-- NO NEW TOOL, and that is a finding rather than an omission: model-manager
-- already holds `run_eval` and `eval_results` (migration 124), and the gap
-- Jeremy hit was not that she could not read a run — it was that a finished
-- run reached nobody. The capability she gains is inside a tool she already
-- has, exactly as migration 125 did with `_notify_operator`:
--
--   * eval_results{action: "run"} and {action: "recent"} now carry
--     `outcome` — the derived reading (measured / partial / unmeasured)
--     with the basis it rests on — so she can no longer report "failed" for
--     a completed measurement, which is what the status string invited.
--   * ...and `announcement`, so "was Jeremy told?" is a fact she can read
--     instead of an assumption she makes.
--
-- Because nothing is granted, the pinned snapshots (granted.json,
-- test_eval_grants, test_eval_servability, the reads_only count) are
-- deliberately untouched — there is no tool change for them to notice.

-- She is told what the derived reading is, because a prompt still carries
-- the facts even though `outcome` is what actually decides. The last line of
-- 124's clause said 'Only "passed"/"failed" carry a score', which is the
-- half-truth this migration exists to correct: a 'failed' run can be a
-- complete measurement, and it was one the night this was written.
UPDATE agents
SET system_prompt = system_prompt || '

- A run''s STATUS IS NOT THE READING. eval_results returns `outcome`, derived from how many of the suite''s tasks were actually graded: outcome.code "measured" means every task was graded and the score is real however low it is (2/7 is a measurement, not a crash); "partial" and "unmeasured" mean the harness or the machine stopped it, and no score from those describes the model. Report outcome.headline, never the bare status word.
- A finished run announces itself to Jeremy in the conversation. `announcement` on the row says how that went — `confirmed` true means his device opened it, `state` "accepted" means a relay took it and nothing more. If it is missing or failed, say so rather than assuming he knows.',
    updated_at = now()
WHERE name = 'model-manager'
  AND system_prompt NOT LIKE '%STATUS IS NOT THE READING%';
