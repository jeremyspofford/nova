-- Migration 124: an eval run survives the backend restarting.
--
-- THE FAILURE (2026-08-07). Jeremy: "I couldn't run a model eval loop on a
-- model." He was right, and it was structural, not bad luck. Measured over
-- the whole table the same evening — 250 rows, every eval ever recorded on
-- this box, 2026-07-28 to 2026-08-07:
--
--     177 error, 73 failed, 0 passed
--     175 of the 177 errors died to the PROCESS, not the model:
--         170 'the run stopped reporting and was declared dead'
--           5 'interrupted by a backend restart' (the pre-heartbeat wording)
--     only 2 were real (one NameError, one no_gradeable_tasks)
--     175 of them carried tasks_total = 0 — nothing at all was kept
--     the dead ones had been running 105s to 46min, mean 4m39s
--
-- Seventy per cent of all eval history is the harness being killed. The cause
-- is that a run executed wholly in memory: asyncio.create_task(_execute)
-- inside a backend running under --reload, where any .py edit is a restart.
-- Nothing was written down until the very end, so a restart at minute 45 of
-- 46 threw the lot away and left a row that reads — to a model picker, and to
-- the autonomous loop's eval floor — exactly like a model that could not be
-- graded. The nightly tournament sat on the same hole: 87 of those deaths
-- landed on 2026-08-04 and 81 on 2026-08-05, both tournament nights.
--
-- THE FIX is the pattern this repo already uses for exactly this problem
-- (action_runs, ingest_jobs): a persisted cursor, a claim taken with FOR
-- UPDATE SKIP LOCKED, orphan recovery at boot, leader-gated. A restart now
-- RESUMES at the cursor. Only a run that has been picked up MAX_RESUMES times
-- and kept dying is certified dead, and the record says so in those words.

ALTER TABLE eval_runs
    -- How many tasks of this run are FINISHED and graded. Written after each
    -- task's verdict, never before it, so a crash between the two re-runs one
    -- task rather than skipping it.
    ADD COLUMN IF NOT EXISTS task_index INTEGER NOT NULL DEFAULT 0,
    -- How many times this run has been picked up again after dying. Bumped in
    -- the same statement that claims it, which is what makes the retry ceiling
    -- terminate: a run that reliably kills the process would otherwise be
    -- rescued at every boot forever.
    ADD COLUMN IF NOT EXISTS resumes    INTEGER NOT NULL DEFAULT 0,
    -- Which instance took it. Attribution only — exclusivity is the row lock,
    -- not this column, because a column a process writes about itself cannot
    -- refuse a second process that never read it.
    ADD COLUMN IF NOT EXISTS claimed_by TEXT;

COMMENT ON COLUMN eval_runs.task_index IS
    'Cursor: tasks finished and graded. A resumed run starts here.';
COMMENT ON COLUMN eval_runs.resumes IS
    'Times this run was recovered after its process died. >= MAX_RESUMES is '
    'what turns "interrupted" into "declared dead".';
COMMENT ON COLUMN eval_runs.claimed_by IS
    'Instance id that last claimed this run. Attribution; the FOR UPDATE '
    'SKIP LOCKED claim is what enforces one owner.';

-- The claim scans for stale running rows under their resume ceiling. Small
-- table today, but the query runs at every boot and the partial index costs
-- nothing: almost no row is ever 'running'.
CREATE INDEX IF NOT EXISTS eval_runs_recoverable
    ON eval_runs (started_at)
    WHERE status = 'running';

-- ── THE GRANTS ───────────────────────────────────────────────────────────
--
-- Missed FIVE times in this repo (095, 096, 099, 104, 106) and called out in
-- CLAUDE.md for it: a tool is not a capability until an agent holds it.
--
-- Until now NO agent could measure a model. That is the hole under the
-- self-improvement loop's eval floor — a gate that reads scores nothing she
-- can produce is a gate standing on nothing — and it is why "run an eval on
-- this model" was an operator-only button. model-manager is the natural
-- holder: it already curates the pool and raises model.assign cards, and a
-- score is the evidence such a card is supposed to carry.

-- run_eval: start one suite against one model. Not read-only (it inserts a
-- row and spends real tokens and GPU), and deliberately NOT goal-scoped: it
-- creates no capability, it measures one. The mechanical limits are the
-- one-at-a-time slot in eval_runs.start and the model-resolution refusal.
UPDATE agents
SET allowed_tools = allowed_tools || ARRAY['run_eval'],
    updated_at = now()
WHERE name = 'model-manager'
  AND allowed_tools IS NOT NULL
  AND NOT ('run_eval' = ANY(allowed_tools));

-- eval_results: standings, recent runs, and one run's live progress. Reads
-- only. Granted alongside run_eval rather than instead of it, because a run
-- she cannot watch is a run she will report on by guessing — and the second
-- most repeated defect in this repo is reporting success nobody checked.
UPDATE agents
SET allowed_tools = allowed_tools || ARRAY['eval_results'],
    updated_at = now()
WHERE name = 'model-manager'
  AND allowed_tools IS NOT NULL
  AND NOT ('eval_results' = ANY(allowed_tools));

-- The agent index is how main decides to dispatch (the migration-016 lesson):
-- if the description does not advertise it, "test that model" never reaches
-- the model-manager and main answers from the transcript instead.
UPDATE agents
SET description = 'Manages Nova''s model inventory and fit: lists what''s available across providers, downloads new local models (Ollama), recommends which model each agent should use based on this machine''s hardware, curates the approved model pool (add/enable/disable curated models, verified against the live provider catalog), raises model-assignment cards for the operator to approve, and MEASURES models by running an eval suite against them and reading the standings. Dispatch "what models do we have", "get/download/pull a model", "add/approve this model", "what model should I/my agents use", or "test/evaluate/benchmark this model" requests here.',
    routing_keywords = ARRAY['model','pull','download','inference','llm',
                             'ollama','recommend','hardware','curated',
                             'approve','deepseek','openrouter',
                             'eval','evaluate','benchmark','test','score',
                             'standings','suite'],
    updated_at = now()
WHERE name = 'model-manager';

-- ...and she learns what the new verbs are for. Facts, not controls — the
-- one-at-a-time slot, the resolution check and the resume ceiling hold
-- whether or not this text is read. The sentence that matters most is the
-- last: an interrupted run and a bad model are the two states an operator
-- most needs told apart, and she is the one who will be asked which it was.
UPDATE agents
SET system_prompt = system_prompt || '

- run_eval starts ONE suite against ONE model and returns immediately with a run id. It does not return a score: a suite is minutes of wall clock and real tokens. Report the id and the estimate, then use eval_results{action: "run", run_id: ...} to see progress task by task. Never state a score you have not read back.
- Only one eval runs at a time; a second start is refused with the id of the one holding the slot. A run now survives a backend restart — it resumes at the task it reached — so "running, task 3 of 7" is normal and is not a failure.
- eval_results{action: "standings"} is the ranking across suites, and it reports what is still owed rather than inventing a winner. A run with status "error" was the HARNESS or the machine failing, never a verdict on the model: read detail.failure.type — declared_dead, suite_changed and model_unresolvable all mean the run did not measure anything. Only "passed"/"failed" carry a score.',
    updated_at = now()
WHERE name = 'model-manager'
  AND system_prompt NOT LIKE '%run_eval%';
