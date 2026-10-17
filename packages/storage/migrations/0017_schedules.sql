-- 0017 — M5 schedules and their history (FR-055, FR-187, ADR-079; docs/06 `schedule`,
-- contracts/schemas/schedule.json). A schedule fires Work runs (run.origin `schedule`); its history
-- keeps every fire, catch-up run and recorded skip. All timestamps UTC ISO-8601, ids UUIDv7. There
-- is no `agent` table until M6, so `agent_id` is plain TEXT. Run ids are plain TEXT too: the
-- history outlives a run the user deletes.

CREATE TABLE schedule (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  project_id TEXT REFERENCES project (id),
  -- The Work run the schedule was made from ("schedule it", docs/18 J5), if any.
  run_id TEXT,
  agent_id TEXT,
  title TEXT NOT NULL,
  cron TEXT,
  rrule TEXT,
  interval_seconds INTEGER CHECK (interval_seconds IS NULL OR interval_seconds >= 60),
  -- One-shot fire (self-set wakes, FR-206).
  once_at TEXT,
  timezone TEXT NOT NULL,
  -- starts_at is the RRULE DTSTART and the interval's anchor; created_at when NULL.
  starts_at TEXT,
  ends_at TEXT,
  instructions TEXT NOT NULL CHECK (length(instructions) BETWEEN 1 AND 8000),
  notify_condition TEXT CHECK (notify_condition IS NULL OR length(notify_condition) <= 1000),
  -- JSON array of {kind: inapp|os|slack|teams|email|webhook, ref?}; webhook signing secrets live
  -- in the secret store under secret://schedule/<id>/webhook, never here.
  delivery_targets_json TEXT NOT NULL,
  -- The declared output (FR-187): {kind: artifact|message|file, ref?}.
  expected_output_json TEXT,
  catch_up_policy TEXT NOT NULL DEFAULT 'once' CHECK (catch_up_policy IN ('once', 'skip')),
  catch_up_lookback_s INTEGER NOT NULL DEFAULT 604800 CHECK (catch_up_lookback_s >= 0),
  autonomy TEXT NOT NULL DEFAULT 'standard' CHECK (autonomy IN ('ask_first', 'standard',
    'autonomous')),
  origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'agent', 'agent_self')),
  wake_reason TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  -- The next fire not yet handled; the loop sleeps until the earliest one.
  next_run_at TEXT,
  last_outcome TEXT CHECK (last_outcome IS NULL OR last_outcome IN ('done', 'output_missing',
    'failed', 'cancelled', 'no_news')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((cron IS NOT NULL) + (rrule IS NOT NULL) + (interval_seconds IS NOT NULL)
    + (once_at IS NOT NULL) = 1),
  CHECK (origin <> 'agent_self'
    OR (agent_id IS NOT NULL AND once_at IS NOT NULL AND wake_reason IS NOT NULL))
);
CREATE INDEX idx_schedule_next ON schedule (next_run_at) WHERE enabled = 1;
CREATE INDEX idx_schedule_account ON schedule (account_id, created_at);

-- A schedule's history (ADR-079): a fire, one catch-up run for missed fires, or misses recorded
-- as skipped. Claiming a fire inserts its row in the same transaction that moves next_run_at, and
-- the unique index stops the same rule time from firing twice, across restarts too.
CREATE TABLE schedule_fire (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedule (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account (id),
  kind TEXT NOT NULL CHECK (kind IN ('fire', 'catch_up', 'skipped')),
  -- The rule time it stands for (a catch-up or skip: the last missed time); NULL for a run the
  -- user started by hand outside the rule.
  due_at TEXT,
  -- The missed window of a catch-up or skip: first and last missed time and how many.
  window_first TEXT,
  window_last TEXT,
  window_count INTEGER,
  run_id TEXT,
  thread_id TEXT,
  -- The run's schedule.report decision: 1 deliver, 0 no news, NULL not reported (deliver).
  notify INTEGER,
  report_message TEXT,
  -- Delivery results once delivery ran: JSON array of {kind, ref?, receipt, error?}.
  receipts_json TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('done', 'output_missing', 'failed',
    'cancelled', 'no_news')),
  -- Why: "no news", the delivery that failed, the error that stopped the run.
  detail TEXT,
  fired_at TEXT NOT NULL,
  ended_at TEXT,
  CHECK (kind = 'fire' OR (window_first IS NOT NULL AND window_last IS NOT NULL
    AND window_count IS NOT NULL))
);
CREATE UNIQUE INDEX uq_schedule_fire_due ON schedule_fire (schedule_id, kind, due_at)
  WHERE due_at IS NOT NULL;
CREATE INDEX idx_schedule_fire_schedule ON schedule_fire (schedule_id, fired_at DESC);
-- Fires whose run has not settled yet (re-attached after a restart).
CREATE INDEX idx_schedule_fire_open ON schedule_fire (account_id, thread_id)
  WHERE outcome IS NULL AND kind <> 'skipped';
